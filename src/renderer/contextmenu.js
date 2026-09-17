'use strict';

/**
 * SaraText - contextual (right-click) menu
 *
 * A second, independent dropdown renderer over the same command registry
 * the menu bar uses. It shares `.menu*` styling and the body-appended
 * `fixed` panel technique from `menubar.js`, but the two never collide:
 * this module fires only for right-clicks, and every open/close path here
 * closes any open menu-bar dropdown first.
 *
 * Registers three named contexts:
 *
 *   editor  the textarea, the gutter and the current-line band
 *   tabs    a tab in the tab strip (tab-aware items are prepended)
 *   app     the tab strip background, the status bar, the empty state
 *
 * Because items are plain `data-cmd` buttons dispatched through
 * `Commands.run`, a feature added to the registry automatically becomes
 * available here - and anything that also belongs in the Edit menu can be
 * declared once in `EDIT_ITEMS` and shared.
 */

const ContextMenu = (() => {
  /** Context definitions in registration order. */
  const contexts = new Map();

  let panel = null;         // open panel (a `.menu` element), else null
  let currentContext = null;

  /* ---------------------------------------------------------------- *
   * Shared item sets
   *
   * The Edit menu layout in app.js references these, so cut/copy/paste
   * and the text transforms exist in exactly one place.
   * ---------------------------------------------------------------- */

  /** Items every editor-like context menu shares. */
  const EDIT_ITEMS = ['edit.undo', 'edit.redo', '-',
    'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll'];

  /** Case transforms, grouped for reuse after the clipboard block. */
  const TRANSFORM_ITEMS = ['edit.toUpperCase', 'edit.toLowerCase', 'edit.toTitleCase',
    'edit.trimTrailing', 'edit.truncateSelection'];

  /* ---------------------------------------------------------------- *
   * Registration
   * ---------------------------------------------------------------- */

  /**
   * @param {string}   name      context identifier
   * @param {string[]} items     command ids, '-' for a separator, '…' for a
   *                             labelled section heading
   * @param {object}   [options]
   * @param {string}   [options.test]  CSS selector; the context applies when
   *                                   the right-click target matches it
   * @param {Function} [options.build] (target) => string[]; used instead of
   *                                   a static list when items depend on the
   *                                   element that was right-clicked
   */
  function register(name, items, options = {}) {
    contexts.set(name, { name, items, ...options });
    return name;
  }

  /**
   * Resolve the context for a right-click target, first match wins, so
   * more specific contexts must be registered first.
   */
  function contextFor(target) {
    for (const ctx of contexts.values()) {
      if (ctx.test && target.closest && target.closest(ctx.test)) return ctx;
    }
    return contexts.get('app') || null;
  }

  /* ---------------------------------------------------------------- *
   * Opening
   * ---------------------------------------------------------------- */

  /**
   * @param {number}             x       viewport x
   * @param {number}             y       viewport y
   * @param {MouseEvent|Element} source  the event or element that triggered it
   */
  function openAt(x, y, source) {
    const target = source && source.target ? source.target : source;
    const ctx = contextFor(target);
    if (!ctx) return false;

    // The menu bar owns its own dropdown and would otherwise stay open
    // behind this one.
    if (typeof MenuBar !== 'undefined' && MenuBar.isOpen()) MenuBar.close();

    close();
    currentContext = ctx;

    const items = typeof ctx.build === 'function' ? ctx.build(target) : ctx.items;
    panel = build(ctx, items);
    if (!panel) { currentContext = null; return false; }

    // Attach to <body> and place it with fixed coordinates, exactly as the
    // menu bar does: nesting it inside the editor would put it in a
    // stacking context that the tab strip and title bar can out-paint.
    document.body.appendChild(panel);
    place(x, y);
    return true;
  }

  /** Build the panel: items, separators and section headings. */
  function build(ctx, items) {
    const el = document.createElement('div');
    el.className = 'menu contextMenu';
    el.setAttribute('role', 'menu');
    el.dataset.group = `menu.${ctx.name}`;

    let added = 0;
    for (const flag of items || []) {
      const id = typeof flag === 'string' && flag.startsWith('#') ? flag.slice(1) : null;

      // `#`-prefixed entries and bare id lookups both resolve against the
      // registry; a literal id wins so a command whose *name* starts with
      // "#" is never mistaken for a heading.
      if (!id && flag === '-') {
        if (added) el.appendChild(separator());
        continue;
      }

      const key = id || flag;
      const command = Commands.get(key);
      if (command) {
        // `hidden` means "keep out of the command palette", not "never
        // offer this anywhere" - these are clipboard-adjacent helpers that
        // belong in a context menu but would be noise in the palette.
        el.appendChild(item(command));
        added++;
        continue;
      }

      // `#`-prefixed entries are explicitly section labels. A bare string
      // that is not a registered command is a typo, and rendering it as a
      // label would hide the mistake behind something that looks
      // deliberate - so it is reported and dropped instead.
      if (id) { el.appendChild(heading(id)); continue; }
      console.warn(`[saratext] context menu "${ctx.name}": no such command "${flag}"`);
    }

    // A menu with nothing clickable in it (an empty document, a document
    // with no path) should not appear at all.
    return el.querySelector('.menu__item') ? el : null;
  }

  function separator() {
    const sep = document.createElement('div');
    sep.className = 'menu__sep';
    return sep;
  }

  function heading(text = '') {
    const el = document.createElement('div');
    el.className = 'menu__heading';
    el.textContent = text;
    return el;
  }

  function item(cmd) {
    const el = document.createElement('button');
    el.className = 'menu__item menu__item--ctx';
    el.type = 'button';
    el.dataset.cmd = cmd.id;
    el.setAttribute('role', 'menuitem');
    el.disabled = !cmd.enabled();

    const check = document.createElement('span');
    check.className = 'menu__check';
    if (cmd.checked && cmd.checked()) check.textContent = '✓';

    const label = document.createElement('span');
    label.className = 'menu__label';
    label.textContent = cmd.label;

    el.append(check, label);

    if (cmd.accel) {
      const accel = document.createElement('span');
      accel.className = 'menu__accel';
      accel.textContent = Commands.displayAccel(cmd.accel);
      el.appendChild(accel);
    }

    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (el.disabled) return;
      close();
      Commands.run(cmd.id);
    });

    return el;
  }

  /* ---------------------------------------------------------------- *
   * Placement
   * ---------------------------------------------------------------- */

  /**
   * Put the panel at (x, y), flipping whichever edge would overflow the
   * window. Runs twice: once to learn the panel's size, then again to
   * place it, so an over-large menu cannot hang off a small window.
   */
  function place(x, y) {
    const rect = panel.getBoundingClientRect();
    const pad = 6;

    let left = x;
    let top = y;

    if (left + rect.width + pad > window.innerWidth) {
      left = Math.max(pad, x - rect.width);
    }
    if (top + rect.height + pad > window.innerHeight) {
      top = Math.max(pad, y - rect.height);
    }

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  /* ---------------------------------------------------------------- *
   * Dismissal
   * ---------------------------------------------------------------- */

  function close() {
    if (panel && panel.parentElement) panel.parentElement.removeChild(panel);
    panel = null;
    currentContext = null;
  }

  /* ---------------------------------------------------------------- *
   * Enable / check state
   * ---------------------------------------------------------------- */

  /**
   * Recompute disabled/checked state in place. Called when the selection
   * changes while the menu is open, so "Copy" cannot stay enabled after
   * the selection is dropped.
   */
  function refresh() {
    if (!panel) return;
    for (const el of panel.querySelectorAll('.menu__item')) {
      const cmd = Commands.get(el.dataset.cmd);
      if (!cmd) continue;
      el.disabled = !cmd.enabled();
      const check = el.querySelector('.menu__check');
      if (check) check.textContent = cmd.checked && cmd.checked() ? '✓' : '';
    }
  }

  const isOpen = () => Boolean(panel);
  const context = () => (currentContext ? currentContext.name : null);

  /* ---------------------------------------------------------------- *
   * Wiring
   * ---------------------------------------------------------------- */

  function init() {
    // Capture phase: the app's other handlers must not see a right-click
    // they would act on. Chromium's own context menu is suppressed in the
    // main process, so this is the only menu that appears.
    window.addEventListener('contextmenu', (e) => {
      e.preventDefault();

      // Let text inputs keep the native menu for editing their own value.
      // Only the editor itself is intercepted - and the find bar's fields,
      // the modal's field and the palette input all fall through.
      const el = e.target;
      if (el && el.tagName === 'INPUT' && el.type !== 'checkbox') return;
      if (el && el.tagName === 'TEXTAREA' && !el.classList.contains('editor')) return;

      // An open modal, the font dialog or the palette owns the screen.
      const modal = document.getElementById('modalOverlay');
      if (modal && !modal.hidden) return;
      const font = document.getElementById('fontOverlay');
      if (font && !font.hidden) return;
      if (typeof Palette !== 'undefined' && Palette.isOpen()) return;

      openAt(e.clientX, e.clientY, e);
    }, true);

    // Any press outside dismisses. `mousedown` rather than `click` so the
    // menu is gone before the press reaches the editor and moves the caret.
    // A press on the menu itself is left alone - the item's own click
    // handler does the closing.
    document.addEventListener('mousedown', (e) => {
      if (!panel) return;
      if (panel.contains(e.target)) return;
      close();
    });

    // A second right-click elsewhere re-opens in place rather than
    // dismissing and leaving nothing.
    document.addEventListener('mousedown', (e) => {
      if (!panel || e.button !== 2) return;
      if (panel.contains(e.target)) return;
      close();
    });

    // The safety net the menu bar also relies on.
    window.addEventListener('blur', () => close());
    window.addEventListener('resize', () => { if (panel) close(); });
    window.addEventListener('wheel', () => { if (panel) close(); }, { passive: true, capture: true });

    // Keyboard: the panel is a normal focusable menu.
    document.addEventListener('keydown', (e) => {
      if (!panel) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        Editor.element.focus();
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const items = focusable();
        if (items.length) items[e.key === 'Home' ? 0 : items.length - 1].focus();
      } else if (e.key === 'Enter' || e.key === ' ') {
        const active = document.activeElement;
        if (active && active.classList.contains('menu__item') && !active.disabled && panel.contains(active)) {
          e.preventDefault();
          e.stopPropagation();
          const id = active.dataset.cmd;
          close();
          Commands.run(id);
        }
      }
    }, true);

    // Keep enabled/checked honest while the menu is on screen.
    if (typeof Docs !== 'undefined') {
      Docs.on('change', () => { if (panel) refresh(); });
      Docs.on('active', () => { if (panel) refresh(); });
    }
    document.addEventListener('selectionchange', () => { if (panel) refresh(); });
  }

  const focusable = () => (panel ? [...panel.querySelectorAll('.menu__item')].filter((i) => !i.disabled) : []);

  function moveFocus(delta) {
    const items = focusable();
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const next = at === -1
      ? (delta > 0 ? 0 : items.length - 1)
      : (at + delta + items.length) % items.length;
    items[next].focus();
  }

  /* ---------------------------------------------------------------- *
   * Context definitions
   *
   * Order matters: `contextFor` takes the first selector that matches.
   * A bare string that is neither a command id nor '-' renders as a
   * section heading, which is how the long editor menu is grouped.
   * ---------------------------------------------------------------- */

  register('gutter', [
    '#Line', '-',
    'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll', '-',
    'search.goToLine', 'edit.deleteLine', 'edit.duplicateLine', 'edit.moveUp', 'edit.moveDown', '-',
    'edit.comment', 'edit.trimTrailing', '-',
    'search.find', 'view.toggleWrap', 'view.font',
  ], { test: '#gutter' });

  register('editor', [
    'edit.undo', 'edit.redo', '-',
    'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll', '-',
    '#Text', '-',
    'edit.duplicateLine', 'edit.deleteLine', 'edit.moveUp', 'edit.moveDown', '-',
    'edit.comment', '-',
    'edit.toUpperCase', 'edit.toLowerCase', 'edit.toTitleCase', '-',
    'edit.trimTrailing', 'edit.truncateSelection', '-',
    '#Clipboard', '-',
    'edit.copyUpper', 'edit.copyLower', '-',
    'search.find', 'search.replace', 'search.goToLine', '-',
    'view.toggleWrap', 'view.font', 'view.resetFont',
  ], { test: '#editorPane, #editor' });

  register('tabs', [
    '#Tab', '-',
    'file.close', 'file.closeOthers', 'tabs.closeAllTabs', '-',
    'file.reopenClosed', '-',
    'file.save', 'file.saveAs', '-',
    'file.copyPath', 'file.reveal', '-',
    'edit.duplicateLine', 'edit.deleteLine', '-',
    'edit.toUpperCase', 'edit.toLowerCase', '-',
    'search.find', '-',
    'view.toggleWrap', 'view.font',
  ], { test: '.tab' });

  register('app', [
    'file.new', 'file.open', '-',
    'file.save', 'file.saveAs', '-',
    'file.close', 'file.reopenClosed', '-',
    'search.find', 'search.goToLine', '-',
    'view.zoomIn', 'view.zoomOut', 'view.zoomReset', '-',
    'view.toggleWrap', 'view.toggleTheme', '-',
    'view.font', '-',
    'app.palette', 'app.settings',
  ], { test: '.tabstrip, .statusbar, .editorWrap, .emptyState' });

  return {
    init, register, openAt, close, refresh, isOpen, context,
    /** The declared item list for a context, for wiring checks. */
    layout: (name) => {
      const ctx = contexts.get(name);
      if (!ctx) return [];
      return typeof ctx.build === 'function' ? ctx.build(null) : ctx.items;
    },
    get contexts() { return [...contexts.keys()]; },
    EDIT_ITEMS, TRANSFORM_ITEMS,
  };
})();
