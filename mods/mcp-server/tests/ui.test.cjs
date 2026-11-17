const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('renderer uses native APIs, preserves magazine slots, checks versions and connection identity', async () => {
  const calls = [];
  const ok = data => ({ ok: true, data });
  let connected = true;
  const ctx = { window: {
    usermodRuntime: { register: () => {}, tools: { list: async () => [{ id: 't', slotNum: 3 }], save: async (...args) => { calls.push(['save', ...args]); return {}; } } },
    usermodUI: { react: {}, toolbar: { addButton: () => {} } },
    api: {
      device: { getStatus: async () => ok({ connected, address: '192.168.1.9' }), sendMessage: async data => { calls.push(['send', data]); return ok({}); } },
      gcode: { validate: async () => ({ ok: false, message: 'CAM unavailable' }) }
    }
  } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../dist/ui.js'), 'utf8'), ctx);
  const run = ctx.__usermodMcpDispatch;
  await assert.rejects(run('send_machine_command', { command: 'M5' }), /connection changed/);
  await assert.rejects(run('send_machine_command', { command: 'M5', expectedConnection: { address: 'other', connectionType: null } }), /connection changed/);
  assert.equal(calls.length, 0);
  const approved = { command: 'M5', expectedConnection: { address: '192.168.1.9', connectionType: null } };
  await run('send_machine_command', approved); assert.equal(calls.at(-1)[1].payload, 'M5');
  connected = false; await assert.rejects(run('send_machine_command', approved), /No machine/);
  await assert.rejects(run('save_tool', { replace: true, tool: { id: 't' } }), /expectedVersion/);
  await run('save_tool', { replace: true, expectedVersion: 4, tool: { id: 't', slotNum: 99 } });
  assert.equal(calls.at(-1)[1].slotNum, 3); assert.equal(calls.at(-1)[3], 4);
  await run('save_tool', { replace: false, tool: { id: 'new', slotNum: 99 } });
  assert.equal(calls.at(-1)[1].slotNum, null);
  await assert.rejects(run('validate_gcode', { gcode: 'M5' }), /CAM unavailable/);
  await assert.rejects(run('get_project', { projectId: 'p' }), /Prepare page/);
  await assert.rejects(run('open_file', { name: 'Upper.step', base64: '' }), /model-import bridge unavailable/);
  ctx.atob = atob; ctx.File = File;
  let imported = false;
  ctx.__usermodModelImport = { importFiles: async (files, progress, options) => {
    assert.equal(files.length, 1); assert.equal(files[0].name, 'Upper.step');
    assert.equal(await files[0].text(), 'ISO-10303-21;');
    imported = true;
    assert.equal(options.axis, '4Axis'); assert.equal(options.newProject, true);
    return { imported: 1, total: 1, projectId: 'new-project' };
  } };
  const result = await run('open_file', { name: 'Upper.step', base64: Buffer.from('ISO-10303-21;').toString('base64'), axis: '4Axis', newProject: true });
  assert.ok(imported); assert.equal(result.projectId, 'new-project');
  ctx.__usermodModelImport.importFiles = async () => ({ imported: 0, total: 1, projectId: 'new-project', error: 'Import cancelled' });
  await assert.rejects(run('open_file', { name: 'Upper.step', base64: '' }), /Import cancelled/);
  const capabilities = await run('get_machining_capabilities', {});
  assert.ok(capabilities.axes.includes('4Axis')); assert.equal(capabilities.threeAxis.customOperations.length, 5);
});
