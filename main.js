'use strict';

/**
 * SaraText - main process
 *
 * Responsibilities:
 *  - window lifecycle + geometry persistence
 *  - filesystem access (all fs work happens here, never in the renderer)
 *  - native open/save dialogs
 *  - global (system-wide) hotkey
 *  - draft autosave storage in userData
 *  - unsaved-changes guard on close
 */

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  globalShortcut,
  shell,
  nativeTheme,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const isPackaged = app.isPackaged;
const isDev = process.argv.includes('--dev');

/**
 * Software-rendering fallback.
 *
 * Headless sessions, some VMs and remote desktops have no usable GPU, and
 * Chromium aborts with "GPU process isn't usable. Goodbye." rather than
 * degrading, which makes the app unlaunchable there.
 *
 * Pass --force-gpu to keep hardware acceleration unconditionally.
 */
const SOFTWARE_FLAG = '--saratext-software-gl';

/**
 * Application arguments, without the executable / script path.
 *
 * In development `process.argv` is `[electron, ., ...flags]`; in a packaged app
 * it is just `[SaraText.exe, ...flags]`. The offset differs, so tests against
 * the raw argv must go through this list.
 */
const APP_ARGS = process.argv.slice(isPackaged ? 1 : 2);
const hasFlag = (name) => APP_ARGS.includes(name);

/**
 * Switches that carry a value separately (`--flag value`) rather than inline
 * (`--flag=value`), so their value must not be mistaken for a bare argument.
 */
const VALUE_FLAGS = new Set(['--user-data-dir', '--app-user-model-id', '--lang', '--log-file']);

/**
 * Paths passed on the command line - this is how Windows hands us the file
 * when the user picks "Open with > SaraText" or drops files onto the exe.
 *
 * Chromium's own switches (`--type=gpu-process` and friends) are filtered out;
 * anything else that is not a known flag is treated as a path.
 */
function collectFileArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      // Bare `--foo bar` form: skip the value too, it is not a path.
      if (!arg.includes('=') && VALUE_FLAGS.has(arg)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

// Paths only exist in the argv of a literal (re)launch, which is exactly when
// they matter. The GPU fallback relaunch must not re-open them, so it reads
// this snapshot instead of re-parsing `process.argv`.
const OPEN_FILES = collectFileArgs(APP_ARGS);

/** Apply the software-rendering switches. Safe to call before app.whenReady(). */
function enableSoftwareRendering() {
  // `disable-gpu` alone is not enough: Chromium still initialises a GL
  // implementation and aborts with "GPU process isn't usable. Goodbye." when
  // that fails. Pointing GL at SwiftShader (the bundled CPU rasterizer) is what
  // actually keeps the app alive on machines with no usable GPU.
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-gpu-rasterization');
  app.commandLine.appendSwitch('use-gl', 'swiftshader');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  // Keeping the GPU work in the main process stops Chromium from spawning a
  // separate GPU process that can fail on its own and take the app down.
  app.commandLine.appendSwitch('in-process-gpu');
}

/**
 * Rendering setup.
 *
 * Guessing up front whether a GPU is usable is unreliable: the same machine can
 * behave differently between a dev launch and a packaged launch, and some GPU
 * failures only surface after Chromium has started. So we combine two tactics:
 *
 *   1. Honour an explicit request, or an environment known to have no GPU.
 *   2. Otherwise start optimistically and let `child-process-gone` catch a
 *      failing GPU, then relaunch once in software mode.
 */
function configureRendering() {
  // Explicit requests always win.
  if (hasFlag('--force-gpu')) return;
  if (APP_ARGS.some((a) => a.startsWith('--disable-gpu') || a.startsWith('--use-gl'))) return;

  // Relaunched by our own fallback: go straight to software rendering.
  if (hasFlag(SOFTWARE_FLAG)) {
    enableSoftwareRendering();
    return;
  }

  // Environments known up front to have no usable GPU.
  const knownHeadless =
    process.env.SARATEXT_SOFTWARE_GL === '1' ||
    process.env.ELECTRON_RUN_AS_NODE === '1' ||
    process.env.DISPLAY === '' ||
    (process.platform === 'win32' && !process.env.SESSIONNAME && !process.env.USERNAME);

  if (knownHeadless) enableSoftwareRendering();
}

/**
 * Reactive fallback.
 *
 * Chromium reports each GPU-process death before it finally gives up. If that
 * happens we restart once with software rendering. The SOFTWARE_FLAG marker
 * makes the next launch take the software path, so this cannot loop.
 */
let gpuRestartAttempted = false;

function installGpuFallback() {
  if (hasFlag('--force-gpu') || hasFlag(SOFTWARE_FLAG)) return;
  if (APP_ARGS.some((a) => a.startsWith('--disable-gpu') || a.startsWith('--use-gl'))) return;

  app.on('child-process-gone', (_event, details) => {
    if (!details || details.type !== 'GPU') return;
    if (gpuRestartAttempted) return;
    // Chromium kills the GPU process a few times before aborting; only the
    // repeated failures indicate a GPU we cannot use.
    if (details.reason === 'killed' && details.exitCode === 0) return;

    gpuRestartAttempted = true;

    // Relaunch with the marker appended. `args` replaces the argument list, so
    // the executable path is supplied separately by Electron itself.
    app.relaunch({ args: [...APP_ARGS.filter((a) => a !== SOFTWARE_FLAG), SOFTWARE_FLAG] });
    app.exit(0);
  });
}

configureRendering();
installGpuFallback();

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

const USER_DIR = app.getPath('userData');
const STATE_FILE = path.join(USER_DIR, 'window-state.json');
const DRAFTS_DIR = path.join(USER_DIR, 'drafts');
const SESSION_FILE = path.join(USER_DIR, 'session.json');

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists */
  }
}

/* ------------------------------------------------------------------ *
 * Simple JSON store
 * ------------------------------------------------------------------ */

function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, data) {
  try {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[saratext] failed to persist', file, err);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Window state
 * ------------------------------------------------------------------ */

const DEFAULT_STATE = { width: 1040, height: 720, x: undefined, y: undefined, maximized: false };

function loadWindowState() {
  const saved = readJSON(STATE_FILE, {}) || {};
  const state = { ...DEFAULT_STATE, ...saved };

  // Guard against a window restored onto a monitor that no longer exists.
  if (typeof state.x === 'number' && typeof state.y === 'number') {
    const { screen } = require('electron');
    const visible = screen.getAllDisplays().some((display) => {
      const b = display.workArea;
      return (
        state.x < b.x + b.width &&
        state.x + state.width > b.x &&
        state.y < b.y + b.height &&
        state.y + state.height > b.y
      );
    });
    if (!visible) {
      state.x = undefined;
      state.y = undefined;
    }
  }
  return state;
}

let win = null;
let forceQuit = false;

/**
 * Absolute paths that should be opened as soon as the renderer is ready to
 * receive them. The renderer is not listening yet while the window is being
 * created, so shell-open requests are queued here and flushed on the
 * `file:ready` handshake (and on `second-instance`, which can arrive at any
 * time).
 */
const pendingOpen = [];
let rendererReady = false;

/** Turn a raw command-line / `%1` argument into something we can open. */
function toAbsolutePath(value) {
  if (typeof value !== 'string' || !value) return null;
  const trimmed = value.trim().replace(/^"(.*)"$/, '$1');
  if (!trimmed) return null;
  // A URL is not a file. `shell.openExternal` already handles links.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  return path.resolve(trimmed);
}

function queueOpenPaths(values) {
  for (const value of values) {
    const abs = toAbsolutePath(value);
    // Most editors (`edit`, `notepad`) are handed a placeholder path when
    // launched from a console. Dropping it is the conventional behaviour.
    if (!abs || /\\edit$/i.test(abs)) continue;
    if (!pendingOpen.includes(abs)) pendingOpen.push(abs);
  }
}

function flushPendingOpen() {
  if (!rendererReady || !win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  if (!pendingOpen.length) return;
  const paths = pendingOpen.splice(0, pendingOpen.length);
  win.webContents.send('app:open-paths', paths);
}

function persistWindowState() {
  if (!win || win.isDestroyed()) return;
  const maximized = win.isMaximized();
  const bounds = maximized ? (win.__restoreBounds || win.getBounds()) : win.getBounds();
  writeJSON(STATE_FILE, {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized,
  });
}

/* ------------------------------------------------------------------ *
 * Window creation
 * ------------------------------------------------------------------ */

function createWindow() {
  const state = loadWindowState();

  win = new BrowserWindow({
    width: Math.max(360, state.width),
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 360,
    minHeight: 280,
    frame: false,
    show: false,
    backgroundColor: '#1b1d23',
    title: 'SaraText',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
    },
  });

  // We ship a custom in-app menu bar, so remove the native one entirely.
  win.setMenuBarVisibility(false);
  win.removeMenu();

  if (state.maximized) win.maximize();

  win.once('ready-to-show', () => {
    win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Remember the pre-maximize bounds so restoring the file is sane.
  win.on('maximize', () => { /* bounds captured on unmaximize */ });
  win.on('unmaximize', () => { win.__restoreBounds = null; });
  win.on('resize', () => persistWindowState());
  win.on('move', () => persistWindowState());
  win.on('close', (event) => {
    persistWindowState();

    if (forceQuit) return;

    // If the renderer is gone we cannot ask it anything - just close.
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;

    event.preventDefault();
    win.webContents.send('app:before-close');
  });

  win.on('closed', () => {
    win = null;
    rendererReady = false;
    // Nothing will consume the queue now; the next window gets a clean slate.
    pendingOpen.length = 0;
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // External links open in the default browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The app draws its own context menu (renderer/contextmenu.js) over the
  // command registry, so Chromium's default one - with its Back / Reload /
  // Save image as… entries - must never appear. Returning an empty menu
  // cancels it; `contextmenu` handling in the renderer is what actually
  // gates which of *our* menus opens.
  win.webContents.on('context-menu', () => {});
}

/* ------------------------------------------------------------------ *
 * Global hotkey
 * ------------------------------------------------------------------ */

let registeredHotkey = null;

function applyGlobalHotkey(accelerator) {
  if (registeredHotkey) {
    globalShortcut.unregister(registeredHotkey);
    registeredHotkey = null;
  }
  if (!accelerator) return { ok: true, accelerator: null };

  try {
    const ok = globalShortcut.register(accelerator, () => {
      if (!win || win.isDestroyed()) {
        createWindow();
        return;
      }
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.show();
      win.focus();
      win.webContents.send('app:focus-editor');
    });
    registeredHotkey = ok ? accelerator : null;
    return { ok, accelerator: registeredHotkey };
  } catch (err) {
    return { ok: false, accelerator: null, error: String(err && err.message) };
  }
}

/* ------------------------------------------------------------------ *
 * File helpers
 * ------------------------------------------------------------------ */

const TEXT_FILTERS = [
  { name: 'Text', extensions: ['txt', 'md', 'markdown', 'log', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'ini', 'csv'] },
  { name: 'All Files', extensions: ['*'] },
];

/** Write via a temp file + rename so an interrupted save cannot truncate the target. */
async function atomicWrite(target, contents, encoding = 'utf8') {
  const dir = path.dirname(target);
  const tmp = path.join(dir, `.${path.basename(target)}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, contents, encoding);
  try {
    await fsp.rename(tmp, target);
  } catch (err) {
    // Windows can refuse a rename when the destination is locked; fall back.
    await fsp.copyFile(tmp, target);
    await fsp.unlink(tmp).catch(() => {});
    if (err && err.code !== 'EEXIST' && err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
  }
  return true;
}

function detectEncoding(buffer) {
  // UTF-8 BOM
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { encoding: 'utf8', bom: true };
  }
  // UTF-16 LE / BE BOM
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { encoding: 'utf16le', bom: true };
  }

  // Heuristic: if the bytes are not valid UTF-8 there is a good chance this
  // is a legacy single-byte file. We still read as utf8 but flag it so the
  // UI can warn rather than silently showing replacement characters.
  const utf8 = buffer.toString('utf8');
  const lossy = utf8.includes('\uFFFD');
  return { encoding: 'utf8', bom: false, lossy };
}

async function readTextFile(filePath) {
  const buffer = await fsp.readFile(filePath);
  const { encoding, bom, lossy } = detectEncoding(buffer);
  let text = buffer.toString(encoding === 'utf16le' ? 'utf16le' : 'utf8');
  if (bom) text = text.replace(/^\uFEFF/, '');
  const stats = await fsp.stat(filePath);
  return {
    text,
    encoding,
    bom,
    lossy: Boolean(lossy),
    size: stats.size,
    mtime: stats.mtimeMs,
  };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

function registerIPC() {
  /** Renderer asks to open one or more files. */
  ipcMain.handle('dialog:open', async (_e, opts = {}) => {
    const properties = opts.multiple
      ? ['openFile', 'multiSelections']
      : ['openFile'];

    if (opts.path) {
      // Caller already knows the path (drag/drop or recent files) - no dialog.
      try {
        return { ok: true, files: [await readTextFile(opts.path)] };
      } catch (err) {
        return { ok: false, error: err.message, path: opts.path };
      }
    }

    // A folder open is used by the "open folder" flow.
    const result = await dialog.showOpenDialog(win, {
      title: opts.title || 'Open',
      defaultPath: opts.defaultPath,
      filters: TEXT_FILTERS,
      properties,
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };

    const files = [];
    const errors = [];
    for (const filePath of result.filePaths) {
      try {
        const data = await readTextFile(filePath);
        files.push({ ...data, path: filePath });
      } catch (err) {
        errors.push({ path: filePath, error: err.message });
      }
    }
    return { ok: true, files, errors };
  });

  /** Read a single known path (recent files, drag & drop, session restore). */
  ipcMain.handle('file:read', async (_e, filePath) => {
    try {
      const data = await readTextFile(filePath);
      return { ok: true, file: { ...data, path: filePath } };
    } catch (err) {
      return { ok: false, error: err.message, path: filePath };
    }
  });

  /** Save to an existing path, or prompt for one when `forceDialog` is set. */
  ipcMain.handle('file:save', async (_e, payload = {}) => {
    const { filePath, contents, forceDialog, suggestedName, encoding } = payload;

    if (!filePath || forceDialog) {
      const result = await dialog.showSaveDialog(win, {
        title: forceDialog ? 'Save As' : 'Save',
        defaultPath: filePath || suggestedName || 'Untitled.txt',
        filters: TEXT_FILTERS,
      });
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      try {
        await atomicWrite(result.filePath, contents, encoding === 'utf16le' ? 'utf16le' : 'utf8');
        return { ok: true, path: result.filePath };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    try {
      await atomicWrite(filePath, contents, encoding === 'utf16le' ? 'utf16le' : 'utf8');
      return { ok: true, path: filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  /** Confirmations driven from the renderer's unsaved-changes guard. */
  ipcMain.handle('dialog:confirm', async (_e, opts = {}) => {
    const { message, detail, buttons = ['Save', "Don't Save", 'Cancel'], defaultId = 0, cancelId = 2 } = opts;
    const result = await dialog.showMessageBox(win, {
      type: opts.type || 'warning',
      message,
      detail,
      buttons,
      defaultId,
      cancelId,
      noLink: true,
    });
    return { response: result.response };
  });

  ipcMain.handle('dialog:message', async (_e, opts = {}) => {
    await dialog.showMessageBox(win, {
      type: opts.type || 'info',
      message: opts.message || '',
      detail: opts.detail,
      buttons: ['OK'],
      noLink: true,
    });
    return { ok: true };
  });

  /**
   * Shell integration.
   *
   * Windows starts a *new* process when the user picks "Open with > SaraText"
   * or drops a file on the executable; `requestSingleInstanceLock` makes the
   * running copy the one that survives, and the extra args arrive on
   * `second-instance`. This handshake gives the renderer the paths that
   * preceded it, so launching on a file opens it on the very first paint.
   */
  ipcMain.on('file:ready', () => {
    rendererReady = true;
    flushPendingOpen();
  });

  /** The renderer finished its close handshake. */
  ipcMain.on('app:close-confirmed', (_e, shouldClose) => {    if (!shouldClose) return;
    forceQuit = true;
    if (win && !win.isDestroyed()) win.close();
    app.quit();
  });

  /** Draft autosave lives under userData/drafts. */
  ipcMain.handle('draft:write', async (_e, { id, payload }) => {
    ensureDir(DRAFTS_DIR);
    const ok = writeJSON(path.join(DRAFTS_DIR, `${id}.json`), payload);
    return { ok };
  });

  ipcMain.handle('draft:list', async () => {
    ensureDir(DRAFTS_DIR);
    try {
      const names = await fsp.readdir(DRAFTS_DIR);
      return { ok: true, ids: names.filter((n) => n.endsWith('.json')).map((n) => n.replace(/\.json$/, '')) };
    } catch (err) {
      return { ok: false, error: err.message, ids: [] };
    }
  });

  ipcMain.handle('draft:read', async (_e, id) => {
    const data = readJSON(path.join(DRAFTS_DIR, `${id}.json`), null);
    return { ok: Boolean(data), draft: data };
  });

  ipcMain.handle('draft:delete', async (_e, id) => {
    try {
      await fsp.unlink(path.join(DRAFTS_DIR, `${id}.json`));
      return { ok: true };
    } catch {
      return { ok: true };
    }
  });

  /** Session (open tabs, active tab) so the app reopens where you left off. */
  ipcMain.handle('session:save', async (_e, data) => {
    return { ok: writeJSON(SESSION_FILE, data) };
  });

  ipcMain.handle('session:load', async () => {
    return { ok: true, data: readJSON(SESSION_FILE, null) };
  });

  /** Global hotkey control. */
  ipcMain.handle('hotkey:set', async (_e, accelerator) => applyGlobalHotkey(accelerator));

  /** Window controls for the custom title bar. */
  ipcMain.handle('window:action', async (_e, action) => {
    if (!win || win.isDestroyed()) return { ok: false };
    switch (action) {
      case 'minimize': win.minimize(); break;
      case 'maximize': win.isMaximized() ? win.unmaximize() : win.maximize(); break;
      case 'fullscreen-toggle': win.setFullScreen(!win.isFullScreen()); break;
      case 'always-on-top': win.setAlwaysOnTop(!win.isAlwaysOnTop()); break;
      case 'close': win.close(); break;
      case 'size-small':
      case 'size-medium':
      case 'size-large': {
        const sizes = {
          'size-small': [350, 280],
          'size-medium': [480, 350],
          'size-large': [700, 600],
        };
        if (win.isFullScreen()) win.setFullScreen(false);
        if (win.isMaximized()) win.unmaximize();
        win.setSize(...sizes[action]);
        break;
      }
      default: break;
    }
    return {
      ok: true,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      alwaysOnTop: win.isAlwaysOnTop(),
    };
  });

  ipcMain.handle('window:query', async () => {
    if (!win || win.isDestroyed()) return { ok: false };
    return {
      ok: true,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      alwaysOnTop: win.isAlwaysOnTop(),
    };
  });

  ipcMain.handle('file:exists', async (_e, filePath) => {
    try {
      await fsp.access(filePath);
      return { ok: true, exists: true };
    } catch {
      return { ok: true, exists: false };
    }
  });

  ipcMain.handle('file:reveal', async (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return { ok: true };
  });

  /**
   * Open a link from the markdown preview in the default browser.
   *
   * The renderer already routes only http(s) / mailto here, but the check is
   * repeated on this side of the boundary: `shell.openExternal` hands the
   * string to the OS, so an unvetted value is a command-execution surface.
   */
  ipcMain.handle('shell:open-external', async (_e, url) => {
    const target = String(url || '').trim();
    if (!/^https?:\/\/|^mailto:/i.test(target)) {
      return { ok: false, error: 'unsupported scheme' };
    }
    try {
      await shell.openExternal(target);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('app:info', async () => ({
    ok: true,
    version: app.getVersion(),
    name: 'SaraText',
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
    platform: process.platform,
    userDir: USER_DIR,
  }));
}

/* ------------------------------------------------------------------ *
 * App lifecycle
 * ------------------------------------------------------------------ */

// Anything the app was launched with (shell "Open with", drag-onto-exe).
queueOpenPaths(OPEN_FILES);

// Single instance: a second launch focuses the existing window instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // macOS-style convention: only arguments after `--` belong to the app.
    const own = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : argv.slice(1);
    queueOpenPaths(collectFileArgs(own));

    if (!win || win.isDestroyed()) {
      createWindow();
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    flushPendingOpen();
  });

  // macOS delivers file opens through the app, not argv.
  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    queueOpenPaths([filePath]);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    flushPendingOpen();
  });

  app.whenReady().then(() => {
    ensureDir(DRAFTS_DIR);
    registerIPC();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}

// Keep a stable dark native chrome (dialogs) to match the app theme.
nativeTheme.themeSource = 'dark';
