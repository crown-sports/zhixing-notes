'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const workflow = require('./workflow');
class ItemView { constructor(leaf) { this.leaf = leaf; } }
const context = { module: { exports: {} }, Date, console, setTimeout, clearTimeout,
  window: { setInterval: () => 1 },
  require(name) {
    if (name === './workflow') return workflow;
    if (name === './journey') return require('./journey');
    if (name === 'obsidian') return { ItemView, Modal: class {}, Notice: class {}, TFolder: class {} };
    throw new Error('Unexpected import: ' + name);
  }
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'desk.js'), 'utf8') + '\nmodule.exports = { ...module.exports, DeskView, openFile };', context);
const { installDesk, DeskView, openFile } = context.module.exports;
function pluginFixture() {
  const leaves = []; let created = 0;
  const plugin = { settings: { folder: 'cards' },
    app: { vault: { on() {}, getAbstractFileByPath() {} }, metadataCache: { on() {} }, workspace: {
      getLeavesOfType: () => leaves,
      getLeaf() { created++; const leaf = { view: {}, async setViewState() { leaves.push(leaf); } }; return leaf; },
      async revealLeaf(leaf) { plugin.revealed = leaf; }
    } }, registerView() {}, addRibbonIcon() {}, addCommand() {}, registerEvent() {}, registerInterval() {}, register() {}
  };
  installDesk(plugin, {});
  return { plugin, leaves, created: () => created };
}
test('background refresh ignores restored deferred views while refreshing live desks', () => {
  const { plugin, leaves } = pluginFixture();
  let refreshed = 0;
  const live = new DeskView({}, plugin); live.refresh = () => refreshed++;
  leaves.push({ view: { getViewType: () => 'zhixing-notes-desk' } }, { view: live });
  assert.doesNotThrow(() => plugin.refreshDesk());
  assert.equal(refreshed, 1);
});
test('repeated workbench opens reuse the same workspace leaf', async () => {
  const fixture = pluginFixture();
  await fixture.plugin.openDesk(); await fixture.plugin.openDesk();
  assert.equal(fixture.created(), 1);
  assert.equal(fixture.plugin.revealed, fixture.leaves[0]);
});
test('opening an existing weekly note reuses its markdown tab', async () => {
  const file = { path: 'reviews/2026-10-19.md' };
  const leaf = { view: { file } }; let created = 0, revealed;
  const plugin = { app: { vault: { getAbstractFileByPath: () => file }, workspace: {
    getLeavesOfType: () => [leaf], getLeaf() { created++; }, async revealLeaf(value) { revealed = value; }
  } } };
  await openFile(plugin, file);
  assert.equal(created, 0); assert.equal(revealed, leaf);
});
test('stale file handles are rejected before opening another tab', async () => {
  const { plugin } = pluginFixture();
  await assert.rejects(openFile(plugin, { path: 'deleted.md' }), /已移动或删除/);
});
test('a restored deferred weekly tab is revealed instead of duplicated', async () => {
  const file = { path: 'reviews/2026-10-19.md' };
  const leaf = { view: {}, getViewState: () => ({ type: 'markdown', state: { file: file.path } }) };
  let created = 0, revealed;
  const plugin = { app: { vault: { getAbstractFileByPath: () => file }, workspace: {
    getLeavesOfType: () => [leaf], getLeaf() { created++; }, async revealLeaf(value) { revealed = value; }
  } } };
  await openFile(plugin, file);
  assert.equal(created, 0); assert.equal(revealed, leaf);
});

function captureFixture(createCapture) {
  const elements = [], notices = [];
  class Element {
    constructor(tag, options = {}) { this.tag = tag; this.options = options; this.value = ''; this.disabled = false; this.handlers = {}; this.children = []; elements.push(this); }
    addClass() {}
    createEl(tag, options) { const child = new Element(tag, options); this.children.push(child); return child; }
    createDiv(options) { return this.createEl('div', options); }
    addEventListener(event, callback) { this.handlers[event] = callback; }
    click() { if (!this.disabled) return this.handlers.click?.(); }
    input(value) { if (!this.disabled) { this.value = value; this.handlers.input?.(); } }
    empty() { this.children = []; this.text = ''; }
    setText(text) { this.text = text; }
    focus() {}
  }
  class Modal {
    constructor(app) {
      this.app = app; this.contentEl = new Element('root'); this.closed = false;
      const keys = [];
      this.scope = {
        register(modifiers, key, callback) { const entry = { modifiers, key, callback }; keys.push(entry); return entry; },
        unregister(entry) { const index = keys.indexOf(entry); if (index >= 0) keys.splice(index, 1); },
        press(modifiers, key) { return keys.find(entry => entry.key === key && entry.modifiers.join() === modifiers.join())?.callback(); },
        count: () => keys.length
      };
      this.scope.register([], 'Escape', () => this.close());
      this.closeButton = new Element('button');
      this.closeButton.addEventListener('click', () => this.close());
    }
    setTitle() {}
    close() { this.closed = true; this.onClose(); }
  }
  const captureContext = { module: { exports: {} }, Date, console,
    require(name) {
      if (name === './workflow') return { ...workflow, createCapture };
      if (name === './journey') return require('./journey');
      if (name === 'obsidian') return { ItemView, Modal, Notice: class { constructor(text) { notices.push(text); } } };
      throw new Error('Unexpected import: ' + name);
    }
  };
  vm.createContext(captureContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'desk.js'), 'utf8') + '\nmodule.exports.CaptureModal = CaptureModal;', captureContext);
  let refreshed = 0;
  const plugin = { app: { vault: {} }, workflowSettings: { inbox: 'inbox' }, refreshDesk() { refreshed++; } };
  const modal = new captureContext.module.exports.CaptureModal(plugin);
  modal.onOpen();
  return {
    modal, notices, refreshed: () => refreshed,
    title: elements.find(element => element.tag === 'input'),
    body: elements.find(element => element.tag === 'textarea'),
    error: elements.find(element => element.options.cls === 'zn-error'),
    save: elements.find(element => element.options.text === '保存到收集箱'),
    cancel: elements.find(element => element.options.text === '取消')
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
test('capture locks inputs and all closing routes until a pending save succeeds', async () => {
  const pending = deferred(); let calls = 0, captured;
  const fixture = captureFixture((vault, settings, data) => { calls++; captured = data; return pending.promise; });
  const { modal, title, body, save, cancel } = fixture;
  title.input('一条想法'); body.input('保存前的完整原文。');
  const saving = save.click();
  for (const element of [title, body, save, cancel]) assert.equal(element.disabled, true);
  title.input('保存中修改标题'); body.input('保存中追加内容');
  await cancel.click(); modal.scope.press([], 'Escape'); await modal.closeButton.click(); modal.close();
  await save.click(); modal.scope.press(['Mod'], 'Enter');
  assert.equal(modal.closed, false);
  assert.equal(calls, 1);
  assert.equal(title.value, '一条想法'); assert.equal(body.value, '保存前的完整原文。');
  assert.equal(captured.title, title.value); assert.equal(captured.body, body.value);
  pending.resolve({ basename: '一条想法' });
  await saving;
  assert.equal(modal.saving, false); assert.equal(modal.closed, true);
  assert.equal(modal.contentEl.children.length, 0);
  assert.equal(modal.scope.count(), 1, 'onOpen shortcuts must be removed on close');
  assert.equal(fixture.refreshed(), 1); assert.deepEqual(fixture.notices, ['已保存：一条想法']);
});
test('failed capture restores editing, preserves content, and supports a successful retry', async () => {
  const pending = deferred(); let calls = 0, retried;
  const fixture = captureFixture((vault, settings, data) => {
    if (++calls === 1) return pending.promise;
    retried = data; return Promise.resolve({ basename: '重试记录' });
  });
  const { modal, title, body, error, save, cancel } = fixture;
  title.input('重试记录'); body.input('第一段。\n\n第二段。');
  const saving = save.click(); pending.reject(new Error('磁盘暂时不可用'));
  await saving;
  assert.equal(modal.closed, false); assert.equal(modal.saving, false);
  for (const element of [title, body, save, cancel]) assert.equal(element.disabled, false);
  assert.equal(title.value, '重试记录'); assert.equal(body.value, '第一段。\n\n第二段。');
  assert.equal(error.text, '磁盘暂时不可用'); assert.equal(fixture.refreshed(), 0);
  body.input(body.value + '\n补充内容。');
  assert.equal(error.text, '');
  await save.click();
  assert.equal(calls, 2); assert.equal(retried.body, '第一段。\n\n第二段。\n补充内容。');
  assert.equal(modal.closed, true); assert.equal(fixture.refreshed(), 1);
});
test('capture can still be closed normally before saving or after a failed save', async () => {
  for (const close of [fixture => fixture.cancel.click(), fixture => fixture.modal.scope.press([], 'Escape'), fixture => fixture.modal.closeButton.click()]) {
    let calls = 0;
    const fixture = captureFixture(() => { calls++; });
    await close(fixture);
    assert.equal(fixture.modal.closed, true); assert.equal(calls, 0);
  }
  const fixture = captureFixture(() => Promise.reject(new Error('保存失败')));
  fixture.body.input('失败后仍可取消。');
  await fixture.save.click();
  fixture.modal.scope.press([], 'Escape');
  assert.equal(fixture.modal.closed, true);
});
