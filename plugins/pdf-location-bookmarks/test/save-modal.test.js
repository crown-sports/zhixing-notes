'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(native) {
  const elements = [], notices = [];
  let lastModal, syncs = 0;
  class Element {
    constructor(tag, options = {}) { this.tag = tag; this.textContent = options.text || ''; this.disabled = false; elements.push(this); }
    addClass() {}
    createEl(tag, options) { return new Element(tag, options); }
    createDiv(options) { return new Element('div', options); }
    addEventListener() {}
    focus() {}
    select() {}
    empty() {}
  }
  class Modal {
    constructor(app) { this.app = app; this.contentEl = new Element('content'); this.closed = false; }
    setTitle() {}
    open() { lastModal = this; this.onOpen(); }
    close() { this.closed = true; this.onClose(); }
  }
  class TFile { constructor() { this.extension = 'pdf'; } }
  class Plugin { constructor(app) { this.app = app; } }
  const app = { internalPlugins: { plugins: { bookmarks: { instance: native } } },
    vault: { getAbstractFileByPath: () => new TFile() } };
  const context = { module: { exports: {} }, console: { error() {}, debug() {} },
    require(name) {
      if (name === './core') return require('../core');
      if (name === 'obsidian') return { Plugin, Modal, FuzzySuggestModal: class {}, TFile,
        Notice: class { constructor(message) { notices.push(message); } }, setIcon() {} };
      throw new Error('Unexpected import: ' + name);
    } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../main.src.js'), 'utf8'), context);
  const plugin = new context.module.exports(app);
  plugin.sync = () => { syncs += 1; };
  const location = { path: 'examples/reading.pdf', book: 'Reading', page: 2, subpath: '#page=2', kind: 'page' };
  plugin.bookmarkCurrent({ file: { path: location.path } }, location);
  return { notices, modal: lastModal, syncs: () => syncs,
    save: elements.find(item => item.tag === 'button' && item.textContent === '保存书签') };
}

function nativeBookmarks(saveData) {
  return { items: [], saveData,
    addItem(item, parent) { (parent ? parent.items : this.items).push(item); this.saveData(); },
    editItem() { this.saveData(); } };
}

test('the modal shows success only after persistence resolves and ignores a second save click', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const native = nativeBookmarks(() => waiting);
  const ui = fixture(native);
  const operation = ui.save.onclick();
  await ui.save.onclick();
  assert.equal(ui.save.disabled, true);
  assert.equal(ui.modal.closed, false);
  assert.deepEqual(ui.notices, []);
  assert.equal(native.items[0].items[0].items.length, 1);
  finish();
  await operation;
  assert.equal(ui.modal.closed, true);
  assert.equal(ui.syncs(), 1);
  assert.match(ui.notices[0], /^已收藏/);
});

test('an asynchronous save failure leaves the modal open and never reports success', async () => {
  let writes = 0;
  const native = nativeBookmarks(() => ++writes <= 3 ? Promise.reject(new Error('Full disk')) : Promise.resolve());
  const ui = fixture(native);
  await ui.save.onclick();
  assert.equal(ui.modal.closed, false);
  assert.equal(ui.save.disabled, false);
  assert.equal(ui.syncs(), 0);
  assert.equal(ui.notices.length, 1);
  assert.match(ui.notices[0], /未保存成功/);
  assert.deepEqual(native.items, []);
});
