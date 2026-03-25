/**
 * Cell operation utilities — CSS class application for cell selection,
 * overrides, test errors, and bulk column transforms.
 */

/**
 * Apply 'dib-cell-selected' CSS class to cells matching the current selection.
 * @param {Element}  rootEl   — app root element
 * @param {Array}    cellSel  — array of { ruleId, dibKey, field }
 */
export function applyCellSelClasses(rootEl, cellSel) {
  if (!rootEl) return;
  rootEl.querySelectorAll('.preview-td.dib-cell-selected')
    .forEach(td => td.classList.remove('dib-cell-selected'));
  for (const { ruleId, dibKey, field } of cellSel) {
    const row  = rootEl.querySelector(`.preview-tr[data-item-key="${CSS.escape(`${ruleId}::${dibKey}`)}"]`);
    const cell = row?.querySelector(`.preview-td[data-field="${CSS.escape(field)}"]`);
    cell?.classList.add('dib-cell-selected');
  }
}

/**
 * Apply 'dib-cell-error' / 'dib-row-error' CSS classes from test error data.
 * @param {Element} rootEl      — app root element
 * @param {Object}  testErrors  — { ruleId: { dibKey: { field: errMsg, _row?: msg } } }
 */
export function applyTestErrorClasses(rootEl, testErrors) {
  if (!rootEl) return;
  for (const [ruleId, items] of Object.entries(testErrors)) {
    for (const [dibKey, fields] of Object.entries(items)) {
      const rowKey = `${ruleId}::${dibKey}`;
      const row = rootEl.querySelector(`.preview-tr[data-item-key="${CSS.escape(rowKey)}"]`);
      if (!row) continue;
      if (fields._row) row.classList.add('dib-row-error');
      for (const [field, errMsg] of Object.entries(fields)) {
        if (field === '_row') continue;
        const cell = row.querySelector(`.preview-td[data-field="${CSS.escape(field)}"]`);
        if (cell) { cell.classList.add('dib-cell-error'); cell.title = errMsg; }
      }
    }
  }
}

/**
 * Apply 'dib-cell-overridden' CSS class for cells with manual overrides.
 * @param {Element} rootEl         — app root element
 * @param {Object}  cellOverrides  — { ruleId: { dibKey: { field: value } } }
 */
export function applyOverrideClasses(rootEl, cellOverrides) {
  if (!rootEl) return;
  for (const [ruleId, items] of Object.entries(cellOverrides)) {
    for (const [dibKey, fields] of Object.entries(items)) {
      const rowKey = `${ruleId}::${dibKey}`;
      const row = rootEl.querySelector(`.preview-tr[data-item-key="${CSS.escape(rowKey)}"]`);
      if (!row) continue;
      for (const field of Object.keys(fields)) {
        const cell = row.querySelector(`.preview-td[data-field="${CSS.escape(field)}"]`);
        cell?.classList.add('dib-cell-overridden');
      }
    }
  }
}

/**
 * Bulk-transform a column's values, storing results as cell overrides.
 *
 * @param {Object}   opts
 * @param {string}   opts.ruleId         — rule ID
 * @param {string}   opts.field          — field path (column)
 * @param {Array}    opts.items          — preview items for the rule
 * @param {Object}   opts.cellOverrides  — mutable overrides object
 * @param {Set}      opts.ignoredKeys    — set of dibKeys to skip
 * @param {Function} opts.transform      — (currentValue: string) => string|null
 * @returns {number} count of changed cells
 */
export function bulkTransformColumn({ ruleId, field, items, cellOverrides, ignoredKeys, transform }) {
  let changed = 0;
  items.forEach((item, idx) => {
    const dibKey = `_${idx}`;
    if (ignoredKeys.has(dibKey)) return;
    const flat = foundry.utils.flattenObject(item);
    const cur  = cellOverrides[ruleId]?.[dibKey]?.[field] !== undefined
      ? String(cellOverrides[ruleId][dibKey][field])
      : (flat[field] != null ? String(flat[field]) : null);
    if (cur === null) return;
    const next = transform(cur);
    if (next === null || next === cur) return;
    if (!cellOverrides[ruleId])         cellOverrides[ruleId] = {};
    if (!cellOverrides[ruleId][dibKey]) cellOverrides[ruleId][dibKey] = {};
    cellOverrides[ruleId][dibKey][field] = next;
    changed++;
  });
  return changed;
}
