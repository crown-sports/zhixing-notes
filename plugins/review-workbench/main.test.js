'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const data = require('./data');
class TFile { constructor(path, content) { this.path = path; this.content = content; } }
class TFolder { constructor(path) { this.path = path; } }
const context = {
  module: { exports: {} },
  require(name) {
    if (name === './data') return data;
    if (name === 'obsidian') return { Plugin: class {}, ItemView: class {}, Modal: class {}, PluginSettingTab: class {}, TFile, TFolder };
    throw new Error('Unexpected require ' + name);
  },
  Intl, Date, console
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'main.src.js'), 'utf8') + '\nmodule.exports = { annotationBlock, buildAnnotation, updateAnnotation, normalizeFolder, buildReviewNote, createReviewNote, today };', context);
const { annotationBlock, buildAnnotation, updateAnnotation, normalizeFolder, buildReviewNote, createReviewNote, today } = context.module.exports;
const values = { title: '主动回忆', category: '读书', question: '为什么先回忆再核对？', answer: '先独立提取，再检查遗漏。' };

function fakeVault() {
  const files = new Map();
  return { files, getAbstractFileByPath: path => files.get(path),
    async createFolder(path) { if (files.has(path)) throw new Error('Already exists'); files.set(path, new TFolder(path)); },
    async create(path, content) { if (files.has(path)) throw new Error('Refuse overwrite'); const file = new TFile(path, content); files.set(path, file); return file; }
  };
}

test('CRLF analysis updates preserve other sections and never append a second analysis', () => {
  const original = '# 原始卡片\r\n\r\n问题是什么？\r\n?\r\n具体答案。\r\n<!--SR:!2026-10-25,7,250-->\r\n\r\n## 回顾分析\r\n\r\n### 正确判断\r\n\r\nold\r\n\r\n## 来源\r\n\r\nkeep';
  const first = updateAnnotation(original, annotationBlock(original), { correct: 'new', diagnosis: 'misunderstood a condition' });
  const second = updateAnnotation(first, annotationBlock(first), { correct: 'latest', diagnosis: 'fixed' });
  assert.equal((second.match(/^## 回顾分析/gm) || []).length, 1);
  assert.ok(second.includes('## 来源\r\n\r\nkeep'));
  assert.ok(second.includes('<!--SR:!2026-10-25,7,250-->'));
  assert.equal(data.parseNote('test.md', second).annotation.correct, 'latest');
});

test('an analysis changed since opening is not overwritten; unrelated edits are preserved', () => {
  const original = '# Note\n\n## 回顾分析\n\n### 正确判断\n\nold\n\n## 来源\n\nsource';
  const initial = annotationBlock(original);
  assert.throws(() => updateAnnotation(original.replace('old', 'someone else edited'), initial, { correct: 'mine' }), /避免覆盖/);
  const updated = updateAnnotation(original.replace('source', 'new source'), initial, { correct: 'mine', diagnosis: 'reason' });
  assert.ok(updated.includes('new source'));
});

test('legacy analysis section migrates once and entered headings cannot escape it', () => {
  const original = '# Note\n\n## 错题分析\n\n### 正确判断\n\nold\n';
  const next = updateAnnotation(original, annotationBlock(original), { correct: '## A heading\nanswer', diagnosis: '# Reason', memory: '### Hint' });
  assert.equal((next.match(/^## /gm) || []).length, 1);
  assert.ok(next.includes('#### A heading'));
  assert.ok(next.includes('## 回顾分析'));
});

test('replacement metacharacters in an analysis stay literal', () => {
  const original = '# Note\n\n## 回顾分析\n\n### 关键理解\n\nold\n\n## 来源\n\nkeep';
  const literal = "Use $& and $' and $` literally.";
  const result = updateAnnotation(original, annotationBlock(original), { correct: literal, diagnosis: 'regular expression syntax' });
  assert.equal(data.parseNote('syntax.md', result).annotation.correct, literal);
  assert.equal((result.match(/^## 回顾分析/gm) || []).length, 1);
});

test('analysis-like headings inside fenced examples never replace the example or following prose', () => {
  for (const fence of ['```md', '~~~~markdown']) {
    const close = fence.startsWith('`') ? '```' : '~~~~';
    const original = `# Note\n\n${fence}\n## 回顾分析\n\n### 关键理解\n\n代码示例\n${close}\n\n普通正文。\n`;
    assert.equal(annotationBlock(original), '');
    assert.equal(data.parseNote('example.md', original).annotation.correct, '');
    const result = updateAnnotation(original, '', { correct: '新理解。', diagnosis: '漏看条件。' });
    assert.ok(result.startsWith(original));
    assert.equal(data.parseNote('example.md', result).annotation.correct, '新理解。');
  }
});

test('real analysis after an identical code example is updated by offset and fenced field text survives', () => {
  const block = '## 回顾分析\n\n### 关键理解\n\n原理解。\n\n';
  const prefix = '# Note\n\n```md\n' + block + '```\n\n正文不能丢。\n\n';
  const original = prefix + block + '## 来源\n\n文档A';
  const code = '示例：\n```md\n## 示例标题\n### 自定义标题\n```\n后续解释。';
  const result = updateAnnotation(original, annotationBlock(original), { correct: code, diagnosis: '漏看条件。' });
  assert.ok(result.startsWith(prefix));
  assert.ok(result.endsWith('## 来源\n\n文档A'));
  assert.equal(data.parseNote('example.md', result).annotation.correct, code);
  const again = updateAnnotation(result, annotationBlock(result), data.parseNote('example.md', result).annotation);
  assert.equal(data.parseNote('example.md', again).annotation.correct, code);
});

test('handwritten preambles and unknown analysis fields are rejected without changing source', () => {
  for (const extra of ['手写前言。\n\n### 关键理解\n\n已知内容。', '### 关键理解\n\n已知内容。\n\n### 我自己的证据\n\n引用。']) {
    const original = '# Note\n\n## 回顾分析\n\n' + extra + '\n\n## 来源\n\n文档A';
    assert.throws(() => updateAnnotation(original, annotationBlock(original), { correct: '新理解', diagnosis: '新原因' }), /直接在笔记中编辑.*原文未修改/);
    assert.ok(original.includes(extra));
  }
});

test('duplicate sections, unsupported select values, comments and unfinished fences cannot be overwritten', () => {
  const block = '## 回顾分析\n\n### 关键理解\n\n原理解。\n\n';
  const examples = [
    block + block,
    block + '### 正确判断\n\n另一份理解。',
    '## 回顾分析\n\n### 理解难点\n\n自定义类型\n\n### 关键理解\n\n原理解。',
    block + '<!-- 手写备注 -->',
    '# Note\n\n```md\n## 回顾分析\n原文。'
  ];
  for (const original of examples) assert.throws(() => updateAnnotation(original, annotationBlock(original), { correct: '新理解' }), /原文未修改/);
  assert.throws(() => updateAnnotation('# Note', '', { correct: '```js\nconst x = 1;' }), /尚未闭合/);
});

test('analysis headings in YAML and comments are not treated as writable sections', () => {
  const original = '---\nexample: |\n  ## 回顾分析\n---\n\n<!--\n## 回顾分析\n-->\n\n正文。';
  assert.equal(annotationBlock(original), '');
  assert.ok(updateAnnotation(original, '', { correct: '实际理解。' }).startsWith(original));
});

test('folder settings reject root, traversal, hidden configuration and absolute paths', () => {
  assert.equal(normalizeFolder('  学习/回顾卡片/  '), '学习/回顾卡片');
  for (const invalid of ['', '/', '/tmp/cards', 'C:\\cards', '../cards', 'cards/../private', '.obsidian', 'cards/.hidden', 'cards//notes']) {
    assert.throws(() => normalizeFolder(invalid), undefined, invalid);
  }
});

test('new-card note is usable without QuickAdd or a scheduler', () => {
  const note = buildReviewNote(values, new Date(2026, 9, 22, 23, 59));
  const record = data.parseNote('new.md', note.content);
  assert.equal(record.cardCount, 1); assert.equal(record.needsRepair, false);
  assert.equal(record.category, '读书'); assert.equal(record.created, '2026-10-22');
  assert.equal(record.cards[0].answer, values.answer);
  assert.equal(today(new Date(2026, 9, 22, 23, 59)), '2026-10-22');
});

test('quoted titles survive the standalone parser and ambiguous card boundaries are rejected', () => {
  const note = buildReviewNote({ ...values, title: '解释 "为什么"' });
  assert.equal(data.parseNote('quoted.md', note.content).title, '解释 "为什么"');
  assert.throws(() => buildReviewNote({ ...values, answer: '先回答。\n## 另一个标题\n后半段。' }), /独立标题/);
});

test('new cards reject parser boundaries before writing any partial self-test content', async () => {
  for (const boundary of ['---', '----', '#flashcards/review', '> [!success] 提示', '详解：']) {
    const vault = fakeVault();
    await assert.rejects(createReviewNote(vault, '回顾', { ...values, answer: '先检查前置条件。\n' + boundary + '\n再排除特殊情况。' }), /会截断自测内容/);
    assert.equal(vault.files.size, 0);
    assert.throws(() => buildReviewNote({ ...values, question: '先检查哪些条件？\n' + boundary + '\n再检查哪些例外？' }), /会截断自测内容/);
  }
});

test('empty input is rejected before any folders or files are created', async () => {
  const vault = fakeVault();
  await assert.rejects(createReviewNote(vault, '回顾', { ...values, answer: '' }), /请填写/);
  assert.equal(vault.files.size, 0);
});

test('empty-vault capture creates parents and duplicate titles never overwrite a note', async () => {
  const vault = fakeVault(); const date = new Date(2026, 9, 22, 10, 20, 30);
  const first = await createReviewNote(vault, '20_笔记/回顾卡片', values, date);
  const second = await createReviewNote(vault, '20_笔记/回顾卡片', { ...values, answer: '用新的例子核对理解。' }, date);
  assert.notEqual(first.path, second.path);
  assert.equal(first.content, buildReviewNote(values, date).content);
  assert.ok(vault.files.get('20_笔记') instanceof TFolder);
  assert.ok(vault.files.get('20_笔记/回顾卡片') instanceof TFolder);
});

test('a file at the configured folder path is never replaced', async () => {
  const vault = fakeVault(); const original = new TFile('cards', 'keep'); vault.files.set('cards', original);
  await assert.rejects(createReviewNote(vault, 'cards/notes', values), /现有文件重名/);
  assert.equal(vault.files.get('cards'), original); assert.equal(vault.files.size, 1);
});

test('unsafe title characters stay inside the configured directory', async () => {
  const vault = fakeVault();
  const file = await createReviewNote(vault, 'cards', { ...values, title: '../other/path: lesson' });
  assert.equal(file.path.split('/').length, 2);
  assert.ok(file.path.startsWith('cards/'));
});
