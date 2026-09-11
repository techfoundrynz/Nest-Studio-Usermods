const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
require('tsx/cjs');
const { patchModelImport, MODEL_IMPORT_BLOCK, MODEL_IMPORT_MARKER } = require('../../../packages/installer/src/model-import.ts');

function bridge(importer, overrides = {}) {
  const projects = [];
  const context = vm.createContext({
    reactExports: { useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: fn => fn() },
    activeProjectGenerating: false, isOnProject: true, activeTab: { projectType: '3D', projectAxis: '3Axis' },
    activeProjectId: 'existing', addProject: axis => { projects.push(axis); return 'new'; }, importModelFile: importer,
    ...overrides
  });
  vm.runInContext(MODEL_IMPORT_BLOCK, context);
  return { api: context.__usermodModelImport, projects };
}
test('installer bridge is anchored, idempotent, and rejects incompatible renderer source', () => {
  const source = '  }, [loadModelFile]);\n  const onNewProject = reactExports.useCallback(() => {';
  const patched = patchModelImport(source);
  assert.ok(patched.includes(MODEL_IMPORT_MARKER));
  assert.equal(patchModelImport(patched), patched);
  assert.throws(() => patchModelImport('changed app source'), /anchor/);
});
test('native batch bridge awaits every committed model and pins the target project', async () => {
  const calls = []; let finish;
  const { api } = bridge((file, project) => { calls.push([file.name, project]); return new Promise(resolve => { finish = resolve; }); });
  const result = api.importFiles([{ name: '1.stl' }, { name: '2.stl' }, { name: '3.stl' }]);
  assert.equal(calls.length, 1);
  await assert.rejects(api.importFiles([{ name: 'other.stl' }]), /already/);
  finish(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 2);
  finish(true); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.length, 3);
  finish(true);
  assert.equal((await result).imported, 3);
  assert.deepEqual(calls.map(c => c[1]), ['existing', 'existing', 'existing']);
});
test('batch stops on cancellation/failure and reports only confirmed imports', async () => {
  let count = 0;
  const { api } = bridge(async () => ++count !== 2);
  const result = await api.importFiles([{ name: '1' }, { name: '2' }, { name: '3' }]);
  assert.equal(count, 2); assert.equal(result.imported, 1); assert.match(result.error, /cancelled or failed/);
});
test('batch creates one 3-axis project from Home or a 4-axis project', async () => {
  for (const overrides of [{ isOnProject: false }, { activeTab: { projectType: '3D', projectAxis: '4Axis' } }]) {
    const { api, projects } = bridge(async (_file, project) => { assert.equal(project, 'new'); return true; }, overrides);
    assert.equal((await api.importFiles([{ name: '1' }, { name: '2' }])).imported, 2);
    assert.deepEqual(projects, ['3Axis']);
  }
});
test('UI automatically imports all boards and retries only failed/unattempted boards', async () => {
  const events = new Map(), buttons = [], calls = [];
  let toolbar, badge = false;
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/ui.js'), 'utf8'), {
    __usermodModelImport: { async importFiles(files) {
      calls.push(files.map(f => f.name));
      return calls.length === 1 ? { imported: 1, total: files.length, error: 'cancelled', projectId: 'test' }
        : { imported: files.length, total: files.length, projectId: 'test' };
    } },
    window: {
      usermodRuntime: { register() {}, toast() {}, el() { return {}; } },
      usermod: { on: (name, fn) => events.set(name, fn) }, addEventListener() {},
      usermodUI: {
        toolbar: { addButton(value) { toolbar = value; return { setBadge(value) { badge = value; } }; } },
        modal() { return { body: { append() {} }, close() {} }; }, settingsForm() { return {}; },
        button(label, onClick) { const b = { label, onClick }; buttons.push(b); return b; }
      }
    }, Uint8Array, File
  });
  events.get('pcb:batch')([1, 2, 3, 4].map(i => ({ name: `board-${i}.stl`, bytes: new Uint8Array([i]) })));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].length, 4); assert.equal(badge, true);
  toolbar.onClick(); buttons.find(b => b.label === 'Retry remaining boards').onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(calls[1]), JSON.stringify(['board-2.stl', 'board-3.stl', 'board-4.stl']));
  assert.equal(badge, false);
});
