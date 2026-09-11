const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

for (const [name, response, expected] of [
  ['ordinary project ZIP', { recognized: false }, 'package.zip'],
  ['Gerber ZIP', { recognized: true, bytes: new Uint8Array([1, 2, 3]) }, 'package.zip.stl'],
  ['cancelled Gerber ZIP', { recognized: true, bytes: null }, null]
]) test(`drop routing handles ${name} without intercepting its replay`, async () => {
  const listeners = new Map(), calls = [], dropped = [];
  class Node { isConnected = true; }
  class Element extends Node {
    closest() { return null; }
    dispatchEvent(event) {
      if (event.type === 'drop') { event.target = this; listeners.get('drop')(event); dropped.push(event.dataTransfer.files[0].name); }
      return true;
    }
  }
  class Transfer { files = []; items = { add: file => this.files.push(file) }; }
  class Drag { constructor(type, init) { this.type = type; Object.assign(this, init); } }
  vm.runInNewContext(fs.readFileSync(require.resolve('../dist/ui.js'), 'utf8'), {
    window: {
      usermodRuntime: { register() {}, toast() {} },
      usermodUI: { toolbar: { addButton() { return {}; } } },
      usermod: { on() {}, async invoke(channel, bytes, fileName) { calls.push({ channel, bytes, fileName }); return { ok: true, data: response }; } },
      addEventListener: (name, fn) => listeners.set(name, fn)
    }, Node, Element, Uint8Array, File, Event, DataTransfer: Transfer, DragEvent: Drag
  });
  const transfer = new Transfer(); transfer.items.add(new File(['zip'], 'package.zip'));
  listeners.get('drop')({ target: new Element(), dataTransfer: transfer, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0].channel, 'pcb:zip');
  assert.ok(calls[0].bytes instanceof Uint8Array);
  assert.deepEqual(dropped, expected ? [expected] : []);
});
