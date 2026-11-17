/** Promise-based bridge to the same importer used by Nest Studio's File menu. */
export const MODEL_IMPORT_MARKER = "/* NEST-USERMOD-MODEL-IMPORT-v2 */";
export const MODEL_IMPORT_BLOCK = `
  ${MODEL_IMPORT_MARKER}
  const usermodBatchBusy = reactExports.useRef(false);
  const usermodImportModels = reactExports.useCallback(async (files, progress, options = {}) => {
    if (usermodBatchBusy.current) throw new Error("A model batch is already importing.");
    if (activeProjectGenerating) throw new Error("Wait for toolpath generation to finish before importing boards.");
    if (!Array.isArray(files) || !files.length) throw new Error("No board files to import.");
    usermodBatchBusy.current = true;
    let imported = 0;
    let projectId = null;
    try {
      const axis = options.axis ?? "3Axis";
      if (axis !== "3Axis" && axis !== "4Axis") throw new Error("Unsupported machining axis.");
      if (axis === "4Axis" && files.length !== 1) throw new Error("Native 4-axis projects accept one model.");
      projectId = !options.newProject && isOnProject && activeTab?.projectType === "3D" && activeTab.projectAxis === axis
        ? activeProjectId : addProject(axis);
      if (!projectId) return { imported, total: files.length, projectId, error: "Could not create a project." };
      for (const file of files) {
        progress?.(imported, files.length, file.name);
        if (!await importModelFile(file, projectId)) return { imported, total: files.length, projectId, error: "Model import was cancelled or failed." };
        imported += 1;
      }
      return { imported, total: files.length, projectId };
    } catch (error) {
      return { imported, total: files.length, projectId, error: error instanceof Error ? error.message : String(error) };
    } finally { usermodBatchBusy.current = false; }
  }, [activeProjectGenerating, isOnProject, activeTab, activeProjectId, addProject, importModelFile]);
  reactExports.useEffect(() => {
    const bridge = { importFiles: usermodImportModels };
    globalThis.__usermodModelImport = bridge;
    return () => { if (globalThis.__usermodModelImport === bridge) delete globalThis.__usermodModelImport; };
  }, [usermodImportModels]);
`;

export function patchModelImport(source: string): string {
  if (source.includes(MODEL_IMPORT_MARKER)) return source;
  if (source.includes("/* NEST-USERMOD-MODEL-IMPORT-")) throw new Error("Stale model importer; rebuild from the original archive");
  const suffix = "  const onNewProject = reactExports.useCallback(() => {";
  const anchors = ["  }, [loadModelFile, location.pathname]);\n", "  }, [loadModelFile]);\n"];
  const matches = anchors.filter(a => source.split(a + suffix).length === 2);
  if (matches.length !== 1) throw new Error("Nest Studio model-import anchor was not found exactly once; batch import cannot be patched safely.");
  const anchor = matches[0]!;
  return source.replace(anchor + suffix, `${anchor}${MODEL_IMPORT_BLOCK}\n${suffix}`);
}
