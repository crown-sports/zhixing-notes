'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { weekRange, DEFAULT_WORKFLOW } = require('./workflow');
const { normalizeJourney, recordJourney, undoJourneyMove, journeyStatus, saveReflection } = require('./journey');
const friday = () => new Date(2026, 9, 23, 10);
const monday = () => new Date(2026, 9, 26, 10);
const capture = { path: '01_收集箱/一条想法.md' };
const move = { from: capture.path, to: '20_笔记/一条想法.md' };

function fixture() {
  const entries = new Map(), contents = new Map();
  const calls = { writes: 0, processes: 0, creates: 0 };
  let processing = Promise.resolve();
  const seed = (path, text) => {
    const parts = path.split('/'); parts.pop(); let folder = '';
    for (const part of parts) { folder = folder ? folder + '/' + part : part; if (!entries.has(folder)) entries.set(folder, { path: folder, children: [] }); }
    const file = { path, basename: path.split('/').pop().replace(/\.md$/, ''), stat: { mtime: friday().getTime() } };
    entries.set(path, file); contents.set(file, text); return file;
  };
  const vault = {
    getAbstractFileByPath: path => entries.get(path),
    getMarkdownFiles: () => [...entries.values()].filter(file => !file.children),
    cachedRead: async file => contents.get(file),
    createFolder: async path => { if (entries.has(path)) throw new Error('exists'); entries.set(path, { path, children: [] }); },
    create: async (path, text) => { if (entries.has(path)) throw new Error('exists'); calls.creates++; return seed(path, text); },
    process(file, update) {
      const result = processing.then(async () => {
        calls.processes++;
        if (entries.get(file.path) !== file) throw new Error('missing');
        const next = update(contents.get(file));
        if (next !== contents.get(file)) calls.writes++;
        contents.set(file, next); return next;
      });
      processing = result.catch(() => {}); return result;
    }
  };
  return { app: { vault }, vault, entries, contents, seed, calls };
}

test('a fresh journey starts with three optional unfinished stages', () => {
  assert.deepEqual(normalizeJourney(), { mode: 'adventure', weeks: {} });
  assert.deepEqual(journeyStatus(null, friday()), {
    week: '2026-10-19', start: '2026-10-19', end: '2026-10-25', done: 0, total: 3,
    steps: { capture: false, organize: false, reflect: false }
  });
});

test('milestones can be completed out of order and repeated actions do not add stars', () => {
  let state = recordJourney(undefined, 'reflect', { path: '40_回顾/2026-10-19.md' }, friday());
  assert.equal(journeyStatus(state, friday()).done, 1);
  state = recordJourney(state, 'capture', capture, friday());
  state = recordJourney(state, 'organize', move, friday());
  state = recordJourney(state, 'organize', { from: '01_收集箱/第二条.md', to: '20_笔记/第二条.md' }, friday());
  assert.equal(journeyStatus(state, friday()).done, 3);
  assert.deepEqual(state.weeks['2026-10-19'].organize, move);
});

test('recording does not mutate prior data or keep supplied note contents', () => {
  const original = { mode: 'focus', weeks: { '2026-10-12': { capture } } };
  const before = JSON.stringify(original);
  const result = recordJourney(original, 'capture', { ...capture, text: 'private note', extra: true }, friday());
  assert.equal(JSON.stringify(original), before);
  assert.equal(result.mode, 'focus');
  assert.deepEqual(result.weeks['2026-10-19'].capture, capture);
  result.weeks['2026-10-12'].capture.path = 'modified.md';
  assert.equal(JSON.stringify(original), before);
});

test('malformed and unsafe saved evidence is dropped without failing startup', () => {
  for (const saved of [null, undefined, 3, [], 'wrong', { weeks: [] }]) assert.deepEqual(normalizeJourney(saved), { mode: 'adventure', weeks: {} });
  const result = normalizeJourney({ mode: 'unknown', weeks: {
    'bad': { capture }, '2026-10-20': { capture }, '2026-02-30': { capture },
    '2026-10-19': { capture: { path: '../secrets.md' }, organize: { from: capture.path, to: capture.path }, reflect: { path: '/outside.md' } },
    '2026-10-12': { capture: { path: '.obsidian/private.md' }, reflect: { path: '回顾/收获.md', body: 'do not keep' } }
  } });
  assert.deepEqual(result, { mode: 'adventure', weeks: { '2026-10-12': { reflect: { path: '回顾/收获.md' } } } });
});

test('bad milestone data cannot create progress', () => {
  assert.throws(() => recordJourney(null, 'click', capture, friday()), /未知/);
  for (const path of ['x', '/x.md', '../x.md', 'a/../x.md', '.obsidian/x.md', 'a\\x.md', 'a//x.md', 'a\u0000.md']) {
    assert.throws(() => recordJourney(null, 'capture', { path }, friday()), /路径/);
  }
  assert.throws(() => recordJourney(null, 'organize', { path: capture.path }, friday()), /路径/);
  assert.throws(() => recordJourney(null, 'capture', capture, new Date(NaN)), /日期/);
});

test('week rollover starts fresh while preserving previous progress', () => {
  const state = recordJourney(undefined, 'capture', capture, friday());
  assert.equal(journeyStatus(state, monday()).done, 0);
  const next = recordJourney(state, 'reflect', { path: '40_回顾/2026-10-26.md' }, monday());
  assert.equal(journeyStatus(next, friday()).done, 1);
  assert.equal(journeyStatus(next, monday()).done, 1);
  const newYear = recordJourney(null, 'capture', capture, new Date(2021, 0, 1, 23));
  assert.equal(journeyStatus(newYear, new Date(2021, 0, 3)).week, '2020-12-28');
});

test('only the most recent 26 stored weeks survive normalization', () => {
  let state;
  for (let index = 0; index < 30; index++) state = recordJourney(state, 'capture', capture, new Date(2026, 0, 5 + index * 7, 12));
  const keys = Object.keys(state.weeks);
  assert.equal(keys.length, 26);
  assert.equal(keys[0], weekRange(new Date(2026, 0, 5 + 29 * 7, 12)).start);
  assert.equal(keys.at(-1), weekRange(new Date(2026, 0, 5 + 4 * 7, 12)).start);
});

test('undo removes only the matching first organization milestone this week', () => {
  let state = recordJourney(null, 'capture', capture, friday());
  state = recordJourney(state, 'organize', move, friday());
  const otherMove = { from: '01_收集箱/别的.md', to: '20_笔记/别的.md' };
  assert.equal(journeyStatus(undoJourneyMove(state, otherMove, friday()), friday()).done, 2);
  assert.equal(journeyStatus(undoJourneyMove(state, move, monday()), friday()).done, 2);
  const undone = undoJourneyMove(state, move, friday());
  assert.equal(journeyStatus(undone, friday()).done, 1);
  assert.equal(journeyStatus(state, friday()).done, 2, 'undo must not mutate saved state');
  assert.equal(journeyStatus(recordJourney(undone, 'organize', otherMove, friday()), friday()).done, 2);
  assert.deepEqual(undoJourneyMove(recordJourney(null, 'organize', move, friday()), move, friday()).weeks, {});
});

test('a too-short reflection fails before creating files or folders', async () => {
  const f = fixture();
  for (const text of [undefined, '', ' \n\t ', '太短了', '12345     6789']) await assert.rejects(saveReflection(f.app, {}, text, friday()), /至少 10/);
  assert.equal(f.entries.size, 0);
});

test('saving a reflection creates the weekly note and preserves Markdown indentation', async () => {
  const f = fixture();
  f.seed('01_收集箱/今天的想法.md', '整理后记得回顾。');
  const text = '    # 这一周我学会先写下一步\n    console.log("保留缩进");  \n';
  const result = await saveReflection(f.app, DEFAULT_WORKFLOW, text, friday());
  assert.equal(result.file.path, '40_回顾/2026-10-19.md');
  assert.equal(result.created, true);
  const content = f.contents.get(result.file);
  assert.match(content, /# 每周回顾 · 2026-10-19/);
  assert.ok(content.endsWith('<!-- zhixing-journey:2026-10-19 -->\n## 本周收获\n\n' + text));
  assert.equal(f.calls.writes, 1);
});

test('reflection appends to the latest weekly note without changing handwritten content', async () => {
  const f = fixture();
  const original = '# 已有回顾\r\n\r\n这段总结和尾部空格都保留。  ';
  const file = f.seed('40_回顾/2026-10-19.md', original);
  const process = f.vault.process;
  f.vault.process = (target, update) => {
    f.contents.set(target, f.contents.get(target) + '\r\n并发编辑刚刚补上的一句。');
    return process(target, update);
  };
  const result = await saveReflection(f.app, {}, '下周先完成一个小目标，再考虑其他事情。', friday());
  assert.equal(result.file, file); assert.equal(result.created, true);
  const content = f.contents.get(file);
  assert.ok(content.startsWith(original + '\r\n并发编辑刚刚补上的一句。\r\n\r\n'));
  assert.ok(!content.replace(/\r\n/g, '').includes('\n'), 'existing CRLF style is preserved');
  assert.equal(f.calls.creates, 0);
});

test('repeating a reflection never replaces the first saved words', async () => {
  const f = fixture();
  const first = await saveReflection(f.app, {}, '第一段感受：每次只做一件事，让自己轻松开始。', friday());
  const before = f.contents.get(first.file);
  const second = await saveReflection(f.app, {}, '第二段内容不应该覆盖已经写好的第一段感受。', friday());
  assert.equal(second.created, false); assert.equal(second.file, first.file);
  assert.equal(f.contents.get(first.file), before);
  assert.equal(f.calls.writes, 1);
});

test('concurrent reflection submissions append exactly one section', async () => {
  const f = fixture();
  const results = await Promise.all([
    saveReflection(f.app, {}, '第一条并发提交的反思正文足够长。', friday()),
    saveReflection(f.app, {}, '第二条并发提交的反思正文也足够长。', friday())
  ]);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(f.calls.writes, 1);
  const content = f.contents.get(results[0].file);
  assert.equal(content.split('<!-- zhixing-journey:2026-10-19 -->').length, 2);
});

test('a failed atomic write keeps existing notes and propagates the error for retry', async () => {
  const f = fixture();
  const file = f.seed('40_回顾/2026-10-19.md', '原来的手写总结，不应该丢失。');
  const process = f.vault.process;
  f.vault.process = async () => { throw new Error('disk full'); };
  await assert.rejects(saveReflection(f.app, {}, '这是还没保存成功的反思，请保留在输入框中。', friday()), /disk full/);
  assert.equal(f.contents.get(file), '原来的手写总结，不应该丢失。');
  f.vault.process = process;
  assert.equal((await saveReflection(f.app, {}, '这是还没保存成功的反思，请保留在输入框中。', friday())).created, true);
});

test('unsupported atomic writes and occupied weekly paths fail before changing content', async () => {
  const f = fixture();
  const process = f.vault.process;
  delete f.vault.process;
  await assert.rejects(saveReflection(f.app, {}, '一段长于十个字的反思，不能不安全地写入。', friday()), /不支持安全写入/);
  assert.equal(f.entries.size, 0);
  f.vault.process = process;
  f.entries.set('40_回顾/2026-10-19.md', { path: '40_回顾/2026-10-19.md', children: [] });
  await assert.rejects(saveReflection(f.app, {}, '已有目录占用了这个路径，不应该写入。', friday()), /占用/);
  assert.equal(f.calls.processes, 0);
});

test('next week uses a separate file and cannot overwrite the previous reflection', async () => {
  const f = fixture();
  const first = await saveReflection(f.app, {}, '这一周我先记录下一步，没有要求自己一口气做完。', friday());
  const before = f.contents.get(first.file);
  const next = await saveReflection(f.app, {}, '新的一周继续做一点，用自己的例子记住读过的内容。', monday());
  assert.notEqual(next.file, first.file);
  assert.equal(next.file.path, '40_回顾/2026-10-26.md');
  assert.equal(f.contents.get(first.file), before);
  assert.match(f.contents.get(next.file), /zhixing-journey:2026-10-26/);
});
