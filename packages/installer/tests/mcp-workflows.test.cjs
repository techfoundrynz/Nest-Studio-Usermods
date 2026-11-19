const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
require('tsx/cjs');
const { MCP_WORKFLOWS_BLOCK, MCP_PREPARE_WORKFLOWS_BLOCK, MCP_IO_BLOCK, patchMcpTabs } = require('../src/mcp-workflows.ts');
const { patchMcpProject, patchMcpArchive } = require('../src/mcp-bridge.ts');

function filesBridge() {
  const code = 'G21\nM06 T1\n' + 'G1 X1\n'.repeat(100000) + 'M30';
  const calls = [];
  const face = { setupId: 'top', side: 'top', file: { suggestedName: 'top', projectAxis: '4Axis', pathConfigList: [{ id: 'path', modelId: 'm', gcodes: [{ id: 'program', gcode: code, toolNum: 1 }] }] } };
  const ctx = {
    Blob, Uint8Array, btoa, TextEncoder, TextDecoder, AbortController, setTimeout, clearTimeout,
    readProjectProcessTree: () => ({}), buildProjectGcodeFaces: () => [face], buildProjectGcodeExportRequest: () => face.file,
    applyFourAxisExportGcodeRotation: () => {},
    streamExportGcodeFile: async (input, emit) => { calls.push(['export', input]); await emit(new TextEncoder().encode(input.pathConfigList[0].gcodes.map(g => g.gcode).join('\n'))); return true; },
    toolSlotsFromCutLibrary: () => ['1', '01'], __usermodTools: { list: async () => [{ slotNum: 1 }] },
    window: { api: { gcode: { validate: async (text, slots) => { calls.push(['validate', text.length, slots]); return { ok: true, data: { has_err: false } }; }, estimatedTime: async () => ({ ok: true, data: 100 }) } } },
    listPreviewFaceReportInputs: () => [{ faceId: 'top', key: 'report' }],
    faceToolpathReportCache: { acquire: async (key, work, signal) => { assert.equal(signal.aborted, false); return work(signal); } },
    requestFaceToolpathReport: async () => ({ risks: [{ kind: 'overcut' }], interiorRisk: true, inspectionGeometry: new Uint8Array(10000) }),
    getOvercutWarningState: r => r.interiorRisk
  };
  vm.runInNewContext(MCP_WORKFLOWS_BLOCK, ctx);
  return { run: (action, args = {}) => ctx.__usermodCamFiles(action, args, { document: { projectId: 'p' }, modelFiles: [] }, {}), ctx, face, calls, code };
}

test('complete-program validation preserves >512 KiB content, mounted slots and native rotary export conversion', async () => {
  const { run, calls, code } = filesBridge();
  const result = await run('validate_programs', { setupId: 'top', programId: 'program' });
  assert.ok(code.length > 512 * 1024);
  assert.equal(calls.find(c => c[0] === 'validate')[1], code.length);
  assert.deepEqual(calls.find(c => c[0] === 'validate')[2], ['1', '01']);
  assert.equal(typeof calls[0][1].rotateExportGcode, 'function');
  assert.equal(result.results[0].validation.has_err, false);
  assert.equal(result.postprocessorsApplied, false);
  await assert.rejects(run('validate_programs', { programId: 'program' }), /setupId/);
  await assert.rejects(run('validate_programs', { setupId: 'other' }), /No exportable/);
  await assert.rejects(run('validate_programs', { setupId: 'top', programId: 'missing' }), /Unknown/);
});

test('inspection returns native risk details without geometry buffers, and propagates unavailable inspection', async () => {
  const { run, ctx } = filesBridge();
  const result = await run('inspect_toolpaths');
  assert.equal(result.reports[0].overcut, true);
  assert.equal(result.reports[0].report.risks[0].kind, 'overcut');
  assert.equal(result.reports[0].report.inspectionGeometry, undefined);
  ctx.requestFaceToolpathReport = async () => { throw Error('unsupported inspection'); };
  await assert.rejects(run('inspect_toolpaths'), /unsupported/);
});

test('program listing excludes code payloads; NC export uses the native stream and rejects oversized output', async () => {
  const { run, code, ctx } = filesBridge();
  assert.ok(!JSON.stringify(await run('list_programs')).includes('G21'));
  const result = await run('export_nc_file', { setupId: 'top' });
  assert.equal(Buffer.from(result.base64, 'base64').toString(), code);
  assert.equal(result.extension, '.nc');
  ctx.streamExportGcodeFile = async (_, emit) => { await emit({ byteLength: 65 * 1024 * 1024 }); return true; };
  await assert.rejects(run('export_nc_file'), /64 MiB/);
});

test('operation inclusion and visibility are independent and setting an existing value is idempotent', async () => {
  const ignored = new Set(), hidden = new Set(), calls = [];
  const ctx = {
    snapshot: { document: {}, modelFiles: [] }, processTree: null, processTreeLoading: false, processTreeGenerating: false, fourAxisGenerating: false, exportingGcode: false,
    project: { projectId: 'p' }, simplificationState: { open: false }, isPrepareOperationEditing: () => false,
    generatedTree: { plans: [{ setupId: 's', modelId: 'm', data: { operations: [{ operation_id: 'op' }] } }] },
    ignoredProcessOperations: ignored, hiddenProcessOperations: hidden, getProcessOperationKey: () => 'key',
    handleToggleIgnoredProcessOperations: keys => { calls.push('ignore'); keys.forEach(k => ignored.has(k) ? ignored.delete(k) : ignored.add(k)); },
    handleToggleProcessOperations: keys => { calls.push('hide'); keys.forEach(k => hidden.has(k) ? hidden.delete(k) : hidden.add(k)); }
  };
  vm.runInNewContext('globalThis.run = async (action,args) => {' + MCP_PREPARE_WORKFLOWS_BLOCK + '}', ctx);
  const args = { setupId: 's', modelId: 'm', operationId: 'op' };
  await ctx.run('set_operation_enabled', { ...args, enabled: true }); assert.equal(calls.length, 0);
  await ctx.run('set_operation_enabled', { ...args, enabled: false });
  await ctx.run('set_operation_enabled', { ...args, enabled: false }); assert.deepEqual(calls, ['ignore']);
  await ctx.run('set_operation_visibility', { ...args, visible: false }); assert.deepEqual(calls, ['ignore', 'hide']);
  assert.equal(ignored.has('key'), true);
  await assert.rejects(ctx.run('set_operation_enabled', { ...args, modelId: 'other', enabled: true }), /Unknown/);
  ctx.processTreeGenerating = true;
  await assert.rejects(ctx.run('set_operation_enabled', { ...args, enabled: true }), /wait for generation/);
});

test('project IO reports cancelled/failed imports and saves rather than claiming completion', async () => {
  let accepted = false;
  const ctx = {
    reactExports: { useEffect: fn => fn() }, Uint8Array, atob,
    parseProjectZipBytes: async () => ({}), captureNestConfirmViewScope: () => 'view', importLoadedProjectZip: async () => accepted,
    activeProjectId: 'p', activeProjectMissingFromRecent: false, persistProject: async () => accepted,
    jotaiStore: { get: atom => atom === 'active' ? 'p' : [{ projectId: 'p', filePath: 'p.zip' }] }, activeProjectIdAtom: 'active', projectTabItemsAtom: 'tabs'
  };
  vm.runInNewContext(MCP_IO_BLOCK, ctx);
  const run = ctx.__usermodMcpIo.run;
  await assert.rejects(run('open_project', { base64: '', name: 'p.zip' }), /cancelled or rejected/);
  await assert.rejects(run('save_project', { projectId: 'other' }), /Activate/);
  await assert.rejects(run('save_project', { projectId: 'p' }), /cancelled or failed/);
  accepted = true;
  assert.equal((await run('save_project', { projectId: 'p' })).status, 'saved');
});

test('new gateway references bind to installed native scope, and tab patch anchors are unambiguous', { skip: !fs.existsSync('C:/Program Files/nest-studio/resources/app.asar.orig') }, () => {
  const { list, readEntry } = require('../../asar/dist/index.js');
  const ts = require('typescript');
  const archive = 'C:/Program Files/nest-studio/resources/app.asar.orig';
  const entries = list(archive);
  const read = prefix => readEntry(archive, entries.find(e => new RegExp('assets/' + prefix + '-.*\\.js$').test(e.path)).path).toString();
  const patched = [['full.js', patchMcpArchive(read('FullApp'))], ['prepare.js', patchMcpProject(read('PreparePageContent'))], ['tabs.js', patchMcpTabs(read('ProjectPage'))]];
  const options = { allowJs: true, noLib: true, noResolve: true, target: ts.ScriptTarget.ESNext };
  const sources = new Map(patched.map(([name, source]) => [name, ts.createSourceFile(name, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)]));
  const host = ts.createCompilerHost(options);
  host.getSourceFile = name => sources.get(name);
  const checker = ts.createProgram([...sources.keys()], options, host).getTypeChecker();
  const globals = new Set(['globalThis', 'window', 'Error', 'JSON', 'Object', 'Array', 'Number', 'String', 'Boolean', 'Math', 'Set', 'Map', 'Blob', 'Uint8Array', 'TextDecoder', 'AbortController', 'setTimeout', 'clearTimeout', 'btoa', 'atob', 'undefined']);
  const missing = new Set();
  for (const [name, source] of patched) {
    const blocks = name === 'full.js' ? [MCP_WORKFLOWS_BLOCK, MCP_IO_BLOCK] : name === 'prepare.js' ? [require('../src/mcp-bridge.ts').MCP_PROJECT_BLOCK] : [];
    const ranges = blocks.map(block => [source.indexOf(block), source.indexOf(block) + block.length]);
    function visit(node) {
      if (ts.isIdentifier(node) && ranges.some(([a,b]) => node.getStart() >= a && node.end <= b)) {
        const parent = node.parent;
        const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node) || (ts.isBindingElement(parent) && parent.propertyName === node);
        if (!propertyName && !globals.has(node.text) && !checker.getSymbolAtLocation(node)) missing.add(name + ':' + node.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(sources.get(name));
  }
  assert.deepEqual([...missing], []);
  assert.equal(patchMcpTabs(patched[2][1]), patched[2][1]);
  assert.throws(() => patchMcpTabs(''), /anchor/);
});
