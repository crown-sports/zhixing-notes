'use strict';

// This module deliberately uses no Obsidian APIs or clock: the view supplies today.
const CATEGORIES = ['概念', '方法', '实践', '其他'];
const ERROR_TYPES = ['概念混淆', '知识缺口', '条件遗漏', '计算步骤', '待分析'];
const GENERIC_QUESTION = /^(?:这题的正确(?:答案|结论)(?:或关键判断)?是什么[？?]?|不看答案[，,]?回答两点[：:]?)$/;
const PLACEHOLDER = /保存前.{0,20}(?:改成|填写)|待补充|待填写|在此填写|请输入(?:答案|题目)|没有选中(?:题目|回答)/;

function stripComments(text) {
  return String(text || '').replace(/<!--\s*SR:[\s\S]*?-->/gi, '').replace(/<!--[\s\S]*?-->/g, '').trim();
}

function plain(text) {
  return stripComments(text)
    .replace(/!\[\[[^\]]*\]\]/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, target, label) => label || target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s*>\s*\[![^\]]+\][-+]?\s*/gm, '')
    .replace(/^\s*[>#]+\s*/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function normalized(text) {
  return plain(text).replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}

function dateOnly(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const match = String(value || '').match(/\b(\d{4}-\d{2}-\d{2})\b/);
  return match ? match[1] : '';
}

function frontmatterOf(content) {
  const match = content.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  const values = {};
  if (match) {
    for (const line of match[1].split(/\r?\n/)) {
      const pair = line.match(/^([^\s:#][^:]*):\s*(.*?)\s*$/);
      if (pair) {
        let value = pair[2].replace(/^(['"])(.*)\1$/, '$2');
        if (pair[2].startsWith('"')) { try { value = JSON.parse(pair[2]); } catch (_) { /* Incomplete YAML stays plain text. */ } }
        values[pair[1].trim()] = value;
      }
    }
  }
  return { body: match ? content.slice(match[0].length) : content, values };
}

// Keep offsets in the original string so a form never replaces a matching
// heading example inside a fenced code block. This is a bounded ATX scanner,
// not a general Markdown parser; callers reject unfinished fences on writes.
function scanMarkdown(body) {
  const headings = [];
  let fence = null;
  let comment = false;
  const frontmatter = body.match(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  const start = frontmatter ? frontmatter[0].length : 0;
  for (const match of body.slice(start).matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) continue;
    const index = start + match.index;
    const line = match[0].replace(/\r?\n$/, '');
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      continue;
    }
    const insideComment = comment;
    for (const marker of line.matchAll(/<!--|-->/g)) comment = marker[0] === '<!--';
    if (insideComment || line.includes('<!--')) continue;
    const open = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (open && (open[1][0] !== '`' || !open[2].includes('`'))) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }
    const heading = line.match(/^( {0,3})(#{1,6})[ \t]+(.+?)\s*$/);
    if (heading) headings.push({ index, end: index + match[0].length,
      marker: index + heading[1].length, level: heading[2].length,
      title: heading[3].replace(/[ \t]+#+[ \t]*$/, '').trim() });
  }
  return { headings, unfinished: Boolean(fence || comment) };
}

function sectionsOf(body) {
  const { headings } = scanMarkdown(body);
  return headings.map((heading, index) => {
    let end = body.length;
    for (let i = index + 1; i < headings.length; i++) {
      if (headings[i].level <= heading.level) { end = headings[i].index; break; }
    }
    return { title: plain(heading.title), level: heading.level, text: body.slice(heading.end, end).trim() };
  });
}

function firstSection(sections, pattern) {
  return sections.find(section => pattern.test(section.title))?.text || '';
}

function stripBoilerplate(text) {
  return stripComments(text)
    .replace(/^#flashcards(?:\/[^\s]+)?\s*$/gm, '')
    .replace(/(^|\n)>\s*\[!(?:success|source|warning)\][-+]?[^\n]*(?:\n>[^\n]*)*/g, '$1')
    .replace(/^>\s*\[!example\][-+]?[^\n]*(?:\n>[^\n]*)*/gm, '')
    .replace(/^>\s*\[!question\][-+]?[^\n]*\n?/gm, '')
    .replace(/【保存前改成一句问题[：:]([^】]+)】/g, '$1')
    .replace(/^\s*\[\[.*(?:返回回顾目录|回顾工作台).*\]\].*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}

function imagePathsOf(body) {
  const paths = [];
  for (const match of body.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|!\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g)) {
    const path = (match[1] || match[2] || match[3] || '').split('#')[0].trim();
    if (path && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

function scheduleOf(text) {
  const comments = [...String(text).matchAll(/<!--\s*SR:([\s\S]*?)-->/gi)];
  const dates = comments.flatMap(match => [...match[1].matchAll(/!(\d{4}-\d{2}-\d{2}),/g)].map(date => date[1])).sort();
  return dates[0] || null;
}

function isPlaceholder(answer, title) {
  const text = plain(answer).replace(/^(?:一句(?:话)?答案|答案|正确答案)[：:]\s*/, '');
  if (!text || PLACEHOLDER.test(text)) return true;
  // The old capture template copied the subject into the answer field, sometimes
  // with the filename truncated by a few characters. That is not a completed card.
  const answerKey = normalized(text);
  const titleKey = normalized(title);
  return answerKey === titleKey || (titleKey.length > 8 && answerKey.startsWith(titleKey) && answerKey.length - titleKey.length <= 5);
}

function extractCards(body, title) {
  const lines = body.split(/\r?\n/);
  const candidates = [];
  let regionStart = 0;
  let consumedThrough = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^#{1,6}\s/.test(line) || /^#flashcards(?:\/|$)/.test(line) || /^\s*---+\s*$/.test(line)) {
      regionStart = index + 1;
      continue;
    }
    if (index <= consumedThrough) continue;
    const inline = line.match(/^\s*(.+?)\s*:{2,3}\s*(.+)$/);
    if (inline && !/^\s*>/.test(line) && !line.includes('://')) {
      const following = /^\s*<!--\s*SR:/.test(lines[index + 1] || '') ? lines[index + 1] : '';
      candidates.push({ question: stripBoilerplate(inline[1]), answer: stripBoilerplate(inline[2]), due: scheduleOf(line + '\n' + following) });
      regionStart = index + 1;
      continue;
    }
    if (!/^\s*\?\??\s*$/.test(line)) continue;
    let end = index + 1;
    while (end < lines.length) {
      if (/^#{1,6}\s/.test(lines[end]) || /^#flashcards(?:\/|$)/.test(lines[end]) || /^\s*---+\s*$/.test(lines[end])) break;
      if (/^\s*>\s*\[!(?:success|source|warning|example)\]/.test(lines[end])) break;
      if (/^\s*详解(?:与图示)?[：:]/.test(lines[end])) break;
      // A subsequent unheaded card starts at its own paragraph.
      if (/^\s*\?\??\s*$/.test(lines[end])) {
        let nextStart = end - 1;
        while (nextStart > index + 1 && lines[nextStart - 1].trim()) nextStart--;
        end = nextStart;
        break;
      }
      end++;
    }
    const question = stripBoilerplate(lines.slice(regionStart, index).join('\n'));
    const answerRaw = lines.slice(index + 1, end).join('\n');
    const answer = stripBoilerplate(answerRaw);
    candidates.push({ question, answer, due: scheduleOf(answerRaw) });
    consumedThrough = end - 1;
    regionStart = end;
  }
  return {
    candidates,
    cards: candidates.filter(card => !isPlaceholder(card.answer, title) && (imagePathsOf(card.question).length || hasRealQuestion(card.question)))
  };
}

function hasRealQuestion(text) {
  const cleaned = plain(text).replace(/#[^\s]+/g, '').trim();
  return cleaned.length >= 4 && !GENERIC_QUESTION.test(cleaned) && !PLACEHOLDER.test(cleaned) && !/^https?:\/\//.test(cleaned);
}

function annotationOf(sections) {
  const block = firstSection(sections, /^(?:回顾|错题)分析$/);
  const fields = sectionsOf(block);
  const get = pattern => stripComments(firstSection(fields, pattern));
  return {
    errorType: plain(get(/^(?:理解难点|错因类型)$/)),
    attempt: get(/^(?:之前的理解|我的误选或思路)$/),
    correct: get(/^(?:关键理解|正确判断)$/),
    diagnosis: get(/^(?:疑点与原因|为什么会错)$/),
    memory: get(/^记忆方法$/),
    check: get(/^下次检查$/)
  };
}

function parseNote(path, content, frontmatter = {}) {
  content = String(content || '').replace(/\r\n/g, '\n');
  const parsed = frontmatterOf(content);
  const meta = { ...parsed.values, ...frontmatter };
  const body = parsed.body;
  const sections = sectionsOf(body);
  const firstHeading = sections.find(section => section.level === 1)?.title;
  const filename = String(path).split('/').pop().replace(/\.md$/i, '');
  const title = plain(meta.title || firstHeading || filename)
    .replace(/^(?:网页错题|截图错题|文字错题|ChatGPT\s*复习)\s*[·・：:]\s*/, '')
    .replace(/^\d{4}-\d{2}-\d{2}-(?:\d{6}-)?/, '').trim();
  const categoryMatch = body.match(/#flashcards\/(?:review|回顾)\/([^\s/#]+)/);
  const category = plain(meta.category || categoryMatch?.[1] || '其他').slice(0, 40) || '其他';
  const imagePaths = imagePathsOf(body);
  const { cards, candidates } = extractCards(body, title);
  const annotation = annotationOf(sections);
  const sourceSection = firstSection(sections, /^(?:原题与这次的错误|原题|题目|题干)$/);
  const firstQuestion = candidates[0]?.question || sourceSection;
  const questionText = stripBoilerplate(sourceSection || firstQuestion);
  const sourceAvailable = imagePaths.length > 0 || hasRealQuestion(questionText);
  const answerReady = candidates.length > 0 && candidates.every(card => !isPlaceholder(card.answer, title));
  const explanationText = stripComments(firstSection(sections, /^(?:用.+理解|讲解|详细解析|题目解析|答案解析|解析)$/));
  const originalDiagnosis = body.match(/(?:本次错因判断|错因分析|错因)[：:]\s*([^\n]+)/)?.[1]?.trim() || '';
  const diagnosis = annotation.diagnosis || originalDiagnosis;
  const diagnosisTentative = Boolean(!annotation.diagnosis && originalDiagnosis && /本次错因判断[：:]/.test(body));
  const legacyMemorySection = sections.find(section => /^(?:记忆方法|记忆口诀|记忆技巧)$/.test(section.title) && section.level === 2)?.text || '';
  const memoryLines = body.split('\n').filter(line => /(?:记忆链|记忆字|口语化回忆|口诀)[：:]/.test(line));
  const memory = annotation.memory || stripComments(legacyMemorySection.split(/\n(?:本次错因判断|错因分析)[：:]/)[0]) || stripComments(memoryLines.join('\n\n'));
  const explicitError = annotation.errorType || meta.错因类型 || meta.errorType;
  let errorType = ERROR_TYPES.includes(explicitError) ? explicitError : '待分析';
  if (errorType === '待分析' && diagnosis) {
    if (/混淆|相近词|分不清|概念不清/.test(diagnosis)) errorType = '概念混淆';
    else if (/漏(?:掉|看|读|了)|忽略|条件/.test(diagnosis)) errorType = '条件遗漏';
    else if (/计算|公式|运算|步骤/.test(diagnosis)) errorType = '计算步骤';
    else if (/不(?:知道|会|熟悉)|知识缺|没学|忘(?:记|了)/.test(diagnosis)) errorType = '知识缺口';
  }
  const analysisReady = Boolean(annotation.diagnosis || explanationText || originalDiagnosis);
  const memoryReady = Boolean(plain(memory) && !PLACEHOLDER.test(plain(memory)));
  const repairReasons = [];
  if (!sourceAvailable) repairReasons.push('缺少题干或原图');
  if (!candidates.length) repairReasons.push('尚未整理为问答卡');
  else if (!answerReady) repairReasons.push('答案仍是主题或占位文字');
  if (candidates.length && candidates.some(card => !imagePathsOf(card.question).length && !hasRealQuestion(card.question))) {
    // A shared original image is a valid question for screenshot cards.
    if (!imagePaths.length) repairReasons.push('回忆问题还不明确');
  }
  // A screenshot outside a card can provide its question, as with saved note sections.
  if (imagePaths.length && !cards.length && answerReady) {
    for (const card of candidates) cards.push({ ...card, question: card.question || `![[${imagePaths[0]}]]` });
  }
  const contentWarnings = []; // Completeness checks do not verify factual correctness.
  const needsRepair = repairReasons.length > 0;
  const dueDates = cards.map(card => card.due).filter(Boolean).sort();
  return {
    path, title, created: dateOnly(meta.创建日期 || meta.created || filename), category,
    cardCount: cards.length, cards,
    hasImage: imagePaths.length > 0, imagePaths,
    answerReady, analysisReady, memoryReady, needsRepair, repairReasons, contentWarnings,
    status: needsRepair ? '待完善' : dueDates.length ? '复习中' : '待复习',
    errorType, diagnosis, diagnosisTentative, memory,
    correctAnswer: annotation.correct || cards.map(card => card.answer).join('\n\n'),
    sourceText: stripBoilerplate(body), analysisText: explanationText || diagnosis,
    explanationText, sourceAvailable, questionText, annotation,
    dueDate: dueDates[0] || null,
    newCardCount: cards.filter(card => !card.due).length
  };
}

function summarize(records, today) {
  const validToday = dateOnly(today);
  const readyRecords = records.filter(record => !record.needsRepair && record.cardCount > 0);
  const isDue = card => Boolean(validToday && card.due && card.due <= validToday);
  const categoryCounts = Object.fromEntries(CATEGORIES.map(category => [category, 0]));
  const errorCounts = Object.fromEntries(ERROR_TYPES.map(type => [type, 0]));
  for (const record of records) {
    categoryCounts[record.category] = (categoryCounts[record.category] || 0) + 1;
    errorCounts[record.errorType in errorCounts ? record.errorType : '待分析']++;
  }
  return {
    total: records.length,
    ready: readyRecords.length,
    needsRepair: records.filter(record => record.needsRepair).length,
    due: readyRecords.filter(record => record.cards.some(isDue)).length,
    newCount: readyRecords.filter(record => record.cards.some(card => !card.due)).length,
    pendingCount: readyRecords.filter(record => record.cards.some(card => !card.due || isDue(card))).length,
    cardCount: records.reduce((total, record) => total + record.cardCount, 0),
    dueCardCount: readyRecords.reduce((total, record) => total + record.cards.filter(isDue).length, 0),
    newCardCount: readyRecords.reduce((total, record) => total + record.cards.filter(card => !card.due).length, 0),
    analysisReady: records.filter(record => record.analysisReady).length,
    categoryCounts, errorCounts
  };
}

function filterRecords(records, { filter = 'all', query = '', category = '', today = '' } = {}) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  const validToday = dateOnly(today);
  return records.filter(record => {
    if (category && category !== 'all' && category !== '全部' && record.category !== category) return false;
    if (filter === 'repair' && !record.needsRepair) return false;
    if (filter === 'analyzed' && !record.analysisReady) return false;
    if (filter === 'ready' && (record.needsRepair || !record.cardCount)) return false;
    if (filter === 'pending') {
      const hasPendingCard = record.cards.some(card => !card.due || (validToday && card.due <= validToday));
      if (record.needsRepair || !hasPendingCard) return false;
    }
    if (filter === 'due' && (record.needsRepair || !validToday || !record.cards.some(card => card.due && card.due <= validToday))) return false;
    if (filter === 'new' && (record.needsRepair || !record.cards.some(card => !card.due))) return false;
    if (!needle) return true;
    return [record.title, record.category, record.errorType, record.diagnosis, record.memory,
      record.correctAnswer, record.questionText, record.explanationText, record.annotation?.attempt]
      .some(value => plain(value).toLocaleLowerCase().includes(needle));
  });
}

module.exports = { parseNote, summarize, filterRecords, scanMarkdown };
