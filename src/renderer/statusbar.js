'use strict';

/**
 * SaraText - status bar
 *
 * Pure renderer of state it is handed. It never reads the document
 * directly, which keeps the update path explicit and easy to reason about.
 */

const StatusBar = (() => {
  let els = null;
  let hintTimer = null;
  let resting = true;

  function init(refs) {
    els = refs;

    els.wrap.addEventListener('click', () => Commands.run('view.toggleWrap'));
    els.encoding.addEventListener('click', () => Commands.run('file.encoding'));
    els.zoom.addEventListener('click', () => Commands.run('view.zoomReset'));
  }

  function update({ caret, doc, zoom, wrap, encoding }) {
    if (resting) {
      els.lnCol.textContent = `Ln ${caret.line}, Col ${caret.col}`;

      if (caret.selected > 0) {
        els.sel.hidden = false;
        els.selDiv.hidden = false;
        const selLines = caret.selected && Editor.getSelection().text.split('\n').length;
        els.sel.textContent = `Sel ${caret.selected} ch${selLines > 1 ? ` / ${selLines} ln` : ''}`;
      } else {
        els.sel.hidden = true;
        els.selDiv.hidden = true;
      }

      els.count.textContent = `${caret.chars.toLocaleString()} chars · ${caret.lines.toLocaleString()} lines`;
    }

    els.wrap.textContent = `Wrap: ${wrap ? 'on' : 'off'}`;
    els.wrap.dataset.on = String(Boolean(wrap));
    els.encoding.textContent = (encoding || 'utf8').toUpperCase().replace('UTF8', 'UTF-8');
    els.zoom.textContent = `${zoom}%`;

    if (doc) {
      els.path.textContent = doc.path || 'Unsaved';
      els.path.title = doc.path || 'This document has no path yet';
      els.eol.textContent = doc.eol || 'LF';
    }
  }

  /** Temporarily replace the left-hand stats with a message. */
  function flash(message, ms = 2200) {
    resting = false;
    els.lnCol.textContent = message;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      resting = true;
      document.dispatchEvent(new CustomEvent('saratext:status-refresh'));
    }, ms);
  }

  function setIndent(size) {
    // Reflected by the editor, surfaced here only for discoverability.
    els.encoding.title = `Encoding (indent: ${size} spaces)`;
  }

  return { init, update, flash, setIndent };
})();
