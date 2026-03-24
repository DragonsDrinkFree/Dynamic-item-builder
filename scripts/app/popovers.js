/**
 * Popover utilities — shared DOM construction, positioning, and event wiring
 * for the various cell/header/split edit popovers.
 */

import { escapeAttr } from '../utils.js';

/**
 * Create, position, and wire a popover element.
 *
 * @param {Object}   opts
 * @param {Element}  opts.anchor      — element to position near
 * @param {string}   opts.className   — CSS class(es) for the popover div
 * @param {string}   opts.innerHTML   — popover content markup
 * @param {Function} opts.onSave      — called when Save is clicked or Enter pressed
 * @param {Function} [opts.onReady]   — called after DOM insertion with (popover) for focus/setup
 * @returns {HTMLElement} the popover element
 */
export function createPopover({ anchor, className, innerHTML, onSave, onReady }) {
  document.querySelector('.dib-cell-popover')?.remove();

  const popover = document.createElement('div');
  popover.className = className || 'dib-cell-popover';
  popover.innerHTML = innerHTML;
  document.body.appendChild(popover);

  // Position below anchor, flip above if near bottom
  const rect = anchor.getBoundingClientRect?.()
    ?? { bottom: 0, left: 0, top: 0 };
  const pw  = popover.offsetWidth  || 260;
  const ph  = popover.offsetHeight || 120;
  let   top = rect.bottom + 4;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  popover.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - pw - 8))}px`;
  popover.style.top  = `${Math.max(4, top)}px`;

  const cancel = () => popover.remove();
  const save   = () => { if (onSave(popover) !== false) popover.remove(); };

  popover.querySelector('.dib-cpop-save')?.addEventListener('click', save);
  popover.querySelector('.dib-cpop-cancel')?.addEventListener('click', cancel);
  popover.querySelectorAll('.dib-cpop-input, .dib-hpop-input').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); save();   }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    });
  });

  const closeOut = e => {
    if (!popover.contains(e.target)) { cancel(); document.removeEventListener('pointerdown', closeOut, true); }
  };
  setTimeout(() => document.addEventListener('pointerdown', closeOut, true), 0);

  if (onReady) onReady(popover);

  return popover;
}

/**
 * Build the "Set Headers" popover for renaming table columns.
 *
 * @param {Element}  anchor         — button that triggered the popover
 * @param {Object}   table          — scan table object
 * @param {Object}   existing       — rule.manualHeaders[tableId] or undefined
 * @param {Function} onSave         — (headers, originalHeaders) callback
 */
export function showSetHeadersPopover(anchor, table, existing, onSave) {
  const originalHeaders = existing?.originalHeaders ?? table.columns.map(c => c.header ?? '');
  const currentHeaders  = existing?.headers ?? table.columns.map((_, i) => `Col ${i + 1}`);

  const inputsHtml = table.columns.map((_, i) => {
    const orig = escapeAttr(originalHeaders[i] ?? `Col ${i + 1}`);
    const cur  = escapeAttr(currentHeaders[i]  ?? '');
    return `<div class="dib-hpop-col">
      <label class="dib-hpop-label" title="Original: ${orig}">${orig}</label>
      <input type="text" class="dib-cpop-input dib-hpop-input" data-col-idx="${i}"
             value="${cur}" placeholder="${orig}">
    </div>`;
  }).join('');

  createPopover({
    anchor,
    className: 'dib-cell-popover dib-headers-popover',
    innerHTML: `
      <div class="dib-cpop-label">Create Column Headers <span style="font-weight:400;text-transform:none;font-size:9px;color:#666">(original values shown as labels)</span></div>
      <div class="dib-hpop-inputs">${inputsHtml}</div>
      <div class="dib-cpop-btns">
        <button class="dib-btn dib-btn-sm dib-btn-primary dib-cpop-save">Save</button>
        <button class="dib-btn dib-btn-sm dib-cpop-cancel">Cancel</button>
      </div>`,
    onSave(popover) {
      const headers = [...popover.querySelectorAll('.dib-hpop-input')].map(inp => inp.value.trim());
      onSave(headers, originalHeaders);
    },
    onReady(popover) {
      popover.querySelector('.dib-hpop-input')?.focus();
    }
  });
}

/**
 * Build the "Split Column" popover.
 *
 * @param {Element}  anchor    — element near which to position
 * @param {string}   col       — column name being split
 * @param {string}   existing  — current delimiter value or ''
 * @param {Function} onSave    — (delimiter) callback
 */
export function showSplitColumnPopover(anchor, col, existing, onSave) {
  createPopover({
    anchor,
    className: 'dib-cell-popover dib-split-popover',
    innerHTML: `
      <div class="dib-cpop-label">Split Column <em style="font-weight:400;font-size:10px;text-transform:none">"${escapeAttr(col)}"</em></div>
      <div class="dib-hpop-col" style="margin-bottom:6px">
        <label class="dib-hpop-label">Split on symbol</label>
        <input type="text" class="dib-cpop-input dib-split-input" value="${escapeAttr(existing)}"
               placeholder="e.g. /" style="width:80px;text-align:center;font-size:14px">
        <span style="font-size:10px;color:#888;margin-top:3px;display:block">
          Max sub-columns determined from data. Short rows duplicate their last value.
        </span>
      </div>
      <div class="dib-cpop-btns">
        <button class="dib-btn dib-btn-sm dib-btn-primary dib-cpop-save">Apply</button>
        <button class="dib-btn dib-btn-sm dib-cpop-cancel">Cancel</button>
      </div>`,
    onSave(popover) {
      onSave(popover.querySelector('.dib-split-input').value);
    },
    onReady(popover) {
      const inp = popover.querySelector('.dib-split-input');
      inp.focus();
      inp.select();
    }
  });
}

/**
 * Build a single-cell edit popover.
 *
 * @param {Element}  anchor    — the TD element
 * @param {string}   label     — field label to display
 * @param {string}   startVal  — initial input value
 * @param {Function} onSave    — (newValue) callback
 */
export function showCellEditPopover(anchor, label, startVal, onSave) {
  createPopover({
    anchor,
    className: 'dib-cell-popover',
    innerHTML: `
      <div class="dib-cpop-label">${label}</div>
      <input type="text" class="dib-cpop-input" value="${escapeAttr(startVal)}">
      <div class="dib-cpop-btns">
        <button class="dib-btn dib-btn-sm dib-btn-primary dib-cpop-save">Save</button>
        <button class="dib-btn dib-btn-sm dib-cpop-cancel">Cancel</button>
      </div>`,
    onSave(popover) {
      onSave(popover.querySelector('.dib-cpop-input').value);
    },
    onReady(popover) {
      const inp = popover.querySelector('.dib-cpop-input');
      inp.focus();
      inp.select();
    }
  });
}

/**
 * Build a multi-cell edit popover.
 *
 * @param {Element}  anchor    — the anchor TD element
 * @param {number}   count     — number of selected cells
 * @param {string}   label     — field label to display
 * @param {Function} onSave    — (newValue) callback
 */
export function showMultiCellEditPopover(anchor, count, label, onSave) {
  createPopover({
    anchor,
    className: 'dib-cell-popover',
    innerHTML: `
      <div class="dib-cpop-label">Override ${count} cell${count !== 1 ? 's' : ''} — ${label}</div>
      <input type="text" class="dib-cpop-input" placeholder="New value…">
      <div class="dib-cpop-btns">
        <button class="dib-btn dib-btn-sm dib-btn-primary dib-cpop-save">Save</button>
        <button class="dib-btn dib-btn-sm dib-cpop-cancel">Cancel</button>
      </div>`,
    onSave(popover) {
      onSave(popover.querySelector('.dib-cpop-input').value);
    },
    onReady(popover) {
      popover.querySelector('.dib-cpop-input').focus();
    }
  });
}

/**
 * Build a Find & Replace popover for a column.
 *
 * @param {Element}  anchor   — the TH element
 * @param {string}   label    — column field label
 * @param {Function} onApply  — ({ find, replace, useRegex, caseSensitive }) => void
 */
export function showFindReplacePopover(anchor, label, onApply) {
  createPopover({
    anchor,
    className: 'dib-cell-popover dib-findreplace-popover',
    innerHTML: `
      <div class="dib-cpop-label">Find &amp; Replace — <em style="font-weight:400;text-transform:none;font-size:10px">${escapeAttr(label)}</em></div>
      <div class="dib-fr-row">
        <label class="dib-fr-label">Find</label>
        <input type="text" class="dib-cpop-input dib-fr-find" placeholder="Search pattern…">
      </div>
      <div class="dib-fr-row">
        <label class="dib-fr-label">Replace</label>
        <input type="text" class="dib-cpop-input dib-fr-replace" placeholder="Replacement…">
      </div>
      <div class="dib-fr-options">
        <label class="dib-fr-check"><input type="checkbox" class="dib-fr-regex"> Regex</label>
        <label class="dib-fr-check"><input type="checkbox" class="dib-fr-case"> Case sensitive</label>
      </div>
      <div class="dib-fr-error"></div>
      <div class="dib-cpop-btns">
        <button class="dib-btn dib-btn-sm dib-btn-primary dib-cpop-save">Apply</button>
        <button class="dib-btn dib-btn-sm dib-cpop-cancel">Cancel</button>
      </div>`,
    onSave(popover) {
      const find          = popover.querySelector('.dib-fr-find').value;
      const replace       = popover.querySelector('.dib-fr-replace').value;
      const useRegex      = popover.querySelector('.dib-fr-regex').checked;
      const caseSensitive = popover.querySelector('.dib-fr-case').checked;
      const errEl         = popover.querySelector('.dib-fr-error');

      errEl.textContent = '';

      if (!find) {
        errEl.textContent = 'Find pattern cannot be empty.';
        return false;
      }

      if (useRegex) {
        try { new RegExp(find); } catch (e) {
          errEl.textContent = `Invalid regex: ${e.message}`;
          return false;
        }
      }

      onApply({ find, replace, useRegex, caseSensitive });
    },
    onReady(popover) {
      popover.querySelector('.dib-fr-find').focus();
    }
  });
}
