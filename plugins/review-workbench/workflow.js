'use strict';

const DEFAULT_WORKFLOW = Object.freeze({
  inbox: '01_收集箱', notes: '20_笔记', projects: '30_项目', archive: '50_归档', weekly: '40_回顾'
});
const queues = new WeakMap();
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const fold = value => value.normalize('NFC').toLowerCase();
const inside = (path, folder) => fold(path).startsWith(fold(folder) + '/');
const overlaps = (a, b) => fold(a) === fold(b) || inside(a, b) || inside(b, a);
const markdownFile = file => !!file && !Array.isArray(file.children) && typeof file.path === 'string' && /\.md$/i.test(file.path);

function relativePath(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.startsWith('/') || value.includes('\\')) {
    throw new Error(label + '必须是库内相对路径。');
  }
  const path = value.normalize('NFC');
  for (const part of path.split('/')) {
    if (!part || part.startsWith('.') || /[<>:"|?*\x00-\x1f\x7f]/.test(part) || /[ .]$/.test(part) || WINDOWS_DEVICE.test(part)) {
      throw new Error(label + '含有隐藏目录、上级目录或不兼容的文件名。');
    }
  }
  return path;
}

function validateWorkflowSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('工作台目录配置无效。');
  const settings = {};
  for (const key of Object.keys(DEFAULT_WORKFLOW)) {
    settings[key] = relativePath(input[key] === undefined ? DEFAULT_WORKFLOW[key] : input[key], key + '目录');
  }
  for (const key of ['notes', 'projects', 'archive', 'weekly']) {
    if (overlaps(settings.inbox, settings[key])) throw new Error('收集箱与其他目录不能相同或互相包含。');
  }
  for (const destination of ['archive', 'weekly']) {
    for (const source of ['notes', 'projects']) {
      if (fold(settings[source]) === fold(settings[destination]) || inside(settings[source], settings[destination])) {
        throw new Error('归档和每周回顾目录不能包含长期笔记或项目目录。');
      }
    }
  }
  if (overlaps(settings.archive, settings.weekly)) throw new Error('归档和每周回顾目录不能相同或互相包含。');
  return settings;
}

function validDate(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new Error('日期无效。');
  return date;
}

function localDate(date = new Date()) {
  validDate(date);
  return [String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function weekRange(date = new Date()) {
  validDate(date);
  const monday = new Date(date.getTime());
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday.getTime());
  sunday.setDate(sunday.getDate() + 6);
  const nextMonday = new Date(monday.getTime());
  nextMonday.setDate(nextMonday.getDate() + 7);
  nextMonday.setHours(0, 0, 0, 0);
  return { start: localDate(monday), end: localDate(sunday), fromMs: monday.getTime(), toMs: nextMonday.getTime() };
}

// Serialize this plugin's writes; Vault still owns the atomic create/rename checks.
function queued(vault, operation) {
  const previous = queues.get(vault) || Promise.resolve();
  const result = previous.then(operation);
  const settled = result.then(() => undefined, () => undefined);
  queues.set(vault, settled);
  settled.then(() => { if (queues.get(vault) === settled) queues.delete(vault); });
  return result;
}

async function ensureFolder(vault, folder) {
  let path = '';
  for (const part of folder.split('/')) {
    path = path ? path + '/' + part : part;
    const existing = vault.getAbstractFileByPath(path);
    if (existing) {
      if (!Array.isArray(existing.children)) throw new Error(path + ' 已被文件占用。');
      continue;
    }
    try { await vault.createFolder(path); }
    catch (error) {
      if (!Array.isArray(vault.getAbstractFileByPath(path)?.children)) throw error;
    }
  }
}

function safeTitle(title, body, date) {
  const firstLine = body.split(/\r?\n/).find(line => line.trim()) || '';
  const derived = firstLine.replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s*)?|\d+[.)]\s+)/, '');
  let name = (typeof title === 'string' && title.trim() ? title : derived).normalize('NFC')
    .replace(/[\\/<>:"|?*\x00-\x1f\x7f]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[ .]+$/, '');
  // At most 240 UTF-8 bytes before the collision suffix and extension.
  name = Array.from(name).slice(0, 60).join('').replace(/[ .]+$/, '');
  if (!name) name = '随手记-' + localDate(date);
  if (WINDOWS_DEVICE.test(name)) name = '_' + name;
  return name;
}

async function createCapture(vault, input, capture, date = new Date()) {
  const settings = validateWorkflowSettings(input);
  validDate(date);
  if (!capture || typeof capture.body !== 'string' || !capture.body.trim()) throw new Error('先写一点正文再保存。');
  if (capture.title !== undefined && typeof capture.title !== 'string') throw new Error('标题必须是文字。');
  const name = safeTitle(capture.title, capture.body, date);
  // Keep the user's Markdown intact. Creation time is available in the file metadata.
  const normalizedBody = capture.body.replace(/\r\n?/g, '\n');
  const content = normalizedBody.endsWith('\n') ? normalizedBody : normalizedBody + '\n';
  return queued(vault, async () => {
    await ensureFolder(vault, settings.inbox);
    for (let index = 1; index <= 1000; index++) {
      const path = settings.inbox + '/' + name + (index === 1 ? '' : ' (' + index + ')') + '.md';
      if (vault.getAbstractFileByPath(path)) continue;
      try { return await vault.create(path, content); }
      catch (error) {
        // Another writer may have claimed this filename between the lookup and create.
        if (!vault.getAbstractFileByPath(path)) throw error;
      }
    }
    throw new Error('同名记录过多，请换一个标题。');
  });
}

function currentFile(vault, file) {
  if (!markdownFile(file) || vault.getAbstractFileByPath(file.path) !== file) throw new Error('笔记已移动、删除，或不是 Markdown 文件，请刷新后重试。');
  relativePath(file.path, '笔记路径');
}

async function moveInboxNote(app, input, file, targetKey) {
  const settings = validateWorkflowSettings(input);
  if (!['notes', 'projects', 'archive'].includes(targetKey)) throw new Error('只能移到长期笔记、项目或归档。');
  return queued(app.vault, async () => {
    currentFile(app.vault, file);
    if (!inside(file.path, settings.inbox)) throw new Error('只能整理当前收集箱内的笔记。');
    const from = file.path;
    const to = settings[targetKey] + '/' + from.split('/').pop();
    if (app.vault.getAbstractFileByPath(to)) throw new Error('目标位置已有同名文件，原笔记未移动。');
    await ensureFolder(app.vault, settings[targetKey]);
    currentFile(app.vault, file);
    if (file.path !== from || app.vault.getAbstractFileByPath(to)) throw new Error('文件位置已变化，请刷新后重试。');
    await app.fileManager.renameFile(file, to);
    return { file, from, to };
  });
}

async function undoMove(app, move) {
  if (!move || typeof move !== 'object') throw new Error('没有可撤销的移动。');
  const from = relativePath(move.from, '原路径');
  const to = relativePath(move.to, '目标路径');
  if (from === to || !from.includes('/')) throw new Error('移动记录无效。');
  return queued(app.vault, async () => {
    currentFile(app.vault, move.file);
    if (move.file.path !== to) throw new Error('笔记已再次移动，不能撤销这次操作。');
    if (app.vault.getAbstractFileByPath(from)) throw new Error('原位置已有文件，不能撤销移动。');
    await ensureFolder(app.vault, from.slice(0, from.lastIndexOf('/')));
    currentFile(app.vault, move.file);
    if (move.file.path !== to || app.vault.getAbstractFileByPath(from)) throw new Error('文件位置已变化，请刷新后重试。');
    await app.fileManager.renameFile(move.file, from);
    return move.file;
  });
}

function markdownLink(file, folder) {
  const from = folder.split('/');
  const to = file.path.split('/');
  while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
  const encode = part => encodeURIComponent(part).replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
  const href = '../'.repeat(from.length) + to.map(encode).join('/');
  const label = file.path.replace(/\.md$/i, '').replace(/[\\`*_[\]<>]/g, '\\$&');
  return '[' + label + '](' + href + ')';
}

function hasReviewTag(text) {
  let body = text.replace(/^\uFEFF/, '');
  // A small fallback for tests or hosts without a metadata cache. In Obsidian the
  // parsed metadata below is preferred so YAML and Markdown use Obsidian's rules.
  const frontmatter = body.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter) {
    const lines = frontmatter[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^tags?\s*:\s*(.*)$/i);
      if (!match) continue;
      let value = match[1];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) value += ',' + lines[++i].replace(/^\s+-\s+/, '');
      if (value.replace(/[\[\]"']/g, '').split(/[,\s]+/).some(tag => /^#?待回顾(?:\/[^\s]+)?$/.test(tag))) return true;
    }
    body = body.slice(frontmatter[0].length);
  }
  body = body.replace(/<!--[\s\S]*?-->/g, '');
  let fence = null;
  const visible = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (!fence && !/^(?: {4}|\t)/.test(line)) visible.push(line);
  }
  const plain = visible.join('\n').replace(/(`+)[\s\S]*?\1/g, '').replace(/\\#/g, '');
  return /(^|[\s([{>，。；：！？、])#待回顾(?:\/[^\s#.,;:!?，。；：！？、)\]}]+)?(?=$|[\s.,;:!?，。；：！？、)\]}])/m.test(plain);
}

async function tagged(app, file) {
  const cache = app.metadataCache?.getFileCache?.(file);
  // Require a cache for this specific file, not merely the metadataCache service.
  if (cache) {
    const tags = (cache.tags || []).map(item => item.tag);
    const raw = cache.frontmatter?.tags ?? cache.frontmatter?.tag;
    if (Array.isArray(raw)) tags.push(...raw);
    else if (typeof raw === 'string') tags.push(...raw.split(/[,\s]+/));
    return tags.some(tag => typeof tag === 'string' && /^#?待回顾(?:\/.*)?$/.test(tag));
  }
  const read = app.vault.cachedRead || app.vault.read;
  return hasReviewTag(await read.call(app.vault, file));
}

function groupSection(title, files, folder) {
  const shown = files.slice(0, 50);
  return '## ' + title + '（' + files.length + '）\n\n' +
    (shown.length ? shown.map(file => '- ' + markdownLink(file, folder)).join('\n') : '暂无。') +
    (files.length > 50 ? '\n\n仅列出前 50 篇，另有 ' + (files.length - 50) + ' 篇未列出。' : '') + '\n';
}

function templateFolder(app) {
  // Core Templates does not expose a public settings API. This optional hint
  // only expands exclusions; a missing or incompatible plugin uses our default.
  const configured = app.internalPlugins?.plugins?.templates?.instance?.options?.folder;
  if (typeof configured !== 'string' || !configured) return '90_模板';
  try { return relativePath(configured.replace(/\/$/, ''), '模板目录'); }
  catch (_) { return '90_模板'; }
}

async function createWeeklyReview(app, input, date = new Date()) {
  const settings = validateWorkflowSettings(input);
  const range = weekRange(date);
  const path = settings.weekly + '/' + range.start + '.md';
  const existingReview = () => {
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing && !markdownFile(existing)) throw new Error('本周回顾路径已被其他文件或文件夹占用。');
    return existing;
  };
  return queued(app.vault, async () => {
    const existing = existingReview();
    if (existing) return existing;
    const excludedFolders = [settings.archive, settings.weekly, '90_模板', templateFolder(app)];
    const files = app.vault.getMarkdownFiles().filter(file => markdownFile(file) && !excludedFolders.some(folder => inside(file.path, folder)));
    const byRecent = (a, b) => (Number(b.stat?.mtime) || 0) - (Number(a.stat?.mtime) || 0) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const inbox = files.filter(file => inside(file.path, settings.inbox)).sort(byRecent);
    const marked = [];
    for (const file of files) if (await tagged(app, file)) marked.push(file);
    marked.sort(byRecent);
    const modified = files.filter(file => [settings.inbox, settings.notes, settings.projects].some(folder => inside(file.path, folder)) && file.stat?.mtime >= range.fromMs && file.stat?.mtime < range.toMs).sort(byRecent);
    const generatedAt = localDate(date) + ' ' + String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0') + '，本地时间';
    const content = '# 每周回顾 · ' + range.start + ' — ' + range.end + '\n\n' +
      '> 生成时快照（' + generatedAt + '）。列表不会自动更新；再次打开本周回顾会保留这里的修改。\n\n' +
      groupSection('收集箱', inbox, settings.weekly) + '\n' +
      groupSection('待回顾', marked, settings.weekly) + '\n' +
      groupSection('本周修改', modified, settings.weekly) + '\n' +
      '## 留给自己的话\n\n- 这周留下了什么？\n- 下周先做哪一件事？\n';
    await ensureFolder(app.vault, settings.weekly);
    const claimed = existingReview();
    if (claimed) return claimed;
    try { return await app.vault.create(path, content); }
    catch (error) {
      const raced = existingReview();
      if (raced) return raced;
      throw error;
    }
  });
}

module.exports = { DEFAULT_WORKFLOW, validateWorkflowSettings, localDate, weekRange, templateFolder, createCapture, moveInboxNote, undoMove, createWeeklyReview };
