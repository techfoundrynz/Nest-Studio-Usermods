/** Named native commands only. The surrounding Prepare closure supplies the app's own controllers. */
export const MCP_MACHINING_BLOCK = `
        if (action === "cancel_toolpath_plan") {
          if (processTreeGenerating || fourAxisGenerating) throw new Error("Cannot close planning while toolpath generation is active.");
          closeProcessTree();
          return { status: "cancelled" };
        }
        if (action === "get_operation_editor") return JSON.parse(JSON.stringify({
          request: operationSettingsRequest, editor: operationEditorSession.editor,
          geometryReady: Boolean(operationGeometryContext?.isCurrent())
        }));
        if (action === "get_operation_geometry") {
          if (!operationGeometryContext?.isCurrent()) throw new Error("Operation geometry is not ready or is stale.");
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120000);
          try { return await operationGeometryContext.load(controller.signal, () => {}); }
          finally { clearTimeout(timeout); }
        }
        const machiningActions = ["configure_stock", "configure_toolpath_plan", "begin_operation", "configure_operation", "commit_operation", "cancel_operation", "delete_operation"];
        if (machiningActions.includes(action) && (processTreeLoading || processTreeGenerating || fourAxisGenerating || exportingGcode)) throw new Error("Wait for the current native job to finish.");
        if (action === "configure_stock") {
          if (args.fixture && (args.materialType || args.shape)) throw new Error("Change the fixture separately from material/shape so native adaptation cannot race.");
          if (processTree || isPrepareOperationEditing(project.projectId)) throw new Error("Close planning/operation editing before changing stock.");
          if (args.shape === "round" && project.projectAxis !== "4Axis") throw new Error("Native 3-axis projects require square stock.");
          if (args.fixture && ((project.projectAxis === "4Axis") !== (args.fixture === "fourth-axis"))) throw new Error("Fixture is incompatible with this machining axis.");
          if (args.materialType || args.shape) {
            const material = { ...snapshot.document.projectCanvasData.material,
              ...args.materialType ? { materialType: args.materialType } : {},
              ...args.shape ? { materialShape: args.shape } : {} };
            parameterEdit.request(() => projectMetadataCommands.submitMaterial(material));
          }
          if (args.fixture && !handleFixtureChange({ type: args.fixture })) throw new Error("Native fixture selection was rejected or requires a local adaptation decision.");
          return { status: "workflow_requested", message: "Native stock adaptation may require a decision; read the project and bounds again." };
        }
        if (action === "configure_toolpath_plan") {
          if (!processTree) throw new Error("Request generate_toolpaths and wait for a native plan first.");
          if (typeof args.carving === "boolean" && project.projectAxis !== "3Axis") throw new Error("The carving toggle belongs to native 3-axis smart milling; rotary projects use relief milling.");
          if (args.fourAxisMachiningMode && project.projectAxis !== "4Axis") throw new Error("Rotary base/cutoff settings require a 4-axis project.");
          if (args.supportSetting && (project.projectAxis !== "3Axis" || args.setupId)) throw new Error("Support settings require 3-axis planning and must apply across all faces; omit setupId.");
          const drafts = { ...processTree.initialDrafts, ...millingDrafts };
          const updates = [];
          for (const [key, current] of Object.entries(drafts)) {
            const setup = processTree.setups.find(s => getProcessTreeDraft(drafts, s.id, current.modelId) === current);
            if (args.setupId && setup?.id !== args.setupId) continue;
            if (args.modelId && current.modelId !== args.modelId) continue;
            const mounted = getCutLibrary?.() ?? cutLibrary;
            const selectedIds = args.toolIds ?? current.oneKeySetting.allTools.map(t => t.id);
            const selected = selectedIds.map(id => {
              const preset = current.oneKeySetting.allTools.find(t => t.id === id);
              const tool = mounted.find(t => t.id === id);
              if (!preset || !tool || !Number.isInteger(tool.slotNum) || tool.slotNum <= 0) throw new Error("Select only mounted tools from the native plan.");
              const override = args.toolOverrides?.find(o => o.toolId === id);
              const { toolId: ignored, ...values } = override ?? {};
              if (values.stepOver > tool.diameter) throw new Error("Stepover exceeds the selected tool diameter.");
              return { ...preset, ...values };
            });
            if (!selected.length || !selected.some(t => t.type === "endmill")) throw new Error("Native smart milling requires a mounted end mill.");
            if (args.toolOverrides?.some(o => !selectedIds.includes(o.toolId))) throw new Error("Override tool is not selected.");
            const next = { ...current, oneKeySetting: { ...current.oneKeySetting, allTools: selected,
              cutSetting: { ...current.oneKeySetting.cutSetting, ...typeof args.carving === "boolean" ? { isCarve: args.carving } : {} } },
              ...args.fourAxisMachiningMode ? { fourAxisMachiningMode: { ...args.fourAxisMachiningMode, dimensionAxes: "machining-zyx" } } : {} };
            if (args.supportSetting) {
              const mesh = supportSceneBridge.getModelMeshById(current.modelId);
              if (!mesh) throw new Error("Model scene is not ready for support validation.");
              const support = { ...current.supportSetting, ...args.supportSetting };
              const thickness = Number(snapshot.document.projectCanvasData.material.thickness);
              const maxDepth = getMaxMachiningDepth(thickness, fixtureConfiguration.type);
              const { maxTabHigh } = computeWorkpieceCutDepth(mesh, thickness);
              if ([support.frontMachiningDepth, support.backMachiningDepth].some(v => v !== undefined && (!Number.isFinite(v) || v < 0 || v > maxDepth))) throw new Error("Machining depth exceeds native stock/fixture limits.");
              if (support.tabHigh > maxTabHigh || support.reserveTabDepth > support.tabHigh || support.cutTabDepth > thickness) throw new Error("Retaining tab/reserve/cut depth exceeds native model/stock limits.");
              if (["tabNum", "tabLength", "tabHigh"].some(k => Object.hasOwn(args.supportSetting, k))) {
                support.tabPaths = []; support.tabAllPath = ""; support.isCustomLayout = false;
              }
              next.supportSetting = support;
            }
            updates.push([key, next]);
          }
          if (!updates.length) throw new Error("No matching native plan draft.");
          for (const [key, next] of updates) saveMillingDraft(key, next);
          return { status: "configured", drafts: updates.length };
        }
        if (action === "generate_planned_toolpaths" && project.projectAxis === "4Axis") {
          if (processTreeLoading || processTreeGenerating || fourAxisGenerating) throw new Error("Native generation is already running.");
          if (processTree?.projectAxis !== "4Axis") throw new Error("Request a native 4-axis plan first.");
          const drafts = { ...processTree.initialDrafts, ...millingDrafts };
          const draft = Object.values(drafts).find(d => d.modelId === processTree.models[0]?.id);
          if (!draft) throw new Error("Native rotary draft is unavailable.");
          const mesh = supportSceneBridge.getModelMeshById(draft.modelId);
          if (!mesh) throw new Error("Model scene is not ready.");
          mesh.updateWorldMatrix(true, false);
          const box = new Box3().setFromObject(mesh, true), size = box.getSize(new Vector3());
          const material = snapshot.document.projectCanvasData.material;
          const limits = getFourAxisMachiningModeLimits({ stockLength: Number(material.materialShape === "round" ? material.length : material.thickness), stockWidth: Number(material.length), stockHeight: Number(material.width), base: draft.fourAxisMachiningMode?.base, model: { length: size.z, width: size.y } });
          if (!isFourAxisMachiningModeValid(draft.fourAxisMachiningMode, limits) || !hasFourAxisLeftClearance(box.min.x, draft.fourAxisMachiningMode)) throw new Error("Native rotary base/cutoff dimensions or left clearance are invalid.");
          if (!evaluateLatestToolpathAvailability(false).canGenerate) throw new Error("Native stock/travel checks blocked rotary generation.");
          if (!generateFourAxisToolpaths(draft, material)) throw new Error("Native rotary generation was rejected.");
          closeProcessTree();
          return { status: "workflow_requested", axis: "4Axis", message: "Rotary generation runs asynchronously. Poll get_cam_state and inspect operation results." };
        }
        if (["begin_operation", "configure_operation", "commit_operation", "cancel_operation", "delete_operation"].includes(action)) {
          if (!advancedOperationsEnabled) throw new Error("Native custom operations are unavailable for this project axis/mode.");
          if (processTree) throw new Error("Close smart planning before editing custom operations.");
          if (action === "cancel_operation") { setOperationSettingsRequest(null); return { status: "cancelled" }; }
          if (action === "begin_operation" || action === "delete_operation") {
            const setup = snapshot.document.saveCoordsSystemList.find(s => s.id === args.setupId);
            if (!setup?.modelItems.some(m => m.value === args.modelId)) throw new Error("Setup/model identity is invalid.");
            if (isPrepareOperationEditing(project.projectId)) throw new Error("An operation editor is already active.");
            const identity = { setupId: args.setupId, modelId: args.modelId, operationId: args.operationId };
            if (args.operationId) {
              const found = findCustomOperation(snapshot.document, identity);
              if (!found || !getCustomOperationConfiguration(found.operation)) throw new Error("Custom operation not found; smart-generated operations are edited through their plan.");
            }
            if (action === "delete_operation") {
              if (!customOperationActions.delete(identity)) throw new Error("Native delete command was rejected.");
              clearPrepareOperationEditor(project.projectId, identity);
              return { status: "deleted" };
            }
            if (args.operationId) openEditOperationSettings(identity);
            else openOperationSettings({ projectId: project.projectId, projectAxis: "3Axis", operationType: args.operationType, target: { type: "model", setupId: args.setupId, modelId: args.modelId } });
            return { status: "workflow_requested", message: "Poll get_operation_editor until phase=ready." };
          }
          const editor = operationEditorSession.editor;
          if (!editor || editor.phase !== "ready" || !operationSettingsRequest || !operationGeometryContext?.isCurrent()) throw new Error("Native operation editor/geometry is not ready.");
          if (action === "configure_operation") {
            let next = cloneOperationParameterConfiguration(editor.configuration);
            if (args.toolId) {
              const tool = (getCutLibrary?.() ?? cutLibrary).find(t => t.id === args.toolId);
              if (!tool || !Number.isInteger(tool.slotNum) || tool.slotNum <= 0) throw new Error("Choose a mounted native tool.");
              next = refreshOperationParameterRecommendations(next, project.projectCanvasData.material, tool);
            }
            for (const [key, value] of Object.entries(args.cutSetting ?? {})) {
              if (!Object.hasOwn(next.cutSetting, key)) throw new Error("Unknown native cut-setting field: " + key);
              if (typeof value !== typeof next.cutSetting[key] && next.cutSetting[key] != null) throw new Error("Native cut-setting type mismatch: " + key);
              next.cutSetting[key] = value;
            }
            if (args.geometry) {
              if (args.geometry.inputKey !== operationGeometryContext.inputKey || !Array.isArray(args.geometry.holeList) || !Array.isArray(args.geometry.dodgeHoleList)) throw new Error("Use current native geometry inputKey and selection lists.");
              next = updateOperationGeometry(next, args.geometry);
            }
            operationEditorSession.setConfiguration(next);
            return { status: "configured" };
          }
          if (!customOperationCommand.start({ request: operationSettingsRequest, configuration: editor.configuration, tools: getCutLibrary?.() ?? cutLibrary, geometryContext: operationGeometryContext, invalidSelectionConfirmed: false })) throw new Error("Native operation validation rejected the request.");
          confirmOperationConfiguration(editor.configuration);
          setOperationSettingsRequest(null);
          return { status: "workflow_requested", message: "Inspect native operation results; this response does not mean machining started." };
        }
`;
