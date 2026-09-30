'use strict';

/**
 * SaraText - markdown renderer
 *
 * Turns markdown source into DOM nodes. It never builds an HTML string and
 * never touches `innerHTML`. That is not stylistic: the source is whatever
 * file the user opened, and this code runs in a page that carries
 * `window.sara` (readFile / saveFile / clipboard). A string-building
 * renderer turns any markdown file into a same-origin script host, which
 * the page's `script-src 'self'` CSP cannot stop. Every character of the
 * document therefore reaches the DOM through `createTextNode` or
 * `textContent`, and only the tags this parser chooses are ever created.
 *
 * Supported: ATX + setext headings, fenced code, blockquotes, ordered /
 * unordered / nested / task lists, GFM pipe tables, horizontal rules and
 * paragraphs, with inline emphasis, code spans, links, autolinks and
 * strikethrough.
 *
 * Deliberately unsupported: raw HTML passthrough (tags render as literal
 * text), indented code blocks, reference links, footnotes and images. An
 * image becomes a labelled placeholder because `<img src>` cannot resolve
 * a document-relative path - the page is loaded from `src/index.html`, not
 * from the open file - and the CSP only permits `img-src 'self' data:`.
 *
 * Public API: `Markdown.render(source)` -> DocumentFragment.
 */

const Markdown = (() => {
  /** Beyond this the preview gives up rather than freezing the window. */
  const MAX_PREVIEW_CHARS = 400000;

  /* Block-level recognisers. */
  const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)\s*$/;
  const RE_ATX = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const RE_QUOTE = /^\s{0,3}>\s?(.*)$/;
  const RE_MARKER = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const RE_SETEXT = /^\s{0,3}(=+|-+)\s*$/;
  const RE_TABLE_DELIM = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

  /* Inline recognisers, all anchored at the current scan position. */
  const RE_ESCAPE = /^\\([\\`*_{}\[\]()#+\-.!>~|])/;
  const RE_BREAK = /^(?: {2,}|\\)\n/;
  const RE_CODE_SPAN = /^(`+)([\s\S]*?[^`])\1(?!`)/;
  const RE_IMAGE = /^!\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"([^"]*)")?\s*\)/;
  const RE_LINK = /^\[([^\]]*)\]\(\s*([^)\s]*)(?:\s+"([^"]*)")?\s*\)/;
  const RE_AUTOLINK = /^<((?:https?|mailto):[^>\s]+)>/;
  const RE_STRONG = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
  const RE_STRIKE = /^~~(?=\S)([\s\S]*?\S)~~/;
  const RE_EM = /^(\*|_)(?=\S)([\s\S]*?\S)\1/;

  /** Schemes that must never reach an href, even though clicks are routed. */
  const RE_UNSAFE_SCHEME = /^(?:javascript|data|vbscript|blob):/i;

  /** Heading ids are namespaced so they cannot collide with app markup. */
  const ID_PREFIX = 'md-';
  const RE_WORD = /[\w$]/;

  /** Cleared per render; heading ids have to be unique within a document. */
  let usedIds = new Set();

  /* ---------------------------------------------------------------- *
   * Small DOM helpers
   * ---------------------------------------------------------------- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function slugify(text) {
    const base = String(text)
      .toLowerCase()
      .replace(/[^\w\s-]+/g, '')
      .trim()
      .replace(/\s+/g, '-');
    return base || 'section';
  }

  function uniqueId(text) {
    const base = slugify(text);
    let id = base;
    let n = 2;
    while (usedIds.has(id)) { id = `${base}-${n}`; n++; }
    usedIds.add(id);
    return ID_PREFIX + id;
  }

  /* ---------------------------------------------------------------- *
   * Inline
   * ---------------------------------------------------------------- */

  /**
   * Allow a link through only if it cannot execute anything. The click
   * handler in preview.js is what actually routes navigation, but the href
   * itself is also kept clean so the attribute is never a loaded gun.
   */
  function sanitizeHref(raw) {
    const href = String(raw == null ? '' : raw).trim();
    if (!href) return null;
    if (RE_UNSAFE_SCHEME.test(href)) return null;
    return href;
  }

  function linkNode(label, href, title) {
    const safe = sanitizeHref(href);
    if (!safe) {
      // Render the label as plain text rather than dropping the link, so the
      // reader still sees what was written.
      const span = el('span', 'md-link md-link--blocked');
      parseInline(label, span);
      return span;
    }
    const a = el('a', 'md-link');
    a.href = safe;
    // The raw target is what the click handler routes on; `href` may have
    // been resolved against the page URL by the DOM.
    a.dataset.href = safe;
    if (title) a.title = title;
    parseInline(label, a);
    return a;
  }

  function imageNode(alt, src) {
    const span = el('span', 'md-img');
    span.title = 'Images are not resolved in the preview';
    span.appendChild(el('span', 'md-img__alt', alt || 'image'));
    if (src) span.appendChild(el('span', 'md-img__src', src));
    return span;
  }

  /** Emphasis delimiters made of `_` must not fire inside a word. */
  function underscoreAllowed(src, i, length) {
    const before = i > 0 ? src[i - 1] : '';
    const after = src[i + length] || '';
    return !RE_WORD.test(before) && !RE_WORD.test(after);
  }

  /**
   * Scan `src` for inline constructs, appending nodes to `out`.
   * Unrecognised characters accumulate into a text node, so nothing is ever
   * interpreted as markup by the browser.
   */
  function parseInline(src, out) {
    let i = 0;
    let buf = '';
    const flush = () => { if (buf) { out.appendChild(document.createTextNode(buf)); buf = ''; } };

    while (i < src.length) {
      const rest = src.slice(i);
      let m;

      if ((m = RE_ESCAPE.exec(rest))) {
        buf += m[1];
        i += m[0].length;
        continue;
      }

      if ((m = RE_BREAK.exec(rest))) {
        flush();
        out.appendChild(el('br'));
        i += m[0].length;
        continue;
      }

      if ((m = RE_CODE_SPAN.exec(rest))) {
        let code = m[2];
        // A single leading and trailing space is padding, not content.
        if (/^ .* $/.test(code) && code.trim()) code = code.slice(1, -1);
        flush();
        out.appendChild(el('code', 'md-code-inline', code));
        i += m[0].length;
        continue;
      }

      if ((m = RE_IMAGE.exec(rest))) {
        flush();
        out.appendChild(imageNode(m[1], m[2]));
        i += m[0].length;
        continue;
      }

      if ((m = RE_LINK.exec(rest))) {
        flush();
        out.appendChild(linkNode(m[1], m[2], m[3]));
        i += m[0].length;
        continue;
      }

      if ((m = RE_AUTOLINK.exec(rest))) {
        flush();
        out.appendChild(linkNode(m[1], m[1], null));
        i += m[0].length;
        continue;
      }

      if ((m = RE_STRONG.exec(rest)) && (m[1] === '**' || underscoreAllowed(src, i, m[0].length))) {
        flush();
        const strong = el('strong');
        parseInline(m[2], strong);
        out.appendChild(strong);
        i += m[0].length;
        continue;
      }

      if ((m = RE_STRIKE.exec(rest))) {
        flush();
        const strike = el('del');
        parseInline(m[1], strike);
        out.appendChild(strike);
        i += m[0].length;
        continue;
      }

      if ((m = RE_EM.exec(rest)) && (m[1] === '*' || underscoreAllowed(src, i, m[0].length))) {
        flush();
        const em = el('em');
        parseInline(m[2], em);
        out.appendChild(em);
        i += m[0].length;
        continue;
      }

      buf += src[i];
      i++;
    }

    flush();
  }

  /* ---------------------------------------------------------------- *
   * Blocks
   * ---------------------------------------------------------------- */

  function heading(level, text) {
    const tag = `h${Math.max(1, Math.min(6, level))}`;
    const node = el(tag, 'md-h');
    node.id = uniqueId(text);
    parseInline(text, node);
    return node;
  }

  function paragraph(lines) {
    const p = el('p', 'md-p');
    // Only the left edge is trimmed: two trailing spaces are a hard break.
    parseInline(lines.map((l) => l.replace(/^[ \t]+/, '')).join('\n'), p);
    return p;
  }

  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    if (!lines[i].includes('|')) return false;
    const delim = lines[i + 1];
    return delim.includes('-') && RE_TABLE_DELIM.test(delim);
  }

  /** Does `lines[i]` open a new block, i.e. end a running paragraph? */
  function startsBlock(lines, i) {
    const line = lines[i];
    if (!line.trim()) return true;
    if (RE_FENCE.test(line)) return true;
    if (RE_ATX.test(line)) return true;
    if (RE_HR.test(line)) return true;
    if (RE_QUOTE.test(line)) return true;
    if (RE_MARKER.test(line)) return true;
    return isTableStart(lines, i);
  }

  /** Read a fenced code block starting at `start`. Returns [node, nextIndex]. */
  function readFence(lines, start, open) {
    const marker = open[1][0];
    const minLen = open[1].length;
    const lang = (open[2] || '').trim();
    const closeRe = new RegExp(`^\\s{0,3}${marker === '`' ? '`' : '~'}{${minLen},}\\s*$`);

    const body = [];
    let i = start + 1;
    while (i < lines.length) {
      if (closeRe.test(lines[i])) { i++; break; }
      body.push(lines[i]);
      i++;
    }

    const pre = el('pre', 'md-pre');
    const bar = el('div', 'md-pre__bar');
    bar.appendChild(el('span', 'md-pre__lang', lang || 'text'));
    const copy = el('button', 'md-pre__copy', 'Copy');
    copy.type = 'button';
    copy.dataset.copy = 'code';
    bar.appendChild(copy);
    pre.appendChild(bar);

    const code = el('code', lang ? `md-code lang-${lang.replace(/[^\w-]/g, '')}` : 'md-code', body.join('\n'));
    pre.appendChild(code);
    return [pre, i];
  }

  function splitRow(row) {
    let s = row.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((cell) => cell.trim());
  }

  /** Read a GFM pipe table starting at `start`. Returns [node, nextIndex]. */
  function readTable(lines, start) {
    const head = splitRow(lines[start]);
    const aligns = splitRow(lines[start + 1]).map((cell) => {
      const left = cell.startsWith(':');
      const right = cell.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return null;
    });

    let i = start + 2;
    const rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
      rows.push(splitRow(lines[i]));
      i++;
    }

    const table = el('table', 'md-table');
    const thead = el('thead');
    const headRow = el('tr');
    head.forEach((cell, idx) => {
      const th = el('th');
      if (aligns[idx]) th.style.textAlign = aligns[idx];
      parseInline(cell, th);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    for (const row of rows) {
      const tr = el('tr');
      // Ragged rows are padded and over-long ones truncated, so the grid
      // stays rectangular however sloppy the source is.
      for (let c = 0; c < head.length; c++) {
        const td = el('td');
        if (aligns[c]) td.style.textAlign = aligns[c];
        parseInline(row[c] || '', td);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    return [table, i];
  }

  /** Read a list starting at `start`. Returns [node, nextIndex]. */
  function readList(lines, start) {
    const first = RE_MARKER.exec(lines[start]);
    const baseIndent = first[1].length;
    const ordered = /^\d/.test(first[2]);
    const startAt = ordered ? parseInt(first[2], 10) : 1;

    /** @type {Array<{lines:string[]}>} */
    const items = [];
    let current = null;
    let i = start;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) {
        // A blank line ends the list unless the next meaningful line still
        // belongs to it - a sibling item, or something indented under one.
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j >= lines.length) break;
        const next = RE_MARKER.exec(lines[j]);
        let continues;
        if (next) {
          const sameKind = /^\d/.test(next[2]) === ordered;
          // A sibling of the same kind continues this list; a different
          // marker kind at the same indent opens a new one instead.
          continues = sameKind ? next[1].length >= baseIndent : next[1].length > baseIndent;
        } else {
          continues = /^\s+/.test(lines[j]);
        }
        if (!continues) break;
        if (current) current.lines.push('');
        i++;
        continue;
      }

      const m = RE_MARKER.exec(line);
      if (m && m[1].length <= baseIndent) {
        // `- a` followed by `1. b` is two lists, not one.
        if (/^\d/.test(m[2]) !== ordered) break;
        current = { lines: [m[3]] };
        items.push(current);
        i++;
        continue;
      }

      if (!current) break;
      // Anything deeper - a nested list, or wrapped text - stays with the
      // item it belongs to.
      current.lines.push(line);
      i++;
    }

    const list = el(ordered ? 'ol' : 'ul', 'md-list');
    if (ordered && startAt !== 1) list.setAttribute('start', String(startAt));

    for (const item of items) {
      const li = el('li', 'md-li');
      const content = item.lines.slice();

      const task = /^\s*\[([ xX])\]\s+/.exec(content[0] || '');
      if (task) {
        li.classList.add('md-li--task');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.className = 'md-task';
        box.disabled = true;
        box.checked = task[1].toLowerCase() === 'x';
        li.appendChild(box);
        content[0] = content[0].replace(/^\s*\[([ xX])\]\s+/, '');
      }

      const inner = document.createDocumentFragment();
      renderBlocks(content, inner);

      // A tight list item is one paragraph with the wrapper stripped.
      const kids = [...inner.childNodes];
      if (kids.length === 1 && kids[0].tagName === 'P') {
        const only = kids[0];
        for (const node of [...only.childNodes]) inner.insertBefore(node, only);
        inner.removeChild(only);
      }

      li.appendChild(inner);
      list.appendChild(li);
    }

    return [list, i];
  }

  /**
   * Render a run of lines into `out`.
   *
   * Known simplification: a setext heading is only recognised when the
   * underline directly follows a single line of text. `line one` / `line
   * two` / `---` therefore renders as a paragraph plus a rule instead of a
   * two-line heading.
   */
  function renderBlocks(lines, out) {
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      let m;

      if ((m = RE_FENCE.exec(line))) {
        const [node, next] = readFence(lines, i, m);
        out.appendChild(node);
        i = next;
        continue;
      }

      if ((m = RE_ATX.exec(line))) {
        out.appendChild(heading(m[1].length, m[2]));
        i++;
        continue;
      }

      if (i + 1 < lines.length
          && RE_SETEXT.test(lines[i + 1])
          && !RE_MARKER.test(line)
          && !RE_QUOTE.test(line)) {
        const level = lines[i + 1].trim()[0] === '=' ? 1 : 2;
        out.appendChild(heading(level, line.trim()));
        i += 2;
        continue;
      }

      if (RE_HR.test(line)) {
        out.appendChild(el('hr', 'md-hr'));
        i++;
        continue;
      }

      if (RE_QUOTE.test(line)) {
        const inner = [];
        while (i < lines.length) {
          const q = RE_QUOTE.exec(lines[i]);
          if (q) { inner.push(q[1]); i++; continue; }
          // A blank line only ends the quote when nothing quoted follows.
          if (!lines[i].trim() && i + 1 < lines.length && RE_QUOTE.test(lines[i + 1])) {
            inner.push('');
            i++;
            continue;
          }
          break;
        }
        const quote = el('blockquote', 'md-quote');
        renderBlocks(inner, quote);
        out.appendChild(quote);
        continue;
      }

      if (isTableStart(lines, i)) {
        const [node, next] = readTable(lines, i);
        out.appendChild(node);
        i = next;
        continue;
      }

      if (RE_MARKER.test(line)) {
        const [node, next] = readList(lines, i);
        out.appendChild(node);
        i = next;
        continue;
      }

      const para = [];
      while (i < lines.length && lines[i].trim()) {
        if (para.length && startsBlock(lines, i)) break;
        para.push(lines[i]);
        i++;
      }
      out.appendChild(paragraph(para));
    }
  }

  /* ---------------------------------------------------------------- *
   * Entry point
   * ---------------------------------------------------------------- */

  /**
   * Render markdown source into a detached fragment.
   * @param {string} source
   * @returns {DocumentFragment}
   */  function render(source) {
    const text = String(source == null ? '' : source).replace(/\r\n?/g, '\n');
    const frag = document.createDocumentFragment();
    usedIds = new Set();

    if (text.length > MAX_PREVIEW_CHARS) {
      const notice = el('p', 'md-notice');
      notice.textContent = `Preview disabled: ${Math.round(text.length / 1024)} KB of text `
        + `is past the ${Math.round(MAX_PREVIEW_CHARS / 1024)} KB preview limit.`;
      frag.appendChild(notice);
      return frag;
    }

    renderBlocks(text.split('\n'), frag);
    return frag;
  }

  return { render, MAX_PREVIEW_CHARS };
})();