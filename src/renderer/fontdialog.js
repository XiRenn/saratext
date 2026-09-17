'use strict';

/**
 * SaraText - font selection dialog
 *
 * Family + size for the editor, with a live sample rendered in the
 * candidate font so the choice is made by looking rather than guessing.
 *
 * Two deliberate decisions:
 *
 *  - **The list is curated, not enumerated.** There is no reliable,
 *    dependency-free way to read the installed-font list from a
 *    sandboxed renderer: `queryLocalFonts()` needs a permission prompt
 *    and enumerates *families* only (no styles, no proper display names),
 *    and the bridge exposes no font API on purpose. So the list is a
 *    fixed set of families that ship with Windows or are common
 *    developer installs, each marked present or absent by probing metrics
 *    after a `document.fonts.load()`. Anything missing can still be typed
 *    into the family box by hand.
 *
 *  - **Nothing commits until Apply.** Moving through the list repaints the
 *    sample only, so browsing does not disturb the document.
 *
 * Size here is *font size*, independent of zoom. The two multiply: the
 * editor renders at `fontSize * zoom / 100`.
 */

const FontDialog = (() => {
  /**
   * Candidate families, grouped. `mono: true` marks the ones that are
   * actually monospaced - the editor works without one, but the gutter
   * alignment and the retro look both depend on it.
   */
  const CANDIDATES = [
    { group: 'Bundled / will be installed by you', fonts: [
      { name: 'JetBrains Mono', mono: true },
      { name: 'Cascadia Code', mono: true },
      { name: 'Cascadia Mono', mono: true },
      { name: 'Fira Code', mono: true },
      { name: '0xProto Nerd Font Mono', mono: true },
      { name: 'Ubuntu Mono', mono: true },
    ] },

    { group: 'Ships with Windows', fonts: [
      { name: 'Consolas', mono: true },
      { name: 'Cascadia Mono', mono: true },
      { name: 'Courier New', mono: true },
      { name: 'Lucida Console', mono: true },
      { name: 'Segoe UI', mono: false },
      { name: 'Calibri', mono: false },
      { name: 'Cambria', mono: false },
      { name: 'Georgia', mono: false },
      { name: 'Tahoma', mono: false },
      { name: 'Verdana', mono: false },
      { name: 'Trebuchet MS', mono: false },
    ] },

    { group: 'Stacks', fonts: [
      { name: 'monospace', mono: true, generic: true },
      { name: 'serif', mono: false, generic: true },
      { name: 'sans-serif', mono: false, generic: true },
    ] },
  ];

  const SIZES = [9, 10, 11, 12, 12.5, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32];

  const SAMPLE = 'SaraText 0123 Oo Il1 {} () => // TODO';

  /** Present/absent verdict per family name, filled in by `probe()`. */
  const available = new Map();
  let probed = false;

  let els = null;
  let open = false;
  let onCommit = () => {};

  /** Staged state - what the dialog would apply, not what is applied. */
  let draft = { family: null, size: 12.5, ligatures: null };

  /* ---------------------------------------------------------------- *
   * Setup
   * ---------------------------------------------------------------- */

  function init(refs, options = {}) {
    els = refs;
    onCommit = options.onCommit || (() => {});

    els.familyInput.addEventListener('input', () => {
      draft.family = els.familyInput.value.trim() || null;
      markSelection();
      renderSample();
    });

    els.list.addEventListener('click', (e) => {
      const row = e.target.closest('.fontList__row');
      if (!row || row.dataset.missing === 'true') return;
      draft.family = row.dataset.family === '(default)' ? null : row.dataset.family;
      els.familyInput.value = draft.family || '';
      markSelection();
      renderSample();
    });

    els.sizeDown.addEventListener('click', () => stepSize(-1));
    els.sizeUp.addEventListener('click', () => stepSize(1));
    els.size.addEventListener('change', () => {
      const v = parseFloat(els.size.value);
      if (Number.isFinite(v)) { draft.size = clampSize(v); els.size.value = draft.size; }
      else els.size.value = draft.size;
      renderSample();
    });

    els.ligatures.addEventListener('change', () => {
      draft.ligatures = els.ligatures.checked;
      renderSample();
    });

    els.apply.addEventListener('click', () => {
      onCommit({ ...draft });
      close();
    });
    els.cancel.addEventListener('click', close);
    els.reset.addEventListener('click', () => {
      draft = { family: null, size: 12.5, ligatures: null };
      syncControls();
      renderSample();
    });

    // Clicking the scrim (not the dialog) dismisses.
    els.overlay.addEventListener('mousedown', (e) => {
      if (e.target === els.overlay) close();
    });

    document.addEventListener('keydown', (e) => {
      if (!open) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'Enter' && !e.target.closest('button')) {
        e.preventDefault();
        e.stopPropagation();
        els.apply.click();
      }
    }, true);
  }

  const clampSize = (v) => Math.round(Math.max(6, Math.min(72, v)) * 10) / 10;

  function stepSize(delta) {
    const px = Math.max(0.5, draft.size * 0.05);
    const idx = SIZES.findIndex((s) => s >= draft.size);
    let next;
    if (delta > 0) next = idx === -1 ? draft.size + px : SIZES[Math.min(SIZES.length - 1, idx + (SIZES[idx] > draft.size ? 0 : 1))];
    else next = idx <= 0 ? draft.size - px : SIZES[idx - 1];
    draft.size = clampSize(next);
    els.size.value = draft.size;
    renderSample();
  }

  /* ---------------------------------------------------------------- *
   * Availability probing
   * ---------------------------------------------------------------- */

  /**
   * A family that is not installed falls back to the next entry in the
   * stack. Measure a probe string in the candidate stack against the same
   * probe in a known-missing family: equal widths mean the candidate was
   * not used. This is the standard trick and is reliable for families
   * whose metrics differ at all from the fallback.
   */
  function probe() {
    if (probed) return;
    probed = true;
    const probeEl = document.createElement('span');
    probeEl.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font-size:72px;';
    probeEl.textContent = 'mmmmmmmmmmlliWWWW';
    document.body.appendChild(probeEl);

    const widthOf = (family) => {
      probeEl.style.fontFamily = family;
      return probeEl.getBoundingClientRect().width;
    };

    // Baselines: three families almost guaranteed to be absent.
    const bases = ['__no_such_font_a__', '__no_such_font_b__', '__no_such_font_c__']
      .map(widthOf);

    for (const group of CANDIDATES) {
      for (const font of group.fonts) {
        if (font.generic) { available.set(font.name, true); continue; }
        const w = widthOf(`"${font.name}"`);
        available.set(font.name, !bases.some((b) => Math.abs(b - w) < 0.01));
      }
    }

    probeEl.remove();
  }

  /* ---------------------------------------------------------------- *
   * Rendering
   * ---------------------------------------------------------------- */

  function buildList() {
    probe();
    const frag = document.createDocumentFragment();

    // Adaptive candidate list: keep every family that named itself as
    // present, plus the four bundled dev fonts that will appear the moment
    // someone installs them - but drop the Windows standard set (Consolas,
    // Courier New, Segoe UI…) on a machine that has none of them, because
    // then they are noise from some other platform's font pack.
    const STANDARD = new Set(['Consolas', 'Courier New', 'Lucida Console', 'Segoe UI',
      'Calibri', 'Cambria', 'Georgia', 'Tahoma', 'Verdana', 'Trebuchet MS']);
    const anyStandardPresent = [...STANDARD].some((n) => available.get(n));
    const PINNED = new Set(['JetBrains Mono', 'Cascadia Code', 'Cascadia Mono', 'Fira Code']);

    for (const group of CANDIDATES) {
      const rows = group.fonts.filter((f) => {
        if (f.generic) return true;
        if (available.get(f.name)) return true;
        return PINNED.has(f.name);
      }).filter((f) => {
        if (!anyStandardPresent && STANDARD.has(f.name)) return false;
        return true;
      });

      if (!rows.length) continue;

      const title = document.createElement('div');
      title.className = 'fontList__group';
      title.textContent = group.group;
      frag.appendChild(title);

      for (const font of rows) {
        const present = available.get(font.name);

        const row = document.createElement('button');
        row.className = 'fontList__row';
        row.type = 'button';
        row.dataset.family = font.name;
        row.dataset.missing = String(!present);
        row.setAttribute('role', 'option');

        const sample = document.createElement('span');
        sample.className = 'fontList__sample';
        sample.textContent = font.name;
        sample.style.fontFamily = font.generic ? font.name : `"${font.name}"`;

        const tag = document.createElement('span');
        tag.className = 'fontList__tag';
        if (!present) tag.textContent = 'not installed';
        else if (!font.mono) tag.textContent = 'proportional';
        row.append(sample, tag);
        frag.appendChild(row);
      }
    }

    // The default stack is not a family, so it gets its own pinned row.
    const defRow = document.createElement('button');
    defRow.className = 'fontList__row';
    defRow.type = 'button';
    defRow.dataset.family = '(default)';
    defRow.setAttribute('role', 'option');
    const defSample = document.createElement('span');
    defSample.className = 'fontList__sample';
    defSample.textContent = 'SaraText default';
    const defTag = document.createElement('span');
    defTag.className = 'fontList__tag';
    defTag.textContent = 'recommended';
    defRow.append(defSample, defTag);

    const defTitle = document.createElement('div');
    defTitle.className = 'fontList__group';
    defTitle.textContent = 'Default';

    els.list.replaceChildren(defTitle, defRow, frag);
  }

  function markSelection() {
    const current = draft.family || '(default)';
    for (const row of els.list.querySelectorAll('.fontList__row')) {
      const on = row.dataset.family === current;
      row.classList.toggle('fontList__row--sel', on);
      if (on && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
    }
  }

  function renderSample() {
    const stack = draft.family ? `"${draft.family}", var(--font-mono)` : 'var(--font-mono)';
    els.sample.style.fontFamily = stack;
    els.sample.style.fontSize = `${draft.size}px`;
    els.sample.textContent = SAMPLE;

    const missing = draft.family && available.get(draft.family) === false;
    els.note.textContent = missing
      ? `"${draft.family}" is not installed — it will fall back to the default.`
      : '';
    els.note.hidden = !missing;

    els.sizeLabel.textContent = `${draft.size} px`;
  }

  function syncControls() {
    els.familyInput.value = draft.family || '';
    els.size.value = draft.size;
    els.ligatures.checked = Boolean(draft.ligatures);
    markSelection();
    renderSample();
  }

  /* ---------------------------------------------------------------- *
   * Open / close
   * ---------------------------------------------------------------- */

  function openWith({ family = null, size = 12.5, ligatures = null } = {}) {
    if (open) return;
    open = true;
    draft = { family, size, ligatures };

    buildList();
    syncControls();

    els.overlay.hidden = false;
    els.familyInput.focus();
    els.familyInput.select();
  }

  function close() {
    if (!open) return;
    open = false;
    els.overlay.hidden = true;
    Editor.element.focus();
  }

  const isOpen = () => open;

  return {
    init, open: openWith, close, isOpen,
    get draft() { return { ...draft }; },
    get available() { return Object.fromEntries(available); },
  };
})();
