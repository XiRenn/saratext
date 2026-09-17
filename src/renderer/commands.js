'use strict';

/**
 * SaraText - command registry
 *
 * Every user-triggerable action is declared here exactly once, with its
 * label, menu placement, accelerator and handler. The custom menu bar,
 * the keyboard layer and the command palette all read from this list, so
 * a shortcut can never drift out of sync with the menu.
 *
 * Accelerator syntax (normalised, lowercase, +-joined):
 *   "ctrl+n"  "ctrl+shift+s"  "alt+z"  "f3"  "ctrl+="
 * Use "mod" on mac if this ever ships cross-platform.
 */

const Commands = (() => {
  /** @type {Map<string, object>} */
  const registry = new Map();
  /** @type {Array<{id:string, label:string, items:string[]}>} */
  const menuLayout = [];

  /**
   * @param {object} def
   * @param {string}   def.id          stable identifier
   * @param {string}   def.label       human label, also used by the palette
   * @param {string}   [def.accel]     normalised accelerator
   * @param {string}   [def.category]  palette grouping
   * @param {Function} def.run         handler
   * @param {Function} [def.enabled]   () => boolean, gates menu + palette
   * @param {Function} [def.checked]   () => boolean, renders a check mark
   * @param {boolean}  [def.hidden]    keep out of the palette
   */
  function register(def) {
    if (!def || !def.id) throw new Error('command needs an id');
    registry.set(def.id, {
      accel: null,
      category: 'General',
      enabled: () => true,
      checked: null,
      hidden: false,
      ...def,
    });
    return def.id;
  }

  /** Declare the menu bar structure. Items not present are skipped. */
  function menu(label, items) {
    menuLayout.push({ id: `menu.${label.toLowerCase()}`, label, items });
  }

  const get = (id) => registry.get(id);

  function all() {
    return [...registry.values()];
  }

  function run(id, ...args) {
    const cmd = registry.get(id);
    if (!cmd) {
      console.warn('[saratext] unknown command:', id);
      return false;
    }
    if (cmd.enabled && !cmd.enabled()) return false;
    try {
      const result = cmd.run(...args);
      // Surface async rejections instead of swallowing them.
      if (result && typeof result.catch === 'function') {
        result.catch((err) => console.error(`[saratext] command "${id}" failed:`, err));
      }
      return true;
    } catch (err) {
      console.error(`[saratext] command "${id}" threw:`, err);
      return false;
    }
  }

  /* ---------------------------------------------------------------- *
   * Accelerator helpers
   * ---------------------------------------------------------------- */

  const MOD_ALIASES = { cmdorctrl: 'ctrl', command: 'ctrl', control: 'ctrl', option: 'alt' };

  /** Turn an accelerator string into a canonical lowercase form. */
  function normalise(accel) {
    if (!accel) return null;
    return accel
      .toLowerCase()
      .split('+')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => MOD_ALIASES[part] || part)
      .sort((a, b) => order(a) - order(b))
      .join('+');
  }

  const ORDER = ['ctrl', 'alt', 'shift', 'meta'];
  const order = (key) => {
    const i = ORDER.indexOf(key);
    return i === -1 ? ORDER.length : i;
  };

  /** Normalise a keyboard event into the same canonical form. */
  function eventToAccel(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('ctrl');
    if (event.altKey) parts.push('alt');
    if (event.shiftKey) parts.push('shift');
    if (event.metaKey) parts.push('meta');

    let key = event.key;
    if (key === ' ') key = 'space';
    else if (key === 'Escape') key = 'escape';
    else if (key === 'Enter') key = 'enter';
    else if (key === 'Backspace') key = 'backspace';
    else if (key === 'Delete') key = 'delete';
    else if (key === 'Tab') key = 'tab';
    else if (key === 'ArrowUp') key = 'up';
    else if (key === 'ArrowDown') key = 'down';
    else if (key === 'ArrowLeft') key = 'left';
    else if (key === 'ArrowRight') key = 'right';
    else if (key === 'Home') key = 'home';
    else if (key === 'End') key = 'end';
    else if (key === 'PageUp') key = 'pageup';
    else if (key === 'PageDown') key = 'pagedown';
    else if (key === '+') key = '=';
    else if (key.length === 1) key = key.toLowerCase();

    // A bare modifier press is not a shortcut.
    if (['control', 'alt', 'shift', 'meta'].includes(key.toLowerCase())) return null;

    parts.push(key);
    return parts.sort((a, b) => order(a) - order(b)).join('+');
  }

  /** accel -> command id, rebuilt lazily whenever the registry changes. */
  let accelIndex = null;
  function resolveAccel(event) {
    if (!accelIndex) {
      accelIndex = new Map();
      for (const cmd of registry.values()) {
        if (!cmd.accel) continue;
        accelIndex.set(normalise(cmd.accel), cmd.id);
      }
    }
    const accel = eventToAccel(event);
    if (!accel) return null;
    const id = accelIndex.get(accel);
    if (!id) return null;
    const cmd = registry.get(id);
    return cmd && cmd.enabled() ? id : null;
  }

  /** An accelerator is "in scope" only while a given predicate holds. */
  const contextRules = [];
  function when(predicate, ids) {
    contextRules.push({ predicate, ids: new Set(ids) });
  }
  function isAllowed(id, context = {}) {
    for (const rule of contextRules) {
      if (!rule.ids.has(id)) continue;
      if (!rule.predicate(context)) return false;
    }
    return true;
  }

  /** Render an accelerator for display: ctrl+shift+s -> Ctrl+Shift+S */
  const DISPLAY = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Win',
    up: '↑', down: '↓', left: '←', right: '→', plus: '=' };
  function displayAccel(accel) {
    if (!accel) return '';
    return accel
      .split('+')
      .map((part) => DISPLAY[part] || (part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)))
      .join('+');
  }

  return {
    register, menu, get, all, run,
    normalise, eventToAccel, resolveAccel, displayAccel,
    when, isAllowed,
    get menuLayout() { return menuLayout; },
    invalidateAccelCache() { accelIndex = null; },
  };
})();
