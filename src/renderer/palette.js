'use strict';

/**
 * SaraText - command palette
 *
 * A fuzzy-searchable list over every non-hidden command in the registry.
 * Also doubles as a quick-open: typing a path-ish query surfaces recent
 * files above the commands.
 */

const Palette = (() => {
  let els = null;
  let items = [];
  let selected = 0;
  let visible = false;
  let onPickRecent = () => {};

  function init(refs, options = {}) {
    els = refs;
    onPickRecent = options.onPickRecent || (() => {});

    els.input.addEventListener('input', () => build(els.input.value));
    els.input.addEventListener('keydown', onKeydown);
    els.overlay.addEventListener('mousedown', (e) => {
      if (e.target === els.overlay) close();
    });
  }

  /* ---------------------------------------------------------------- *
   * Fuzzy scoring
   * ---------------------------------------------------------------- */

  /**
   * Subsequence match with a bonus for consecutive runs and word starts.
   * Returns null when the query doesn't match at all.
   */
  function score(query, target) {
    if (!query) return 0;
    const q = query.toLowerCase();
    const t = target.toLowerCase();

    // Exact substring is always strongest.
    const direct = t.indexOf(q);
    if (direct !== -1) {
      return 1000 - direct * 2 + (direct === 0 ? 300 : 0);
    }

    let ti = 0;
    let total = 0;
    let run = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      let found = -1;
      while (ti < t.length) {
        if (t[ti] === ch) { found = ti; break; }
        ti++;
      }
      if (found === -1) return null;
      run = found > 0 && t[found - 1] === q[qi - 1] && qi > 0 ? run + 1 : 1;
      total += 10 + run * 4;
      if (found === 0 || /[\s\-_/.]/.test(t[found - 1])) total += 12;
      ti = found + 1;
    }
    return total - t.length * 0.15;
  }

  /* ---------------------------------------------------------------- *
   * Building the list
   * ---------------------------------------------------------------- */

  function build(query) {
    const q = (query || '').trim();

    const commands = Commands.all()
      .filter((cmd) => !cmd.hidden)
      .filter((cmd) => cmd.enabled())
      .map((cmd) => {
        const haystack = `${cmd.label} ${cmd.category}`;
        const s = q ? score(q, haystack) : 1;
        return s === null ? null : { type: 'command', cmd, score: s };
      })
      .filter(Boolean);

    // Recent files behave like a quick-open when the query looks like a path.
    const recents = Store.get('recentFiles') || [];
    const fileItems = q
      ? recents.map((p) => {
          const s = score(q, p);
          return s === null ? null : { type: 'file', path: p, score: s + 40 };
        }).filter(Boolean)
      : [];

    items = [...fileItems, ...commands]
      .sort((a, b) => b.score - a.score)
      .slice(0, 60);

    selected = 0;
    render();
  }

  function render() {
    if (!items.length) {
      els.list.innerHTML = '<div class="palette__empty">No matching commands</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'palette__item' + (i === selected ? ' palette__item--sel' : '');
      row.setAttribute('role', 'option');

      const label = document.createElement('span');
      label.className = 'palette__label';

      if (item.type === 'file') {
        label.textContent = Docs.basename(item.path);
        const cat = document.createElement('span');
        cat.className = 'palette__cat';
        cat.textContent = 'Recent';
        const accel = document.createElement('span');
        accel.className = 'palette__accel';
        accel.textContent = item.path;
        accel.style.maxWidth = '190px';
        accel.style.overflow = 'hidden';
        accel.style.textOverflow = 'ellipsis';
        accel.style.whiteSpace = 'nowrap';
        row.append(label, accel, cat);
      } else {
        label.textContent = item.cmd.label;
        const cat = document.createElement('span');
        cat.className = 'palette__cat';
        cat.textContent = item.cmd.category;
        row.append(label, cat);
        if (item.cmd.accel) {
          const accel = document.createElement('span');
          accel.className = 'palette__accel';
          accel.textContent = Commands.displayAccel(item.cmd.accel);
          row.append(accel);
        }
      }

      row.addEventListener('mouseenter', () => {
        selected = i;
        highlight();
      });
      row.addEventListener('click', () => pick(i));
      frag.appendChild(row);
    });

    els.list.replaceChildren(frag);
  }

  function highlight() {
    const rows = els.list.children;
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('palette__item--sel', i === selected);
    }
    const row = rows[selected];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
  }

  /* ---------------------------------------------------------------- *
   * Interaction
   * ---------------------------------------------------------------- */

  function onKeydown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selected = Math.min(items.length - 1, selected + 1);
        highlight();
        break;
      case 'ArrowUp':
        e.preventDefault();
        selected = Math.max(0, selected - 1);
        highlight();
        break;
      case 'Home':
        if (!els.input.value) { e.preventDefault(); selected = 0; highlight(); }
        break;
      case 'End':
        if (!els.input.value) { e.preventDefault(); selected = items.length - 1; highlight(); }
        break;
      case 'Enter':
        e.preventDefault();
        pick(selected);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      default:
        break;
    }
  }

  function pick(i) {
    const item = items[i];
    if (!item) return;
    close();
    if (item.type === 'file') onPickRecent(item.path);
    else Commands.run(item.cmd.id);
  }

  function open(seed = '') {
    visible = true;
    els.overlay.hidden = false;
    els.input.value = seed;
    build(seed);
    els.input.focus();
    els.input.select();
  }

  function close() {
    if (!visible) return;
    visible = false;
    els.overlay.hidden = true;
    items = [];
    Editor.element.focus();
  }

  const isOpen = () => visible;

  return { init, open, close, isOpen, build };
})();
