const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { zipSync, unzipSync } = require('fflate');
require('tsx/cjs');
const { transformExportFile } = require('../src/export-file.ts');
const { patchStreamExport } = require('../../installer/src/compatibility.ts');

async function directory(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nest-export-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test('streamed NC file is transformed once using the chosen destination, before commit', async t => {
  const dir = await directory(t), tmp = path.join(dir, 'write.tmp'), target = path.join(dir, 'part.nc');
  await fs.writeFile(tmp, 'G1 X1 F100\n'); await fs.writeFile(target, 'old file');
  let calls = 0;
  await transformExportFile(tmp, target, async (text, ctx) => {
    calls++; assert.equal(ctx.filePath, target); assert.equal(ctx.fileName, 'part.nc');
    return text.replace('F100', 'F200');
  });
  assert.equal(calls, 1); assert.match(await fs.readFile(tmp, 'utf8'), /F200/);
  assert.equal(await fs.readFile(target, 'utf8'), 'old file');
});
test('each G-code ZIP member is transformed and entry paths are preserved', async t => {
  const dir = await directory(t), tmp = path.join(dir, 'write.tmp');
  await fs.writeFile(tmp, zipSync({ 'top.nc': Buffer.from('F100'), 'sides/bottom.nc': Buffer.from('F200') }));
  const contexts = [];
  await transformExportFile(tmp, path.join(dir, 'part.zip'), async (text, ctx) => { contexts.push(ctx); return text + '\nM5\n'; });
  const files = unzipSync(await fs.readFile(tmp));
  assert.deepEqual(Object.keys(files).sort(), ['sides/bottom.nc', 'top.nc']);
  assert.match(Buffer.from(files['top.nc']).toString(), /M5/);
  assert.match(Buffer.from(files['sides/bottom.nc']).toString(), /M5/);
  assert.equal(contexts.length, 2); assert.notEqual(contexts[0].filePath, contexts[1].filePath);
});
test('project ZIP, including embedded NC, stays byte-for-byte unchanged', async t => {
  const dir = await directory(t), tmp = path.join(dir, 'project.tmp');
  const bytes = zipSync({ 'project.json': Buffer.from('{}'), 'path.nc': Buffer.from('F100') });
  await fs.writeFile(tmp, bytes);
  await transformExportFile(tmp, path.join(dir, 'project.zip'), async () => { throw new Error('must not run'); });
  assert.deepEqual(await fs.readFile(tmp), Buffer.from(bytes));
});
test('large non-G-code project saves do not enter the processing size limit', async t => {
  const dir = await directory(t), tmp = path.join(dir, 'project.tmp');
  const handle = await fs.open(tmp, 'w'); await handle.truncate(257 * 1024 * 1024); await handle.close();
  await transformExportFile(tmp, path.join(dir, 'project.zip'), async () => { throw new Error('must not run'); });
});
test('native commit preserves the old destination and removes its temp file when processing fails', async t => {
  const dir = await directory(t), tmp = path.join(dir, 'write.tmp'), target = path.join(dir, 'part.nc');
  await fs.writeFile(tmp, 'new'); await fs.writeFile(target, 'old');
  const source = `async function finish(session) {
  try {
    await session.handle.close();
    await promises$1.rename(session.tempPath, session.targetPath);
  } catch (error) { await promises$1.unlink(session.tempPath); throw error; }
}`;
  const patched = patchStreamExport(source, 'loader');
  const context = { promises$1: fs, require: () => ({ processExportFile: async () => { throw new Error('processing failed'); } }) };
  vm.runInNewContext(patched + '\nglobalThis.finish = finish;', context);
  await assert.rejects(context.finish({ tempPath: tmp, targetPath: target, handle: { close: async () => {} } }), /processing failed/);
  assert.equal(await fs.readFile(target, 'utf8'), 'old');
  await assert.rejects(fs.stat(tmp), { code: 'ENOENT' });
});
test('unsafe G-code ZIP paths are rejected before transformation', async t => {
  const dir = await directory(t), tmp = path.join(dir, 'write.tmp');
  await fs.writeFile(tmp, zipSync({ '../bad.nc': Buffer.from('G0') }));
  await assert.rejects(transformExportFile(tmp, path.join(dir, 'out.zip'), async x => x), /Unsafe path/);
});
