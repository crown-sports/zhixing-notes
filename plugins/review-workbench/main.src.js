const { Plugin, ItemView, Modal, Notice, MarkdownRenderer, Component, setIcon, TFile, TFolder, PluginSettingTab, Setting } = require('obsidian');
const { parseNote, summarize, filterRecords, scanMarkdown } = require('./data');
const { installDesk, renderDeskSettings } = require('./desk');
const MAIN = 'review-workbench-main';
const SIDE = 'review-workbench-nav';
const DEFAULT_SETTINGS = { folder: '20_笔记/回顾卡片' };
const FILTERS = [['all', '全部卡片', 'library'], ['pending', '待复习', 'rotate-ccw'], ['repair', '待完善', 'pencil-line'], ['analyzed', '已有分析', 'lightbulb']];
const today = (date = new Date()) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
const plain = text => String(text || '').replace(/!\[\[[^\]]+\]\]/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_, a, b) => b || a.split('/').pop()).replace(/[#>*`_]/g, '').replace(/\s+/g, ' ').trim();
function rootClass(el, name, value) { el.classList.toggle(name, value); }
const short = (text, n = 96) => { const value = plain(text); return value.length > n ? value.slice(0, n) + '…' : value; };
function icon(parent, name) { const span = parent.createSpan({ cls: 'mw-icon', attr: { 'aria-hidden': 'true' } }); setIcon(span, name); return span; }
function button(parent, label, action, cls = '', glyph) {
  const el = parent.createEl('button', { cls: 'mw-button ' + cls, attr: { type: 'button' } });
  if (glyph) icon(el, glyph);
  el.createSpan({ text: label });
  el.addEventListener('click', async () => {
    if (el.disabled) return;
    try { await action(); } catch (error) { console.error('回顾工作台', error); new Notice('操作未完成：' + error.message, 6000); }
  });
  return el;
}
function panel(parent, title, cls = '') { const el = parent.createDiv({ cls: 'mw-panel ' + cls }); el.createEl('h3', { cls: 'mw-panel-title', text: title }); return el; }
function annotationRanges(text) {
  const scanned = scanMarkdown(text);
  const ranges = scanned.headings.filter(heading => heading.level === 2 && /^(?:回顾|错题)分析$/.test(heading.title)).map(heading => ({
    start: heading.index,
    end: scanned.headings.find(next => next.index > heading.index && next.level <= 2)?.index ?? text.length
  }));
  return { ...scanned, ranges };
}
function annotationBlock(text) {
  const range = annotationRanges(text).ranges[0];
  return range ? text.slice(range.start, range.end) : '';
}
function assertEditableAnnotation(block) {
  if (!block) return;
  const manual = () => { throw new Error('分析含手写前言、自定义字段或无法安全回写的内容，请直接在笔记中编辑；原文未修改。'); };
  if (/<!--/.test(block)) manual(); // The display parser removes comments.
  const { headings, unfinished } = scanMarkdown(block);
  if (unfinished) manual();
  const fields = headings.filter(heading => heading.level === 3);
  if (block.slice(headings[0].end, fields[0]?.index ?? block.length).trim()) manual();
  const known = [/^(?:理解难点|错因类型)$/, /^(?:之前的理解|我的误选或思路)$/, /^(?:关键理解|正确判断)$/, /^(?:疑点与原因|为什么会错)$/, /^记忆方法$/, /^下次检查$/];
  const seen = new Set();
  fields.forEach((field, index) => {
    const key = known.findIndex(pattern => pattern.test(field.title));
    if (key < 0 || seen.has(key)) manual();
    seen.add(key);
    // This field uses a fixed select; arbitrary Markdown would otherwise vanish.
    if (key === 0 && !['待分析', '概念混淆', '知识缺口', '条件遗漏', '计算步骤'].includes(block.slice(field.end, fields[index + 1]?.index ?? block.length).trim())) manual();
  });
}
function annotationValue(value) {
  let text = value.trim().replace(/\r\n/g, '\n');
  const { headings, unfinished } = scanMarkdown(text);
  if (unfinished) throw new Error('分析中的代码围栏或注释尚未闭合，请补全后保存。');
  for (const heading of headings.filter(heading => heading.level <= 3).reverse()) {
    text = text.slice(0, heading.marker) + '####' + text.slice(heading.marker + heading.level);
  }
  return text;
}
function buildAnnotation(values) {
  const sections = [['errorType', '理解难点'], ['attempt', '之前的理解'], ['correct', '关键理解'], ['diagnosis', '疑点与原因'], ['memory', '记忆方法'], ['check', '下次检查']];
  return '## 回顾分析\n\n' + sections.filter(([key]) => values[key]?.trim()).map(([key, label]) => '### ' + label + '\n\n' + annotationValue(values[key])).join('\n\n') + '\n';
}
function updateAnnotation(current, initial, values) {
  const { ranges, unfinished } = annotationRanges(current);
  if (unfinished || ranges.length > 1) throw new Error('笔记含未闭合的代码围栏、注释或多个分析区，请直接在笔记中整理后再保存；原文未修改。');
  const existing = annotationBlock(current);
  if (existing !== initial) throw new Error('这份分析刚被修改，请关闭后重新打开，避免覆盖新内容。');
  assertEditableAnnotation(existing);
  const eol = current.includes('\r\n') ? '\r\n' : '\n';
  const block = buildAnnotation(values).replace(/\n/g, eol);
  return existing ? current.slice(0, ranges[0].start) + block + eol + current.slice(ranges[0].end) : current + (current.endsWith(eol + eol) ? '' : eol + eol) + block;
}
function normalizeFolder(value) {
  if (typeof value !== 'string') throw new Error('请输入库内卡片目录。');
  const cleaned = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!cleaned || cleaned.startsWith('/') || /[<>:"|?*\x00-\x1f]/.test(cleaned)) throw new Error('请使用库内相对目录，不要输入绝对路径或特殊字符。');
  const parts = cleaned.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || /[. ]$/.test(part))) throw new Error('目录不能包含空层级、隐藏目录或上级路径。');
  return parts.join('/');
}
function buildReviewNote(values, date = new Date()) {
  const title = String(values.title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  const question = String(values.question || '').trim();
  const answer = String(values.answer || '').trim();
  const category = String(values.category || '概念').replace(/\s+/g, ' ').trim().slice(0, 40) || '其他';
  if (!title || !question || !answer) throw new Error('请填写标题、回忆问题和答案。');
  if (/^#{1,6}\s|^\s*\?{1,2}\s*$/m.test(question + '\n' + answer)) throw new Error('新建表单每次收录一张卡，请不要在问题或答案内加入独立标题或问答分隔符。');
  if (/^\s*---+\s*$|^#flashcards(?:\/|$)|^\s*>\s*\[!(?:success|source|warning|example)\]|^\s*详解(?:与图示)?[：:]/m.test(question + '\n' + answer)) throw new Error('问题或答案包含卡片边界（分隔线、复习标签或详解块），会截断自测内容。请移到卡片外，或拆成独立卡片。');
  const content = `---\ntitle: ${JSON.stringify(title)}\ncreated: ${today(date)}\ncategory: ${JSON.stringify(category)}\n---\n\n# ${title}\n\n#flashcards/review\n\n## 回忆卡\n\n${question}\n?\n${answer}\n\n## 来源\n\n`;
  const record = parseNote('new-card.md', content);
  if (record.needsRepair || record.cardCount !== 1) throw new Error('请写一个具体问题和完整答案，不要只重复标题；新建表单每次收录一张卡。');
  return { title, content };
}
async function createReviewNote(vault, folder, values, date = new Date()) {
  const directory = normalizeFolder(folder);
  const note = buildReviewNote(values, date);
  let parent = '';
  for (const part of directory.split('/')) {
    parent = parent ? parent + '/' + part : part;
    const current = vault.getAbstractFileByPath(parent);
    if (current && !(current instanceof TFolder)) throw new Error('目标目录与现有文件重名，请换一个目录。');
    if (!current) {
      try { await vault.createFolder(parent); }
      catch (error) { if (!(vault.getAbstractFileByPath(parent) instanceof TFolder)) throw error; }
    }
  }
  const stamp = today(date) + '-' + [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => String(n).padStart(2, '0')).join('');
  const slug = note.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').slice(0, 70) || '回顾卡';
  for (let n = 0; n < 1000; n++) {
    const path = directory + '/' + stamp + '-' + slug + (n ? '-' + n : '') + '.md';
    if (!vault.getAbstractFileByPath(path)) return vault.create(path, note.content);
  }
  throw new Error('同名卡片过多，请修改标题后再试。');
}
function queueSettings(plugin, patch) {
  const save = async () => {
    const next = { folder: plugin.settings.folder, workflow: plugin.workflowSettings, ...patch };
    await plugin.saveData(next);
    plugin.settings = { folder: next.folder };
    plugin.workflowSettings = next.workflow;
  };
  const result = (plugin.settingsSaveQueue || Promise.resolve()).then(save);
  plugin.settingsSaveQueue = result.catch(() => {});
  return result;
}
class CreateCardModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  onOpen() {
    this.setTitle('新建回顾卡');
    const root = this.contentEl; root.addClass('mw-analysis-form');
    root.createEl('p', { cls: 'mw-muted', text: '把一个值得记住的知识点写成问题。保存为普通 Markdown，不需要其他插件。' });
    const fields = {};
    for (const [key, label, placeholder, rows] of [['title', '标题', '例如：主动回忆', 1], ['category', '主题分类', '概念、方法、实践，也可以自定义', 1], ['question', '回忆问题', '例如：为什么先回忆，再看答案？', 3], ['answer', '答案', '用自己的话写出关键解释。', 4]]) {
      const field = root.createDiv({ cls: 'mw-form-field' });
      field.createEl('label', { text: label, attr: { for: 'rw-new-' + key } });
      fields[key] = field.createEl(rows === 1 ? 'input' : 'textarea', { attr: { id: 'rw-new-' + key, rows: String(rows), placeholder } });
    }
    fields.category.value = '概念';
    const actions = root.createDiv({ cls: 'mw-actions' });
    button(actions, '取消', () => this.close(), 'is-quiet');
    const save = button(actions, '创建卡片', async () => {
      save.disabled = true;
      try {
        const values = Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value]));
        const file = await createReviewNote(this.app.vault, this.plugin.settings.folder, values);
        await this.plugin.refresh(); this.close();
        await this.plugin.openNote(file.path, true);
        new Notice('回顾卡已创建，可继续补充来源和截图。');
      } finally { save.disabled = false; }
    }, 'is-primary', 'plus');
    fields.title.focus();
  }
  onClose() { this.contentEl.empty(); }
}
class ReviewSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.owner = plugin; }
  display() {
    const root = this.containerEl; root.empty();
    root.createEl('h2', { text: '知行工作台' });
    let folder = this.owner.settings.folder;
    new Setting(root).setName('卡片目录').setDesc('仅扫描此目录及子目录。保存设置不会移动现有笔记。')
      .addText(text => text.setPlaceholder(DEFAULT_SETTINGS.folder).setValue(folder).onChange(value => { folder = value; }))
      .addButton(save => save.setButtonText('保存目录').setCta().onClick(async () => {
        try { await this.owner.setFolder(folder); new Notice('卡片目录已更新。'); this.display(); }
        catch (error) { new Notice(error.message, 6000); }
      }));
    root.createEl('p', { text: '新建卡片和快速自测可直接使用。需要间隔排期时，可自行安装 Spaced Repetition；本插件不修改它的复习记录。' });
    renderDeskSettings(root, this.owner);
  }
}
class AnalysisModal extends Modal {
  constructor(plugin, record) { super(plugin.app); this.plugin = plugin; this.record = record; }
  async onOpen() {
    const root = this.contentEl; root.addClass('mw-analysis-form');
    this.setTitle('补充回顾分析');
    root.createEl('p', { cls: 'mw-muted', text: this.record.title + ' · 保存后写回这篇卡片笔记' });
    const file = this.app.vault.getAbstractFileByPath(this.record.path);
    if (!(file instanceof TFile)) { new Notice('原笔记已移动，请刷新后再试'); this.close(); return; }
    const initialContent = await this.app.vault.read(file);
    const initial = annotationBlock(initialContent);
    const annotation = parseNote(this.record.path, initialContent).annotation || {};
    const values = {};
    const field = (key, label, hint, value, select) => {
      const row = root.createDiv({ cls: 'mw-form-field' }); const id = 'mw-' + key;
      row.createEl('label', { text: label, attr: { for: id } });
      const input = row.createEl(select ? 'select' : 'textarea', { attr: { id, rows: key === 'diagnosis' ? '3' : '2', placeholder: hint } });
      if (select) ['待分析', '概念混淆', '知识缺口', '条件遗漏', '计算步骤'].forEach(s => input.createEl('option', { text: s, value: s }));
      input.value = value || (select ? '待分析' : ''); values[key] = input;
      return input;
    };
    field('errorType', '理解难点', '', annotation.errorType, true);
    field('attempt', '我当时怎么想的', '例如：读的时候很熟悉，就以为自己已经能解释了。', annotation.attempt);
    field('correct', '关键理解', '写出具体结论，不能只填知识点名称。', annotation.correct);
    field('diagnosis', '疑点与原因', '哪里容易混淆？哪一步还需要解释？', annotation.diagnosis);
    field('memory', '下次怎么记', '一句口诀、一个反例，或一组对比。', annotation.memory);
    field('check', '下次先检查什么', '例如：先说清适用条件，再举一个自己的例子。', annotation.check);
    const foot = root.createDiv({ cls: 'mw-actions' });
    button(foot, '取消', () => this.close(), 'is-quiet');
    const save = button(foot, '保存分析', async () => {
      const result = Object.fromEntries(Object.entries(values).map(([key, input]) => [key, input.value.trim()]));
      if (!result.correct || !result.diagnosis) { new Notice('请至少填写“关键理解”和“疑点与原因”。'); return; }
      save.disabled = true;
      try {
        await this.app.vault.process(file, current => updateAnnotation(current, initial, result));
        await this.plugin.refresh();
        new Notice('分析已保存到原卡片笔记。');
        this.close();
      } finally { save.disabled = false; }
    }, 'is-primary', 'check');
  }
  onClose() { this.contentEl.empty(); }
}
class WorkbenchView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.route = { filter: 'all', category: '', query: '', selected: '' }; this.practice = null; }
  getViewType() { return MAIN; }
  getDisplayText() { return '回顾工作台'; }
  getIcon() { return 'notebook-pen'; }
  getState() { return this.route; }
  async setState(state, result) { this.route = { ...this.route, ...state }; this.render(); await super.setState(state, result); }
  async onOpen() { this.contentEl.addClass('mw-main'); this.render(); }
  onClose() { if (this.renderComponent) this.removeChild(this.renderComponent); }
  go(next) { this.practice = null; this.route = { ...this.route, ...next }; this.render(); this.plugin.renderSidebar(); this.app.workspace.requestSaveLayout(); }
  showRecord(record) { this.go({ selected: record.path }); }
  render() {
    if (!this.contentEl) return;
    const scroll = this.contentEl.scrollTop;
    if (this.renderComponent) this.removeChild(this.renderComponent);
    this.renderComponent = this.addChild(new Component());
    this.contentEl.empty();
    this.contentEl.setAttribute('aria-label', '回顾工作台');
    if (this.plugin.loading) { this.contentEl.createEl('p', { cls: 'mw-muted', text: '正在整理你的卡片…' }); return; }
    if (this.plugin.loadError) { const box = panel(this.contentEl, '暂时无法读取回顾卡片'); box.createEl('p', { text: this.plugin.loadError }); button(box, '重新读取', () => this.plugin.refresh()); return; }
    const record = this.plugin.records.find(r => r.path === this.route.selected);
    rootClass(this.contentEl, 'mw-detail', !!record && !this.practice);
    if (this.practice) this.renderPractice();
    else if (record) this.renderDetail(record);
    else this.renderDashboard();
    this.contentEl.scrollTop = this.keepScroll ? scroll : 0;
    this.keepScroll = false;
  }
  md(parent, text, path) {
    const el = parent.createDiv({ cls: 'mw-markdown' });
    MarkdownRenderer.render(this.app, text || '', el, path || this.plugin.settings.folder + '/', this.renderComponent).catch(error => { console.error(error); el.textContent = plain(text); });
    return el;
  }
  renderDashboard() {
    const root = this.contentEl; const stats = this.plugin.stats;
    const head = root.createDiv({ cls: 'mw-header' }); const intro = head.createDiv();
    intro.createDiv({ cls: 'mw-eyebrow', text: '回顾工作台 / 本地笔记' });
    intro.createEl('h1', { cls: 'mw-title', text: '回顾工作台' });
    intro.createEl('p', { cls: 'mw-subtitle', text: '把读过的内容变成问题，用自己的话回忆答案。' });
    const actions = head.createDiv({ cls: 'mw-actions' });
    button(actions, '新建回顾卡', () => new CreateCardModal(this.plugin).open(), '', 'plus');
    button(actions, '开始回忆', () => this.startPractice(this.readyRecords()), 'is-primary', 'play');
    const statsEl = root.createDiv({ cls: 'mw-stats' });
    [[stats.total, '已收录卡片', '问题与笔记都在本地', 'all'], [stats.ready, '可直接练习', '问题与答案已具备', 'ready'], [stats.needsRepair, '需要完善', '先补全，再反复记忆', 'repair'], [stats.analysisReady, '已有分析', '查看疑点与理解过程', 'analyzed']].forEach(([value, label, help, filter]) => {
      const stat = statsEl.createEl('button', { cls: 'mw-stat', attr: { type: 'button', 'aria-label': label + ' ' + value + '张' } });
      stat.createDiv({ cls: 'mw-stat-value', text: String(value || 0) }); stat.createDiv({ cls: 'mw-stat-label', text: label }); stat.createDiv({ cls: 'mw-stat-help', text: help }); stat.onclick = () => this.go({ filter, selected: '', query: '', category: '' });
    });
    if (this.route.filter === 'all' && !this.route.query && !this.route.category) {
      const feature = root.createDiv({ cls: 'mw-feature' });
      const featured = this.plugin.records.find(r => r.analysisReady && r.answerReady) || this.plugin.records.find(r => r.answerReady);
      if (featured) {
        const text = feature.createDiv(); text.createDiv({ cls: 'mw-eyebrow', text: '从这张卡开始' }); text.createEl('h2', { text: featured.title });
        text.createEl('p', { text: featured.diagnosis ? short(featured.diagnosis, 110) : '先回忆答案，再核对笔记，留下自己的理解。' });
        const action = feature.createDiv({ cls: 'mw-actions' }); button(action, '查看理解与分析', () => this.showRecord(featured), 'is-primary', 'arrow-up-right'); button(action, '先自测', () => this.startPractice([featured]), 'is-quiet');
      }
    }
    const section = root.createDiv({ cls: 'mw-section-head' });
    const title = this.route.filter === 'ready' ? '可直接练习' : FILTERS.find(x => x[0] === this.route.filter)?.[1] || '全部卡片';
    const titleEl = section.createEl('h2', { text: (this.route.category ? this.route.category + ' · ' : '') + title });
    section.createSpan({ cls: 'mw-muted', text: '按收录时间排序' });
    const toolbar = root.createDiv({ cls: 'mw-toolbar' });
    const searchWrap = toolbar.createDiv({ cls: 'mw-search' }); icon(searchWrap, 'search');
    const search = searchWrap.createEl('input', { attr: { type: 'search', placeholder: '搜索卡片、关键词或记忆方法', 'aria-label': '搜索回顾卡片' } }); search.value = this.route.query;
    const category = toolbar.createEl('select', { cls: 'mw-select', attr: { 'aria-label': '按主题分类筛选' } });
    ['', ...this.plugin.categories()].forEach(value => category.createEl('option', { text: value || '全部分类', value })); category.value = this.route.category;
    category.onchange = () => { this.route.category = category.value; update(); this.plugin.renderSidebar(); this.app.workspace.requestSaveLayout(); };
    const chips = root.createDiv({ cls: 'mw-filters', attr: { 'aria-label': '卡片状态筛选' } });
    FILTERS.forEach(([key, label]) => { const chip = button(chips, label, () => this.go({ filter: key, selected: '' }), 'mw-chip' + (this.route.filter === key ? ' is-active' : '')); chip.setAttribute('aria-pressed', String(this.route.filter === key)); });
    const grid = root.createDiv({ cls: 'mw-grid' });
    const update = () => {
      grid.empty();
      const records = filterRecords(this.plugin.records, { ...this.route, today: today() });
      titleEl.textContent = (this.route.category ? this.route.category + ' · ' : '') + title + ' · ' + records.length;
      if (!this.plugin.records.length) { const empty = grid.createDiv({ cls: 'mw-empty' }); empty.createEl('h3', { text: '从一个值得记住的问题开始' }); empty.createEl('p', { text: '新建一张回顾卡，写下问题和答案。也可以在设置中选择已有卡片目录。' }); button(empty, '新建回顾卡', () => new CreateCardModal(this.plugin).open(), 'is-primary'); }
      else if (!records.length) { const empty = grid.createDiv({ cls: 'mw-empty' }); icon(empty, 'search'); empty.createEl('h3', { text: '没有匹配的卡片' }); empty.createEl('p', { text: '换个关键词，或返回全部卡片。' }); button(empty, '查看全部', () => this.go({ filter: 'all', query: '', category: '', selected: '' })); }
      for (const record of records) this.renderCard(grid, record);
    };
    search.oninput = () => { this.route.query = search.value; update(); };
    search.onchange = () => this.app.workspace.requestSaveLayout();
    update();
    root.createDiv({ cls: 'mw-footnote', text: '“可练习”表示问题与答案完整，不代表已经掌握。待完善的卡片不会进入快速回忆。' });
  }
  renderCard(parent, record) {
    const card = parent.createEl('article', { cls: 'mw-card' });
    const top = card.createDiv({ cls: 'mw-card-top' });
    top.createSpan({ cls: 'mw-badge is-neutral', text: record.category });
    top.createSpan({ cls: 'mw-badge ' + (record.needsRepair ? 'is-warning' : 'is-success'), text: record.needsRepair ? '待完善' : (record.analysisReady ? '已有分析' : '可练习') });
    const title = card.createEl('h3', { cls: 'mw-card-title' });
    const link = title.createEl('button', { text: record.title, attr: { type: 'button' } }); link.onclick = () => this.showRecord(record);
    card.createEl('p', { cls: 'mw-card-description', text: record.needsRepair ? record.repairReasons.join('；') : short(record.diagnosis || record.questionText || '打开卡片，先回忆，再看答案。', 94) });
    const meta = card.createDiv({ cls: 'mw-card-meta' });
    meta.createSpan({ text: record.created || '收录日期未记录' });
    meta.createSpan({ text: record.cardCount ? record.cardCount + ' 张回忆卡' : '待补充答案' });
    if (record.memoryReady) meta.createSpan({ text: '有记忆方法' });
    const foot = card.createDiv({ cls: 'mw-card-bottom' });
    button(foot, record.needsRepair ? '查看待补内容' : '打开分析', () => this.showRecord(record), 'is-quiet', 'arrow-up-right');
    if (!record.needsRepair && record.cardCount) button(foot, '自测', () => this.startPractice([record]), '', 'play');
  }
  readyRecords() { return filterRecords(this.plugin.records, { filter: 'pending', today: today() }).filter(r => !r.needsRepair && r.cardCount); }
  renderDetail(record) {
    const root = this.contentEl; root.addClass('mw-detail');
    const back = root.createDiv({ cls: 'mw-detail-header' }); button(back, '返回回顾目录', () => { root.removeClass('mw-detail'); this.go({ selected: '' }); }, 'is-quiet mw-back', 'arrow-left');
    const controls = back.createDiv({ cls: 'mw-actions' }); button(controls, '编辑原笔记', () => this.plugin.openNote(record.path, true), 'is-quiet', 'file-pen-line'); button(controls, '补充回顾分析', () => new AnalysisModal(this.plugin, record).open(), '', 'pencil-line');
    root.createDiv({ cls: 'mw-eyebrow', text: record.category + ' / ' + (record.created || '回顾详情') });
    root.createEl('h1', { cls: 'mw-title', text: record.title });
    const actions = root.createDiv({ cls: 'mw-actions' });
    if (record.cardCount && !record.needsRepair) { button(actions, '先回忆，再看答案', () => this.startPractice([record]), 'is-primary', 'play'); button(actions, '间隔复习这张卡', () => this.plugin.scheduledReview(record), '', 'calendar-check'); }
    if (record.needsRepair) {
      const repair = panel(root, '先补完整这张卡', 'mw-repair-panel'); repair.createEl('p', { text: record.repairReasons.join('；') });
      repair.createEl('p', { cls: 'mw-muted', text: '先补上能核对理解的答案，再开始回顾。' });
      button(repair, '打开笔记补全', () => this.plugin.openNote(record.path, true), 'is-primary', 'pencil-line');
    }
    const flow = root.createDiv({ cls: 'mw-flow' });
    [['01', '找疑点', '哪里还没理解'], ['02', '理清思路', '用自己的话解释'], ['03', '留下记法', '一句话抓关键'], ['04', '主动回忆', '合上笔记再回答']].forEach(([num, title, sub]) => { const step = flow.createDiv({ cls: 'mw-flow-step' }); step.createSpan({ cls: 'mw-step-num', text: num }); step.createEl('strong', { text: title }); step.createSpan({ text: sub }); });
    const grid = root.createDiv({ cls: 'mw-detail-grid' });
    const left = grid.createDiv({ cls: 'mw-detail-primary' }); const right = grid.createDiv({ cls: 'mw-detail-secondary' });
    const why = panel(left, '哪里还没理解');
    const annotation = record.annotation || {};
    if (record.diagnosis) {
      why.createSpan({ cls: 'mw-badge is-warning', text: record.diagnosisTentative ? '可能的原因 · 待确认' : record.errorType === '待分析' ? '待确认的疑点' : record.errorType });
      this.md(why, record.diagnosis, record.path);
      if (!annotation.diagnosis) why.createEl('p', { cls: 'mw-muted', text: '这是笔记中已有的理解记录，可以补充你现在的想法。' });
    } else { why.createEl('p', { text: '这张卡还没有记录疑点。' }); why.createEl('p', { cls: 'mw-muted', text: '试着回想：哪个概念还说不清，哪个条件容易忽略，哪里还缺一个例子？' }); }
    if (annotation.attempt) { why.createEl('h4', { text: '我当时的思路' }); this.md(why, annotation.attempt, record.path); }
    const comparison = (record.questionText || '').split('\n\n').find(block => /^\|/.test(block.trim()) && /错/.test(block.split('\n')[0]) && /正确/.test(block.split('\n')[0]));
    const answer = panel(left, comparison ? '不同理解的对照' : '已有答案与依据');
    if (comparison) this.md(answer, comparison, record.path);
    else if (record.correctAnswer) this.md(answer, record.correctAnswer, record.path);
    else answer.createEl('p', { cls: 'mw-muted', text: '需要补上正确结论；知识点名称不能代替答案。' });
    if (record.explanationText || record.analysisText) {
      const explanation = panel(left, '把概念讲明白'); this.md(explanation, record.explanationText || record.analysisText, record.path);
    }
    const memory = panel(right, '下次怎么记', 'mw-memory');
    if (record.memory) this.md(memory, record.memory, record.path);
    else { memory.createEl('p', { text: '还没有整理记忆方法。' }); memory.createEl('p', { cls: 'mw-muted', text: '写一句口诀、一个反例，或一组容易混淆的对比。' }); }
    const check = panel(right, '下次应用前');
    if (annotation.check) this.md(check, annotation.check, record.path);
    else { const list = check.createEl('ol'); ['说清这个方法适用的情境与条件。', '用自己的话解释核心观点。', '举一个实际例子，再想想它的局限。'].forEach(text => list.createEl('li', { text })); }
    const source = panel(right, '问题与截图');
    if (record.questionText && !record.questionText.includes('这题的正确答案或关键判断')) this.md(source, record.questionText.split(/\n\s*\|/)[0], record.path);
    if (record.imagePaths.length) {
      const details = source.createEl('details', { cls: 'mw-source-details' }); details.createEl('summary', { text: '查看原图（可能含答案）' });
      for (const path of record.imagePaths) {
        const file = this.app.metadataCache.getFirstLinkpathDest(path.split('|')[0], record.path);
        if (file instanceof TFile) { const img = details.createEl('img', { cls: 'mw-image', attr: { src: this.app.vault.getResourcePath(file), alt: record.title + ' 笔记截图', loading: 'lazy' } }); img.onclick = () => this.app.workspace.getLeaf('tab').openFile(file); }
      }
    } else if (!record.sourceAvailable) source.createEl('p', { cls: 'mw-muted', text: '还缺少明确的回顾问题，可打开原笔记补充。' });
    const all = root.createEl('details', { cls: 'mw-source-details mw-original-note' }); all.createEl('summary', { text: '查看完整笔记与来源' });
    let rendered = false; all.addEventListener('toggle', () => { if (all.open && !rendered) { rendered = true; this.md(all, record.sourceText, record.path); } });
  }
  startPractice(records) {
    const queue = records.filter(r => !r.needsRepair).flatMap(record => record.cards.map(card => ({ record, card })));
    if (!queue.length) { new Notice('当前没有待回顾卡片。可从目录选择一张自测，或先补全问题和答案。'); return; }
    this.practice = { queue, index: 0, revealed: false, origin: this.route.selected }; this.render();
  }
  renderPractice() {
    const root = this.contentEl; const state = this.practice; const item = state.queue[state.index];
    const head = root.createDiv({ cls: 'mw-header' }); const info = head.createDiv();
    info.createDiv({ cls: 'mw-eyebrow', text: '主动回忆 / 不看答案先作答' }); info.createEl('h1', { cls: 'mw-title', text: '想一想，再翻开' });
    button(head, '退出自测', () => { this.practice = null; this.render(); }, 'is-quiet', 'x');
    root.createEl('p', { cls: 'mw-subtitle', text: '快速自测不改变复习间隔；需要安排下次复习，请使用“间隔复习”。' });
    const progress = root.createDiv({ cls: 'mw-progress', attr: { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(state.queue.length), 'aria-valuenow': String(state.index), 'aria-label': '自测进度' } });
    progress.createDiv().style.width = (state.index / state.queue.length * 100) + '%';
    if (!item) {
      const done = panel(root, '这一轮已经看完'); done.createEl('p', { text: '共回忆了 ' + state.queue.length + ' 张卡。能否独立说清答案和判断依据，比“看着眼熟”更重要。' });
      button(done, '回到回顾目录', () => { this.practice = null; this.go({ selected: '' }); }, 'is-primary');
      return;
    }
    const box = root.createDiv({ cls: 'mw-practice' }); box.createDiv({ cls: 'mw-eyebrow', text: '第 ' + (state.index + 1) + ' / ' + state.queue.length + ' 张 · ' + item.record.category });
    box.createEl('h2', { text: item.record.title });
    this.md(box, item.card.question, item.record.path);
    const label = box.createEl('label', { cls: 'mw-inline-label', text: '先用自己的话回答（可选，不保存）', attr: { for: 'mw-recall-input' } });
    const input = box.createEl('textarea', { cls: 'mw-recall-input', attr: { id: 'mw-recall-input', rows: '3', placeholder: '我认为答案是……因为……' } });
    const result = box.createDiv({ cls: 'mw-answer' }); result.hidden = true;
    const actions = box.createDiv({ cls: 'mw-actions' });
    const reveal = button(actions, '显示答案', () => {
      result.hidden = false; result.createEl('h3', { text: '核对答案与理由' }); this.md(result, item.card.answer, item.record.path); reveal.remove();
      button(actions, state.index + 1 === state.queue.length ? '完成本轮' : '下一张', () => { state.index++; this.render(); }, 'is-primary', 'arrow-right');
      button(actions, '查看这张卡的分析', () => { this.practice = null; this.showRecord(item.record); }, 'is-quiet');
    }, 'is-primary', 'eye');
  }
}
class NavigationView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return SIDE; }
  getDisplayText() { return '回顾导航'; }
  getIcon() { return 'notebook-pen'; }
  async onOpen() { this.contentEl.addClass('mw-sidebar'); this.render(); }
  render() {
    const root = this.contentEl; root.empty(); const plugin = this.plugin; const stats = plugin.stats;
    const brand = root.createDiv({ cls: 'mw-brand' }); icon(brand, 'notebook-pen'); const text = brand.createDiv(); text.createEl('strong', { text: '我的回顾卡片' }); text.createDiv({ cls: 'mw-muted', text: '主动回忆 · 持续积累' });
    const add = root.createDiv({ cls: 'mw-sidebar-capture' }); button(add, '新建回顾卡', () => new CreateCardModal(plugin).open(), 'is-primary', 'plus');
    root.createDiv({ cls: 'mw-sidebar-heading', text: '复习与整理' });
    const nav = root.createDiv({ cls: 'mw-nav' }); const state = plugin.mainView()?.route || {};
    const counts = { all: stats.total, pending: stats.pendingCount || 0, repair: stats.needsRepair, analyzed: stats.analysisReady };
    for (const [key, label, glyph] of FILTERS) {
      const el = button(nav, label, () => plugin.open({ filter: key, category: '', query: '', selected: '' }), 'mw-nav-button' + (state.filter === key && !state.category && !state.selected ? ' is-active' : ''), glyph);
      el.createSpan({ cls: 'mw-count', text: String(counts[key] || 0) });
    }
    root.createDiv({ cls: 'mw-sidebar-heading', text: '按主题分类' });
    const categories = root.createDiv({ cls: 'mw-nav' });
    for (const category of plugin.categories()) {
      const count = stats.categoryCounts?.[category] || 0; if (!count && category === '其他') continue;
      const el = button(categories, category, () => plugin.open({ filter: 'all', category, query: '', selected: '' }), 'mw-nav-button' + (state.category === category ? ' is-active' : ''), 'book-open');
      el.createSpan({ cls: 'mw-count', text: String(count) });
    }
    root.createDiv({ cls: 'mw-sidebar-heading', text: '最近收录' });
    const recent = root.createDiv({ cls: 'mw-recent' });
    for (const record of plugin.records.slice(0, 4)) {
      const el = button(recent, record.title, () => plugin.open({ selected: record.path }), 'mw-recent-button');
      el.createSpan({ cls: 'mw-muted', text: record.needsRepair ? '待完善答案' : record.analysisReady ? '已有讲解与分析' : '可开始练习' });
    }
    const tip = root.createDiv({ cls: 'mw-sidebar-tip' }); icon(tip, 'lightbulb'); tip.createEl('strong', { text: '每次弄懂一个问题' }); tip.createEl('p', { text: '用自己的话解释，再留一个下次能用的例子或方法。' });
    root.createDiv({ cls: 'mw-footnote', text: '卡片目录可在插件设置中修改。' });
  }
}
module.exports = class ReviewWorkbench extends Plugin {
  async onload() {
    this.settings = { ...DEFAULT_SETTINGS };
    const saved = await this.loadData();
    try { this.settings.folder = normalizeFolder(saved?.folder || DEFAULT_SETTINGS.folder); } catch (_) { new Notice('卡片目录配置无效，已使用默认目录。'); }
    installDesk(this, saved?.workflow);
    this.addSettingTab(new ReviewSettings(this.app, this));
    this.addCommand({ id: 'new-card', name: '新建回顾卡', callback: () => new CreateCardModal(this).open() });
    this.records = []; this.stats = summarize([], today()); this.loading = true; this.loadError = ''; this.refreshId = 0;
    this.registerView(MAIN, leaf => new WorkbenchView(leaf, this));
    this.registerView(SIDE, leaf => new NavigationView(leaf, this));
    this.addRibbonIcon('notebook-pen', '回顾工作台', () => this.open());
    this.addCommand({ id: 'open', name: '打开回顾工作台', callback: () => this.open() });
    this.addCommand({ id: 'analyze-current', name: '分析当前回顾卡片', callback: () => { const path = this.app.workspace.getActiveFile()?.path; const record = this.records.find(r => r.path === path); record ? this.open({ selected: path }) : this.open(); } });
    this.registerObsidianProtocolHandler('review-workbench', async params => {
      if (params.vault && params.vault !== this.app.vault.getName()) return;
      await this.open(params.file ? { selected: params.file } : { selected: '' });
    });
    const affectsCards = path => path && (path === this.settings.folder || path.startsWith(this.folderPrefix()) || this.settings.folder.startsWith(path + '/'));
    const invalidate = file => {
      if (!file || affectsCards(file.path)) { clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => this.refresh(), 300); }
    };
    for (const event of ['create', 'modify', 'delete', 'rename']) this.registerEvent(this.app.vault.on(event, (file, oldPath) => { if (affectsCards(oldPath)) invalidate(); else invalidate(file); }));
    this.registerEvent(this.app.metadataCache.on('changed', invalidate));
    this.registerInterval(window.setInterval(() => { if (this.lastDay !== today()) this.refresh(); }, 60000));
    this.app.workspace.onLayoutReady(async () => { await this.refresh(); });
  }
  onunload() { clearTimeout(this.refreshTimer); this.refreshId++; }
  folderPrefix() { return this.settings.folder + '/'; }
  categories() { return [...new Set(['概念', '方法', '实践', '其他', ...this.records.map(record => record.category)])]; }
  updateSettings(patch) { return queueSettings(this, patch); }
  async setFolder(value) {
    await this.updateSettings({ folder: normalizeFolder(value) });
    const view = this.mainView(); if (view) { view.practice = null; view.route.selected = ''; }
    await this.refresh();
  }
  mainView() { const view = this.app.workspace.getLeavesOfType(MAIN)[0]?.view; return view instanceof WorkbenchView ? view : undefined; }
  renderSidebar() { for (const leaf of this.app.workspace.getLeavesOfType(SIDE)) if (leaf.view instanceof NavigationView) leaf.view.render(); }
  async refresh() {
    const id = ++this.refreshId;
    try {
      const files = this.app.vault.getMarkdownFiles().filter(f => f.path.startsWith(this.folderPrefix()) && f.basename !== 'README');
      const records = await Promise.all(files.map(async file => parseNote(file.path, await this.app.vault.cachedRead(file), this.app.metadataCache.getFileCache(file)?.frontmatter || {})));
      if (id !== this.refreshId) return;
      this.records = records.sort((a, b) => (b.created || '').localeCompare(a.created || '') || a.title.localeCompare(b.title, 'zh-CN'));
      this.lastDay = today(); this.stats = summarize(this.records, this.lastDay); this.loadError = '';
    } catch (error) { if (id !== this.refreshId) return; console.error('读取回顾卡片', error); this.loadError = '读取笔记时出现问题，请稍后重试。'; }
    if (id !== this.refreshId) return;
    this.loading = false;
    for (const leaf of this.app.workspace.getLeavesOfType(MAIN)) { if (!(leaf.view instanceof WorkbenchView)) continue; leaf.view.keepScroll = true; if (!leaf.view.practice) leaf.view.render(); }
    this.renderSidebar();
  }
  async open(route) {
    let leaf = this.app.workspace.getLeavesOfType(MAIN)[0];
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: MAIN, active: true }); }
    await this.app.workspace.revealLeaf(leaf);
    if (route && leaf.view instanceof WorkbenchView) leaf.view.go(route);
    let side = this.app.workspace.getLeavesOfType(SIDE)[0];
    if (!side) { side = this.app.workspace.getLeftLeaf(false); if (side) await side.setViewState({ type: SIDE, active: true }); }
    this.app.workspace.leftSplit?.expand(); if (side) await this.app.workspace.revealLeaf(side);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    return leaf;
  }
  async openNote(path, edit = false) {
    const file = this.app.vault.getAbstractFileByPath(path); if (!(file instanceof TFile)) throw new Error('找不到原笔记，请刷新目录。');
    const leaf = this.app.workspace.getLeaf('tab'); await leaf.openFile(file, { state: { mode: edit ? 'source' : 'preview' } }); return leaf;
  }
  async scheduledReview(record) {
    const sr = this.app.plugins.getPlugin('obsidian-spaced-repetition');
    if (!sr) throw new Error('间隔复习插件尚未启用。');
    if (this.reviewOpening || this.app.workspace.containerEl.ownerDocument.querySelector('.sr-view')) {
      new Notice('已有复习窗口，请先完成或关闭它。'); return;
    }
    const file = this.app.vault.getAbstractFileByPath(record.path);
    if (!(file instanceof TFile)) throw new Error('原笔记已移动，请刷新后重试。');
    this.reviewOpening = true;
    try {
      await this.openNote(record.path);
      const ok = this.app.commands.executeCommandById('obsidian-spaced-repetition:srs-review-flashcards-in-note');
      if (!ok) throw new Error('此版本未提供单篇卡片复习命令，请从 Spaced Repetition 的命令面板启动。');
    } finally { this.reviewOpening = false; }
  }
};
