'use strict';
const { Plugin, Modal, FuzzySuggestModal, Notice, TFile, setIcon } = require('obsidian');
const { compact, pageNumber, selectionSubpath, pageSubpath, flattenOutline, resolveDestination, findPosition, saveBookmark } = require('./core');

function isPdf(view) { return view?.getViewType?.() === 'pdf' && view.file?.extension?.toLowerCase() === 'pdf'; }
function nativeBookmarks(app) { return app.internalPlugins?.plugins?.bookmarks?.instance; }
function documentFor(view) { return view?.containerEl?.ownerDocument || document; }
function showError(error) { console.error('PDF 位置书签', error); new Notice(error?.message || '无法读取 PDF 位置，请稍后再试。', 5500); }
function locationLabel(location) {
  if (location.kind === 'selection') return '文字选区';
  if (location.kind === 'annotation') return 'PDF 批注';
  if (location.kind === 'outline') return location.hasOffset ? '目录中的具体位置' : '目录对应页';
  return location.hasOffset ? '当前页与阅读位置' : '当前页';
}

class SaveLocationModal extends Modal {
  constructor(plugin, location) { super(plugin.app); this.owner = plugin; this.location = location; }
  onOpen() {
    const loc = this.location;
    this.setTitle('收藏 PDF 位置');
    this.contentEl.addClass('plb-modal');
    const summary = this.contentEl.createDiv({ cls: 'plb-summary' });
    summary.createEl('strong', { text: loc.book });
    summary.createDiv({ cls: 'plb-meta', text: `第 ${loc.page} 页 · ${locationLabel(loc)}` });
    if (loc.kind === 'page') this.contentEl.createEl('p', { cls: 'plb-hint', text: '没有检测到可定位的文字选区或批注。这次只收藏当前页及可用的阅读位置，不包含文字选区。' });
    if (loc.kind === 'selection' && loc.text) this.contentEl.createEl('blockquote', { cls: 'plb-excerpt', text: compact(loc.text, 220) });
    const duplicate = findPosition(nativeBookmarks(this.app)?.items, loc.path, loc.subpath);
    if (duplicate) this.contentEl.createEl('p', { cls: 'plb-hint', text: '这个位置已经收藏。保存会更新原书签标题，不会重复添加。' });
    const label = this.contentEl.createEl('label', { cls: 'plb-label', text: '书签标题', attr: { for: 'plb-bookmark-title' } });
    const input = this.contentEl.createEl('input', { cls: 'plb-title-input', attr: { id: 'plb-bookmark-title', type: 'text', maxlength: '180', placeholder: '以后能一眼认出的标题' } });
    input.value = duplicate?.title || loc.title || `第 ${loc.page} 页`;
    const actions = this.contentEl.createDiv({ cls: 'plb-actions' });
    const cancel = actions.createEl('button', { text: '取消', attr: { type: 'button' } }); cancel.onclick = () => this.close();
    const save = actions.createEl('button', { text: duplicate ? '更新标题' : '保存书签', cls: 'mod-cta', attr: { type: 'button' } });
    save.onclick = async () => {
      if (save.disabled) return;
      try {
        if (!input.value.trim()) { new Notice('请填写一个书签标题。'); input.focus(); return; }
        const file = this.app.vault.getAbstractFileByPath(loc.path);
        if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'pdf') throw new Error('这份 PDF 已移动或移除，请重新打开后收藏。');
        save.disabled = true; cancel.disabled = true; input.disabled = true;
        save.textContent = '保存中…';
        const native = nativeBookmarks(this.app);
        const result = await saveBookmark(native, loc, input.value);
        new Notice(result.reused ? '已更新原有 PDF 位置书签。' : `已收藏：${loc.book} · 第 ${loc.page} 页`);
        this.close(); this.owner.sync();
      } catch (error) {
        save.disabled = false; cancel.disabled = false; input.disabled = false;
        save.textContent = duplicate ? '更新标题' : '保存书签'; showError(error);
      }
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save.click(); } });
    input.focus(); input.select();
  }
  onClose() { this.contentEl.empty(); }
}

class OutlinePicker extends FuzzySuggestModal {
  constructor(plugin, view, pdfDocument, items) {
    super(plugin.app); this.owner = plugin; this.view = view; this.pdfDocument = pdfDocument; this.items = items;
    this.setPlaceholder(`搜索《${view.file.basename}》的章节`);
    this.setInstructions([{ command: '↑ ↓', purpose: '选择章节' }, { command: 'Enter', purpose: '确认位置与标题' }, { command: 'Esc', purpose: '取消' }]);
  }
  getItems() { return this.items; }
  getItemText(item) { return item.trail.join(' / '); }
  renderSuggestion(match, el) {
    el.addClass('plb-outline-result');
    el.createDiv({ cls: 'plb-outline-title', text: match.item.title });
    if (match.item.trail.length > 1) el.createDiv({ cls: 'plb-outline-trail', text: match.item.trail.slice(0, -1).join(' › ') });
  }
  async onChooseItem(item) {
    try {
      const file = this.view.file;
      if (!file || this.view.viewer?.child?.pdfViewer?.pdfViewer?.pdfDocument !== this.pdfDocument) throw new Error('PDF 已切换，请重新打开目录选择。');
      const resolved = await resolveDestination(item.dest, this.pdfDocument);
      new SaveLocationModal(this.owner, { ...resolved, path: file.path, book: file.basename, title: item.title, kind: 'outline' }).open();
    } catch (error) { showError(error); }
  }
}

module.exports = class PdfLocationBookmarks extends Plugin {
  async onload() {
    this.panels = new Map(); this.headerActions = new Map(); this.lastPdf = null;
    this.addCommand({ id: 'bookmark-current-pdf-location', name: '收藏当前 PDF 位置', callback: () => this.bookmarkCurrent() });
    this.addCommand({ id: 'bookmark-from-pdf-outline', name: '从当前 PDF 目录挑选位置', callback: () => this.chooseOutline() });
    this.registerEvent(this.app.workspace.on('active-leaf-change', leaf => { if (isPdf(leaf?.view)) this.lastPdf = leaf.view; this.sync(); }));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.sync()));
    this.registerEvent(this.app.workspace.on('file-open', () => this.sync()));
    this.app.workspace.onLayoutReady(() => this.sync());
  }
  currentPdf() {
    const views = this.app.workspace.getLeavesOfType('pdf').map(leaf => leaf.view).filter(isPdf);
    const active = this.app.workspace.activeLeaf?.view;
    if (isPdf(active)) { this.lastPdf = active; return active; }
    const recent = this.app.workspace.getMostRecentLeaf()?.view;
    if (isPdf(recent) && views.includes(recent)) { this.lastPdf = recent; return recent; }
    if (this.lastPdf && views.includes(this.lastPdf)) return this.lastPdf;
    this.lastPdf = views.sort((a, b) => (b.leaf.activeTime || 0) - (a.leaf.activeTime || 0))[0] || null;
    return this.lastPdf;
  }
  sync() {
    const current = this.currentPdf();
    const bookmarkViews = this.app.workspace.getLeavesOfType('bookmarks').map(leaf => leaf.view);
    for (const [view, panel] of this.panels) if (!bookmarkViews.includes(view)) { panel.remove(); this.panels.delete(view); }
    for (const view of bookmarkViews) {
      let panel = this.panels.get(view);
      if (!panel || !panel.isConnected) {
        panel?.remove(); panel = this.makePanel(view); this.panels.set(view, panel);
      }
      const label = panel.querySelector('.plb-current-book');
      label.textContent = current ? current.file.basename : '先打开一份 PDF';
      label.title = current ? current.file.basename : '';
      for (const button of panel.querySelectorAll('button')) button.disabled = !current;
    }
    const pdfViews = this.app.workspace.getLeavesOfType('pdf').map(leaf => leaf.view).filter(isPdf);
    for (const [view, action] of this.headerActions) if (!pdfViews.includes(view)) { action.remove(); this.headerActions.delete(view); }
    for (const view of pdfViews) {
      if (this.headerActions.get(view)?.isConnected) continue;
      let snapshot = null;
      const action = view.addAction('bookmark-plus', '收藏 PDF 当前位置', event => { this.bookmarkCurrent(view, event?.detail && snapshot && Date.now() - snapshot.at < 1500 ? snapshot.location : null); snapshot = null; });
      action.addClass('plb-header-action');
      this.registerDomEvent(action, 'mousedown', event => { if (event.button === 0) { event.preventDefault(); snapshot = { location: this.tryCapture(view), at: Date.now() }; } });
      this.registerDomEvent(action, 'mouseleave', () => { snapshot = null; });
      this.headerActions.set(view, action);
    }
  }
  makePanel(view) {
    const panel = documentFor(view).createElement('section'); panel.className = 'plb-panel'; panel.setAttribute('aria-label', 'PDF 位置书签');
    const title = panel.createDiv({ cls: 'plb-panel-heading' }); const glyph = title.createSpan({ cls: 'plb-icon', attr: { 'aria-hidden': 'true' } }); setIcon(glyph, 'bookmark'); title.createEl('strong', { text: 'PDF 位置书签' });
    panel.createEl('p', { cls: 'plb-description', text: '把页码、选区和目录位置留在这里。' });
    const current = panel.createDiv({ cls: 'plb-current' }); current.createSpan({ cls: 'plb-current-label', text: '当前阅读' }); current.createEl('strong', { cls: 'plb-current-book' });
    const actions = panel.createDiv({ cls: 'plb-panel-actions' });
    const save = actions.createEl('button', { cls: 'plb-button plb-primary', text: '收藏当前位置', attr: { type: 'button' } });
    const outline = actions.createEl('button', { cls: 'plb-button', text: '从目录挑选', attr: { type: 'button' } });
    let snapshot = null;
    this.registerDomEvent(save, 'mousedown', event => { if (event.button === 0) { event.preventDefault(); const view = this.currentPdf(); snapshot = { view, location: this.tryCapture(view), at: Date.now() }; } });
    this.registerDomEvent(save, 'mouseleave', () => { snapshot = null; });
    this.registerDomEvent(save, 'click', event => {
      const view = this.currentPdf();
      const location = event.detail && snapshot?.view === view && Date.now() - snapshot.at < 1500 ? snapshot.location : null;
      this.bookmarkCurrent(view, location); snapshot = null;
    });
    this.registerDomEvent(outline, 'click', () => this.chooseOutline());
    view.containerEl.insertBefore(panel, view.contentEl);
    return panel;
  }
  tryCapture(view) { try { return this.capture(view); } catch (_) { return null; } }
  capture(view = this.currentPdf()) {
    if (!isPdf(view)) throw new Error('请先打开一份 PDF，再收藏阅读位置。');
    const child = view.viewer?.child;
    const pdfViewer = child?.pdfViewer?.pdfViewer;
    if (!child || !pdfViewer?.pdfDocument) throw new Error('PDF 还在加载，请稍后再收藏。');
    const base = { path: view.file.path, book: view.file.basename };
    const lib = this.app.plugins.getPlugin('pdf-plus')?.lib;
    const selection = documentFor(view).getSelection();
    // A selection is accepted only when both endpoints really belong to this PDF.
    if (lib?.copyLink?.getPageAndTextRangeFromSelection && selection?.rangeCount && !selection.isCollapsed) {
      const range = selection.getRangeAt(0);
      if (view.containerEl.contains(range.startContainer) && view.containerEl.contains(range.endContainer)) {
        try {
          const owner = lib.getPDFViewerChildFromSelection?.(selection);
          const info = lib.copyLink.getPageAndTextRangeFromSelection(selection);
          const subpath = selectionSubpath(info);
          if (owner === child && subpath && info.page <= pdfViewer.pdfDocument.numPages) {
            const text = selection.toString();
            return { ...base, page: info.page, subpath, text, kind: 'selection', title: compact(text) || `第 ${info.page} 页 · 文字选区` };
          }
        } catch (error) { console.debug('PDF 位置书签：无法获取文字选区，检查当前批注或页码。', error); }
      }
    }
    try {
      const annotation = lib?.copyLink?.getAnnotationLinkInfo?.();
      const popup = annotation?.child?.activeAnnotationPopupEl;
      const page = pageNumber(annotation?.page);
      if (annotation?.child === child && popup?.isConnected && view.containerEl.contains(popup) && page && page <= pdfViewer.pdfDocument.numPages && annotation.id) {
        return { ...base, page, subpath: `#page=${page}&annotation=${encodeURIComponent(annotation.id)}`, kind: 'annotation', title: `第 ${page} 页 · 批注` };
      }
    } catch (error) { console.debug('PDF 位置书签：没有可定位的批注，使用当前页。', error); }
    const state = view.getState();
    const page = pageNumber(state.page) || pageNumber(pdfViewer.currentPageNumber);
    if (!page || page > pdfViewer.pdfDocument.numPages) throw new Error('暂时无法确认当前页码，请等 PDF 显示后重试。');
    const subpath = pageSubpath({ ...state, page });
    return { ...base, page, subpath, kind: 'page', hasOffset: subpath.includes('&offset='), title: `第 ${page} 页` };
  }
  bookmarkCurrent(view = this.currentPdf(), snapshot = null) {
    try {
      const location = snapshot && snapshot.path === view?.file?.path ? snapshot : this.capture(view);
      new SaveLocationModal(this, location).open();
    } catch (error) { showError(error); }
  }
  async chooseOutline(view = this.currentPdf()) {
    try {
      if (!isPdf(view)) throw new Error('请先打开一份 PDF，再从目录挑选位置。');
      const pdfDocument = view.viewer?.child?.pdfViewer?.pdfViewer?.pdfDocument;
      if (!pdfDocument) throw new Error('PDF 还在加载，请稍后再打开目录。');
      const outline = await pdfDocument.getOutline();
      const items = flattenOutline(outline);
      if (!items.length) { new Notice('这份 PDF 没有可收藏的内部目录。可以使用“收藏当前位置”保存当前页。', 5500); return; }
      new OutlinePicker(this, view, pdfDocument, items).open();
    } catch (error) { showError(error); }
  }
  onunload() {
    for (const panel of this.panels.values()) panel.remove();
    for (const action of this.headerActions.values()) action.remove();
    this.panels.clear(); this.headerActions.clear(); this.lastPdf = null;
  }
};
