/**
 * Generic context menu — builds a floating DOM menu from an items array.
 *
 * Each item can be:
 *   { separator: true }
 *   { heading: 'Section Title' }
 *   { filterInput: true }                — renders a search input; subsequent filterable items go inside a scrollable list
 *   { label, icon?, action, filterable? } — clickable button
 */
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
