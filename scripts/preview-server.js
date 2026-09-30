'use strict';

/**
 * Static server for verifying the renderer in a browser.
 *
 * The Electron app loads from file://, but a normal browser can't reach
 * that from another origin, so this serves src/ over HTTP. It also stubs
 * `window.sara` with an in-memory implementation so the renderer boots
 * without the Electron preload present. Verification only - not shipped.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'src');
const PORT = Number(process.env.PORT || 5199);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/**
 * Injected before any app script: a fake preload bridge.
 *
 * NOTE: this is JavaScript inside a template literal, so a backslash in the
 * emitted code needs to be written twice, and a regex literal containing one
 * is a trap - `\\` collapses to `\` and the emitted pattern is garbage, which
 * fails at parse time in the page rather than here. `node --check` on this
 * file will not catch that, because it checks the source, not the string.
 * Prefer string methods to regexes in here.
 */
const BRIDGE = `
(function () {
  const files = new Map();
  window.__mockFiles = files;

  const noop = async () => ({ ok: true });
  let draftSeq = 0;

  /**
   * Event subscriptions are real here, not stubs - a stubbed no-op listener
   * would let the renderer look correct while silently dropping every event.
   * window.__emit* lets a verification script drive them from the outside.
   */
  const listeners = new Map();
  const on = (channel) => (cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel).delete(cb);
  };
  window.__emit = (channel, ...args) => {
    for (const cb of listeners.get(channel) || []) cb(...args);
    return (listeners.get(channel) || new Set()).size;
  };
  window.__emitOpenPaths = (paths) => window.__emit('app:open-paths', paths);
  window.__notifyReadyCalls = 0;
  /** Every URL the preview handed to the shell, in order. */
  window.__external = [];

  window.sara = {
    openFiles: async () => ({ ok: false, canceled: true }),
    /**
     * Look the path up exactly first, then with separators normalised: the
     * renderer resolves markdown-relative links to backslash paths, while a
     * test seeds them with forward slashes. The real fs module takes both.
     * (No regex literals in this bridge - see the note above BRIDGE.)
     */
    readFile: async (p) => {
      const key = String(p);
      const norm = (s) => String(s).split('\\\\').join('/');
      const hit = files.has(key) ? key : [...files.keys()].find((k) => norm(k) === norm(key));
      if (hit === undefined) return { ok: false, error: 'not found', path: key };
      const text = files.get(hit);
      return { ok: true, file: { path: key, text, encoding: 'utf8', bom: false, size: text.length } };
    },
    saveFile: async (payload) => ({ ok: true, path: payload.filePath || 'C:/mock/Untitled.txt' }),
    fileExists: async () => ({ ok: true, exists: true }),
    revealFile: async () => ({ ok: true }),
    openExternal: async (url) => { window.__external.push(String(url)); return { ok: true }; },
    confirm: async () => ({ response: 1 }),
    message: async () => ({ ok: true }),
    writeDraft: async (id, payload) => { try { localStorage.setItem('draft.' + id, JSON.stringify(payload)); } catch (e) {} return { ok: true }; },
    listDrafts: async () => ({ ok: true, ids: Object.keys(localStorage).filter(k => k.startsWith('draft.')).map(k => k.slice(6)) }),
    readDraft: async (id) => { try { return { ok: true, draft: JSON.parse(localStorage.getItem('draft.' + id)) }; } catch (e) { return { ok: false }; } },
    deleteDraft: async (id) => { localStorage.removeItem('draft.' + id); return { ok: true }; },
    saveSession: async (d) => { try { localStorage.setItem('session.mock', JSON.stringify(d)); } catch (e) {} return { ok: true }; },
    loadSession: async () => { try { return { ok: true, data: JSON.parse(localStorage.getItem('session.mock')) }; } catch (e) { return { ok: true, data: null }; } },
    windowAction: async () => ({ ok: true, maximized: false, fullscreen: false, alwaysOnTop: false }),
    windowState: async () => ({ ok: true, maximized: false, fullscreen: false, alwaysOnTop: false }),
    setGlobalHotkey: async () => ({ ok: true }),
    appInfo: async () => ({ ok: true, version: '1.0.0', electron: 'mock', node: 'mock', chrome: 'mock', platform: 'win32', userDir: 'C:/mock' }),
    onBeforeClose: on('app:before-close'),
    onFocusEditor: on('app:focus-editor'),
    onOpenPaths: on('app:open-paths'),
    notifyReady: () => { window.__notifyReadyCalls += 1; },
    closeConfirmed: () => {},
    pathForFile: () => null,
    // A real store, not a stub: cut/copy/paste are covered by
    // scripts/test-context-font.js, and a no-op here would let a broken
    // clipboard path look correct.
    clipboard: (() => {
      let buf = '';
      return { readText: () => buf, writeText: (t) => { buf = String(t == null ? '' : t); } };
    })(),
  };

  // The renderer is opened directly rather than through the session restore
  // path, so seed one empty document to exercise the normal editor state.
  window.__seed = files;
})();
`;

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  // Virtual routes must be handled before the filesystem lookup below.
  if (urlPath === '/__mock-bridge.js') {
    res.writeHead(200, { 'Content-Type': TYPES['.js'] });
    res.end(BRIDGE);
    return;
  }

  const full = path.join(ROOT, urlPath);
  if (!full.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    res.end('not found: ' + urlPath);
    return;
  }

  const ext = path.extname(full).toLowerCase();
  const body = fs.readFileSync(full);

  if (urlPath === '/index.html') {
    // Inject the bridge as an external script: the page's CSP allows
    // 'self' only, so an inline script tag would be blocked.
    const html = body.toString('utf8').replace(
      '<script src="renderer/commands.js"></script>',
      '<script src="/__mock-bridge.js"></script>\n  <script src="renderer/commands.js"></script>'
    );
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`SaraText renderer preview on http://127.0.0.1:${PORT}`);
});
