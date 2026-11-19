export const EXPORT_MARKER = "/* NEST-USERMOD-STREAM-EXPORT-v1 */";
export const TOOLS_MARKER = "/* NEST-USERMOD-TOOLS-v2 */";
export const MULTISIDE_MARKER = "/* NEST-USERMOD-MULTISIDE */";
export const STOCK_EXPORT_MARKER = "/* NEST-USERMOD-STOCK-EXPORT-v1 */";
export const CUTTER_MARKER = "/* NEST-USERMOD-CUTTER-v2 */";
export const PREVIEW_MARKER = "/* NEST-USERMOD-PREVIEW-ROWS-v1 */";

/** 2.0.1 removed the Device page's duplicate travel scan; the other four sites remain. */
export function expectedBedSizeMarkers(version: string): number {
  return version === "2.0.1" ? 4 : 5;
}

export function patchPreview(source: string): string {
  if (source.includes(PREVIEW_MARKER)) return source;
  const anchor = '"data-operation-id": isOperation ? node.operationId ?? node.name : void 0,';
  return once(source, anchor, `${anchor}\n          ${PREVIEW_MARKER}
          "data-gcode-id": isOperation ? node.tools[0]?.gcodeId : void 0,
          "data-usermod-gcode-ids": isOperation ? JSON.stringify(node.tools.map(tool => tool.gcodeId).filter(id => typeof id === "string")) : void 0,`);
}

export function patchCutter(source: string): string {
  if (source.includes(CUTTER_MARKER)) return source;
  const anchor = "  getSpatialGcodeIds() {\n    return this.toolpaths.default.visualizer.getSpatialGcodeIds();\n  }";
  return once(source, anchor, `${anchor}\n  ${CUTTER_MARKER}
  usermodSample(index) {
    const visualizer = this.toolpaths.default.visualizer;
    const sample = visualizer.getSpatialSample(index);
    let toolNumber = null;
    for (const run of visualizer.getSpatialToolRuns()) {
      if (run.start > sample.sampleIndex) break;
      toolNumber = run.toolNumber;
    }
    return { gcodeId: sample.gcodeId, toolNumber, meta: this.stockRemoval?.recoveryPayload?.toolsByGcodeId.get(sample.gcodeId) };
  }`);
}

/** A separate CPU calculation retains the old height-field STL export without altering the GPU preview. */
export function patchStockExport(source: string): string {
  if (source.includes(STOCK_EXPORT_MARKER)) return source;
  if (!source.includes("class StockRemovalController {")) throw new Error("StockRemovalController anchor missing");
  return source + `\n${STOCK_EXPORT_MARKER}
globalThis.__usermodStockExport = async (runtime, signal) => {
  signal.throwIfAborted();
  const original = runtime.stockRemoval;
  const payload = original?.recoveryPayload;
  if (!payload) throw new Error("Open Preview and turn on material removal first.");
  if (runtime.stock?.stockDimensions?.layoutMode === "4axis" || payload.stock.shape === "round" || payload.orientations?.some((v, i) => i % 4 !== 3 && Math.abs(v) > 0.00001))
    throw new Error("Height-field STL export supports three-axis machining only.");
  if (!original.createComparisonWorker) throw new Error("Stock worker is unavailable.");
  const controller = new StockRemovalController({
    sceneManager: { renderer: {}, requestRender() {} },
    createWorker: original.createComparisonWorker
  });
  try {
    const toolsByGcodeId = new Map();
    const selectedId = (id, slot) => {
      const meta = payload.toolsByGcodeId?.get(id);
      const choices = meta?.toolsByNumber ? Object.values(meta.toolsByNumber) : [];
      const tool = meta?.toolsByNumber ? meta.toolsByNumber[slot] ?? (choices.length === 1 ? choices[0] : undefined) : meta;
      if (!tool?.diameter || !Number.isFinite(tool.diameter)) throw new Error("The toolpath has incomplete cutter geometry.");
      const key = id + ":tool:" + (slot ?? "default");
      toolsByGcodeId.set(key, tool);
      return key;
    };
    const offsetX = payload.bounds ? (payload.bounds.minX + payload.bounds.maxX) / 2 : 0;
    const offsetY = payload.bounds ? (payload.bounds.minY + payload.bounds.maxY) / 2 : 0;
    let packedTimeline, gcodeIds;
    if (payload.packedTimeline) {
      const chunks = [];
      for (const chunk of payload.packedTimeline.chunks) {
        const part = (start, end, slot) => {
          const matrixWorld = chunk.matrixWorld.slice();
          matrixWorld[12] -= offsetX; matrixWorld[13] -= offsetY;
          return { ...chunk, globalStart: chunk.globalStart + start, localStart: 0, pointCount: end - start,
            positions: chunk.positions.subarray((chunk.localStart + start) * 3, (chunk.localStart + end) * 3),
            motionFlags: chunk.motionFlags.subarray(chunk.localStart + start, chunk.localStart + end),
            matrixWorld, gcodeId: selectedId(chunk.gcodeId, slot), toolRuns: undefined };
        };
        const runs = chunk.toolRuns ?? [];
        let start = 0, slot;
        for (const run of runs) {
          if (run.start > start) chunks.push(part(start, run.start, slot));
          start = run.start; slot = run.toolNumber;
        }
        if (start < chunk.pointCount) chunks.push(part(start, chunk.pointCount, slot));
      }
      packedTimeline = { ...payload.packedTimeline, chunks };
    } else if (payload.gcodeIds) {
      let runIndex = 0, slot;
      const runs = payload.toolRuns ?? [];
      gcodeIds = payload.gcodeIds.map((id, index) => {
        while (runIndex < runs.length && runs[runIndex].start <= index) slot = runs[runIndex++].toolNumber;
        return selectedId(id, slot);
      });
    }
    const positions = payload.positions?.slice();
    if (positions) for (let i = 0; i < positions.length; i += 3) { positions[i] -= offsetX; positions[i + 1] -= offsetY; }
    controller.resetTimeline({ ...payload, ...(positions ? { positions } : {}), toolsByGcodeId, ...(gcodeIds ? { gcodeIds } : {}), ...(packedTimeline ? { packedTimeline } : {}), backend: undefined, finalStock: undefined });
    const count = controller.timelineSampleCount();
    if (!count) throw new Error("The simulation timeline is empty.");
    controller.seekToAsync(count - 1, { settle: true });
    const started = performance.now();
    while (controller.getSampleIndex() < count - 1) {
      signal.throwIfAborted();
      if (original.recoveryPayload !== payload || runtime.manager.disposed) throw new Error("The preview changed during export. Recompute the stock.");
      if (performance.now() - started > 180000) throw new Error("Stock export timed out.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    signal.throwIfAborted();
    if (!controller.volume || !controller.spec) throw new Error("Height-field output is unavailable for this toolpath.");
    const { nx, ny, bounds } = controller.spec;
    const heights = new Float32Array(nx * ny);
    controller.volume.fillTopHeights(heights);
    return { nx, ny, minX: bounds.minX + offsetX, minY: bounds.minY + offsetY, minZ: bounds.minZ,
      dx: (bounds.maxX - bounds.minX) / (nx - 1), dy: (bounds.maxY - bounds.minY) / (ny - 1), heights };
  } finally { controller.dispose(); }
};\n`;
}

function once(source: string, anchor: string, replacement: string): string {
  if (source.split(anchor).length !== 2) throw new Error(`Nest Studio 2.0 anchor missing or ambiguous: ${anchor.slice(0, 100)}`);
  return source.replace(anchor, () => replacement);
}

export function patchStreamExport(source: string, loaderPath: string): string {
  if (source.includes(EXPORT_MARKER)) return source;
  const anchor = "    await session.handle.close();\n    await promises$1.rename(session.tempPath, session.targetPath);";
  return once(source, anchor, `    await session.handle.close();\n    ${EXPORT_MARKER}\n    await require(${JSON.stringify(loaderPath)}).processExportFile(session.tempPath, session.targetPath);\n    await promises$1.rename(session.tempPath, session.targetPath);`);
}

/** Use the same controller as the native UI: refreshes atoms, versions, slots and dependent projects. */
export function patchTools(source: string): string {
  if (source.includes(TOOLS_MARKER)) return source;
  if (source.includes("/* NEST-USERMOD-TOOLS-")) throw new Error("Stale native tool gateway; rebuild from the original archive");
  const anchor = "function getToolLibraryController(store) {";
  source = once(source, anchor, `function getToolLibraryController(store) {\n  ${TOOLS_MARKER}`);
  return once(source, "  return controller;\n}\n\nfunction useToolLibraryActions()", `  globalThis.__usermodTools = {
    async list() {
      await controller.refresh({ force: true });
      return controller.store.get(cutLibrarySettingsAtom).map(tool => ({ ...tool }));
    },
    async manage(action, args) {
      await controller.refresh({ force: true });
      const tools = controller.store.get(cutLibrarySettingsAtom);
      const expected = args.expectedVersions;
      if (!expected || tools.some(t => expected[t.id] !== t.version) || Object.keys(expected).length !== tools.length) throw new Error("Tool library changed; refresh list_tools and supply all expectedVersions.");
      if (action === "delete") {
        const tool = controller.findTool(args.toolId);
        if (tool.slotNum !== null) throw new Error("Unassign the mounted tool before deleting it.");
        return controller.deleteTool(args.toolId);
      }
      if (action === "assign") return controller.installTool(args.toolId, args.slotNum);
      if (action === "unassign") return controller.uninstallTool(args.toolId);
      if (action === "reorder") return controller.reorderSlots(args.toolIds.map(id => id === null ? null : controller.findTool(id)));
      throw new Error("Unknown tool-library action.");
    },
    async save(tool, replace, expectedVersion) {
      await controller.refresh({ force: true });
      const existing = replace ? controller.findTool(tool.id) : null;
      if (existing && existing.version !== expectedVersion) throw new Error("The tool library changed. Close and reopen the import before retrying.");
      const saved = existing ? await controller.updateTool(existing.id, { ...tool, version: existing.version }) : await controller.createTool(tool);
      return saved;
    }
  };
  return controller;
}

function useToolLibraryActions()`);
}

const multiEdits: [string, string][] = [
  ['const canCreateBottomSide = project.projectAxis !== "4Axis" && items.length === 1 && !items[0]?.flipDirection;', 'const canCreateBottomSide = project.projectAxis !== "4Axis" && items.length >= 1;'],
  ['const trimmedName = resolveBottomFaceDefaultName(t);', 'const baseSideName = resolveBottomFaceDefaultName(t); const trimmedName = coordsList.length > 1 ? `${baseSideName} ${coordsList.length}` : baseSideName;'],
  ['function getFlipPlatformOffset(dimensions) {\n  const spacing = resolveFlipPlatformSpacing();', 'function getFlipPlatformOffset(dimensions, slot = 0) {\n  const spacing = resolveFlipPlatformSpacing() * (slot + 1);'],
  ['const offset = getFlipPlatformOffset();\n      const platformGroup = new Group();', 'const offset = getFlipPlatformOffset(dimensions, specs.indexOf(spec));\n      const platformGroup = new Group();'],
  ['const offset = getFlipPlatformOffset();\n      entry.platformGroup.position.set(offset.x, offset.y, 0);', 'const offset = getFlipPlatformOffset(dimensions, this.entries.indexOf(entry));\n      entry.platformGroup.position.set(offset.x, offset.y, 0);']
];
export const MULTISIDE_SITES = multiEdits.length;
export function patchMultiSide(source: string, enabled: boolean): string {
  for (const [before, after] of multiEdits) {
    const patched = `${after} ${MULTISIDE_MARKER}`;
    if (enabled && source.includes(before)) source = once(source, before, patched);
    if (!enabled && source.includes(patched)) source = once(source, patched, before);
  }
  return source;
}
