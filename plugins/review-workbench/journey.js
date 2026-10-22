'use strict';

const { weekRange, createWeeklyReview } = require('./workflow');
const KINDS = ['capture', 'organize', 'reflect'];
const MAX_WEEKS = 26;

function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function notePath(value) {
  return typeof value === 'string' && value.length <= 2000 && /\.md$/i.test(value) &&
    !/[\x00-\x1f\x7f\\]/.test(value) && !value.startsWith('/') &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'));
}
function detailFor(kind, value) {
  if (!object(value)) return null;
  if (kind === 'organize') return notePath(value.from) && notePath(value.to) && value.from !== value.to
    ? { from: value.from, to: value.to } : null;
  return notePath(value.path) ? { path: value.path } : null;
}
function validWeek(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const date = new Date(key + 'T12:00:00');
  if (!Number.isFinite(date.getTime()) || date.getDay() !== 1) return false;
  return weekRange(date).start === key;
}
function trimWeeks(state) {
  state.weeks = Object.fromEntries(Object.keys(state.weeks).sort().reverse().slice(0, MAX_WEEKS).map(key => [key, state.weeks[key]]));
  return state;
}

// Store only milestones and their file paths. Reflections stay in Markdown.
function normalizeJourney(saved) {
  const state = { mode: saved?.mode === 'focus' ? 'focus' : 'adventure', weeks: {} };
  if (!object(saved) || !object(saved.weeks)) return state;
  for (const [key, entry] of Object.entries(saved.weeks)) {
    if (!validWeek(key) || !object(entry)) continue;
    const week = {};
    for (const kind of KINDS) {
      const detail = detailFor(kind, entry[kind]);
      if (detail) week[kind] = detail;
    }
    if (Object.keys(week).length) state.weeks[key] = week;
  }
  return trimWeeks(state);
}

function recordJourney(saved, kind, detail, date = new Date()) {
  if (!KINDS.includes(kind)) throw new Error('未知的旅程阶段。');
  const cleaned = detailFor(kind, detail);
  if (!cleaned) throw new Error('旅程记录需要有效的笔记路径。');
  const state = normalizeJourney(saved);
  const { start } = weekRange(date);
  const week = state.weeks[start] || (state.weeks[start] = {});
  if (!week[kind]) week[kind] = cleaned;
  return trimWeeks(state);
}

function undoJourneyMove(saved, move, date = new Date()) {
  const state = normalizeJourney(saved);
  const { start } = weekRange(date);
  const recorded = state.weeks[start]?.organize;
  if (recorded && move?.from === recorded.from && move?.to === recorded.to) {
    delete state.weeks[start].organize;
    if (!Object.keys(state.weeks[start]).length) delete state.weeks[start];
  }
  return state;
}

function journeyStatus(saved, date = new Date()) {
  const state = normalizeJourney(saved);
  const { start, end } = weekRange(date);
  const entry = state.weeks[start] || {};
  const steps = Object.fromEntries(KINDS.map(kind => [kind, !!entry[kind]]));
  return { week: start, start, end, done: KINDS.filter(kind => steps[kind]).length, total: 3, steps };
}

async function saveReflection(app, workflowSettings, text, date = new Date()) {
  if (typeof text !== 'string' || Array.from(text.replace(/\s/g, '')).length < 10) {
    throw new Error('写下至少 10 个字，留住这周的一点收获。');
  }
  const { start } = weekRange(date);
  if (typeof app.vault.process !== 'function') throw new Error('当前 Obsidian 不支持安全写入，请更新后重试。');
  const file = await createWeeklyReview(app, workflowSettings, date);
  const marker = '<!-- zhixing-journey:' + start + ' -->';
  let created = false;
  // Obsidian process reads and writes the latest content atomically. A second
  // submission sees the marker and preserves the first saved reflection.
  await app.vault.process(file, content => {
    created = false;
    if (content.includes(marker)) return content;
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const body = text.replace(/\r\n?/g, '\n').replace(/\n/g, eol);
    const gap = !content || content.endsWith(eol + eol) ? '' : content.endsWith(eol) ? eol : eol + eol;
    const ending = body.endsWith(eol) ? '' : eol;
    created = true;
    return content + gap + marker + eol + '## 本周收获' + eol + eol + body + ending;
  });
  return { file, created };
}

module.exports = { normalizeJourney, recordJourney, undoJourneyMove, journeyStatus, saveReflection };
