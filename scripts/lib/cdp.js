'use strict';

/**
 * Shared headless-Chromium-over-CDP client for the renderer regression
 * tests. Verification only - not shipped.
 *
 * Why hand-rolled: `agent-browser` does not support Windows, and pulling in
 * Playwright/Puppeteer for three scripts is not worth the dependency. Node 22
 * ships a browser-compatible global `WebSocket`, which is all CDP needs.
 *
 * Why headless Chrome instead of Electron: this sandbox has no usable GPU and
 * injects a NODE_OPTIONS shim into every Node process, so any Electron launch
 * dies at the GPU stage. Chromium plus `scripts/preview-server.js` (which
 * stubs `window.sara`) exercises the real renderer, which is where the UI
 * logic under test lives.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.CHROME_PATH || '',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launch headless Chromium against the preview server and connect to it. */
async function launch({ port = 5199, debugPort = 9401, windowSize = '1400,940', label = 'test' } = {}) {
  const chromePath = CHROME_CANDIDATES.find((p) => p && fs.existsSync(p));
  if (!chromePath) throw new Error('No Chromium binary found; set CHROME_PATH');

  const chrome = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), `saratext-${label}-`))}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--use-gl=swiftshader',
    `--window-size=${windowSize}`,
    `http://127.0.0.1:${port}/`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  const httpJson = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: debugPort, path: p }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });

  let target;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await httpJson('/json/list');
      target = list.find((t) => t.type === 'page' && t.url.startsWith('http'));
      if (target) break;
    } catch { /* not ready yet */ }
    await sleep(250);
  }
  if (!target) throw new Error('DevTools target never appeared');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });

  let id = 0;
  const pending = new Map();
  const consoleErrors = [];

  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      return;
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      consoleErrors.push(d.exception ? (d.exception.description || d.exception.value) : d.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, { resolve, reject });
    ws.send(JSON.stringify({ id: i, method, params }));
    setTimeout(() => {
      if (pending.has(i)) { pending.delete(i); reject(new Error(`timeout: ${method}`)); }
    }, 15000);
  });

  const ev = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    .then((r) => {
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(d.exception ? (d.exception.description || d.exception.value) : d.text);
      }
      return r.result.value;
    });

  /** A genuine left press/release pair at viewport coordinates. */
  async function click(x, y, button = 'left') {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
    await sleep(50);
    const mask = button === 'right' ? 2 : 1;
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: mask, clickCount: 1 });
    await sleep(50);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: 1 });
    await sleep(240);
  }

  /** A genuine right-click: which is what opens the context menu. */
  const rightClick = (x, y) => click(x, y, 'right');

  const move = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
    await sleep(160);
  };

  const centre = (sel) => ev(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);

  await send('Runtime.enable');

  return {
    send, ev, click, rightClick, move, centre,
    consoleErrors,
    async waitForBoot(ms = 2600) { await sleep(ms); },
    async close() {
      try { ws.close(); } catch { /* already gone */ }
      try { chrome.kill(); } catch { /* already gone */ }
    },
  };
}

module.exports = { launch, sleep, CHROME_CANDIDATES };
