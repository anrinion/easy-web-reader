// ==UserScript==
// @name         EasyWebReader
// @namespace    easy-web-reader
// @version      1.1.1
// @description  Reading aid for long texts: a "continue here" bookmark line, highlights, margin comments and a library of everything you've read. Off by default, enable per site from the userscript menu.
// @license      MIT
// @match        *://*/*
// @noframes
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_addStyle
// @grant        GM_setClipboard
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// ==/UserScript==

(function () {
  'use strict';

  const NAME = 'EasyWebReader';
  const P = 'ewr'; // prefix for CSS classes and highlight names
  const CTX = 32; // chars of context stored around each quote
  const HL = !!(window.CSS && CSS.highlights && window.Highlight);
  const HOST = location.hostname || location.protocol.replace(':', '');

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------

  const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|yclid|mc_cid|mc_eid|igshid|_ga|_gl|ref_src)$/;

  function pageKey(href = location.href) {
    const u = new URL(href);
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
    return u.href;
  }

  let key = null;
  let page = null; // { title, updated, bookmark, items: [...] }
  let unwatch = null;

  const emptyPage = () => ({ title: document.title, updated: 0, bookmark: null, items: [] });

  function loadPage() {
    key = pageKey();
    page = GM_getValue('p:' + key, null) || emptyPage();
    // The same page open in another tab: pick up its changes instead of overwriting them later.
    unwatch?.();
    unwatch = null;
    if (typeof GM_addValueChangeListener === 'function') {
      const id = GM_addValueChangeListener('p:' + key, (name, oldValue, newValue, remote) => {
        if (!remote || !layer || editingId) return;
        page = newValue || emptyPage();
        refresh();
      });
      unwatch = () => GM_removeValueChangeListener(id);
    }
  }

  function savePage() {
    page.title = document.title;
    page.updated = Date.now();
    const trail = readTrail(); // where the page sits in the site, for the library tree
    if (trail) page.trail = trail;
    page.site = siteName() || page.site;
    if (!page.bookmark && !page.items.length) GM_deleteValue('p:' + key);
    else GM_setValue('p:' + key, page);
  }

  const isEnabled = () => GM_getValue('enabledHosts', []).includes(HOST);

  function setEnabled(on) {
    const hosts = GM_getValue('enabledHosts', []).filter((h) => h !== HOST);
    if (on) hosts.push(HOST);
    GM_setValue('enabledHosts', hosts);
  }

  const dayKey = (d = new Date()) => // for file names
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // ---------------------------------------------------------------------------
  // Text index and anchoring (W3C TextQuote + TextPosition selectors)
  // ---------------------------------------------------------------------------

  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME']);
  let index = null; // { text, nodes, starts, map }

  function buildIndex() {
    const nodes = [], starts = [], parts = [], map = new Map();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.nodeType === 1
        ? (SKIP.has(n.nodeName.toUpperCase()) || n.isContentEditable ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP)
        : NodeFilter.FILTER_ACCEPT,
    });
    let len = 0;
    for (let n; (n = walker.nextNode());) {
      map.set(n, nodes.length);
      nodes.push(n);
      starts.push(len);
      parts.push(n.data);
      len += n.data.length;
    }
    return { text: parts.join(''), nodes, starts, map };
  }

  const getIndex = () => (index ||= buildIndex());

  function pointToOffset(idx, node, off) {
    if (node.nodeType === 3 && idx.map.has(node)) return idx.starts[idx.map.get(node)] + Math.min(off, node.data.length);
    // Element boundary (or unindexed node): offset of the first indexed text node at/after the point.
    const r = document.createRange();
    try { r.setStart(node, off); } catch { return 0; }
    let lo = 0, hi = idx.nodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (r.comparePoint(idx.nodes[mid], 0) < 0) lo = mid + 1; else hi = mid;
    }
    return lo < idx.nodes.length ? idx.starts[lo] : idx.text.length;
  }

  function offsetToPoint(idx, off, isEnd) {
    let lo = 0, hi = idx.nodes.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (isEnd ? idx.starts[mid] < off : idx.starts[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const n = idx.nodes[ans];
    return [n, Math.max(0, Math.min(off - idx.starts[ans], n.data.length))];
  }

  function offsetsToRange(s, e) {
    const idx = getIndex();
    if (!idx.nodes.length) return null;
    const r = document.createRange();
    r.setStart(...offsetToPoint(idx, s, false));
    r.setEnd(...offsetToPoint(idx, e, true));
    return r;
  }

  // Returns a selector for the range, trimmed of surrounding whitespace. With minLen, short/collapsed
  // ranges are extended forward so a bookmark always has some text to anchor to.
  function selectorFromRange(range, minLen = 0) {
    const idx = getIndex(), t = idx.text;
    let s = pointToOffset(idx, range.startContainer, range.startOffset);
    let e = pointToOffset(idx, range.endContainer, range.endOffset);
    while (s < e && /\s/.test(t[s])) s++;
    while (e > s && /\s/.test(t[e - 1])) e--;
    if (e - s < minLen) e = Math.min(t.length, s + minLen);
    if (e <= s) return null;
    return { exact: t.slice(s, e), prefix: t.slice(Math.max(0, s - CTX), s), suffix: t.slice(e, e + CTX), start: s, end: e };
  }

  const collapse = (s) => s.replace(/\s+/g, ' ');
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function commonTail(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }

  function commonHead(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }

  function findAnchor(q) {
    const t = getIndex().text;
    const pre = Math.max(0, q.start - q.prefix.length);
    if (t.slice(q.start, q.end) === q.exact && t.slice(pre, q.start) === q.prefix) return { s: q.start, e: q.end };
    // Text moved: search for the quote with whitespace-insensitive matching, score by surrounding context.
    const words = collapse(q.exact).trim();
    if (!words) return null;
    const re = new RegExp(words.split(' ').map(escapeRe).join('\\s+'), 'g');
    const wantPre = collapse(q.prefix), wantSuf = collapse(q.suffix);
    let best = null, n = 0;
    for (const m of t.matchAll(re)) {
      const s = m.index, e = s + m[0].length;
      const score = commonTail(collapse(t.slice(Math.max(0, s - CTX * 2), s)), wantPre)
        + commonHead(collapse(t.slice(e, e + CTX * 2)), wantSuf)
        - Math.abs(s - q.start) / 1e7;
      if (!best || score > best.score) best = { s, e, score };
      if (++n > 500) break;
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  let layer = null; // overlay root, lives on <html> so it never touches the page's <body>

  function h(tag, props = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    el.append(...kids);
    return el;
  }

  // Line icons (paths in a 24x24 box), drawn with the current text colour.
  const ICONS = {
    comment: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
    trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
    chevron: 'M9 6l6 6-6 6',
    arrow: 'M5 12h14M13 6l6 6-6 6',
    bookmark: 'M7 3h10v18l-5-4-5 4z',
    search: 'M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14zM20 20l-4-4',
    close: 'M6 6l12 12M18 6L6 18',
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', `${P}-icon`);
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  const origin = () => layer.getBoundingClientRect();
  const visibleRects = (r) => (r ? [...r.getClientRects()].filter((x) => x.width > 0 || x.height > 0) : []);
  const inUI = (n) => !!(layer && n && layer.contains(n.nodeType === 1 ? n : n.parentNode));
  const isEditable = (el) => !!(el && el.closest && (el.closest('input, textarea, select') || el.isContentEditable));
  const elementOf = (n) => (n.nodeType === 1 ? n : n.parentElement);

  // True when something else (a modal, a sticky header, a page's own popup) is painted over the
  // anchored text, so our overlay must not be drawn on top of it. Off-screen text counts as visible.
  function occluded(rect, block) {
    const y = rect.top + rect.height / 2;
    const x = rect.left + Math.min(rect.width / 2, 12);
    if (y < 0 || y >= window.innerHeight || x < 0 || x >= window.innerWidth) return false;
    const top = document.elementsFromPoint(x, y).find((el) => !inUI(el));
    return !!top && !block.contains(top) && !top.contains(block);
  }

  function blockOf(node) {
    for (let el = elementOf(node); el && el !== document.body; el = el.parentElement) {
      const d = getComputedStyle(el).display;
      if (!d.startsWith('inline') && d !== 'contents') return el;
    }
    return document.body;
  }

  function scrollParent(el) {
    for (; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  }

  function caretAt(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  }

  function toast(msg) {
    const el = h('div', { class: `${P}-toast` }, msg);
    layer.append(el);
    setTimeout(() => el.classList.add('is-leaving'), 2200);
    setTimeout(() => el.remove(), 2600);
  }

  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ---------------------------------------------------------------------------
  // Anchors and rendering
  // ---------------------------------------------------------------------------

  const anchors = new Map(); // item id -> { range, s, e } (null when not found on the page)
  let bmRange = null;

  function reanchor() {
    index = null;
    anchors.clear();
    for (const it of page.items) {
      const m = findAnchor(it);
      anchors.set(it.id, m ? { range: offsetsToRange(m.s, m.e), s: m.s, e: m.e } : null);
    }
    const bm = page.bookmark && findAnchor(page.bookmark);
    bmRange = bm ? offsetsToRange(bm.s, bm.e) : null;
    // Pages saved by an older version: record breadcrumbs for the library, without bumping 'updated'.
    if ((page.bookmark || page.items.length) && !('trail' in page)) {
      page.trail = readTrail();
      page.site = siteName() || page.site;
      GM_setValue('p:' + key, page);
    }
    renderHighlights();
    renderBookmark();
    scheduleLayout();
  }

  const rangeOf = (id) => anchors.get(id)?.range || null;

  function renderHighlights() {
    if (!HL) return;
    CSS.highlights.set(`${P}-mark`, new Highlight(...page.items.map((it) => rangeOf(it.id)).filter(Boolean)));
    const hot = hotId && rangeOf(hotId);
    const active = new Highlight(...(hot ? [hot] : []));
    active.priority = 1;
    CSS.highlights.set(`${P}-active`, active);
  }

  function clearHighlights() {
    if (!HL) return;
    for (const n of ['mark', 'active']) CSS.highlights.delete(`${P}-${n}`);
  }

  function itemAt(x, y) {
    for (let i = page.items.length - 1; i >= 0; i--) {
      const it = page.items[i];
      if (visibleRects(rangeOf(it.id)).some((r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom)) return it;
    }
    return null;
  }

  let raf = 0;
  function scheduleLayout() {
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (layer) { layoutBookmark(); layoutCards(); positionBubble(); } });
  }

  // ---------------------------------------------------------------------------
  // Bookmark line
  // ---------------------------------------------------------------------------

  let bmEl = null;
  let pillEl = null;
  let pillActive = false;

  function renderBookmark() {
    if (!page.bookmark) {
      bmEl?.remove();
      bmEl = null;
      hidePill();
      return;
    }
    if (bmEl) return;
    bmEl = h('div', { class: `${P}-bm` },
      h('button', { class: `${P}-bm-x`, title: 'Remove bookmark (middle-click any text to move it)', onclick: removeBookmark }, '✕'));
    layer.append(bmEl);
  }

  function layoutBookmark() {
    if (!bmEl) return;
    const rects = visibleRects(bmRange);
    const block = rects.length && blockOf(bmRange.startContainer);
    if (!rects.length || occluded(rects[0], block)) { bmEl.style.display = 'none'; return; }
    bmEl.style.display = '';
    // Draw under the text line of the anchor's first rect, centered in the gap before the next line.
    const rc = rects[0];
    const textEl = elementOf(bmRange.startContainer);
    const ts = getComputedStyle(textEl);
    const lh = parseFloat(ts.lineHeight) || parseFloat(ts.fontSize) * 1.2;
    const y = rc.bottom + Math.max(1, (lh - rc.height) / 2);
    const b = block.getBoundingClientRect(), bs = getComputedStyle(block);
    const left = b.left + parseFloat(bs.paddingLeft) - 8;
    const right = b.right - parseFloat(bs.paddingRight) + 8;
    const o = origin();
    Object.assign(bmEl.style, { left: left - o.left + 'px', top: y - o.top - 1.5 + 'px', width: Math.max(40, right - left) + 'px' });
  }

  function setBookmark(range) {
    const sel = selectorFromRange(range, 12);
    if (!sel) return;
    page.bookmark = { exact: sel.exact, prefix: sel.prefix, suffix: sel.suffix, start: sel.start, end: sel.end, created: Date.now() };
    savePage();
    hidePill();
    if (bmEl) {
      const old = bmEl;
      bmEl = null;
      old.classList.add('is-leaving');
      setTimeout(() => old.remove(), 400);
    }
    bmRange = offsetsToRange(sel.start, sel.end);
    renderBookmark();
    bmEl.classList.add('is-new');
    layoutBookmark();
  }

  function removeBookmark() {
    page.bookmark = null;
    bmRange = null;
    savePage();
    renderBookmark();
  }

  function scrollToRange(range) {
    if (!visibleRects(range).length) return false;
    // Scroll boxes around the text first (a transcript panel, a chat column), innermost first and
    // instantly, so the window scroll below aims at where the text ends up.
    for (let el = scrollParent(blockOf(range.startContainer)); el; el = scrollParent(el.parentElement)) {
      const rc = visibleRects(range)[0];
      el.scrollTop += rc.top - el.getBoundingClientRect().top - el.clientHeight / 3;
    }
    const rc = visibleRects(range)[0];
    window.scrollTo({ top: window.scrollY + rc.top - window.innerHeight / 3, behavior: 'smooth' });
    return true;
  }

  function goToBookmark() {
    if (!scrollToRange(bmRange)) { toast(page.bookmark ? 'Bookmark text not found on this page' : 'No bookmark on this page'); return; }
    hidePill();
  }

  // Scrolls to a highlight and briefly marks it as active.
  function goToItem(id) {
    if (!scrollToRange(rangeOf(id))) { toast('Highlight not found on this page'); return; }
    focusId = id;
    setHot(id);
    setTimeout(() => { if (layer && hotId === id) setHot(null); }, 1800);
    scheduleLayout();
  }

  // Floating "Continue reading" pill, shown on load until the line has been on screen once.
  function updatePill() {
    const rc = visibleRects(bmRange)[0];
    if (!rc) return;
    if (rc.bottom > 0 && rc.top < window.innerHeight) { hidePill(); return; }
    if (!pillEl) {
      pillEl = h('div', { class: `${P}-pill` },
        h('button', { class: `${P}-pill-go`, onclick: goToBookmark }),
        h('button', { class: `${P}-x`, title: 'Dismiss', onclick: hidePill }, '✕'));
      layer.append(pillEl);
    }
    pillEl.firstChild.textContent = (rc.top < 0 ? '↑' : '↓') + ' Continue reading';
  }

  function setupPill() {
    if (!bmRange) return;
    pillActive = true;
    document.addEventListener('scroll', updatePill, { capture: true, passive: true });
    requestAnimationFrame(() => pillActive && updatePill());
  }

  function hidePill() {
    if (pillActive) document.removeEventListener('scroll', updatePill, { capture: true });
    pillActive = false;
    pillEl?.remove();
    pillEl = null;
  }

  // ---------------------------------------------------------------------------
  // Bubble (selection toolbar / highlight toolbar)
  // ---------------------------------------------------------------------------

  let bubble = null; // { el, range, itemId }

  function showBubble(item) {
    hideBubble();
    const btn = (label, title, onclick) => h('button', { title, onmousedown: (e) => e.preventDefault(), onclick }, label);
    const el = h('div', { class: `${P}-bubble` },
      btn(icon('comment'), item.comment ? 'Edit comment' : 'Add comment', onComment),
      btn(icon('trash'), 'Remove highlight', onDelete));
    layer.append(el);
    bubble = { el, range: rangeOf(item.id), itemId: item.id };
    positionBubble();
  }

  function hideBubble() {
    bubble?.el.remove();
    bubble = null;
  }

  function positionBubble() {
    if (!bubble) return;
    const rects = visibleRects(bubble.range);
    if (!rects.length) { hideBubble(); return; }
    const o = origin(), el = bubble.el, first = rects[0];
    const vw = document.documentElement.clientWidth;
    let top = first.top - el.offsetHeight - 8;
    if (top < 4) top = rects[rects.length - 1].bottom + 8;
    let left = (first.left + first.right) / 2 - el.offsetWidth / 2;
    left = Math.max(4, Math.min(left, vw - el.offsetWidth - 4));
    el.style.left = left - o.left + 'px';
    el.style.top = top - o.top + 'px';
  }

  function addItem(sel) {
    const it = { id: newId(), ...sel, created: Date.now() };
    page.items.push(it);
    anchors.set(it.id, { range: offsetsToRange(sel.start, sel.end), s: sel.start, e: sel.end });
    savePage();
    renderHighlights();
    return it;
  }

  // Selecting text highlights it right away; selecting inside an existing highlight reuses that one.
  function highlightSelection(range) {
    const sel = selectorFromRange(range);
    if (!sel) return null;
    return page.items.find((it) => {
      const a = anchors.get(it.id);
      return a && a.s <= sel.start && a.e >= sel.end;
    }) || addItem(sel);
  }

  function onComment() {
    const id = bubble.itemId;
    hideBubble();
    startEdit(id);
  }

  function onDelete() {
    const id = bubble.itemId;
    page.items = page.items.filter((it) => it.id !== id);
    anchors.delete(id);
    if (editingId === id) editingId = null;
    savePage();
    hideBubble();
    renderHighlights();
    scheduleLayout();
  }

  // ---------------------------------------------------------------------------
  // Margin comments
  // ---------------------------------------------------------------------------

  const cards = new Map(); // item id -> card element
  let editingId = null;
  let focusId = null; // card aligned exactly with its highlight; others make room around it
  let hotId = null;

  function setHot(id) {
    if (id === hotId) return;
    hotId = id;
    for (const [cid, el] of cards) el.classList.toggle('is-hot', cid === id);
    renderHighlights();
  }

  function createCard(it) {
    const el = h('div', { class: `${P}-card`, onmouseenter: () => setHot(it.id), onmouseleave: () => setHot(null) },
      h('div', { class: `${P}-card-text`, title: 'Click to edit', onclick: () => startEdit(it.id) }),
      h('div', { class: `${P}-card-actions` },
        h('button', { title: 'Delete comment', onmousedown: (e) => e.preventDefault(), onclick: () => saveComment(it.id, '') }, icon('trash'))));
    cards.set(it.id, el);
    layer.append(el);
    return el;
  }

  function startEdit(id) {
    const it = page.items.find((x) => x.id === id);
    if (!it) return;
    if (editingId && editingId !== id) cards.get(editingId)?.querySelector('textarea')?.blur();
    editingId = focusId = id;
    const el = cards.get(id) || createCard(it);
    if (!el.querySelector('textarea')) {
      const ta = h('textarea', { placeholder: 'Add a comment… (Ctrl+Enter to save, Esc to cancel)' });
      ta.value = it.comment || '';
      let cancelled = false;
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { cancelled = true; ta.blur(); }
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ta.blur();
      });
      ta.addEventListener('input', scheduleLayout);
      ta.addEventListener('blur', () => { if (!ta.dataset.done) saveComment(id, cancelled ? it.comment || '' : ta.value); });
      el.firstChild.replaceWith(ta);
      layoutCards();
      ta.focus({ preventScroll: true });
    }
  }

  function saveComment(id, text) {
    const it = page.items.find((x) => x.id === id);
    if (editingId === id) editingId = null;
    const el = cards.get(id);
    const ta = el?.querySelector('textarea');
    if (ta) {
      ta.dataset.done = '1';
      ta.replaceWith(h('div', { class: `${P}-card-text`, title: 'Click to edit', onclick: () => startEdit(id) }));
    }
    if (!it) return;
    const had = !!it.comment;
    if (text.trim()) it.comment = text.trim(); else delete it.comment;
    if (it.comment === undefined && !had) { scheduleLayout(); return; } // opened and closed an empty editor
    savePage();
    scheduleLayout();
  }

  function layoutCards() {
    const items = page.items.filter((it) => it.comment || it.id === editingId);
    const wanted = new Set(items.map((it) => it.id));
    for (const [id, el] of cards) if (!wanted.has(id)) { el.remove(); cards.delete(id); }

    const o = origin();
    const vw = document.documentElement.clientWidth;
    let right = 0;
    const entries = [];
    for (const it of items) {
      const el = cards.get(it.id) || createCard(it);
      if (it.id !== editingId) el.firstChild.textContent = it.comment || '';
      const range = rangeOf(it.id);
      const rects = visibleRects(range);
      const block = rects.length && blockOf(range.startContainer);
      if (!rects.length || (it.id !== editingId && occluded(rects[0], block))) { el.style.display = 'none'; continue; }
      el.style.display = '';
      right = Math.max(right, block.getBoundingClientRect().right);
      entries.push({ id: it.id, el, ideal: rects[0].top - o.top });
    }
    if (!entries.length) return;

    const width = Math.min(260, Math.max(160, vw - right - 32));
    const x = Math.min(right + 16, vw - width - 8);
    for (const e of entries) {
      e.el.style.width = width + 'px';
      e.el.style.left = x - o.left + 'px';
      e.h = e.el.offsetHeight;
    }
    // Docs-style stacking: the focused card sits at its highlight, the rest are pushed away from it.
    entries.sort((a, b) => a.ideal - b.ideal);
    const GAP = 8;
    const a = Math.max(0, entries.findIndex((e) => e.id === focusId));
    entries[a].top = entries[a].ideal;
    for (let i = a + 1; i < entries.length; i++) entries[i].top = Math.max(entries[i].ideal, entries[i - 1].top + entries[i - 1].h + GAP);
    for (let i = a - 1; i >= 0; i--) entries[i].top = Math.min(entries[i].ideal, entries[i + 1].top - GAP - entries[i].h);
    for (const e of entries) e.el.style.top = e.top + 'px';
  }

  // ---------------------------------------------------------------------------
  // Page events
  // ---------------------------------------------------------------------------

  let upTimer = 0;

  function onMouseUp(e) {
    if (e.button !== 0 || inUI(e.target) || isEditable(e.target)) return;
    clearTimeout(upTimer);
    const { clientX: x, clientY: y } = e;
    // Wait briefly: another click (double/triple-click selection) cancels this one in onMouseDown.
    upTimer = setTimeout(() => {
      const sel = getSelection();
      let it = null;
      if (sel.rangeCount && !sel.isCollapsed) {
        const range = sel.getRangeAt(0);
        if (!document.body.contains(range.commonAncestorContainer) || !sel.toString().trim()) return;
        it = highlightSelection(range);
      } else if (!e.target.closest('a, button, label, summary')) {
        it = itemAt(x, y);
      }
      if (it) { focusId = it.id; showBubble(it); scheduleLayout(); }
    }, 300);
  }

  function onMouseDown(e) {
    clearTimeout(upTimer);
    if (!inUI(e.target)) hideBubble();
    if (e.button !== 1 || inUI(e.target) || isEditable(e.target) || e.target.closest('a, button')) return;
    const c = caretAt(e.clientX, e.clientY);
    if (!c || c.node.nodeType !== 3 || !document.body.contains(c.node) || !c.node.data.trim()) return;
    // Clicks on empty space snap to the nearest text, possibly far away: only accept the clicked line.
    const range = document.createRange();
    const at = Math.min(c.offset, c.node.data.length - 1);
    range.setStart(c.node, at);
    range.setEnd(c.node, at + 1);
    const rc = range.getBoundingClientRect();
    if (e.clientY < rc.top - 4 || e.clientY > rc.bottom + 4) return;
    e.preventDefault(); // no autoscroll
    range.collapse(true);
    setBookmark(range);
  }

  let moveRaf = 0;
  function onMouseMove(e) {
    if (moveRaf || !cards.size) return;
    const { clientX: x, clientY: y, target } = e;
    moveRaf = requestAnimationFrame(() => {
      moveRaf = 0;
      if (inUI(target)) return;
      const it = itemAt(x, y);
      setHot(it && it.comment ? it.id : null);
    });
  }

  // ---------------------------------------------------------------------------
  // Menu commands
  // ---------------------------------------------------------------------------

  function exportMarkdown() {
    if (!page.items.length) { toast('No highlights on this page'); return; }
    const ordered = [...page.items].sort((a, b) => {
      const sa = anchors.get(a.id)?.s ?? Infinity, sb = anchors.get(b.id)?.s ?? Infinity;
      return sa - sb || a.created - b.created;
    });
    const lines = [`# ${document.title}`, '', `<${location.href}>`, '', `_Exported ${new Date().toLocaleString()} · ${ordered.length} highlights_`, '',
      ...noteLines(ordered, (it) => !anchors.get(it.id))];
    const md = lines.join('\n') + '\n';
    GM_setClipboard(md, 'text');
    download(md, fileName(document.title, 'notes') + '.md', 'text/markdown');
    toast('Comments copied to clipboard and downloaded');
  }

  function noteLines(items, isLost = () => false) {
    const lines = [];
    for (const it of items) {
      lines.push(`- “${collapse(it.exact).trim()}”${isLost(it) ? ' _(not found on page)_' : ''}`);
      if (it.comment) lines.push('  - 💬 ' + it.comment.split('\n').join('\n    '));
    }
    return lines;
  }

  const fileName = (s, fallback) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || fallback;

  function download(text, name, type) {
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })) });
    a.download = name;
    document.documentElement.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function storedPages() {
    return GM_listValues().filter((k) => k.startsWith('p:')).map((k) => {
      const v = GM_getValue(k, null);
      return { k, v, size: JSON.stringify(v || '').length };
    });
  }

  const kb = (n) => (n / 1024).toFixed(1) + ' KB';

  function resetCurrent() {
    loadPage();
    refresh();
  }

  function refresh() {
    hidePill();
    for (const el of cards.values()) el.remove();
    cards.clear();
    editingId = focusId = hotId = null;
    hideBubble();
    reanchor();
  }

  function clearPage() {
    const n = page.items.length;
    if (!confirm(`${NAME}: delete ${n} highlight(s)${page.bookmark ? ' and the bookmark' : ''} on this page?`)) return;
    page.items = [];
    page.bookmark = null;
    savePage();
    resetCurrent();
  }

  function wipeStorage() {
    const all = storedPages();
    const items = all.reduce((s, p) => s + (p.v?.items?.length || 0), 0);
    const size = kb(all.reduce((s, p) => s + p.size, 0));
    if (!confirm(`${NAME}: wipe out all data — ${all.length} page(s), ${items} highlight(s), ${size}?\nThe list of enabled domains is kept.`)) return;
    for (const k of GM_listValues()) if (k !== 'enabledHosts') GM_deleteValue(k);
    resetCurrent();
    toast('Storage wiped out');
  }

  // Opens the page whose bookmark was set most recently (any site) and scrolls to it there.
  function goToLastBookmark() {
    let last = null;
    for (const { k, v } of storedPages()) {
      if (v?.bookmark && (!last || v.bookmark.created > last.created)) last = { key: k.slice(2), created: v.bookmark.created };
    }
    if (!last) { toast('No bookmarks yet'); return; }
    if (last.key === key) { goToBookmark(); return; }
    GM_setValue('jumpTo', { key: last.key, at: Date.now() });
    location.href = last.key;
  }

  // ---------------------------------------------------------------------------
  // Library: every page with notes, in one overlay (works on any page, enabled or not)
  // ---------------------------------------------------------------------------

  let lib = null; // { host, render }

  function ago(t) {
    const m = (Date.now() - t) / 60e3;
    if (m < 1) return 'just now';
    if (m < 60) return `${m | 0} min ago`;
    if (m < 1440) return `${(m / 60) | 0} h ago`;
    if (m < 1440 * 30) return `${(m / 1440) | 0} d ago`;
    return new Date(t).toLocaleDateString();
  }

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  function hostOf(k) {
    try { return new URL(k).hostname || 'local file'; } catch { return k; }
  }

  function libraryPages() {
    return storedPages()
      .filter(({ v }) => v && (v.bookmark || v.items?.length))
      .map(({ k, v }) => {
        const items = [...(v.items || [])].sort((a, b) => a.start - b.start);
        return { key: k.slice(2), title: collapse(v.title || k.slice(2)).trim(), updated: v.updated || 0, bookmark: v.bookmark, items,
          comments: items.filter((it) => it.comment).length, trail: v.trail || [], site: v.site };
      });
  }

  // ---------------------------------------------------------------------------
  // Reading tree: site -> breadcrumb trail (course, chapter, ...) -> page
  // ---------------------------------------------------------------------------

  const SEPS = '\\s:|\\-–—·•›»/';
  const trimSep = (s) => s.replace(new RegExp(`^[${SEPS}]+|[${SEPS}]+$`, 'g'), '');

  // The page's breadcrumb trail (ARIA breadcrumb nav, schema.org BreadcrumbList or a "breadcrumb" class):
  // the one with the most links, without the link to the site's front page.
  function readTrail() {
    let best = null;
    for (const el of document.querySelectorAll('nav[aria-label*="breadcrumb" i], [itemtype$="BreadcrumbList"], [class*="breadcrumb" i]')) {
      if (layer?.contains(el)) continue;
      const crumbs = [];
      for (const a of el.querySelectorAll('a[href]')) {
        const label = collapse(a.textContent).trim();
        let u;
        try { u = new URL(a.href); } catch { continue; }
        if (!label || !/^https?:$/.test(u.protocol) || (u.pathname === '/' && !u.search)) continue;
        if (!crumbs.some((c) => c.href === u.href)) crumbs.push({ label: label.slice(0, 120), href: u.href });
      }
      if (crumbs.length > (best?.length || 0)) best = crumbs;
    }
    return best ? best.slice(0, 8) : null;
  }

  const siteName = () => document.querySelector('meta[property="og:site_name"]')?.content?.trim() || undefined;

  const safeKey = (href) => { try { return pageKey(href); } catch { return href; } };

  // Two addresses are parts of one document when they share the path and all but one parameter,
  // and at least one parameter is shared (e.g. ?id=7&section=2 and ?id=7&section=3, or ?id=7).
  function sameDoc(a, b) {
    try {
      const x = new URL(a), y = new URL(b);
      if (x.origin !== y.origin || x.pathname !== y.pathname) return false;
      let diff = 0, same = 0;
      for (const k of new Set([...x.searchParams.keys(), ...y.searchParams.keys()])) {
        if (x.searchParams.get(k) === y.searchParams.get(k)) same++; else diff++;
      }
      return diff <= 1 && same >= 1;
    } catch { return false; }
  }

  // Longest shared start of the strings, cut back to a whole word.
  function commonPrefix(strs) {
    let p = strs[0] || '';
    for (const s of strs) while (!s.startsWith(p)) p = p.slice(0, -1);
    if (strs.some((s) => /\w/.test(s[p.length] || '') && /\w$/.test(p))) p = p.replace(/\S*$/, '');
    return trimSep(p);
  }

  // The site's name as it appears at the end of its page titles ("Chapter 1 | Site name").
  function titleSuffix(pages) {
    const counts = new Map();
    for (const p of pages) {
      const m = p.title.match(/\s[|\-–—·•]\s([^|–—·•]+)$/);
      if (m) counts.set(m[1].trim(), (counts.get(m[1].trim()) || 0) + 1);
    }
    let best = null;
    for (const [t, n] of counts) if (!best || n > best[1]) best = [t, n];
    if (!best) return null;
    return best[1] >= 2 || pages.some((p) => p.site === best[0]) ? best[0] : null;
  }

  // Page title without the site name and without what the branch above already says.
  function cleanTitle(title, suffix, names) {
    let t = title;
    if (suffix && t.endsWith(suffix) && t.length > suffix.length) t = trimSep(t.slice(0, -suffix.length));
    for (const n of [...names].sort((a, b) => b.length - a.length)) {
      if (n && t.length > n.length && t.startsWith(n) && new RegExp(`[${SEPS}]`).test(t[n.length])) { t = trimSep(t.slice(n.length)); break; }
    }
    return t || title;
  }

  // Pages in reading order: by address, numbers compared as numbers (section=9 before section=10).
  const reading = (a, b) => a.key.localeCompare(b.key, undefined, { numeric: true });

  function buildTree(pages) {
    // Pages saved without breadcrumbs borrow the trail of another part of the same document.
    const withTrail = pages.filter((p) => p.trail.length);
    for (const p of pages) if (!p.trail.length) p.trail = withTrail.find((q) => sameDoc(p.key, q.key))?.trail || [];
    // Still nothing (site without breadcrumbs): parts of one document share a group named after their common title.
    const loose = pages.filter((p) => !p.trail.length), seen = new Set();
    for (const p of loose) {
      if (seen.has(p)) continue;
      const group = [p];
      seen.add(p);
      for (let i = 0; i < group.length; i++) {
        for (const q of loose) if (!seen.has(q) && sameDoc(group[i].key, q.key)) { seen.add(q); group.push(q); }
      }
      if (group.length < 2) continue;
      const label = commonPrefix(group.map((g) => g.title)) || new URL(p.key).pathname;
      for (const g of group) g.trail = [{ label, href: 'doc:' + p.key }];
    }

    const node = (id, label) => ({ id, label, names: [label], kids: new Map(), leaves: [] });
    const roots = new Map();
    for (const p of pages) {
      const host = hostOf(p.key);
      if (!roots.has(host)) roots.set(host, node('site:' + host, host));
      let cur = roots.get(host);
      for (const c of p.trail) {
        if (!cur.kids.has(c.href)) cur.kids.set(c.href, node(c.href, c.label));
        cur = cur.kids.get(c.href);
      }
      cur.leaves.push(p);
    }

    const compress = (n) => {
      for (const k of n.kids.values()) compress(k);
      for (const [id, k] of [...n.kids]) {
        // A branch that holds only the page it links to is just that page.
        if (!k.kids.size && k.leaves.length === 1 && k.leaves[0].key === safeKey(k.id)) {
          n.kids.delete(id);
          n.leaves.push(k.leaves[0]);
          continue;
        }
        // A branch with one sub-branch and nothing else: show both on one line.
        while (!k.leaves.length && k.kids.size === 1) {
          const sub = [...k.kids.values()][0];
          k.label += ' › ' + cleanTitle(sub.label, null, k.names);
          k.names.push(...sub.names);
          k.id = sub.id;
          k.kids = sub.kids;
          k.leaves = sub.leaves;
        }
      }
    };

    const total = (n, names, suffix, isSite) => {
      for (const p of n.leaves) p.label = cleanTitle(p.title, suffix, names);
      // An ending every sibling shares ("Part 2 - My blog", "Part 3 - My blog") says nothing either.
      if (n.leaves.length > 1) {
        const rev = (x) => [...x].reverse().join('');
        const tail = rev(commonPrefix(n.leaves.map((p) => rev(p.label))));
        if (tail.length > 2 && n.leaves.every((p) => new RegExp(`[${SEPS}]$`).test(p.label.slice(0, -tail.length)))) {
          for (const p of n.leaves) p.label = trimSep(p.label.slice(0, -tail.length)) || p.label;
        }
      }
      const kids = [...n.kids.values()];
      for (const k of kids) total(k, [...names, ...k.names], suffix, false);
      const all = [...n.leaves, ...kids];
      n.pages = n.leaves.length + kids.reduce((s, k) => s + k.pages, 0);
      n.items = n.leaves.reduce((s, p) => s + p.items.length, 0) + kids.reduce((s, k) => s + k.items, 0);
      n.comments = n.leaves.reduce((s, p) => s + p.comments, 0) + kids.reduce((s, k) => s + k.comments, 0);
      n.updated = Math.max(0, ...all.map((x) => x.updated));
      // Where to continue: inside a course, the furthest page you've marked in reading order (going back
      // to an earlier page doesn't move it); across a site's courses, the one read most recently.
      const marked = [...n.leaves, ...kids.map((k) => k.latest).filter(Boolean)];
      n.latest = marked.sort(isSite ? (a, b) => a.updated - b.updated : reading).at(-1) || null;
    };

    for (const [host, root] of roots) {
      const hostPages = pages.filter((p) => hostOf(p.key) === host);
      const suffix = titleSuffix(hostPages);
      const name = hostPages.map((p) => p.site).find(Boolean) || suffix;
      root.label = name || host;
      root.host = name ? host : '';
      root.names = [];
      compress(root);
      total(root, [], suffix, true);
    }
    return [...roots.values()];
  }

  // Jumps to the bookmark (or a highlight) on another page; on this page, just scrolls.
  // Returns true when handled here, so the caller can cancel the link navigation.
  function jumpTo(key2, id) {
    if (layer && key2 === key) {
      closeLibrary();
      if (id) goToItem(id); else goToBookmark();
      return true;
    }
    GM_setValue('jumpTo', { key: key2, id, at: Date.now() });
    return false;
  }

  function jumpLink(cls, key2, id, ...kids) {
    const handler = (e) => { if ((e.type === 'click' || e.button === 1) && jumpTo(key2, id)) e.preventDefault(); };
    return h('a', { class: cls, href: key2, onclick: handler, onauxclick: handler }, ...kids);
  }

  function backup() {
    const pages = {};
    for (const { k, v } of storedPages()) pages[k.slice(2)] = v;
    const data = { app: NAME, version: 1, exported: new Date().toISOString(), enabledHosts: GM_getValue('enabledHosts', []), pages };
    download(JSON.stringify(data, null, 1), `${NAME}-backup-${dayKey()}.json`, 'application/json');
  }

  // Merges a backup into storage: nothing is deleted, highlights are matched by id, the newer bookmark wins.
  function restore(file, done) {
    file.text().then((text) => {
      const data = JSON.parse(text);
      if (!data || data.app !== NAME || typeof data.pages !== 'object') throw new Error('not an ' + NAME + ' backup');
      let added = 0;
      for (const [k, b] of Object.entries(data.pages)) {
        if (!b || !Array.isArray(b.items)) continue;
        const a = GM_getValue('p:' + k, null);
        if (!a) { GM_setValue('p:' + k, b); added += b.items.length; continue; }
        const ids = new Set(a.items.map((it) => it.id));
        const extra = b.items.filter((it) => !ids.has(it.id));
        added += extra.length;
        a.items.push(...extra);
        if ((b.bookmark?.created || 0) > (a.bookmark?.created || 0)) a.bookmark = b.bookmark;
        a.updated = Math.max(a.updated || 0, b.updated || 0);
        if (!a.trail?.length && b.trail?.length) a.trail = b.trail;
        GM_setValue('p:' + k, a);
      }
      const hosts = new Set([...GM_getValue('enabledHosts', []), ...(data.enabledHosts || [])]);
      GM_setValue('enabledHosts', [...hosts]);
      if (layer) resetCurrent();
      done(`Restored: ${plural(Object.keys(data.pages).length, 'page')}, ${plural(added, 'new highlight')}`);
    }).catch((err) => done(`Restore failed: ${err.message}`));
  }

  function exportAllMarkdown(pages) {
    const lines = [`# ${NAME} notes`, '', `_Exported ${new Date().toLocaleString()} · ${plural(pages.length, 'page')}_`, ''];
    for (const p of pages) {
      if (!p.items.length) continue;
      lines.push(`## ${p.title}`, '', `<${p.key}>`, '', ...noteLines(p.items), '');
    }
    download(lines.join('\n'), `${NAME}-notes-${dayKey()}.md`, 'text/markdown');
  }

  function openLibrary() {
    if (lib) return;
    hideBubble();
    const host = h('div', { 'data-ewr-library': '' });
    // Keep keys and clicks away from the page's own handlers (site shortcuts, our own selection logic).
    for (const t of ['mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'keydown', 'keyup', 'keypress', 'input'])
      host.addEventListener(t, (e) => { if (t === 'keydown' && e.key === 'Escape') closeLibrary(); e.stopPropagation(); });
    const root = host.attachShadow({ mode: 'open' });
    const style = h('style', {}, LIB_CSS);
    const state = { q: '', sort: GM_getValue('librarySort', 'recent'), open: new Map() };
    if (!['recent', 'notes', 'title'].includes(state.sort)) state.sort = 'recent';
    const status = h('div', { class: 'status', role: 'status' });
    const say = (msg) => { status.textContent = msg; };

    const search = h('input', { type: 'search', placeholder: 'Search titles, highlights and comments…', 'aria-label': 'Search' });
    search.addEventListener('input', () => { state.q = search.value.trim().toLowerCase(); renderList(); });
    const sort = h('select', { 'aria-label': 'Sort' },
      ...[['recent', 'Recently read'], ['notes', 'Most notes'], ['title', 'A–Z']]
        .map(([v, label]) => h('option', { value: v }, label)));
    sort.value = state.sort;
    sort.addEventListener('change', () => { state.sort = sort.value; GM_setValue('librarySort', sort.value); renderList(); });

    const fileIn = h('input', { type: 'file', accept: '.json,application/json', hidden: '' });
    fileIn.addEventListener('change', () => { if (fileIn.files[0]) restore(fileIn.files[0], (msg) => { say(msg); render(); }); fileIn.value = ''; });

    const list = h('div', { class: 'list' });
    let pages = [];

    function render() {
      pages = libraryPages();
      renderList();
    }

    function renderList() {
      const q = state.q;
      const hit = (s) => !!s && s.toLowerCase().includes(q);
      const byName = (a, b) => a.label.localeCompare(b.label, undefined, { numeric: true });
      const order = {
        recent: (a, b) => b.updated - a.updated,
        notes: (a, b) => b.items - a.items || b.updated - a.updated,
        title: byName,
      }[state.sort];

      const renderNode = (n, depth) => {
        const kids = [...n.kids.values()].sort(order).map((k) => renderNode(k, depth + 1)).filter(Boolean);
        const leaves = n.leaves.sort(reading).map((p) => {
          if (!q) return renderLeaf(p, p.items);
          const items = p.items.filter((it) => hit(it.exact) || hit(it.comment));
          return items.length || hit(p.title) || hit(p.key) ? renderLeaf(p, items, true) : null;
        }).filter(Boolean);
        if (!kids.length && !leaves.length) return null;
        // A site: its name, then one card per course (and one for pages outside any course).
        if (depth === 0) {
          return h('section', { class: 'site' },
            h('h2', { class: 'site-name' }, n.label, n.host ? h('span', { class: 'site-host' }, n.host) : ''),
            leaves.length ? h('div', { class: 'card' }, h('div', { class: 'rows' }, ...leaves)) : '',
            ...kids);
        }
        const recent = n.updated > Date.now() - 14 * 864e5;
        const open = q ? true : state.open.get(n.id) ?? recent;
        const toggle = () => { state.open.set(n.id, !open); renderList(); };
        const meta = [plural(n.pages, 'page'), n.items && plural(n.items, 'highlight'), n.comments && plural(n.comments, 'comment'), 'read ' + ago(n.updated)]
          .filter(Boolean).join(' · ');
        const c = n.latest;
        return h('div', { class: depth === 1 ? 'card' : 'sub' },
          h('div', { class: 'g-head' },
            h('button', { class: 'g-toggle' + (open ? ' is-open' : ''), 'aria-expanded': String(open), onclick: toggle },
              libIcon('chevron'),
              h('span', { class: 'g-text' }, h('span', { class: 'g-label' }, n.label), h('span', { class: 'g-meta' }, meta))),
            c ? jumpLink('continue', c.key, c.bookmark ? null : c.items.at(-1)?.id,
              h('span', { class: 'continue-k' }, 'Continue'), h('span', { class: 'continue-v' }, c.label), libIcon('arrow')) : ''),
          open ? h('div', { class: 'rows' }, ...kids, ...leaves) : '');
      };

      const tree = buildTree(pages).sort(order).map((n) => renderNode(n, 0)).filter(Boolean);
      if (!tree.length) {
        list.replaceChildren(h('p', { class: 'empty' }, pages.length
          ? 'Nothing matches your search.'
          : 'Nothing here yet. Enable the script on a site, then highlight text or middle-click to drop a bookmark.'));
        return;
      }
      list.replaceChildren(...tree);
    }

    function renderLeaf(p, items, searching) {
      const id = 'page:' + p.key;
      const open = searching ? items.length > 0 : !!state.open.get(id);
      const toggle = () => { state.open.set(id, !open); renderList(); };
      const del = () => {
        if (!confirm(`${NAME}: delete ${plural(p.items.length, 'highlight')}${p.bookmark ? ' and the bookmark' : ''} for “${p.title}”?`)) return;
        GM_deleteValue('p:' + p.key);
        if (layer && p.key === key) resetCurrent();
        render();
      };
      // Deletes one highlight, keeping the page's bookmark and other notes.
      const delItem = (it) => {
        if (it.comment && !confirm(`${NAME}: delete this highlight and its comment?`)) return;
        const v = GM_getValue('p:' + p.key, null);
        if (!v) return;
        v.items = v.items.filter((x) => x.id !== it.id);
        if (!v.bookmark && !v.items.length) GM_deleteValue('p:' + p.key); else GM_setValue('p:' + p.key, v);
        if (layer && p.key === key) resetCurrent();
        render();
      };
      const counts = [p.items.length && plural(p.items.length, 'highlight'), p.comments && plural(p.comments, 'comment')].filter(Boolean).join(' · ');
      return h('div', { class: 'leaf' + (open ? ' is-open' : '') },
        h('div', { class: 'leaf-row' },
          h('span', { class: 'mark', title: p.bookmark ? 'Bookmarked' : '' }, p.bookmark ? libIcon('bookmark') : ''),
          h('span', { class: 'leaf-main' },
            p.bookmark ? jumpLink('leaf-title', p.key, null, p.label) : h('a', { class: 'leaf-title', href: p.key }, p.label),
            p.key === key ? h('span', { class: 'here' }, 'this page') : ''),
          counts && items.length
            ? h('button', { class: 'count' + (open ? ' is-open' : ''), 'aria-expanded': String(open), onclick: toggle }, counts, libIcon('chevron'))
            : h('span', { class: 'count is-static' }, counts),
          h('button', { class: 'icon-btn del', title: 'Delete the bookmark and all highlights on this page', 'aria-label': 'Delete the bookmark and all highlights on this page', onclick: del }, libIcon('trash'))),
        open ? h('ul', { class: 'notes' }, ...items.map((it) => h('li', {},
          h('div', {},
            jumpLink('quote', p.key, it.id, '“' + collapse(it.exact).trim() + '”'),
            it.comment ? h('div', { class: 'comment' }, libIcon('comment'), it.comment) : ''),
          h('button', { class: 'icon-btn del', title: 'Delete this highlight', 'aria-label': 'Delete this highlight', onclick: () => delItem(it) },
            libIcon('trash'))))) : '');
    }

    const close = h('button', { class: 'icon-btn close', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeLibrary }, libIcon('close'));
    const panel = h('div', { class: 'panel', role: 'dialog', 'aria-label': `${NAME} library` },
      h('header', {},
        h('div', { class: 'title' }, h('div', { class: 'eyebrow' }, NAME), h('h1', {}, 'Library')),
        h('div', { class: 'actions' },
          h('button', { title: 'Download all notes as one Markdown file', onclick: () => exportAllMarkdown(pages) }, 'Export notes'),
          h('button', { title: 'Download everything as a JSON backup', onclick: () => { backup(); say('Backup downloaded'); } }, 'Back up'),
          h('button', { title: 'Merge a JSON backup into your data', onclick: () => fileIn.click() }, 'Restore')),
        close),
      status,
      h('div', { class: 'toolbar' }, h('label', { class: 'search' }, libIcon('search'), search), sort),
      list, fileIn);
    const backdrop = h('div', { class: 'backdrop', onclick: (e) => { if (e.target === backdrop) closeLibrary(); } }, panel);
    root.append(style, backdrop);
    document.documentElement.append(host);
    const prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    lib = { host, prevOverflow, render };
    render();
    search.focus({ preventScroll: true });
  }

  function closeLibrary() {
    if (!lib) return;
    lib.host.remove();
    document.documentElement.style.overflow = lib.prevOverflow;
    lib = null;
  }

  function libIcon(name) {
    const svg = icon(name);
    svg.setAttribute('class', 'i i-' + name);
    return svg;
  }

  const LIB_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .backdrop {
      --bg: #ffffff; --card: #ffffff; --surface: #f4f5f7; --fg: #1d2129; --muted: #69707d; --faint: #9aa1ad;
      --border: rgba(20, 24, 31, 0.1); --accent: #d9480f; --accent-fg: #ffffff; --accent-soft: rgba(217, 72, 15, 0.1);
      --mark: rgba(255, 200, 0, 0.6);
      position: fixed; inset: 0; z-index: 2147483600; display: flex; padding: 40px 16px; overflow: auto; overscroll-behavior: contain;
      background: rgba(12, 14, 18, 0.5); backdrop-filter: blur(3px);
      font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg); -webkit-font-smoothing: antialiased;
    }
    @media (prefers-color-scheme: dark) {
      .backdrop { --bg: #17191d; --card: #1e2126; --surface: #262a30; --fg: #e9eaec; --muted: #9ba1ab; --faint: #6f7680;
        --border: rgba(255, 255, 255, 0.09); --accent: #ff7a45; --accent-fg: #1a0e08; --accent-soft: rgba(255, 122, 69, 0.14);
        --mark: rgba(255, 200, 0, 0.45); background: rgba(0, 0, 0, 0.6); }
    }
    .panel { margin: auto; width: 100%; max-width: 760px; background: var(--bg); border-radius: 18px;
      box-shadow: 0 24px 80px rgba(0, 0, 0, 0.35), 0 0 0 1px var(--border); padding: 26px 28px 30px; }
    button, select, input { font: inherit; color: inherit; }
    a { color: inherit; }
    .i { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }

    header { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; margin-bottom: 18px; }
    .title { flex: 1; min-width: 0; }
    .eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); }
    h1 { font-size: 26px; line-height: 1.15; font-weight: 700; margin: 2px 0 0; letter-spacing: -0.01em; }
    .actions { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
    .actions button { padding: 6px 11px; border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer; font-size: 13px; }
    .actions button:hover { background: var(--surface); color: var(--fg); }
    .icon-btn { width: 32px; height: 32px; border: 0; border-radius: 8px; background: none; cursor: pointer; color: var(--muted);
      display: grid; place-items: center; flex: none; padding: 0; }
    .icon-btn:hover { background: var(--surface); color: var(--fg); }
    .close .i { width: 18px; height: 18px; }
    .status { color: var(--accent); font-size: 13px; margin: -8px 0 12px; }
    .status:empty { display: none; }

    .toolbar { display: flex; gap: 8px; margin-bottom: 22px; }
    .search { flex: 1; min-width: 0; position: relative; display: flex; align-items: center; }
    .search .i { position: absolute; left: 12px; color: var(--faint); pointer-events: none; }
    .search input { width: 100%; padding: 9px 12px 9px 36px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); }
    .toolbar select { padding: 9px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); cursor: pointer; }
    .search input:focus, .toolbar select:focus { outline: 2px solid var(--accent); outline-offset: -1px; background: var(--bg); }

    .list { display: flex; flex-direction: column; gap: 26px; }
    .site { display: flex; flex-direction: column; gap: 10px; }
    .site-name { margin: 0 2px; font-size: 13px; font-weight: 600; color: var(--muted); display: flex; align-items: baseline; gap: 8px; }
    .site-host { font-weight: 400; color: var(--faint); font-size: 12px; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 14px; padding: 6px; }

    .g-head { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; padding: 8px 8px 8px 6px; }
    .g-toggle { flex: 1 1 280px; min-width: 0; display: flex; align-items: flex-start; gap: 8px; border: 0; background: none;
      padding: 0; cursor: pointer; text-align: left; }
    .g-toggle > .i { margin-top: 3px; color: var(--faint); transition: transform 0.15s; }
    .g-toggle.is-open > .i { transform: rotate(90deg); }
    .g-text { display: flex; flex-direction: column; min-width: 0; }
    .g-label { font-size: 15px; font-weight: 650; line-height: 1.35; overflow-wrap: anywhere; }
    .sub .g-label { font-size: 14px; }
    .g-toggle:hover .g-label { color: var(--accent); }
    .g-meta { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
    .continue { display: inline-flex; align-items: center; gap: 8px; max-width: 100%; padding: 7px 12px 7px 14px; border-radius: 10px;
      background: var(--accent); color: var(--accent-fg); text-decoration: none; font-size: 13px; line-height: 1.3; }
    .continue:hover { filter: brightness(1.08); }
    .continue-k { font-weight: 700; }
    .continue-v { opacity: 0.9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
    .sub .continue { background: var(--accent-soft); color: var(--accent); padding: 5px 10px; }
    .sub { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 4px; }
    .rows { display: flex; flex-direction: column; }
    .card > .g-head + .rows { border-top: 1px solid var(--border); padding-top: 4px; }

    .leaf { border-radius: 10px; }
    .leaf:hover, .leaf.is-open { background: var(--surface); }
    .leaf-row { display: grid; grid-template-columns: 22px 1fr auto 32px; align-items: center; gap: 6px; padding: 5px 4px 5px 6px; min-height: 40px; }
    .mark { display: grid; place-items: center; color: var(--faint); }
    .mark .i { width: 15px; height: 15px; fill: currentColor; }
    .leaf-main { min-width: 0; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .leaf-title { text-decoration: none; overflow-wrap: anywhere; }
    .leaf-title:hover { color: var(--accent); }
    .here { font-size: 11px; font-weight: 600; color: var(--accent); background: var(--accent-soft); padding: 1px 7px; border-radius: 999px; white-space: nowrap; }
    .count { display: inline-flex; align-items: center; gap: 4px; border: 0; background: none; padding: 4px 6px; border-radius: 6px;
      color: var(--muted); font-size: 12px; white-space: nowrap; cursor: pointer; }
    .count .i { width: 13px; height: 13px; transition: transform 0.15s; }
    .count.is-open .i { transform: rotate(90deg); }
    button.count:hover { color: var(--fg); background: var(--bg); }
    .count.is-static { cursor: default; }
    .del { opacity: 0; }
    .leaf-row:hover .del, .notes li:hover .del, .del:focus-visible { opacity: 1; }
    .notes { list-style: none; margin: 0; padding: 2px 8px 10px 34px; display: flex; flex-direction: column; gap: 10px; }
    .notes li { display: grid; grid-template-columns: 1fr 32px; gap: 6px; padding-left: 12px; border-left: 3px solid var(--mark); }
    .quote { text-decoration: none; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .quote:hover { color: var(--accent); }
    .comment { margin-top: 3px; color: var(--muted); white-space: pre-wrap; overflow-wrap: anywhere; }
    .comment .i { display: inline-block; width: 13px; height: 13px; margin-right: 6px; vertical-align: -2px; }
    .empty { color: var(--muted); text-align: center; padding: 32px 0; }
    @media (max-width: 560px) {
      .backdrop { padding: 12px 8px; }
      .panel { padding: 18px 14px 20px; border-radius: 14px; }
      .actions { order: 3; width: 100%; margin: 0 0 0 -11px; }
      .continue-v { max-width: 180px; }
      .notes { padding-left: 14px; }
      .leaf-row { grid-template-columns: 22px 1fr 32px; }
      .leaf-row > .count { grid-column: 2; grid-row: 2; justify-self: start; margin: -6px 0 0 -6px; }
      .leaf-row > .count.is-static:empty { display: none; }
    }
  `;

  let menuIds = [];

  function buildMenu() {
    if (typeof GM_unregisterMenuCommand === 'function') for (const id of menuIds) GM_unregisterMenuCommand(id);
    menuIds = [];
    const add = (title, fn) => menuIds.push(GM_registerMenuCommand(title, fn));
    if (!layer) {
      add('Enable for this domain', () => { setEnabled(true); start(); toast(`${NAME} enabled for ${HOST}`); });
      add('Open library', openLibrary);
      return;
    }
    add('Open library', openLibrary);
    add('Go to last bookmark', goToLastBookmark);
    add('Disable for this domain', () => { setEnabled(false); stop(); });
    add('Export comments as Markdown', exportMarkdown);
    add('Clear this page', clearPage);
    add('Wipe out storage', wipeStorage);
  }

  // ---------------------------------------------------------------------------
  // Start / stop
  // ---------------------------------------------------------------------------

  const CSS_TEXT = `
    ::highlight(${P}-mark) { background-color: rgba(255, 212, 0, 0.45); }
    ::highlight(${P}-active) { background-color: rgba(232, 89, 12, 0.28); }

    .${P}-layer {
      position: absolute; top: 0; left: 0; width: 0; height: 0; overflow: visible;
      z-index: 2147483000; pointer-events: none;
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      --bg: #ffffff; --fg: #1f2328; --muted: #6b7280; --border: rgba(0, 0, 0, 0.14);
      --shadow: 0 6px 20px rgba(0, 0, 0, 0.18); --line: #ff5a1f;
      color: var(--fg);
    }
    @media (prefers-color-scheme: dark) {
      .${P}-layer { --bg: #25282e; --fg: #e8e8e8; --muted: #9aa0a6; --border: rgba(255, 255, 255, 0.16); --shadow: 0 6px 20px rgba(0, 0, 0, 0.55); }
    }
    .${P}-layer * {
      box-sizing: border-box; margin: 0; padding: 0; border: 0; font: inherit; color: inherit;
      letter-spacing: normal; text-transform: none; text-align: left; line-height: inherit; float: none;
      min-width: 0; max-width: none; box-shadow: none; background: none;
    }
    .${P}-layer > * { pointer-events: auto; }
    .${P}-layer button { cursor: pointer; }

    .${P}-bm { position: absolute; height: 3px; border-radius: 2px; pointer-events: none;
      background: var(--line); box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.6), 0 0 10px rgba(255, 90, 31, 0.7); }
    .${P}-bm.is-new { animation: ${P}-fade-in 0.3s ease-out; }
    .${P}-bm.is-leaving { opacity: 0; transition: opacity 0.4s; }
    @keyframes ${P}-fade-in { from { opacity: 0; } to { opacity: 1; } }
    .${P}-bm-x { position: absolute; right: -8px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px;
      border-radius: 50%; background: var(--line); color: #fff; font-size: 9px; line-height: 16px; text-align: center; pointer-events: auto; }
    .${P}-bm-x:hover { background: #fff; color: var(--line); box-shadow: 0 0 0 2px var(--line), 0 2px 6px rgba(0, 0, 0, 0.3); }
    .${P}-x { width: 16px; height: 16px; border-radius: 50%; font-size: 10px; line-height: 16px; text-align: center; opacity: 0.8; }
    .${P}-x:hover { opacity: 1; background: rgba(0, 0, 0, 0.15); }

    .${P}-pill { position: fixed; right: 20px; bottom: 20px; display: flex; align-items: center; gap: 4px;
      padding: 6px 8px 6px 14px; border-radius: 999px; background: var(--line); color: #fff; box-shadow: var(--shadow); font-weight: 600; }

    .${P}-bubble { position: absolute; display: flex; align-items: center; gap: 4px; padding: 4px 6px;
      background: var(--bg); border: 1px solid var(--border); border-radius: 999px; box-shadow: var(--shadow); }
    .${P}-bubble button { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; }
    .${P}-layer .${P}-icon { display: block; width: 16px; height: 16px; fill: none; stroke: currentColor;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
    .${P}-bubble button:hover { background: rgba(127, 127, 127, 0.18); }

    .${P}-card { position: absolute; padding: 8px 10px; background: var(--bg); border: 1px solid var(--border);
      border-left: 4px solid #f5c400; border-radius: 8px; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
      transition: top 0.15s ease, box-shadow 0.15s ease; }
    .${P}-card.is-hot { box-shadow: var(--shadow); }
    .${P}-card-text { white-space: pre-wrap; overflow-wrap: anywhere; cursor: text; min-height: 1.45em; }
    .${P}-card textarea { display: block; width: 100%; min-height: 64px; resize: vertical; padding: 4px 6px;
      border: 1px solid var(--border); border-radius: 4px; background: transparent; }
    .${P}-card-actions { display: flex; justify-content: flex-end; height: 0; overflow: visible; opacity: 0; }
    .${P}-card:hover .${P}-card-actions { opacity: 1; }
    .${P}-card-actions button { position: relative; top: -20px; right: -4px; width: 22px; height: 22px; border-radius: 4px;
      display: grid; place-items: center; color: var(--muted); }
    .${P}-card-actions .${P}-icon { width: 14px; height: 14px; }
    .${P}-card-actions button:hover { background: rgba(127, 127, 127, 0.18); }

    .${P}-toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); padding: 8px 14px;
      border-radius: 8px; background: var(--fg); color: var(--bg); box-shadow: var(--shadow); transition: opacity 0.4s; }
    .${P}-toast.is-leaving { opacity: 0; }
  `;

  let styleEl = null;
  let cleanups = [];
  let mutationTimer = 0;

  function on(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  function start() {
    if (layer) return;
    styleEl = GM_addStyle(CSS_TEXT);
    layer = h('div', { class: `${P}-layer`, 'data-ewr': '' });
    // Keep our UI's events away from the page's own handlers.
    for (const t of ['mousedown', 'mouseup', 'click', 'auxclick', 'dblclick', 'keydown', 'keyup', 'keypress', 'input'])
      layer.addEventListener(t, (e) => e.stopPropagation());
    document.documentElement.append(layer);
    if (!HL) console.warn(`${NAME}: CSS Custom Highlight API not supported, highlights will not be drawn.`);

    loadPage();
    reanchor();
    setupPill();
    // Arrived here from "Go to last bookmark" or the library on another page.
    const jump = GM_getValue('jumpTo', null);
    if (jump) {
      GM_deleteValue('jumpTo');
      // Wait for styles/images so the layout no longer shifts under the scroll target.
      const go = () => requestAnimationFrame(() => { if (layer) { if (jump.id) goToItem(jump.id); else goToBookmark(); } });
      if (jump.key === key && Date.now() - jump.at < 60e3) {
        if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
      }
    }

    on(document, 'mouseup', onMouseUp);
    on(document, 'mousedown', onMouseDown);
    on(document, 'mousemove', onMouseMove, { passive: true });
    on(document, 'keydown', (e) => { if (e.key === 'Escape') hideBubble(); });
    on(window, 'resize', scheduleLayout);
    // Window scrolling moves the layer with the page, but can slide the text under a sticky header;
    // inner scroll containers need repositioning too.
    on(document, 'scroll', scheduleLayout, { capture: true, passive: true });
    document.fonts?.ready.then(scheduleLayout);

    const ro = new ResizeObserver(scheduleLayout);
    ro.observe(document.body);
    // Page text changed (dynamic content): rebuild index and re-anchor, at most about once a second.
    const mo = new MutationObserver(() => {
      scheduleLayout(); // re-check occlusion right away (a modal just opened or closed)
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = 0;
        if (!layer || editingId) return;
        if (page.items.length || page.bookmark) reanchor(); else index = null;
      }, 800);
    });
    mo.observe(document.body, { childList: true, subtree: true, characterData: true });
    // Single-page apps: switch data when the URL changes without a reload.
    const poll = setInterval(() => { if (pageKey() !== key) { resetCurrent(); setupPill(); } }, 1000);
    cleanups.push(() => { ro.disconnect(); mo.disconnect(); clearInterval(poll); clearTimeout(mutationTimer); mutationTimer = 0; });

    buildMenu();
  }

  function stop() {
    if (!layer) return;
    for (const fn of cleanups) fn();
    cleanups = [];
    unwatch?.();
    unwatch = null;
    clearTimeout(upTimer);
    hidePill();
    hideBubble();
    clearHighlights();
    cards.clear();
    anchors.clear();
    bmEl = bmRange = null;
    editingId = focusId = hotId = null;
    layer.remove();
    layer = null;
    styleEl?.remove();
    styleEl = null;
    buildMenu();
  }

  if (GM_getValue('activity', null)) GM_deleteValue('activity'); // reading statistics, no longer kept
  if (isEnabled()) start(); else buildMenu();
})();
