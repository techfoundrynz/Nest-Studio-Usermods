/** Promise-based bridge to the same importer used by Nest Studio's File menu. */
export const MODEL_IMPORT_MARKER = "/* NEST-USERMOD-MODEL-IMPORT-v1 */";
export const MODEL_IMPORT_BLOCK = `
  ${MODEL_IMPORT_MARKER}
  const usermodBatchBusy = reactExports.useRef(false);
  const usermodImportModels = reactExports.useCallback(async (files, progress) => {
    if (usermodBatchBusy.current) throw new Error("A model batch is already importing.");
    if (activeProjectGenerating) throw new Error("Wait for toolpath generation to finish before importing boards.");
    if (!Array.isArray(files) || !files.length) throw new Error("No board files to import.");
    usermodBatchBusy.current = true;
    let imported = 0;
    let projectId = null;
    try {
      projectId = isOnProject && activeTab?.projectType === "3D" && activeTab.projectAxis === "3Axis"
        ? activeProjectId : addProject("3Axis");
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
  const anchor = "  }, [loadModelFile]);\n  const onNewProject = reactExports.useCallback(() => {";
  if (source.split(anchor).length !== 2) throw new Error("Nest Studio model-import anchor was not found exactly once; batch import cannot be patched safely.");
  return source.replace(anchor, `  }, [loadModelFile]);\n${MODEL_IMPORT_BLOCK}\n  const onNewProject = reactExports.useCallback(() => {`);
}
