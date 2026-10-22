'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { DEFAULT_WORKFLOW, validateWorkflowSettings, localDate, weekRange, templateFolder, createCapture, moveInboxNote, undoMove, createWeeklyReview } = require('./workflow');

function fakeApp() {
  const entries = new Map();
  const contents = new Map();
  const calls = { creates: [], folders: [], renames: [], reads: [] };
  function parents(path) {
    const parts = path.split('/'); parts.pop();
    let parent = '';
    for (const part of parts) {
      parent = parent ? parent + '/' + part : part;
      if (!entries.has(parent)) entries.set(parent, { path: parent, children: [] });
    }
  }
  function seed(path, text = '', mtime = 0) {
    parents(path);
    const name = path.split('/').pop();
    const file = { path, name, basename: name.replace(/\.[^.]+$/, ''), extension: name.split('.').pop(), stat: { mtime, ctime: mtime, size: text.length } };
    entries.set(path, file); contents.set(file, text); return file;
  }
  const vault = {
    getAbstractFileByPath: path => entries.get(path) || null,
    getMarkdownFiles: () => [...entries.values()].filter(file => !file.children && file.extension.toLowerCase() === 'md'),
    createFolder: async path => {
      calls.folders.push(path); await Promise.resolve();
      if (entries.has(path)) throw new Error('exists');
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (path.includes('/') && !entries.get(parent)?.children) throw new Error('missing parent');
      entries.set(path, { path, children: [] });
    },
    create: async (path, text) => {
      calls.creates.push(path); await Promise.resolve();
      if (entries.has(path)) throw new Error('exists');
      if (!entries.get(path.slice(0, path.lastIndexOf('/')))?.children) throw new Error('missing parent');
      return seed(path, text, Date.now());
    },
    cachedRead: async file => { calls.reads.push(file.path); if (!contents.has(file)) throw new Error('missing'); return contents.get(file); }
  };
  const app = {
    vault,
    fileManager: { renameFile: async (file, path) => {
      calls.renames.push({ from: file.path, to: path }); await Promise.resolve();
      if (entries.get(file.path) !== file) throw new Error('missing');
      if (entries.has(path)) throw new Error('exists');
      if (!entries.get(path.slice(0, path.lastIndexOf('/')))?.children) throw new Error('missing parent');
      entries.delete(file.path); file.path = path; file.name = path.split('/').pop(); file.basename = file.name.replace(/\.[^.]+$/, ''); entries.set(path, file);
    } }
  };
  return { app, vault, entries, contents, calls, seed };
}

test('settings merge defaults and accept independent nested folders', () => {
  assert.deepEqual(validateWorkflowSettings(), DEFAULT_WORKFLOW);
  const settings = validateWorkflowSettings({ inbox: '记录/收集', archive: '20_笔记/旧稿', weekly: '30_项目/回顾' });
  assert.equal(settings.inbox, '记录/收集');
  assert.equal(settings.notes, DEFAULT_WORKFLOW.notes);
});

test('settings reject escaping, hidden and Windows-incompatible paths', () => {
  for (const inbox of ['', '/', '/tmp', '../box', 'a/../box', './box', '.obsidian', 'a/.secret', 'a//b', 'a/', 'C:\\notes', 'C:/notes', 'a\\b', 'a:b', 'a?b', 'a*b', 'a|b', 'a<b', 'a>b', 'a"b', 'a\u0000b', 'a./b', 'a /b', 'a/CON.txt', 'NUL', 'lpt1', 'COM¹', ' trailing', 'trailing ']) {
    assert.throws(() => validateWorkflowSettings({ inbox }), undefined, inbox);
  }
  assert.throws(() => validateWorkflowSettings(null));
  assert.throws(() => validateWorkflowSettings([]));
  assert.throws(() => validateWorkflowSettings({ inbox: 4 }));
});

test('settings prevent directories swallowing each other or hiding all source notes', () => {
  for (const settings of [
    { inbox: '20_笔记' }, { inbox: '20_笔记/收集' }, { inbox: '20_笔记', notes: '20_笔记/永久' },
    { inbox: 'NOTES', notes: 'notes/sub' }, { archive: '资料', notes: '资料/笔记' },
    { weekly: '30_项目' }, { archive: '回顾', weekly: '回顾/每周' }, { archive: '回顾/旧', weekly: '回顾' }
  ]) assert.throws(() => validateWorkflowSettings(settings));
});

test('local date and week stay on calendar boundaries across New Year', () => {
  const date = new Date(2021, 0, 1, 23, 59, 59);
  assert.equal(localDate(date), '2021-01-01');
  assert.deepEqual(weekRange(date), { start: '2020-12-28', end: '2021-01-03', fromMs: new Date(2020, 11, 28).getTime(), toMs: new Date(2021, 0, 4).getTime() });
  assert.equal(date.getHours(), 23);
  assert.throws(() => weekRange(new Date(NaN)));
  assert.throws(() => localDate('2026-10-22'));
});

test('week ranges honor both DST transitions instead of assuming 168 hours', () => {
  const script = `const {weekRange, localDate} = require(${JSON.stringify(require.resolve('./workflow'))});
    const spring=weekRange(new Date(2026,2,8,20)); const fall=weekRange(new Date(2026,10,1,20));
    console.log(JSON.stringify({spring,fall,nearUtc:localDate(new Date('2026-01-01T02:00:00Z'))}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/New_York' }, encoding: 'utf8' }));
  assert.equal(result.spring.start, '2026-03-02'); assert.equal(result.spring.end, '2026-03-08');
  assert.equal((result.spring.toMs - result.spring.fromMs) / 3600000, 167);
  assert.equal(result.fall.start, '2026-10-26'); assert.equal(result.fall.end, '2026-11-01');
  assert.equal((result.fall.toMs - result.fall.fromMs) / 3600000, 169);
  assert.equal(result.nearUtc, '2025-12-31');
});

test('a Sunday midnight DST gap does not shift Monday boundaries to 01:00', () => {
  const script = `const {weekRange} = require(${JSON.stringify(require.resolve('./workflow'))});
    const week=weekRange(new Date(2026,8,6,12));
    console.log(JSON.stringify({week,fromHour:new Date(week.fromMs).getHours(),toHour:new Date(week.toMs).getHours()}));`;
  const result = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'America/Santiago' }, encoding: 'utf8' }));
  assert.equal(result.week.start, '2026-08-31'); assert.equal(result.week.end, '2026-09-06');
  assert.equal(result.fromHour, 0); assert.equal(result.toHour, 0);
  assert.equal((result.week.toMs - result.week.fromMs) / 3600000, 167);
});

test('capture requires body before touching the vault and creates missing parents', async () => {
  const f = fakeApp();
  await assert.rejects(createCapture(f.vault, {}, { title: '标题', body: ' \n ' }), /正文/);
  assert.equal(f.entries.size, 0);
  const file = await createCapture(f.vault, { inbox: '资料/收集' }, { body: '# 第一条想法\n\n- [ ] 保留 Markdown' });
  assert.equal(file.path, '资料/收集/第一条想法.md');
  assert.equal(f.contents.get(file), '# 第一条想法\n\n- [ ] 保留 Markdown\n');
  assert.deepEqual(f.calls.folders, ['资料', '资料/收集']);
});

test('capture sanitizes filename without changing its body', async () => {
  const f = fakeApp();
  const file = await createCapture(f.vault, {}, { title: '../a/b\\c:*?<>|"', body: 'original [link](x)\n正文' });
  assert.ok(file.path.startsWith('01_收集箱/'));
  assert.equal(file.path.split('/').length, 2);
  assert.doesNotMatch(file.name, /[<>:"\\|?*]/);
  assert.equal(f.contents.get(file), 'original [link](x)\n正文\n');
  const device = await createCapture(f.vault, {}, { title: 'CON.txt', body: 'text' });
  assert.equal(device.name, '_CON.txt.md');
  const fallback = await createCapture(f.vault, {}, { title: '...', body: 'text' }, new Date(2026, 9, 22));
  assert.equal(fallback.name, '随手记-2026-10-22.md');
  const emoji = await createCapture(f.vault, {}, { title: '📖'.repeat(100), body: 'text' });
  assert.ok(Buffer.byteLength(emoji.name, 'utf8') <= 255);
});

test('capture preserves indentation, surrounding blank lines and Markdown hard breaks', async () => {
  const f = fakeApp();
  const body = '    # This is code\r\n    console.log(1)';
  const code = await createCapture(f.vault, {}, { body });
  assert.equal(f.contents.get(code), '    # This is code\n    console.log(1)\n');
  const spaced = await createCapture(f.vault, {}, { title: 'spacing', body: '\r\n\tcode\r\nline with hard break  \r\n\r\n' });
  assert.equal(f.contents.get(spaced), '\n\tcode\nline with hard break  \n\n');
  const ending = await createCapture(f.vault, {}, { title: 'ending', body: 'already complete\n' });
  assert.equal(f.contents.get(ending), 'already complete\n');
});

test('same-title concurrent captures never overwrite or return the same file', async () => {
  const f = fakeApp();
  const original = f.seed('01_收集箱/相同.md', 'already here');
  const captures = await Promise.all(Array.from({ length: 10 }, (_, i) => createCapture(f.vault, {}, { title: '相同', body: 'body ' + i })));
  assert.equal(new Set(captures).size, 10);
  assert.equal(new Set(captures.map(file => file.path)).size, 10);
  assert.equal(f.contents.get(original), 'already here');
  captures.forEach((file, i) => assert.equal(f.contents.get(file), 'body ' + i + '\n'));
});

test('capture retries a competing external create and a folder-create race', async () => {
  const f = fakeApp();
  const create = f.vault.create;
  f.vault.createFolder = async path => { f.entries.set(path, { path, children: [] }); throw new Error('raced folder'); };
  let competing;
  f.vault.create = async (path, text) => {
    if (!competing) { competing = f.seed(path, 'someone else'); throw new Error('raced file'); }
    return create(path, text);
  };
  const file = await createCapture(f.vault, {}, { title: 'same', body: 'mine' });
  assert.equal(file.name, 'same (2).md');
  assert.equal(f.contents.get(competing), 'someone else');
  assert.equal(f.contents.get(file), 'mine\n');
});

test('storage failures propagate and do not poison later capture operations', async () => {
  const f = fakeApp(); const create = f.vault.create;
  f.vault.create = async () => { throw new Error('disk full'); };
  await assert.rejects(createCapture(f.vault, {}, { body: 'first' }), /disk full/);
  f.vault.create = create;
  const file = await createCapture(f.vault, {}, { body: 'second' });
  assert.equal(f.contents.get(file), 'second\n');
  const blocked = fakeApp(); blocked.seed('01_收集箱', 'a file');
  await assert.rejects(createCapture(blocked.vault, {}, { body: 'blocked' }), /已被文件占用/);
  assert.equal(blocked.calls.creates.length, 0);
});

test('move uses renameFile, preserves links through that API, and undo keeps edits', async () => {
  const f = fakeApp(); const file = f.seed('01_收集箱/深层/想法.md', 'before');
  const move = await moveInboxNote(f.app, {}, file, 'notes');
  assert.deepEqual(move, { file, from: '01_收集箱/深层/想法.md', to: '20_笔记/想法.md' });
  assert.equal(f.contents.get(file), 'before');
  f.contents.set(file, 'edited after move');
  const restored = await undoMove(f.app, move);
  assert.equal(restored, file); assert.equal(file.path, move.from);
  assert.equal(f.contents.get(file), 'edited after move');
  assert.deepEqual(f.calls.renames, [{ from: move.from, to: move.to }, { from: move.to, to: move.from }]);
});

test('only current Markdown inbox files can move to the allowed destinations', async () => {
  const f = fakeApp(); const outside = f.seed('01_收集箱副本/test.md'); const pdf = f.seed('01_收集箱/test.pdf');
  const note = f.seed('01_收集箱/test.md'); const stale = { ...note };
  await assert.rejects(moveInboxNote(f.app, {}, outside, 'notes'), /当前收集箱/);
  await assert.rejects(moveInboxNote(f.app, {}, pdf, 'notes'), /Markdown/);
  await assert.rejects(moveInboxNote(f.app, {}, stale, 'notes'), /刷新/);
  await assert.rejects(moveInboxNote(f.app, {}, note, 'weekly'), /只能移到/);
  await assert.rejects(moveInboxNote(f.app, {}, f.entries.get('01_收集箱'), 'notes'), /Markdown/);
  assert.equal(f.calls.renames.length, 0);
  await moveInboxNote(f.app, {}, note, 'projects');
  assert.equal(note.path, '30_项目/test.md');
});

test('move and undo refuse collisions without replacing either file', async () => {
  const f = fakeApp(); const file = f.seed('01_收集箱/a.md', 'inbox'); const target = f.seed('20_笔记/a.md', 'existing');
  await assert.rejects(moveInboxNote(f.app, {}, file, 'notes'), /同名/);
  assert.equal(f.contents.get(file), 'inbox'); assert.equal(f.contents.get(target), 'existing');
  const move = await moveInboxNote(f.app, {}, file, 'archive');
  const replacement = f.seed(move.from, 'new inbox note');
  await assert.rejects(undoMove(f.app, move), /原位置已有/);
  assert.equal(file.path, move.to); assert.equal(f.contents.get(replacement), 'new inbox note');
  f.entries.delete(replacement.path);
  await f.vault.createFolder('Elsewhere'); await f.app.fileManager.renameFile(file, 'Elsewhere/a.md');
  await assert.rejects(undoMove(f.app, move), /再次移动/);
  assert.equal(f.contents.get(file), 'inbox');
});

test('concurrent moves of one note and concurrent undo have one winner', async () => {
  const f = fakeApp(); const file = f.seed('01_收集箱/a.md', 'stable');
  const moves = await Promise.allSettled([moveInboxNote(f.app, {}, file, 'notes'), moveInboxNote(f.app, {}, file, 'projects')]);
  assert.equal(moves.filter(result => result.status === 'fulfilled').length, 1);
  const move = moves.find(result => result.status === 'fulfilled').value;
  const undo = await Promise.allSettled([undoMove(f.app, move), undoMove(f.app, move)]);
  assert.equal(undo.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(file.path, move.from); assert.equal(f.contents.get(file), 'stable');
});

test('rename rejection is not reported as a successful move or undo', async () => {
  const f = fakeApp(); const file = f.seed('01_收集箱/a.md', 'stable'); const rename = f.app.fileManager.renameFile;
  f.app.fileManager.renameFile = async () => { throw new Error('permission denied'); };
  await assert.rejects(moveInboxNote(f.app, {}, file, 'notes'), /permission denied/);
  assert.equal(file.path, '01_收集箱/a.md');
  f.app.fileManager.renameFile = rename;
  const move = await moveInboxNote(f.app, {}, file, 'notes');
  f.app.fileManager.renameFile = async () => { throw new Error('permission denied'); };
  await assert.rejects(undoMove(f.app, move), /permission denied/);
  assert.equal(file.path, move.to); assert.equal(f.contents.get(file), 'stable');
});

test('weekly review uses the local Monday filename and includes the intended three groups', async () => {
  const f = fakeApp(); const date = new Date(2021, 0, 1, 13); const range = weekRange(date);
  const inbox = f.seed('01_收集箱/inbox.md', 'capture', range.fromMs);
  f.seed('20_笔记/start.md', '#待回顾', range.fromMs);
  f.seed('30_项目/last.md', 'project', range.toMs - 1);
  f.seed('30_项目/next.md', 'future', range.toMs);
  f.seed('20_笔记/old.md', 'old', range.fromMs - 1);
  f.seed('Elsewhere/marked.md', '#待回顾/本周', range.fromMs);
  f.seed('50_归档/skip.md', '#待回顾', range.fromMs);
  f.seed('40_回顾/skip.md', '#待回顾', range.fromMs);
  f.seed('90_模板/skip.md', '#待回顾', range.fromMs);
  f.seed('20_笔记/ignored/skip.md', '#待回顾', range.fromMs);
  f.app.internalPlugins = { plugins: { templates: { instance: { options: { folder: '20_笔记/ignored' } } } } };
  const file = await createWeeklyReview(f.app, {}, date); const text = f.contents.get(file);
  assert.equal(file.path, '40_回顾/2020-12-28.md');
  assert.match(text, /2020-12-28 — 2021-01-03/); assert.match(text, /生成时快照（2021-01-01 13:00，本地时间）/);
  assert.match(text, /## 收集箱（1）/); assert.match(text, /## 待回顾（2）/); assert.match(text, /## 本周修改（3）/);
  assert.doesNotMatch(text, /skip|future|\/next|\/old/);
  assert.equal(f.contents.get(inbox), 'capture');
});

test('tag fallback reads actual tags and frontmatter, excluding examples and longer unrelated tags', async () => {
  const f = fakeApp();
  for (const [name, text] of Object.entries({
    yes: '#待回顾', nested: '事项 #待回顾/之后。', yaml: '---\ntags: [待回顾, 阅读]\n---\ntext',
    list: '---\ntags:\n  - 阅读\n  - 待回顾\n---\ntext',
    fenced: '```md\n#待回顾\n```', tilde: '~~~\n#待回顾\n~~~', inline: '使用 `#待回顾`',
    escaped: '\\#待回顾', longer: '#待回顾内容', url: '[x](https://site/#待回顾)', comment: '<!-- #待回顾 -->', indented: '    #待回顾'
  })) f.seed('20_笔记/' + name + '.md', text);
  const file = await createWeeklyReview(f.app, {}, new Date(2026, 9, 22)); const text = f.contents.get(file);
  assert.match(text, /## 待回顾（4）/);
  for (const name of ['yes', 'nested', 'yaml', 'list']) assert.match(text, new RegExp('/' + name + '\\]'));
  for (const name of ['fenced', 'tilde', 'inline', 'escaped', 'longer', 'url', 'comment', 'indented']) assert.doesNotMatch(text, new RegExp('/' + name + '\\]'));
});

test('weekly uses Obsidian metadata when available for tags and frontmatter', async () => {
  const f = fakeApp(); const files = [f.seed('20_笔记/a.md'), f.seed('20_笔记/b.md'), f.seed('20_笔记/c.md', '#待回顾 example')];
  f.app.metadataCache = { getFileCache: file => file === files[0] ? { tags: [{ tag: '#待回顾/以后' }] } : file === files[1] ? { frontmatter: { tags: ['阅读', '待回顾'] } } : {} };
  const file = await createWeeklyReview(f.app, {}, new Date(2026, 9, 22));
  assert.match(f.contents.get(file), /## 待回顾（2）/);
  assert.equal(f.calls.reads.length, 0);
});

test('template-folder hint is optional and safely falls back if unavailable or invalid', () => {
  assert.equal(templateFolder({}), '90_模板');
  const app = { internalPlugins: { plugins: { templates: { instance: { options: { folder: '我的/模板/' } } } } } };
  assert.equal(templateFolder(app), '我的/模板');
  app.internalPlugins.plugins.templates.instance.options.folder = '../outside';
  assert.equal(templateFolder(app), '90_模板');
});

test('weekly links escape labels and encode each relative Markdown path segment', async () => {
  const f = fakeApp(); f.seed('01_收集箱/A [B] (C) #50% & 中文.md', '#待回顾');
  const file = await createWeeklyReview(f.app, { weekly: '回顾/每周' }, new Date(2026, 9, 22)); const text = f.contents.get(file);
  assert.ok(text.includes('A \\[B\\] (C) #50% & 中文]('));
  assert.ok(text.includes('../../01_%E6%94%B6%E9%9B%86%E7%AE%B1/A%20%5BB%5D%20%28C%29%20%2350%25%20%26%20%E4%B8%AD%E6%96%87.md)'));
});

test('each group limits 50 entries and states the omitted count', async () => {
  const f = fakeApp(); const date = new Date(2026, 9, 22); const mtime = date.getTime();
  for (let i = 0; i < 53; i++) f.seed('01_收集箱/note' + String(i).padStart(2, '0') + '.md', '#待回顾', mtime + i);
  const file = await createWeeklyReview(f.app, {}, date); const text = f.contents.get(file);
  assert.equal((text.match(/^- \[/gm) || []).length, 150);
  assert.equal((text.match(/另有 3 篇未列出/g) || []).length, 3);
  assert.doesNotMatch(text, /note00|note01|note02/);
});

test('same-week existing review is returned unchanged without scanning notes', async () => {
  const f = fakeApp(); const existing = f.seed('40_回顾/2026-10-19.md', 'my edited review');
  f.seed('20_笔记/new.md', '#待回顾');
  f.vault.getMarkdownFiles = () => { throw new Error('should not scan'); };
  assert.equal(await createWeeklyReview(f.app, {}, new Date(2026, 9, 22)), existing);
  assert.equal(f.contents.get(existing), 'my edited review'); assert.equal(f.calls.creates.length, 0);
});

test('concurrent weekly generation creates one snapshot and an external claimant is preserved', async () => {
  const f = fakeApp(); f.seed('01_收集箱/a.md', 'capture'); const date = new Date(2026, 9, 22);
  const results = await Promise.all(Array.from({ length: 6 }, () => createWeeklyReview(f.app, {}, date)));
  assert.equal(new Set(results).size, 1); assert.equal(f.calls.creates.length, 1);
  const race = fakeApp(); let claimant;
  race.vault.create = async path => { claimant = race.seed(path, 'outside writer'); throw new Error('exists'); };
  assert.equal(await createWeeklyReview(race.app, {}, date), claimant);
  assert.equal(race.contents.get(claimant), 'outside writer');
});

test('weekly read/write failures are visible and never leave a partial note', async () => {
  const f = fakeApp(); f.seed('01_收集箱/a.md', 'read me'); const date = new Date(2026, 9, 22);
  f.vault.cachedRead = async () => { throw new Error('read failure'); };
  await assert.rejects(createWeeklyReview(f.app, {}, date), /read failure/);
  assert.equal(f.vault.getAbstractFileByPath('40_回顾/2026-10-19.md'), null);
  const failed = fakeApp(); failed.vault.create = async () => { throw new Error('disk full'); };
  await assert.rejects(createWeeklyReview(failed.app, {}, date), /disk full/);
  assert.equal(failed.vault.getAbstractFileByPath('40_回顾/2026-10-19.md'), null);
  const blocked = fakeApp(); blocked.entries.set('40_回顾/2026-10-19.md', { path: '40_回顾/2026-10-19.md', children: [] });
  await assert.rejects(createWeeklyReview(blocked.app, {}, date), /占用/);
});
