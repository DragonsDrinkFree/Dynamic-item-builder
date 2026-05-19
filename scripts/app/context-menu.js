/**
 * Generic context menu — builds a floating DOM menu from an items array.
 *
 * Each item can be:
 *   { separator: true }
 *   { heading: 'Section Title' }
 *   { filterInput: true }                — renders a search input; subsequent filterable items go inside a scrollable list
 *   { label, icon?, action, filterable? } — clickable button
 */

import { createPopover } from './popovers.js';

export function showContextMenu(event, items) {
  document.querySelector('.dib-context-menu')?.remove();
  if (!items.length) return;

  const menu = document.createElement('div');
  menu.className = 'dib-context-menu';

  let filterableList = null;
  let filterInput    = null;

  for (const item of items) {
    if (item.separator) {
      const hr = document.createElement('hr');
      hr.className = 'dib-ctx-sep';
      menu.appendChild(hr);
      continue;
    }
    if (item.heading) {
      const h = document.createElement('div');
      h.className = 'dib-ctx-heading';
      h.textContent = item.heading;
      menu.appendChild(h);
      continue;
    }
    if (item.filterInput) {
      filterInput = document.createElement('input');
      filterInput.type = 'text';
      filterInput.className = 'dib-ctx-filter';
      filterInput.placeholder = 'Filter fields…';

      filterableList = document.createElement('div');
      filterableList.className = 'dib-ctx-filterable-list';

      filterInput.addEventListener('input', () => {
        const q = filterInput.value.toLowerCase();
        filterableList.querySelectorAll('.dib-ctx-item').forEach(btn => {
          btn.hidden = !!q && !btn.textContent.toLowerCase().includes(q);
        });
      });
      filterInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          filterableList.querySelector('.dib-ctx-item:not([hidden])')?.click();
        }
        if (e.key === 'Escape') { e.stopPropagation(); menu.remove(); }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          filterableList.querySelector('.dib-ctx-item:not([hidden])')?.focus();
        }
      });

      menu.appendChild(filterInput);
      menu.appendChild(filterableList);
      continue;
    }

    const btn = document.createElement('button');
    btn.className = 'dib-ctx-item';
    btn.innerHTML = `<i class="fas ${item.icon ?? 'fa-circle'}"></i> ${item.label}`;
    btn.addEventListener('click', () => { item.action(); menu.remove(); });

    if (item.filterable && filterableList) {
      filterableList.appendChild(btn);
    } else {
      menu.appendChild(btn);
    }
  }

  document.body.appendChild(menu);
  const { clientX: x, clientY: y } = event;
  const { offsetWidth: w, offsetHeight: h } = menu;
  menu.style.left = `${Math.min(x, window.innerWidth  - w - 8)}px`;
  menu.style.top  = `${Math.min(y, window.innerHeight - h - 8)}px`;

  if (filterInput) filterInput.focus();

  const close = e => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); }
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}

/**
 * Build a filterable attribute-mapping submenu (separator + heading + filter + items).
 * Appended to an existing menuItems array; caller decides action per attribute.
 *
 * @param {Array}    menuItems      — mutable array to push items onto
 * @param {string}   label          — what's being mapped (e.g. column header or field name)
 * @param {Array}    attributePaths — [{ path, label }]
 * @param {Function} onSelect       — (attrPath: string) => void
 * @param {Element}  [anchor]       — element to position the "Map Unlisted Field" popover near
 */
export function appendAttributeMappingMenu(menuItems, label, attributePaths, onSelect, anchor) {
  if (!attributePaths?.length) return;
  menuItems.push({ separator: true });
  menuItems.push({ heading: `Map "${label}" to field:` });
  menuItems.push({
    icon: 'fa-pencil',
    label: 'Map Unlisted Field…',
    action: () => {
      createPopover({
        anchor: anchor ?? document.body,
        className: 'dib-cell-popover',
        innerHTML: `
          <div class="dib-cpop-label">Field path:</div>
          <input type="text" class="dib-cpop-input" placeholder="e.g. system.description">
          <div class="dib-cpop-buttons">
            <button class="dib-cpop-save">Apply</button>
            <button class="dib-cpop-cancel">Cancel</button>
          </div>`,
        onSave: (popover) => {
          const path = popover.querySelector('.dib-cpop-input').value.trim();
          if (path) onSelect(path);
        },
        onReady: (popover) => popover.querySelector('.dib-cpop-input').focus()
      });
    }
  });
  menuItems.push({ filterInput: true });
  for (const attr of attributePaths) {
    menuItems.push({
      icon: 'fa-link', label: attr.path, filterable: true,
      action: () => onSelect(attr.path)
    });
  }
}
