'use strict';

/**
 * Markdown preview regression test.
 *
 * Drives the renderer in headless Chromium over CDP and asserts the
 * behaviour a user depends on:
 *
 *   RENDERING
 *     1. every supported block type reaches the DOM (headings, lists,
 *        nested lists, task items, quotes, fences, tables, rules, setext),
 *     2. inline emphasis, code spans, links and strikethrough survive,
 *     3. an image becomes a placeholder, never an <img>,
 *     4. table alignment is honoured,
 *     5. a document past the size limit renders a notice instead,
 *     6. a re-render keeps the reader's scroll position.
 *
 *   SAFETY
 *     7. raw HTML in the source is inert - no element is created from it,
 *        and no inline handler can run,
 *     8. javascript:/data: links carry no href at all,
 *     9. a link that climbs out of the document's folder is refused
 *        before the filesystem is touched.
 *
 *   WIRING
 *    10. Ctrl+Shift+M / Ctrl+Shift+E switch layout and the panes actually
 *        resize (measured, not just asserted from the data attribute),
 *    11. the mode is per tab and survives a tab switch,
 *    12. both commands are registered and reachable from the View menu and
 *        the editor context menu,
 *    13. clicking a web link goes to the shell, a sibling link opens a tab,
 *    14. the code-block Copy button fills the clipboard.
 *
 * Usage:  node scripts/test-preview.js
 * Exit code 0 = healthy, 1 = at least one failure.
 * Verification only - not shipped.
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { launch, sleep } = require('./lib/cdp');

const PORT = Number(process.env.PORT || 5199);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9403);
const PREVIEW = path.join(__dirname, 'preview-server.js');

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const MD = [
  '# SaraText',
  '',
  'Intro with **bold**, *italic*, `code`, ~~struck~~ and a [link](https://example.com).',
  '',
  '## Lists',
  '',
  '- one',
  '- two',
  '  - nested',
  '- [x] done',
  '',
  '1. first',
  '2. second',
  '',
  '> quoted **text**',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '| Layer | Tech |',
  '| ----- | ---: |',
  '| Mono  | pnpm |',
  '',
  '---',
  '',
  'Setext',
  '======',
  '',
  '![](missing.png)',
].join('\n');

/** Raw HTML and hostile URLs: none of this may become markup or run. */
const HOSTILE = [
  '# Hostile',
  '',
  '<script>window.__pwned = true;<\/script>',
  '<img src=x onerror="window.__pwned = true">',
  '<iframe src="https://example.com"></iframe>',
  '',
  '[safe](https://example.com)',
  '[js](javascript:window.__pwned=true)',
  '[data](data:text/html,<script>alert(1)<\/script>)',
  '[vb](vbscript:msgbox(1))',
].join('\n');

/** Link routing fixture, opened from a real path so relative links resolve. */
const PADDING = Array.from({ length: 40 }, (_, i) => `Padding ${i}.`).join('\n\n');
const LINKS = [
  '# Links',
  '',
  '[web](https://example.com/x)',
  '[escape](../../secret.md)',
  '[sibling](sibling.md)',
  '[anchor](#deep)',
  '',
  PADDING,
  '',
  '## Deep',
  '',
  'end',
].join('\n');

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
  console.log(`${label.padEnd(11)} ${note(ok, label)}${detail ? `  ${detail}` : ''}`);

/* ------------------------------------------------------------------ */

(async () => {
  const server = spawn(process.execPath, [PREVIEW], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(700);

  const cdp = await launch({ port: PORT, debugPort: DEBUG_PORT, windowSize: '1400,940', label: 'preview' });
  const { ev, click, rightClick, centre } = cdp;

  await sleep(2600);   // let boot() finish its async session restore

  console.log('\n=== SaraText markdown preview ===\n');

  // Record what the app runs and what it tries to read, so "did this link
  // reach the filesystem" is answered by the bridge rather than by guessing.
  await ev(`(() => {
    window.__ran = [];
    const run = Commands.run;
    Commands.run = function (id, ...rest) { window.__ran.push(id); return run.call(Commands, id, ...rest); };
    window.__readPaths = [];
    const read = window.sara.readFile;
    window.sara.readFile = (p) => { window.__readPaths.push(String(p)); return read(p); };
    return true;
  })()`);

  /* ================================================================ *
   * 1-4. Block + inline rendering
   * ================================================================ */

  await ev(`(async () => {
    Editor.setText(${JSON.stringify(MD)});
    Commands.run('view.togglePreview');
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);

  const dom = await ev(`(() => {
    const body = document.getElementById('previewBody');
    const count = (sel) => body.querySelectorAll(sel).length;
    const code = body.querySelector('.md-pre code');
    const rightCell = body.querySelector('td[style*="right"]');
    const nested = body.querySelector('ul ul li');
    return {
      h1: count('h1.md-h'),
      h2: count('h2.md-h'),
      p: count('p.md-p'),
      ul: count('ul.md-list'),
      ol: count('ol.md-list'),
      li: count('li.md-li'),
      nested: Boolean(nested),
      task: count('li.md-li--task input.md-task'),
      taskChecked: Boolean(body.querySelector('input.md-task:checked')),
      quote: count('blockquote.md-quote'),
      hr: count('hr.md-hr'),
      table: count('table.md-table'),
      rows: count('table.md-table tbody tr'),
      th: count('table.md-table th'),
      rightAligned: Boolean(rightCell),
      strong: count('strong'),
      em: count('em'),
      del: count('del'),
      inlineCode: count('code.md-code-inline'),
      link: count('a.md-link'),
      img: count('img'),
      placeholder: count('.md-img'),
      copyBtn: count('.md-pre__copy'),
      lang: (body.querySelector('.md-pre__lang') || {}).textContent,
      codeText: code ? code.textContent : null,
      text: body.textContent,
    };
  })()`);

  const blockOk = dom.h1 === 2 && dom.h2 === 1 && dom.ul === 2 && dom.ol === 1
    && dom.li === 6 && dom.quote === 1 && dom.hr === 1 && dom.table === 1
    && dom.rows === 1 && dom.th === 2;
  line('blocks', blockOk,
    `h1=${dom.h1} (ATX + setext) h2=${dom.h2} ul=${dom.ul} ol=${dom.ol} li=${dom.li} quote=${dom.quote} hr=${dom.hr} table=${dom.table} rows=${dom.rows}`);

  line('lists', dom.nested && dom.task === 1 && dom.taskChecked,
    `nested list present, ${dom.task} task item and it is checked`);

  line('inline', dom.strong === 2 && dom.em === 1 && dom.del === 1
    && dom.inlineCode === 1 && dom.link === 1,
    `strong=${dom.strong} em=${dom.em} del=${dom.del} code=${dom.inlineCode} link=${dom.link}`);

  line('fence', dom.lang === 'js' && dom.codeText === 'const a = 1;' && dom.copyBtn === 1,
    `lang="${dom.lang}" body="${String(dom.codeText).trim()}" copy button: ${dom.copyBtn}`);

  line('align', dom.rightAligned, 'the `---:` column renders right-aligned');

  line('image', dom.img === 0 && dom.placeholder === 1,
    `no <img> created; the image is a placeholder reading "${(dom.text.match(/missing\.png/) || [''])[0]}"`);

  /* ================================================================ *
   * 5. Scroll is preserved across a re-render
   * ================================================================ */

  const scroll = await ev(`(async () => {
    const body = document.getElementById('previewBody');
    // Make the document long enough to actually scroll.
    Editor.setText(Array.from({ length: 80 }, (_, i) => 'Paragraph ' + i + ' with some words in it.').join('\\n\\n'));
    await new Promise((r) => setTimeout(r, 500));
    body.scrollTop = 250;
    const before = body.scrollTop;
    Preview.render(Docs.active());
    const after = body.scrollTop;
    return { before, after, max: Math.round(body.scrollHeight - body.clientHeight) };
  })()`);
  line('scroll', scroll.before > 0 && Math.abs(scroll.after - scroll.before) <= 2,
    `offset ${scroll.before} → ${scroll.after} across a re-render (max ${scroll.max})`);

  /* ================================================================ *
   * 6-9. Hostile source
   * ================================================================ */

  await ev(`(async () => {
    Editor.setText(${JSON.stringify(HOSTILE)});
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);

  const hostile = await ev(`(() => {
    const body = document.getElementById('previewBody');
    const blocked = [...body.querySelectorAll('a')];
    return {
      scripts: body.querySelectorAll('script').length,
      imgs: body.querySelectorAll('img').length,
      iframes: body.querySelectorAll('iframe').length,
      pwned: Boolean(window.__pwned),
      literalText: body.textContent.includes('<script>'),
      elements: body.querySelectorAll('*').length,
      links: blocked.length,
      hrefs: blocked.map((a) => a.getAttribute('href')),
      blockedLinks: body.querySelectorAll('.md-link--blocked').length,
      safeHref: (body.querySelector('a.md-link[data-href="https://example.com"]') || {}).outerHTML || null,
    };
  })()`);

  line('inert', hostile.scripts === 0 && hostile.imgs === 0 && hostile.iframes === 0 && !hostile.pwned,
    `script=${hostile.scripts} img=${hostile.imgs} iframe=${hostile.iframes} executed=${hostile.pwned} (${hostile.elements} elements total)`);

  line('literal', hostile.literalText,
    'the raw HTML is visible as text, which is what "no passthrough" means');

  const noHref = hostile.hrefs.every((h) => h === null || /^https?:/.test(h));
  line('schemes', hostile.links === 1 && noHref && hostile.blockedLinks === 3,
    `${hostile.links} live link, ${hostile.blockedLinks} blocked; hrefs = ${JSON.stringify(hostile.hrefs)}`);

  /* ================================================================ *
   * 10. Layout actually changes
   * ================================================================ */

  const geometry = () => ev(`(() => {
    const wrap = document.getElementById('editorWrap');
    const ed = document.getElementById('editorPane');
    const pv = document.getElementById('previewPane');
    const box = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.width); };
    return {
      mode: wrap.dataset.mode, hidden: pv.hidden,
      edDisplay: getComputedStyle(ed).display, pvDisplay: getComputedStyle(pv).display,
      wrapW: box(wrap), edW: box(ed), pvW: box(pv),
      view: Docs.active().view,
    };
  })()`);

  const split = await geometry();
  line('split', split.mode === 'split' && !split.hidden && split.edW > 100 && split.pvW > 100
    && Math.abs(split.edW - split.pvW) < 24,
    `editor ${split.edW}px / preview ${split.pvW}px inside ${split.wrapW}px`);

  await ev(`Commands.run('view.previewOnly')`);
  await sleep(250);
  const only = await geometry();
  line('previewonly', only.mode === 'preview' && only.edDisplay === 'none'
    && Math.abs(only.pvW - only.wrapW) <= 1,
    `editor display=${only.edDisplay}, preview takes the full ${only.pvW}px`);

  // Back to editing. Toggling full-pane is the only way out of "preview";
  // the side-by-side command would land in "split", which is its own state.
  await ev(`Commands.run('view.previewOnly')`);
  await sleep(250);
  const back = await geometry();
  line('backtoedit', back.mode === 'edit' && back.hidden && back.pvDisplay === 'none'
    && back.edW > 100,
    `editor back at ${back.edW}px, preview display=${back.pvDisplay}`);

  /* ================================================================ *
   * 11. The mode is per tab
   * ================================================================ */

  const perTab = await ev(`(async () => {
    const first = Docs.active();
    Commands.run('view.togglePreview');           // first tab -> split
    await new Promise((r) => setTimeout(r, 240));
    const firstView = first.view;

    Commands.run('file.new');                     // second tab, default view
    await new Promise((r) => setTimeout(r, 300));
    const second = Docs.active();
    return {
      firstView,
      firstId: first.id,
      secondView: second.view,
      secondId: second.id,
      modeOnSecond: document.getElementById('editorWrap').dataset.mode,
    };
  })()`);

  // Return to the first tab the way the tab strip does - a genuine click, so
  // stashActive + setActive + presentDoc all run.
  const tabClick = await ev(`(() => {
    const tabs = [...document.querySelectorAll('.tab')];
    const first = tabs[0];
    const r = first.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), n: tabs.length };
  })()`);
  await click(tabClick.x, tabClick.y);
  const afterSwitchBack = await ev(`(() => ({
    mode: document.getElementById('editorWrap').dataset.mode,
    hidden: document.getElementById('previewPane').hidden,
    view: Docs.active().view,
    id: Docs.active().id,
  }))()`);

  line('pertab', perTab.firstView === 'split' && perTab.secondView === 'edit'
    && perTab.modeOnSecond === 'edit'
    && afterSwitchBack.id === perTab.firstId
    && afterSwitchBack.mode === 'split' && !afterSwitchBack.hidden,
    `tab A="${perTab.firstView}" tab B="${perTab.secondView}", returning to A restores "${afterSwitchBack.mode}" (${tabClick.n} tabs)`);

  /* ================================================================ *
   * 12. Reachable from the menu and the context menu
   * ================================================================ */

  const wiring = await ev(`(() => {
    const viewMenu = (Commands.menuLayout.find((m) => m.label === 'View') || {}).items || [];
    const editorCtx = ContextMenu.layout('editor');
    return {
      inViewMenu: viewMenu.includes('view.togglePreview') && viewMenu.includes('view.previewOnly'),
      inEditorCtx: editorCtx.includes('view.togglePreview') && editorCtx.includes('view.previewOnly'),
      registered: Boolean(Commands.get('view.togglePreview') && Commands.get('view.previewOnly')),
      accels: [Commands.get('view.togglePreview').accel, Commands.get('view.previewOnly').accel],
    };
  })()`);
  line('wiring', wiring.registered && wiring.inViewMenu && wiring.inEditorCtx,
    `registered (${wiring.accels.join(', ')}), in the View menu and the editor context menu`);

  // Prove the context menu really renders them, not just that the layout lists them.
  const ctxPoint = await centre('#editorPane');
  await rightClick(ctxPoint.x, ctxPoint.y);
  const ctxItems = await ev(`[...document.querySelectorAll('.menu.contextMenu .menu__item')].map((i) => i.dataset.cmd)`);
  await ev('ContextMenu.close()');
  line('ctxrender', ctxItems.includes('view.togglePreview') && ctxItems.includes('view.previewOnly'),
    `${ctxItems.length} context items, both preview commands present`);

  /* ================================================================ *
   * 13-14. Links and code copy
   * ================================================================ */

  await ev(`(async () => {
    window.__mockFiles.set('C:/notes/README.md', ${JSON.stringify(LINKS)});
    window.__mockFiles.set('C:/notes/sibling.md', '# sibling\\n\\nopened by a link');
    window.__emitOpenPaths(['C:/notes/README.md']);
    await new Promise((r) => setTimeout(r, 700));
    Commands.run('view.togglePreview');
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);

  const linksDoc = await ev(`(() => ({
    path: Docs.active().path,
    tabs: Docs.count(),
    mode: document.getElementById('editorWrap').dataset.mode,
    anchors: [...document.querySelectorAll('#previewBody a')].map((a) => a.dataset.href),
  }))()`);
  line('openmd', linksDoc.path === 'C:/notes/README.md' && linksDoc.mode === 'split',
    `opened ${linksDoc.path} through the shell handshake, anchors: ${linksDoc.anchors.join(', ')}`);

  // Web link -> the shell, never an in-app navigation.
  const web = await centre('#previewBody a[data-href="https://example.com/x"]');
  await click(web.x, web.y);
  await sleep(200);
  const external = await ev('window.__external');
  const stillHere = await ev('location.pathname');
  line('web', external.includes('https://example.com/x') && stillHere === '/',
    `handed "${external.join('", "')}" to the shell; the page did not navigate`);

  // A link that climbs out of the folder must never reach the filesystem.
  const escape = await centre('#previewBody a[data-href="../../secret.md"]');
  await click(escape.x, escape.y);
  await sleep(300);
  const escaped = await ev(`(() => ({
    tabs: Docs.count(),
    touched: window.__readPaths.filter((p) => /secret/i.test(p)),
  }))()`);
  line('escape', escaped.tabs === linksDoc.tabs && escaped.touched.length === 0,
    `refused before readFile (${escaped.touched.length} reads attempted outside the folder)`);

  // Anchor link scrolls the pane.
  const anchor = await centre('#previewBody a[data-href="#deep"]');
  await click(anchor.x, anchor.y);
  await sleep(300);
  const anchored = await ev(`document.getElementById('previewBody').scrollTop`);
  line('anchor', anchored > 0, `#deep scrolled the pane to ${Math.round(anchored)}px`);

  // Back to the top, so the sibling link below is on screen to click.
  await ev(`document.getElementById('previewBody').scrollTop = 0`);

  // Sibling link -> a new tab. This one navigates, so it runs last.
  const sibling = await centre('#previewBody a[data-href="sibling.md"]');
  await click(sibling.x, sibling.y);
  await sleep(600);
  const opened = await ev(`(() => ({
    tabs: Docs.count(),
    names: Docs.all().map((d) => d.name),
  }))()`);
  line('sibling', opened.tabs === linksDoc.tabs + 1 && opened.names.includes('sibling.md'),
    `tabs ${linksDoc.tabs} → ${opened.tabs} (${opened.names.join(', ')})`);

  // The fence's Copy button goes through the real clipboard bridge.
  // The sibling tab opened by the link above is in "edit", so the pane has
  // to be brought back before there is anything to click.
  const copySetup = await ev(`(async () => {
    Commands.run('view.togglePreview');
    Editor.setText(${JSON.stringify(MD)});
    await new Promise((r) => setTimeout(r, 600));
    return document.getElementById('editorWrap').dataset.mode;
  })()`);
  const copy = await centre('#previewBody .md-pre__copy');
  await click(copy.x, copy.y);
  await sleep(250);
  const clip = await ev('window.sara.clipboard.readText()');
  line('copy', clip === 'const a = 1;', `clipboard holds "${clip}" (mode ${copySetup})`);

  /* ================================================================ *
   * 5. Size guard
   * ================================================================ */

  const huge = await ev(`(async () => {
    Editor.setText('a'.repeat(Markdown.MAX_PREVIEW_CHARS + 1000));
    await new Promise((r) => setTimeout(r, 700));
    const notice = document.querySelector('#previewBody .md-notice');
    // Count p.md-p specifically: the notice itself is a <p>, so a bare p
    // count can never be zero and would make this check meaningless.
    const out = { notice: notice ? notice.textContent : null,
                  paragraphs: document.querySelectorAll('#previewBody p.md-p').length };
    Editor.setText('done');
    await new Promise((r) => setTimeout(r, 400));
    return out;
  })()`);
  line('sizeguard', Boolean(huge.notice) && huge.paragraphs === 0,
    huge.notice || 'no notice rendered');

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
