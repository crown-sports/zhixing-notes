'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  selectionSubpath, pageSubpath, canonicalPosition, flattenOutline,
  resolveDestination, findPosition, upsertBookmark, saveBookmark,
} = require('../core');

function fakeNative(initialItems = []) {
  return {
    items: structuredClone(initialItems),
    calls: [],
    saved: structuredClone(initialItems),
    saveData() { this.saved = structuredClone(this.items); },
    addItem(item, parent) {
      (parent ? parent.items : this.items).push(item);
      this.calls.push({ method: 'addItem', item, parent });
      this.saveData();
    },
    editItem(item) {
      this.calls.push({ method: 'editItem', item });
      this.saveData();
    },
  };
}

function location(path = '教材/系统架构.pdf', subpath = '#page=27') {
  return { path, subpath, book: path.split('/').pop().replace(/\.pdf$/, '') };
}

function fakePdf({ numPages = 100, named = {}, refs = new Map() } = {}) {
  return {
    numPages,
    calls: [],
    async getDestination(name) {
      this.calls.push(['getDestination', name]);
      return named[name] ?? null;
    },
    async getPageIndex(ref) {
      this.calls.push(['getPageIndex', ref]);
      if (!refs.has(ref)) throw new Error('Unknown PDF page reference');
      return refs.get(ref);
    },
  };
}

test('selection preserves the four real text coordinates, including a zero index', () => {
  assert.equal(selectionSubpath({ page: 7, selection: {
    beginIndex: 0, beginOffset: 2, endIndex: 3, endOffset: 9,
  } }), '#page=7&selection=0,2,3,9');
  assert.equal(selectionSubpath({ page: 1, selection: {
    beginIndex: 8, beginOffset: 4, endIndex: 8, endOffset: 5,
  } }), '#page=1&selection=8,4,8,5');
});

test('collapsed, reversed, missing, fractional and negative selections are rejected', () => {
  const ranges = [
    undefined,
    { beginIndex: 1, beginOffset: 2, endIndex: 1, endOffset: 2 },
    { beginIndex: 1, beginOffset: 3, endIndex: 1, endOffset: 2 },
    { beginIndex: 3, beginOffset: 0, endIndex: 1, endOffset: 5 },
    { beginIndex: -1, beginOffset: 0, endIndex: 1, endOffset: 5 },
    { beginIndex: 0, beginOffset: 0.5, endIndex: 1, endOffset: 5 },
    { beginIndex: 0, beginOffset: 0, endIndex: 1, endOffset: NaN },
    { beginIndex: 0, beginOffset: 0, endIndex: 1 },
  ];
  for (const selection of ranges) assert.equal(selectionSubpath({ page: 7, selection }), null);
  assert.equal(selectionSubpath(null), null);
});

test('page fallback never invents text selection or incomplete offsets', () => {
  for (const state of [
    { page: 8 }, { page: 8, left: 2 }, { page: 8, top: 3 },
    { page: 8, left: Infinity, top: 3 }, { page: 8, left: 2, top: NaN },
  ]) assert.equal(pageSubpath(state), '#page=8');
  assert.equal(selectionSubpath({ page: 8 }), null);
  assert.equal(pageSubpath({ page: 8, left: 12.375, top: 42.8125, zoom: 1.2345 }), '#page=8&offset=12.375,42.8125,1.2345');
  assert.equal(pageSubpath({ page: 8, left: 0, top: 0 }), '#page=8&offset=0,0,0');
});

test('page and selection helpers reject invalid page numbers', () => {
  const selection = { beginIndex: 0, beginOffset: 0, endIndex: 0, endOffset: 1 };
  for (const page of [0, -1, 1.5, Infinity, NaN, 'bad', undefined, null]) {
    assert.equal(pageSubpath({ page }), null);
    assert.equal(selectionSubpath({ page, selection }), null);
  }
});

test('named outline destinations resolve references to one-based page numbers', async () => {
  const ref = { num: 23, gen: 0 };
  const pdf = fakePdf({ named: { chapter2: [ref, { name: 'XYZ' }, 18.2, 402.7, 1.236] }, refs: new Map([[ref, 12]]) });
  assert.deepEqual(await resolveDestination('chapter2', pdf), {
    page: 13, subpath: '#page=13&offset=18,403,1.24', hasOffset: true,
  });
  assert.deepEqual(pdf.calls, [['getDestination', 'chapter2'], ['getPageIndex', ref]]);
});

test('explicit numeric and reference destinations use the correct page-index semantics', async () => {
  const ref = { num: 40, gen: 0 };
  const pdf = fakePdf({ refs: new Map([[ref, 6]]) });
  assert.deepEqual(await resolveDestination([0, { name: 'Fit' }], pdf), { page: 1, subpath: '#page=1', hasOffset: false });
  assert.deepEqual(pdf.calls, [], 'numeric page indices must not be passed to getPageIndex');
  assert.deepEqual(await resolveDestination([ref, { name: 'FitB' }], pdf), { page: 7, subpath: '#page=7', hasOffset: false });
  assert.deepEqual(pdf.calls, [['getPageIndex', ref]]);
});

test('XYZ rounds only the output precision and supports missing coordinates', async () => {
  const pdf = fakePdf();
  assert.equal((await resolveDestination([2, { name: 'XYZ' }, -12.6, 50.49, 1.236], pdf)).subpath, '#page=3&offset=-13,50,1.24');
  assert.equal((await resolveDestination([2, 'XYZ', null, null, null], pdf)).subpath, '#page=3&offset=,,0');
});

test('FitH and FitBH preserve vertical position without inventing a horizontal coordinate', async () => {
  for (const mode of ['FitH', 'FitBH']) {
    assert.deepEqual(await resolveDestination([4, { name: mode }, 671.125], fakePdf()), {
      page: 5, subpath: '#page=5&offset=,671.125,', hasOffset: true,
    });
  }
});

test('vertical and rectangular fit destinations retain their usable coordinates', async () => {
  for (const mode of ['FitV', 'FitBV']) {
    assert.equal((await resolveDestination([1, { name: mode }, 20.5], fakePdf())).subpath, '#page=2&offset=20.5,,');
  }
  assert.equal((await resolveDestination([1, { name: 'FitR' }, 20.5, 15, 300, 550.25], fakePdf())).subpath, '#page=2&offset=20.5,550.25,');
});

test('missing PDF, invalid destinations, external links and unknown destination modes reject', async () => {
  await assert.rejects(resolveDestination([0, { name: 'Fit' }], null), /PDF/);
  for (const dest of [null, undefined, [], [0], {}, 'missing-name', 'https://example.com/other.pdf#page=2']) {
    await assert.rejects(resolveDestination(dest, fakePdf()), /位置/);
  }
  await assert.rejects(resolveDestination([0, { name: 'Launch' }], fakePdf()), /定位类型/);
  await assert.rejects(resolveDestination([0, { name: 'UnexpectedMode' }], fakePdf()), /定位类型/);
});

test('out-of-range pages and failed PDF reference resolution reject instead of producing bookmarks', async () => {
  const pdf = fakePdf({ numPages: 3 });
  for (const index of [-1, 3, 100]) await assert.rejects(resolveDestination([index, { name: 'Fit' }], pdf), /页码/);
  await assert.rejects(resolveDestination([{ num: 999, gen: 0 }, { name: 'Fit' }], pdf), /Unknown PDF page reference/);
});

test('flattened outline preserves hierarchy while skipping external/actions and keeping internal descendants', () => {
  const input = [{ title: '  第一章\n 基础 ', dest: [0, { name: 'Fit' }], items: [
    { title: '外部资料', dest: 'external', url: 'https://example.com', items: [{ title: '内部小节', dest: 'internal' }] },
    { title: '不安全链接', dest: 'unsafe', unsafeUrl: 'file:///tmp/target' },
    { title: '启动操作', dest: 'launch', action: 'NextPage' },
    { title: '无位置父节点', items: [{ title: '', dest: [4, { name: 'FitH' }, 80] }] },
  ] }];
  const snapshot = structuredClone(input);
  const flattened = flattenOutline(input);
  assert.deepEqual(flattened.map(({ title, trail, dest }) => ({ title, trail, dest })), [
    { title: '第一章 基础', trail: ['第一章 基础'], dest: [0, { name: 'Fit' }] },
    { title: '内部小节', trail: ['第一章 基础', '外部资料', '内部小节'], dest: 'internal' },
    { title: '未命名章节', trail: ['第一章 基础', '无位置父节点', '未命名章节'], dest: [4, { name: 'FitH' }, 80] },
  ]);
  assert.deepEqual(input, snapshot, 'reading the outline must not mutate the PDF outline tree');
  assert.deepEqual(flattenOutline(null), []);
  assert.deepEqual(flattenOutline([null, undefined, 1]), []);
});

test('native add/save creates one PDF root and a per-file group with accurate stored precision', () => {
  const native = fakeNative();
  const pos = location('教材/系统架构.pdf', '#page=27&offset=12.375,188.8125,1.2345');
  const result = upsertBookmark(native, pos, '  第 3 章\n重点 ', 123);
  assert.equal(result.reused, false);
  assert.deepEqual(native.calls.map(call => call.method), ['addItem', 'addItem', 'addItem']);
  assert.deepEqual(native.saved, [{
    type: 'group', title: 'PDF 位置', pdfLocationRoot: true, ctime: 123, items: [{
      type: 'group', title: '系统架构', pdfPath: pos.path, ctime: 123, items: [{
        type: 'file', path: pos.path, subpath: pos.subpath, title: '第 3 章 重点', ctime: 123,
      }],
    }],
  }]);
});

test('selection color and query order do not create duplicates; changing text range does', () => {
  const native = fakeNative();
  const first = upsertBookmark(native, location(undefined, '#page=27&selection=1,2,3,4&color=yellow'), '旧标题', 10);
  const next = upsertBookmark(native, location(undefined, '#color=green&selection=1,2,3,4&page=27'), '新标题', 20);
  assert.equal(next.reused, true);
  assert.equal(next.item, first.item);
  assert.equal(first.item.title, '新标题');
  assert.equal(first.item.ctime, 10);
  assert.equal(first.item.subpath, '#page=27&selection=1,2,3,4&color=yellow');
  assert.equal(native.calls.at(-1).method, 'editItem');
  assert.equal(native.saved[0].items[0].items.length, 1);
  assert.equal(native.saved[0].items[0].items[0].title, '新标题');
  assert.equal(upsertBookmark(native, location(undefined, '#page=27&selection=1,2,3,5'), '另一段').reused, false);
});

test('offset precision differences reuse the location but preserve the original precise subpath', () => {
  const native = fakeNative();
  const original = '#page=27&offset=18.24,400.26,1.234';
  const first = upsertBookmark(native, location(undefined, original), '原位置', 50);
  const next = upsertBookmark(native, location(undefined, '#page=27&offset=18,400,1.23&color=red'), '再命名', 60);
  assert.equal(next.reused, true);
  assert.equal(next.item, first.item);
  assert.equal(next.item.subpath, original);
  assert.equal(native.saved[0].items[0].items.length, 1);
  assert.equal(upsertBookmark(native, location(undefined, '#page=27&offset=19,400,1.23'), '另一处').reused, false);
  assert.equal(canonicalPosition('a.pdf', '#page=2&offset=,401,'), canonicalPosition('a.pdf', '#page=2&offset=,401,0'));
});

test('a stale pdfPath marker still reuses the group whose member path matches', () => {
  const native = fakeNative([{ type: 'group', title: 'PDF 位置', items: [{
    type: 'group', title: '用户改过的分组名', pdfPath: '旧目录/旧名字.pdf', items: [
      { type: 'file', path: '新目录/新名字.pdf', subpath: '#page=1', title: '第一页', ctime: 1 },
    ],
  }] }]);
  const result = upsertBookmark(native, location('新目录/新名字.pdf', '#page=5'), '第五页', 100);
  assert.equal(result.reused, false);
  assert.equal(native.saved[0].items.length, 1);
  assert.equal(native.saved[0].items[0].title, '用户改过的分组名');
  assert.equal(native.saved[0].items[0].items.length, 2);
  assert.deepEqual(native.calls.map(call => call.method), ['editItem', 'addItem']);
});

test('reusing a moved PDF old path creates a different group instead of trusting stale pdfPath', () => {
  const native = fakeNative([{ type: 'group', title: 'PDF 位置', pdfLocationRoot: true, items: [{
    type: 'group', title: 'Reading', pdfPath: 'old/Reading.pdf', items: [
      { type: 'file', path: 'moved/Reading.pdf', subpath: '#page=1', title: '原文位置' },
    ],
  }] }]);
  upsertBookmark(native, location('old/Reading.pdf', '#page=2'), '旧路径里的新 PDF');
  upsertBookmark(native, location('moved/Reading.pdf', '#page=3'), '移走的原 PDF');
  const groups = native.items[0].items;
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].items.map(item => item.path), ['moved/Reading.pdf', 'moved/Reading.pdf']);
  assert.deepEqual(groups[1].items.map(item => item.path), ['old/Reading.pdf']);
  assert.deepEqual(native.saved, native.items);
});

test('renamed root stays the destination for future PDF positions', () => {
  const native = fakeNative();
  upsertBookmark(native, location('教材/甲.pdf', '#page=2'), '甲');
  native.items[0].title = '我的原文定位';
  upsertBookmark(native, location('教材/乙.pdf', '#page=3'), '乙');
  assert.equal(native.items.length, 1);
  assert.equal(native.items[0].title, '我的原文定位');
  assert.equal(native.items[0].items.length, 2);
});

test('unrelated native bookmarks remain unchanged when adding a PDF position', () => {
  const existing = [
    { type: 'file', path: '日记/今日.md', title: '今日安排', ctime: 1 },
    { type: 'search', query: 'tag:#错题', title: '我的搜索', ctime: 2 },
    { type: 'group', title: '资料', items: [{ type: 'file', path: '其他/教材.pdf', subpath: '#page=9', title: '其他教材' }] },
  ];
  const native = fakeNative(existing);
  upsertBookmark(native, location(), '新位置', 10);
  assert.deepEqual(native.saved.slice(0, 3), existing);
});

test('an existing nested native bookmark updates in place without moving its group or touching neighbors', () => {
  const original = { type: 'file', path: '教材/系统架构.pdf', subpath: '#page=27', title: '旧标题', ctime: 1 };
  const neighbor = { type: 'file', path: '教材/系统架构.pdf', subpath: '#page=28', title: '保留标题', ctime: 2 };
  const native = fakeNative([{ type: 'group', title: '自定义收藏', items: [original, neighbor] }]);
  const result = upsertBookmark(native, location(), '更新标题', 99);
  assert.equal(result.reused, true);
  assert.deepEqual(native.saved, [{ type: 'group', title: '自定义收藏', items: [{ ...original, title: '更新标题' }, neighbor] }]);
  assert.deepEqual(native.calls.map(call => call.method), ['editItem']);
  assert.equal(findPosition(native.items, original.path, original.subpath), result.item);
});

test('same basename in different paths receives independent PDF groups and positions', () => {
  const native = fakeNative();
  const a = upsertBookmark(native, location('教材一/架构.pdf', '#page=3'), 'A', 1);
  const b = upsertBookmark(native, location('教材二/架构.pdf', '#page=3'), 'B', 2);
  assert.equal(a.reused, false);
  assert.equal(b.reused, false);
  assert.equal(native.saved[0].items.length, 2);
  assert.deepEqual(native.saved[0].items.map(group => group.title), ['架构', '架构 · 教材二']);
  assert.deepEqual(native.saved[0].items.map(group => group.items[0].path), ['教材一/架构.pdf', '教材二/架构.pdf']);
  assert.notEqual(canonicalPosition(a.item.path, a.item.subpath), canonicalPosition(b.item.path, b.item.subpath));
  assert.equal(upsertBookmark(native, location('教材二/架构.pdf', '#page=3'), 'B 更新', 3).item, b.item);
  assert.equal(a.item.title, 'A');
});

test('missing native API, empty title and invalid location do not mutate saved bookmarks', () => {
  assert.throws(() => upsertBookmark(null, location(), '标题'), /核心插件/);
  const native = fakeNative([{ type: 'file', path: 'existing.md' }]);
  const before = structuredClone(native.saved);
  assert.throws(() => upsertBookmark(native, location(), ' \n '), /标题/);
  assert.throws(() => upsertBookmark(native, location(undefined, '#page=0'), '标题'), /页码/);
  assert.deepEqual(native.saved, before);
  assert.deepEqual(native.calls, []);
});

test('missing persistence API rejects before creating any bookmark', async () => {
  const native = fakeNative([{ type: 'file', path: 'existing.md' }]);
  delete native.saveData;
  await assert.rejects(saveBookmark(native, location(), '标题'), /无法保存/);
  assert.deepEqual(native.items, [{ type: 'file', path: 'existing.md' }]);
  assert.deepEqual(native.calls, []);
});

test('save completion waits for asynchronous native persistence and blocks duplicate submissions', async () => {
  const native = fakeNative();
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  native.saveData = () => waiting;
  const originalSave = native.saveData;
  let completed = false;
  const operation = saveBookmark(native, location(), '等磁盘写完').then(result => { completed = true; return result; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(native.saveData, originalSave, 'the native save method is restored before waiting');
  await assert.rejects(saveBookmark(native, location(), '重复点击'), /还在保存/);
  finish();
  const result = await operation;
  assert.equal(completed, true);
  assert.equal(result.item.title, '等磁盘写完');
  assert.equal(native.items[0].items[0].items.length, 1);
});

test('the final snapshot follows reverse-completing automatic saves and remains the last disk write', async () => {
  const native = fakeNative();
  const writes = [];
  native.saveData = function () {
    const snapshot = structuredClone(this.items);
    return new Promise(resolve => {
      writes.push(() => { this.saved = snapshot; resolve(); });
    });
  };
  let completed = false;
  const operation = saveBookmark(native, location(), '完整书签').then(result => { completed = true; return result; });
  assert.equal(writes.length, 3, 'the final fourth write must not race automatic writes');
  writes[2](); writes[1](); writes[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 4);
  assert.equal(completed, false);
  assert.equal(native.saved[0].items.length, 0, 'the oldest intermediate snapshot finished last');
  writes[3]();
  await operation;
  assert.equal(completed, true);
  assert.deepEqual(native.saved, native.items);
  assert.equal(native.saved[0].items[0].items[0].title, '完整书签');
});

test('failed automatic saves skip the final write and revert new groups without touching unrelated bookmarks', async () => {
  const existing = [{ type: 'file', path: 'existing.md', title: '已有笔记' }];
  const native = fakeNative(existing);
  let saves = 0;
  native.saveData = function () {
    saves += 1;
    if (saves <= 3) return Promise.reject(new Error('Disk unavailable'));
    this.saved = structuredClone(this.items);
    return Promise.resolve();
  };
  await assert.rejects(saveBookmark(native, location(), '新书签'), /未保存成功/);
  assert.equal(saves, 4, 'only the three automatic writes and one rollback write run');
  assert.deepEqual(native.items, existing);
  assert.deepEqual(native.saved, existing);
});

test('a failed final snapshot write also rolls back and persists the original bookmarks', async () => {
  const existing = [{ type: 'file', path: 'existing.md', title: '已有笔记' }];
  const native = fakeNative(existing);
  let saves = 0;
  native.saveData = function () {
    if (++saves === 4) return Promise.reject(new Error('Final write failed'));
    this.saved = structuredClone(this.items); return Promise.resolve();
  };
  await assert.rejects(saveBookmark(native, location(), '新书签'), /未保存成功/);
  assert.equal(saves, 5);
  assert.deepEqual(native.items, existing);
  assert.deepEqual(native.saved, existing);
});

test('rollback preserves a different bookmark added while a save was pending', async () => {
  const native = fakeNative();
  let rejectSave;
  const waiting = new Promise((_, reject) => { rejectSave = reject; });
  let saves = 0;
  native.saveData = function () {
    saves += 1;
    if (saves <= 3) return waiting;
    this.saved = structuredClone(this.items);
    return Promise.resolve();
  };
  const operation = saveBookmark(native, location(), '将失败的书签');
  const other = { type: 'file', path: 'another-note.md', title: '另一处编辑' };
  native.items.push(other);
  rejectSave(new Error('Write failed'));
  await assert.rejects(operation, /未保存成功/);
  assert.deepEqual(native.items, [other]);
  assert.deepEqual(native.saved, [other]);
});

test('a failed rename restores its title without undoing a later user rename', async () => {
  for (const laterRename of [false, true]) {
    const original = { type: 'file', path: '教材/系统架构.pdf', subpath: '#page=27', title: '旧标题' };
    const native = fakeNative([original]);
    let rejectSave;
    const waiting = new Promise((_, reject) => { rejectSave = reject; });
    let saves = 0;
    native.saveData = function () {
      if (++saves <= 1) return waiting;
      this.saved = structuredClone(this.items); return Promise.resolve();
    };
    const operation = saveBookmark(native, location(), '本次标题');
    if (laterRename) native.items[0].title = '用户随后改的标题';
    rejectSave(new Error('Write failed'));
    await assert.rejects(operation, /未保存成功/);
    assert.equal(native.items[0].title, laterRename ? '用户随后改的标题' : '旧标题');
    assert.deepEqual(native.items, native.saved);
  }
});

test('failed rollback persistence reports uncertainty but still restores in-memory data', async () => {
  const native = fakeNative();
  native.saveData = () => Promise.reject(new Error('Disk unavailable'));
  await assert.rejects(saveBookmark(native, location(), '标题'), /回退结果也未能写入磁盘/);
  assert.deepEqual(native.items, []);
});
