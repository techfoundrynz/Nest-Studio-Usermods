/** These helpers live in FullApp's scope and call the vendor's own export/inspection code. */
export const MCP_WORKFLOWS_BLOCK = `
globalThis.__usermodCamFiles = async (action, args, snapshot, scene) => {
  const project = snapshot.document;
  const tree = readProjectProcessTree(project);
  const language = args.language ?? "en";
  const faces = buildProjectGcodeFaces(project, tree, language);
  const face = args.setupId ? faces.find(f => f.setupId === args.setupId) : null;
  if (args.setupId && !face) throw new Error("No exportable programs for this setup; check ignored, stale and generating operations.");
  if (action === "list_programs") return faces.map(f => ({ setupId: f.setupId, side: f.side, programs: f.file.pathConfigList.flatMap(p => (p.gcodes ?? []).map(g => ({ programId: g.id, pathId: p.id, modelId: p.modelId, toolNum: g.toolNum, pathType: g.pathType, operationIds: g.sourceOperationIds }))) }));
  if (action === "inspect_toolpaths") {
    const tools = await globalThis.__usermodTools.list();
    const inputs = listPreviewFaceReportInputs(project, snapshot.modelFiles, tools).filter(f => !args.setupId || f.faceId === args.setupId);
    if (!inputs.length) throw new Error("No generated toolpaths to inspect.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      const reports = [];
      for (const input of inputs) {
        const report = await faceToolpathReportCache.acquire(input.key, signal => requestFaceToolpathReport({ ...input, scene, signal, priority: () => true }), controller.signal, args.retry === true);
        // Inspection geometry contains large typed arrays intended for rendering, not MCP transport.
        const { inspectionGeometry, ...summary } = report;
        reports.push({ setupId: input.faceId, overcut: getOvercutWarningState(report), report: summary });
      }
      return { reports, note: "Native inspection results; an incomplete or unsupported report is not clearance to machine." };
    } finally { clearTimeout(timeout); }
  }
  let input = face?.file ?? buildProjectGcodeExportRequest(project, tree, language);
  if (!input) throw new Error("No exportable generated toolpaths.");
  if (args.programId) {
    if (!face) throw new Error("setupId is required with programId.");
    const paths = input.pathConfigList.flatMap(p => { const gcodes = p.gcodes.filter(g => g.id === args.programId); return gcodes.length ? [{ ...p, gcodes }] : []; });
    if (paths.reduce((n, p) => n + p.gcodes.length, 0) !== 1) throw new Error("Unknown or ambiguous programId; use list_programs.");
    input = { ...input, pathConfigList: paths };
  }
  const rotate = file => ({ ...file, rotateExportGcode: file.projectAxis === "4Axis" ? applyFourAxisExportGcodeRotation : undefined });
  input = "files" in input ? { ...input, files: input.files.map(rotate) } : rotate(input);
  const collect = async value => {
    const chunks = []; let size = 0;
    if (!await streamExportGcodeFile(value, async chunk => { size += chunk.byteLength; if (size > 64 * 1024 * 1024) throw new Error("CAM output exceeds 64 MiB; select fewer programs."); chunks.push(chunk.slice()); })) throw new Error("Native export is empty.");
    return new Uint8Array(await new Blob(chunks).arrayBuffer());
  };
  if (action === "validate_programs") {
    const tools = await globalThis.__usermodTools.list();
    const slots = toolSlotsFromCutLibrary(tools);
    const files = "files" in input ? input.files : [input];
    const results = [];
    for (const file of files) {
      const bytes = await collect(file);
      const code = new TextDecoder().decode(bytes);
      const validation = await window.api.gcode.validate(code, slots);
      if (!validation.ok) throw new Error(validation.message ?? "Native validation failed.");
      const estimate = await window.api.gcode.estimatedTime(code);
      results.push({ name: file.suggestedName, bytes: bytes.length, validation: validation.data, estimate: estimate.ok ? estimate.data : { error: estimate.message } });
    }
    return { results, source: "native_export", postprocessorsApplied: false };
  }
  if (action !== "export_nc_file") throw new Error("Unknown CAM file action.");
  const bytes = await collect(input);
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return { base64: btoa(chunks.join("")), extension: "files" in input ? ".zip" : ".nc" };
};
`;

/** Named commands inside the existing active Prepare gateway. */
export const MCP_PREPARE_WORKFLOWS_BLOCK = `
        if (["list_programs", "validate_programs", "inspect_toolpaths", "export_nc_file"].includes(action)) {
          if (processTree || processTreeLoading || processTreeGenerating || fourAxisGenerating || exportingGcode) throw new Error("Close planning and wait for generation/export to finish first.");
          await historySceneSyncRef.current;
          const scene = editor.getScene();
          if (action === "inspect_toolpaths" && !scene) throw new Error("Prepare scene is not ready.");
          const result = await globalThis.__usermodCamFiles(action, args, snapshot, scene);
          if (projectCommands.read()?.document !== snapshot.document) throw new Error("Project changed during CAM review/export; retry against the latest project.");
          return result;
        }
        if (action === "get_model_analysis") return { analysisByModelId, runningModelId, reportSetupId };
        if (action === "get_model_edit_state") return { simplification: simplificationState, canUndo: canUndoModelHistory(project.projectId), canRedo: canRedoModelHistory(project.projectId) };
        const editActions = ["preview_toolpaths", "set_operation_enabled", "set_operation_visibility", "set_work_origin", "scale_model", "remove_model", "undo_repair", "model_history", "simplify_model"];
        if (editActions.includes(action)) {
          if (processTree || processTreeLoading || processTreeGenerating || fourAxisGenerating || exportingGcode || isPrepareOperationEditing(project.projectId)) throw new Error("Close planning/editing and wait for generation/export to finish.");
          if (simplificationState.open && action !== "simplify_model") throw new Error("Commit or cancel the native simplification session first.");
          if (action === "preview_toolpaths") {
            if (!hasGeneratedProcessTree || !snapshot.document.saveCoordsSystemList.some(c => c.id === args.setupId)) throw new Error("Choose a generated setup.");
            if (args.operationId && (!args.modelId || !(generatedTree?.plans ?? []).some(p => p.setupId === args.setupId && p.modelId === args.modelId && p.data.operations.some(o => o.operation_id === args.operationId)))) throw new Error("Unknown setup/model/operation.");
            handleSimulationPreview({ type: args.operationId ? "operation" : "setup", setupId: args.setupId, modelId: args.modelId, operationId: args.operationId });
            return { status: "workflow_requested", message: "Native simulation preview requested; this does not certify toolpath safety." };
          }
          if (action === "set_operation_enabled" || action === "set_operation_visibility") {
            const tree = generatedTree;
            if (!tree?.plans.some(p => p.setupId === args.setupId && p.modelId === args.modelId && p.data.operations.some(o => o.operation_id === args.operationId))) throw new Error("Unknown generated operation identity.");
            const key = getProcessOperationKey(args.setupId, args.modelId, args.operationId);
            if (action === "set_operation_enabled") {
              if (ignoredProcessOperations.has(key) === args.enabled) handleToggleIgnoredProcessOperations([key]);
              return { status: "configured", enabled: args.enabled };
            }
            if (hiddenProcessOperations.has(key) === args.visible) handleToggleProcessOperations([key]);
            return { status: "configured", visible: args.visible };
          }
          if (action === "set_work_origin") {
            if (project.projectAxis !== "3Axis" || originPositionDisabled) throw new Error("Origin is locked; configure before generating toolpaths in a 3-axis project.");
            handleOriginPositionConfirm(args.origin);
            return { status: "configured", origin: args.origin };
          }
          if (action === "model_history") {
            const available = args.direction === "undo" ? canUndoModelHistory(project.projectId) : canRedoModelHistory(project.projectId);
            if (!available) throw new Error("No model history in that direction.");
            const applied = await (args.direction === "undo" ? (modelHistoryUndoUsesAsync(project.projectId) ? undoModelHistoryAsync(project.projectId) : undoModelHistory(project.projectId)) : (modelHistoryRedoUsesAsync(project.projectId) ? redoModelHistoryAsync(project.projectId) : redoModelHistory(project.projectId)));
            if (applied === false) throw new Error("Native history command was rejected.");
            await historySceneSyncRef.current;
            return { status: "history_applied", direction: args.direction };
          }
          if (!snapshot.modelFiles.some(f => f.modelId === args.modelId)) throw new Error("Model not found.");
          if (hasGeneratedProcessTree) throw new Error("Edit model geometry before generating toolpaths.");
          if (action === "remove_model") handleRemoveModelById(args.modelId);
          if (action === "undo_repair") await onUndoRepair(args.modelId);
          if (action === "scale_model") {
            const before = getModelDimensions(args.modelId);
            if (!before || !editor.sceneReady) throw new Error("Model scene is not ready.");
            const supports = captureModelSupportSnapshot(snapshot.document, new Set([args.modelId]));
            if (!applyModelDimensions(args.modelId, { x: before.x * args.factor, y: before.y * args.factor, z: before.z * args.factor })) throw new Error("Native scaling rejected.");
            const after = getModelDimensions(args.modelId);
            recordModelDimensionsChange(project.projectId, args.modelId, before, after, undefined, supports);
            setModelSizeRevision(n => n + 1);
          }
          if (action === "simplify_model") {
            if (!uiFeatures.prepareModelSimplification) throw new Error("Native model simplification is unavailable in this build.");
            if (args.stage === "open") {
              if (simplificationState.open) throw new Error("A simplification session is already open.");
              openSimplification({ projectId: project.projectId, modelId: args.modelId, fileName: snapshot.modelFiles.find(f => f.modelId === args.modelId).relativePath });
            } else {
              if (simplificationState.target?.modelId !== args.modelId) throw new Error("Open the requested model's simplification session first.");
              if (args.stage === "cancel") cancelSimplification();
              else {
                if (!simplificationState.sourceReady || simplificationState.simplifying) throw new Error("Wait for simplification to become ready.");
                if (args.stage === "preview") requestSimplification(args.percent);
                else confirmSimplification();
              }
            }
          }
          return { status: "workflow_requested", action, message: "Read get_cam_state/get_model_edit_state to verify the native result." };
        }
`;

export const MCP_TABS_MARKER = "/* NEST-USERMOD-MCP-TABS-v1 */";
export const MCP_IO_BLOCK = `
  reactExports.useEffect(() => {
    const bridge = { async run(action, args) {
      if (action === "open_project") {
        const bytes = Uint8Array.from(atob(args.base64), c => c.charCodeAt(0));
        const loaded = await parseProjectZipBytes(bytes, args.name);
        if (!await importLoadedProjectZip(loaded, captureNestConfirmViewScope())) throw new Error("Project opening was cancelled or rejected.");
        return { status: "opened", projectId: jotaiStore.get(activeProjectIdAtom) };
      }
      if (action !== "save_project" || args.projectId !== activeProjectId) throw new Error("Activate the requested project before saving.");
      const saved = await persistProject(activeProjectId, args.saveAs === true || activeProjectMissingFromRecent);
      if (!saved) throw new Error("Native project save was cancelled or failed.");
      return { status: "saved", projectId: activeProjectId, filePath: jotaiStore.get(projectTabItemsAtom).find(p => p.projectId === activeProjectId)?.filePath };
    } };
    globalThis.__usermodMcpIo = bridge;
    return () => { if (globalThis.__usermodMcpIo === bridge) delete globalThis.__usermodMcpIo; };
  });
`;
export function patchMcpTabs(source: string): string {
  if (source.includes(MCP_TABS_MARKER)) return source;
  const anchor = "  const tabItemsForUi = reactExports.useMemo(";
  if (source.split(anchor).length !== 2) throw new Error("Native MCP tab gateway anchor missing or ambiguous");
  return source.replace(anchor, () => `  ${MCP_TABS_MARKER}
  reactExports.useEffect(() => {
    const bridge = { async run(action, args) {
      const state = jotaiStore.get(projectAtom);
      const tab = state.tabItems.find(p => p.projectId === args.projectId);
      if (!tab) throw new Error("Project tab not found.");
      if (fourAxisGuideSession || threeAxisGuideSession) throw new Error("Finish the native guide first.");
      if (action === "activate_project") { switchTab(args.projectId); await navigate(ROUTES.project); return { status: "activated", projectId: args.projectId }; }
      if (action !== "close_project") throw new Error("Unknown tab action.");
      await requestCloseTab(args.projectId);
      return { status: jotaiStore.get(projectAtom).tabItems.some(p => p.projectId === args.projectId) ? "not_closed" : "closed", projectId: args.projectId };
    } };
    globalThis.__usermodMcpTabs = bridge;
    return () => { if (globalThis.__usermodMcpTabs === bridge) delete globalThis.__usermodMcpTabs; };
  });
` + anchor);
}
