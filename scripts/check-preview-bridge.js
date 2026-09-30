'use strict';

/**
 * Verifies the mock bridge that scripts/preview-server.js injects.
 *
 * The bridge is JavaScript embedded in a template literal, so the source text
 * and the string the page receives are not the same thing - a stray backslash
 * or backtick produces a script that fails at parse time in the browser while
 * `node --check` on the server file stays green. This fetches the emitted
 * string over HTTP and parses it, which is the only check that catches that.
 *
 * Usage:  node scripts/check-preview-bridge.js
 */

const { spawn } = require('node:child_process');
const http = require('node:http');
const vm = require('node:vm');
const path = require('node:path');

const PORT = Number(process.env.PORT || 5211);

const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve(body));
  }).on('error', reject);
});

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, 'preview-server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let bridge = null;
    for (let i = 0; i < 30 && bridge === null; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { bridge = await get(`http://127.0.0.1:${PORT}/__mock-bridge.js`); } catch { /* not up yet */ }
    }
    if (!bridge) throw new Error('the preview server never answered');

    new vm.Script(bridge);
    console.log(`bridge OK  ${bridge.length} bytes, parses as JavaScript`);

    // Exercise it the way the page will, so a runtime failure is caught too.
    const sandbox = {
      window: {},
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, keys: () => [] },
      Object, JSON, String, Number, Boolean, Array, Map, Set, Promise, Error, Date, console,
    };
    sandbox.window.localStorage = sandbox.localStorage;
    vm.createContext(sandbox);
    vm.runInContext(bridge, sandbox);

    const sara = sandbox.window.sara;
    const missing = ['readFile', 'saveFile', 'openExternal', 'clipboard', 'onOpenPaths', 'notifyReady']
      .filter((k) => !sara || sara[k] === undefined);
    if (missing.length) throw new Error(`bridge is missing: ${missing.join(', ')}`);

    // Separator-insensitive lookup, which is what the markdown link test needs.
    sandbox.window.__mockFiles.set('C:/notes/sibling.md', 'x');
    const viaBackslash = await sara.readFile('C:\\notes\\sibling.md');
    const viaForward = await sara.readFile('C:/notes/sibling.md');
    if (!viaBackslash.ok || !viaForward.ok) {
      throw new Error(`readFile did not normalise separators (\\: ${viaBackslash.ok}, /: ${viaForward.ok})`);
    }
    await sara.openExternal('https://example.com');
    if (sandbox.window.__external[0] !== 'https://example.com') {
      throw new Error('openExternal did not record the URL');
    }

    console.log('bridge OK  readFile normalises separators, openExternal records URLs');
  } finally {
    server.kill();
  }
})().catch((e) => {
  console.error(`bridge FAILED: ${e.message}`);
  process.exit(1);
});
