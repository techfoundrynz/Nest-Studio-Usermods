const { test } = require('node:test');
const assert = require('node:assert/strict');
const { convertGerber, convertGerberBoards } = require('../dist/geometry');
const mod = require('../dist/main');
const gerber = (body, units = 'MM') => `%FSLAX24Y24*%\n%MO${units}*%\nG01*\n${body}\nM02*`;

function mesh(bytes) {
  const b = Buffer.from(bytes), count = b.readUInt32LE(80);
  assert.equal(b.length, 84 + count * 50);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  const edges = new Map();
  let volume = 0;
  for (let i = 0; i < count; i++) {
    const v = Array.from({ length: 3 }, (_, j) => Array.from({ length: 3 }, (_, k) => b.readFloatLE(84 + i * 50 + 12 + j * 12 + k * 4)));
    for (const p of v) p.forEach((n, k) => { assert.ok(Number.isFinite(n)); min[k] = Math.min(min[k], n); max[k] = Math.max(max[k], n); });
    for (let j = 0; j < 3; j++) {
      const a = v[j].join(','), c = v[(j + 1) % 3].join(',');
      assert.notEqual(a, c, 'nondegenerate edge');
      const key = [a, c].sort().join('|');
      const e = edges.get(key) || { count: 0, balance: 0 };
      e.count++; e.balance += a < c ? 1 : -1; edges.set(key, e);
    }
    const [a, c, d] = v;
    volume += (a[0] * (c[1] * d[2] - c[2] * d[1]) + a[1] * (c[2] * d[0] - c[0] * d[2]) + a[2] * (c[0] * d[1] - c[1] * d[0])) / 6;
  }
  for (const e of edges.values()) { assert.equal(e.count, 2, 'closed manifold'); assert.equal(e.balance, 0, 'consistent winding'); }
  assert.ok(volume > 0);
  return { min, max, volume, count };
}
const close = (a, b, tolerance = 1e-5) => assert.ok(Math.abs(a - b) < tolerance, `${a} ≈ ${b}`);

test('separated boards get independent bases, with no bridge across the gap', async () => {
  const text = gerber('%ADD10R,4X4*%D10*X000000Y000000D03*X100000Y000000D03*X200000Y000000D03*');
  const parts = await convertGerberBoards(text, 1.6, 0.01, 0.1);
  assert.equal(parts.length, 3);
  const models = parts.map(mesh);
  for (const m of models) { close(m.max[0] - m.min[0], 6); close(m.max[1] - m.min[1], 6); close(m.max[2], 1.6); }
  assert.ok(models[0].max[0] < models[1].min[0]);
  assert.ok(models[1].max[0] < models[2].min[0]);
  assert.equal((await convertGerberBoards(text, 1.6, 0.01, 0.1, 0)).length, 1);
});
test('multi-row panels split all boards, including step-repeat instances', async () => {
  const text = gerber('%ADD10R,4X4*%%SRX3Y2I10J10*%D10*X000000Y000000D03*%SR*%');
  const parts = await convertGerberBoards(text, 1.6, 0.01, 0.1);
  assert.equal(parts.length, 6);
  parts.forEach(mesh);
});
test('nearby disconnected pads and clear holes stay on the same board', async () => {
  const text = gerber('%ADD10C,4X2*%%ADD11R,1X1*%D10*X000000Y000000D03*D11*X030000Y000000D03*');
  assert.equal((await convertGerberBoards(text, 1.6, 0.01, 0.1)).length, 1);
  await assert.rejects(convertGerberBoards(text, 1.6, 0.01, 0.1, -1), /separation gap/);
});
test('drop conversion queues every additional board as a distinct STL', async () => {
  const handlers = new Map(), queued = [];
  mod.activate({ settings: {}, intercept() {}, handle: (n, h) => handlers.set(n, h), log() {}, send: (name, data) => {
    if (name === 'pcb:prompt') handlers.get('pcb:answer')(data.id, { thicknessMm: 1.6, engraveDepthMm: 0.1, splitGapMm: 2 });
    else if (name === 'pcb:boards') queued.push(...data);
    else assert.fail(name);
  } });
  const text = gerber('%ADD10R,4X4*%%SRX3Y2I10J10*%D10*X000000Y000000D03*%SR*%');
  mesh(await handlers.get('pcb:convert')(text, 'panel.gbr'));
  assert.equal(queued.length, 5);
  assert.deepEqual(queued.map(p => p.name), [2, 3, 4, 5, 6].map(i => `panel.gbr-board-${i}.stl`));
  queued.forEach(p => mesh(p.bytes));
});

test('engraving leaves a solid base and clear areas at exactly the requested depth', async () => {
  const artwork = gerber('%ADD10R,4X4*%%ADD11R,2X2*%D10*X000000Y000000D03*%LPC*%D11*X000000Y000000D03*');
  const bytes = await convertGerber(artwork, 1.6, 0.01, 0.1);
  const m = mesh(bytes);
  assert.deepEqual(m.min, [-3, -3, 0]); close(m.max[2], 1.6);
  // 6x6 rectangular base to 1.5 mm, plus 12 mm² of retained artwork to 1.6 mm.
  close(m.volume, 36 * 1.5 + 12 * 0.1);
  const levels = new Set();
  for (let i = 0; i < bytes.readUInt32LE(80); i++) for (let j = 0; j < 3; j++) levels.add(bytes.readFloatLE(84 + i * 50 + 20 + j * 12).toFixed(4));
  assert.deepEqual([...levels].sort(), ['0.0000', '1.5000', '1.6000']);
  const deeper = mesh(await convertGerber(artwork, 1.6, 0.01, 0.25));
  close(deeper.volume, 36 * 1.35 + 12 * 0.25);
});
test('engraved curved artwork with holes is a closed model', async () => {
  mesh(await convertGerber(gerber('%ADD10C,4X2*%D10*X000000Y000000D03*'), 1.6, 0.01, 0.1));
});
test('engraving depth is in mm even for inch artwork and cannot cut through the board', async () => {
  const artwork = gerber('%ADD10R,1X1*%D10*X000000Y000000D03*', 'IN');
  const m = mesh(await convertGerber(artwork, 1.6, 0.01, 0.1));
  close(m.max[0] - m.min[0], 27.4, 0.0001); close(m.max[2], 1.6);
  for (const depth of [0, -0.1, NaN, Infinity, 1.6, 2]) await assert.rejects(convertGerber(artwork, 1.6, 0.01, depth), /Engraving depth/);
});
test('both Open and drop imports prompt, reject invalid answers, and cancel without conversion', async () => {
  const hooks = new Map(), handlers = new Map();
  let prompts = 0;
  mod.activate({ settings: {}, intercept: (n, h) => hooks.set(n, h), handle: (n, h) => handlers.set(n, h), log() {}, send: (name, data) => {
    assert.equal(name, 'pcb:prompt'); prompts++;
    assert.equal(data.engraveDepthMm, 0.1);
    assert.throws(() => handlers.get('pcb:answer')(data.id, { thicknessMm: 1.6, engraveDepthMm: 1.6 }), /positive depth/);
    handlers.get('pcb:answer')(data.id, null);
    assert.throws(() => handlers.get('pcb:answer')(data.id, null), /expired/);
  } });
  assert.equal(await handlers.get('pcb:convert')('some text', 'dropped.gbr'), null);
  const dialog = hooks.get('dialog:show-open');
  const args = dialog.before([{ filters: [{ extensions: ['stl'] }] }]);
  const result = await dialog.after({ ok: true, data: { filePath: 'selected.gbr' } }, args);
  assert.deepEqual(result, { ok: true, data: { canceled: true } });
  assert.equal(prompts, 2);
});
test('drop conversion uses the confirmed depth instead of the default', async () => {
  const handlers = new Map();
  mod.activate({ settings: {}, intercept() {}, handle: (n, h) => handlers.set(n, h), log() {}, send: (name, data) => {
    assert.equal(name, 'pcb:prompt');
    handlers.get('pcb:answer')(data.id, { thicknessMm: 2, engraveDepthMm: 0.3 });
  } });
  const bytes = await handlers.get('pcb:convert')(gerber('%ADD10R,2X2*%D10*X000000Y000000D03*'), 'drop.gbr');
  const m = mesh(bytes);
  close(m.max[2], 2); close(m.volume, 16 * 1.7 + 4 * 0.3);
});

test('rectangular flash has exact millimetre dimensions and outward closed faces', async () => {
  const m = mesh(await convertGerber(gerber('%ADD10R,4X2*%\nD10*X100000Y200000D03*'), 1.6));
  assert.deepEqual(m.min, [8, 19, 0]); close(m.max[0], 12); close(m.max[1], 21); close(m.max[2], 1.6); close(m.volume, 12.8);
});
test('inch input is converted to mm', async () => {
  const m = mesh(await convertGerber(gerber('%ADD10R,1X1*%\nD10*X000000Y000000D03*', 'IN'), 1));
  close(m.max[0] - m.min[0], 25.4); close(m.volume, 25.4 ** 2, 0.001);
});
test('overlapping flashes are unioned, not overlapping STL shells', async () => {
  const m = mesh(await convertGerber(gerber('%ADD10R,2X2*%\nD10*X000000Y000000D03*X010000Y000000D03*'), 1));
  close(m.volume, 6);
});
test('clear polarity cuts holes, then dark polarity can add an island', async () => {
  const m = mesh(await convertGerber(gerber('%ADD10R,4X4*%%ADD11R,2X2*%%ADD12R,1X1*%\nD10*X000000Y000000D03*%LPC*%D11*X000000Y000000D03*%LPD*%D12*X000000Y000000D03*'), 1));
  close(m.volume, 13);
});
test('standard aperture holes survive extrusion', async () => {
  const m = mesh(await convertGerber(gerber('%ADD10C,4X2*%D10*X000000Y000000D03*'), 1));
  close(m.volume, Math.PI * 3, 0.08);
});
test('obrounds and macro apertures are supported', async () => {
  mesh(await convertGerber(gerber('%ADD10O,4X2*%D10*X000000Y000000D03*')));
  const m = mesh(await convertGerber(gerber('%AMTEST*21,1,4,2,0,0,0*%\n%ADD10TEST*%D10*X000000Y000000D03*'), 1));
  close(m.volume, 8);
});
test('linear tracks and circular arcs produce closed solids', async () => {
  mesh(await convertGerber(gerber('%ADD10C,1*%D10*X000000Y000000D02*X100000Y000000D01*G75*G03*X100000Y100000I000000J050000D01*')));
});
test('regions and disconnected regions are filled', async () => {
  const m = mesh(await convertGerber(gerber('G36*X000000Y000000D02*X020000Y000000D01*X020000Y020000D01*X000000Y020000D01*X000000Y000000D01*G37*'), 1));
  close(m.volume, 4);
});
test('step repeat preserves every instance', async () => {
  const m = mesh(await convertGerber(gerber('%ADD10R,1X1*%%SRX2Y2I3J3*%D10*X000000Y000000D03*%SR*%'), 1));
  close(m.volume, 4); close(m.max[0] - m.min[0], 4);
});
test('X2 attributes do not alter geometry', async () => {
  mesh(await convertGerber(gerber('%TF.FileFunction,Copper,L1,Top*%%ADD10R,2X2*%D10*X000000Y000000D03*')));
});
test('malformed, empty, unsupported and oversized input fails explicitly', async () => {
  for (const input of ['not Gerber', gerber(''), gerber('%LR90*%'), gerber('%ADD10R,2X2*%D99*X000000Y000000D03*'), 'x'.repeat(8 * 1024 * 1024 + 1)]) {
    await assert.rejects(convertGerber(input));
  }
  await assert.rejects(convertGerber(gerber(''), NaN));
});
test('native Open aliases only selected Gerber files, reads the authorized source, and returns STL', async () => {
  const hooks = new Map(), handlers = new Map(), events = [];
  mod.activate({ settings: {}, intercept: (name, hook) => hooks.set(name, hook), handle: (name, handler) => handlers.set(name, handler), log() {}, send: (name, data) => {
    if (name === 'pcb:prompt') handlers.get('pcb:answer')(data.id, { thicknessMm: 1.6, engraveDepthMm: 0.1 });
    else events.push([name, data]);
  } });
  const dialog = hooks.get('dialog:show-open'), read = hooks.get('store:read-binary-file');
  const options = { filters: [{ name: 'Models', extensions: ['stl', 'step'] }] };
  const args = dialog.before([options]);
  assert.ok(args[0].filters[0].extensions.includes('grb'));
  assert.deepEqual(options.filters[0].extensions, ['stl', 'step']);
  const result = await dialog.after({ ok: true, data: { filePath: 'C:/board.GRB', filePaths: ['C:/board.GRB'] } }, args);
  const alias = result.data.filePath;
  assert.ok(alias.endsWith('.stl'));
  const readArgs = read.before([alias]);
  assert.equal(readArgs[0], 'C:/board.GRB');
  const converted = await read.after({ ok: true, data: Buffer.from(gerber('%ADD10R,2X2*%D10*X000000Y000000D03*')) }, readArgs);
  mesh(converted.data);
  assert.equal(read.before([alias]), undefined, 'single-use alias');
  assert.equal(read.before(['C:/unselected.grb.stl']), undefined);
  assert.equal(dialog.before([{ filters: [{ name: 'Project', extensions: ['zip'] }] }]), undefined);
  assert.equal(await dialog.after({ ok: true, data: { canceled: true } }, args), undefined);
  assert.equal(events.length, 0);
});
test('native STL is untouched, conversion failure returns an error instead of Gerber bytes', async () => {
  const hooks = new Map(), handlers = new Map();
  mod.activate({ settings: {}, intercept: (n, h) => hooks.set(n, h), handle: (n, h) => handlers.set(n, h), log() {}, send: (name, data) => {
    if (name === 'pcb:prompt') handlers.get('pcb:answer')(data.id, { thicknessMm: 1.6, engraveDepthMm: 0.1 });
  } });
  const dialog = hooks.get('dialog:show-open'), read = hooks.get('store:read-binary-file');
  const args = dialog.before([{ filters: [{ extensions: ['stl'] }] }]);
  const native = { ok: true, data: { filePath: 'part.stl', filePaths: ['part.stl'] } };
  assert.deepEqual(await dialog.after(native, args), native);
  const selected = await dialog.after({ ok: true, data: { filePath: 'bad.gbr' } }, args);
  const converted = await read.after({ ok: true, data: Buffer.from('bad') }, read.before([selected.data.filePath]));
  assert.equal(converted.ok, false); assert.match(converted.message, /RS-274X/);
});
