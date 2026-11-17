const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createHttpServer } = require('../dist/server.js');
const token = 'a'.repeat(64);

async function start(t, dispatch) {
  const server = createHttpServer(token, dispatch);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(r => server.close(r)); });
  return new URL(`http://127.0.0.1:${server.address().port}/mcp`);
}
async function client(t, url) {
  const c = new Client({ name: 'regression-client', version: '1' });
  await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => c.close()); return c;
}
test('official client initializes, discovers tools and reads status over authenticated Streamable HTTP', async t => {
  const calls = [];
  const url = await start(t, async (name, args) => { calls.push([name, args]); return { connected: false }; });
  const c = await client(t, url);
  const { tools } = await c.listTools();
  assert.equal(tools.length, 33);
  assert.equal(tools.find(x => x.name === 'get_status').annotations.readOnlyHint, true);
  assert.equal(tools.find(x => x.name === 'send_machine_command').annotations.destructiveHint, true);
  const result = await c.callTool({ name: 'get_status', arguments: {} });
  assert.equal(JSON.parse(result.content[0].text).connected, false);
  assert.deepEqual(calls, [['get_status', {}]]);
});
test('invalid commands, stock, pairing codes and tool inputs never reach dispatch', async t => {
  const calls = [];
  const c = await client(t, await start(t, async (...args) => { calls.push(args); return {}; }));
  for (const [name, args] of [
    ['send_machine_command', { command: 'G0 X1\nM3' }],
    ['set_stock_dimensions', { projectId: 'p', width: -1, length: 10, thickness: 2 }],
    ['connect_machine', { ipAddress: 'https://example.com', codeValue: '123456' }],
    ['save_tool', { tool: { id: 'x', name: 'x', type: 'endmill', diameter: 0 } }]
  ]) {
    const r = await c.callTool({ name, arguments: args }); assert.equal(r.isError, true);
  }
  assert.equal(calls.length, 0);
});
test('tool errors are MCP errors, not successful results, and no retries occur', async t => {
  let calls = 0;
  const c = await client(t, await start(t, async () => { calls++; throw Error('No machine connected'); }));
  const r = await c.callTool({ name: 'send_machine_command', arguments: { command: 'M5' } });
  assert.equal(r.isError, true); assert.match(r.content[0].text, /No machine connected/); assert.equal(calls, 1);
});
test('HTTP rejects missing credentials, foreign Host/Origin, unknown paths and methods', async t => {
  const url = await start(t, async () => { throw Error('must not dispatch'); });
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await fetch(url)).status, 401);
  const badHost = await new Promise((resolve, reject) => {
    http.get(url, { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await fetch(url, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(new URL('/nope', url), { headers })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: 'x'.repeat(1024 * 1024 + 1) })).status, 413);
});
