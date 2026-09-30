'use strict';

/**
 * SaraText - document / tab model
 *
 * Holds one Doc object per open file. The textarea is a single shared
 * widget, so switching tabs means stashing the current document's text,
 * caret and scroll position, then restoring the incoming one. That keeps
 * one undo stack per "session of viewing" rather than per document, which
 * is the same trade-off Notepad++ makes and is plenty for a notepad.
 */

const Docs = (() => {
  /** @type {Array<object>} */
  let docs = [];
  /** @type {Array<number>} ids of recently closed tabs, newest last */
  let closedStack = [];
  let activeId = null;
  let seq = 0;

  let emit = () => {};

  const listeners = { change: [], active: [] };

  function on(event, fn) {
    if (listeners[event]) listeners[event].push(fn);
    return () => {
      listeners[event] = listeners[event].filter((f) => f !== fn);
    };
  }

  function fire(event, payload) {
    for (const fn of listeners[event] || []) {
      try { fn(payload); } catch (err) { console.error('[saratext] listener error', err); }
    }
  }

  /* ---------------------------------------------------------------- *
   * Document shape
   * ---------------------------------------------------------------- */

  function makeDoc(overrides = {}) {
    return {
      id: ++seq,
      path: null,             // absolute path, or null for an unsaved buffer
      name: 'Untitled',
      text: '',
      savedText: '',          // snapshot at last save, drives the dirty dot
      encoding: 'utf8',
      bom: false,
      eol: 'LF',
      readonly: false,
      caret: { start: 0, end: 0 },
      scrollTop: 0,
      scrollLeft: 0,
      /**
       * View mode for this tab: 'edit' | 'split' | 'preview'. Per document
       * rather than global, so switching tabs restores the view that tab was
       * left in - the same reasoning as `caret` and `scrollTop`.
       */
      view: 'edit',
      dirty: false,
      size: 0,
      ...overrides,
    };
  }

  const isDirty = (doc) => doc.text !== doc.savedText;

  function newDoc(overrides = {}) {
    return makeDoc({ newFile: true, ...overrides });
  }

  /* ---------------------------------------------------------------- *
   * Queries
   * ---------------------------------------------------------------- */

  const all = () => docs;
  const get = (id) => docs.find((d) => d.id === id) || null;
  const active = () => get(activeId);
  const indexOf = (id) => docs.findIndex((d) => d.id === id);
  const count = () => docs.length;

  function basename(filePath) {
    if (!filePath) return 'Untitled';
    const parts = filePath.split(/[\\/]/);
    return parts[parts.length - 1] || filePath;
  }

  /** "3 modified" style summary used by the close guard. */
  function dirtyDocs() {
    return docs.filter(isDirty);
  }

  /* ---------------------------------------------------------------- *
   * Mutations
   * ---------------------------------------------------------------- */

  function add(doc, { activate = true } = {}) {
    docs.push(doc);
    fire('change', { type: 'add', doc });
    if (activate) setActive(doc.id);
    return doc;
  }

  function openFile(file) {
    // If the same path is already open, focus that tab instead of duplicating.
    const existing = docs.find((d) => d.path && file.path && d.path === file.path);
    if (existing) {
      setActive(existing.id);
      if (file.text !== undefined && existing.text !== file.text && !isDirty(existing)) {
        existing.text = file.text;
        existing.savedText = file.text;
        fire('change', { type: 'reload', doc: existing });
      }
      return existing;
    }

    const eol = /\r\n/.test(file.text || '') ? 'CRLF' : 'LF';
    const doc = makeDoc({
      path: file.path || null,
      name: basename(file.path),
      text: file.text || '',
      savedText: file.text || '',
      encoding: file.encoding || 'utf8',
      bom: Boolean(file.bom),
      eol,
      size: file.size || 0,
    });
    return add(doc);
  }

  function close(id) {
    const idx = indexOf(id);
    if (idx === -1) return null;
    const [doc] = docs.splice(idx, 1);

    if (doc.path || doc.text) closedStack.push(doc);
    if (closedStack.length > 25) closedStack.shift();

    if (activeId === id) {
      // Prefer the tab to the right, else the one to the left.
      const next = docs[idx] || docs[idx - 1] || null;
      activeId = next ? next.id : null;
      fire('active', active());
    }
    fire('change', { type: 'close', doc });
    return doc;
  }

  function reopenLast() {
    const doc = closedStack.pop();
    if (!doc) return null;
    // A path-based doc may have been re-opened in the meantime.
    const clash = doc.path && docs.find((d) => d.path === doc.path);
    if (clash) { setActive(clash.id); return clash; }
    docs.push(doc);
    fire('change', { type: 'add', doc });
    setActive(doc.id);
    return doc;
  }

  const canReopen = () => closedStack.length > 0;

  function setActive(id) {
    if (activeId === id) return;
    const doc = get(id);
    if (!doc) return;
    activeId = id;
    fire('active', doc);
  }

  function cycle(step = 1) {
    if (docs.length < 2) return;
    const idx = indexOf(activeId);
    const next = (idx + step + docs.length) % docs.length;
    setActive(docs[next].id);
  }

  /** Move a tab to an explicit index (drag & drop reordering). */
  function reorder(id, toIndex) {
    const from = indexOf(id);
    if (from === -1) return;
    const [doc] = docs.splice(from, 1);
    docs.splice(Math.max(0, Math.min(docs.length, toIndex)), 0, doc);
    fire('change', { type: 'reorder' });
  }

  /** Update the buffer text and recompute dirty state. */
  function setText(id, text) {
    const doc = get(id);
    if (!doc) return;
    doc.text = text;
    doc.dirty = isDirty(doc);
  }

  function markSaved(id, { path, encoding, text } = {}) {
    const doc = get(id);
    if (!doc) return;
    if (path) { doc.path = path; doc.name = basename(path); }
    if (encoding) doc.encoding = encoding;
    if (text !== undefined) doc.text = text;
    doc.savedText = doc.text;
    doc.dirty = false;
    fire('change', { type: 'saved', doc });
  }

  /** Snapshot the live editor state onto the active doc before switching. */
  function stash(id, state) {
    const doc = get(id);
    if (!doc) return;
    Object.assign(doc, state);
    doc.dirty = isDirty(doc);
  }

  function reset() {
    docs = [];
    closedStack = [];
    activeId = null;
    seq = 0;
  }

  return {
    on, newDoc, add, openFile, close, reopenLast, canReopen,
    all, get, active, indexOf, count, dirtyDocs, isDirty,
    setActive, cycle, reorder, setText, markSaved, stash, reset,
    basename,
    get activeId() { return activeId; },
  };
})();
