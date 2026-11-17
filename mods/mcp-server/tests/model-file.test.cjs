const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readModelFile, MAX_MODEL_BYTES } = require('../dist/model-file.js');

test('model reader accepts STEP/STL bytes and rejects other files, missing paths, directories and oversized files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nest-model-read-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.step');
  await fs.writeFile(file, 'ISO-10303-21;');
  const result = await readModelFile(file);
  assert.equal(result.name, 'model.step'); assert.equal(Buffer.from(result.base64, 'base64').toString(), 'ISO-10303-21;');
  await assert.rejects(readModelFile('model.step'), /absolute/);
  await fs.writeFile(path.join(dir, 'secret.txt'), 'not a model');
  await assert.rejects(readModelFile(path.join(dir, 'secret.txt')), /supports STEP/);
  await assert.rejects(readModelFile(path.join(dir, 'absent.step')), /ENOENT/);
  await fs.mkdir(path.join(dir, 'folder.stl'));
  await assert.rejects(readModelFile(path.join(dir, 'folder.stl')), /regular file/);
  await fs.writeFile(file, ''); await assert.rejects(readModelFile(file), /nonempty/);
  const large = await fs.open(file, 'w'); await large.truncate(MAX_MODEL_BYTES + 1); await large.close();
  await assert.rejects(readModelFile(file), /32 MiB/);
});
