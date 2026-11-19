import { MCP_MACHINING_BLOCK } from "./mcp-machining";
import { MCP_WORKFLOWS_BLOCK, MCP_PREPARE_WORKFLOWS_BLOCK, MCP_IO_BLOCK } from "./mcp-workflows";
/** Native Prepare gateway. No store-file writes or copied CAM/machining implementation. */
export const MCP_PROJECT_MARKER = "/* NEST-USERMOD-MCP-PROJECT-v7 */";
export const MCP_ARCHIVE_MARKER = "/* NEST-USERMOD-MCP-ARCHIVE-v2 */";
export const MCP_ARCHIVE_BLOCK = `
${MCP_ARCHIVE_MARKER}
${MCP_WORKFLOWS_BLOCK}
globalThis.__usermodProjectZip = async (project, modelFiles) => {
  const chunks = [];
  let length = 0;
  await streamProjectZip(createProjectZipEntries({ project, modelFiles }), async bytes => {
    length += bytes.byteLength;
    if (length > 64 * 1024 * 1024) throw new Error("Project copy exceeds 64 MiB.");
    chunks.push(bytes.slice());
  });
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  const text = [];
  for (let offset = 0; offset < bytes.length; offset += 16384) text.push(String.fromCharCode(...bytes.subarray(offset, offset + 16384)));
  return btoa(text.join(""));
};
`;
export const MCP_PROJECT_BLOCK = `
  ${MCP_PROJECT_MARKER}
  reactExports.useEffect(() => {
    if (!active) return;
    const bridge = {
      async run(action, args) {
        if (action === "list_projects") return session.getProjectTabs().map(p => ({ projectId: p.projectId, projectName: p.projectName, projectAxis: p.projectAxis }));
        if (args.projectId !== project.projectId) throw new Error("Open the requested project's Prepare page first.");
        const snapshot = projectCommands.read();
        if (!snapshot) throw new Error("Project is no longer open.");
        if (action === "get_project") return JSON.parse(JSON.stringify(snapshot.document));
${MCP_MACHINING_BLOCK}
${MCP_PREPARE_WORKFLOWS_BLOCK}
        if (action === "save_project_copy") {
          if (processTreeLoading || processTreeGenerating || fourAxisGenerating) throw new Error("Wait for generation to finish before saving.");
          if (!globalThis.__usermodProjectZip) throw new Error("Native project archive bridge unavailable.");
          const base64 = await globalThis.__usermodProjectZip({ ...snapshot.document, filePath: args.filePath, isSave: true }, snapshot.modelFiles);
          if (projectCommands.read()?.document !== snapshot.document) throw new Error("Project changed while archiving; retry the copy.");
          return { base64 };
        }
        if (action === "get_cam_state") return JSON.parse(JSON.stringify({
          axis: project.projectAxis, machiningMode: project.projectCanvasData.machiningMode,
          loading: processTreeLoading, generating: processTreeGenerating || fourAxisGenerating,
          availability: toolpathAvailability, canMachine, machiningBlockedReason,
          fixture: fixtureConfiguration, planned: Boolean(processTree),
          tree: processTree, drafts: { ...processTree?.initialDrafts, ...millingDrafts },
          models: modelFiles.map(file => {
            const mesh = supportSceneBridge.getModelMeshById(file.modelId);
            mesh?.updateWorldMatrix(true, false);
            const box = mesh ? new Box3().setFromObject(mesh, true) : null;
            return { modelId: file.modelId, name: file.relativePath, bounds: box ? { min: box.min, max: box.max } : null };
          })
        }));
        if (fourAxisGenerating || processTreeLoading || processTreeGenerating || exportingGcode) throw new Error("Wait for the active project operation to finish.");
        if (action === "transform_model") {
          if (!snapshot.modelFiles.some(file => file.modelId === args.modelId)) throw new Error("Model not found.");
          if (processTree || hasGeneratedProcessTree) throw new Error("Transform only before planning/generating toolpaths.");
          const rotation = args.rotationDeg ? Object.fromEntries(Object.entries(args.rotationDeg).map(([axis, value]) => [axis, value * Math.PI / 180])) : undefined;
          const next = patchActiveModelItemTransform(snapshot.document, args.modelId, { position: args.position, rotation });
          projectMetadataCommands.patchTransforms(next);
          recordProjectSnapshot(project.projectId, "mcpTransform", snapshot.document, next);
          await reloadSceneForCoordsTab();
          return { status: "transformed", modelId: args.modelId };
        }
        if (action === "repair_model") {
          if (!snapshot.modelFiles.some(file => file.modelId === args.modelId)) throw new Error("Model not found.");
          if (processTree || hasGeneratedProcessTree) throw new Error("Repair only before planning/generating toolpaths.");
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120000);
          try { await onRunRepair({ modelId: args.modelId, signal: controller.signal }); }
          finally { clearTimeout(timeout); }
          return { status: "repair_finished", modelId: args.modelId, message: "Read the project importRepair state to verify repair succeeded." };
        }
        if (action === "generate_planned_toolpaths") {
          if (!processTree) throw new Error("Request generate_toolpaths first, then wait until get_cam_state reports planned=true.");
          const drafts = { ...processTree.initialDrafts, ...millingDrafts };
          const generated = await handleGenerateProcessTree(processTree, drafts, "overwrite", args.sides);
          if (!generated) throw new Error("Native generation did not complete. Inspect get_cam_state and the project before retrying.");
          return { status: "generated", projectId: project.projectId };
        }
        if (action === "rename_project") {
          if (typeof args.name !== "string" || !args.name.trim() || args.name.length > PROJECT_ENTITY_NAME_MAX_LENGTH || !NAME_ALLOWED_PATTERN.test(args.name)) throw new Error("Project name does not meet Nest Studio's naming rules.");
          const next = { ...snapshot.document, projectName: args.name, isSave: false };
          if (!projectCommands.commit({ document: next, expectedDocument: snapshot.document, dirty: "meta" })) throw new Error("Project changed; read it again before retrying.");
          recordProjectSnapshot(project.projectId, "mcpRename", snapshot.document, next);
          return { projectId: project.projectId, projectName: args.name, unsaved: true };
        }
        if (action === "set_stock_dimensions") {
          if (!handleBlankDimensionsCommit) throw new Error("Stock dimensions are locked in the current workflow.");
          handleBlankDimensionsCommit({ width: args.width, length: args.length, thickness: args.thickness });
        } else if (action === "generate_toolpaths") {
          if (guideStep || !canStartToolpathGeneration()) throw new Error("Native generation checks blocked this request. Review the Prepare page.");
          toolpathRegeneration.start();
        } else if (action === "export_toolpaths") {
          if (!hasGeneratedProcessTree) throw new Error("Generate toolpaths first.");
          if (!snapshot.document.saveCoordsSystemList.some(c => c.id === args.setupId)) throw new Error("Unknown setupId; read get_project first.");
          handleProcessTreeExportGcode({ type: "setup", setupId: args.setupId });
        } else if (action === "start_machining") {
          if (guideStep || !canMachine) throw new Error("Native machining checks blocked this request.");
          machiningFlow.start();
        } else throw new Error("Unsupported MCP project action.");
        return { status: "workflow_requested", projectId: project.projectId, action, message: "Review native dialogs and read the project again to check the result." };
      }
    };
    globalThis.__usermodMcpProject = bridge;
    return () => { if (globalThis.__usermodMcpProject === bridge) delete globalThis.__usermodMcpProject; };
  });
`;

export function patchMcpProject(source: string): string {
  if (source.includes(MCP_PROJECT_MARKER)) return source;
  // Older staging archives are regenerated from the original when this file changes. Never append
  // a second hook to an older patch if called directly on an already patched source.
  if (source.includes("/* NEST-USERMOD-MCP-PROJECT-")) throw new Error("Stale MCP gateway; rebuild from the original archive");
  const anchor = "  const blankBoundaryAlertVisible = blankProximity.visible && !dimensionLinkage.open;";
  if (source.split(anchor).length !== 2) throw new Error("Native MCP Prepare gateway anchor missing or ambiguous");
  return source.replace(anchor, () => MCP_PROJECT_BLOCK + "\n" + anchor);
}

export function patchMcpArchive(source: string): string {
  if (source.includes(MCP_ARCHIVE_MARKER)) return source;
  if (source.includes("/* NEST-USERMOD-MCP-ARCHIVE-")) throw new Error("Stale native CAM file gateway; rebuild from the original archive");
  const anchor = "function createProjectZipEntries(input) {";
  if (source.split(anchor).length !== 2) throw new Error("Native project archive anchor missing or ambiguous");
  const ioAnchor = "  return {\n    tabItems,\n    activeProjectId,\n    canSaveActive,\n    openProjectDialog,";
  if (source.split(ioAnchor).length !== 2) throw new Error("Native MCP project IO anchor missing or ambiguous");
  return source.replace(anchor, () => MCP_ARCHIVE_BLOCK + "\n" + anchor).replace(ioAnchor, () => MCP_IO_BLOCK + ioAnchor);
}
