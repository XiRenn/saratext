'use strict';

/**
 * SaraText - custom menu bar
 *
 * Renders the menu structure declared via Commands.menu() and executes
 * commands through the registry, so menu items, palette entries and
 * keyboard shortcuts are always the same code path.
 */

const MenuBar = (() => {
  let root = null;
  let openMenu = null;      // the currently expanded dropdown element
  let openButton = null;

  function init(el) {
    root = el;

    for (const group of Commands.menuLayout) {
      const button = document.createElement('button');
      button.className = 'menubar__item';
      button.type = 'button';
      button.textContent = group.label;
      button.setAttribute('aria-haspopup', 'true');
      button.setAttribute('aria-expanded', 'false');

      // Menus on the right half of the bar open right-aligned, so the dropdown
      // never spills past the window edge.
      const rect = button.getBoundingClientRect();
      if (rect.left > window.innerWidth * 0.55) button.dataset.align = 'end';

      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (openButton === button) close();
        else openMenuFor(group, button);
      });

      root.appendChild(button);
    }

    // Hovering a sibling while a menu is open switches to it, the standard
    // desktop menu-bar behaviour. `relatedTarget` must sit inside the bar -
    // moving into the open dropdown is not a switch.
    root.addEventListener('mouseover', (e) => {
      if (!openMenu) return;
      const button = e.target.closest('.menubar__item');
      if (!button || button === openButton) return;
      if (!root.contains(e.relatedTarget)) return;
      const group = Commands.menuLayout.find((g) => g.label === button.textContent);
      if (group) openMenuFor(group, button);
    });

    // A press anywhere outside the bar and the dropdown dismisses it. The
    // dropdown lives on <body>, so it must be tested separately.
    document.addEventListener('mousedown', (e) => {
      if (!openMenu) return;
      if (openMenu.contains(e.target) || root.contains(e.target)) return;
      close();
    });

    // Safety net for the cases a mousedown cannot reach us: the window losing
    // focus, or a scroll/resize leaving the dropdown stranded.
    window.addEventListener('blur', () => close());
    window.addEventListener('resize', () => { if (openMenu) close(); });

    document.addEventListener('keydown', (e) => {
      if (!openMenu) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close();
        Editor.element.focus();
        return;
      }

      // Keyboard navigation: the menu bar must be operable without a mouse.
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveFocus(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        const items = focusable(openMenu);
        if (items.length) items[e.key === 'Home' ? 0 : items.length - 1].focus();
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        stepMenu(e.key === 'ArrowRight' ? 1 : -1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        const item = document.activeElement;
        if (item && item.classList.contains('menu__item') && !item.disabled) {
          e.preventDefault();
          e.stopPropagation();
          const id = item.dataset.cmd;
          close();
          Commands.run(id);
        }
      }
    }, true);

    // Re-evaluate enabled/checked state as the document changes.
    Docs.on('change', () => { if (openMenu) refresh(); });
    Docs.on('active', () => { if (openMenu) refresh(); });
  }

  /** Enabled items of an open menu, in visual order. */
  const focusable = (menu) => [...menu.querySelectorAll('.menu__item')].filter((i) => !i.disabled);

  /** Move focus by `delta` items within the open dropdown. */
  function moveFocus(delta) {
    if (!openMenu) return;
    const items = focusable(openMenu);
    if (!items.length) return;
    const at = items.indexOf(document.activeElement);
    const next = at === -1
      ? (delta > 0 ? 0 : items.length - 1)
      : (at + delta + items.length) % items.length;
    items[next].focus();
  }

  /** Open the next/previous top-level menu, keeping the bar keyboard-drivable. */
  function stepMenu(delta) {
    if (!openButton) return;
    const buttons = [...root.querySelectorAll('.menubar__item')];
    const at = buttons.indexOf(openButton);
    if (at === -1) return;
    const next = buttons[(at + delta + buttons.length) % buttons.length];
    const group = Commands.menuLayout.find((g) => g.label === next.textContent);
    openMenuFor(group, next);
    moveFocus(1);
  }

  function openMenuFor(group, button) {
    close();
    openButton = button;
    button.setAttribute('aria-expanded', 'true');

    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.dataset.group = group.id;

    for (const id of group.items) {
      if (id === '-') {
        const sep = document.createElement('div');
        sep.className = 'menu__sep';
        menu.appendChild(sep);
        continue;
      }
      const cmd = Commands.get(id);
      if (!cmd || cmd.hidden) continue;

      const item = document.createElement('button');
      item.className = 'menu__item';
      item.type = 'button';
      item.dataset.cmd = id;
      item.setAttribute('role', 'menuitem');

      const enabled = cmd.enabled();
      item.disabled = !enabled;

      const check = document.createElement('span');
      check.className = 'menu__check';
      if (cmd.checked && cmd.checked()) check.textContent = '✓';

      const label = document.createElement('span');
      label.className = 'menu__label';
      label.textContent = cmd.label;

      item.append(check, label);

      if (cmd.accel) {
        const accel = document.createElement('span');
        accel.className = 'menu__accel';
        accel.textContent = Commands.displayAccel(cmd.accel);
        item.appendChild(accel);
      }

      // `click` rather than `mouseup`: a click only fires when press and
      // release land on the same element, so dragging off an item no longer
      // fires it. stopPropagation keeps the event away from the command
      // palette's overlay and the editor's own handlers.
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (item.disabled) return;
        close();
        Commands.run(id);
      });

      menu.appendChild(item);
    }

    // Attach to <body> and place it under the button, rather than nesting it
    // inside the button. The caption buttons carry `.tabstrip`'s re-render and
    // the title bar's stacking context, and a dropdown living inside them is
    // easy to orphan mid-click. A body-level panel with fixed coordinates is
    // stable: nothing reparents it while the pointer is on an item.
    document.body.appendChild(menu);
    openMenu = menu;
    position(group, button, menu);
  }

  /** Anchor an open dropdown under its caption button. */
  function position(group, button, menu) {
    const btn = button.getBoundingClientRect();
    menu.style.top = `${Math.round(btn.bottom + 5)}px`;
    // Right-aligned menus keep their right edge under the button's right edge.
    if (button.dataset.align === 'end') {
      menu.style.right = `${Math.round(window.innerWidth - btn.right)}px`;
      menu.style.left = 'auto';
    } else {
      menu.style.left = `${Math.round(btn.left)}px`;
      menu.style.right = 'auto';
    }
  }

  /** Recompute disabled/checked state without rebuilding the menu. */
  function refresh() {
    if (!openMenu) return;
    for (const item of openMenu.querySelectorAll('.menu__item')) {
      const cmd = Commands.get(item.dataset.cmd);
      if (!cmd) continue;
      item.disabled = !cmd.enabled();
      const check = item.querySelector('.menu__check');
      if (check) check.textContent = cmd.checked && cmd.checked() ? '✓' : '';
    }
  }

  function close() {
    if (openMenu && openMenu.parentElement) openMenu.parentElement.removeChild(openMenu);
    if (openButton) openButton.setAttribute('aria-expanded', 'false');
    openMenu = null;
    openButton = null;
  }
  const isOpen = () => Boolean(openMenu);

  return { init, close, refresh, isOpen };
})();
