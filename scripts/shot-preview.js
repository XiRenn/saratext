'use strict';

/**
 * Screenshot helper: renders the preview in headless Chromium and writes
 * PNGs to .shots/. Verification only - not shipped.
 *
 * Usage:  node scripts/shot-preview.js
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { launch, sleep } = require('./lib/cdp');

const PORT = Number(process.env.PORT || 5212);
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9412);
const OUT = path.join(__dirname, '..', '.shots');

const MD = [
  '# SaraText',
  '',
  'A **markdown preview** for the notepad: *inline emphasis*, `code spans`,',
  '~~strikethrough~~ and [links](https://example.com) all render in place.',
  '',
  '## Lists',
  '',
  '- Tight list items',
  '- With a nested level',
  '  - like this one',
  '- [x] a completed task',
  '- [ ] and an open one',
  '',
  '1. Ordered items',
  '2. Keep their numbering',
  '',
  '> Blockquotes are indented with a rule, and can hold **emphasis** too.',
  '',
  '```js',
  'const preview = Markdown.render(Editor.getText());',
  'pane.replaceChildren(preview);',
  '```',
  '',
  '| Layer | Technology | Notes |',
  '| ----- | ---------: | :---- |',
  '| Editor | textarea | untouched |',
  '| Parser | markdown.js | DOM only |',
  '| Pane | preview.js | read-only |',
  '',
  '---',
  '',
  'Setext headings work too',
  '========================',
  '',
  'And an image becomes a placeholder: ![](diagram.png)',
].join('\n');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, 'preview-server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await sleep(800);

  const cdp = await launch({ port: PORT, debugPort: DEBUG_PORT, windowSize: '1400,900', label: 'shot' });
  await sleep(2600);
  await cdp.send('Page.enable');

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(data, 'base64'));
    console.log('wrote', path.join('.shots', name));
  };

  await cdp.ev(`(async () => {
    Editor.setText(${JSON.stringify(MD)});
    await new Promise((r) => setTimeout(r, 400));
    Commands.run('view.togglePreview');
    await new Promise((r) => setTimeout(r, 400));
    return document.getElementById('editorWrap').dataset.mode;
  })()`);
  await shot('preview-split-dark.png');

  await cdp.ev(`(async () => {
    Commands.run('view.previewOnly');
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);
  await shot('preview-only-dark.png');

  await cdp.ev(`(async () => {
    Commands.run('view.toggleTheme');
    await new Promise((r) => setTimeout(r, 300));
    return true;
  })()`);
  await shot('preview-only-light.png');

  // Scrolled to the end, to check the parts the first screenful cuts off.
  await cdp.ev(`(async () => {
    const body = document.getElementById('previewBody');
    body.scrollTop = body.scrollHeight;
    await new Promise((r) => setTimeout(r, 300));
    return body.scrollTop;
  })()`);
  await shot('preview-bottom-light.png');

  const errors = [...new Set(cdp.consoleErrors)];
  console.log('console errors:', errors.length);
  for (const e of errors) console.log('  -', String(e).split('\n')[0]);

  await cdp.close();
  server.kill();
})().catch((e) => { console.error('shot failed:', e.message); process.exit(1); });
