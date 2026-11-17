const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
require('tsx/cjs');
const { list, readEntry } = require('../../asar/dist/index.js');
const { patchStockExport, patchStreamExport, patchTools, patchCutter, patchPreview, patchMultiSide, MULTISIDE_SITES,
  EXPORT_MARKER, TOOLS_MARKER, STOCK_EXPORT_MARKER, CUTTER_MARKER, PREVIEW_MARKER, MULTISIDE_MARKER } = require('../src/compatibility.ts');
const { patchModelImport, MODEL_IMPORT_MARKER } = require('../src/model-import.ts');
const archive = process.env.NEST_TEST_ASAR || 'C:/Program Files/nest-studio/resources/app.asar';

test('installed vendor archive accepts all required bridges and multi-side patches without syntax errors', { skip: !fs.existsSync(archive) }, t => {
  const entries = list(archive);
  const read = pattern => {
    const matches = entries.filter(entry => pattern.test(entry.path));
    assert.equal(matches.length, 1, `one matching chunk: ${pattern}`);
    return readEntry(archive, matches[0].path).toString('utf8');
  };
  const main = patchStreamExport(read(/^out\/main\/index\.js$/), 'C:/test/loader.js');
  const full = patchTools(patchModelImport(read(/^out\/renderer\/assets\/FullApp-.*\.js$/)));
  const engine = patchCutter(patchStockExport(read(/^out\/renderer\/assets\/engine-3d-.*\.js$/)));
  const preview = patchPreview(read(/^out\/renderer\/assets\/PreviewPage-.*\.js$/));
  for (const [source, marker] of [[main, EXPORT_MARKER], [full, TOOLS_MARKER], [full, MODEL_IMPORT_MARKER], [engine, STOCK_EXPORT_MARKER], [engine, CUTTER_MARKER], [preview, PREVIEW_MARKER]]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.equal(patchTools(full), full);
  assert.equal(patchModelImport(full), full);
  assert.equal(patchCutter(engine), engine);
  assert.equal(patchStockExport(engine), engine);
  assert.equal(patchPreview(preview), preview);
  const prepare = read(/^out\/renderer\/assets\/PreparePageContent-.*\.js$/);
  const renderer = [full, engine, prepare].map(source => patchMultiSide(source, true));
  assert.equal(renderer.reduce((sum, source) => sum + source.split(MULTISIDE_MARKER).length - 1, 0), MULTISIDE_SITES);
  for (const source of renderer) assert.equal(patchMultiSide(source, true), source);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-native-patches-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const [index, source] of [main, ...renderer, preview].entries()) {
    const file = path.join(temp, index === 0 ? 'main.cjs' : `renderer-${index}.mjs`);
    fs.writeFileSync(file, source);
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});

test('stock export splits numbered tools and preserves origin using the installed native worker', { skip: !fs.existsSync(archive) }, async () => {
  const entry = list(archive).find(e => /^out\/renderer\/assets\/stock-removal\.worker-.*\.js$/.test(e.path));
  assert.ok(entry, 'installed stock worker is present');
  let response;
  const worker = vm.createContext({ self: { postMessage: value => { response = value; } }, performance, setTimeout, clearTimeout });
  vm.runInContext(readEntry(archive, entry.path).toString('utf8') + '\nglobalThis.Volume = DexelStockVolume;', worker);
  let payload, disposed = false;
  class StockRemovalController {
    resetTimeline(input) {
      payload = input;
      this.spec = worker.Volume.fromBounds({ minX: -5, maxX: 5, minY: -5, maxY: 5, minZ: -2, maxZ: 0 }, 0.5).spec;
      worker.self.onmessage({ data: { type: 'initPackedTimeline', timelineId: 1, spec: this.spec, sampleCount: input.packedTimeline.sampleCount,
        tools: [...input.toolsByGcodeId].map(([gcodeId, meta]) => ({ gcodeId, ...meta })), volumeData: null, sampleIndex: -1, stampPosition: new Float64Array([NaN, NaN, NaN]) } });
      for (const chunk of input.packedTimeline.chunks) worker.self.onmessage({ data: { type: 'appendPackedTimelineChunk', timelineId: 1, chunk } });
    }
    timelineSampleCount() { return payload.packedTimeline.sampleCount; }
    seekToAsync(index) {
      worker.self.onmessage({ data: { type: 'seek', timelineId: 1, epoch: 1, fromIndex: -1, toIndex: index, returnVolume: true, interpolateStepMm: null } });
      assert.equal(response.type, 'seekResult', response.errorText);
      assert.deepEqual(Array.from(response.missingDiameterGcodeIds), []);
      this.volume = worker.Volume.deserialize(this.spec, response.volumeData);
    }
    getSampleIndex() { return response?.sampleIndex ?? -1; }
    dispose() { disposed = true; }
  }
  const context = vm.createContext({ StockRemovalController, performance, setTimeout });
  vm.runInContext(patchStockExport('class StockRemovalController {}').replace('class StockRemovalController {}', ''), context);
  const identity = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  const original = {
    stock: { shape: 'square', width: 10, length: 10, thickness: 2 },
    bounds: { minX: 15, maxX: 25, minY: -5, maxY: 5 }, positions: new Float32Array(),
    toolsByGcodeId: new Map([['program', { toolsByNumber: { 1: { diameter: 2, toolType: 'endmill' }, 2: { diameter: 4, toolType: 'endmill' } } }]]),
    packedTimeline: { sampleCount: 4, chunks: [{ format: 'float32', globalStart: 0, localStart: 0, pointCount: 4, gcodeId: 'program',
      positions: new Float32Array([18, 0, -1, 19, 0, -1, 20, 0, -1, 21, 0, -1]),
      motionFlags: new Uint8Array([1, 3, 3, 3]), matrixWorld: identity,
      toolRuns: [{ start: 0, toolNumber: 1 }, { start: 2, toolNumber: 2 }] }] }
  };
  const runtime = { manager: {}, stockRemoval: { recoveryPayload: original, createComparisonWorker() {} } };
  const grid = await context.__usermodStockExport(runtime, new AbortController().signal);
  assert.equal(payload.packedTimeline.chunks.length, 2);
  assert.equal(payload.toolsByGcodeId.size, 2);
  assert.equal(grid.minX, 15);
  assert.ok(grid.heights.some(z => z < -0.5), 'native worker cut material in the correct centered coordinates');
  assert.ok(grid.heights.some(z => z === 0), 'uncut stock remains');
  assert.equal(identity[12], 0, 'preview transform remains unchanged');
  assert.equal(original.packedTimeline.chunks[0].positions.length, 12, 'preview buffers remain attached');
  assert.equal(disposed, true);
});
