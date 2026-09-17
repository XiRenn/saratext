'use strict';

/**
 * SaraText - find & replace
 *
 * Owns the find bar. Match discovery lives in the editor module (it needs
 * the raw text); this module drives the UI, tracks which match is current
 * and performs replacements.
 */

const Search = (() => {
  let els = null;
  let open = false;
  let replaceMode = false;

  let matches = [];
  let index = -1;

  const state = { query: '', matchCase: false, wholeWord: false, regex: false };

  const handlers = {};
  let onStatus = () => {};

  function init(refs, options = {}) {
    els = refs;
    onStatus = options.onStatus || (() => {});

    els.findInput.addEventListener('input', () => {
      state.query = els.findInput.value;
      recompute({ fromCaret: true });
    });
    els.replaceInput.addEventListener('input', () => { /* nothing until action */ });

    els.findInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? prev() : next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    els.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.ctrlKey || e.altKey) replaceAll(); else replaceOne();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    for (const [el, key] of [[els.optCase, 'matchCase'], [els.optWord, 'wholeWord'], [els.optRegex, 'regex']]) {
      el.addEventListener('change', () => {
        state[key] = el.checked;
        recompute({ fromCaret: true });
      });
    }

    els.next.addEventListener('click', next);
    els.prev.addEventListener('click', prev);
    els.replaceOne.addEventListener('click', replaceOne);
    els.replaceAll.addEventListener('click', replaceAll);
    els.close.addEventListener('click', close);
  }

  /* ---------------------------------------------------------------- *
   * Open / close
   * ---------------------------------------------------------------- */

  function show({ replace = false, seed = '' } = {}) {
    open = true;
    replaceMode = replace;

    // Seed with the current selection - a very common "search this" path.
    const sel = Editor.getSelection();
    const text = sel.text;
    if (text && !text.includes('\n')) {
      els.findInput.value = text;
      state.query = text;
    } else if (seed) {
      els.findInput.value = seed;
      state.query = seed;
    } else {
      state.query = els.findInput.value;
    }

    els.root.hidden = false;
    els.replaceGroup.hidden = !replace;

    Editor.element.focus();
    els.findInput.focus();
    els.findInput.select();

    recompute({ fromCaret: true });
  }

  function openFind() { show({ replace: false }); }
  function openReplace() { show({ replace: true }); }

  function close() {
    if (!open) return;
    open = false;
    els.root.hidden = true;
    Editor.setMatches([], -1);
    matches = [];
    index = -1;
    Editor.element.focus();
    onStatus({ matches: 0, index: -1, open: false });
  }

  function isOpen() { return open; }
  function isReplaceOpen() { return open && replaceMode; }

  function toggleReplace() {
    if (!open) { openReplace(); return; }
    replaceMode = !replaceMode;
    els.replaceGroup.hidden = !replaceMode;
    if (replaceMode) els.replaceInput.focus();
  }

  /* ---------------------------------------------------------------- *
   * Matching
   * ---------------------------------------------------------------- */

  function recompute({ fromCaret = false } = {}) {
    state.query = els.findInput.value;

    if (!state.query) {
      matches = [];
      index = -1;
      Editor.setMatches([], -1);
      updateCount();
      return;
    }

    matches = Editor.findMatches(state.query, state);

    if (!matches.length) {
      index = -1;
      Editor.setMatches([], -1);
      updateCount();
      return;
    }

    index = fromCaret
      ? Editor.matchIndexAtCaret(matches, false)
      : Math.min(index < 0 ? 0 : index, matches.length - 1);

    paint();
  }

  function paint() {
    Editor.setMatches(matches, index);
    updateCount();
    onStatus({ matches: matches.length, index, open: true });
  }

  function updateCount() {
    if (!state.query) {
      els.count.textContent = '0 / 0';
      els.count.classList.remove('findbar__count--none');
      return;
    }
    if (!matches.length) {
      els.count.textContent = 'No results';
      els.count.classList.add('findbar__count--none');
      return;
    }
    els.count.textContent = `${index + 1} / ${matches.length}`;
    els.count.classList.remove('findbar__count--none');
  }

  /** Re-run the search without moving the caret (after an edit). */
  function refresh() {
    if (!open || !state.query) return;
    const keep = index;
    matches = Editor.findMatches(state.query, state);
    if (!matches.length) {
      index = -1;
      Editor.setMatches([], -1);
      updateCount();
      return;
    }
    index = Math.max(0, Math.min(keep, matches.length - 1));
    paint();
  }

  /* ---------------------------------------------------------------- *
   * Navigation
   * ---------------------------------------------------------------- */

  function goTo(i) {
    if (!matches.length) return;
    index = (i + matches.length) % matches.length;
    const m = matches[index];
    Editor.setSelection(m.start, m.end);
    index = m.end;
    index = (i + matches.length) % matches.length;
    Editor.setMatches(matches, index);
    updateCount();
    els.findInput.focus();
  }

  function next() {
    if (!matches.length) { recompute({ fromCaret: true }); if (!matches.length) return; }
    const from = index < 0 ? Editor.matchIndexAtCaret(matches, true) : index + 1;
    goTo(from % matches.length);
  }

  function prev() {
    if (!matches.length) { recompute({ fromCaret: true }); if (!matches.length) return; }
    const from = index <= 0 ? matches.length - 1 : index - 1;
    goTo(from);
  }

  /* ---------------------------------------------------------------- *
   * Replacement
   * ---------------------------------------------------------------- */

  function expandReplacement(match, replacement) {
    if (!state.regex) return replacement;
    // Support $1..$9 and $& when in regex mode.
    const text = Editor.getText();
    const full = text.slice(match.start, match.end);
    return replacement
      .replace(/\$&/g, full)
      .replace(/\$(\d)/g, (_m, d) => (match.groups && match.groups[Number(d)] !== undefined ? match.groups[Number(d)] : ''));
  }

  function replaceOne() {
    if (!matches.length || index < 0) { next(); return; }
    const m = matches[index];
    const replacement = expandReplacement(m, els.replaceInput.value);
    const delta = replacement.length - (m.end - m.start);
    const wasIndex = index;

    Editor.replaceRange(m.start, m.end, replacement);

    // The document shifted, so re-scan and keep the position stable.
    matches = Editor.findMatches(state.query, state);
    if (!matches.length) {
      index = -1;
      Editor.setMatches([], -1);
      updateCount();
      return;
    }

    // Land on the match that now occupies the replaced region.
    const anchor = m.start + delta;
    let landed = matches.findIndex((x) => x.start >= anchor);
    if (landed === -1) landed = 0;
    index = landed;
    const target = matches[index];
    Editor.setSelection(target.start, target.end);
    Editor.setMatches(matches, index);
    updateCount();
    els.findInput.focus();
  }

  function replaceAll() {
    if (!state.query) return 0;

    const found = Editor.findMatches(state.query, state);
    if (!found.length) return 0;

    const text = Editor.getText();
    const replacement = els.replaceInput.value;

    // Build the result in one pass so overlapping ranges can't corrupt it.
    let out = '';
    let cursor = 0;
    let applied = 0;
    for (const m of found) {
      if (m.start < cursor) continue;
      out += text.slice(cursor, m.start);
      out += expandReplacement(m, replacement);
      cursor = m.end;
      applied++;
    }
    out += text.slice(cursor);

    Editor.setSelection(0, 0);
    Editor.replaceRange(0, text.length, out);

    matches = Editor.findMatches(state.query, state);
    index = matches.length ? 0 : -1;
    Editor.setMatches(matches, index);
    updateCount();
    onStatus({ matches: matches.length, index, open: true, replaced: applied });
    return applied;
  }

  /* ---------------------------------------------------------------- *
   * Shortcuts owned by the bar itself
   * ---------------------------------------------------------------- */

  function toggleOption(which) {
    const map = { case: els.optCase, word: els.optWord, regex: els.optRegex };
    const el = map[which];
    if (!el) return;
    el.checked = !el.checked;
    el.dispatchEvent(new Event('change'));
  }

  return {
    init, openFind, openReplace, close, isOpen, isReplaceOpen, toggleReplace,
    next, prev, replaceOne, replaceAll, refresh, toggleOption,
    recompute,
    get matches() { return matches; },
    get state() { return state; },
  };
})();
