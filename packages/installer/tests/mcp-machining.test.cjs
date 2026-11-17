const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
require('tsx/cjs');
const { MCP_MACHINING_BLOCK } = require('../src/mcp-machining.ts');
const { MODEL_IMPORT_BLOCK } = require('../src/model-import.ts');

test('native model importer preserves the existing default and supports new 4-axis projects', async () => {
  const calls = [];
  const ctx = {
    reactExports: { useRef: value => ({ current: value }), useCallback: fn => fn, useEffect: fn => fn() },
    activeProjectGenerating: false, isOnProject: true, activeTab: { projectType: '3D', projectAxis: '3Axis' }, activeProjectId: 'existing',
    addProject: axis => { calls.push(['create', axis]); return 'new-' + axis; },
    importModelFile: async (file, project) => { calls.push(['import', file.name, project]); return true; }
  };
  vm.runInNewContext(MODEL_IMPORT_BLOCK, ctx);
  const run = ctx.__usermodModelImport.importFiles;
  assert.equal((await run([{ name: 'a.step' }])).projectId, 'existing');
  assert.equal((await run([{ name: 'a.step' }], undefined, { axis: '4Axis' })).projectId, 'new-4Axis');
  assert.equal((await run([{ name: 'a.step' }], undefined, { newProject: true })).projectId, 'new-3Axis');
  assert.match((await run([{ name: 'a' }, { name: 'b' }], undefined, { axis: '4Axis' })).error, /one model/);
  assert.match((await run([{ name: 'a' }], undefined, { axis: '5Axis' })).error, /Unsupported/);
  assert.equal(calls.filter(c => c[0] === 'import').length, 3);
});

function machining(overrides = {}) {
  const calls = [];
  const project = { projectId: 'p', projectAxis: '3Axis', projectCanvasData: { material: { width: 100, length: 50, thickness: 50, materialShape: 'square', materialType: '6061_Aluminum' } }, saveCoordsSystemList: [{ id: 's', modelItems: [{ value: 'm' }] }] };
  const tool = { id: 't', slotNum: 1, type: 'endmill', diameter: 6 };
  const draft = { modelId: 'm', oneKeySetting: { allTools: [{ ...tool, stepOver: 2 }], cutSetting: {} }, fourAxisMachiningMode: { base: { enabled: false }, smartCutoff: { enabled: false } } };
  const ctx = {
    project, snapshot: { document: project }, processTreeLoading: false, processTreeGenerating: false, fourAxisGenerating: false, exportingGcode: false,
    closeProcessTree: () => { calls.push(['closePlan']); ctx.processTree = null; },
    processTree: { projectAxis: '3Axis', setups: [{ id: 's' }], models: [{ id: 'm' }], initialDrafts: { s: draft } }, millingDrafts: {},
    getProcessTreeDraft: (drafts, id) => drafts[id], getCutLibrary: () => [tool], cutLibrary: [tool],
    saveMillingDraft: (key, value) => { calls.push(['draft', key, value]); ctx.millingDrafts[key] = value; },
    parameterEdit: { request: fn => fn() }, projectMetadataCommands: { submitMaterial: m => calls.push(['material', m]) },
    isPrepareOperationEditing: () => false, handleFixtureChange: fixture => { calls.push(['fixture', fixture]); return {}; },
    advancedOperationsEnabled: true, operationSettingsRequest: { operationType: 'pocket' },
    operationEditorSession: { editor: { phase: 'ready', configuration: { operationType: 'pocket', toolId: 't', cutSetting: { freeRate: 100, holeCount: 0 } } }, setConfiguration: value => { calls.push(['configuration', value]); ctx.operationEditorSession.editor.configuration = value; } },
    operationGeometryContext: { inputKey: 'current', isCurrent: () => true, load: async (_signal, onProgress) => { assert.equal(typeof onProgress, 'function'); onProgress(50); return { inputKey: 'current', holeList: [] }; } },
    cloneOperationParameterConfiguration: value => structuredClone(value), refreshOperationParameterRecommendations: value => value,
    updateOperationGeometry: (value, geometry) => ({ ...value, geometry }),
    openOperationSettings: request => calls.push(['open', request]), openEditOperationSettings: id => calls.push(['edit', id]),
    findCustomOperation: () => ({ operation: {} }), getCustomOperationConfiguration: () => ({ operationType: 'pocket' }),
    customOperationActions: { delete: () => true }, clearPrepareOperationEditor: () => calls.push(['clearEditor']), setOperationSettingsRequest: value => calls.push(['request', value]),
    customOperationCommand: { start: value => { calls.push(['commit', value]); return true; } }, confirmOperationConfiguration: () => {},
    AbortController, setTimeout, clearTimeout, ...overrides
  };
  vm.runInNewContext('globalThis.run = async function(action, args) {' + MCP_MACHINING_BLOCK + '\nreturn null;}', ctx);
  return { run: ctx.run, ctx, calls, draft };
}

test('smart-plan configuration selects mounted tools without changing geometry or library state', async () => {
  const { run, ctx, calls } = machining();
  await run('configure_toolpath_plan', { toolIds: ['t'], toolOverrides: [{ toolId: 't', freeRate: 800 }], carving: true });
  const saved = calls[0][2]; assert.equal(saved.oneKeySetting.allTools[0].freeRate, 800); assert.equal(saved.oneKeySetting.cutSetting.isCarve, true);
  assert.equal(ctx.cutLibrary[0].freeRate, undefined);
  await assert.rejects(run('configure_toolpath_plan', { toolIds: ['absent'] }), /mounted/);
  await assert.rejects(run('configure_toolpath_plan', { toolOverrides: [{ toolId: 't', stepOver: 7 }] }), /Stepover/);
  await assert.rejects(run('configure_toolpath_plan', { fourAxisMachiningMode: {} }), /4-axis/);
  ctx.processTree = null;
  await run('configure_stock', { fixture: 'low-profile-vise' });
  assert.equal(calls.at(-1)[1].type, 'low-profile-vise');
  await assert.rejects(run('configure_stock', { fixture: 'fourth-axis' }), /incompatible/);
  await assert.rejects(run('configure_stock', { shape: 'round' }), /square stock/);
});

test('rotary generation uses the native 4-axis controller and retains mode, clearance and travel gates', async () => {
  const { run, ctx, calls } = machining(); ctx.project.projectAxis = '4Axis'; ctx.processTree.projectAxis = '4Axis';
  const tree = ctx.processTree;
  ctx.supportSceneBridge = { getModelMeshById: () => ({ updateWorldMatrix: () => {} }) };
  ctx.Box3 = class { setFromObject() { this.min = { x: 10 }; return this; } getSize() { return { z: 20, y: 10 }; } };
  ctx.Vector3 = class {}; ctx.getFourAxisMachiningModeLimits = () => ({});
  ctx.isFourAxisMachiningModeValid = () => true; ctx.hasFourAxisLeftClearance = () => true;
  ctx.evaluateLatestToolpathAvailability = () => ({ canGenerate: true });
  let generated = 0; ctx.generateFourAxisToolpaths = () => { generated++; return true; };
  const result = await run('generate_planned_toolpaths', {});
  assert.equal(result.axis, '4Axis'); assert.equal(result.status, 'workflow_requested'); assert.equal(generated, 1);
  assert.ok(calls.some(c => c[0] === 'closePlan')); assert.equal(ctx.processTree, null);
  ctx.processTree = tree;
  ctx.hasFourAxisLeftClearance = () => false;
  await assert.rejects(run('generate_planned_toolpaths', {}), /clearance/);
  ctx.hasFourAxisLeftClearance = () => true; ctx.evaluateLatestToolpathAvailability = () => ({ canGenerate: false });
  await assert.rejects(run('generate_planned_toolpaths', {}), /stock\/travel/);
  assert.equal(generated, 1);
  ctx.processTreeGenerating = true;
  await assert.rejects(run('cancel_toolpath_plan', {}), /generation is active/);
  ctx.processTreeGenerating = false;
  await run('cancel_toolpath_plan', {}); assert.equal(ctx.processTree, null);
});

test('all five native custom operation types retain target, ready-state, geometry and commit validation', async () => {
  const { run, ctx, calls } = machining(); ctx.processTree = null;
  assert.equal((await run('get_operation_geometry', {})).inputKey, 'current');
  for (const operationType of ['contour', 'pocket', 'drilling', 'chamfer', 'thread']) {
    await run('begin_operation', { setupId: 's', modelId: 'm', operationType });
    assert.equal(calls.at(-1)[1].operationType, operationType);
  }
  await assert.rejects(run('begin_operation', { setupId: 's', modelId: 'missing', operationType: 'pocket' }), /identity/);
  await run('configure_operation', { cutSetting: { freeRate: 500 } });
  assert.equal(ctx.operationEditorSession.editor.configuration.cutSetting.freeRate, 500);
  await assert.rejects(run('configure_operation', { cutSetting: { injected: 1 } }), /Unknown/);
  await assert.rejects(run('configure_operation', { geometry: { inputKey: 'old', holeList: [], dodgeHoleList: [] } }), /current native geometry/);
  await run('commit_operation', {});
  assert.equal(calls.find(c => c[0] === 'commit')[1].invalidSelectionConfirmed, false);
  ctx.advancedOperationsEnabled = false;
  await assert.rejects(run('begin_operation', {}), /unavailable/);
});
