'use strict';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const pageNumber = value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const compact = (text, limit = 70) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);

function selectionSubpath(info) {
  const page = pageNumber(info?.page);
  const range = info?.selection;
  if (!page || !range) return null;
  const values = [range.beginIndex, range.beginOffset, range.endIndex, range.endOffset];
  if (!values.every(value => Number.isInteger(value) && value >= 0)) return null;
  if (values[0] > values[2] || (values[0] === values[2] && values[1] >= values[3])) return null;
  return `#page=${page}&selection=${values.join(',')}`;
}

function pageSubpath(state) {
  const page = pageNumber(state?.page);
  if (!page) return null;
  const base = `#page=${page}`;
  if (!finite(state.left) || !finite(state.top)) return base;
  return `${base}&offset=${state.left},${state.top},${finite(state.zoom) ? state.zoom : 0}`;
}

function canonicalPosition(path, subpath) {
  if (!path || typeof subpath !== 'string' || !subpath.startsWith('#')) return null;
  const params = new URLSearchParams(subpath.slice(1));
  const page = pageNumber(params.get('page'));
  if (!page) return null;
  // Color affects presentation, not the bookmarked reading position.
  const keys = ['selection', 'annotation', 'offset'];
  const position = keys.filter(key => params.has(key)).map(key => {
    if (key !== 'offset') return `${key}=${params.get(key)}`;
    const parts = params.get(key).split(',');
    return 'offset=' + parts.map((value, index) => {
      if (value === '') return index === 2 ? '0' : '';
      const number = Number(value);
      return Number.isFinite(number) ? String(index === 2 ? Math.round(number * 100) / 100 : Math.round(number)) : value;
    }).join(',');
  }).join('&');
  return `${path}#page=${page}${position ? '&' + position : ''}`;
}

function flattenOutline(items, ancestors = []) {
  const result = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue;
    const title = compact(item.title || '未命名章节', 160);
    const trail = [...ancestors, title];
    // Never turn external URLs or launch actions into internal PDF bookmarks.
    if (item.dest && !item.url && !item.unsafeUrl && !item.action) result.push({ title, trail, dest: item.dest });
    result.push(...flattenOutline(item.items, trail));
  }
  return result;
}

async function resolveDestination(dest, pdfDocument) {
  if (!pdfDocument) throw new Error('PDF 尚未加载完成，请稍后再试。');
  const explicit = typeof dest === 'string' ? await pdfDocument.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || explicit.length < 2) throw new Error('这条目录没有可解析的 PDF 位置。');
  const pageIndex = Number.isInteger(explicit[0]) ? explicit[0] : await pdfDocument.getPageIndex(explicit[0]);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || (finite(pdfDocument.numPages) && pageIndex >= pdfDocument.numPages)) throw new Error('目录页码无效，未创建书签。');
  const page = pageIndex + 1;
  const mode = typeof explicit[1] === 'string' ? explicit[1] : explicit[1]?.name;
  let left = '', top = '', zoom = '';
  if (mode === 'XYZ') {
    if (finite(explicit[2])) left = Math.round(explicit[2]);
    if (finite(explicit[3])) top = Math.round(explicit[3]);
    zoom = finite(explicit[4]) ? Math.round(explicit[4] * 100) / 100 : 0;
  } else if (mode === 'FitH' || mode === 'FitBH') {
    if (finite(explicit[2])) top = explicit[2];
  } else if (mode === 'FitV' || mode === 'FitBV') {
    if (finite(explicit[2])) left = explicit[2];
  } else if (mode === 'FitR') {
    if (finite(explicit[2])) left = explicit[2];
    if (finite(explicit[5])) top = explicit[5];
  } else if (mode !== 'Fit' && mode !== 'FitB') {
    throw new Error('这条目录的定位类型暂不支持，未创建书签。');
  }
  const offset = left !== '' || top !== '' || zoom !== '';
  return { page, subpath: `#page=${page}${offset ? `&offset=${left},${top},${zoom}` : ''}`, hasOffset: offset };
}

function findPosition(items, path, subpath) {
  const key = canonicalPosition(path, subpath);
  if (!key) return null;
  for (const item of items || []) {
    if (item.type === 'file' && canonicalPosition(item.path, item.subpath) === key) return item;
    if (item.type === 'group') {
      const nested = findPosition(item.items, path, subpath);
      if (nested) return nested;
    }
  }
  return null;
}

function upsertBookmark(native, location, title, now = Date.now()) {
  if (!native || !Array.isArray(native.items) || typeof native.addItem !== 'function' || typeof native.editItem !== 'function') throw new Error('请先在 Obsidian 核心插件中启用“书签”。');
  const cleaned = compact(title, 180);
  if (!cleaned) throw new Error('请为这处位置填写一个标题。');
  if (!canonicalPosition(location.path, location.subpath)) throw new Error('没有有效的 PDF 页码，未创建书签。');
  const duplicate = findPosition(native.items, location.path, location.subpath);
  if (duplicate) {
    duplicate.title = cleaned;
    native.editItem(duplicate);
    return { item: duplicate, reused: true };
  }
  let root = native.items.find(item => item.type === 'group' && item.pdfLocationRoot === true)
    || native.items.find(item => item.type === 'group' && (item.title === 'PDF 位置' || item.items?.some(group => group.type === 'group' && group.pdfPath)));
  if (!root) { root = { type: 'group', title: 'PDF 位置', pdfLocationRoot: true, ctime: now, items: [] }; native.addItem(root); }
  else if (!root.pdfLocationRoot) { root.pdfLocationRoot = true; native.editItem(root); }
  let group = root.items.find(item => {
    if (item.type !== 'group') return false;
    const members = (item.items || []).filter(child => child.type === 'file');
    // Obsidian updates bookmark file paths on a move, but not our custom marker.
    // Once members exist, their current paths take precedence over stale pdfPath.
    return members.length ? members.some(child => child.path === location.path) : item.pdfPath === location.path;
  });
  if (!group) {
    const titleTaken = root.items.some(item => item.type === 'group' && item.title === location.book);
    const parentFolder = location.path.split('/').slice(-2, -1)[0] || 'PDF';
    group = { type: 'group', title: titleTaken ? `${location.book} · ${parentFolder}` : location.book, pdfPath: location.path, ctime: now, items: [] };
    native.addItem(group, root);
  }
  const item = { type: 'file', path: location.path, subpath: location.subpath, title: cleaned, ctime: now };
  native.addItem(item, group);
  return { item, reused: false };
}

const savesInFlight = new WeakSet();

async function saveBookmark(native, location, title, now = Date.now()) {
  if (!native || typeof native.saveData !== 'function') throw new Error('当前 Obsidian 无法保存原生书签，请检查“书签”核心插件是否已启用。');
  if (!Array.isArray(native.items) || typeof native.addItem !== 'function' || typeof native.editItem !== 'function') {
    throw new Error('当前 Obsidian 的书签接口不可用，请检查核心插件。');
  }
  if (savesInFlight.has(native)) throw new Error('上一条书签还在保存，请稍后再试。');
  const originalItems = native.items;
  const before = new Map();
  const visit = items => { for (const item of items || []) {
    before.set(item, { title: item.title, hasTitle: Object.hasOwn(item, 'title'),
      pdfLocationRoot: item.pdfLocationRoot, hasRoot: Object.hasOwn(item, 'pdfLocationRoot') });
    if (item.type === 'group') visit(item.items);
  } };
  visit(originalItems);
  const added = [], changed = [], pending = [];
  const track = value => {
    if (value && typeof value.then === 'function') {
      const promise = Promise.resolve(value);
      promise.catch(() => {}); // Native mutation APIs may not await their own save.
      pending.push(promise);
    }
    return value;
  };
  const saveData = native.saveData;
  const ownSave = Object.getOwnPropertyDescriptor(native, 'saveData');
  const adapter = { items: originalItems,
    addItem(item, parent) {
      added.push({ item, items: parent ? parent.items : originalItems });
      return track(native.addItem(item, parent));
    },
    editItem(item) {
      const old = before.get(item);
      if (old) changed.push({ item, old, title: item.title, pdfLocationRoot: item.pdfLocationRoot });
      return track(native.editItem(item));
    },
  };
  savesInFlight.add(native);
  try {
    // Observe any saves called synchronously by native add/edit, without changing
    // their arguments or scheduling. Restore the method before the first await.
    native.saveData = function (...args) { return track(saveData.apply(this, args)); };
    let result;
    try { result = upsertBookmark(adapter, location, title, now); }
    finally {
      if (ownSave) Object.defineProperty(native, 'saveData', ownSave);
      else delete native.saveData;
    }
    const outcomes = await Promise.allSettled(pending);
    const failure = outcomes.find(item => item.status === 'rejected');
    if (failure) throw failure.reason;
    // Native add/edit may save intermediate snapshots. Finish those writes first
    // so a late empty-group snapshot cannot overwrite the complete bookmark.
    await saveData.call(native);
    return result;
  } catch (error) {
    await Promise.allSettled(pending);
    // Revert only this operation, preserving unrelated edits made while saving.
    // If the native plugin reloaded its entire tree, leave the new tree alone.
    if (native.items === originalItems) {
      for (const { item, old, title: writtenTitle, pdfLocationRoot: writtenRoot } of changed.reverse()) {
        if (item.title === writtenTitle && old.title !== writtenTitle) {
          if (old.hasTitle) item.title = old.title; else delete item.title;
        }
        if (item.pdfLocationRoot === writtenRoot && old.pdfLocationRoot !== writtenRoot) {
          if (old.hasRoot) item.pdfLocationRoot = old.pdfLocationRoot; else delete item.pdfLocationRoot;
        }
      }
      for (const { item, items } of added.reverse()) {
        const index = items.indexOf(item);
        if (index >= 0 && (item.type !== 'group' || !item.items?.length)) items.splice(index, 1);
      }
      if (added.length || changed.length) {
        try { await saveData.call(native); }
        catch (_) { throw new Error('书签保存失败，已回退本次内存改动，但回退结果也未能写入磁盘。请检查存储后重新打开书签核对。', { cause: error }); }
      }
    }
    throw new Error('书签未保存成功，请检查存储后重试。', { cause: error });
  } finally { savesInFlight.delete(native); }
}

module.exports = { compact, pageNumber, selectionSubpath, pageSubpath, canonicalPosition, flattenOutline, resolveDestination, findPosition, upsertBookmark, saveBookmark };
