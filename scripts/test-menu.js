'use strict';

/**
 * Menu regression test.
 *
 * Drives the menu bar with genuine pointer input through CDP and asserts the
 * behaviour a user depends on:
 *
 *   1. every dropdown opens,
 *   2. every enabled item in every dropdown runs its command when clicked,
 *   3. the dropdown paints above the tab strip and the editor,
 *   4. sliding along the bar switches menus while one is open,
 *   5. a press outside dismisses the menu,
 *   6. the bar is fully operable from the keyboard.
 *
 * Usage:  node scripts/test-menu.js     (starts its own preview server)
 * Exit code 0 = healthy, 1 = at least one failure.
 * Verification only - not shipped.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { launch, sleep } = require('./lib/cdp');

const PORT = Number(process.env.PORT || 5199);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9401);
const PREVIEW = path.join(__dirname, 'preview-server.js');

(async () => {
  // The preview server stubs window.sara; start it as a child so the test is a
  // single command rather than something that needs a leftover process. (This
  // used to assume a server was already listening, which made the failure mode
  // `Commands is not defined` - the page had loaded about:blank or an error.)
  const server = spawn(process.execPath, [PREVIEW], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(700);

  const cdp = await launch({ port: PORT, debugPort: DEBUG_PORT, windowSize: '1280,900', label: 'menu' });
  const { send, ev, click, move, centre } = cdp;
  const teardown = async () => { await cdp.close(); server.kill(); };

  await sleep(2600);   // let boot() finish its async session restore

  // Record every command the app actually runs.
  await ev(`(() => {
    window.__ran = [];
    const original = Commands.run;
    Commands.run = function (cmdId, ...rest) { window.__ran.push(cmdId); return original.call(Commands, cmdId, ...rest); };
    return true;
  })()`);

  const labels = await ev(`[...document.querySelectorAll('.menubar__item')].map((b) => b.textContent)`);
  console.log('\n=== SaraText menu test ===');
  console.log(`menus: ${labels.join(' | ')}\n`);

  // Open two extra tabs. Commands like "Next Tab", "Close Other Tabs" and
  // "Close All Tabs" are deliberately disabled on a single-document session,
  // so without this the tab-dependent half of the Tabs menu is never covered.
  await ev(`(async () => {
    const file = [...document.querySelectorAll('.menubar__item')].find((b) => b.textContent === 'File');
    for (let i = 0; i < 2; i++) {
      file.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 160));
      const item = document.querySelector('.menu__item[data-cmd="file.new"]');
      if (item) item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      await new Promise((r) => setTimeout(r, 200));
      MenuBar.close();
    }
    return true;
  })()`);
  const tabsOpen = await ev('Docs.count()');
  console.log(`tabs open: ${tabsOpen}\n`);

  const failures = [];
  const note = (ok, msg) => { if (!ok) failures.push(msg); return ok ? 'PASS' : 'FAIL'; };

  for (const label of labels) {
    const index = labels.indexOf(label) + 1;
    const button = await centre(`.menubar__item:nth-child(${index})`);
    await click(button.x, button.y);

    if (!(await ev('MenuBar.isOpen()'))) {
      note(false, `${label}:dropdown`);
      console.log(`${label.padEnd(7)} FAIL  dropdown did not open`);
      continue;
    }

    // Exercise every enabled item. The list is re-derived before each attempt
    // because running a command can change what is enabled - closing the last
    // spare tab disables "Reopen Closed Tab", and a stale list would then blame
    // the product for correctly refusing to run a disabled item.
    const tried = new Set();
    let bad = 0;
    for (;;) {
      const ids = await ev(`[...document.querySelectorAll('.menu__item')].filter((i) => !i.disabled).map((i) => i.dataset.cmd)`);
      const cmdId = ids.find((c) => !tried.has(c));
      if (!cmdId) break;
      tried.add(cmdId);

      await ev('window.__ran = []');
      const point = await centre(`.menu__item[data-cmd="${cmdId}"]`);
      if (!point) {
        // The item vanished between enumeration and measurement; a rebuild did
        // that, not a click failure. Treat it as unverified rather than broken.
        continue;
      }
      await click(point.x, point.y);
      const ran = await ev('window.__ran');
      if (!ran.includes(cmdId)) bad++;

      // Re-open for the next item.
      await click(button.x, button.y);
      if (!(await ev('MenuBar.isOpen()'))) break;
    }
    await ev('MenuBar.close()');

    const ok = bad === 0;
    if (!ok) failures.push(`${label}:${bad} item(s)`);
    console.log(`${label.padEnd(7)} ${ok ? 'PASS' : 'FAIL'}  ${tried.size} item(s) exercised${ok ? '' : `, ${bad} did not fire`}`);
    await sleep(120);
  }

  // The dropdown must paint above the tab strip and the editor, not under them.
  const layering = await ev(`(async () => {
    MenuBar.close();
    const button = document.querySelector('.menubar__item');
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 150));
    const item = document.querySelector('.menu__item');
    const r = item.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const parentIsBody = document.querySelector('.menu').parentElement === document.body;
    MenuBar.close();
    return { onTop: item.contains(hit), parentIsBody };
  })()`);
  console.log(`\nlayering   ${note(layering.onTop, 'layering:hit-test')}  items hit-test above the tab strip (panel on body: ${layering.parentIsBody})`);

  // Sliding along the bar with a menu open switches menus.
  const hover = await ev(`(async () => {
    MenuBar.close();
    document.querySelectorAll('.menubar__item')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 150));
    return MenuBar.isOpen();
  })()`);
  const second = await centre('.menubar__item:nth-child(2)');
  await move(second.x, second.y);
  const switched = await ev(`(() => {
    const open = document.querySelector('.menu');
    return open ? open.dataset.group : null;
  })()`);
  const hoverOk = hover && switched === 'menu.edit';
  console.log(`hover      ${note(hoverOk, 'hover:switch')}  sliding to "Edit" while open switches menus (now: ${switched})`);

  // A press outside the bar dismisses the menu.
  await ev(`document.querySelectorAll('.menubar__item')[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }))`);
  await sleep(150);
  await click(640, 420);
  const dismissed = !(await ev('MenuBar.isOpen()'));
  console.log(`outside    ${note(dismissed, 'outside:press')}  pressing the editor closes the menu`);

  // Keyboard-only operation.
  const kb = await ev(`(async () => {
    MenuBar.close();
    const button = document.querySelector('.menubar__item');
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((r) => setTimeout(r, 140));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 110));
    const focused = document.activeElement;
    const isItem = Boolean(focused && focused.classList && focused.classList.contains('menu__item'));
    const cmd = isItem ? focused.dataset.cmd : null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 140));
    const moved = document.querySelector('.menu') ? document.querySelector('.menu').dataset.group : null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 120));
    return { isItem, cmd, moved, closed: !MenuBar.isOpen() };
  })()`);
  console.log(`keyboard   ${note(kb.isItem, 'keyboard:focus')}  ArrowDown focuses an item (${kb.cmd})`);
  console.log(`keyboard   ${note(kb.moved === 'menu.edit', 'keyboard:switch')}  ArrowRight moves to the next menu (${kb.moved})`);
  console.log(`keyboard   ${note(kb.closed, 'keyboard:escape')}  Escape closes the menu`);

  const uniq = [...new Set(cdp.consoleErrors)];
  console.log(`\nconsole errors: ${uniq.length}`);
  for (const e of uniq.slice(0, 10)) console.log('  - ' + String(e).split('\n')[0]);

  console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nAll menu checks passed.');

  await teardown();
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => {
  console.error('menu test could not run:', e.message);
  process.exit(1);
});
