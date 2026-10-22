'use strict';
const { ItemView, Modal, Notice, Setting, TFolder, setIcon, getAllTags } = require('obsidian');
const { DEFAULT_WORKFLOW, validateWorkflowSettings, localDate, weekRange, templateFolder, createCapture, moveInboxNote, undoMove, createWeeklyReview } = require('./workflow');
const { normalizeJourney, recordJourney, undoJourneyMove, journeyStatus, saveReflection } = require('./journey');
const HERO_IMAGE = '__ZHIXING_HERO_DATA_URL__';
const DESK = 'zhixing-notes-desk';
const inside = (path, folder) => path.startsWith(folder + '/');
const FOLDERS = [['inbox', '收集箱'], ['notes', '长期笔记'], ['projects', '项目'], ['archive', '归档'], ['weekly', '每周回顾']];
function action(parent, label, fn, primary = false) {
  const el = parent.createEl('button', { text: label, cls: primary ? 'mod-cta' : '', attr: { type: 'button' } });
  el.addEventListener('click', async () => {
    if (el.disabled) return;
    el.disabled = true;
    try { await fn(); } catch (e) { new Notice(e.message || '操作未完成，请重试。', 6000); }
    finally { el.disabled = false; }
  });
  return el;
}
function reviewTagged(app, file) { return (getAllTags(app.metadataCache.getFileCache(file) || {}) || []).some(tag => tag === '#待回顾' || tag.startsWith('#待回顾/')); }
function excerpt(text) {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').replace(/!\[\[[^\]]*\]\]/g, '[附件]').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, alias) => alias || path).replace(/^#{1,6}\s+/gm, '').trim().slice(0, 200);
}
async function openFile(plugin, file) {
  if (plugin.app.vault.getAbstractFileByPath(file.path) !== file) throw new Error('这篇笔记已移动或删除，请刷新后重试。');
  const existing = plugin.app.workspace.getLeavesOfType('markdown').find(leaf => leaf.view.file === file || leaf.getViewState?.().state?.file === file.path);
  if (existing) return plugin.app.workspace.revealLeaf(existing);
  const leaf = plugin.app.workspace.getLeaf('tab');
  await leaf.openFile(file);
  await plugin.app.workspace.revealLeaf(leaf);
}
class CaptureModal extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.saving = false; this.shortcuts = []; }
  close() { if (!this.saving) super.close(); }
  onOpen() {
    this.setTitle('快速记录');
    this.contentEl.addClass('zn-capture');
    this.contentEl.createEl('p', { cls: 'zn-muted', text: '先写下来，晚一点再整理。保存到 ' + this.plugin.workflowSettings.inbox });
    const titleLabel = this.contentEl.createEl('label', { text: '标题（可选）', cls: 'zn-field' });
    const title = titleLabel.createEl('input', { type: 'text', attr: { placeholder: '留空时使用正文第一行', maxlength: '100' } });
    const bodyLabel = this.contentEl.createEl('label', { text: '想记下什么', cls: 'zn-field' });
    const body = bodyLabel.createEl('textarea', { attr: { placeholder: '一句想法、一段读书感受，或者一条 - [ ] 待办', rows: '7' } });
    const error = this.contentEl.createDiv({ cls: 'zn-error', attr: { role: 'alert' } });
    body.addEventListener('input', () => error.empty());
    const controls = this.contentEl.createDiv({ cls: 'zn-actions' });
    const cancel = action(controls, '取消', () => this.close());
    const save = action(controls, '保存到收集箱', async () => {
      if (this.saving) return;
      this.saving = true;
      title.disabled = body.disabled = cancel.disabled = true;
      error.empty();
      let file;
      try {
        file = await createCapture(this.app.vault, this.plugin.workflowSettings, { title: title.value, body: body.value }, new Date());
      } catch (e) {
        error.setText(e.message || '保存失败，内容还在这里，请重试。');
        return;
      } finally {
        this.saving = false;
        title.disabled = body.disabled = cancel.disabled = false;
      }
      this.close();
      await this.plugin.completeJourney?.('capture', { path: file.path });
      this.plugin.refreshDesk();
      new Notice('已保存：' + file.basename);
    }, true);
    this.shortcuts = [
      this.scope.register(['Mod'], 'Enter', () => { if (!save.disabled) save.click(); return false; }),
      this.scope.register([], 'Escape', () => { this.close(); return false; })
    ];
    body.focus();
  }
  onClose() {
    for (const shortcut of this.shortcuts) this.scope.unregister(shortcut);
    this.shortcuts = [];
    this.contentEl.empty();
  }
}
class ReflectionModal extends CaptureModal {
  onOpen() {
    this.setTitle('留下一句本周收获');
    this.contentEl.addClass('zn-capture');
    this.contentEl.createEl('p', { cls: 'zn-muted', text: '什么值得留下？至少写 10 个字，会追加到本周回顾里。' });
    const label = this.contentEl.createEl('label', { cls: 'zn-field', text: '写给下次打开笔记的自己' });
    const body = label.createEl('textarea', { attr: { rows: '6', maxlength: '4000', placeholder: '例如：把整理相册拆成“先挑三张照片”，比一直等有空更容易开始。' } });
    const error = this.contentEl.createDiv({ cls: 'zn-error', attr: { role: 'alert' } });
    body.addEventListener('input', () => error.empty());
    const controls = this.contentEl.createDiv({ cls: 'zn-actions' });
    const cancel = action(controls, '再想一想', () => this.close());
    let existingFile;
    const recover = action(controls, '复制草稿并打开回顾', async () => {
      if (!existingFile || this.saving) return;
      this.saving = true; body.disabled = cancel.disabled = save.disabled = true;
      try { await navigator.clipboard.writeText(body.value); }
      finally { this.saving = false; body.disabled = cancel.disabled = save.disabled = false; }
      this.close(); await openFile(this.plugin, existingFile);
      new Notice('草稿已复制，可以粘贴到原回顾中继续编辑。');
    });
    recover.hidden = true;
    const save = action(controls, '保存收获，点亮星章', async () => {
      if (this.saving) return;
      this.saving = true; body.disabled = cancel.disabled = recover.disabled = true; error.empty();
      const date = new Date();
      let result, recorded;
      try {
        result = await saveReflection(this.app, this.plugin.workflowSettings, body.value, date);
        recorded = await this.plugin.completeJourney('reflect', { path: result.file.path }, date);
      }
      catch (e) { error.setText(e.message || '保存失败，内容还在这里。'); return; }
      finally { this.saving = false; body.disabled = cancel.disabled = recover.disabled = false; }
      this.plugin.refreshDesk();
      if (!result.created) {
        existingFile = result.file; recover.hidden = false;
        error.setText('本周已有收获，这段新草稿尚未保存。可以复制后在原文中补充。');
        return;
      }
      this.close();
      new Notice(recorded ? '本周收获已保存，回顾星章已点亮。' : '本周收获已保存；进度保存失败，稍后可以重试。');
      await openFile(this.plugin, result.file);
    }, true);
    this.shortcuts = [this.scope.register(['Mod'], 'Enter', () => { if (!save.disabled) save.click(); return false; }), this.scope.register([], 'Escape', () => { this.close(); return false; })];
  }
}
class DeskView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.tab = 'inbox'; this.query = ''; this.limit = 20; this.renderId = 0; }
  getViewType() { return DESK; }
  getDisplayText() { return '知行工作台'; }
  getIcon() { return 'house'; }
  async onOpen() { this.contentEl.addClass('zn-desk'); this.shell(); this.refresh(); }
  onClose() { this.renderId++; }
  shell() {
    const root = this.contentEl; root.empty();
    root.setAttribute('aria-label', '知行工作台');
    const top = root.createDiv({ cls: 'zn-topbar' });
    const brand = top.createDiv({ cls: 'zn-brand' });
    setIcon(brand.createSpan({ cls: 'zn-brand-mark' }), 'compass');
    brand.createSpan({ text: '知行 · 灵感远征' });
    const tools = top.createDiv({ cls: 'zn-actions' });
    action(tools, '回顾卡片', () => this.plugin.open());
    this.modeButton = action(tools, '专注模式', async () => {
      await this.plugin.updateSettings(current => ({ journey: { ...normalizeJourney(current.journey), mode: normalizeJourney(current.journey).mode === 'focus' ? 'adventure' : 'focus' } }));
      this.plugin.refreshDesk();
    });
    const header = root.createDiv({ cls: 'zn-header' });
    const art = header.createDiv({ cls: 'zn-world', attr: { 'aria-hidden': 'true' } });
    art.style.backgroundImage = 'url("' + HERO_IMAGE + '")';
    const intro = header.createDiv({ cls: 'zn-hero-copy' });
    this.dateEl = intro.createDiv({ cls: 'zn-eyebrow', text: '知行笔记 / ' + localDate(new Date()) });
    this.titleEl = intro.createEl('h1', { text: '让灵感，\n成为你的下一站。' });
    this.subtitleEl = intro.createEl('p', { cls: 'zn-muted', text: '每记下一点，每整理一页，都离自己的答案更近。' });
    const buttons = intro.createDiv({ cls: 'zn-actions zn-hero-actions' });
    action(buttons, '＋ 快速记录', () => new CaptureModal(this.plugin).open(), true);
    action(buttons, '本周回顾', () => this.plugin.openWeekly());
    this.progressEl = header.createDiv({ cls: 'zn-journey-progress', attr: { 'aria-live': 'polite' } });
    this.journeyEl = root.createDiv({ cls: 'zn-journey' });
    this.noticeEl = root.createDiv({ cls: 'zn-notice', attr: { 'aria-live': 'polite' } });
    const library = root.createDiv({ cls: 'zn-library-heading' });
    library.createEl('h2', { text: '我的笔记' });
    this.statsEl = library.createDiv({ cls: 'zn-stats' });
    const toolbar = root.createDiv({ cls: 'zn-toolbar' });
    this.tabsEl = toolbar.createDiv({ cls: 'zn-tabs', attr: { role: 'group', 'aria-label': '笔记范围' } });
    this.tabButtons = {};
    for (const [key, label] of [['inbox', '收集箱'], ['review', '待回顾'], ['recent', '本周修改']]) {
      const btn = action(this.tabsEl, label, () => { this.tab = key; this.limit = 20; this.renderList(); });
      this.tabButtons[key] = btn;
    }
    const searchLabel = toolbar.createEl('label', { cls: 'zn-search', text: '查找 ' });
    this.search = searchLabel.createEl('input', { type: 'search', attr: { placeholder: '按标题或路径查找', 'aria-label': '按标题或路径查找笔记' } });
    this.search.addEventListener('input', () => { this.query = this.search.value; this.limit = 20; this.renderList(); });
    this.hintEl = root.createEl('p', { cls: 'zn-muted' });
    this.listEl = root.createDiv({ cls: 'zn-list', attr: { 'aria-live': 'polite' } });
    const footer = root.createDiv({ cls: 'zn-footer' });
    footer.createSpan({ text: '本地 Markdown · 随时可以停下，下次接着走。' });
    action(footer, '重新读取', () => this.refresh());
    action(footer, '使用方法', () => this.showHelp());
  }
  renderJourney() {
    const state = journeyStatus(this.plugin.journey, new Date());
    const focus = normalizeJourney(this.plugin.journey).mode === 'focus';
    this.contentEl.toggleClass('zn-focus', focus);
    this.modeButton.setText(focus ? '探索模式' : '专注模式');
    this.modeButton.setAttribute('aria-pressed', String(focus));
    this.titleEl.setText(focus ? '今天先记下来' : '让灵感，\n成为你的下一站。');
    this.subtitleEl.setText(focus ? '有空时整理一条，周末再看看留下了什么。' : '每记下一点，每整理一页，都离自己的答案更近。');
    this.progressEl.empty();
    this.progressEl.createDiv({ cls: 'zn-progress-label', text: '本周星章' });
    const stars = this.progressEl.createDiv({ cls: 'zn-stars', attr: { 'aria-label': '已点亮 ' + state.done + ' 枚，共 3 枚星章' } });
    for (const key of ['capture', 'organize', 'reflect']) { const star = stars.createSpan({ cls: state.steps[key] ? 'is-lit' : '' }); setIcon(star, 'star'); }
    this.progressEl.createSpan({ cls: 'zn-progress-count', text: state.done + ' / 3' });
    this.journeyEl.empty();
    const heading = this.journeyEl.createDiv({ cls: 'zn-journey-heading' });
    heading.createEl('h2', { text: state.done === 3 ? '本周旅程已完成' : '本周旅程' });
    heading.createSpan({ text: state.start.slice(5) + ' — ' + state.end.slice(5) + ' · 每关一枚星章，可自由选择顺序' });
    const route = this.journeyEl.createDiv({ cls: 'zn-route' });
    const stages = [
      { key: 'capture', icon: 'feather', place: '拾光林地', title: '记下一束灵感', detail: '保存一条自己的想法。', button: '开始记录', run: () => new CaptureModal(this.plugin).open() },
      { key: 'organize', icon: 'compass', place: '整理工坊', title: '给笔记一个去处', detail: '从收集箱整理出一篇。', button: '去整理', run: () => {
        this.tab = 'inbox'; this.query = ''; this.search.value = ''; this.limit = 20; this.renderList();
        this.listEl.scrollIntoView({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
        if (!this.groups.inbox.length) new Notice('收集箱是空的，可以先快速记录一条想法。');
      } },
      { key: 'reflect', icon: 'telescope', place: '回望灯塔', title: '留下一句收获', detail: '写给下次打开笔记的自己。', button: '写一句回顾', run: () => state.steps.reflect ? this.plugin.openWeekly() : new ReflectionModal(this.plugin).open() }
    ];
    const current = stages.find(stage => !state.steps[stage.key])?.key;
    for (const [i, stage] of stages.entries()) {
      const done = state.steps[stage.key];
      const card = route.createEl('article', { cls: 'zn-stage' + (done ? ' is-complete' : stage.key === current ? ' is-current' : '') });
      if (this.plugin.lastJourneyAward?.kind === stage.key && Date.now() - this.plugin.lastJourneyAward.at < 1800) card.addClass('is-awarded');
      const seal = card.createDiv({ cls: 'zn-stage-seal' }); setIcon(seal, done ? 'check' : stage.icon);
      card.createDiv({ cls: 'zn-stage-label', text: '0' + (i + 1) + ' / ' + stage.place });
      card.createEl('h3', { text: stage.title });
      card.createEl('p', { text: stage.detail });
      const bottom = card.createDiv({ cls: 'zn-stage-bottom' });
      bottom.createSpan({ cls: 'zn-stage-state', text: done ? '✦ 已点亮' : stage.key === current ? '当前关卡' : '尚未点亮' });
      action(bottom, done ? stage.key === 'reflect' ? '查看收获' : '再走一程' : stage.button, stage.run, !done && stage.key === current);
    }
    if (state.done === 3) this.journeyEl.createDiv({ cls: 'zn-completion', text: '✦ 记录、整理、回顾，都有了自己的痕迹。下周再出发。' });
  }
  showHelp() {
    const modal = new Modal(this.app); modal.setTitle('从记录到回顾');
    const list = modal.contentEl.createEl('ol');
    for (const text of [
      '快速记录：写一句话即可保存，标题可以留空。Ctrl / ⌘ + Enter 也能保存。',
      '整理收集箱：保留为笔记、变成项目，或先归档。移动的是原文件，不复制一份；需要时点上方“撤销移动”。',
      '待回顾：给任意笔记加 #待回顾，就能在这里找到。看完后在原笔记中移除标签。',
      '本周回顾：生成当前收集箱、待回顾和本周修改笔记的链接快照。同一周再次点击只打开已有记录，不覆盖你的文字。每周从本地时间的周一开始。',
      '使用已有库：在设置 → 知行工作台中选择自己的目录。不需要复制示例库，也不会替换原库设置。'
    ]) list.createEl('li', { text });
    list.createEl('li', { text: '每周旅程：成功保存记录、整理一篇、保存至少 10 字的收获，各点亮一枚星章。打开页面不计进度；撤销对应整理会熄灭该星章。进度只存在本地插件配置，专注模式可以收起地图。' });
    action(modal.contentEl, '开始记录', () => { modal.close(); new CaptureModal(this.plugin).open(); }, true);
    modal.open();
  }
  refresh() {
    try {
      const s = this.plugin.workflowSettings; const range = weekRange(new Date());
      this.dateEl.setText('知行笔记 / ' + localDate(new Date()));
      const all = this.app.vault.getMarkdownFiles();
      const excluded = f => [s.archive, s.weekly, '90_模板', templateFolder(this.app)].some(folder => inside(f.path, folder));
      this.groups = {
        inbox: all.filter(f => inside(f.path, s.inbox)),
        review: all.filter(f => !excluded(f) && reviewTagged(this.app, f)),
        recent: all.filter(f => !excluded(f) && [s.inbox, s.notes, s.projects].some(folder => inside(f.path, folder)) && f.stat.mtime >= range.fromMs && f.stat.mtime < range.toMs)
      };
      for (const list of Object.values(this.groups)) list.sort((a, b) => b.stat.mtime - a.stat.mtime || a.path.localeCompare(b.path, 'zh-CN'));
      this.renderJourney();
      this.statsEl.empty();
      for (const [key, label] of [['inbox', '条待整理'], ['review', '篇待回顾'], ['recent', '篇本周修改']]) {
        const tile = action(this.statsEl, '', () => { this.tab = key; this.query = ''; this.search.value = ''; this.limit = 20; this.renderList(); });
        tile.createEl('strong', { text: String(this.groups[key].length) }); tile.createSpan({ text: label });
        tile.setAttribute('aria-label', this.groups[key].length + ' ' + label);
      }
      this.renderNotice(); this.renderList();
    } catch (error) {
      this.listEl.empty(); this.listEl.createEl('p', { cls: 'zn-error', text: '读取失败：' + error.message });
      action(this.listEl, '重试', () => this.refresh());
    }
  }
  renderNotice() {
    this.noticeEl.empty();
    const move = this.plugin.lastDeskMove;
    if (!move) { this.noticeEl.hidden = true; return; }
    this.noticeEl.hidden = false;
    this.noticeEl.createSpan({ text: '已移动到 ' + move.to });
    action(this.noticeEl, '撤销移动', async () => {
      await this.plugin.deskMutation(() => undoMove(this.app, move));
      await this.plugin.revertJourneyMove(move);
      this.plugin.lastDeskMove = null; this.plugin.refreshDesk(); new Notice('已移回 ' + move.from);
    });
  }
  async renderList() {
    if (!this.groups) return;
    const id = ++this.renderId;
    for (const [key, btn] of Object.entries(this.tabButtons)) btn.setAttribute('aria-pressed', String(key === this.tab));
    const q = this.query.toLocaleLowerCase().trim();
    const filtered = this.groups[this.tab].filter(f => !q || f.path.toLocaleLowerCase().includes(q));
    const showing = filtered.slice(0, this.limit);
    const hints = { inbox: '先处理一条就好。移到笔记、项目或归档后，它会离开收集箱。', review: '点开笔记回顾。看完后移除 #待回顾 标签，它就会离开这里。', recent: '列出收集箱、笔记和项目中本周修改的记录。导入或同步也可能改变修改时间。' };
    this.hintEl.setText(hints[this.tab] + ' 共 ' + filtered.length + ' 篇。');
    this.listEl.empty();
    if (!filtered.length) {
      const empty = this.listEl.createDiv({ cls: 'zn-empty' });
      const glyph = empty.createDiv({ cls: 'zn-empty-icon' }); setIcon(glyph, q ? 'search' : 'notebook-pen');
      const titles = { inbox: '收集箱已经清空', review: '暂时没有待回顾的笔记', recent: '这一周还没有记录' };
      empty.createEl('h2', { text: q ? '没有找到这条笔记' : titles[this.tab] });
      empty.createEl('p', { cls: 'zn-muted', text: q ? '换一个标题关键词，或者清除筛选。' : this.tab === 'review' ? '在值得再看的笔记里加上 #待回顾，下次从这里打开。' : '写一句想法就能开始，不必先填模板。' });
      if (q) action(empty, '清除筛选', () => { this.query = ''; this.search.value = ''; this.renderList(); });
      else action(empty, '记第一条', () => new CaptureModal(this.plugin).open(), true);
      return;
    }
    this.listEl.createEl('p', { cls: 'zn-muted', text: '正在读取笔记…' });
    const previews = await Promise.all(showing.map(async file => {
      try { return { file, preview: excerpt(await this.app.vault.cachedRead(file)) }; }
      catch (_) { return { file, preview: '暂时无法读取正文，请打开原笔记检查。' }; }
    }));
    if (id !== this.renderId || !this.contentEl.isConnected) return;
    this.listEl.empty();
    for (const { file, preview } of previews) {
      const card = this.listEl.createEl('article', { cls: 'zn-note' });
      const head = card.createDiv({ cls: 'zn-note-head' });
      const title = action(head, file.basename, () => openFile(this.plugin, file)); title.addClass('zn-note-title');
      head.createEl('span', { cls: 'zn-date', text: localDate(new Date(file.stat.mtime)) });
      card.createEl('p', { cls: 'zn-path', text: file.path });
      card.createEl('p', { cls: 'zn-excerpt', text: preview || '空笔记，打开后继续写。' });
      const buttons = card.createDiv({ cls: 'zn-actions' });
      action(buttons, '打开笔记', () => openFile(this.plugin, file));
      if (this.tab === 'inbox') for (const [key, label] of [['notes', '保留为笔记'], ['projects', '变成项目'], ['archive', '归档']]) {
        const move = action(buttons, label, async () => {
          this.plugin.lastDeskMove = await this.plugin.deskMutation(() => moveInboxNote(this.app, this.plugin.workflowSettings, file, key));
          this.plugin.lastDeskMove.journeyDate = new Date();
          await this.plugin.completeJourney('organize', { from: this.plugin.lastDeskMove.from, to: this.plugin.lastDeskMove.to }, this.plugin.lastDeskMove.journeyDate);
          this.plugin.refreshDesk();
        });
        move.setAttribute('title', '移动到 ' + this.plugin.workflowSettings[key] + '，可撤销');
      }
    }
    if (filtered.length > showing.length) action(this.listEl, '再显示 20 篇（还有 ' + (filtered.length - showing.length) + ' 篇）', () => { this.limit += 20; this.renderList(); });
  }
}
function renderDeskSettings(root, plugin) {
  root.createEl('h3', { text: '日常工作台的目录' });
  root.createEl('p', { text: '可以使用已有目录。保存设置不会移动笔记；首次写入时才创建缺失目录。', cls: 'setting-item-description' });
  const draft = { ...plugin.workflowSettings };
  for (const [key, name] of FOLDERS) new Setting(root).setName(name).addText(text => text.setValue(draft[key]).onChange(value => { draft[key] = value; }));
  const status = root.createDiv({ cls: 'zn-error', attr: { role: 'status' } });
  new Setting(root).addButton(button => button.setButtonText('保存工作台目录').setCta().onClick(async () => {
    try {
      const next = validateWorkflowSettings(draft);
      for (const folder of Object.values(next)) { const existing = plugin.app.vault.getAbstractFileByPath(folder); if (existing && !(existing instanceof TFolder)) throw new Error(folder + ' 是文件，请选择文件夹。'); }
      await plugin.updateSettings({ workflow: next }); plugin.lastDeskMove = null; plugin.refreshDesk(); status.empty(); new Notice('工作台目录已保存');
    } catch (e) { status.setText(e.message); }
  }));
}
function installDesk(plugin, saved, savedJourney) {
  plugin.journey = normalizeJourney(savedJourney);
  plugin.completeJourney = async (kind, detail, date = new Date()) => {
    const before = journeyStatus(plugin.journey, date).steps[kind];
    try {
      await plugin.updateSettings(current => ({ journey: recordJourney(current.journey, kind, detail, date) }));
      if (!before && journeyStatus(plugin.journey, date).steps[kind]) plugin.lastJourneyAward = { kind, at: Date.now() };
      return true;
    } catch (e) { new Notice('笔记操作已完成，但本周进度未能保存：' + e.message, 6000); return false; }
  };
  plugin.revertJourneyMove = async move => {
    const date = move.journeyDate || new Date();
    try { await plugin.updateSettings(current => ({ journey: undoJourneyMove(current.journey, move, date) })); }
    catch (e) { new Notice('笔记已移回，但本周进度未能保存：' + e.message, 6000); }
  };
  try { plugin.workflowSettings = validateWorkflowSettings(saved || {}); }
  catch (_) { plugin.workflowSettings = { ...DEFAULT_WORKFLOW }; new Notice('工作台目录配置无效，已恢复默认值。请在设置中检查目录。'); }
  plugin.deskMutation = async fn => {
    if (plugin.deskWriting) throw new Error('上一个文件操作还在进行，请稍后再试。');
    plugin.deskWriting = true;
    try { return await fn(); } finally { plugin.deskWriting = false; }
  };
  plugin.refreshDesk = () => { for (const leaf of plugin.app.workspace.getLeavesOfType(DESK)) if (leaf.view instanceof DeskView) leaf.view.refresh(); };
  plugin.openDesk = async () => {
    let leaf = plugin.app.workspace.getLeavesOfType(DESK)[0];
    if (!leaf) { leaf = plugin.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: DESK, active: true }); }
    await plugin.app.workspace.revealLeaf(leaf);
  };
  plugin.openWeekly = async () => {
    const file = await plugin.deskMutation(() => createWeeklyReview(plugin.app, plugin.workflowSettings, new Date()));
    await openFile(plugin, file);
  };
  plugin.registerView(DESK, leaf => new DeskView(leaf, plugin));
  plugin.addRibbonIcon('house', '知行工作台', () => plugin.openDesk());
  plugin.addCommand({ id: 'open-desk', name: '打开笔记工作台', callback: () => plugin.openDesk() });
  plugin.addCommand({ id: 'quick-capture', name: '快速记录到收集箱', callback: () => new CaptureModal(plugin).open() });
  plugin.addCommand({ id: 'weekly-review', name: '打开本周回顾', callback: () => plugin.openWeekly().catch(e => new Notice(e.message, 6000)) });
  let timer;
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => plugin.refreshDesk(), 250); };
  for (const event of ['create', 'modify', 'delete', 'rename']) plugin.registerEvent(plugin.app.vault.on(event, changed));
  plugin.registerEvent(plugin.app.metadataCache.on('changed', changed));
  let day = localDate(new Date());
  plugin.registerInterval(window.setInterval(() => { const now = localDate(new Date()); if (now !== day) { day = now; plugin.refreshDesk(); } }, 60000));
  plugin.register(() => clearTimeout(timer));
}
module.exports = { installDesk, renderDeskSettings };
