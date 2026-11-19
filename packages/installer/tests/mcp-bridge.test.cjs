const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('tsx/cjs');
const { patchMcpProject, MCP_PROJECT_BLOCK, patchMcpArchive, MCP_ARCHIVE_BLOCK } = require('../src/mcp-bridge.ts');

function bridge(overrides = {}) {
  let document = { projectId: 'p', projectName: 'Before', saveCoordsSystemList: [{ id: 'top' }] };
  const calls = [];
  const ctx = {
    active: true, project: document, session: { getProjectTabs: () => [document] },
    PROJECT_ENTITY_NAME_MAX_LENGTH: 80, NAME_ALLOWED_PATTERN: /^[^<>:"/\\|?*]+$/,
    projectCommands: { read: () => ({ document, modelFiles: [{ modelId: 'm' }] }), commit: x => { assert.equal(x.expectedDocument, document); calls.push(['commit', x]); document = x.document; return true; } },
    reactExports: { useEffect: fn => fn() }, fourAxisGenerating: false, processTreeLoading: false, processTreeGenerating: false, exportingGcode: false,
    recordProjectSnapshot: (...args) => calls.push(['history', ...args]),
    handleBlankDimensionsCommit: args => calls.push(['stock', args]), guideStep: false, canStartToolpathGeneration: () => true,
    toolpathRegeneration: { start: () => calls.push(['generate']) }, hasGeneratedProcessTree: true,
    handleProcessTreeExportGcode: args => calls.push(['export', args]), canMachine: true, machiningFlow: { start: () => calls.push(['machine']) },
    processTree: null, hasGeneratedProcessTree: false,
    patchActiveModelItemTransform: (p, id, update) => { calls.push(['transform', id, update]); return { ...p, transformed: true }; },
    projectMetadataCommands: { patchTransforms: p => { calls.push(['patchTransforms']); document = p; } },
    reloadSceneForCoordsTab: async () => calls.push(['reloadScene']),
    onRunRepair: async args => { assert.equal(args.modelId, 'm'); assert.equal(args.signal.aborted, false); calls.push(['repair']); },
    AbortController, setTimeout, clearTimeout,
    handleGenerateProcessTree: async (tree, drafts, mode, sides) => { calls.push(['generatePlan', tree, drafts, mode, sides]); return true; },
    millingDrafts: { setup: { setting: 'native' } },
    ...overrides
  };
  vm.runInNewContext(MCP_PROJECT_BLOCK, ctx);
  return { run: ctx.__usermodMcpProject?.run, calls, ctx };
}
test('MCP patch is idempotent and rejects missing or ambiguous native anchors', () => {
  const source = '  const blankBoundaryAlertVisible = blankProximity.visible && !dimensionLinkage.open;';
  const patched = patchMcpProject(source); assert.equal(patchMcpProject(patched), patched);
  assert.throws(() => patchMcpProject(''), /anchor/); assert.throws(() => patchMcpProject(source + source), /anchor/);
});
test('native project rename commits with expected document and undo history; wrong project cannot mutate', async () => {
  const { run, calls } = bridge();
  await assert.rejects(run('rename_project', { projectId: 'other', name: 'After' }), /requested project/);
  assert.equal(calls.length, 0);
  await run('rename_project', { projectId: 'p', name: 'After' });
  assert.equal(calls[0][1].dirty, 'meta'); assert.equal(calls[1][0], 'history');
  assert.equal((await run('get_project', { projectId: 'p' })).projectName, 'After');
});
test('native workflow requests retain stock, generation, export and machining gates', async () => {
  const { run, calls, ctx } = bridge({ hasGeneratedProcessTree: true });
  await run('set_stock_dimensions', { projectId: 'p', width: 10, length: 20, thickness: 3 });
  await run('generate_toolpaths', { projectId: 'p' });
  await run('export_toolpaths', { projectId: 'p', setupId: 'top' });
  await run('start_machining', { projectId: 'p' });
  assert.deepEqual(calls.map(x => x[0]), ['stock', 'generate', 'export', 'machine']);
  const n = calls.length;
  await assert.rejects(run('export_toolpaths', { projectId: 'p', setupId: 'absent' }), /Unknown setup/);
  ctx.canMachine = false; await assert.rejects(run('start_machining', { projectId: 'p' }), /blocked/);
  ctx.canStartToolpathGeneration = () => false; await assert.rejects(run('generate_toolpaths', { projectId: 'p' }), /blocked/);
  ctx.handleBlankDimensionsCommit = undefined; await assert.rejects(run('set_stock_dimensions', { projectId: 'p' }), /locked/);
  ctx.processTreeLoading = true; await assert.rejects(run('rename_project', { projectId: 'p', name: 'x' }), /Wait/);
  assert.equal(calls.length, n);
  assert.equal(bridge({ active: false }).run, undefined);
});

test('native transform preserves units, repairs use cancellation and planned generation retains native drafts', async () => {
  const { run, calls, ctx } = bridge();
  await assert.rejects(run('transform_model', { projectId: 'p', modelId: 'absent' }), /Model not found/);
  await run('transform_model', { projectId: 'p', modelId: 'm', rotationDeg: { x: 0, y: -180, z: 45 }, position: { x: 0, y: 0, z: -8 } });
  const transform = calls.find(x => x[0] === 'transform')[2];
  assert.equal(transform.rotation.y, -Math.PI); assert.equal(transform.rotation.z, Math.PI / 4); assert.equal(transform.position.z, -8);
  assert.ok(calls.some(x => x[0] === 'reloadScene')); assert.ok(calls.some(x => x[0] === 'history'));
  await run('repair_model', { projectId: 'p', modelId: 'm' }); assert.ok(calls.some(x => x[0] === 'repair'));
  await assert.rejects(run('generate_planned_toolpaths', { projectId: 'p', sides: ['top'] }), /Request generate_toolpaths/);
  ctx.processTree = { projectId: 'p', setups: [], initialDrafts: { initial: { setting: 'initial native draft' } } };
  await assert.rejects(run('transform_model', { projectId: 'p', modelId: 'm' }), /only before planning/);
  const result = await run('generate_planned_toolpaths', { projectId: 'p', sides: ['top'] });
  assert.equal(result.status, 'generated');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)[2])), { initial: { setting: 'initial native draft' }, ...ctx.millingDrafts });
  assert.equal(calls.at(-1)[3], 'overwrite');
  ctx.handleGenerateProcessTree = async () => false;
  await assert.rejects(run('generate_planned_toolpaths', { projectId: 'p', sides: ['top'] }), /did not complete/);
});

test('project copy uses native archive entries and streams model/toolpath bytes', async () => {
  let input;
  const ctx = { Blob, btoa, Uint8Array,
    createProjectZipEntries: value => { input = value; return [{ native: true }]; },
    streamProjectZip: async (entries, write) => { assert.equal(entries[0].native, true); await write(Uint8Array.from([80, 75, 3, 4])); await write(Uint8Array.from([1, 2])); }
  };
  vm.runInNewContext(MCP_ARCHIVE_BLOCK, ctx);
  const project = { projectId: 'p' }, files = [{ relativePath: 'model.stl' }];
  const encoded = await ctx.__usermodProjectZip(project, files);
  assert.deepEqual([...Buffer.from(encoded, 'base64')], [80, 75, 3, 4, 1, 2]);
  assert.equal(input.project, project); assert.equal(input.modelFiles, files);
  ctx.streamProjectZip = async (_, write) => write({ byteLength: 65 * 1024 * 1024 });
  await assert.rejects(ctx.__usermodProjectZip(project, files), /64 MiB/);
  const source = 'function createProjectZipEntries(input) {}\nfunction io() {\n  return {\n    tabItems,\n    activeProjectId,\n    canSaveActive,\n    openProjectDialog,\n }; }';
  assert.equal(patchMcpArchive(patchMcpArchive(source)), patchMcpArchive(source));
  assert.throws(() => patchMcpArchive(''), /archive anchor/);
});

test('project-copy gateway refuses unstable or busy snapshots', async () => {
  const { run, ctx } = bridge();
  ctx.__usermodProjectZip = async (project, models) => {
    assert.equal(project.filePath, '/new.zip'); assert.equal(project.isSave, true); assert.equal(models.length, 1); return 'native-base64';
  };
  assert.equal((await run('save_project_copy', { projectId: 'p', filePath: '/new.zip' })).base64, 'native-base64');
  ctx.processTreeGenerating = true;
  await assert.rejects(run('save_project_copy', { projectId: 'p', filePath: '/new.zip' }), /Wait for generation/);
});
