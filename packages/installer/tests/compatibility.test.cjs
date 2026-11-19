const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('tsx/cjs');
const { patchTools, patchStockExport, patchCutter, patchPreview } = require('../src/compatibility.ts');

test('Preview rows expose every program belonging to an operation for hover highlighting', () => {
  const source = 'function row(node, isOperation) { return { "data-operation-id": isOperation ? node.operationId ?? node.name : void 0, }; }';
  const context = {};
  vm.runInNewContext(patchPreview(source) + '\nglobalThis.row = row;', context);
  const node = { operationId: 'operation', tools: [{ gcodeId: 'first' }, { gcodeId: 'second' }] };
  const row = context.row(node, true);
  assert.equal(row['data-gcode-id'], 'first');
  assert.deepEqual(JSON.parse(row['data-usermod-gcode-ids']), ['first', 'second']);
  assert.equal(context.row(node, false)['data-gcode-id'], undefined);
});

function toolsBridge() {
  const calls = [];
  const tool = { id: 'one', version: 3, slotNum: 2, name: 'original' };
  const controller = {
    store: { get: () => [tool] }, refresh: async () => calls.push('refresh'), findTool: () => tool,
    updateTool: async (id, input) => { calls.push({ id, input }); return input; },
    createTool: async input => { calls.push({ create: input }); return { ...input, id: 'created' }; },
    installTool: async (id, slot) => { calls.push(['assign', id, slot]); return true; },
    uninstallTool: async id => { calls.push(['unassign', id]); return true; },
    deleteTool: async id => { calls.push(['delete', id]); return true; },
    reorderSlots: async slots => { calls.push(['reorder', slots]); return true; }
  };
  const source = `function getToolLibraryController(store) {\n  let controller = provided;\n  return controller;\n}\n\nfunction useToolLibraryActions() {}`;
  const patched = patchTools(source);
  assert.equal(patchTools(patched), patched);
  const context = { provided: controller, cutLibrarySettingsAtom: {} };
  vm.runInNewContext(patched + '\ngetToolLibraryController({});', context);
  return { bridge: context.__usermodTools, calls, tool };
}
test('tool bridge reads authoritative state and refuses stale replacements', async () => {
  const { bridge, calls } = toolsBridge();
  assert.equal((await bridge.list())[0].version, 3);
  await assert.rejects(bridge.save({ id: 'one', name: 'changed' }, true, 2), /library changed/);
  assert.ok(calls.every(x => x === 'refresh'));
  await bridge.save({ id: 'one', name: 'changed' }, true, 3);
  assert.equal(calls.at(-1).input.version, 3);
});
test('tool bridge creates through native controller rather than rewriting the store', async () => {
  const { bridge, calls } = toolsBridge();
  const created = await bridge.save({ id: 'foreign', name: 'imported', slotNum: null }, false);
  assert.equal(created.id, 'created'); assert.equal(calls.at(-1).create.slotNum, null);
});

test('tool slot management rejects stale inventories and mounted deletion, then uses native controller', async () => {
  const { bridge, calls, tool } = toolsBridge();
  await assert.rejects(bridge.manage('unassign', { toolId: 'one', expectedVersions: { one: 2 } }), /changed/);
  assert.ok(calls.every(c => c === 'refresh'));
  const expectedVersions = { one: 3 };
  await assert.rejects(bridge.manage('delete', { toolId: 'one', expectedVersions }), /Unassign/);
  await bridge.manage('unassign', { toolId: 'one', expectedVersions }); assert.equal(calls.at(-1)[0], 'unassign');
  await bridge.manage('assign', { toolId: 'one', slotNum: 4, expectedVersions }); assert.deepEqual(calls.at(-1), ['assign', 'one', 4]);
  tool.slotNum = null;
  await bridge.manage('delete', { toolId: 'one', expectedVersions }); assert.equal(calls.at(-1)[0], 'delete');
});
test('stock export creates an isolated worker controller and disposes it', async () => {
  let disposed = false, seen;
  const payload = { stock: { shape: 'square' }, backend: 'webgpu' };
  class StockRemovalController {
    constructor(options) { assert.deepEqual(Object.keys(options.sceneManager.renderer), []); }
    resetTimeline(input) { seen = input; }
    timelineSampleCount() { return 3; }
    seekToAsync() { this.volume = { fillTopHeights: out => out.fill(-1) }; this.spec = { nx: 2, ny: 2, bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: -2 } }; }
    getSampleIndex() { return 2; }
    dispose() { disposed = true; }
  }
  const context = { StockRemovalController, Float32Array, performance, setTimeout };
  vm.runInNewContext(patchStockExport('class StockRemovalController {}').replace('class StockRemovalController {}', ''), context);
  const runtime = { manager: {}, stockRemoval: { recoveryPayload: payload, createComparisonWorker() {} } };
  const grid = await context.__usermodStockExport(runtime, new AbortController().signal);
  assert.equal(grid.heights[0], -1); assert.equal(seen.backend, undefined);
  assert.equal(payload.backend, 'webgpu'); assert.equal(disposed, true);
  await assert.rejects(context.__usermodStockExport({ stockRemoval: { recoveryPayload: { stock: { shape: 'round' } } } }, new AbortController().signal), /three-axis/);
});
test('cutter bridge uses a packed sample and changes tools within one program', () => {
  const source = `class Runtime { getSpatialGcodeIds() {\n    return this.toolpaths.default.visualizer.getSpatialGcodeIds();\n  } }`.replace('Runtime { get', 'Runtime {\n  get');
  const context = {};
  vm.runInNewContext(patchCutter(source) + '\nglobalThis.Runtime = Runtime;', context);
  const runtime = new context.Runtime();
  runtime.toolpaths = { default: { visualizer: {
    getSpatialSample: index => ({ gcodeId: 'same-program', sampleIndex: index }),
    getSpatialToolRuns: () => [{ start: 0, toolNumber: 1 }, { start: 10, toolNumber: 2 }]
  } } };
  assert.equal(runtime.usermodSample(2).toolNumber, 1);
  assert.equal(runtime.usermodSample(12).toolNumber, 2);
});

test('cutter wrappers forward new backend, shared-stock and playback arguments', () => {
  const fs = require('node:fs');
  const calls = [];
  const runtime = {
    cuttingTool: null, manager: {},
    resetStockRemoval: (...args) => calls.push(['reset', ...args]),
    seekSpatialSample: (...args) => { calls.push(['seek', ...args]); return 'pose'; },
    seekStockRemoval: (...args) => calls.push(['stock', ...args]),
    applyToolPose: result => calls.push(['pose', result])
  };
  let tick;
  const context = {
    window: {
      usermodRuntime: { register() {}, log() {} },
      usermodUI: { toolbar: { addButton() {} } },
      usermod: { info: async () => ({ ok: false }) }
    },
    setInterval: callback => { tick = callback; },
    __usermodSimRuntimes: new Set([runtime])
  };
  vm.runInNewContext(fs.readFileSync(require('node:path').resolve('mods/cutter/dist/index.js'), 'utf8'), context);
  tick();
  const tools = new Map(), shared = {}, options = { stockPlayback: true };
  runtime.resetStockRemoval(tools, 'webgpu', shared);
  assert.equal(runtime.seekSpatialSample(3, options), 'pose');
  runtime.seekStockRemoval(4, { sync: true });
  runtime.applyToolPose({ sampleIndex: 5 });
  assert.deepEqual(calls[0], ['reset', tools, 'webgpu', shared]);
  assert.deepEqual(calls[1], ['seek', 3, options]);
  assert.equal(calls[2][0], 'stock'); assert.equal(calls[3][0], 'pose');
});
