// ==UserScript==
// @name         EasyWebReader
// @namespace    easy-web-reader
// @version      1.0.0
// @description  Reading aid for long texts: a "continue here" bookmark line, highlights and margin comments. Off by default, enable per site from the userscript menu.
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
    if (!page.bookmark && !page.items.length) GM_deleteValue('p:' + key);
    else GM_setValue('p:' + key, page);
  }

  const isEnabled = () => GM_getValue('enabledHosts', []).includes(HOST);

  function setEnabled(on) {
    const hosts = GM_getValue('enabledHosts', []).filter((h) => h !== HOST);
    if (on) hosts.push(HOST);
    GM_setValue('enabledHosts', hosts);
  }

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
    if (!rects.length) { bmEl.style.display = 'none'; return; }
    bmEl.style.display = '';
    // Draw under the text line of the anchor's first rect, centered in the gap before the next line.
    const rc = rects[0];
    const textEl = elementOf(bmRange.startContainer);
    const ts = getComputedStyle(textEl);
    const lh = parseFloat(ts.lineHeight) || parseFloat(ts.fontSize) * 1.2;
    const y = rc.bottom + Math.max(1, (lh - rc.height) / 2);
    const block = blockOf(bmRange.startContainer);
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

  function goToBookmark() {
    const rects = visibleRects(bmRange);
    if (!rects.length) { toast(page.bookmark ? 'Bookmark text not found on this page' : 'No bookmark on this page'); return; }
    const scroller = scrollParent(blockOf(bmRange.startContainer));
    if (scroller) {
      const top = rects[0].top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
      scroller.scrollBy({ top, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: window.scrollY + rects[0].top - window.innerHeight / 3, behavior: 'smooth' });
    }
    hidePill();
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
    if (text.trim()) it.comment = text.trim(); else delete it.comment;
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
      if (!rects.length) { el.style.display = 'none'; continue; }
      el.style.display = '';
      right = Math.max(right, blockOf(range.startContainer).getBoundingClientRect().right);
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
    const lines = [`# ${document.title}`, '', `<${location.href}>`, '', `_Exported ${new Date().toLocaleString()} · ${ordered.length} highlights_`, ''];
    for (const it of ordered) {
      const lost = anchors.get(it.id) ? '' : ' _(not found on page)_';
      lines.push(`- “${collapse(it.exact).trim()}”${lost}`);
      if (it.comment) lines.push('  - 💬 ' + it.comment.split('\n').join('\n    '));
    }
    const md = lines.join('\n') + '\n';
    GM_setClipboard(md, 'text');
    const a = h('a', { href: URL.createObjectURL(new Blob([md], { type: 'text/markdown' })) });
    a.download = (document.title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'notes') + '.md';
    layer.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Comments copied to clipboard and downloaded');
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

  let menuIds = [];

  function buildMenu() {
    if (typeof GM_unregisterMenuCommand === 'function') for (const id of menuIds) GM_unregisterMenuCommand(id);
    menuIds = [];
    const add = (title, fn) => menuIds.push(GM_registerMenuCommand(title, fn));
    if (!layer) {
      add('Enable for this domain', () => { setEnabled(true); start(); toast(`${NAME} enabled for ${HOST}`); });
      return;
    }
    add('Disable for this domain', () => { setEnabled(false); stop(); });
    add('Go to last bookmark', goToLastBookmark);
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
    // Arrived here from "Go to last bookmark" on another page.
    const jump = GM_getValue('jumpTo', null);
    if (jump) {
      GM_deleteValue('jumpTo');
      // Wait for styles/images so the layout no longer shifts under the scroll target.
      const go = () => requestAnimationFrame(() => layer && goToBookmark());
      if (jump.key === key && Date.now() - jump.at < 60e3) {
        if (document.readyState === 'complete') go(); else window.addEventListener('load', go, { once: true });
      }
    }

    on(document, 'mouseup', onMouseUp);
    on(document, 'mousedown', onMouseDown);
    on(document, 'mousemove', onMouseMove, { passive: true });
    on(document, 'keydown', (e) => { if (e.key === 'Escape') hideBubble(); });
    on(window, 'resize', scheduleLayout);
    // Window scrolling moves the layer with the page; inner scroll containers need repositioning.
    on(document, 'scroll', (e) => { if (e.target !== document) scheduleLayout(); }, { capture: true, passive: true });
    document.fonts?.ready.then(scheduleLayout);

    const ro = new ResizeObserver(scheduleLayout);
    ro.observe(document.body);
    // Page text changed (dynamic content): rebuild index and re-anchor, at most about once a second.
    const mo = new MutationObserver(() => {
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

  if (isEnabled()) start(); else buildMenu();
})();
