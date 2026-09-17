'use strict';

/**
 * Boot check for the shell "Open with" plumbing.
 *
 * Loads the real renderer against the preview server's mock bridge and drives it
 * exactly the way the main process would: publish a path on the open-paths
 * channel, then assert a tab appears for it.
 *
 * This is the assertion that matters. The launch path can be parsed perfectly in
 * main.js and still do nothing on screen if the handshake is ordered wrongly -
 * `notifyReady()` before the listener is bound silently drops the file.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const URL = process.env.URL || 'http://127.0.0.1:5199/';
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9455);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

const chromePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chromePath) {
  console.error('No Chromium found. Set CHROME_PATH.');
  process.exit(2);
}

const failures = [];
const check = (label, ok, detail) => {
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${ok || !detail ? '' : ` -> ${detail}`}`);
  if (!ok) failures.push(label);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'saratext-verify-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--use-gl=swiftshader',
    '--window-size=1280,900',
    URL,
  ], { stdio: 'ignore' });

  const cleanup = () => { try { chrome.kill(); } catch { /* gone */ } };

  try {
    // ---- connect to the page target --------------------------------
    let target = null;
    for (let i = 0; i < 60 && !target; i += 1) {
      await sleep(500);
      try {
        const list = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`).then((r) => r.json());
        target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      } catch { /* not up yet */ }
    }
    if (!target) throw new Error('CDP target never appeared');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('ws failed')), { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const errors = [];

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        errors.push(msg.params.exceptionDetails.text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
      }
    });

    const send = (method, params = {}) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout: ${method}`));
        }, 15000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    };

    const ev = (expression) => send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    }).then((r) => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
      return r.result.value;
    });

    await send('Runtime.enable');
    await send('Page.enable');

    // ---- 1. the app booted in the first place ----------------------
    let booted = false;
    for (let i = 0; i < 40 && !booted; i += 1) {
      await sleep(250);
      booted = await ev(`!!window.sara && !!document.querySelector('#editor')`);
    }
    check('app booted (window.sara + editor present)', booted);

    const readyCalls = await ev('window.__notifyReadyCalls ?? -1');
    check('boot reached notifyReady()', readyCalls > 0, `calls=${readyCalls}`);

    // ---- 2. a shell-supplied file opens as a tab -------------------
    await ev(`(() => {
      window.__mockFiles.set('C:\\\\shell\\\\note.txt', 'hello from explorer');
      window.__emitOpenPaths(['C:\\\\shell\\\\note.txt']);
      return true;
    })()`);

    let tabText = '';
    for (let i = 0; i < 40; i += 1) {
      await sleep(250);
      tabText = await ev(`document.querySelector('#tabs')?.innerText || ''`);
      if (tabText.includes('note.txt')) break;
    }
    check('file from the shell channel opened a tab', tabText.includes('note.txt'), tabText.trim());

    const editorText = await ev(`document.querySelector('#editor')?.value || ''`);
    check(
      'tab content is the file content',
      editorText.includes('hello from explorer'),
      JSON.stringify(editorText.slice(0, 60)),
    );

    check('no console errors', errors.length === 0, errors.join(' | '));

    ws.close();
  } finally {
    cleanup();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked */ }
  }

  console.log(failures.length ? `\n${failures.length} check(s) FAILED` : '\nall checks passed');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('harness error:', err.message);
  process.exit(2);
});
