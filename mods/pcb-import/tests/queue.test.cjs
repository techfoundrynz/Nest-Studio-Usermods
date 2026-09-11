const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('additional boards use the native file input individually and remain available for retry', () => {
  const events = new Map(), buttons = [], sent = [], messages = [];
  let toolbar, badge = false, hasInput = false;
  const input = { accept: '.stl,.step', files: null, dispatchEvent(event) { sent.push({ event, file: this.files[0] }); } };
  class Transfer {
    files = [];
    items = { add: file => this.files.push(file) };
  }
  const ui = {
    toolbar: { addButton(options) { toolbar = options; return { setBadge(value) { badge = value; } }; } },
    modal() { return { body: { append() {} }, close() {} }; },
    button(label, onClick) { const button = { label, onClick }; buttons.push(button); return button; },
    settingsForm() { return {}; }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/ui.js'), 'utf8'), {
    window: { usermodRuntime: { register() {}, el() { return {}; }, toast(message) { messages.push(message); } },
      usermodUI: ui, usermod: { on: (name, fn) => events.set(name, fn) }, addEventListener() {} },
    document: { querySelectorAll() { return hasInput ? [input] : []; } },
    Uint8Array, DataTransfer: Transfer, File, Event
  });
  events.get('pcb:boards')([2, 3, 4].map(i => ({ name: `board-${i}.stl`, bytes: new Uint8Array([i]) })));
  assert.equal(badge, true);
  toolbar.onClick();
  const imports = buttons.filter(b => b.label.startsWith('Import '));
  assert.equal(imports.length, 3);
  imports[0].onClick();
  assert.equal(sent.length, 0);
  assert.match(messages.at(-1), /Prepare/);
  hasInput = true;
  imports[0].onClick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].file.name, 'board-2.stl');
  assert.equal(sent[0].event.type, 'change');
  assert.equal(sent[0].event.bubbles, true);
  assert.equal(badge, true);
  imports[1].onClick(); imports[2].onClick();
  assert.equal(badge, false);
  buttons.length = 0;
  toolbar.onClick();
  assert.equal(buttons.filter(b => b.label.startsWith('Retry ')).length, 3);
  buttons.find(b => b.label === 'Discard pending boards').onClick();
  buttons.length = 0;
  toolbar.onClick();
  assert.equal(buttons.length, 0);
});
