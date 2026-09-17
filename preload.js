'use strict';

/**
 * SaraText - preload bridge
 *
 * The renderer has no Node access. Everything it is allowed to do is
 * declared here as an explicit, narrow method on window.sara.
 */

const { contextBridge, ipcRenderer, webUtils, clipboard } = require('electron');

/** Wrap a send/on pair so the renderer can never touch the raw emitter. */
function subscribe(channel, callback) {
  const handler = (_event, ...args) => callback(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('sara', {
  /* ---- files ---------------------------------------------------- */
  openFiles: (opts = {}) => ipcRenderer.invoke('dialog:open', opts),
  readFile: (filePath) => ipcRenderer.invoke('file:read', filePath),
  saveFile: (payload) => ipcRenderer.invoke('file:save', payload),
  fileExists: (filePath) => ipcRenderer.invoke('file:exists', filePath),
  revealFile: (filePath) => ipcRenderer.invoke('file:reveal', filePath),

  /* ---- dialogs --------------------------------------------------- */
  confirm: (opts) => ipcRenderer.invoke('dialog:confirm', opts),
  message: (opts) => ipcRenderer.invoke('dialog:message', opts),

  /* ---- drafts + session ------------------------------------------ */
  writeDraft: (id, payload) => ipcRenderer.invoke('draft:write', { id, payload }),
  listDrafts: () => ipcRenderer.invoke('draft:list'),
  readDraft: (id) => ipcRenderer.invoke('draft:read', id),
  deleteDraft: (id) => ipcRenderer.invoke('draft:delete', id),

  saveSession: (data) => ipcRenderer.invoke('session:save', data),
  loadSession: () => ipcRenderer.invoke('session:load'),

  /* ---- window ---------------------------------------------------- */
  windowAction: (action) => ipcRenderer.invoke('window:action', action),
  windowState: () => ipcRenderer.invoke('window:query'),
  setGlobalHotkey: (accelerator) => ipcRenderer.invoke('hotkey:set', accelerator),
  appInfo: () => ipcRenderer.invoke('app:info'),

  /* ---- main -> renderer events ----------------------------------- */
  onBeforeClose: (cb) => subscribe('app:before-close', cb),
  onFocusEditor: (cb) => subscribe('app:focus-editor', cb),

  /**
   * Files the app was launched with (Explorer "Open with", drop-on-exe).
   * `notifyReady` is the handshake that releases anything the main process
   * queued before this listener existed.
   */
  onOpenPaths: (cb) => subscribe('app:open-paths', cb),
  notifyReady: () => ipcRenderer.send('file:ready'),

  closeConfirmed: (shouldClose) => ipcRenderer.send('app:close-confirmed', shouldClose),

  /**
   * Resolve the absolute path of a dropped File. Electron removed the
   * File.path property, so webUtils is the supported replacement.
   */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },

  clipboard: {
    readText: () => clipboard.readText(),
    writeText: (t) => clipboard.writeText(t),
  },
});
