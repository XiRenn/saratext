# SaraText

A fast, minimal notepad for Windows, built with Electron. Dark and light themes,
multi-document tabs, find & replace, autosave, and a full keyboard shortcut set.

```bash
npm install
npm start
```

---

## Features

**Files** — New, Open (multi-select), Save, Save As, recent files, drag & drop onto
the window. Saves are written atomically (temp file + rename), so an interrupted
save cannot truncate the original.

**Tabs** — Multiple documents with a modified dot per tab, middle-click to close,
reopen the last closed tab, next/previous cycling.

**Editing** — Line-number gutter with current-line highlighting, a full-width
current-line band, word wrap, zoom 50–300%, duplicate/delete/move lines, line
comment toggle, indent/outdent across selections, case conversion, trim trailing
whitespace.

**Right-click context menus** — Right-clicking anywhere gives you the commands
that make sense *there*: the editor gets cut/copy/paste and the text transforms,
the tab strip gets close/reopen, the gutter gets go-to-line, and the chrome gets
the view and window actions. Items that cannot run are greyed out rather than
hidden, so the menu never reshuffles under you.

**Font selection** — Choose the editor font family and size from a curated list
(`Ctrl+Shift+F`). Fonts are grouped by bundled / ships-with-Windows / stacks, and
each row is probed for actual availability so you can see what is really
installed on this machine. A live sample renders as you pick. The size here
multiplies with zoom rather than replacing it, so 110% zoom on a 17px font
renders at 18.7px.

**Markdown preview** — `Ctrl+Shift+M` splits the pane and renders the document
side by side; `Ctrl+Shift+E` gives the preview the whole window. Headings (ATX
and setext), ordered/unordered/nested/task lists, blockquotes, fenced code with a
Copy button, GFM tables with column alignment, horizontal rules, and inline
emphasis, code spans, links and strikethrough all render. The view is per tab, so
each document comes back to the view it was left in. Web links open in your
browser; a link to another document in the same folder opens it as a new tab.
Images are not resolved yet and render as labelled placeholders — see
[Markdown preview](#markdown-preview) below.

**Find & Replace** — Match case, whole word and regex modes, live match count,
amber highlighting of every match with the active one emphasized, Replace and
Replace All, `F3` / `Shift+F3` navigation.

**Command palette** — `Ctrl+Space` fuzzy-searches every command in the app and
doubles as a quick-open for recent files.

**Autosave & recovery** — Unsaved work is snapshotted to the app's data folder
every few seconds and restored after a crash. Files that already have a path are
written straight through. The session (open tabs, carets, scroll positions)
survives a restart.

**Other** — Global hotkey to summon the window from any app, always-on-top,
fullscreen, custom dark-theme menu bar, native unsaved-changes guards.

---

## Shortcuts

### File
| Shortcut | Action |
|---|---|
| `Ctrl+N` | New document |
| `Ctrl+O` | Open file |
| `Ctrl+S` | Save |
| `Ctrl+Shift+S` | Save As |
| `Ctrl+W` | Close tab |
| `Ctrl+Shift+T` | Reopen closed tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab |
| `Ctrl+P` | Open recent (quick-open) |
| `Ctrl+Q` | Exit |

### Edit
| Shortcut | Action |
|---|---|
| `Ctrl+Z` / `Ctrl+Y` | Undo / Redo |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut / Copy / Paste |
| `Ctrl+A` | Select all |
| `Ctrl+D` | Duplicate line |
| `Ctrl+Shift+D` | Delete line |
| `Alt+↑` / `Alt+↓` | Move line up / down |
| `Ctrl+/` | Toggle line comment (`//`) |
| `Tab` / `Shift+Tab` | Insert an indent at the caret, or indent/outdent the selected lines |

Right-click adds **Cut / Copy / Paste / Select All**, the case conversions
(UPPER, lower, Title Case), Trim Trailing Whitespace, and Truncate Selection —
all scoped to the current selection.

### Search
| Shortcut | Action |
|---|---|
| `Ctrl+F` | Find |
| `Ctrl+H` | Find & Replace |
| `F3` / `Shift+F3` | Find next / previous |
| `Ctrl+G` | Go to line |
| `Alt+C` / `Alt+W` / `Alt+R` | Toggle match case / whole word / regex |
| `Esc` | Close the find bar |

### View
| Shortcut | Action |
|---|---|
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Ctrl`+wheel | Zoom |
| `Alt+Z` | Toggle word wrap |
| `Ctrl+Shift+L` | Toggle dark / light theme |
| `F11` | Fullscreen |
| `Ctrl+\`` | Always on top |
| `Ctrl+Shift+F` | Editor font |
| `Ctrl+Shift+M` | Markdown preview: side by side |
| `Ctrl+Shift+E` | Markdown preview: full pane |
| `Ctrl+Space` | Command palette |

### System
| Shortcut | Action |
|---|---|
| `Ctrl+,` | Settings |
| `F1` | Keyboard shortcut reference |
| `Ctrl+Alt+N` | Summon the window from any application (global) |

---

## Architecture

```
main.js                  Window lifecycle, filesystem access, dialogs,
                         global hotkey, autosave storage, close guard
preload.js               contextBridge — the renderer's only privileged surface
src/
  index.html             App shell and markup
  styles/
    theme.css            Design tokens; both themes declared up front
    app.css              Component styles
  renderer/
    commands.js          Command registry — the single source of truth
    store.js             Preferences (localStorage) + drafts & session (IPC)
    editor.js            Textarea engine: gutter, highlight layer, line ops
    tabs.js              Document / tab model
    search.js            Find & replace
    palette.js           Command palette (fuzzy search)
    menubar.js           Custom menu bar
    contextmenu.js       Right-click menus (per-region item lists)
    fontdialog.js        Editor font picker (family, size, ligatures)
    statusbar.js         Status bar
    markdown.js          Markdown -> DOM renderer (never builds HTML strings)
    preview.js           Preview pane: modes, re-render, link routing
    app.js               Controller: registers commands, wires the UI
scripts/
  make-icon.js           Regenerates assets/icon.png (no image deps)
  preview-server.js      Dev-only: serves the renderer for browser testing
  lib/cdp.js             Shared headless-Chromium/CDP client for the UI tests
  check-open-with.js     Shell "Open with" argv checks (npm run test:shell)
  check-preview-bridge.js Verifies the injected mock bridge parses (npm run test:bridge)
  test-menu.js           Menu bar regression suite (npm run test:menu)
  test-context-font.js   Context menu + font dialog suite (npm run test:ui)
  test-editor-keys.js    Tab / Shift+Tab editing contract (npm run test:keys)
  test-preview.js        Markdown preview suite (npm run test:preview)
  shot-preview.js        Dev-only: screenshots the preview into .shots/
```

### Design decisions

**One command registry.** Every action is declared once in `commands.js` with its
label, accelerator and handler. The menu bar, the palette and the keyboard layer
all read from that list, so a shortcut can never drift out of sync with the menu.
Adding a feature means registering one entry.

**A plain `<textarea>`, not a rich editor.** The textarea keeps the native caret,
IME support, system undo and OS text shortcuts for free — exactly what a notepad
needs. The gutter, current-line band and match highlighting are derived state
painted alongside it. The trade-off is one shared undo stack across tabs, which
matches Notepad++ behaviour.

**Nothing privileged in the renderer.** `contextIsolation` is on and
`nodeIntegration` is off. All filesystem work happens in the main process behind a
narrow, explicitly enumerated IPC surface in `preload.js`.

**Atomic saves.** Writes go to a temp file and are renamed into place, so a crash
or power loss mid-save leaves the original file intact.

**Menus are markup, not native menus.** The menu bar and the right-click menus
are ordinary DOM, so they inherit the theme, animate, and can be hit-tested by
the test suite. Both append their panel to `<body>` rather than nesting it in the
pane that opened it — a `position: fixed` panel inside `.titlebar` gets clipped
and stacked by that element's own stacking context. Consequently a context menu
takes focus off the textarea, which is why its clipboard verbs go through the
main process rather than `document.execCommand('cut')` (which silently no-ops
without focus).

**Fonts are applied through CSS custom properties**, not inline styles. The
textarea, the highlight layer and the gutter each read `--editor-font-family` /
`--editor-font-size`, with the stylesheet providing the default stack. Unsetting
the property therefore reverts cleanly to the built-in fonts, which is what makes
"Reset" a supported state rather than a special case.

**Software-rendering fallback.** Headless sessions, some VMs and remote desktops
have no usable GPU, and Chromium aborts with "GPU process isn't usable" rather
than degrading. `main.js` detects that case and falls back to software rendering.
Pass `--force-gpu` to keep hardware acceleration on unconditionally.

### Markdown preview

**It renders DOM, never HTML.** `markdown.js` builds nodes with `createElement` /
`createTextNode` and never assembles an HTML string. That is a security boundary
rather than a style preference: the source is whatever file you opened, and it is
rendered in a page that carries `window.sara` — so a string-building renderer
would turn any markdown file into a same-origin script host, which the page's
`script-src 'self'` CSP cannot stop. Raw HTML in the source is therefore shown as
literal text, and `javascript:` / `data:` / `vbscript:` links never receive an
`href` at all.

Clicks in the pane are routed through the app rather than followed by the
browser. `http(s)` and `mailto` go to the OS browser through the main process,
which re-validates the scheme before handing anything to `shell.openExternal`. A
relative link is resolved against the document's own folder and is refused if it
would climb out of it — a markdown file must not be able to talk you into opening
`..\..\Users\…\.ssh\id_rsa` by labelling the link "docs".

**A sibling pane, not a mode of the editor.** The `<textarea>` stays mounted and
keeps the caret, so toggling the view never disturbs the document, the undo stack
or the caret position. `data-mode` on `.editorWrap` carries the state (`edit` /
`split` / `preview`), alongside the `data-wrap` and `data-font` axes that were
already there. Re-renders ride the same 120 ms debounce the tab title uses, and
carry the scroll offset across, so typing does not throw the reader back to the
top.

**Images are not resolved yet.** An `<img src>` cannot work as written: the page
is loaded from `src/index.html`, so a document-relative path resolves against the
wrong folder, and the CSP only permits `img-src 'self' data:`. Doing it properly
needs a custom protocol handler in the main process with a path containment
check. Until then an image renders as a labelled placeholder showing its alt text
and source path, and remote images stay blocked.

---

## Where your data lives

`%APPDATA%\SaraText\`

| File | Contents |
|---|---|
| `session.json` | Open tabs, carets, scroll positions |
| `window-state.json` | Window size, position, maximized |
| `drafts/*.json` | Unsaved-work snapshots for crash recovery |

Preferences (theme, zoom, wrap, recents, settings) live in the app's
`localStorage`. Deleting the folder resets the app completely; your actual
documents are never touched.

---

## Development

```bash
npm start          # run the app
npm run dev        # run with DevTools detached
npm start -- --force-gpu   # force hardware acceleration
```

Regenerate the icon after editing `scripts/make-icon.js`:

```bash
npm run icon
```

### Building a distributable

Packaging is handled by electron-builder. The output lands in `dist/`.

```bash
npm run dist              # NSIS installer + portable exe
npm run dist:installer    # installer only
npm run dist:portable     # portable exe only
npm run pack              # unpacked build, for quick testing
```

Two artifacts are produced:

| Artifact | Purpose |
|---|---|
| `SaraText-<version>-Setup.exe` | Installer — lets the user pick a location, creates Start Menu and desktop shortcuts, and registers an uninstaller. Per-user, so it does not require admin rights. |
| `SaraText-<version>-Portable.exe` | Single-file portable build. Runs anywhere, leaves no install behind. |

Both targets are x64. Only `main.js`, `preload.js`, `src/`, `assets/` and
`package.json` are packed into `app.asar` — the `scripts/` directory is
development-only and is deliberately excluded.

The icon is generated from `assets/icon.png`, which electron-builder converts to
a multi-resolution `.ico` automatically; no separate icon file is needed.

### Hardware acceleration and headless machines

Chromium aborts with `GPU process isn't usable. Goodbye.` on machines with no
usable GPU — headless sessions, some VMs, and certain remote desktops — rather
than degrading gracefully. `main.js` handles this in two layers:

1. **Up-front** — if the environment is known to be headless (`SARATEXT_SOFTWARE_GL=1`,
   an empty `DISPLAY`, or a Windows session with neither `SESSIONNAME` nor
   `USERNAME`), software rendering is enabled before the window exists.
2. **Reactively** — otherwise the app starts with hardware acceleration and
   listens for `child-process-gone`. A repeatedly failing GPU process triggers a
   single self-relaunch with `--saratext-software-gl`, which pins GL to
   SwiftShader and keeps GPU work in the main process. The flag makes the
   relaunch loop-proof.

Pass `--force-gpu` to opt out of both layers entirely.

If the app still will not start on an unusual machine, run it with
`SARATEXT_SOFTWARE_GL=1` to force the software path from the outset.

### Testing the renderer in a browser

`scripts/preview-server.js` serves `src/` over HTTP with a stubbed `window.sara`
bridge, so the UI can be driven by ordinary browser automation without launching
Electron:

```bash
node scripts/preview-server.js     # http://127.0.0.1:5199
```

This is a development aid only — it is not part of the shipped app.

### Running the tests

```bash
npm test                   # all five suites, plus the bridge check
npm run test:shell         # shell "Open with" argv parsing (pure unit checks)
npm run test:bridge        # the mock bridge the preview server injects parses
npm run test:menu          # menu bar: every dropdown, every item, layering, keyboard
npm run test:ui            # context menus + font dialog
npm run test:keys          # Tab / Shift+Tab: insert at caret, indent/outdent lines
npm run test:preview       # markdown rendering, layout modes, link routing
```

The suites are self-contained: the browser ones start their own copy of
`preview-server.js`, launch headless Chromium over the DevTools protocol
(`scripts/lib/cdp.js`) and tear both down afterwards. They must not run
concurrently, since they share port 5199 — `npm test` chains them for that reason.

`test:bridge` exists because `preview-server.js` injects its `window.sara` stub as
JavaScript embedded in a template literal. A stray backslash or backtick there
produces a script that fails to parse in the browser while `node --check` on the
server file stays green — which is exactly how a broken `readFile` once shipped
into the harness unnoticed. The check fetches the emitted string over HTTP and
parses that.

Why headless Chromium and not Electron: the UI logic that is worth regression-
testing lives in the renderer, and `preview-server.js` exposes it with the same
`window.sara` shape. (There is also a practical reason — see
[Hardware acceleration and headless machines](#hardware-acceleration-and-headless-machines) —
Electron cannot always start on a build machine at all.)

All browser suites assert that the page logged **zero console errors**, which is
what caught a pre-existing `Store.readDraft is not a function` boot failure that
had been silently breaking draft recovery.

`scripts/shot-preview.js` renders the preview and writes screenshots to `.shots/`
(git-ignored) — useful for eyeballing a style change, since the DOM assertions say
nothing about how it looks.

---

## Platform notes

Built and tested on Windows. The window controls, path handling and global hotkey
are Windows-oriented; the editor and file logic are platform-neutral.

## License

MIT
