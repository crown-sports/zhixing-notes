'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseNote, summarize, filterRecords } = require('./data');
const note = (title, body, category = '概念') => `---\ncreated: 2026-10-22\ncategory: ${category}\n---\n# ${title}\n\n#flashcards/review\n\n${body}`;

test('ordinary note cards work without a vault or external plugin', () => {
  const result = parseNote('回顾/学习.md', note('主动回忆', '为什么先回忆再看答案？\n?\n先独立提取知识，再检查遗漏。'));
  assert.equal(result.cardCount, 1);
  assert.equal(result.needsRepair, false);
  assert.equal(result.category, '概念');
  assert.equal(result.created, '2026-10-22');
  assert.equal(result.diagnosis, '');
  assert.equal(result.memoryReady, false);
});

test('topic-only answers and capture placeholders cannot masquerade as ready cards', () => {
  for (const answer of ['主动回忆', '待填写', '请输入答案']) {
    const result = parseNote('学习.md', note('主动回忆', `![[示例.png]]\n这题的正确答案或关键判断是什么？\n?\n${answer}`));
    assert.equal(result.needsRepair, true);
    assert.equal(result.cardCount, 0);
    assert.equal(summarize([result], '2026-10-22').pendingCount, 0);
  }
});

test('inline and multiline cards preserve schedules while hiding metadata from display', () => {
  const source = note('复习方法', '复习前先做什么？::先回忆。 <!--SR:!2026-10-22,3,250-->\n\n### 另一张卡\n回忆之后再做什么？\n?\n核对答案并修正。\n<!--SR:!2026-10-25,3,250-->');
  const result = parseNote('方法.md', source);
  assert.deepEqual(result.cards.map(card => card.due), ['2026-10-22', '2026-10-25']);
  assert.equal(result.dueDate, '2026-10-22');
  assert.ok(!JSON.stringify(result).includes('<!--SR:'));
  assert.equal(summarize([result], '2026-10-21').pendingCount, 0);
  assert.equal(summarize([result], '2026-10-22').pendingCount, 1);
});

test('custom topics, search and due filters compose without mutating notes', () => {
  const reading = parseNote('阅读.md', note('阅读方法', '阅读后如何检查理解？::用自己的话解释。 <!--SR:!2026-10-22,3,250-->', '读书'));
  const practice = parseNote('实践.md', note('编程练习', '如何检查程序边界？::用空输入和边界值测试。', '编程'));
  const before = JSON.stringify([reading, practice]);
  assert.deepEqual(filterRecords([reading, practice], { category: '读书', query: '自己的话' }), [reading]);
  assert.deepEqual(filterRecords([reading, practice], { filter: 'due', today: '2026-10-22' }), [reading]);
  assert.equal(summarize([reading, practice], '2026-10-22').categoryCounts.编程, 1);
  assert.equal(JSON.stringify([reading, practice]), before);
});

test('new and due cards count each note once, future cards remain available to self-test', () => {
  const mixed = parseNote('混合.md', note('混合练习', '今天先回忆什么？::昨天的结论。 <!--SR:!2026-10-22,3,250-->\n\n下一步检查什么？::遗漏的条件。'));
  const future = parseNote('未来.md', note('未来练习', '之后如何检查理解？::换一个例子解释。 <!--SR:!2026-10-25,3,250-->'));
  const stats = summarize([mixed, future], '2026-10-22');
  assert.equal(stats.ready, 2); assert.equal(stats.pendingCount, 1); assert.equal(stats.newCount, 1);
  assert.deepEqual(filterRecords([mixed, future], { filter: 'ready' }), [mixed, future]);
  assert.deepEqual(filterRecords([mixed, future], { filter: 'pending', today: '2026-10-22' }), [mixed]);
});

test('a personal analysis is not a substitute for an incomplete answer card', () => {
  const body = '为什么需要反馈？\n?\n待填写\n\n## 回顾分析\n\n### 正确判断\n\n反馈帮助修正误解。\n\n### 为什么会错\n\n只记住了结论，没有检查条件。';
  const result = parseNote('反馈.md', note('反馈', body));
  assert.equal(result.annotation.correct, '反馈帮助修正误解。');
  assert.equal(result.analysisReady, true);
  assert.equal(result.needsRepair, true);
});

test('a source URL without a real question stays incomplete', () => {
  const result = parseNote('链接.md', note('外部资料', 'https://example.invalid/article\n?\n这篇文章介绍了一种复习方法。'));
  assert.equal(result.needsRepair, true);
  assert.equal(result.sourceAvailable, false);
});

test('completeness checking does not claim to fact-check the answer', () => {
  const result = parseNote('示例.md', note('算术例子', '二加二等于多少？\n?\n五。'));
  assert.equal(result.needsRepair, false);
  assert.deepEqual(result.contentWarnings, []);
  assert.ok(!Object.hasOwn(summarize([result], '2026-10-22'), 'accuracy'));
});
