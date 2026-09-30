'use strict';

/**
 * SaraText - markdown preview pane
 *
 * A read-only sibling of the editor, not a replacement for it. It owns no
 * text: it renders `Editor.getText()` and re-renders on the same debounced
 * change path the tab title already uses. Nothing here writes to the
 * document.
 *
 * The view mode lives on `#editorWrap` as `data-mode` ("edit" | "split" |
 * "preview") and is stored per document, so a tab comes back to the view it
 * was left in. `editor.js` already treats that element as the carrier for
 * view state (`data-wrap`, `data-font`), so this adds a third axis rather
 * than a second source of truth.
 *
 * Interaction is delegated: markdown.js emits plain elements and never
 * attaches handlers, so every click in the pane funnels through `onClick`.
 */

const Preview = (() => {
  const MODES = ['edit', 'split', 'preview'];
  const DEFAULT_MODE = 'edit';
  const REFRESH_MS = 140;

  let wrap = null;      // #editorWrap, the data-mode carrier
  let pane = null;      // #previewPane, hidden in "edit"
  let body = null;      // #previewBody, the scroll container
  let title = null;     // #previewTitle
  let doc = null;       // the document currently rendered
  let timer = null;

  let onAction = () => {};   // (action) => void, for bar buttons
  let onLink = () => {};     // (href, doc) => void, for link routing
  let onToast = () => {};    // (message, kind) => void

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  function init(refs, handlers = {}) {
    wrap = refs.wrap;
    pane = refs.pane;
    body = refs.body;
    title = refs.title;

    onAction = handlers.onAction || (() => {});
    onLink = handlers.onLink || (() => {});
    onToast = handlers.onToast || (() => {});

    if (!pane || !body) return;

    pane.addEventListener('click', onClick);
    // Middle-click on a link would otherwise try to open a new tab.
    pane.addEventListener('auxclick', (e) => e.preventDefault());
    // No mousedown handler here on purpose: the pane is its own scroll
    // container, so a press in it cannot move the editor's caret, and
    // intercepting the press would break double-click-to-select-a-word.
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  /** The text to render: the live buffer for the active doc, else its stash. */
  function textFor(target) {
    if (!target) return '';
    if (typeof Docs !== 'undefined' && target.id === Docs.activeId) return Editor.getText();
    return target.text || '';
  }

  /**
   * Paint `target` into the pane.
   *
   * The scroll offset is carried across, because a re-render fires on every
   * keystroke and throwing the reader back to the top each time would make
   * the pane unusable. Clamping keeps the offset valid when the document
   * has just become shorter.
   */
  function render(target = doc) {
    if (!pane || !body) return;
    doc = target || null;

    if (title) title.textContent = doc ? doc.name : 'Preview';

    if (!doc) {
      body.replaceChildren();
      return;
    }

    const previous = body.scrollTop;
    body.replaceChildren(Markdown.render(textFor(doc)));
    const maxScroll = Math.max(0, body.scrollHeight - body.clientHeight);
    body.scrollTop = Math.min(previous, maxScroll);
  }

  /** Re-render on the next quiet moment, if the pane is on screen at all. */
  function schedule(delay = REFRESH_MS) {
    if (!isVisible()) return;
    clearTimeout(timer);
    timer = setTimeout(() => render(doc || (typeof Docs !== 'undefined' ? Docs.active() : null)), delay);
  }

  /* ---------------------------------------------------------------- *
   * Mode
   * ---------------------------------------------------------------- */

  const normalise = (mode) => (MODES.includes(mode) ? mode : DEFAULT_MODE);
  const isVisible = () => Boolean(pane) && !pane.hidden;

  /**
   * Switch the editor pane between editing, side-by-side and preview-only.
   *
   * Only paints when the mode actually changes: a tab switch calls this
   * with the incoming document's mode and then renders explicitly, so
   * re-rendering here would duplicate the work on every tab change.
   *
   * @returns {string} the mode actually applied
   */
  function setMode(mode) {
    const next = normalise(mode);
    clearTimeout(timer);

    const changed = currentMode() !== next;
    if (wrap) wrap.dataset.mode = next;
    if (pane) pane.hidden = next === 'edit';

    if (next !== 'edit' && changed) render(doc || (typeof Docs !== 'undefined' ? Docs.active() : null));
    return next;
  }

  /** The mode currently stamped on the wrap element. */
  const currentMode = () => (wrap && wrap.dataset.mode ? normalise(wrap.dataset.mode) : DEFAULT_MODE);

  /* ---------------------------------------------------------------- *
   * Interaction
   * ---------------------------------------------------------------- */

  async function copyCode(button) {
    const block = button.closest('.md-pre');
    const code = block && block.querySelector('code');
    if (!code) return;
    const text = code.textContent;
    try {
      if (window.sara && window.sara.clipboard) window.sara.clipboard.writeText(text);
      else await navigator.clipboard.writeText(text);
      onToast('Code copied', 'ok');
    } catch {
      onToast('Could not reach the clipboard', 'warn');
    }
  }

  /**
   * Jump to a heading by its `#fragment`. Heading ids are namespaced
   * (`md-…`) so they cannot collide with app markup, so both the bare
   * fragment and the prefixed form are tried.
   */
  function scrollToAnchor(href) {
    const raw = href.slice(1);
    if (!raw) return;
    let target = null;
    try {
      target = body.querySelector(`#${CSS.escape(raw)}`)
        || body.querySelector(`#${CSS.escape(`md-${raw}`)}`);
    } catch {
      return;   // a fragment the selector engine will not accept
    }
    if (target) target.scrollIntoView({ block: 'start' });
  }

  function onClick(e) {
    const action = e.target.closest('[data-preview-action]');
    if (action) {
      e.preventDefault();
      onAction(action.dataset.previewAction);
      return;
    }

    const copy = e.target.closest('[data-copy]');
    if (copy) {
      e.preventDefault();
      copyCode(copy);
      return;
    }

    const link = e.target.closest('a[data-href]');
    if (!link) return;
    e.preventDefault();

    const href = link.dataset.href || '';
    if (href.startsWith('#')) { scrollToAnchor(href); return; }
    onLink(href, doc);
  }

  return {
    init, render, schedule, setMode, isVisible,
    get MODES() { return MODES.slice(); },
  };
})();
