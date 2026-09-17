'use strict';

/**
 * SaraText - persistence store
 *
 * Thin layer over localStorage for preferences and over IPC for drafts.
 * Preferences are small and synchronous, so localStorage is the right
 * tool; drafts can be large and belong on disk in userData.
 */

const Store = (() => {
  const PREF_KEY = 'saratext.prefs.v1';

  const DEFAULTS = {
    theme: 'dark',
    wordWrap: false,
    zoom: 100,
    showLineNumbers: true,
    tabSize: 4,
    autoSaveEnabled: true,
    autoSaveIntervalMs: 5000,
    restoreSession: true,
    globalHotkey: 'ctrl+alt+n',
    globalHotkeyEnabled: true,
    alwaysOnTop: false,
    fontSize: 12.5,
    /** Editor font stack. `null` means "keep the built-in --font-mono stack". */
    fontFamily: null,
    /** Font ligatures. `null` means "leave the browser default" (off today). */
    fontLigatures: null,
    recentFiles: [],
    maxRecentFiles: 12,
  };

  /**
   * A stored `null` is a real value here ("no override"), not a missing key,
   * so the usual `{ ...DEFAULTS, ...stored }` merge is not enough: it would
   * let a null overwrite a non-null default. Options whose default is a real
   * value fall back individually.
   */
  const NON_NULL_DEFAULTS = ['fontSize'];

  let prefs = { ...DEFAULTS };

  function load() {
    try {
      const raw = localStorage.getItem(PREF_KEY);
      if (raw) {
        const stored = JSON.parse(raw);
        prefs = { ...DEFAULTS, ...stored };
        for (const key of NON_NULL_DEFAULTS) {
          if (stored[key] === null || stored[key] === undefined) prefs[key] = DEFAULTS[key];
        }
      }
    } catch (err) {
      console.warn('[saratext] could not read preferences, using defaults', err);
      prefs = { ...DEFAULTS };
    }
    return prefs;
  }

  function persist() {
    try {
      localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
      return true;
    } catch (err) {
      console.warn('[saratext] could not persist preferences', err);
      return false;
    }
  }

  function get(key) {
    return key === undefined ? { ...prefs } : prefs[key];
  }

  function set(key, value) {
    prefs[key] = value;
    persist();
    return value;
  }

  function patch(updates) {
    Object.assign(prefs, updates);
    persist();
    return prefs;
  }

  function reset() {
    prefs = { ...DEFAULTS };
    persist();
  }

  /* ---- recent files ------------------------------------------------ */

  function addRecent(filePath) {
    if (!filePath) return;
    const list = prefs.recentFiles.filter((p) => p !== filePath);
    list.unshift(filePath);
    prefs.recentFiles = list.slice(0, prefs.maxRecentFiles);
    persist();
  }

  function removeRecent(filePath) {
    prefs.recentFiles = prefs.recentFiles.filter((p) => p !== filePath);
    persist();
  }

  function clearRecent() {
    prefs.recentFiles = [];
    persist();
  }

  /* ---- drafts ------------------------------------------------------ */

  /** Drafts are addressed by a stable per-tab id so they survive reloads. */
  const draftId = (tabId) => `tab-${tabId}`;

  async function saveDraft(tabId, payload) {
    if (!window.sara) return false;
    const res = await window.sara.writeDraft(draftId(tabId), payload);
    return Boolean(res && res.ok);
  }

  async function loadDraft(tabId) {
    if (!window.sara) return null;
    const res = await window.sara.readDraft(draftId(tabId));
    return res && res.ok ? res.draft : null;
  }

  async function dropDraft(tabId) {
    if (!window.sara) return;
    await window.sara.deleteDraft(draftId(tabId));
  }

  async function listDrafts() {
    if (!window.sara) return [];
    const res = await window.sara.listDrafts();
    return res && res.ok ? res.ids : [];
  }

  /* ---- session ----------------------------------------------------- */

  async function saveSession(data) {
    if (!window.sara) return false;
    const res = await window.sara.saveSession(data);
    return Boolean(res && res.ok);
  }

  async function loadSession() {
    if (!window.sara) return null;
    const res = await window.sara.loadSession();
    return res && res.ok ? res.data : null;
  }

  return {
    DEFAULTS,
    load, persist, get, set, patch, reset,
    addRecent, removeRecent, clearRecent,
    saveDraft, loadDraft, dropDraft, listDrafts,
    saveSession, loadSession,
  };
})();
