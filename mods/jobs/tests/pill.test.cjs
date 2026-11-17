const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const browser = [process.env.USERMOD_TEST_BROWSER,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome'].find(file => file && fs.existsSync(file));

// This runs the built mod with a real DOM/CSS cascade. No Nest Studio window or machine is involved.
function browserHarness(initialConfig = {}) {
  const handlers = new Map();
  const timers = [];
  let config = { hud: true, hudWhenDisconnected: false, hudPosition: 'bottom-left', notifyPause: false, ...initialConfig };
  let response = { ok: false, message: 'machine-state is disabled' };
  let rejectState = false;
  let initial = true;
  let resolveSettings;
  const initialSettings = new Promise(resolve => { resolveSettings = resolve; });
  let toolbar;
  let form;
  let opened = 0;
  let saved = 0;
  let dragSettings;
  const checks = [];
  const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
  const info = () => ({ ok: true, data: { config: { settings: { jobs: { ...config } } } } });
  const disconnected = { phase: 'disconnected', connected: false, status: null, alarm: null,
    job: { fileName: null }, progress: null, etaSeconds: null, elapsedSeconds: 0 };
  const connected = { ...disconnected, phase: 'idle', connected: true, status: 'Idle' };
  const walk = node => {
    if (!node || typeof node !== 'object') return;
    if (node.props?.modName === 'jobs') form = node.props;
    (node.children ?? []).flat().forEach(walk);
  };
  window.React = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props, children }), useEffect() {} };
  const components = Object.fromEntries(['Section', 'KV', 'Row', 'Button', 'Sub', 'SettingsForm', 'Loading', 'Err'].map(name => [name, name]));
  window.usermodUI = {
    react: { ...components, useEvent() {}, useInvoke: channel => ({ data: channel === 'jobs:list' ? [] : {}, refresh: async () => {} }),
      modal: (_title, element) => { opened++; walk(element.type()); } },
    toolbar: { addButton: button => { toolbar = button; } }, icons: { svg() {} }
  };
  window.usermodRuntime = {
    register() {}, toast() {}, formatDuration: seconds => `${seconds}s`,
    addStyle(css) { const style = document.createElement('style'); style.textContent = css; document.head.append(style); },
    el(tag, props = {}, children = []) {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(props)) {
        if (key === 'class') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        else node.setAttribute(key, value);
      }
      node.append(...children); return node;
    }
  };
  window.usermod = {
    info: () => initial ? initialSettings : Promise.resolve(info()),
    async setSettings(name, value) {
      if (name !== 'jobs') throw new Error('unexpected settings write');
      config = { ...value }; saved++;
      return { ok: true, data: {} };
    },
    on: (channel, callback) => { handlers.set(channel, callback); },
    async invoke(channel) {
      if (channel !== 'machine:state') return { ok: true, data: {} };
      if (rejectState) throw new Error('IPC unavailable');
      return response;
    }
  };
  window.setInterval = callback => { timers.push(callback); return timers.length; };
  const pointer = (hud, type, x, y, button = 0) => hud.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button, clientX: x, clientY: y }));
  const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
  window.runPillChecks = async () => {
    const hud = document.getElementById('usermod-hud');
    const hidden = () => hud.hidden && getComputedStyle(hud).display === 'none' && hud.getBoundingClientRect().width === 0;
    const shown = () => !hud.hidden && getComputedStyle(hud).display === 'flex';
    check('initial hidden attribute survives the CSS cascade', hidden());
    handlers.get('machine:state')(connected);
    check('early machine events cannot flash a disabled or unconfigured pill', hidden());
    initial = false; resolveSettings(info()); await settle();
    check('missing machine-state provider leaves no empty pill', hidden());
    handlers.get('machine:state')(disconnected);
    check('no machine and no job stay hidden', hidden());
    handlers.get('machine:state')(connected);
    check('connected idle machine can show its status', shown());
    check('configured bottom-left position is retained', hud.dataset.pos === 'bottom-left' && getComputedStyle(hud).left === '16px');
    let bounds = hud.getBoundingClientRect();
    pointer(hud, 'pointerdown', bounds.left + 5, bounds.top + 5);
    pointer(hud, 'pointermove', bounds.left + 145, bounds.top - 115);
    const moving = hud.getBoundingClientRect();
    handlers.get('machine:state')(connected);
    check('status updates do not snap an ongoing drag back to its preset', Math.abs(hud.getBoundingClientRect().left - moving.left) < 1);
    pointer(hud, 'pointerup', bounds.left + 145, bounds.top - 115); hud.click(); await settle();
    check('drag moves the pill in both directions', hud.getBoundingClientRect().left > bounds.left + 100 && hud.getBoundingClientRect().top < bounds.top - 100);
    check('drag stores a custom position', config.hudPosition === 'custom' && config.hudX === Math.round(hud.getBoundingClientRect().left) && config.hudY === Math.round(hud.getBoundingClientRect().top));
    check('drag preserves unrelated notification settings', config.notifyPause === false);
    check('finishing a drag does not open Jobs', opened === 0);
    const writes = saved;
    bounds = hud.getBoundingClientRect();
    pointer(hud, 'pointerdown', bounds.left + 5, bounds.top + 5);
    pointer(hud, 'pointermove', bounds.left + 7, bounds.top + 7);
    pointer(hud, 'pointerup', bounds.left + 7, bounds.top + 7); hud.click(); await settle();
    check('normal click with slight pointer movement opens Jobs', opened === 1 && saved === writes);
    pointer(hud, 'pointerdown', bounds.left + 5, bounds.top + 5);
    pointer(hud, 'pointermove', bounds.left + 65, bounds.top + 65);
    pointer(hud, 'pointercancel', bounds.left + 65, bounds.top + 65); hud.click(); await settle();
    check('cancelled drag restores the position without saving or opening Jobs', Math.abs(hud.getBoundingClientRect().left - bounds.left) < 1 && saved === writes && opened === 1);
    pointer(hud, 'pointerdown', bounds.left + 5, bounds.top + 5, 2);
    pointer(hud, 'pointermove', 0, 0, 2); pointer(hud, 'pointerup', 0, 0, 2);
    check('right button does not start a drag', Math.abs(hud.getBoundingClientRect().left - bounds.left) < 1);
    pointer(hud, 'pointerdown', bounds.left + 5, bounds.top + 5);
    pointer(hud, 'pointermove', -5000, -5000); pointer(hud, 'pointerup', -5000, -5000); hud.click(); await settle();
    check('drag cannot leave the top or left edge', hud.getBoundingClientRect().left === 8 && hud.getBoundingClientRect().top === 8);
    bounds = hud.getBoundingClientRect();
    pointer(hud, 'pointerdown', bounds.left + 5, bounds.top + 5);
    pointer(hud, 'pointermove', 10000, 10000); pointer(hud, 'pointerup', 10000, 10000); hud.click(); await settle();
    bounds = hud.getBoundingClientRect();
    check('drag cannot leave the bottom or right edge', bounds.right <= innerWidth - 7 && bounds.bottom <= innerHeight - 7);
    dragSettings = { ...config };
    await form.onSaved();
    check('saved coordinates are read back by the settings loader', hud.dataset.pos === 'custom' && Math.abs(hud.getBoundingClientRect().left - config.hudX) < 1);
    handlers.get('machine:state')({ ...connected, phase: 'running', job: { fileName: 'part.nc' }, progress: 0.5, etaSeconds: 10 });
    check('running job shows program and progress', shown() && hud.textContent.includes('part.nc') && hud.textContent.includes('50%'));
    handlers.get('machine:state')(disconnected);
    check('disconnect hides a previously visible job pill', hidden());
    toolbar.onClick(); check('jobs settings form is available', !!form?.onSaved);
    config = { ...config, hudWhenDisconnected: true, hudPosition: 'top-right' };
    await form.onSaved();
    check('saving disconnected visibility and position applies immediately', shown() && hud.dataset.pos === 'top-right' && hud.textContent.includes('No machine'));
    config = { ...config, hud: false }; await form.onSaved();
    check('saving pill disabled hides it immediately', hidden());
    config = { ...config, hud: true }; await form.onSaved();
    check('explicit disconnected visibility remains opt-in', shown());
    config = { hud: true }; await form.onSaved();
    check('absent disconnected setting defaults to hidden', hidden());
    handlers.get('machine:state')(connected); check('connection restores status', shown());
    await timers[0](); await settle();
    check('failed state response hides stale connected data', hidden());
    response = { ok: true, data: connected }; await timers[0](); await settle();
    check('valid state recovers after a failed poll', shown());
    rejectState = true; await timers[0](); await settle();
    check('rejected IPC also hides stale data', hidden());
    document.documentElement.dataset.pillResult = btoa(JSON.stringify({ checks, dragSettings }));
  };
  window.preparePillResizeCheck = async () => {
    config = { ...dragSettings }; await form.onSaved(); handlers.get('machine:state')(connected);
  };
  window.checkPillAfterResize = () => {
    const bounds = document.getElementById('usermod-hud').getBoundingClientRect();
    if (bounds.right > innerWidth - 7 || bounds.bottom > innerHeight - 7 || bounds.left < 8 || bounds.top < 8) throw new Error('pill left the resized viewport');
    return true;
  };
  window.runPillRestoreChecks = async () => {
    initial = false; resolveSettings(info()); await settle();
    handlers.get('machine:state')(connected);
    const hud = document.getElementById('usermod-hud'), bounds = hud.getBoundingClientRect();
    check('custom position restores in a new UI document', hud.dataset.pos === 'custom' && Math.abs(bounds.left - config.hudX) < 1 && Math.abs(bounds.top - config.hudY) < 1);
    check('restoring a position does not rewrite settings', saved === 0);
    document.documentElement.dataset.pillResult = btoa(JSON.stringify({ checks }));
  };
}

test('jobs pill respects hidden CSS, state availability, disconnects and live settings in Chromium', { skip: !browser || typeof WebSocket !== 'function', timeout: 30000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nest-jobs-pill-'));
  let socket;
  let send;
  t.after(async () => {
    if (send) await Promise.race([send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 1000))]);
    socket?.close();
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  });
  const script = fs.readFileSync(process.env.USERMOD_TEST_JOBS_UI || path.join(__dirname, '../dist/ui.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const htmlFor = (config = {}, restore = false) => `<!doctype html><html><head></head><body><script>(${browserHarness})(${JSON.stringify(config)});</script><script>${script}</script><script>
    ${restore ? 'runPillRestoreChecks' : 'runPillChecks'}().catch(error => { document.documentElement.dataset.pillResult = btoa(JSON.stringify({ failure: error.stack })); });
    </script></body></html>`;
  // Chromium may de-elevate/relaunch on Windows, losing stdout. CDP survives that relaunch.
  let launchError;
  const child = spawn(browser, ['--headless', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-extensions', '--disable-sync',
    '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore' });
  child.on('error', error => { launchError = error; });
  let endpoint;
  for (let i = 0; i < 100; i++) {
    assert.ifError(launchError);
    try {
      const [port, suffix] = fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      if (port && suffix) { endpoint = `ws://127.0.0.1:${port}${suffix}`; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(endpoint, 'isolated headless browser started');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
  });
  socket.addEventListener('close', () => { for (const request of pending.values()) request.reject(new Error('browser closed')); pending.clear(); });
  send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false }, sessionId);
  const writing = await send('Runtime.evaluate', { expression: `document.open();document.write(${JSON.stringify(htmlFor())});document.close();`, returnByValue: true }, sessionId);
  assert.equal(writing.exceptionDetails, undefined, JSON.stringify(writing.exceptionDetails));
  const result = await send('Runtime.evaluate', { expression: `(async () => {
    for (let i = 0; i < 50; i++) { if (document.documentElement.dataset.pillResult) return document.documentElement.dataset.pillResult; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('pill checks did not complete');
  })()`, awaitPromise: true, returnByValue: true }, sessionId);
  assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
  const report = JSON.parse(Buffer.from(result.result.value, 'base64').toString());
  assert.equal(report.failure, undefined, report.failure);
  assert.equal(report.checks.length, 28);
  const preparing = await send('Runtime.evaluate', { expression: 'preparePillResizeCheck()', awaitPromise: true }, sessionId);
  assert.equal(preparing.exceptionDetails, undefined);
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 200, deviceScaleFactor: 1, mobile: false }, sessionId);
  const resizing = await send('Runtime.evaluate', { expression: '(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); return checkPillAfterResize(); })()', awaitPromise: true, returnByValue: true }, sessionId);
  assert.equal(resizing.exceptionDetails, undefined, JSON.stringify(resizing.exceptionDetails));
  assert.equal(resizing.result.value, true);
  const restored = await send('Target.createTarget', { url: 'about:blank' });
  const restoreSession = (await send('Target.attachToTarget', { targetId: restored.targetId, flatten: true })).sessionId;
  await send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 700, deviceScaleFactor: 1, mobile: false }, restoreSession);
  await send('Runtime.evaluate', { expression: `document.open();document.write(${JSON.stringify(htmlFor(report.dragSettings, true))});document.close();` }, restoreSession);
  const restoreResult = await send('Runtime.evaluate', { expression: 'document.documentElement.dataset.pillResult', returnByValue: true }, restoreSession);
  const restoredReport = JSON.parse(Buffer.from(restoreResult.result.value, 'base64').toString());
  assert.equal(restoredReport.failure, undefined, restoredReport.failure);
  assert.equal(restoredReport.checks.length, 2);
});
