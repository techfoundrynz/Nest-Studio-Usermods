const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

test('main integration requires local approval, serializes mutations, keeps credentials out of logs and shuts down', async t => {
  const mod = require('../dist/main.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-mcp-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const handlers = new Map(), callbacks = new Map(), logs = [], actions = [];
  let approve;
  let response = 0;
  const fixtures = {};
  const win = { isDestroyed: () => false, webContents: { isLoading: () => false, executeJavaScript: script => vm.runInNewContext(script, { __usermodMcpDispatch: async (name, args) => { if (name !== 'get_status') actions.push([name, args]); return fixtures[name] ?? { connected: true, address: '192.168.1.9' }; } }) } };
  // Reserve an available port first, then release it for the plugin.
  const probe = require('node:net').createServer(); probe.listen(0, '127.0.0.1'); await require('node:events').once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  mod.activate({
    settings: { port }, dataDir: dir, modDir: path.resolve(__dirname, '../../..'), runPostprocessors: async (stage, text) => { assert.equal(stage, 'export'); return text + '\n(postprocessed)'; }, app: { getVersion: () => '2.0.1', once: (event, fn) => callbacks.set(event, fn) },
    electron: { dialog: { showMessageBox: async () => { if (response === 'wait') return new Promise(resolve => { approve = resolve; }); return { response }; } } },
    getMainWindow: () => win, handle: (name, fn) => handlers.set(name, fn), call: async () => { throw Error('disabled'); },
    log: (...v) => logs.push(v), warn: (...v) => logs.push(v)
  });
  t.after(() => callbacks.get('before-quit')());
  for (let i = 0; i < 100 && !handlers.get('mcp:status')().listening; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(handlers.get('mcp:status')().listening, true);
  const config = handlers.get('mcp:client-config')().mcpServers['nest-studio'];
  const client = new Client({ name: 'main-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }));
  t.after(() => client.close());
  let r = await client.callTool({ name: 'send_machine_command', arguments: { command: 'M5' } });
  assert.equal(r.isError, true); assert.equal(actions.length, 0);
  response = 'wait';
  const pending = client.callTool({ name: 'send_machine_command', arguments: { command: 'M5' } });
  for (let i = 0; i < 100 && !approve; i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(approve);
  r = await client.callTool({ name: 'disconnect_machine', arguments: {} });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /Another MCP action/);
  approve({ response: 1 });
  assert.equal((await pending).isError, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(actions)), [['send_machine_command', { command: 'M5', expectedConnection: { address: '192.168.1.9', connectionType: null } }]]);
  const history = await client.callTool({ name: 'list_jobs', arguments: {} });
  assert.equal(JSON.parse(history.content[0].text).available, false);
  const logged = JSON.stringify(logs);
  assert.ok(!logged.includes('M5')); assert.ok(!logged.includes(config.headers.Authorization));
  fixtures.export_nc_file = { base64: Buffer.from('G21\nM30').toString('base64'), extension: '.nc' };
  const target = path.join(dir, 'review.nc');
  r = await client.callTool({ name: 'export_nc_file', arguments: { projectId: 'p', setupId: 's', filePath: target } });
  assert.equal(r.isError, undefined, r.content[0].text);
  assert.equal(fs.readFileSync(target, 'utf8'), 'G21\nM30\n(postprocessed)');
  const count = actions.length;
  r = await client.callTool({ name: 'export_nc_file', arguments: { projectId: 'p', filePath: target } });
  assert.equal(r.isError, true); assert.equal(actions.length, count);
  assert.equal(fs.readFileSync(target, 'utf8'), 'G21\nM30\n(postprocessed)');
  assert.equal(fs.readdirSync(dir).some(name => name.endsWith('.tmp')), false);
  r = await client.callTool({ name: 'export_nc_file', arguments: { projectId: 'p', filePath: path.join(dir, 'wrong.zip') } });
  assert.equal(r.isError, true); assert.equal(fs.existsSync(path.join(dir, 'wrong.zip')), false);
  fixtures.open_project = { status: 'opened', projectId: 'p' };
  const zip = path.join(dir, 'project.zip'); fs.writeFileSync(zip, Buffer.from([80,75,3,4,1]));
  r = await client.callTool({ name: 'open_project', arguments: { filePath: zip } });
  assert.equal(r.isError, undefined);
  assert.equal(actions.at(-1)[1].name, 'project.zip');
  assert.equal(actions.at(-1)[1].base64, Buffer.from([80,75,3,4,1]).toString('base64'));
  fs.writeFileSync(zip, 'not a zip');
  r = await client.callTool({ name: 'open_project', arguments: { filePath: zip } }); assert.equal(r.isError, true);
});
