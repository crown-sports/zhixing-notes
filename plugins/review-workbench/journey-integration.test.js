'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const journey = require('./journey');
const workflow = require('./workflow');
const data = require('./data');

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(options = {}) {
  let now = new Date(2026, 9, 23, 10).getTime(), disk, refreshes = 0;
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const elements = [], notices = [], opened = [], copied = [];
  class Element {
    constructor(tag, props = {}) { this.tag = tag; this.props = props; this.value = ''; this.disabled = false; this.children = []; this.handlers = {}; elements.push(this); }
    addClass() {}
    createEl(tag, props) { const child = new Element(tag, props); this.children.push(child); return child; }
    createDiv(props) { return this.createEl('div', props); }
    createSpan(props) { return this.createEl('span', props); }
    addEventListener(key, callback) { this.handlers[key] = callback; }
    empty() { this.children = []; this.text = ''; }
    setText(text) { this.text = text; }
    focus() {}
    click() { if (!this.disabled) return this.handlers.click?.(); }
  }
  class Modal {
    constructor(app) { this.app = app; this.contentEl = new Element('root'); this.closed = false; this.scope = { register: () => ({}), unregister() {} }; }
    setTitle() {}
    close() { this.closed = true; this.onClose(); }
  }
  const obsidian = { Plugin: class {}, ItemView: class {}, Modal, PluginSettingTab: class {}, TFolder: class {}, Notice: class { constructor(text) { notices.push(text); } } };
  const mainContext = { module: { exports: {} }, Intl, Date: Clock, console,
    require(name) { if (name === 'obsidian') return obsidian; if (name === './data') return data; if (name === './desk') return {}; throw new Error(name); }
  };
  vm.createContext(mainContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.src.js'), 'utf8') + '\nmodule.exports = { queueSettings };', mainContext);
  const { queueSettings } = mainContext.module.exports;
  const deskContext = { module: { exports: {} }, Date: Clock, console, setTimeout, clearTimeout, window: { setInterval: () => 1 },
    navigator: { clipboard: { async writeText(text) { if (options.copy) await options.copy(text); copied.push(text); } } },
    require(name) {
      if (name === 'obsidian') return obsidian;
      if (name === './workflow') return { ...workflow, ...(options.workflow || {}) };
      if (name === './journey') return { ...journey, ...(options.journey || {}) };
      throw new Error(name);
    }
  };
  vm.createContext(deskContext);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'desk.js'), 'utf8') + '\nmodule.exports = { ...module.exports, CaptureModal, ReflectionModal, DeskView };', deskContext);
  const plugin = {
    settings: { folder: 'cards' },
    app: { vault: { on() {}, getAbstractFileByPath: filePath => options.file?.path === filePath ? options.file : null }, metadataCache: { on() {} }, workspace: {
      getLeavesOfType: () => [], getLeaf: () => ({ async openFile(file) { opened.push(file.path); } }), async revealLeaf() {}
    } },
    registerView() {}, addRibbonIcon() {}, addCommand() {}, registerEvent() {}, registerInterval() {}, register() {},
    async saveData(value) { if (options.saveData) await options.saveData(value); disk = JSON.parse(JSON.stringify(value)); },
    updateSettings(patch) { return queueSettings(this, patch); }
  };
  deskContext.module.exports.installDesk(plugin, {}, options.savedJourney);
  plugin.refreshDesk = () => refreshes++;
  return {
    plugin, notices, elements, opened, copied, disk: () => disk, refreshes: () => refreshes,
    setTime: date => { now = date.getTime(); },
    undoNotice(move) {
      plugin.lastDeskMove = move;
      deskContext.module.exports.DeskView.prototype.renderNotice.call({ noticeEl: new Element('div'), plugin, app: plugin.app });
      return elements.findLast(el => el.tag === 'button' && el.props.text === '撤销移动');
    },
    modal(kind) {
      const Constructor = deskContext.module.exports[kind]; const modal = new Constructor(plugin); modal.onOpen();
      return { modal, body: elements.findLast(el => el.tag === 'textarea'),
        save: elements.findLast(el => el.tag === 'button' && /保存/.test(el.props.text)),
        error: elements.findLast(el => el.props.cls === 'zn-error') };
    }
  };
}
const friday = new Date(2026, 9, 23, 10);
const capture = { path: '01_收集箱/想法.md' };

test('concurrent settings changes and two milestones merge at execution time', async () => {
  const f = fixture({ savedJourney: { mode: 'focus', weeks: {} } });
  await Promise.all([
    f.plugin.updateSettings({ folder: '新卡片' }),
    f.plugin.completeJourney('capture', capture),
    f.plugin.updateSettings({ workflow: { ...workflow.DEFAULT_WORKFLOW, inbox: '我的收件箱' } }),
    f.plugin.completeJourney('organize', { from: capture.path, to: '20_笔记/想法.md' })
  ]);
  assert.equal(f.disk().folder, '新卡片'); assert.equal(f.disk().workflow.inbox, '我的收件箱');
  assert.equal(f.disk().journey.mode, 'focus');
  assert.equal(journey.journeyStatus(f.disk().journey, friday).done, 2);
});

test('a failed progress save does not alter memory or block later directory writes', async () => {
  let fail = true;
  const f = fixture({ saveData: async () => { if (fail) { fail = false; throw new Error('磁盘失败'); } } });
  assert.equal(await f.plugin.completeJourney('capture', capture), false);
  assert.equal(journey.journeyStatus(f.plugin.journey, friday).done, 0);
  assert.match(f.notices[0], /笔记操作已完成.*进度未能保存/);
  await f.plugin.updateSettings({ folder: '新卡片' });
  assert.equal(f.disk().folder, '新卡片'); assert.equal(journey.journeyStatus(f.disk().journey, friday).done, 0);
});

test('capture awards only after the note is saved and failed input stays available', async () => {
  const pending = deferred();
  const f = fixture({ workflow: { createCapture: () => pending.promise } });
  const form = f.modal('CaptureModal'); form.body.value = '保存这一段真实想法。';
  const saving = form.save.click();
  assert.equal(journey.journeyStatus(f.plugin.journey, friday).done, 0);
  pending.reject(new Error('写入失败')); await saving;
  assert.equal(form.modal.closed, false); assert.equal(form.body.value, '保存这一段真实想法。');
  assert.equal(journey.journeyStatus(f.plugin.journey, friday).done, 0);
});

test('successful capture persists one milestone and opening weekly review does not award it', async () => {
  const file = { ...capture, basename: '想法' };
  const f = fixture({ file, workflow: { createCapture: async () => file, createWeeklyReview: async () => file } });
  await f.plugin.openWeekly(); assert.equal(journey.journeyStatus(f.plugin.journey, friday).done, 0);
  const form = f.modal('CaptureModal'); form.body.value = '成功保存这一段真实想法。'; await form.save.click();
  assert.equal(form.modal.closed, true); assert.equal(journey.journeyStatus(f.disk().journey, friday).done, 1);
  assert.equal(f.disk().journey.weeks['2026-10-19'].capture.path, capture.path);
});

test('queued milestone stays in the week where its successful action was recorded', async () => {
  const gate = deferred(); let saves = 0;
  const f = fixture({ saveData: async () => { if (++saves === 1) await gate.promise; } });
  f.setTime(new Date(2026, 9, 25, 23, 59, 59));
  const earlier = f.plugin.updateSettings({ folder: '新卡片' });
  const award = f.plugin.completeJourney('capture', capture);
  f.setTime(new Date(2026, 9, 26, 0, 0, 1)); gate.resolve();
  await Promise.all([earlier, award]);
  assert.equal(journey.journeyStatus(f.plugin.journey, friday).done, 1);
  assert.equal(journey.journeyStatus(f.plugin.journey, new Date(2026, 9, 26)).done, 0);
});

test('a duplicate reflection keeps new unsaved text visible instead of silently discarding it', async () => {
  const file = { path: '40_回顾/2026-10-19.md' };
  const f = fixture({ file, journey: { saveReflection: async () => ({ file, created: false }) } });
  const form = f.modal('ReflectionModal'); const draft = '上次保存后我又想到了一个新的例子，不要把这段直接丢掉。';
  form.body.value = draft; await form.save.click();
  assert.equal(form.modal.closed, false);
  assert.equal(form.body.value, draft);
  assert.ok(form.modal.contentEl.children.length > 0);
});

test('reflection does not announce a lit badge when only the Markdown save succeeded', async () => {
  const file = { path: '40_回顾/2026-10-19.md' };
  const f = fixture({ file, saveData: async () => { throw new Error('配置不可写'); }, journey: { saveReflection: async () => ({ file, created: true }) } });
  const form = f.modal('ReflectionModal'); form.body.value = '写好一段反思，但进度文件暂时无法保存。'; await form.save.click();
  assert.equal(journey.journeyStatus(f.plugin.journey, friday).done, 0);
  assert.ok(f.notices.some(text => /进度未能保存/.test(text)));
  assert.ok(!f.notices.some(text => /星章已点亮/.test(text)));
});

test('reflection stays locked until both the note and pending progress write finish', async () => {
  const file = { path: '40_回顾/2026-10-19.md' }, entered = deferred(), pending = deferred();
  const f = fixture({ file,
    saveData: async () => { entered.resolve(); await pending.promise; },
    journey: { saveReflection: async () => ({ file, created: true }) }
  });
  const form = f.modal('ReflectionModal'); const draft = '保存笔记之后还要等进度写完，期间不能输入新的草稿。';
  form.body.value = draft;
  const saving = form.save.click();
  await entered.promise;
  try {
    assert.equal(form.modal.saving, true); assert.equal(form.body.disabled, true);
    assert.equal(f.elements.findLast(el => el.props.text === '再想一想').disabled, true);
    assert.equal(f.elements.findLast(el => el.props.text === '复制草稿并打开回顾').disabled, true);
    form.modal.close();
    assert.equal(form.modal.closed, false); assert.equal(form.body.value, draft);
    assert.equal(f.opened.length, 0);
    assert.equal(journey.journeyStatus(f.plugin.journey, friday).steps.reflect, false);
  } finally { pending.resolve(); }
  await saving;
  assert.equal(form.modal.closed, true);
  assert.equal(journey.journeyStatus(f.disk().journey, friday).steps.reflect, true);
  assert.deepEqual(f.opened, [file.path]);
});

test('a reflection finishing after midnight keeps the week of its saved review file', async () => {
  const file = { path: '40_回顾/2026-10-19.md' }, pending = deferred();
  const f = fixture({ file, journey: { saveReflection: () => pending.promise } });
  f.setTime(new Date(2026, 9, 25, 23, 59, 59));
  const form = f.modal('ReflectionModal'); form.body.value = '周日晚上写下的回顾，仍然属于刚过去的这一周。';
  const saving = form.save.click();
  f.setTime(new Date(2026, 9, 26, 0, 0, 1)); pending.resolve({ file, created: true }); await saving;
  assert.equal(journey.journeyStatus(f.plugin.journey, friday).steps.reflect, true);
  assert.equal(journey.journeyStatus(f.plugin.journey, new Date(2026, 9, 26)).steps.reflect, false);
});

test('undoing last week’s move clears that week only after the file move succeeds', async () => {
  const move = { from: capture.path, to: '20_笔记/想法.md', journeyDate: friday };
  let undone = 0;
  const f = fixture({ workflow: { undoMove: async (_app, actual) => { assert.equal(actual, move); undone++; } } });
  await f.plugin.completeJourney('organize', move, friday);
  const monday = new Date(2026, 9, 26); f.setTime(monday);
  await f.plugin.completeJourney('capture', capture);
  await f.undoNotice(move).click();
  assert.equal(undone, 1); assert.equal(f.plugin.lastDeskMove, null);
  assert.equal(journey.journeyStatus(f.disk().journey, friday).steps.organize, false);
  assert.equal(journey.journeyStatus(f.disk().journey, monday).steps.capture, true);
});

test('a failed undo retains the organization milestone and offers the move again', async () => {
  const move = { from: capture.path, to: '20_笔记/想法.md', journeyDate: friday };
  const f = fixture({ workflow: { undoMove: async () => { throw new Error('原位置已有同名笔记'); } } });
  await f.plugin.completeJourney('organize', move, friday);
  await f.undoNotice(move).click();
  assert.equal(f.plugin.lastDeskMove, move);
  assert.equal(journey.journeyStatus(f.disk().journey, friday).steps.organize, true);
  assert.ok(f.notices.some(text => /同名笔记/.test(text)));
});

test('duplicate reflection repairs lost progress and copies the full draft before opening the note', async () => {
  const file = { path: '40_回顾/2026-10-19.md' }, gate = deferred();
  const f = fixture({ file, copy: () => gate.promise, journey: { saveReflection: async () => ({ file, created: false }) } });
  const form = f.modal('ReflectionModal'); const draft = '    保留这段带缩进的新想法，之后在原来的回顾中补充。';
  form.body.value = draft; await form.save.click();
  assert.equal(journey.journeyStatus(f.disk().journey, friday).steps.reflect, true);
  const recovery = f.elements.findLast(el => el.props.text === '复制草稿并打开回顾');
  assert.equal(recovery.hidden, false);
  const copying = recovery.click();
  assert.equal(form.modal.closed, false); assert.equal(f.opened.length, 0);
  gate.resolve(); await copying;
  assert.deepEqual(f.copied, [draft]); assert.deepEqual(f.opened, [file.path]);
  assert.equal(form.modal.closed, true);
});

test('clipboard failure never closes or clears a duplicate reflection draft', async () => {
  const file = { path: '40_回顾/2026-10-19.md' };
  const f = fixture({ file, copy: async () => { throw new Error('剪贴板不可用'); }, journey: { saveReflection: async () => ({ file, created: false }) } });
  const form = f.modal('ReflectionModal'); const draft = '复制失败时这一段新的反思内容必须继续留在窗口里。';
  form.body.value = draft; await form.save.click();
  await f.elements.findLast(el => el.props.text === '复制草稿并打开回顾').click();
  assert.equal(form.modal.closed, false); assert.equal(form.body.value, draft);
  assert.equal(f.opened.length, 0); assert.equal(f.copied.length, 0);
  assert.ok(f.notices.some(text => /剪贴板不可用/.test(text)));
});

for (const succeeds of [true, false]) {
  test(`pending clipboard write protects the draft until ${succeeds ? 'success' : 'failure'}`, async () => {
    const file = { path: '40_回顾/2026-10-19.md' }, pending = deferred();
    const f = fixture({ file, copy: () => pending.promise, journey: { saveReflection: async () => ({ file, created: false }) } });
    const form = f.modal('ReflectionModal'); const draft = '复制期间不允许输入新内容，避免复制的旧文本与关闭时的新文本不一致。';
    form.body.value = draft; await form.save.click();
    const recover = f.elements.findLast(el => el.props.text === '复制草稿并打开回顾');
    const cancel = f.elements.findLast(el => el.props.text === '再想一想');
    const copying = recover.click();
    try {
      assert.equal(form.modal.saving, true); assert.equal(form.body.disabled, true);
      assert.equal(form.save.disabled, true); assert.equal(cancel.disabled, true);
      form.modal.close();
      assert.equal(form.modal.closed, false); assert.equal(form.body.value, draft);
      assert.equal(f.opened.length, 0); assert.equal(f.copied.length, 0);
    } finally {
      if (succeeds) pending.resolve(); else pending.reject(new Error('剪贴板被拒绝'));
    }
    await copying;
    assert.equal(form.modal.saving, false); assert.equal(form.body.disabled, false);
    assert.equal(form.save.disabled, false); assert.equal(cancel.disabled, false);
    assert.equal(form.modal.closed, succeeds);
    assert.deepEqual(f.copied, succeeds ? [draft] : []);
    assert.deepEqual(f.opened, succeeds ? [file.path] : []);
    if (!succeeds) {
      assert.equal(form.body.value, draft);
      assert.ok(f.notices.some(text => /剪贴板被拒绝/.test(text)));
    }
  });
}
