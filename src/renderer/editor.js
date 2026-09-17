'use strict';

/**
 * SaraText - editor engine
 *
 * The document is a plain <textarea>. Everything else - the line-number
 * gutter, the current-line band, find-match highlighting - is derived
 * state painted alongside it. The textarea keeps native caret behaviour,
 * IME support, system undo and OS-level text shortcuts for free, which is
 * exactly what a notepad needs.
 *
 * This module owns:
 *   - line metrics (gutter + wrap-aware line starts)
 *   - the highlight layer
 *   - selection / caret math
 *   - programmatic edits that must respect edit history
 */

const Editor = (() => {
  const DEFAULT_LINE_HEIGHT = 19;

  let ta = null;          // textarea
  let gutter = null;
  let highlight = null;
  let pane = null;
  let wrap = null;        // .editorWrap, carries data-wrap
  let band = null;        // full-width current-line band

  let onChange = () => {};
  let onCaret = () => {};
  let metrics = { lineHeight: DEFAULT_LINE_HEIGHT, charWidth: 7.2, paddingTop: 8 };

  /** Match spans currently highlighted: [{start, end, current}] */
  let matchSpans = [];
  /** Index of the "current" match, or -1. */
  let currentMatch = -1;

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  function init(refs, handlers = {}) {
    ta = refs.textarea;
    gutter = refs.gutter;
    highlight = refs.highlight;
    pane = refs.pane;
    wrap = refs.wrap;
    band = refs.band;

    onChange = handlers.onChange || (() => {});
    onCaret = handlers.onCaret || (() => {});

    measure();

    ta.addEventListener('input', () => {
      onChange();
      // Text changed: any painted matches are stale.
      if (matchSpans.length) { matchSpans = []; currentMatch = -1; }
      render();
      onCaret();
    });

    ta.addEventListener('scroll', () => {
      gutter.scrollTop = ta.scrollTop;
      highlight.scrollTop = ta.scrollTop;
      highlight.scrollLeft = ta.scrollLeft;
      positionBand();
      renderGutter(true);
    });

    // Caret moves must repaint the gutter highlight and the current-line
    // band, not just report position - so these use refreshCaret.
    ta.addEventListener('keyup', refreshCaret);
    ta.addEventListener('click', refreshCaret);
    ta.addEventListener('select', refreshCaret);
    ta.addEventListener('selectchange', refreshCaret);
    ta.addEventListener('keydown', (e) => {
      // Alt+Up / Alt+Down move the current line.
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        moveLine(e.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      // Tab indents, Shift+Tab outdents. With a selection, both operate on
      // every touched line.
      if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (e.shiftKey) outdent(); else indent();
      }
    });

    // Re-measure when the font finishes loading or the pane resizes.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(measure).catch(() => {});
    }
    const ro = new ResizeObserver(() => { measure(); render(); });
    ro.observe(pane);

    // Arrow keys, Home/End and mouse drags all move the caret without
    // reliably firing keyup/click, so listen to the platform-level event.
    // Debounced to one frame: selectionchange fires very frequently.
    let selFrame = null;
    document.addEventListener('selectionchange', () => {
      if (document.activeElement !== ta) return;
      if (selFrame) return;
      selFrame = requestAnimationFrame(() => {
        selFrame = null;
        refreshCaret();
      });
    });

    render();
    onCaret();
  }

  /* ---------------------------------------------------------------- *
   * Metrics
   * ---------------------------------------------------------------- */

  function measure() {
    if (!ta) return;
    const cs = getComputedStyle(ta);
    let lh = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lh) || lh < 1) {
      lh = (parseFloat(cs.fontSize) || 13) * 1.46;
    }
    metrics.lineHeight = lh;
    metrics.paddingTop = parseFloat(cs.paddingTop) || 0;

    ta.style.setProperty('--line-h', `${lh}px`);
    if (highlight) highlight.style.setProperty('--line-h', `${lh}px`);

    // Character width drives horizontal scroll maths for the gutter.
    const probe = document.createElement('span');
    probe.textContent = '0'.repeat(100);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font || cs.fontFamily};font-size:${cs.fontSize};font-family:${cs.fontFamily};`;
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width / 100;
    probe.remove();
    if (w > 0) metrics.charWidth = w;

    if (gutter) gutter.style.setProperty('--line-h', `${lh}px`);
  }

  /* ---------------------------------------------------------------- *
   * Text access
   * ---------------------------------------------------------------- */

  const getText = () => (ta ? ta.value : '');
  const setText = (text) => {
    if (!ta) return;
    ta.value = text;
    matchSpans = [];
    currentMatch = -1;
    render();
    onCaret();
  };

  /** 0-based line number containing `offset`. */
  function lineAt(offset) {
    const before = ta.value.slice(0, offset);
    return before.split('\n').length;   // 1-based
  }

  /** Offset of the first character of a 1-based line. */
  function lineStart(line) {
    const text = ta.value;
    let n = 1;
    for (let i = 0; i < text.length; i++) {
      if (n === line) return i;
      if (text[i] === '\n') n++;
    }
    return line === n ? text.length : -1;
  }

  function lineCount() {
    return ta.value === '' ? 1 : ta.value.split('\n').length;
  }

  function currentLine() {
    return lineAt(ta.selectionStart);
  }

  function caret() {
    const start = ta.selectionStart;
    const pos = ta.value.slice(0, start);
    const line = pos.split('\n').length;
    const col = start - (pos.lastIndexOf('\n') + 1);
    return {
      line,
      col: col + 1,
      start,
      end: ta.selectionEnd,
      selected: ta.selectionEnd - ta.selectionStart,
      lines: lineCount(),
      chars: ta.value.length,
    };
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  let gutterDirty = true;

  /**
   * Paint a full-width band behind the caret's line. Only correct when the
   * document has no soft wrapping (a wrapped logical line occupies several
   * visual rows and a single band would be misleading), so it hides there.
   */
  function positionBand() {
    if (!band || !pane) return;
    const wrapped = wrap && wrap.dataset.wrap === 'on';
    if (wrapped || !ta.value.length) {
      pane.dataset.showCur = 'false';
      return;
    }
    const line = currentLine();
    const y = metrics.paddingTop + (line - 1) * metrics.lineHeight - ta.scrollTop;
    const paneH = pane.clientHeight;

    if (y + metrics.lineHeight < 0 || y > paneH) {
      pane.dataset.showCur = 'false';
      return;
    }
    pane.dataset.showCur = 'true';
    band.style.transform = `translateY(${Math.round(y)}px)`;
  }

  function render() {
    renderGutter(false);
    renderHighlight();
    positionBand();
  }

  /** Gutter shows one row per logical line; with wrap on, rows can differ. */
  function renderGutter(onlyScroll) {
    const count = lineCount();

    if (gutter && (gutterDirty || gutter.childElementCount !== count)) {
      const frag = document.createDocumentFragment();
      for (let i = 1; i <= count; i++) {
        const div = document.createElement('div');
        div.className = 'gutter__line';
        div.textContent = String(i);
        frag.appendChild(div);
      }
      gutter.replaceChildren(frag);
      gutterDirty = false;
      onlyScroll = false;
    }

    if (onlyScroll) {
      // Keep the current-line marker in sync while scrolling cheaply.
      const cur = currentLine();
      const prev = gutter.querySelector('.gutter__line--cur');
      if (prev) prev.classList.remove('gutter__line--cur');
      const next = gutter.children[cur - 1];
      if (next) next.classList.add('gutter__line--cur');
      return;
    }

    const cur = currentLine();
    for (let i = 0; i < gutter.childElementCount; i++) {
      gutter.children[i].classList.toggle('gutter__line--cur', i === cur - 1);
    }

    // A wide document needs the gutter to scroll horizontally with the text.
    gutter.scrollLeft = ta.scrollLeft;
    gutter.scrollTop = ta.scrollTop;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  /**
   * Paint the current-line band plus any find matches. The layer is
   * colour-transparent text: only backgrounds are visible, and because it
   * uses the same font metrics as the textarea the bands line up exactly.
   */
  function renderHighlight() {
    if (!highlight || !ta) return;
    if (!matchSpans.length) {
      highlight.innerHTML = '';
      highlight.scrollTop = ta.scrollTop;
      highlight.scrollLeft = ta.scrollLeft;
      return;
    }

    const text = ta.value;
    // Build a list of non-overlapping cut points across all spans.
    const spans = matchSpans
      .map((s, i) => ({ ...s, index: i }))
      .filter((s) => s.end > s.start)
      .sort((a, b) => a.start - b.start);

    let html = '';
    let cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue;      // overlapping match, skip
      html += escapeHtml(text.slice(cursor, span.start));
      const cls = span.index === currentMatch ? ' class="hl-cur"' : '';
      html += `<mark${cls}>${escapeHtml(text.slice(span.start, span.end))}</mark>`;
      cursor = span.end;
    }
    html += escapeHtml(text.slice(cursor));

    highlight.innerHTML = html;
    highlight.scrollTop = ta.scrollTop;
    highlight.scrollLeft = ta.scrollLeft;
  }

  function setMatches(spans, current = -1) {
    matchSpans = spans || [];
    currentMatch = current;
    renderHighlight();
  }

  function refreshCaret() {
    renderGutter(true);
    positionBand();
    onCaret();
  }

  /* ---------------------------------------------------------------- *
   * Selection-aware helpers
   * ---------------------------------------------------------------- */

  function getSelection() {
    return { start: ta.selectionStart, end: ta.selectionEnd, text: ta.value.slice(ta.selectionStart, ta.selectionEnd) };
  }

  function setSelection(start, end = start) {
    ta.focus();
    ta.setSelectionRange(start, end);
    scrollCaretIntoView();
    refreshCaret();
  }

  function selectRange(start, end) {
    setSelection(start, end);
  }

  /**
   * Replace a range. The browser records this in the textarea's native
   * undo stack, so Ctrl+Z keeps working across programmatic edits.
   */
  function replaceRange(start, end, insert, selectAfter = false) {
    ta.focus();
    ta.setSelectionRange(start, end);
    // execCommand is deprecated but remains the only way to make a
    // programmatic edit participate in native undo history.
    let ok = false;
    try { ok = document.execCommand('insertText', false, insert); } catch { ok = false; }
    if (!ok) {
      ta.setRangeText(insert, start, end, selectAfter ? 'select' : 'end');
      onChange();
    }
    if (!selectAfter) {
      ta.setSelectionRange(start + insert.length, start + insert.length);
    }
    onChange();
    refreshCaret();
  }

  function insertAtCaret(text) {
    const { start, end } = getSelection();
    replaceRange(start, end, text);
  }

  /**
   * Cut the selection and return it.
   *
   * Going through the main process clipboard rather than
   * `document.execCommand('cut')` keeps this reliable when the editor does
   * not hold focus - which is exactly the case for a context-menu item,
   * since the press that opened the menu moved focus to the menu panel.
   */
  async function cutSelection() {
    const { start, end, text } = getSelection();
    if (!text) return '';
    try {
      if (window.sara && window.sara.clipboard) {
        window.sara.clipboard.writeText(text);
      } else {
        await navigator.clipboard.writeText(text);
      }
    } catch {
      return '';          // clipboard unavailable: leave the text alone
    }
    replaceRange(start, end, '');
    return text;
  }

  function scrollCaretIntoView() {
    const { lineHeight } = metrics;
    const line = currentLine() - 1;
    const y = line * lineHeight;
    const viewTop = ta.scrollTop;
    const viewBottom = viewTop + ta.clientHeight - lineHeight * 1.5;
    if (y < viewTop) ta.scrollTop = Math.max(0, y - lineHeight);
    else if (y > viewBottom) ta.scrollTop = y - ta.clientHeight + lineHeight * 2.5;
  }

  /* ---------------------------------------------------------------- *
   * Line operations (respect multi-line selections)
   * ---------------------------------------------------------------- */

  /** Bounds of every line touched by the selection, expanded to line starts. */
  function touchedLines() {
    const { start, end } = getSelection();
    const first = lineStart(lineAt(start));
    let lastEnd;
    if (end > start && ta.value[end - 1] === '\n') {
      // Selection ends exactly on a newline: don't drag the next line in.
      lastEnd = end - 1;
    } else {
      const nextNl = ta.value.indexOf('\n', end);
      lastEnd = nextNl === -1 ? ta.value.length : nextNl;
    }
    return { from: first, to: lastEnd };
  }

  function indent() {
    const { from, to } = touchedLines();
    const block = ta.value.slice(from, to);
    const unit = ' '.repeat(Store.get('tabSize') || 4);
    const indented = block.split('\n').map((l) => (l.length ? unit + l : l)).join('\n');
    if (indented === block) { insertAtCaret(unit); return; }
    const { start, end } = getSelection();
    replaceRange(from, to, indented, false);
    ta.setSelectionRange(start + (block[0] !== undefined && ta.value[from] === unit[0] ? unit.length : 0),
                          end + (indented.length - block.length));
    refreshCaret();
  }

  function outdent() {
    const { from, to } = touchedLines();
    const block = ta.value.slice(from, to);
    const size = Store.get('tabSize') || 4;
    const outdented = block.split('\n').map((l) => {
      if (l.startsWith('\t')) return l.slice(1);
      const spaces = l.match(/^ {1,}/);
      if (spaces) return l.slice(Math.min(spaces[0].length, size));
      return l;
    }).join('\n');
    if (outdented === block) return;
    replaceRange(from, to, outdented, false);
    refreshCaret();
  }

  function moveLine(direction) {
    const { line } = caret();
    const total = lineCount();
    const target = line + direction;
    if (target < 1 || target > total) return;

    const lines = ta.value.split('\n');
    const [moved] = lines.splice(line - 1, 1);
    lines.splice(target - 1, 0, moved);
    const col = caret().col;

    ta.value = lines.join('\n');
    const newStart = lineStart(target) + (col - 1);
    ta.setSelectionRange(newStart, newStart);
    onChange();
    scrollCaretIntoView();
    refreshCaret();
  }

  /**
   * Delete lines.
   *
   * A context menu says "Delete Line" about the line you right-clicked, so
   * when there is no selection or the selection sits inside a single line,
   * only that line goes. With a multi-line selection, every touched line is
   * removed - which is what "Delete Line" means when the user has clearly
   * marked a block.
   */
  function deleteLine() {
    const sel = getSelection();
    const spansLines = sel.text.includes('\n') || (sel.text.length > 0 && sel.end > sel.start && lineAt(sel.end) > lineAt(sel.start));

    let from;
    let to;
    if (spansLines) {
      const touched = touchedLines();
      from = touched.from;
      to = touched.to;
      if (to < ta.value.length) to += 1;          // swallow the trailing newline
      else if (from > 0) from -= 1;               // ...or the leading one on the last line
    } else {
      const { line } = caret();
      const total = lineCount();
      from = lineStart(line);
      if (line < total) to = lineStart(line + 1);
      else if (from > 0) { from = lineStart(line) - 1; to = ta.value.length; }
      else to = ta.value.length;
    }

    replaceRange(from, to, '');
  }

  function duplicateLine() {
    const { line } = caret();
    const from = lineStart(line);
    const total = lineCount();
    const to = line < total ? lineStart(line + 1) : ta.value.length;
    const block = ta.value.slice(from, to);
    const insert = block.endsWith('\n') ? block : `${block}\n`;
    replaceRange(to, to, insert);
  }

  /** Toggle a line-comment prefix across the touched lines. */
  function toggleComment(prefix = '// ') {
    const { from, to } = touchedLines();
    const block = ta.value.slice(from, to);
    const lines = block.split('\n');
    const meaningful = lines.filter((l) => l.trim().length);
    if (!meaningful.length) return;

    const allCommented = meaningful.every((l) => l.trimStart().startsWith(prefix.trim()));
    const result = lines.map((l) => {
      if (!l.trim().length) return l;
      if (allCommented) {
        const idx = l.indexOf(prefix.trim());
        const cut = l.slice(0, idx) + l.slice(idx + prefix.length);
        return cut;
      }
      const indent = l.match(/^\s*/)[0];
      return indent + prefix + l.slice(indent.length);
    }).join('\n');

    replaceRange(from, to, result);
  }

  function goToLine(n) {
    const total = lineCount();
    const line = Math.max(1, Math.min(total, Math.floor(n)));
    const offset = lineStart(line);
    setSelection(offset, offset);
    // Centre the target line rather than just nudging it into view.
    const y = (line - 1) * metrics.lineHeight;
    ta.scrollTop = Math.max(0, y - ta.clientHeight / 2 + metrics.lineHeight);
    renderGutter(true);
  }

  function selectAll() { setSelection(0, ta.value.length); }

  /* ---------------------------------------------------------------- *
   * Font
   * ---------------------------------------------------------------- */

  /** Custom properties stamped onto the panes when a font is applied. */
  const FONT_VARS = ['--line-h', '--editor-font-size', '--editor-font-family'];

  function clearFontVars() {
    for (const el of [ta, highlight, gutter]) {
      if (!el) continue;
      for (const name of FONT_VARS) el.style.removeProperty(name);
    }
  }

  const quoteFamily = (name) => (/^[A-Za-z][\w -]*$/.test(name) ? `"${name}"` : name);

  /**
   * Apply the editor font. `size` is px; `family` is either a single
   * family name or a `null`/falsy value meaning "keep the stylesheet
   * stack".
   *
   * Only data attributes and inline custom properties are touched - never
   * inline `font-family`/`font-size`. The properties are inherited by the
   * `.editor` / `.highlightLayer` / `.gutter` rules in app.css, so a
   * `null` simply clears the property and the CSS default takes over
   * again. That keeps one source of truth for the default stack instead
   * of duplicating it here.
   */
  function applyFont(size, family = null) {
    const px = Number.isFinite(size) ? size : null;

    if (px !== null) {
      for (const el of [ta, highlight, gutter]) {
        if (el) el.style.setProperty('--editor-font-size', `${px}px`);
      }
    }
    if (family) {
      const stack = `${quoteFamily(family)}, var(--font-mono)`;
      for (const el of [ta, highlight, gutter]) {
        if (el) el.style.setProperty('--editor-font-family', stack);
      }
      wrap.dataset.font = 'custom';
    } else {
      for (const el of [ta, highlight, gutter]) {
        if (el) el.style.removeProperty('--editor-font-family');
      }
      wrap.dataset.font = 'default';
    }

    // A loaded webfont can land after the first paint; re-measure then.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { measure(); render(); }).catch(() => {});
    }

    measure();
    render();
  }

  /** Drop every inline font override and fall back to the stylesheet. */
  function resetFont() {
    clearFontVars();
    wrap.dataset.font = 'default';
    measure();
    render();
  }

  /** The font stack the editor is actually rendering with right now. */
  function fontStack() {
    return ta ? getComputedStyle(ta).fontFamily : '';
  }

  /* ---------------------------------------------------------------- *
   * Wrap mode
   * ---------------------------------------------------------------- */

  function setWrap(on) {
    wrap.dataset.wrap = on ? 'on' : 'off';
    ta.wrap = on ? 'soft' : 'off';
    // Wrap changes which rows exist, so the gutter and band must recompute.
    measure();
    render();
    requestAnimationFrame(() => { positionBand(); renderGutter(true); });
  }

  /* ---------------------------------------------------------------- *
   * Search support
   * ---------------------------------------------------------------- */

  /**
   * Find every occurrence of `query` in the document.
   * @returns {Array<{start:number,end:number}>}
   */
  function findMatches(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
    const text = ta.value;
    if (!query) return [];

    const results = [];
    if (regex) {
      let re;
      try {
        re = new RegExp(query, matchCase ? 'g' : 'gi');
      } catch {
        return [];   // an in-progress pattern is not an error worth showing
      }
      let m;
      let guard = 0;
      while ((m = re.exec(text)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }   // avoid infinite loop
        results.push({ start: m.index, end: m.index + m[0].length });
        if (++guard > 20000) break;
      }
      return results;
    }

    const haystack = matchCase ? text : text.toLowerCase();
    const needle = matchCase ? query : query.toLowerCase();
    let idx = 0;
    while (idx <= haystack.length - needle.length) {
      const found = haystack.indexOf(needle, idx);
      if (found === -1) break;
      const end = found + needle.length;
      if (!wholeWord || (isBoundary(text, found - 1) && isBoundary(text, end))) {
        results.push({ start: found, end });
      }
      idx = found + Math.max(1, needle.length);
    }
    return results;
  }

  const isBoundary = (text, i) => i < 0 || i >= text.length || !/[\w$]/.test(text[i]);

  /** The match that contains (or follows) the caret, used to pick a start index. */
  function matchIndexAtCaret(matches, preferAfter = false) {
    if (!matches.length) return -1;
    const { start, end } = getSelection();
    const probe = preferAfter ? end : start;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].start <= probe && probe <= matches[i].end) return i;
    }
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].start >= probe) return i;
    }
    return 0;
  }

  return {
    init, measure, render, renderGutter, renderHighlight, refreshCaret, positionBand,
    getText, setText, lineAt, lineStart, lineCount, currentLine, caret,
    getSelection, setSelection, selectRange, replaceRange, insertAtCaret, cutSelection,
    scrollCaretIntoView, selectAll, goToLine,
    indent, outdent, moveLine, deleteLine, duplicateLine, toggleComment,
    applyFont, resetFont, fontStack, setWrap,
    findMatches, setMatches, matchIndexAtCaret,
    get element() { return ta; },
    get metrics() { return metrics; },
  };
})();
