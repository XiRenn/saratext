'use strict';

/**
 * Editor keyboard regression test - the Tab / Shift+Tab contract.
 *
 * Drives the renderer in headless Chromium over CDP with *genuine* Tab key
 * events (Input.dispatchKeyEvent), not synthetic KeyboardEvents, and asserts
 * the behaviour a user depends on:
 *
 *   TAB, bare caret
 *     1. mid-line it inserts at the caret - the text to the LEFT must not
 *        move. Re-indenting the whole line there is the reported bug: the
 *        line looks like it jumped instead of splitting,
 *     2. at the start of a line it inserts at column 1,
 *     3. at the end of a line it appends,
 *     4. a corrupt `tabSize` preference cannot make it throw or no-op.
 *
 *   TAB, selection
 *     5. every touched line gains exactly one level,
 *     6. the selection survives and still covers the same lines.
 *
 *   SHIFT+TAB
 *     7. mid-line it gives back one unit immediately before the caret,
 *     8. inside the indentation it outdents the line,
 *     9. at column 1 of a flush-left line it is a no-op,
 *    10. on a selection every touched line loses one level AND the
 *        selection survives - it used to collapse and dump the caret at
 *        the end of the document.
 *
 *   HEALTH
 *    11. no renderer console errors.
 *
 * Usage:  node scripts/test-editor-keys.js
 * Exit code 0 = healthy, 1 = at least one failure.
 * Verification only - not shipped.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { launch, sleep } = require('./lib/cdp');

const PORT = Number(process.env.PORT || 5199);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9404);
const PREVIEW = path.join(__dirname, 'preview-server.js');

const UNIT = '    ';   // tabSize 4, the default

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
  console.log(`${label.padEnd(12)} ${note(ok, label)}${detail ? `  ${detail}` : ''}`);

const show = (s) => JSON.stringify(s);

/* ------------------------------------------------------------------ */

(async () => {
  const server = spawn(process.execPath, [PREVIEW], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(700);

  const cdp = await launch({ port: PORT, debugPort: DEBUG_PORT, windowSize: '1400,940', label: 'keys' });
  const { ev } = cdp;
  await sleep(2600);

  /** A real Tab press. `shift` sets the Shift modifier. */
  const tab = async (shift = false) => {
    const modifiers = shift ? 8 : 0;
    const base = {
      key: 'Tab', code: 'Tab',
      windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers,
    };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await sleep(120);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(260);
  };

  /** Load `text` into a fresh document, put the caret/selection, return it. */
  const setup = async (text, start, end = start) => {
    await ev(`(() => {
      Editor.setText(${JSON.stringify(text)});
      Editor.element.disabled = false;
      Editor.element.focus();
      Editor.element.setSelectionRange(${start}, ${end});
      Editor.refreshCaret();
    })()`);
    await sleep(360);
    return { text, start, end };
  };

  const state = () => ev(`JSON.stringify({
    text: Editor.getText(),
    start: Editor.element.selectionStart,
    end: Editor.element.selectionEnd,
    sel: Editor.getSelection().text,
  })`).then(JSON.parse);

  await ev(`Commands.run('file.new')`);
  await sleep(400);

  /* ================================================================ *
   * Tab with a bare caret
   * ================================================================ */

  // 1. The reported bug: Tab in the middle of a line must split there.
  {
    const text = 'PRICE  QTY';
    const at = 7;                       // between the two words
    await setup(text, at);
    await tab();
    const s = await state();
    const expected = 'PRICE      QTY';  // unit inserted at the caret
    const leftIntact = s.text.slice(0, at) === text.slice(0, at);
    line('tab mid-line', s.text === expected && leftIntact && s.start === at + 4,
      `${show(text)} @${at} -> ${show(s.text)} caret ${s.start}`
      + (leftIntact ? ' (text left of the caret did not move)' : ' (LEFT SIDE JUMPED)'));
  }

  // 2. At column 1 the unit lands at the start of the line.
  {
    const text = 'alpha\nbeta';
    await setup(text, 6);               // start of line 2
    await tab();
    const s = await state();
    line('tab at col 1', s.text === 'alpha\n    beta' && s.start === 10,
      `-> ${show(s.text)} caret ${s.start}`);
  }

  // 3. At the end of the last line it appends, with no newline created.
  {
    const text = 'alpha';
    await setup(text, 5);
    await tab();
    const s = await state();
    line('tab at eol', s.text === 'alpha    ' && s.start === 9,
      `-> ${show(s.text)} caret ${s.start}`);
  }

  // 4. A corrupt preference must not throw (String.repeat RangeError) or
  //    silently insert nothing.
  {
    await ev(`Store.set('tabSize', -2)`);
    await setup('x', 0);
    await tab();
    const s = await state();
    await ev(`Store.set('tabSize', 4)`);
    line('tab bad pref', s.text === `${UNIT}x` && s.start === 4,
      `tabSize=-2 fell back to 4 -> ${show(s.text)}`);
  }

  /* ================================================================ *
   * Tab with a selection
   * ================================================================ */

  // 5 + 6. Every touched line gains one level and the selection survives.
  {
    const text = 'one\ntwo\nthree';
    const from = 0;
    const to = 7;                       // "one\ntwo" - ends on 'o', line 3 untouched
    await setup(text, from, to);
    await tab();
    const s = await state();
    const expected = '    one\n    two\nthree';
    line('tab selection', s.text === expected,
      `${show(text)} -> ${show(s.text)}`);
    line('tab sel kept', s.start > 0 && s.end - s.start === s.sel.length
      && s.sel === 'one\n    two' && s.text.slice(0, s.end) === expected.slice(0, s.end),
      `selection ${s.start}..${s.end} still covers ${show(s.sel)}`);
  }

  /* ================================================================ *
   * Shift+Tab
   * ================================================================ */

  // 7. Mid-line: give back one unit immediately before the caret.
  {
    const text = 'PRICE      QTY';      // two levels of space between the words
    const at = 11;                      // just before 'Q'
    await setup(text, at);
    await tab(true);
    const s = await state();
    line('s-tab mid-line', s.text === 'PRICE  QTY' && s.start === 7,
      `${show(text)} @${at} -> ${show(s.text)} caret ${s.start}`);
  }

  // 8. Inside the indentation: outdent the line.
  {
    const text = '        deep';
    await setup(text, 3);               // caret inside the leading spaces
    await tab(true);
    const s = await state();
    line('s-tab in indent', s.text === '    deep' && s.start === 0,
      `-> ${show(s.text)} caret ${s.start}`);
  }

  // 9. Flush left: nothing to remove, and no throw.
  {
    const text = 'flush';
    await setup(text, 0);
    await tab(true);
    const s = await state();
    line('s-tab flush', s.text === text && s.start === 0,
      `-> ${show(s.text)} caret ${s.start}`);
  }

  // 10. On a selection: outdent all touched lines, keep the selection.
  //     This is the regression - it used to collapse to a caret at the end.
  {
    const text = '    one\n    two\n    three';
    const to = text.indexOf('    three') - 1;       // "    one\n    two"
    await setup(text, 0, to);
    await tab(true);
    const s = await state();
    line('s-tab selection', s.text === 'one\ntwo\n    three',
      `${show(text)} -> ${show(s.text)}`);
    line('s-tab sel kept', s.start === 0 && s.end > s.start && s.sel === 'one\ntwo',
      `selection ${s.start}..${s.end} still covers ${show(s.sel)}`
      + ' (was collapsing to the end of the document)');
  }

  // And a second Shift+Tab outdents the same block again.
  {
    const before = await state();
    await tab(true);
    const s = await state();
    line('s-tab twice', s.text === 'one\ntwo\n    three' && s.end > s.start,
      `second press is a no-op at level 0, selection ${s.start}..${s.end} `
      + `(text unchanged: ${s.text === before.text})`);
  }

  /* ================================================================ *
   * Console health
   * ================================================================ */

  const uniq = [...new Set(cdp.consoleErrors)];
  console.log(`\nconsole errors: ${uniq.length}`);
  for (const e of uniq.slice(0, 8)) console.log('  - ' + String(e).split('\n')[0]);
  line('console', uniq.length === 0, 'the renderer stayed silent');

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
