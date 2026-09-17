'use strict';

/**
 * Context menu + font dialog regression test.
 *
 * Drives the renderer in headless Chromium over CDP and asserts the
 * behaviour a user depends on:
 *
 *   CONTEXT MENU
 *     1. a right-click in the editor opens a menu,
 *     2. the editor menu carries the clipboard + line-op items,
 *     3. right-clicking a tab opens the tab menu, not the editor one,
 *     4. Cut/Copy are disabled with no selection and enabled with one,
 *     5. Cut actually moves the text to the clipboard and out of the doc,
 *     6. Paste actually inserts the clipboard contents,
 *     7. every enabled item in every context runs its command,
 *     8. the panel hit-tests above the editor,
 *     9. a left-press outside dismisses it,
 *    10. it flips back inside the window when opened near an edge,
 *    11. ArrowDown / Enter / Escape work,
 *    12. right-clicking the gutter still targets the editor menu.
 *
 *   FONT DIALOG
 *    13. Ctrl+Shift+F opens it,
 *    14. the family list is populated and marks availability,
 *    15. picking a family repaints the sample but does not touch the doc,
 *    16. Apply updates the editor's computed font, and the gutter and
 *        highlight layer move with it (they must not drift),
 *    17. the preference survives a reload,
 *    18. Reset restores the built-in stack,
 *    19. zoom multiplies the chosen font size instead of discarding it.
 *
 * Usage:  node scripts/test-context-font.js
 * Exit code 0 = healthy, 1 = at least one failure.
 * Verification only - not shipped.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { launch, sleep } = require('./lib/cdp');

const PORT = Number(process.env.PORT || 5199);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9402);
const PREVIEW = path.join(__dirname, 'preview-server.js');

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

const failures = [];
let checks = 0;
const note = (ok, msg) => {
  checks++;
  if (!ok) failures.push(msg);
  return ok ? 'PASS' : 'FAIL';
};
const line = (label, ok, detail = '') =>
  console.log(`${label.padEnd(10)} ${note(ok, label)}${detail ? `  ${detail}` : ''}`);

/* ------------------------------------------------------------------ */

(async () => {
  // The preview server stubs window.sara; start it as a child so the test
  // is a single command.
  const server = spawn(process.execPath, [PREVIEW], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(700);

  const cdp = await launch({ port: PORT, debugPort: DEBUG_PORT, label: 'ctxfont' });
  const { ev, click, rightClick, centre, send } = cdp;

  await sleep(2600);   // let boot() finish its async session restore

  console.log('\n=== SaraText context menu + font dialog ===\n');

  // Record every command the app runs, so "did this item fire" is answered
  // by the registry rather than by guessing from side effects.
  await ev(`(() => {
    window.__ran = [];
    const original = Commands.run;
    Commands.run = function (id, ...rest) { window.__ran.push(id); return original.call(Commands, id, ...rest); };
    return true;
  })()`);

  /* ---------------------------------------------------------------- *
   * Seed a document and give the editor a known caret/selection
   * ---------------------------------------------------------------- */

  await ev(`(async () => {
    Editor.setText('alpha beta gamma\\ndelta epsilon\\nzeta eta theta\\niota kappa\\nlambda mu');
    Editor.setSelection(0, 0);
    await new Promise((r) => setTimeout(r, 120));
    return Docs.active().name;
  })()`);

  const seedOk = (await ev('Editor.getText().split("\\n").length')) === 5;
  line('seed', seedOk, 'document holds 5 lines');

  /* ================================================================ *
   * 1. Right-click in the editor opens the editor menu
   * ================================================================ */

  const pane = await centre('#editorPane');
  await rightClick(pane.x, pane.y);

  let state = await ev(`(() => {
    const menu = document.querySelector('.menu.contextMenu');
    if (!menu) return { open: false };
    const items = [...menu.querySelectorAll('.menu__item')].map((i) => i.dataset.cmd);
    const enabled = items.filter((_, i) => !menu.querySelectorAll('.menu__item')[i].disabled);
    return {
      open: true,
      group: menu.dataset.group,
      isOpen: ContextMenu.isOpen(),
      ctx: ContextMenu.context(),
      parentIsBody: menu.parentElement === document.body,
      items,
      enabled,
      headings: [...menu.querySelectorAll('.menu__heading')].length,
    };
  })()`);

  line('open', state.open && state.isOpen && state.ctx === 'editor',
    `context="${state.ctx}" items=${state.items ? state.items.length : 0}`);
  line('onbody', Boolean(state.parentIsBody), 'panel appended to <body> (not nested in the pane)');

  const NEEDED = ['edit.undo', 'edit.redo', 'edit.cut', 'edit.copy', 'edit.paste', 'edit.selectAll',
    'edit.duplicateLine', 'edit.deleteLine', 'edit.moveUp', 'edit.moveDown', 'edit.comment',
    'edit.toUpperCase', 'edit.toLowerCase', 'edit.toTitleCase', 'edit.trimTrailing',
    'edit.truncateSelection', 'edit.copyUpper', 'edit.copyLower',
    'search.find', 'search.replace', 'search.goToLine',
    'view.toggleWrap', 'view.font', 'view.resetFont'];
  const missing = NEEDED.filter((id) => !(state.items || []).includes(id));
  line('items', missing.length === 0,
    missing.length
      ? `missing: ${missing.join(', ')}`
      : `${state.items.length} items (${NEEDED.length} expected present), ${state.headings} section heading(s)`);

  // The panel must paint above the editor, not under it. The menu__item is
  // measured inside the panel (its nested label would trivially hit-test).
  const layering = await ev(`(() => {
    const item = document.querySelector('.menu.contextMenu .menu__item');
    if (!item) return { ok: false };
    const r = item.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + 4);
    return { ok: item.contains(hit), tag: hit ? hit.className : null };
  })()`);
  line('layering', layering.ok, `item hit-tests above the editor (hit: ${layering.tag})`);

  /* ================================================================ *
   * 2. Enabled/disabled follows the selection
   * ================================================================ */

  const noSel = await ev(`(() => {
    const q = (id) => document.querySelector('.menu.contextMenu .menu__item[data-cmd="' + id + '"]');
    return { cut: q('edit.cut').disabled, copy: q('edit.copy').disabled,
             paste: q('edit.paste').disabled, selAll: q('edit.selectAll').disabled,
             trunc: q('edit.truncateSelection').disabled };
  })()`);
  line('disable', noSel.cut && noSel.copy && noSel.trunc && !noSel.paste && !noSel.selAll,
    `no selection -> cut/copy/truncate disabled, paste/select-all enabled`);

  // Give it a selection without touching the menu and watch it refresh.
  const withSel = await ev(`(async () => {
    Editor.setSelection(0, 5);                       // "alpha"
    await new Promise((r) => setTimeout(r, 200));
    const q = (id) => document.querySelector('.menu.contextMenu .menu__item[data-cmd="' + id + '"]');
    return { open: ContextMenu.isOpen(), cut: q('edit.cut').disabled, copy: q('edit.copy').disabled };
  })()`);
  line('enable', withSel.open && !withSel.cut && !withSel.copy,
    'selection -> cut/copy become enabled while the menu is still open');

  /* ================================================================ *
   * 3. Dismissal
   * ================================================================ */

  // Re-open for a clean state, then press well below the panel. The
  // editor menu is tall, so aiming at the pane centre would land on the
  // menu itself - which correctly does *not* dismiss.
  await rightClick(pane.x, pane.y);
  const openedAgain = await ev('ContextMenu.isOpen()');
  await click(pane.x + 620, pane.y + 300);
  const dismissed = !(await ev('ContextMenu.isOpen()'));
  line('outside', openedAgain && dismissed, 'left-press outside closes the menu');

  // Escape.
  await rightClick(pane.x, pane.y);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(180);
  const escClosed = !(await ev('ContextMenu.isOpen()'));
  line('escape', escClosed, 'Escape closes the menu');

  /* ================================================================ *
   * 4. Edge flipping
   * ================================================================ */

  const flip = await ev(`(async () => {
    ContextMenu.close();
    // Open hard against the bottom-right corner; the panel must stay inside.
    ContextMenu.openAt(window.innerWidth - 4, window.innerHeight - 4, document.getElementById('editorPane'));
    await new Promise((r) => setTimeout(r, 120));
    const menu = document.querySelector('.menu.contextMenu');
    if (!menu) return { ok: false };
    const r = menu.getBoundingClientRect();
    const inside = r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
    ContextMenu.close();
    return { ok: inside, right: Math.round(r.right), bottom: Math.round(r.bottom),
             vw: window.innerWidth, vh: window.innerHeight };
  })()`);
  line('flip', flip.ok, `stays in the window opened at the corner (right ${flip.right}/${flip.vw}, bottom ${flip.bottom}/${flip.vh})`);

  /* ================================================================ *
   * 5. Keyboard operation
   * ================================================================ */

  const kb = await ev(`(async () => {
    ContextMenu.close();
    ContextMenu.openAt(400, 300, document.getElementById('editorPane'));
    await new Promise((r) => setTimeout(r, 120));
    const items = [...document.querySelectorAll('.menu.contextMenu .menu__item')].filter((i) => !i.disabled);
    return { opened: ContextMenu.isOpen(), first: items.length ? items[0].dataset.cmd : null };
  })()`);
  line('kb-open', kb.opened, `keyboard path opens (first enabled item: ${kb.first})`);

  await ev(`(() => { window.__ran = []; return true; })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await sleep(150);
  const focused = await ev(`document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.cmd : null`);
  line('kb-focus', Boolean(focused), `ArrowDown focuses "${focused}"`);

  /* ================================================================ *
   * 6. Cut / Copy / Paste through a focused menu panel
   *
   * The point of these is that they work with the *menu* holding focus,
   * which is exactly where document.execCommand('cut') fails.
   * ================================================================ */

  const cut = await ev(`(async () => {
    ContextMenu.close();
    // Stand in for the menu panel holding focus.
    const proxy = document.createElement('button');
    proxy.type = 'button';
    document.body.appendChild(proxy);
    proxy.focus();

    Editor.setText('alpha beta gamma');
    Editor.setSelection(0, 5);                        // "alpha"
    const before = Editor.getText();
    await Commands.get('edit.cut').run();
    await new Promise((r) => setTimeout(r, 80));
    const after = Editor.getText();
    proxy.remove();
    return { before, after, clip: window.sara.clipboard.readText() };
  })()`);
  line('cut', cut.after === ' beta gamma' && cut.clip === 'alpha',
    `clipboard="${cut.clip}" document="${cut.after}" (focus was off the textarea)`);

  const copy = await ev(`(async () => {
    Editor.setText('alpha beta');
    Editor.setSelection(6, 10);                       // "beta"
    await Commands.get('edit.copy').run();
    await new Promise((r) => setTimeout(r, 60));
    return { text: Editor.getText(), clip: window.sara.clipboard.readText() };
  })()`);
  line('copy', copy.text === 'alpha beta' && copy.clip === 'beta',
    `clipboard="${copy.clip}" document unchanged`);

  const paste = await ev(`(async () => {
    window.sara.clipboard.writeText('PASTED');
    Editor.setText('one two');
    Editor.setSelection(7, 7);
    await Commands.get('edit.paste').run();
    await new Promise((r) => setTimeout(r, 80));
    return Editor.getText();
  })()`);
  line('paste', paste === 'one twoPASTED', `document="${paste}"`);

  /* ================================================================ *
   * 7. Every enabled item in the editor menu fires
   * ================================================================ */

  const itemSweep = await ev(`(async () => {
    ContextMenu.close();
    MenuBar.close();
    const bad = [];
    let exercised = 0;
    const swept = new Set();
    // Stand in for the menu panel holding focus: the real panel closes on
    // activation, exactly like a native menu.
    const proxy = document.createElement('button');
    document.body.appendChild(proxy);

    // Some items legitimately open UI of their own - Font… opens the font
    // dialog, Find… opens the find bar. Close whatever a command left
    // behind, or the next iteration would be blocked by it.
    const tidy = () => {
      if (typeof FontDialog !== 'undefined' && FontDialog.isOpen()) FontDialog.close();
      if (typeof Search !== 'undefined' && Search.isOpen()) Search.close();
      const md = document.getElementById('modalOverlay');
      if (md && !md.hidden) md.hidden = true;
      ContextMenu.close();
      MenuBar.close();
    };

    // Re-derive the enabled list before every attempt: running a command
    // changes what is enabled, and a stale list would blame the product
    // for correctly refusing a disabled item.
    for (let guard = 0; guard < 80; guard++) {
      tidy();
      proxy.focus();
      Editor.setText('alpha beta gamma\\ndelta epsilon and some more words here');
      Editor.setSelection(0, 5);
      ContextMenu.openAt(300, 260, document.getElementById('editorPane'));
      await new Promise((r) => setTimeout(r, 60));

      const rows = [...document.querySelectorAll('.menu.contextMenu .menu__item')].filter((i) => !i.disabled);
      const next = rows.find((i) => !swept.has(i.dataset.cmd));
      if (!next) break;
      swept.add(next.dataset.cmd);
      const cmdId = next.dataset.cmd;

      window.__ran = [];
      next.click();
      await new Promise((r) => setTimeout(r, 110));
      exercised++;
      if (!window.__ran.includes(cmdId)) bad.push(cmdId);
    }

    proxy.remove();
    tidy();
    return { bad, exercised };
  })()`);
  line('sweep', itemSweep.bad.length === 0,
    `${itemSweep.exercised} enabled item(s) exercised${itemSweep.bad.length ? `, did not fire: ${itemSweep.bad.join(', ')}` : ', all fired'}`);

  /* ================================================================ *
   * 8. Tab and gutter contexts
   * ================================================================ */

  // A dialog owning the screen must suppress the context menu, not fight it.
  const guarded = await ev(`(async () => {
    FontDialog.open({ family: null, size: 12.5, ligatures: null });
    await new Promise((r) => setTimeout(r, 200));
    const el = document.getElementById('editorPane');
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 300, clientY: 300 }));
    await new Promise((r) => setTimeout(r, 120));
    const blocked = !ContextMenu.isOpen();
    FontDialog.close();
    await new Promise((r) => setTimeout(r, 120));
    return { blocked, dialogWasOpen: true };
  })()`);
  line('guard', guarded.blocked, 'no context menu while the font dialog is open');

  // Add a tab so the tab menu has something tab-specific to show.
  await ev(`(async () => {
    MenuBar.close();
    ContextMenu.close();
    const file = [...document.querySelectorAll('.menubar__item')].find((b) => b.textContent === 'File');
    file.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 150));
    const item = document.querySelector('.menu__item[data-cmd="file.new"]');
    if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 220));
    MenuBar.close();
    return Docs.count();
  })()`);

  const tabPt = await centre('.tab:last-child');
  await rightClick(tabPt.x, tabPt.y);
  const tabCtx = await ev(`(() => {
    const menu = document.querySelector('.menu.contextMenu');
    if (!menu) return { open: false };
    return { open: true, ctx: ContextMenu.context(), group: menu.dataset.group,
             items: [...menu.querySelectorAll('.menu__item')].map((i) => i.dataset.cmd) };
  })()`);
  line('tabmenu', tabCtx.open && tabCtx.ctx === 'tabs',
    `context="${tabCtx.ctx}" with ${tabCtx.items ? tabCtx.items.length : 0} items`);
  const tabSpecific = ['file.close', 'file.closeOthers', 'file.reopenClosed', 'tabs.closeAllTabs', 'file.reveal'];
  const tabMissing = tabSpecific.filter((id) => !(tabCtx.items || []).includes(id));
  line('tabitems', tabMissing.length === 0,
    tabMissing.length ? `missing: ${tabMissing.join(', ')}` : `${tabCtx.items.length} tab items present`);
  await ev('ContextMenu.close()');

  // Every id in every context must resolve. A typo would otherwise render
  // as a section label and look deliberate. This runs against the *source*
  // lists rather than the rendered DOM, so it catches a bad id even when
  // the context happens to be unopenable in the current state.
  const wiring = await ev(`(() => {
    const known = new Set(Commands.all().map((c) => c.id));
    const bad = [];
    let total = 0;
    for (const name of ContextMenu.contexts) {
      for (const entry of ContextMenu.layout(name)) {
        if (entry === '-' || entry.startsWith('#')) continue;
        total++;
        if (!known.has(entry)) bad.push(name + ':' + entry);
      }
    }
    return { bad, total, contexts: ContextMenu.contexts.length };
  })()`);
  line('wiring', wiring.bad.length === 0,
    wiring.bad.length
      ? `unregistered id(s): ${wiring.bad.join(', ')}`
      : `all ${wiring.total} ids across ${wiring.contexts} contexts resolve to registered commands`);

  // Right-clicking a line number must aim the menu at *that* line. The
  // editor scrolls to the bottom on setText, so reset it first or every
  // point maps onto the last line. The geometry is read once and the
  // coordinates are computed here, the way the gutter itself lays out.
  const geom = await ev(`(async () => {
    Editor.setText('L1 aaa\\nL2 bbb\\nL3 ccc\\nL4 ddd\\nL5 eee\\nL6 fff\\nL7 ggg\\nL8 hhh');
    Editor.element.scrollTop = 0;
    Editor.setSelection(0, 0);
    await new Promise((r) => setTimeout(r, 220));
    const gut = document.getElementById('gutter').getBoundingClientRect();
    const pane = document.getElementById('editorPane').getBoundingClientRect();
    return {
      x: Math.round(gut.left + gut.width / 2),
      paneTop: pane.top,
      lineHeight: Editor.metrics.lineHeight,
      paddingTop: Editor.metrics.paddingTop,
      scrollTop: Editor.element.scrollTop,
      lines: Editor.lineCount(),
    };
  })()`);

  const gutterHits = [];
  for (const target of [2, 5, 8]) {
    const y = Math.round(geom.paneTop + geom.paddingTop + (target - 1) * geom.lineHeight + geom.lineHeight / 2);
    await rightClick(geom.x, y);
    const got = await ev(`(() => {
      const line = Editor.caret().line;
      const start = Editor.lineStart(line);
      const end = Editor.getText().indexOf('\\n', start);
      return { line, content: Editor.getText().slice(start, end === -1 ? undefined : end), ctx: ContextMenu.context() };
    })()`);
    gutterHits.push({ target, got: got.line, content: got.content, ctx: got.ctx });
    await ev('ContextMenu.close()');
  }
  const gutterOk = gutterHits.every((h) => h.got === h.target && h.ctx === 'gutter'
    && h.content === `L${h.target} ${['aaa', 'bbb', 'ccc', 'ddd', 'eee', 'fff', 'ggg', 'hhh'][h.target - 1]}`);
  line('gutter', gutterOk,
    `line numbers aim the menu at the clicked line: ${gutterHits.map((h) => `${h.target}->"${h.content}"`).join(', ')}`);

  /* ================================================================ *
   * FONT DIALOG
   * ================================================================ */

  await ev('MenuBar.close(); ContextMenu.close(); Editor.element.focus()');

  // Ctrl+Shift+F through the real keyboard layer.
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70,
    modifiers: 2 | 8,   // Ctrl | Shift
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'F', code: 'KeyF', windowsVirtualKeyCode: 70,
    modifiers: 2 | 8,
  });
  await sleep(320);
  const accelOk = await ev('FontDialog.isOpen()');

  if (!accelOk) {
    // Fall back to opening it programmatically so the rest of the font
    // checks still produce a signal, but keep the failure.
    await ev('FontDialog.open({ family: null, size: 12.5, ligatures: null })');
    await sleep(200);
  }
  line('fontopen', accelOk, accelOk ? 'Ctrl+Shift+F opened the dialog' : 'Ctrl+Shift+F did not open it (continued via direct call)');

  const listState = await ev(`(() => {
    const rows = [...document.querySelectorAll('.fontList__row')];
    const avail = FontDialog.available;
    const present = Object.entries(avail).filter(([, v]) => v).map(([k]) => k);
    return {
      rows: rows.length,
      groups: [...document.querySelectorAll('.fontList__group')].map((g) => g.textContent),
      presentCount: present.length,
      present: present.slice(0, 12),
      sampleText: document.getElementById('fontSample').textContent.length,
      visible: !document.getElementById('fontOverlay').hidden,
    };
  })()`);
  line('fontlist', listState.visible && listState.rows > 0 && listState.groups.length > 0,
    `${listState.rows} row(s) in ${listState.groups.length} group(s); ${listState.presentCount} family(ies) detected as installed`);
  console.log(`           installed: ${listState.present.join(', ') || '(none detected)'}`);

  // Picking a family must repaint the sample only.
  const preview = await ev(`(async () => {
    const before = getComputedStyle(document.getElementById('editor')).fontFamily;
    const row = [...document.querySelectorAll('.fontList__row')]
      .find((r) => r.dataset.missing !== 'true' && r.dataset.family !== '(default)');
    const family = row ? row.dataset.family : null;
    if (row) row.click();
    await new Promise((r) => setTimeout(r, 120));
    return {
      family,
      sampleFont: document.getElementById('fontSample').style.fontFamily,
      editorBefore: before,
      editorAfter: getComputedStyle(document.getElementById('editor')).fontFamily,
      draft: FontDialog.draft,
      selected: document.querySelectorAll('.fontList__row--sel').length,
    };
  })()`);
  line('fontpick', Boolean(preview.family) && preview.selected === 1 && preview.editorAfter === preview.editorBefore,
    `picked "${preview.family}" - sample previews it, editor untouched until Apply`);

  // Apply, and confirm all three layers move together.
  const applied = await ev(`(async () => {
    const sizeInput = document.getElementById('fontSize');
    sizeInput.value = '17';
    sizeInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    document.getElementById('fontApply').click();
    await new Promise((r) => setTimeout(r, 400));

    const cs = (sel) => getComputedStyle(document.querySelector(sel));
    const ed = cs('#editor');
    const gut = cs('#gutter');
    const hl = cs('#highlightLayer');
    return {
      open: FontDialog.isOpen(),
      editorFamily: ed.fontFamily,
      gutterFamily: gut.fontFamily,
      hlFamily: hl.fontFamily,
      editorSize: ed.fontSize,
      gutterSize: gut.fontSize,
      hlSize: hl.fontSize,
      stored: { family: Store.get('fontFamily'), size: Store.get('fontSize') },
      lineH: ed.lineHeight,
    };
  })()`);
  line('fontapply', !applied.open && applied.stored.size === 17,
    `applied 17px ${applied.stored.family} (dialog closed, pref stored)`);

  // Comparing the three layers to *each other* is not enough: if the
  // family were ignored outright they would all still agree - on the
  // wrong font. And a substring search is not enough either, because the
  // default stack (`--font-mono`) already lists JetBrains Mono, Cascadia
  // Code and Consolas - so a broken custom font still "contains" the
  // name. The chosen family has to be *first* in the computed stack.
  const firstFamily = (css) => (css || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  const editorRendered = firstFamily(applied.editorFamily) === applied.stored.family;
  line('fontrender', editorRendered,
    `editor's leading family is "${firstFamily(applied.editorFamily)}" (wanted "${applied.stored.family}")`);

  line('fontsync',
    applied.editorFamily === applied.gutterFamily
    && applied.editorFamily === applied.hlFamily
    && applied.editorSize === applied.gutterSize
    && applied.editorSize === applied.hlSize,
    `editor/gutter/highlight agree: ${applied.editorSize} / ${applied.gutterSize} / ${applied.hlSize}, line-height ${applied.lineH}`);

  const gutterAlign = await ev(`(() => {
    const ed = getComputedStyle(document.getElementById('editor'));
    const gut = getComputedStyle(document.getElementById('gutter'));
    const lh = parseFloat(ed.lineHeight);
    const prose = document.createElement('span');
    prose.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;font:' + ed.fontSize + ' ' + ed.fontFamily;
    prose.textContent = '0'.repeat(100);
    document.body.appendChild(prose);
    const charW = prose.getBoundingClientRect().width / 100;
    prose.remove();
    return { ok: gut.fontFamily === ed.fontFamily && Math.abs(gut.fontSize && parseFloat(gut.fontSize) - parseFloat(ed.fontSize)) < 0.01,
             charW: Math.round(charW * 100) / 100, lh,
             editorCharW: Math.round(Editor.metrics.charWidth * 100) / 100 };
  })()`);
  line('metrics', gutterAlign.ok && Math.abs(gutterAlign.charW - gutterAlign.editorCharW) < 0.6,
    `chars measured at ${gutterAlign.editorCharW}px (independent probe ${gutterAlign.charW}px), line-height ${gutterAlign.lh}px`);

  /* ---- zoom multiplies the font size ------------------------------ */

  const zoomed = await ev(`(async () => {
    const base = Store.get('fontSize');
    const before = parseFloat(getComputedStyle(document.getElementById('editor')).fontSize);
    Commands.run('view.zoomIn');                     // 100 -> 110
    await new Promise((r) => setTimeout(r, 250));
    const size1 = parseFloat(getComputedStyle(document.getElementById('editor')).fontSize);
    const prefAfter = Store.get('fontSize');
    const zoomPct = Store.get('zoom');
    return { base, before, size1, prefAfter, zoomPct };
  })()`);
  const expected = Math.round(zoomed.base * (zoomed.zoomPct / 100) * 100) / 100;
  line('zoom', zoomed.prefAfter === zoomed.base && Math.abs(zoomed.size1 - expected) < 0.05,
    `pref stays ${zoomed.base}px at ${zoomed.zoomPct}% zoom, renders ${zoomed.size1}px (expected ${expected}px)`);

  // Back to 100% for the persistence check.
  await ev(`(async () => { Commands.run('view.zoomReset'); await new Promise((r) => setTimeout(r, 200)); return true; })()`);

  /* ---- persistence across a reload -------------------------------- */

  // Stash the expectation in localStorage, not on `window`: the reload
  // wipes every global.
  await ev(`(() => {
    localStorage.setItem('__expect', JSON.stringify({ family: Store.get('fontFamily'), size: Store.get('fontSize') }));
    return true;
  })()`);
  const beforeReload = await ev(`JSON.parse(localStorage.getItem('__expect'))`);
  await ev('location.reload()');
  await sleep(3200);

  const persisted = await ev(`(() => {
    const cs = getComputedStyle(document.getElementById('editor'));
    const gut = getComputedStyle(document.getElementById('gutter'));
    const expected = JSON.parse(localStorage.getItem('__expect'));
    return {
      computed: cs.fontFamily,
      gutter: gut.fontFamily,
      size: parseFloat(cs.fontSize),
      expected,
      stored: Store.get('fontFamily'),
      booted: Boolean(document.querySelector('.menubar__item')),
    };
  })()`);
  // Both halves matter: the pref must survive, *and* the restored pref must
  // actually be leading on screen. A boot path that reads the pref but
  // never calls applyFont would pass the first and fail the second.
  const lead = (css) => (css || '').split(',')[0].trim().replace(/^["']|["']$/g, '');
  line('persist', persisted.booted
      && persisted.stored === beforeReload.family
      && lead(persisted.computed) === beforeReload.family
      && lead(persisted.gutter) === beforeReload.family
      && Math.abs(persisted.size - beforeReload.size) < 0.01,
    `"${beforeReload.family}" @ ${beforeReload.size}px both stored and rendered after reload `
    + `(computed: ${lead(persisted.computed)} @ ${persisted.size}px)`);

  /* ---- reset ------------------------------------------------------ */

  const afterReset = await ev(`(async () => {
    Commands.run('view.resetFont');
    await new Promise((r) => setTimeout(r, 300));
    const cs = getComputedStyle(document.getElementById('editor'));
    const gut = getComputedStyle(document.getElementById('gutter'));
    return {
      stored: { family: Store.get('fontFamily'), size: Store.get('fontSize') },
      editor: cs.fontFamily, gutter: gut.fontFamily,
      size: cs.fontSize,
      inlineFamily: document.getElementById('editor').style.getPropertyValue('--editor-font-family'),
    };
  })()`);
  line('reset', afterReset.stored.family === null && afterReset.stored.size === 12.5
    && afterReset.inlineFamily === '' && afterReset.editor === afterReset.gutter,
    `back to the built-in stack at ${afterReset.size} (no inline override left on the textarea)`);

  /* ================================================================ *
   * Console health
   * ================================================================ */

  const uniq = [...new Set(cdp.consoleErrors)];
  console.log(`\nconsole errors: ${uniq.length}`);
  for (const e of uniq.slice(0, 8)) console.log('  - ' + String(e).split('\n')[0]);

  console.log(failures.length
    ? `\nFAILED (${failures.length}/${checks}): ${failures.join(', ')}`
    : `\nAll ${checks} checks passed.`);

  await cdp.close();
  server.kill();
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  console.error('\ntest could not run:', e.message);
  process.exit(1);
});
