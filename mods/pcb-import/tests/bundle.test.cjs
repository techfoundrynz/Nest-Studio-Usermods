const { test } = require('node:test');
const assert = require('node:assert/strict');
const { zipSync, strToU8 } = require('fflate');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspectBundle, convertBundle } = require('../dist/bundle');
const { parseArtwork } = require('../dist/geometry');
const mod = require('../dist/main');
const mesh = require('./mesh.cjs');
const wrap = body => `%FSLAX24Y24*%%MOMM*%G01*${body}M02*`;
const outline = wrap('%ADD10C,0.254*%D10*X000000Y000000D02*X100000Y000000D01*X100000Y080000D01*X000000Y080000D01*X000000Y000000D01*');
const copper = wrap('%ADD10R,4X4*%D10*X050000Y040000D03*');
const drill = 'M48\nMETRIC,LZ,0000.00000\nT01C1.000\n%\nG05\nG90\nT01\nX5.0Y4.0\nM30';
const pack = files => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
const files = { 'nested/outline.GKO': outline, 'nested/copper.GTL': copper, 'nested/copper.GBL': copper, 'nested/plated.DRL': drill, 'nested/vias.DRL': drill,
  'nested/paste.GTP': copper, 'nested/paste.GBP': copper, 'nested/mask.GTS': copper, 'nested/silk.GTO': copper, 'readme.txt': 'metadata' };
const options = { thicknessMm: 1.6, engraveDepthMm: 0.1, toleranceMm: 0.01 };
const near = (a, b, tol = 1e-5) => assert.ok(Math.abs(a - b) < tol, `${a} ≈ ${b}`);

test('ZIP inventory recognizes related layers and leaves ordinary project ZIPs alone', () => {
  const summary = inspectBundle(pack(files));
  assert.equal(summary.outlines, 1); assert.equal(summary.top, true); assert.equal(summary.bottom, true); assert.equal(summary.drills, 2);
  assert.equal(summary.files.filter(f => f.role === 'paste').length, 2);
  assert.ok(summary.files.some(f => f.name === 'readme.txt' && f.role === 'other'));
  assert.equal(inspectBundle(pack({ 'project.json': '{}', 'model.stl': 'not a gerber' })), null);
});
test('outline centerline, not stroke width or a border, sets exact dimensions', async () => {
  const [bytes] = await convertBundle(pack(files), { ...options, includeDrills: false });
  const m = mesh(bytes);
  assert.deepEqual(m.min, [0, 0, 0]); near(m.max[0], 10); near(m.max[1], 8); near(m.max[2], 1.6);
  near(m.volume, 80 * 1.4 + 16 * 0.2);
});
test('duplicate drill files produce one through-hole and can be excluded', async () => {
  const two = (await convertBundle(pack(files), options))[0];
  const single = { ...files }; delete single['nested/vias.DRL'];
  const one = (await convertBundle(pack(single), options))[0];
  assert.deepEqual(two, one);
  const m = mesh(two);
  const undrilled = mesh((await convertBundle(pack(files), { ...options, includeDrills: false }))[0]);
  near(undrilled.volume - m.volume, Math.PI / 4 * 1.6, 0.04);
});
test('top-only and bottom-only choices put the recesses on the selected side', async () => {
  for (const sides of ['top', 'bottom']) {
    const b = (await convertBundle(pack(files), { ...options, sides, includeDrills: false }))[0];
    const m = mesh(b); near(m.volume, 80 * 1.5 + 16 * 0.1);
    const levels = new Set();
    for (let i = 0; i < b.readUInt32LE(80); i++) for (let j = 0; j < 3; j++) levels.add(b.readFloatLE(84 + i * 50 + 20 + j * 12).toFixed(1));
    assert.ok(levels.has(sides === 'top' ? '1.5' : '0.1'));
  }
  const deep = mesh((await convertBundle(pack(files), { ...options, sides: 'bottom', engraveDepthMm: 0.9, includeDrills: false }))[0]);
  near(deep.volume, 80 * 0.7 + 16 * 0.9);
});
test('closed profile cutouts become through-cutouts and multiple profiles become separate boards', async () => {
  const profile = wrap('%ADD10C,0.254*%D10*X000000Y000000D02*X100000Y000000D01*X100000Y080000D01*X000000Y080000D01*X000000Y000000D01*'
    + 'X020000Y020000D02*X030000Y020000D01*X030000Y030000D01*X020000Y030000D01*X020000Y020000D01*'
    + 'X200000Y000000D02*X300000Y000000D01*X300000Y080000D01*X200000Y080000D01*X200000Y000000D01*');
  const boards = await convertBundle(pack({ 'profile.GKO': profile, 'top.GTL': copper }), options);
  assert.equal(boards.length, 2); boards.forEach(mesh);
  near(mesh(boards[0]).max[0] - mesh(boards[0]).min[0], 10);
});
test('open outlines, missing or ambiguous layers, unsafe depths and malformed ZIPs fail', async () => {
  assert.throws(() => inspectBundle(new Uint8Array([1, 2, 3])));
  await assert.rejects(convertBundle(pack({ 'top.GTL': copper }), options), /outline/);
  await assert.rejects(convertBundle(pack({ ...files, 'second.GTL': copper }), options), /Multiple top/);
  await assert.rejects(convertBundle(pack(files), { ...options, engraveDepthMm: 0.8 }), /solid core/);
  await assert.rejects(parseArtwork(wrap('%ADD10C,0.1*%D10*X000000Y000000D02*X100000Y000000D01*'), 0.01, 'outline'), /open/);
});
test('X2 profile and copper metadata work with generic extensions', () => {
  const summary = inspectBundle(pack({ 'profile.gbr': outline.replace('G01*', '%TF.FileFunction,Profile,NP*%G01*'),
    'top.gbr': copper.replace('G01*', '%TF.FileFunction,Copper,L1,Top*%G01*'), 'bottom.gbr': copper.replace('G01*', '%TF.FileFunction,Copper,L2,Bot*%G01*') }));
  assert.equal(summary.outlines, 1); assert.ok(summary.top && summary.bottom);
});
test('ZIP IPC prompts with inventory, converts packages, and passes project ZIPs through', async () => {
  const handlers = new Map(); let prompts = 0;
  mod.activate({ settings: {}, intercept() {}, handle: (n, h) => handlers.set(n, h), log() {}, send: (name, data) => {
    assert.equal(name, 'pcb:prompt'); prompts++; assert.equal(data.summary.outlines, 1);
    handlers.get('pcb:answer')(data.id, { ...options, sides: 'both', includeDrills: true });
  } });
  const result = await handlers.get('pcb:zip')(pack(files), 'board.zip');
  assert.equal(result.recognized, true); mesh(result.bytes);
  assert.deepEqual(await handlers.get('pcb:zip')(pack({ 'project.json': '{}' }), 'project.zip'), { recognized: false });
  assert.equal(prompts, 1);
});
test('native Open preserves project ZIPs and aliases Gerber ZIPs to STL', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-zip-'));
  try {
    const file = path.join(temp, 'boards.zip'), project = path.join(temp, 'project.zip');
    fs.writeFileSync(file, pack(files)); fs.writeFileSync(project, pack({ 'project.json': '{}' }));
    const handlers = new Map(), hooks = new Map();
    mod.activate({ settings: {}, intercept: (n, h) => hooks.set(n, h), handle: (n, h) => handlers.set(n, h), log() {}, send: (name, data) => {
      assert.equal(name, 'pcb:prompt'); handlers.get('pcb:answer')(data.id, { ...options, sides: 'top' });
    } });
    const dialog = hooks.get('dialog:show-open'), read = hooks.get('store:read-binary-file');
    const args = dialog.before([{ filters: [{ extensions: ['stl', 'zip'] }] }]);
    const ordinary = { ok: true, data: { filePath: project, filePaths: [project] } };
    assert.deepEqual(await dialog.after(ordinary, args), ordinary);
    const selected = await dialog.after({ ok: true, data: { filePath: file, filePaths: [file] } }, args);
    assert.match(selected.data.filePath, /\.stl$/);
    const result = await read.after({ ok: true, data: fs.readFileSync(file) }, read.before([selected.data.filePath]));
    assert.equal(result.ok, true); mesh(result.data);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('automatic native Open sends every board in one batch and does not also import an alias', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pcb-batch-'));
  try {
    const file = path.join(temp, 'panel.gbr');
    fs.writeFileSync(file, wrap('%ADD10R,4X4*%%SRX4Y1I10J10*%D10*X000000Y000000D03*%SR*%'));
    const handlers = new Map(), hooks = new Map(), batches = [];
    mod.activate({ settings: {}, intercept: (n, h) => hooks.set(n, h), handle: (n, h) => handlers.set(n, h), log() {}, send: (name, data) => {
      if (name === 'pcb:prompt') handlers.get('pcb:answer')(data.id, { ...options, autoImport: true });
      else { assert.equal(name, 'pcb:batch'); batches.push(data); }
    } });
    const dialog = hooks.get('dialog:show-open');
    const args = dialog.before([{ filters: [{ extensions: ['stl', 'zip'] }] }]);
    const result = await dialog.after({ ok: true, data: { filePath: file, filePaths: [file] } }, args);
    assert.deepEqual(result, { ok: true, data: { canceled: true } });
    assert.equal(batches.length, 1); assert.equal(batches[0].length, 4);
    batches[0].forEach(board => mesh(board.bytes));
    assert.ok(batches[0][0].name.endsWith('board-1.stl'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
