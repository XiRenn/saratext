'use strict';

/**
 * SaraText - application controller
 *
 * Boots the UI, registers every command, wires the keyboard layer and
 * owns the document lifecycle (open / save / close / autosave / session).
 */

(() => {
  /* ================================================================== *
   * Element lookup
   * ================================================================== */

  const $ = (id) => document.getElementById(id);

  const els = {
    titlebar: $('titlebar'),
    menubar: $('menubar'),
    tabs: $('tabs'),
    tabstrip: $('tabstrip'),
    newTabBtn: $('newTabBtn'),

    findbar: $('findbar'),
    findInput: $('findInput'),
    findCount: $('findCount'),
    replaceGroup: $('replaceGroup'),
    replaceInput: $('replaceInput'),
    optCase: $('optCase'),
    optWord: $('optWord'),
    optRegex: $('optRegex'),
    findPrev: $('findPrev'),
    findNext: $('findNext'),
    replaceOne: $('replaceOne'),
    replaceAll: $('replaceAll'),
    findClose: $('findClose'),

    editorWrap: $('editorWrap'),
    gutter: $('gutter'),
    editorPane: $('editorPane'),
    currentLine: $('currentLine'),
    highlightLayer: $('highlightLayer'),
    editor: $('editor'),
    emptyState: $('emptyState'),
    emptyOpen: $('emptyOpen'),

    previewPane: $('previewPane'),
    previewBody: $('previewBody'),
    previewTitle: $('previewTitle'),

    statLnCol: $('statLnCol'),
    statSel: $('statSel'),
    statSelDiv: $('statSelDiv'),
    statCount: $('statCount'),
    statWrap: $('statWrap'),
    statEncoding: $('statEncoding'),
    statEol: $('statEol'),
    statPath: $('statPath'),
    statZoom: $('statZoom'),

    paletteOverlay: $('paletteOverlay'),
    paletteInput: $('paletteInput'),
    paletteList: $('paletteList'),

    modalOverlay: $('modalOverlay'),
    modalTitle: $('modalTitle'),
    modalBody: $('modalBody'),
    modalField: $('modalField'),
    modalInput: $('modalInput'),
    modalActions: $('modalActions'),

    fontOverlay: $('fontOverlay'),
    fontFamilyInput: $('fontFamilyInput'),
    fontList: $('fontList'),
    fontSize: $('fontSize'),
    fontSizeUp: $('fontSizeUp'),
    fontSizeDown: $('fontSizeDown'),
    fontSizeLabel: $('fontSizeLabel'),
    fontSample: $('fontSample'),
    fontNote: $('fontNote'),
    fontLigatures: $('fontLigatures'),
    fontApply: $('fontApply'),
    fontCancel: $('fontCancel'),
    fontReset: $('fontReset'),

    toasts: $('toasts'),
  };

  let zoom = 100;
  let autoSaveTimer = null;
  let booted = false;

  /* ================================================================== *
   * Toasts
   * ================================================================== */

  function toast(message, kind = 'info', ms = 2600) {
    const el = document.createElement('div');
    el.className = `toast toast--${kind}`;
    el.textContent = message;
    els.toasts.appendChild(el);

    const remove = () => {
      el.classList.add('toast--leaving');
      setTimeout(() => el.remove(), 200);
    };
    const timer = setTimeout(remove, ms);
    el.addEventListener('click', () => { clearTimeout(timer); remove(); });
  }

  /* ================================================================== *
   * Modal
   * ================================================================== */

  /**
   * Show a modal and resolve with the chosen button index.
   * `buttons` is [{ label, value, kind }].
   */
  function modal({ title, body = '', field = false, value = '', placeholder = '', buttons }) {
    return new Promise((resolve) => {
      els.modalTitle.textContent = title;
      els.modalBody.textContent = body;
      els.modalField.hidden = !field;
      els.modalInput.value = value;
      els.modalInput.placeholder = placeholder;
      els.modalActions.replaceChildren();

      const finish = (result) => {
        els.modalOverlay.hidden = true;
        document.removeEventListener('keydown', onKey, true);
        resolve(result);
      };

      buttons.forEach((btn, i) => {
        const b = document.createElement('button');
        b.className = 'modal__btn' + (btn.kind ? ` modal__btn--${btn.kind}` : '');
        b.textContent = btn.label;
        b.addEventListener('click', () => {
          finish({ value: btn.value, index: i, text: field ? els.modalInput.value : undefined });
        });
        els.modalActions.appendChild(b);
      });

      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish({ value: null, index: -1, cancelled: true }); }
        else if (e.key === 'Enter' && field) { e.preventDefault(); e.stopPropagation(); finish({ value: buttons[0].value, index: 0, text: els.modalInput.value }); }
      }
      document.addEventListener('keydown', onKey, true);

      els.modalOverlay.hidden = false;
      if (field) { els.modalInput.focus(); els.modalInput.select(); }
      else els.modalActions.firstChild && els.modalActions.firstChild.focus();
    });
  }

  /* ================================================================== *
   * Document lifecycle
   * ================================================================== */

  const editorRefs = {
    textarea: els.editor,
    gutter: els.gutter,
    highlight: els.highlightLayer,
    pane: els.editorPane,
    wrap: els.editorWrap,
    band: els.currentLine,
  };

  /** Copy live editor state onto the active doc before switching away. */
  function stashActive() {
    const doc = Docs.active();
    if (!doc) return;
    const caret = Editor.caret();
    Docs.stash(doc.id, {
      text: Editor.getText(),
      caret: { start: caret.start, end: caret.end },
      scrollTop: els.editor.scrollTop,
      scrollLeft: els.editor.scrollLeft,
    });
  }

  /** Load a doc into the shared textarea widget. */
  function presentDoc(doc) {
    if (!doc) {
      els.editor.value = '';
      els.editor.disabled = true;
      els.emptyState.hidden = false;
      Preview.setMode('edit');
      Preview.render(null);
      renderTabs();
      updateStatus();
      updateTitle();
      return;
    }

    els.editor.disabled = false;
    els.emptyState.hidden = true;

    // Assigning .value resets the native undo stack; that is the trade-off
    // of a single shared textarea, and matches Notepad++ behaviour.
    els.editor.value = doc.text;
    const safe = {
      start: Math.min(doc.caret?.start ?? 0, doc.text.length),
      end: Math.min(doc.caret?.end ?? doc.caret?.start ?? 0, doc.text.length),
    };
    els.editor.setSelectionRange(safe.start, safe.end);
    els.editor.scrollTop = doc.scrollTop || 0;
    els.editor.scrollLeft = doc.scrollLeft || 0;

    Editor.render();
    Editor.refreshCaret();
    // Restore this tab's view, then paint it. `setMode` is a no-op repaint
    // when the mode is unchanged, so the content render below is what
    // actually updates a tab switch inside the same mode.
    Preview.setMode(doc.view || 'edit');
    Preview.render(doc);
    renderTabs();
    updateStatus();
    updateTitle();
    Search.refresh();
  }

  function newFile({ activate = true } = {}) {
    const doc = Docs.newDoc();
    Docs.add(doc, { activate });
    if (activate) presentDoc(doc);
    return doc;
  }

  async function openPaths(paths) {
    if (!paths.length) return;
    let last = null;
    for (const p of paths) {
      const res = await window.sara.readFile(p);
      if (!res.ok) {
        toast(`Could not open ${Docs.basename(p)}: ${res.error}`, 'error', 4200);
        Store.removeRecent(p);
        continue;
      }
      stashActive();
      const doc = Docs.openFile(res.file);
      Store.addRecent(res.file.path);
      last = doc;
      if (res.file.lossy) {
        toast(`${doc.name} may not be UTF-8 — characters could look wrong`, 'warn', 4200);
      }
    }
    if (last) {
      presentDoc(Docs.active());
    }
  }

  async function cmdOpen() {
    const res = await window.sara.openFiles({ multiple: true, title: 'Open' });
    if (!res.ok || !res.files) return;
    stashActive();
    let last = null;
    for (const file of res.files) {
      last = Docs.openFile(file);
      Store.addRecent(file.path);
    }
    if (last) presentDoc(Docs.active());
    if (res.errors && res.errors.length) {
      toast(`${res.errors.length} file(s) could not be read`, 'warn');
    }
    if (res.files.length === 1) toast(`Opened ${last.name}`, 'ok', 1600);
  }

  /**
   * Save the active document. `as` forces the Save-As dialog.
   * Returns 'saved' | 'canceled' | 'error'.
   */
  async function saveActive({ as = false } = {}) {
    const doc = Docs.active();
    if (!doc) return 'canceled';

    if (doc.readonly && !as) {
      toast(`${doc.name} is read-only`, 'warn');
      return 'error';
    }

    const contents = doc.id === Docs.activeId ? Editor.getText() : doc.text;
    const res = await window.sara.saveFile({
      filePath: doc.path,
      contents,
      forceDialog: as || !doc.path,
      suggestedName: doc.name,
      encoding: doc.encoding,
    });

    if (!res.ok) {
      if (res.canceled) return 'canceled';
      toast(`Save failed: ${res.error}`, 'error', 4500);
      return 'error';
    }

    Docs.markSaved(doc.id, { path: res.path, text: contents });
    Store.addRecent(res.path);
    Store.dropDraft(doc.id);

    if (doc.id === Docs.activeId) {
      updateTitle();
      updateStatus();
      Search.refresh();
    }
    renderTabs();
    toast(`Saved ${Docs.basename(res.path)}`, 'ok', 1500);
    return 'saved';
  }

  /** Ask about unsaved work in one doc. Returns true when it's safe to proceed. */
  async function confirmDiscard(doc) {
    const res = await window.sara.confirm({
      type: 'warning',
      message: `Save changes to "${doc.name}"?`,
      detail: 'Your changes will be lost if you don\'t save them.',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });

    if (res.response === 2) return false;         // Cancel
    if (res.response === 0) {                     // Save
      const before = Docs.activeId;
      Docs.setActive(doc.id);
      stashActive();
      const outcome = await saveActive({});
      if (outcome !== 'saved') {
        // Restore focus to whatever was active before, then abort.
        if (before && Docs.get(before)) { Docs.setActive(before); presentDoc(Docs.get(before)); }
        return false;
      }
      return true;
    }
    return true;                                  // Don't Save
  }

  async function closeTab(id) {
    const doc = Docs.get(id);
    if (!doc) return;
    if (Docs.isDirty(doc)) {
      if (Docs.activeId !== id) { stashActive(); Docs.setActive(id); presentDoc(doc); }
      const ok = await confirmDiscard(doc);
      if (!ok) return;
    }
    Store.dropDraft(doc.id);

    // Never leave zero tabs open - a fresh empty buffer replaces the last one.
    const wasLast = Docs.count() === 1;
    if (wasLast) {
      Docs.reset();
      newFile();
      return;
    }

    const idx = Docs.indexOf(id);
    Docs.close(id);
    const next = Docs.get(Docs.activeId) || Docs.all()[Math.min(idx, Docs.count() - 1)];
    if (next) Docs.setActive(next.id);
    presentDoc(Docs.active());
  }

  async function closeOthers(keepId) {
    const others = Docs.all().filter((d) => d.id !== keepId);
    for (const doc of others) {
      if (Docs.isDirty(doc)) {
        Docs.setActive(doc.id);
        stashActive();
        Docs.setActive(keepId);
        const ok = await confirmDiscard(doc);
        if (!ok) return;
      }
      Store.dropDraft(doc.id);
      Docs.close(doc.id);
    }
    Docs.setActive(keepId);
    presentDoc(Docs.active());
  }

  /* ================================================================== *
   * Title + tabs + status
   * ================================================================== */

  function updateTitle() {
    const doc = Docs.active();
    if (!doc) {
      document.title = 'SaraText';
      return;
    }
    const dirty = Docs.isDirty(doc) ? '● ' : '';
    document.title = `${dirty}${doc.name} — SaraText`;
  }

  function renderTabs() {
    const activeId = Docs.activeId;
    const frag = document.createDocumentFragment();

    for (const doc of Docs.all()) {
      const tab = document.createElement('div');
      tab.className = 'tab' + (doc.id === activeId ? ' tab--active' : '');
      tab.dataset.id = doc.id;
      tab.setAttribute('role', 'tab');
      tab.title = doc.path || `${doc.name} (unsaved)`;

      if (Docs.isDirty(doc)) {
        const dot = document.createElement('span');
        dot.className = 'tab__dot';
        tab.appendChild(dot);
      }

      const name = document.createElement('span');
      name.className = 'tab__name';
      name.textContent = doc.name;
      tab.appendChild(name);

      const close = document.createElement('button');
      close.className = 'tab__close';
      close.type = 'button';
      close.textContent = '✕';
      close.title = 'Close (Ctrl+W)';
      close.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeTab(doc.id);
      });
      tab.appendChild(close);

      tab.addEventListener('mousedown', (e) => {
        if (e.button === 1) { e.preventDefault(); closeTab(doc.id); return; }
        if (e.button !== 0) return;
        if (doc.id === Docs.activeId) return;
        stashActive();
        Docs.setActive(doc.id);
        presentDoc(Docs.active());
      });

      frag.appendChild(tab);
    }

    els.tabs.replaceChildren(frag);
    const activeTab = els.tabs.querySelector('.tab--active');
    if (activeTab && activeTab.scrollIntoView) {
      activeTab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function updateStatus() {
    const doc = Docs.active();
    StatusBar.update({
      caret: Editor.caret(),
      doc,
      zoom,
      wrap: Store.get('wordWrap'),
      encoding: doc ? doc.encoding : 'utf8',
    });
  }

  /* ================================================================== *
   * Font
   *
   * Two independent axes: `fontSize` (the document's type size) and
   * `zoom` (a view multiplier). They multiply - the editor is rendered at
   * `fontSize * zoom / 100` - so resetting the zoom never silently
   * discards a chosen font size.
   * ================================================================== */

  const DEFAULT_FONT_SIZE = 12.5;

  const currentFontSize = () => Number(Store.get('fontSize')) || DEFAULT_FONT_SIZE;

  /** Push the stored font onto the editor. `size` overrides the pref. */
  function applyFont({ size = currentFontSize(), family = Store.get('fontFamily'), ligatures = Store.get('fontLigatures') } = {}) {
    Editor.applyFont(size * (zoom / 100), family);
    els.editorWrap.dataset.font = ligatures ? 'ligatures' : 'normal';
    updateStatus();
  }

  function cmdFont() {
    FontDialog.open({
      family: Store.get('fontFamily'),
      size: currentFontSize(),
      ligatures: Store.get('fontLigatures'),
    });
  }

  /** Committed by the dialog: persist, then apply. */
  function commitFont({ family, size, ligatures }) {
    Store.patch({ fontFamily: family, fontSize: size, fontLigatures: ligatures });
    applyFont({ size, family, ligatures });
    StatusBar.flash(`Font: ${family || 'default'} ${size}px`);
  }

  function cmdResetFont() {
    Store.patch({ fontFamily: null, fontSize: DEFAULT_FONT_SIZE, fontLigatures: null });
    applyFont({ size: DEFAULT_FONT_SIZE, family: null, ligatures: null });
    toast('Editor font reset', 'info', 1400);
  }

  /* ================================================================== *
   * Zoom / wrap / theme
   * ================================================================== */

  function applyZoom(percent) {
    zoom = Math.max(50, Math.min(300, Math.round(percent)));
    Store.set('zoom', zoom);
    // The zoom multiplies the stored font size rather than replacing it.
    applyFont();
  }

  function cmdZoomIn() { applyZoom(zoom + 10); }
  function cmdZoomOut() { applyZoom(zoom - 10); }
  function cmdZoomReset() { applyZoom(100); }

  function applyWrap(on) {
    Store.set('wordWrap', on);
    Editor.setWrap(on);
    updateStatus();
  }

  function cmdToggleWrap() {
    applyWrap(!Store.get('wordWrap'));
    toast(`Word wrap ${Store.get('wordWrap') ? 'on' : 'off'}`, 'info', 1200);
  }

  function applyTheme(theme) {
    Store.set('theme', theme);
    document.documentElement.dataset.theme = theme;
    MenuBar.refresh();
  }

  function cmdToggleTheme() {
    const next = Store.get('theme') === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    toast(`${next === 'dark' ? 'Dark' : 'Light'} theme`, 'info', 1200);
  }

  /* ================================================================== *
   * Markdown preview
   * ================================================================== */

  /**
   * Switch the editor / preview layout.
   *
   * The mode is stored on the document so it survives a tab switch. The
   * editor is re-measured afterwards because the gutter, the current-line
   * band and the highlight layer are all derived from the pane's geometry,
   * which a mode change moves.
   */
  function applyView(mode) {
    const doc = Docs.active();
    const next = Preview.setMode(mode);
    if (doc) doc.view = next;

    if (next !== 'preview') {
      Editor.measure();
      Editor.render();
      Editor.refreshCaret();
    }
    MenuBar.refresh();
    return next;
  }

  function activeDocOrWarn() {
    const doc = Docs.active();
    if (!doc) toast('Open a document first', 'warn', 1600);
    return doc;
  }

  function cmdTogglePreview() {
    const doc = activeDocOrWarn();
    if (!doc) return;
    const next = doc.view === 'split' ? 'edit' : 'split';
    applyView(next);
    toast(next === 'split' ? 'Preview: side by side' : 'Preview closed', 'info', 1400);
  }

  function cmdPreviewOnly() {
    const doc = activeDocOrWarn();
    if (!doc) return;
    applyView(doc.view === 'preview' ? 'edit' : 'preview');
  }

  /**
   * Collapse `.` and `..` segments without touching the filesystem.
   * @returns {string|null} null when the path would climb above its root
   */
  function normalisePath(value) {
    const out = [];
    for (const part of String(value).split(/[\\/]+/)) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (out.length <= 1) return null;   // nothing left to climb into
        out.pop();
        continue;
      }
      out.push(part);
    }
    return out.join('\\');
  }

  /**
   * Resolve a click in the preview pane.
   *
   * Web links go to the OS browser through the main process. Everything else
   * is a path relative to the document that contains it, and is only
   * followed while it stays inside that document's own folder: a markdown
   * file must not be able to talk the reader into opening
   * `..\..\Users\…\.ssh\id_rsa` just by labelling the link "docs".
   */
  async function openPreviewLink(href, doc) {
    const url = String(href || '').trim();
    if (!url) return;

    if (/^(?:https?|mailto):/i.test(url)) {
      if (!window.sara.openExternal) return;
      try {
        const res = await window.sara.openExternal(url);
        if (res && res.ok === false) toast(`Could not open the link: ${res.error}`, 'warn', 3000);
      } catch (err) {
        // The click handler does not await this, so a rejection here would
        // surface as an unhandled rejection rather than anything visible.
        toast(`Could not open the link: ${err.message}`, 'warn', 3000);
      }
      return;
    }

    if (!doc || !doc.path) {
      toast('Save this file first — the link is relative to it', 'warn', 3000);
      return;
    }

    const dir = normalisePath(doc.path.replace(/[\\/][^\\/]*$/, ''));
    const rel = url.split('/').join('\\');
    const resolved = dir && normalisePath(/^[a-z]:[\\/]/i.test(rel) ? rel : `${dir}\\${rel}`);

    if (!dir || !resolved || !resolved.toLowerCase().startsWith(`${dir.toLowerCase()}\\`)) {
      toast("Links are only followed inside the document's own folder", 'warn', 3600);
      return;
    }

    await openPaths([resolved]);
  }

  /* ================================================================== *
   * Autosave
   * ================================================================== */

  function syncActiveText() {
    const doc = Docs.active();
    if (!doc) return;
    const text = Editor.getText();
    if (text === doc.text) return;
    Docs.setText(doc.id, text);
    updateTitle();
    renderTabs();
  }

  function startAutoSave() {
    clearInterval(autoSaveTimer);
    if (!Store.get('autoSaveEnabled')) return;

    autoSaveTimer = setInterval(async () => {
      const doc = Docs.active();
      if (!doc || !Docs.isDirty(doc)) return;
      syncActiveText();

      // Draft snapshots keep unsaved work recoverable after a crash.
      await Store.saveDraft(doc.id, {
        path: doc.path,
        name: doc.name,
        text: doc.text,
        encoding: doc.encoding,
        caret: doc.caret,
        savedAt: Date.now(),
      });

      // Files that already have a path are written straight through.
      if (doc.path && Store.get('autoSaveEnabled')) {
        const res = await window.sara.saveFile({
          filePath: doc.path,
          contents: doc.text,
          encoding: doc.encoding,
        });
        if (res.ok) {
          Docs.markSaved(doc.id, { text: doc.text });
          updateTitle();
          renderTabs();
          StatusBar.flash('Auto-saved');
        }
      }
    }, Store.get('autoSaveIntervalMs') || 5000);
  }

  /* ================================================================== *
   * Session
   * ================================================================== */

  async function saveSession() {
    if (!Store.get('restoreSession')) return;
    stashActive();
    const data = {
      activeId: Docs.activeId,
      docs: Docs.all().map((d) => ({
        id: d.id,
        path: d.path,
        name: d.name,
        text: d.path ? '' : d.text,     // don't duplicate on-disk contents
        encoding: d.encoding,
        eol: d.eol,
        caret: d.caret,
        scrollTop: d.scrollTop,
        scrollLeft: d.scrollLeft,
        view: d.view || 'edit',
        dirty: Docs.isDirty(d),
      })),
      savedAt: Date.now(),
    };
    await Store.saveSession(data);
  }

  async function restoreSession() {
    const data = await Store.loadSession();
    let restored = 0;

    if (data && Array.isArray(data.docs) && data.docs.length) {
      for (const entry of data.docs) {
        let doc = null;
        if (entry.path) {
          const res = await window.sara.readFile(entry.path);
          if (res.ok) {
            doc = Docs.openFile(res.file);
          } else {
            // The file moved or was deleted - fall back to the draft if we have one.
            const draft = await Store.loadDraft(entry.id);
            if (draft && draft.text) {
              doc = Docs.newDoc({ name: `${entry.name} (recovered)`, text: draft.text, savedText: '' });
              toast(`Recovered unsaved changes for ${entry.name}`, 'warn', 4000);
            } else {
              Store.removeRecent(entry.path);
            }
          }
        } else {
          const draft = await Store.loadDraft(entry.id);
          const text = (draft && draft.text) || entry.text || '';
          doc = Docs.newDoc({ name: entry.name || 'Untitled', text, savedText: '' });
          if (draft && draft.text) doc.recovered = true;
        }

        if (doc) {
          doc.caret = entry.caret || { start: 0, end: 0 };
          doc.scrollTop = entry.scrollTop || 0;
          doc.scrollLeft = entry.scrollLeft || 0;
          // An unknown mode from an older session falls back to editing.
          doc.view = Preview.MODES.includes(entry.view) ? entry.view : 'edit';
          restored++;
        }
      }

      if (data.activeId) {
        const match = Docs.all()[data.docs.findIndex((d) => d.id === data.activeId)];
        if (match) Docs.setActive(match.id);
      }
    }

    // Anything left in the drafts folder that isn't part of the session is
    // an orphan from a crash - offer it back.
    if (!restored) {
      const drafts = await Store.listDrafts();
      for (const id of drafts) {
        // `listDrafts` returns the raw draft ids (`tab-7`); `loadDraft`
        // expects a tab id and re-prefixes it, so strip it back off here.
        const tabId = id.startsWith('tab-') ? id.slice(4) : id;
        const draft = await Store.loadDraft(tabId);
        if (!draft || !draft.text || !draft.text.trim()) continue;
        const alreadyOpen = Docs.all().some((d) => d.path && d.path === draft.path);
        if (alreadyOpen) continue;
        Docs.newDoc({
          name: draft.path ? Docs.basename(draft.path) : `${draft.name || 'Untitled'} (recovered)`,
          path: null,
          text: draft.text,
          savedText: draft.path ? '' : draft.text,
        });
        restored++;
      }
      if (restored) toast(`Recovered ${restored} unsaved document(s)`, 'warn', 4500);
    }

    if (!Docs.count()) newFile({ activate: true });
    else presentDoc(Docs.active());

    return restored;
  }

  /* ================================================================== *
   * Misc commands
   * ================================================================== */

  async function cmdGoToLine() {
    const res = await modal({
      title: 'Go to Line',
      body: `Enter a line number between 1 and ${Editor.lineCount()}.`,
      field: true,
      value: '',
      placeholder: String(Editor.caret().line),
      buttons: [
        { label: 'Go', value: 'go', kind: 'primary' },
        { label: 'Cancel', value: null },
      ],
    });
    if (res.cancelled || !res.text) return;
    const n = parseInt(res.text, 10);
    if (!Number.isFinite(n) || n < 1) { toast('Enter a valid line number', 'warn'); return; }
    Editor.goToLine(n);
    StatusBar.flash(`Line ${n}`);
  }

  function cmdSelectAll() { Editor.selectAll(); }

  async function cmdNewWindow() {
    // Windows/Linux: spawning is handled by the single-instance lock, so we
    // simply surface a fresh tab instead - a second window would be blocked.
    newFile();
    toast('New document', 'info', 1200);
  }

  async function cmdOpenRecent() {
    const recents = Store.get('recentFiles') || [];
    if (!recents.length) { toast('No recent files yet', 'warn'); return; }
    Palette.open('');
  }

  async function cmdClearRecent() {
    const res = await modal({
      title: 'Clear Recent Files',
      body: 'This removes the recent files list. The files themselves are not touched.',
      buttons: [
        { label: 'Clear', value: 'clear', kind: 'danger' },
        { label: 'Cancel', value: null },
      ],
    });
    if (res.value !== 'clear') return;
    Store.clearRecent();
    toast('Recent files cleared', 'ok', 1600);
  }

  async function cmdEncoding() {
    const doc = Docs.active();
    if (!doc) return;
    const res = await modal({
      title: 'File Encoding',
      body: `Current: ${doc.encoding.toUpperCase()}${doc.bom ? ' (with BOM)' : ''}\nApplies the next time this file is saved.`,
      buttons: [
        { label: 'UTF-8', value: 'utf8', kind: 'primary' },
        { label: 'UTF-16 LE', value: 'utf16le' },
        { label: 'Cancel', value: null },
      ],
    });
    if (!res.value) return;
    doc.encoding = res.value;
    updateStatus();
    toast(`Encoding set to ${res.value.toUpperCase()}`, 'ok', 1600);
  }

  async function cmdAbout() {
    const info = await window.sara.appInfo();
    await modal({
      title: `SaraText ${info.version}`,
      body: [
        'A fast, minimal notepad.',
        '',
        `Electron  ${info.electron}`,
        `Node      ${info.node}`,
        `Chromium  ${info.chrome}`,
        `Platform  ${info.platform}`,
        '',
        'Press Ctrl+Space for the command palette, F1 for shortcuts.',
      ].join('\n'),
      buttons: [{ label: 'Close', value: null, kind: 'primary' }],
    });
  }

  async function cmdShortcuts() {
    await modal({
      title: 'Keyboard Shortcuts',
      body: [
        'FILE',
        '  Ctrl+N            New          Ctrl+O        Open',
        '  Ctrl+S            Save         Ctrl+Shift+S  Save As',
        '  Ctrl+W            Close tab    Ctrl+Shift+T  Reopen closed',
        '  Ctrl+Tab          Next tab     Ctrl+P        Recent files',
        '',
        'EDIT',
        '  Ctrl+Z / Ctrl+Y   Undo / Redo',
        '  Ctrl+X / C / V    Cut / Copy / Paste',
        '  Ctrl+D            Duplicate line',
        '  Ctrl+Shift+D      Delete line',
        '  Alt+↑ / Alt+↓     Move line up / down',
        '  Ctrl+/            Toggle comment',
        '  Tab / Shift+Tab   Indent at caret / selected lines',
        '',
        'SEARCH',
        '  Ctrl+F            Find         Ctrl+H        Replace',
        '  F3 / Shift+F3     Next / prev  Ctrl+G        Go to line',
        '',
        'VIEW',
        '  Ctrl+Shift+F      Choose font',
        '  Ctrl+= / Ctrl+-   Zoom in / out       Ctrl+0  Reset zoom',
        '  Alt+Z             Word wrap           F11     Fullscreen',
        '  Ctrl+Shift+L      Toggle theme        Ctrl+Space    Palette',
        '  Ctrl+Shift+M      Preview side by side',
        '  Ctrl+Shift+E      Preview full pane',
        '',
        'MOUSE',
        '  Right-click       Context menu (editor, tabs, chrome)',
        '',
        'SYSTEM',
        '  Ctrl+,            Settings     F1            This list',
        `  ${Commands.displayAccel(Store.get('globalHotkey') || '')}   Summon window from anywhere`,
      ].join('\n'),
      buttons: [{ label: 'Close', value: null, kind: 'primary' }],
    });
  }

  async function cmdSettings() {
    const hotkey = Store.get('globalHotkey') || '';
    const res = await modal({
      title: 'Settings',
      body: [
        'Auto-save drafts keeps unsaved work recoverable and writes files that',
        'already have a path. The global hotkey summons the window from any app.',
        '',
        `Global hotkey: ${Commands.displayAccel(hotkey)}`,
      ].join('\n'),
      buttons: [
        { label: 'Toggle auto-save', value: 'autosave' },
        { label: 'Toggle hotkey', value: 'hotkey' },
        { label: 'Close', value: null, kind: 'primary' },
      ],
    });

    if (res.value === 'autosave') {
      const next = !Store.get('autoSaveEnabled');
      Store.set('autoSaveEnabled', next);
      startAutoSave();
      toast(`Auto-save ${next ? 'enabled' : 'disabled'}`, 'ok', 1800);
    } else if (res.value === 'hotkey') {
      const next = !Store.get('globalHotkeyEnabled');
      Store.set('globalHotkeyEnabled', next);
      await applyGlobalHotkey();
      toast(`Global hotkey ${next ? 'enabled' : 'disabled'}`, 'ok', 1800);
    }
  }

  async function applyGlobalHotkey() {
    const enabled = Store.get('globalHotkeyEnabled');
    const accel = enabled ? Store.get('globalHotkey') : null;
    if (!window.sara.setGlobalHotkey) return;
    const res = await window.sara.setGlobalHotkey(accel);
    if (enabled && !res.ok) {
      toast(`Could not register ${Commands.displayAccel(accel)} — another app may own it`, 'warn', 4200);
      Store.set('globalHotkeyEnabled', false);
    }
  }

  async function cmdAlwaysOnTop() {
    const st = await window.sara.windowAction('always-on-top');
    const on = Boolean(st && st.alwaysOnTop);
    Store.set('alwaysOnTop', on);
    toast(`Always on top ${on ? 'enabled' : 'disabled'}`, 'info', 1600);
    MenuBar.refresh();
  }

  async function cmdRevealInExplorer() {
    const doc = Docs.active();
    if (!doc || !doc.path) { toast('This document has not been saved yet', 'warn'); return; }
    await window.sara.revealFile(doc.path);
  }

  async function cmdCopyPath() {
    const doc = Docs.active();
    if (!doc) return;
    const value = doc.path || doc.name;
    await navigator.clipboard.writeText(value);
    toast('Path copied', 'ok', 1400);
  }

  function cmdToggleFullscreen() {
    window.sara.windowAction('fullscreen-toggle');
    // The main process reports back through window:query on the next tick.
    setTimeout(async () => {
      const st = await window.sara.windowState();
      if (st && st.ok) {
        document.body.classList.toggle('is-fullscreen', st.fullscreen);
        els.titlebar.style.display = st.fullscreen ? 'none' : '';
      }
    }, 60);
  }

  /* ================================================================== *
   * Command registration
   * ================================================================== */

  function registerCommands() {
    const C = Commands;
    const noDoc = () => Docs.count() > 0;
    const hasSelection = () => Editor.getSelection().text.length > 0;

    /* -- File ------------------------------------------------------- */
    C.register({ id: 'file.new', label: 'New', accel: 'ctrl+n', category: 'File',
      run: () => { stashActive(); newFile(); } });

    C.register({ id: 'file.open', label: 'Open…', accel: 'ctrl+o', category: 'File',
      run: cmdOpen });

    C.register({ id: 'file.save', label: 'Save', accel: 'ctrl+s', category: 'File',
      enabled: noDoc, run: () => saveActive({}) });

    C.register({ id: 'file.saveAs', label: 'Save As…', accel: 'ctrl+shift+s', category: 'File',
      enabled: noDoc, run: () => saveActive({ as: true }) });

    C.register({ id: 'file.close', label: 'Close Tab', accel: 'ctrl+w', category: 'File',
      enabled: noDoc, run: () => closeTab(Docs.activeId) });

    C.register({ id: 'file.closeOthers', label: 'Close Other Tabs', category: 'File',
      enabled: () => Docs.count() > 1, run: () => closeOthers(Docs.activeId) });

    C.register({ id: 'file.reopenClosed', label: 'Reopen Closed Tab', accel: 'ctrl+shift+t', category: 'File',
      enabled: () => Docs.canReopen(),
      run: () => {
        const doc = Docs.reopenLast();
        if (doc) { stashActive(); presentDoc(doc); }
        else toast('Nothing to reopen', 'warn', 1400);
      } });

    C.register({ id: 'file.recent', label: 'Open Recent…', accel: 'ctrl+p', category: 'File',
      run: () => Palette.open('') });

    C.register({ id: 'file.clearRecent', label: 'Clear Recent Files', category: 'File',
      hidden: true, enabled: () => (Store.get('recentFiles') || []).length > 0, run: cmdClearRecent });

    C.register({ id: 'file.encoding', label: 'Encoding…', category: 'File',
      enabled: noDoc, run: cmdEncoding });

    C.register({ id: 'file.reveal', label: 'Reveal in Explorer', category: 'File',
      enabled: () => Boolean(Docs.active() && Docs.active().path), run: cmdRevealInExplorer });

    C.register({ id: 'file.copyPath', label: 'Copy File Path', category: 'File',
      enabled: noDoc, run: cmdCopyPath });

    C.register({ id: 'file.quit', label: 'Exit', accel: 'ctrl+q', category: 'File',
      run: () => window.sara.windowAction('close') });

    /* -- Edit ------------------------------------------------------- */
    C.register({ id: 'edit.undo', label: 'Undo', accel: 'ctrl+z', category: 'Edit',
      run: () => document.execCommand('undo') });
    C.register({ id: 'edit.redo', label: 'Redo', accel: 'ctrl+y', category: 'Edit',
      run: () => document.execCommand('redo') });

    // Clipboard verbs go through the main-process clipboard rather than
    // `document.execCommand`. The context menu is exactly the case that
    // forces this: the press that opened it moved focus off the textarea,
    // so execCommand('cut'/'copy') silently does nothing there.
    C.register({ id: 'edit.cut', label: 'Cut', accel: 'ctrl+x', category: 'Edit',
      enabled: hasSelection,
      run: async () => {
        if (!hasSelection()) return;
        await Editor.cutSelection();
        syncActiveText();
      } });
    C.register({ id: 'edit.copy', label: 'Copy', accel: 'ctrl+c', category: 'Edit',
      enabled: hasSelection,
      run: async () => {
        const { text } = Editor.getSelection();
        if (!text) return;
        try {
          if (window.sara && window.sara.clipboard) window.sara.clipboard.writeText(text);
          else await navigator.clipboard.writeText(text);
        } catch { toast('Could not reach the clipboard', 'warn', 2200); }
      } });
    C.register({ id: 'edit.paste', label: 'Paste', accel: 'ctrl+v', category: 'Edit',
      enabled: noDoc,
      run: async () => {
        let text = '';
        try {
          text = (window.sara && window.sara.clipboard)
            ? window.sara.clipboard.readText()
            : await navigator.clipboard.readText();
        } catch { return; }
        if (!text) return;
        Editor.insertAtCaret(text);
        syncActiveText();
      } });
    C.register({ id: 'edit.selectAll', label: 'Select All', accel: 'ctrl+a', category: 'Edit',
      enabled: noDoc, run: cmdSelectAll });

    C.register({ id: 'edit.deleteLine', label: 'Delete Line', accel: 'ctrl+shift+d', category: 'Edit',
      enabled: noDoc, run: () => { Editor.deleteLine(); syncActiveText(); } });
    C.register({ id: 'edit.duplicateLine', label: 'Duplicate Line', accel: 'ctrl+d', category: 'Edit',
      enabled: noDoc, run: () => { Editor.duplicateLine(); syncActiveText(); } });
    C.register({ id: 'edit.moveUp', label: 'Move Line Up', accel: 'alt+up', category: 'Edit',
      enabled: noDoc, run: () => { Editor.moveLine(-1); syncActiveText(); } });
    C.register({ id: 'edit.moveDown', label: 'Move Line Down', accel: 'alt+down', category: 'Edit',
      enabled: noDoc, run: () => { Editor.moveLine(1); syncActiveText(); } });
    C.register({ id: 'edit.comment', label: 'Toggle Line Comment', accel: 'ctrl+/', category: 'Edit',
      enabled: noDoc, run: () => { Editor.toggleComment('// '); syncActiveText(); } });
    C.register({ id: 'edit.trimTrailing', label: 'Trim Trailing Whitespace', category: 'Edit',
      enabled: noDoc,
      run: () => {
        const text = Editor.getText();
        const cleaned = text.split('\n').map((l) => l.replace(/[ \t]+$/, '')).join('\n');
        const removed = text.length - cleaned.length;
        if (!removed) { toast('Nothing to trim', 'info', 1400); return; }
        Editor.replaceRange(0, text.length, cleaned);
        syncActiveText();
        toast(`Trimmed ${removed} character(s)`, 'ok', 1600);
      } });
    C.register({ id: 'edit.toUpperCase', label: 'Convert to UPPERCASE', category: 'Edit',
      enabled: noDoc,
      run: () => transformSelection((s) => s.toUpperCase()) });
    C.register({ id: 'edit.toLowerCase', label: 'Convert to lowercase', category: 'Edit',
      enabled: noDoc,
      run: () => transformSelection((s) => s.toLowerCase()) });
    C.register({ id: 'edit.toTitleCase', label: 'Convert to Title Case', category: 'Edit',
      enabled: noDoc,
      run: () => transformSelection(toTitleCase) });

    // Destructive, so it is confined to a selection: doing it to a whole
    // document by accident is not something Ctrl+Z obviously fixes.
    C.register({ id: 'edit.truncateSelection', label: 'Truncate to 80 Columns', category: 'Edit',
      enabled: () => Editor.getSelection().text.length > 0,
      run: () => {
        const { start, end, text } = Editor.getSelection();
        if (!text) { toast('Select some text first', 'warn', 1600); return; }
        const width = 80;
        const clipped = text.split('\n').map((l) => (l.length > width ? l.slice(0, width) : l)).join('\n');
        if (clipped === text) { toast('Nothing over 80 columns', 'info', 1600); return; }
        Editor.replaceRange(start, end, clipped, true);
        syncActiveText();
        toast(`Truncated to ${width} columns`, 'ok', 1600);
      } });

    // Case-clipboard helpers. The context menu makes "copy this, then
    // paste it upper-cased" a two-click operation.
    C.register({ id: 'edit.copyUpper', label: 'Copy as UPPERCASE', category: 'Edit',
      hidden: true,
      enabled: () => Editor.getSelection().text.length > 0,
      run: () => copyTransformed((s) => s.toUpperCase()) });
    C.register({ id: 'edit.copyLower', label: 'Copy as lowercase', category: 'Edit',
      hidden: true,
      enabled: () => Editor.getSelection().text.length > 0,
      run: () => copyTransformed((s) => s.toLowerCase()) });

    /* -- Search ----------------------------------------------------- */
    C.register({ id: 'search.find', label: 'Find…', accel: 'ctrl+f', category: 'Search',
      run: () => Search.openFind() });
    C.register({ id: 'search.replace', label: 'Replace…', accel: 'ctrl+h', category: 'Search',
      run: () => Search.openReplace() });
    C.register({ id: 'search.next', label: 'Find Next', accel: 'f3', category: 'Search',
      run: () => { if (Search.isOpen()) Search.next(); else Search.openFind(); } });
    C.register({ id: 'search.prev', label: 'Find Previous', accel: 'shift+f3', category: 'Search',
      run: () => { if (Search.isOpen()) Search.prev(); else Search.openFind(); } });
    C.register({ id: 'search.goToLine', label: 'Go to Line…', accel: 'ctrl+g', category: 'Search',
      enabled: noDoc, run: cmdGoToLine });

    /* -- View ------------------------------------------------------- */
    C.register({ id: 'view.font', label: 'Font…', accel: 'ctrl+shift+f', category: 'View',
      run: cmdFont });
    C.register({ id: 'view.resetFont', label: 'Reset Editor Font', category: 'View',
      hidden: true,
      enabled: () => Store.get('fontFamily') !== null || Store.get('fontLigatures') !== null,
      run: cmdResetFont });
    C.register({ id: 'view.zoomIn', label: 'Zoom In', accel: 'ctrl+=', category: 'View', run: cmdZoomIn });
    C.register({ id: 'view.zoomOut', label: 'Zoom Out', accel: 'ctrl+-', category: 'View', run: cmdZoomOut });
    C.register({ id: 'view.zoomReset', label: 'Reset Zoom', accel: 'ctrl+0', category: 'View', run: cmdZoomReset });
    C.register({ id: 'view.sizeSmall', label: 'Window Size: 350 × 280 px', accel: 'alt+1', category: 'View',
      run: () => window.sara.windowAction('size-small') });
    C.register({ id: 'view.sizeMedium', label: 'Window Size: 480 × 350 px', accel: 'alt+2', category: 'View',
      run: () => window.sara.windowAction('size-medium') });
    C.register({ id: 'view.sizeLarge', label: 'Window Size: 700 × 600 px', accel: 'alt+3', category: 'View',
      run: () => window.sara.windowAction('size-large') });
    C.register({ id: 'view.toggleWrap', label: 'Toggle Word Wrap', accel: 'alt+z', category: 'View',
      checked: () => Boolean(Store.get('wordWrap')), run: cmdToggleWrap });
    C.register({ id: 'view.toggleTheme', label: 'Toggle Theme', accel: 'ctrl+shift+l', category: 'View',
      run: cmdToggleTheme });
    C.register({ id: 'view.fullscreen', label: 'Toggle Fullscreen', accel: 'f11', category: 'View',
      run: cmdToggleFullscreen });
    C.register({ id: 'view.alwaysOnTop', label: 'Always on Top', accel: 'ctrl+`', category: 'View',
      checked: () => Boolean(Store.get('alwaysOnTop')), run: cmdAlwaysOnTop });
    C.register({ id: 'view.togglePreview', label: 'Markdown Preview: Side by Side',
      accel: 'ctrl+shift+m', category: 'View',
      enabled: () => Docs.count() > 0,
      checked: () => Boolean(Docs.active() && Docs.active().view === 'split'),
      run: cmdTogglePreview });
    C.register({ id: 'view.previewOnly', label: 'Markdown Preview: Full Pane',
      accel: 'ctrl+shift+e', category: 'View',
      enabled: () => Docs.count() > 0,
      checked: () => Boolean(Docs.active() && Docs.active().view === 'preview'),
      run: cmdPreviewOnly });

    /* -- Tabs ------------------------------------------------------- */
    C.register({ id: 'tabs.next', label: 'Next Tab', accel: 'ctrl+tab', category: 'Tabs',
      enabled: () => Docs.count() > 1, run: () => { stashActive(); Docs.cycle(1); presentDoc(Docs.active()); } });
    C.register({ id: 'tabs.prev', label: 'Previous Tab', accel: 'ctrl+shift+tab', category: 'Tabs',
      enabled: () => Docs.count() > 1, run: () => { stashActive(); Docs.cycle(-1); presentDoc(Docs.active()); } });
    C.register({ id: 'tabs.closeAllTabs', label: 'Close All Tabs', category: 'Tabs',
      enabled: () => Docs.count() > 1,
      run: async () => {
        const snapshot = Docs.all().slice();
        for (const doc of snapshot) {
          if (Docs.count() <= 1) break;
          const still = Docs.get(doc.id);
          if (still) await closeTab(doc.id);
        }
      } });

    /* -- Tools / system -------------------------------------------- */
    C.register({ id: 'app.palette', label: 'Command Palette', accel: 'ctrl+space', category: 'App',
      run: () => Palette.open('') });
    C.register({ id: 'app.settings', label: 'Settings…', accel: 'ctrl+,', category: 'App', run: cmdSettings });
    C.register({ id: 'app.shortcuts', label: 'Keyboard Shortcuts', accel: 'f1', category: 'App', run: cmdShortcuts });
    C.register({ id: 'app.about', label: 'About SaraText', category: 'App', run: cmdAbout });
    C.register({ id: 'app.newWindow', label: 'New Document', hidden: true, run: cmdNewWindow });

    /* -- Menu bar layout ------------------------------------------- */
    C.menu('File', [
      'file.new', 'file.open', 'file.recent', '-',
      'file.save', 'file.saveAs', '-',
      'file.close', 'file.closeOthers', 'file.reopenClosed', '-',
      'file.encoding', 'file.reveal', 'file.copyPath', '-',
      'file.quit',
    ]);
    C.menu('Edit', [
      'edit.undo', 'edit.redo', '-',
      ...ContextMenu.EDIT_ITEMS, '-',
      'edit.duplicateLine', 'edit.deleteLine', 'edit.moveUp', 'edit.moveDown', '-',
      'edit.comment', '-',
      ...ContextMenu.TRANSFORM_ITEMS,
    ]);
    C.menu('Search', [
      'search.find', 'search.replace', '-',
      'search.next', 'search.prev', '-',
      'search.goToLine',
    ]);
    C.menu('View', [
      'view.font', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', '-',
      'view.toggleWrap', 'view.toggleTheme', '-',
      'view.togglePreview', 'view.previewOnly', '-',
      'view.sizeSmall', 'view.sizeMedium', 'view.sizeLarge', '-',
      'view.fullscreen', 'view.alwaysOnTop',
    ]);
    C.menu('Tools', [
      'tabs.next', 'tabs.prev', '-',
      'file.close', 'file.closeOthers', 'tabs.closeAllTabs', '-',
      'file.reopenClosed', '-',
      'app.palette', 'app.settings', '-',
      'app.shortcuts', 'app.about',
    ]);

    // Ctrl+Enter and Escape are context-sensitive, so they are not plain
    // accelerators - they are resolved by the keydown layer instead.
  }

  function transformSelection(fn) {
    const { start, end, text } = Editor.getSelection();
    if (!text) { toast('Select some text first', 'warn', 1600); return; }
    const next = fn(text);
    if (next === text) return;
    Editor.replaceRange(start, end, next, true);
    syncActiveText();
  }

  /**
   * Title-case that leaves existing capitals alone: an acronym like
   * "HTTP" or "SaraText" should survive, and only a lowercase letter at
   * a word boundary is promoted.
   */
  function toTitleCase(text) {
    return text.replace(/(^|[\s\-_/.([])([a-z])/g, (_m, lead, ch) => lead + ch.toUpperCase());
  }

  /** Copy the selection through `fn` without touching the document. */
  async function copyTransformed(fn) {
    const { text } = Editor.getSelection();
    if (!text) { toast('Select some text first', 'warn', 1600); return; }
    const out = fn(text);
    try {
      if (window.sara && window.sara.clipboard) window.sara.clipboard.writeText(out);
      else await navigator.clipboard.writeText(out);
      toast('Copied', 'ok', 1200);
    } catch {
      toast('Could not reach the clipboard', 'warn', 2200);
    }
  }

  /* ================================================================== *
   * Keyboard layer
   * ================================================================== */

  function bindKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (!booted) return;

      // While the palette, a modal or the font dialog owns focus, let it
      // handle its own keys.
      if (Palette.isOpen()) return;
      if (FontDialog.isOpen()) return;
      if (!els.modalOverlay.hidden) return;

      // The context menu is a real focusable menu: it consumes its own
      // navigation, activation and Escape.
      if (ContextMenu.isOpen()) {
        if (['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(e.key)) return;
      }

      // ---- context-sensitive keys, handled before the registry ------
      if (e.key === 'Escape') {
        if (Search.isOpen()) { e.preventDefault(); Search.close(); return; }
        // An open menu owns Escape itself (it needs to close and restore
        // focus), so it is deliberately not closed again here.
        return;
      }

      // Search-bar option toggles.
      if (Search.isOpen() && e.altKey) {
        const map = { c: 'case', w: 'word', r: 'regex' };
        const which = map[e.key.toLowerCase()];
        if (which) { e.preventDefault(); Search.toggleOption(which); return; }
      }

      // The find bar swallows F3 / Enter itself, but F3 from the editor
      // should still work, so no special case is needed there.

      // ---- registry-driven shortcuts --------------------------------
      const id = Commands.resolveAccel(e);

      if (id) {
        // Let the OS handle plain system clipboard combos natively *while
        // the textarea has focus* - that is native cut/copy/paste with all
        // its IME and rich-text behaviour. Everywhere else the registry
        // path runs instead, which is why those commands exist in two
        // forms: a native shortcut and an explicit menu item.
        const NATIVE = ['edit.cut', 'edit.copy', 'edit.paste', 'edit.undo', 'edit.redo'];
        if (NATIVE.includes(id) && document.activeElement === Editor.element) return;
        e.preventDefault();
        Commands.run(id);
        return;
      }

      // Ctrl+Tab is not delivered as a normal key on all platforms; catch it.
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        Commands.run(e.shiftKey ? 'tabs.prev' : 'tabs.next');
      }
    }, true);
  }

  /* ================================================================== *
   * Context menu
   * ================================================================== */

  function bindPaneContext() {
    // Q: right-clicking a tab in Explorer selects it before showing the
    // menu. Do the same, so the tab commands act on the tab that was
    // clicked rather than on whatever happened to be active.
    els.tabs.addEventListener('mousedown', (e) => {
      if (e.button !== 2) return;
      const tab = e.target.closest('.tab');
      if (!tab) return;
      const id = Number(tab.dataset.id);
      if (!id || id === Docs.activeId) return;
      stashActive();
      Docs.setActive(id);
      presentDoc(Docs.active());
    }, true);

    // The gutter sits outside the textarea, so a press there would leave
    // the caret (and therefore every line command in the resulting menu)
    // pointing at whatever line was last touched. Aim it at the clicked
    // line instead. The pane and the textarea share a top edge, so the
    // line follows from the editor's own line metrics.
    els.gutter.addEventListener('mousedown', (e) => {
      const line = lineFromPoint(e.clientY);
      const offset = Editor.lineStart(line);
      Editor.setSelection(offset, offset);
    });

    // Right-clicking a tab must not also close it (middle-click does).
    els.tabs.addEventListener('auxclick', (e) => { if (e.button === 2) e.preventDefault(); });
  }

  /** Map a viewport y onto a 1-based line number, using the editor metrics. */
  function lineFromPoint(clientY) {
    const paneRect = els.editorPane.getBoundingClientRect();
    const { lineHeight, paddingTop } = Editor.metrics;
    const y = clientY - paneRect.top + els.editor.scrollTop - paddingTop;
    const line = Math.floor(y / lineHeight) + 1;
    return Math.max(1, Math.min(Editor.lineCount(), line));
  }

  /* ================================================================== *
   * Drag & drop
   * ================================================================== */

  function bindDragDrop() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };

    window.addEventListener('dragover', (e) => {
      stop(e);
      e.dataTransfer.dropEffect = 'copy';
      document.body.classList.add('is-dropping');
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) document.body.classList.remove('is-dropping');
    });
    window.addEventListener('drop', async (e) => {
      stop(e);
      document.body.classList.remove('is-dropping');

      const files = [...(e.dataTransfer?.files || [])];
      const paths = [];
      for (const f of files) {
        const p = window.sara.pathForFile ? window.sara.pathForFile(f) : f.path;
        if (p) paths.push(p);
      }
      if (paths.length) await openPaths(paths);
      else if (e.dataTransfer.getData('text')) {
        Editor.insertAtCaret(e.dataTransfer.getData('text'));
        syncActiveText();
      }
    });
  }

  /* ================================================================== *
   * Window chrome
   * ================================================================== */

  function bindWindowChrome() {
    for (const btn of document.querySelectorAll('[data-win]')) {
      btn.addEventListener('click', () => window.sara.windowAction(btn.dataset.win));
    }

    // Double-clicking the draggable area toggles maximize, like a native bar.
    els.titlebar.addEventListener('dblclick', (e) => {
      if (e.target.closest('button') || e.target.closest('.menubar')) return;
      window.sara.windowAction('maximize');
    });

    // The OS asks the renderer whether it may close.
    window.sara.onBeforeClose(async () => {
      syncActiveText();
      const dirty = Docs.dirtyDocs();
      if (dirty.length) {
        const preview = dirty.slice(0, 6).map((d) => `  • ${d.name}`).join('\n');
        const more = dirty.length > 6 ? `\n  …and ${dirty.length - 6} more` : '';
        const res = await window.sara.confirm({
          type: 'warning',
          message: `${dirty.length} document${dirty.length > 1 ? 's have' : ' has'} unsaved changes`,
          detail: `${preview}${more}\n\nSave before closing?`,
          buttons: ['Save All', 'Discard All', 'Cancel'],
          defaultId: 0,
          cancelId: 2,
        });

        if (res.response === 2) { window.sara.closeConfirmed(false); return; }
        if (res.response === 0) {
          for (const doc of dirty) {
            Docs.setActive(doc.id);
            stashActive();
            const outcome = await saveActive({});
            if (outcome !== 'saved') { window.sara.closeConfirmed(false); return; }
          }
        }
      }
      await saveSession();
      window.sara.closeConfirmed(true);
    });

    window.sara.onFocusEditor(() => {
      window.focus();
      Editor.element.focus();
    });

    // Files handed to us by the shell ("Open with > SaraText", drop on the
    // exe, or a second launch while we are already running).
    window.sara.onOpenPaths((paths) => {
      openPaths(paths);
    });
  }

  /* ================================================================== *
   * Boot
   * ================================================================== */

  function bindUIEvents() {
    els.newTabBtn.addEventListener('click', () => Commands.run('file.new'));
    els.emptyOpen.addEventListener('click', () => Commands.run('file.open'));

    // Live sync of the active doc as the user types, debounced lightly so
    // the tab dot and title stay honest without thrashing the DOM.
    let syncTimer = null;
    const scheduleSync = () => {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        syncActiveText();
        updateTitle();
        renderTabs();
        if (Search.isOpen()) Search.refresh();
        // The preview rides the same debounce: one re-render per quiet
        // moment rather than one per keystroke.
        Preview.schedule();
      }, 120);
    };

    Editor.init(editorRefs, {
      onChange: () => { scheduleSync(); updateStatus(); },
      onCaret: () => updateStatus(),
    });
  }

  /**
   * Plain Ctrl+wheel zoom, matching every other text editor.
   */
  function bindWheelZoom() {
    els.editor.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      applyZoom(zoom + (e.deltaY < 0 ? 10 : -10));
    }, { passive: false });
  }

  async function boot() {
    Store.load();

    // Theme + view preferences first so the first paint is already correct.
    document.documentElement.dataset.theme = Store.get('theme') || 'dark';
    zoom = Store.get('zoom') || 100;

    registerCommands();
    MenuBar.init(els.menubar);
    StatusBar.init({
      lnCol: els.statLnCol,
      sel: els.statSel,
      selDiv: els.statSelDiv,
      count: els.statCount,
      wrap: els.statWrap,
      encoding: els.statEncoding,
      eol: els.statEol,
      path: els.statPath,
      zoom: els.statZoom,
    });
    Search.init({
      root: els.findbar,
      findInput: els.findInput,
      count: els.findCount,
      replaceGroup: els.replaceGroup,
      replaceInput: els.replaceInput,
      optCase: els.optCase,
      optWord: els.optWord,
      optRegex: els.optRegex,
      next: els.findNext,
      prev: els.findPrev,
      replaceOne: els.replaceOne,
      replaceAll: els.replaceAll,
      close: els.findClose,
    }, {
      onStatus: ({ replaced }) => {
        if (replaced !== undefined) toast(`Replaced ${replaced} occurrence(s)`, 'ok', 1800);
      },
    });
    Palette.init({ overlay: els.paletteOverlay, input: els.paletteInput, list: els.paletteList }, {
      onPickRecent: (path) => openPaths([path]),
    });
    FontDialog.init({
      overlay: els.fontOverlay,
      familyInput: els.fontFamilyInput,
      list: els.fontList,
      size: els.fontSize,
      sizeUp: els.fontSizeUp,
      sizeDown: els.fontSizeDown,
      sizeLabel: els.fontSizeLabel,
      sample: els.fontSample,
      note: els.fontNote,
      ligatures: els.fontLigatures,
      apply: els.fontApply,
      cancel: els.fontCancel,
      reset: els.fontReset,
    }, { onCommit: commitFont });
    ContextMenu.init();
    Preview.init({
      wrap: els.editorWrap,
      pane: els.previewPane,
      body: els.previewBody,
      title: els.previewTitle,
    }, {
      onAction: (action) => { if (action === 'edit') applyView('edit'); },
      onLink: (href, doc) => openPreviewLink(href, doc),
      onToast: (message, kind) => toast(message, kind),
    });

    bindUIEvents();
    bindKeyboard();
    bindDragDrop();
    bindWindowChrome();
    bindWheelZoom();
    bindPaneContext();

    // Apply stored view state.
    Editor.setWrap(Boolean(Store.get('wordWrap')));
    applyFont();

    Docs.on('active', () => { updateTitle(); renderTabs(); });
    Docs.on('change', () => { renderTabs(); updateTitle(); });
    document.addEventListener('saratext:status-refresh', () => updateStatus());

    booted = true;

    // Restore or start fresh.
    const restored = await restoreSession();
    await applyGlobalHotkey();
    startAutoSave();

    // Release anything the shell handed us at launch. Done after the session
    // restore so these files land on top of the restored tabs, not under them.
    window.sara.notifyReady();

    // Periodically checkpoint the session so a hard kill is still recoverable.
    setInterval(saveSession, 15000);

    if (!restored) Editor.element.focus();
    updateStatus();
    updateTitle();
    renderTabs();
  }

  window.addEventListener('DOMContentLoaded', () => {
    boot().catch((err) => {
      console.error('[saratext] boot failed', err);
      toast(`Startup error: ${err.message}`, 'error', 8000);
    });
  });

  // Flush state when the renderer is torn down.
  window.addEventListener('beforeunload', () => { syncActiveText(); });
})();
