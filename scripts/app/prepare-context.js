/**
 * Pure data transforms used by _prepareContext and #buildTextScanContext
 * to build the template context.
 */

import { normalizeItemName } from '../pdf-parser.js';
import { getIgnoredKeySet } from '../utils.js';

/**
 * Build the preview summary array used by the Item Preview tab.
 *
 * @param {Array}  rules          — all rules
 * @param {Object} preview        — { ruleId: items[] }
 * @param {Object} cellOverrides  — { ruleId: { dibKey: { field: value } } }
 * @returns {Array} preview summary entries
 */
export function buildPreviewSummary(rules, preview, cellOverrides) {
  return rules.map(r => {
    const cols = r.attributes
      .filter(a => a.foundryField)
      .map(a => ({ field: a.foundryField, label: a.foundryField.split('.').pop() }));
    // Append manual (unlinked) columns chosen by the user
    const linkedFields = new Set(cols.map(c => c.field));
    for (const path of (r.manualColumns ?? [])) {
      if (!linkedFields.has(path)) {
        cols.push({ field: path, label: path.split('.').pop(), manual: true });
        linkedFields.add(path);
      }
    }
    // Append text fields that have a Foundry attribute mapped
    for (const tf of (r.textFields ?? [])) {
      if (tf.foundryAttr && !linkedFields.has(tf.foundryAttr)) {
        cols.push({ field: tf.foundryAttr, label: tf.header || tf.foundryAttr.split('.').pop() });
        linkedFields.add(tf.foundryAttr);
      }
    }

    const ignoredKeys = getIgnoredKeySet(r);
    const rawItems    = preview[r.id] ?? null;
    const flatItems   = rawItems
      ? rawItems
          .map((item, idx) => {
            const dibKey = `_${idx}`;
            const flat   = foundry.utils.flattenObject(item);
            flat._dibKey = dibKey;
            flat._key    = `${r.id}::${dibKey}`;
            // Auto-flag cells that carry HTML from format rules so the template renders them safely
            if (item.__htmlFields) {
              for (const hField of Object.keys(item.__htmlFields)) flat[`__html__${hField}`] = true;
            }
            // Apply any per-cell value overrides
            const ovr = cellOverrides[r.id]?.[dibKey] ?? {};
            for (const [ovField, ovVal] of Object.entries(ovr)) flat[ovField] = ovVal;
            return flat;
          })
          .filter(item => !ignoredKeys.has(item._dibKey))
      : null;

    const ignoredFlatItems = (r.ignoredItems ?? []).map(item => {
      const flat   = foundry.utils.flattenObject(item);
      flat._dibKey = item._dibKey;
      flat._key    = `${r.id}::${item._dibKey}`;
      return flat;
    });

    return { id: r.id, name: r.name, columns: cols, items: flatItems, ignoredItems: ignoredFlatItems };
  });
}

/**
 * Enrich text entries with match status relative to table scan data.
 * Each entry gets `_matchStatus` ('matched' | 'unmatched' | 'unlinked')
 * and `_cols` (column values mapped from the entry).
 *
 * @param {Array}  entries   — raw parsed text entries
 * @param {Array}  columns   — column definitions [{ id, header, isJoinTarget }]
 * @param {Object} scanData  — table scan data (may be null)
 * @param {Object} nameAttr  — the 'name' attribute rule (may be null)
 * @returns {Array} enriched entries
 */
export function enrichTextEntries(entries, columns, scanData, nameAttr) {
  const hasTables = (scanData?.tables?.length ?? 0) > 0;
  const joinField = columns.find(c => c.isJoinTarget);
  const canMatch  = hasTables && (joinField || nameAttr);

  return entries.map(entry => {
    let matchStatus = 'unlinked';
    if (canMatch) {
      const normEntry = normalizeItemName(entry._textName ?? '');
      let found = false;
      for (const table of (scanData?.tables ?? [])) {
        for (const row of table.rows) {
          if (row._injected || row._sectionHeader) continue;
          const nameCell = nameAttr
            ? row.cells.find(c => c.column === nameAttr.columnHeader)
            : row.cells[0];
          if (!nameCell) continue;
          const normRow = normalizeItemName(nameCell.value);
          const shorter = normRow.length <= normEntry.length ? normRow : normEntry;
          const longer  = normRow.length <= normEntry.length ? normEntry : normRow;
          const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (normRow === normEntry ||
              (shorter.includes(' ') && new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(longer))) {
            found = true; break;
          }
        }
        if (found) break;
      }
      matchStatus = found ? 'matched' : 'unmatched';
    }
    const _cols = columns.map(c => ({ id: c.id, header: c.header, isJoinTarget: c.isJoinTarget, value: entry[c.id] ?? '' }));
    return { ...entry, _matchStatus: matchStatus, _cols };
  });
}

/**
 * Aggregate unique fonts across text regions into sorted lists for dropdowns.
 *
 * @param {Object} textRegionFonts — { regionId: [{ fontSize, fontName }] }
 * @param {Array}  textRegions     — region objects with .id
 * @returns {{ availableFonts, availableFontSizes, availableFontNames }}
 */
export function aggregateTextFonts(textRegionFonts, textRegions) {
  const fontSet = new Map();
  for (const region of textRegions) {
    for (const f of (textRegionFonts[region.id] ?? [])) {
      const key = `${f.fontSize}::${f.fontName}`;
      if (!fontSet.has(key)) fontSet.set(key, f);
    }
  }
  const availableFonts     = [...fontSet.values()].sort((a, b) => b.fontSize - a.fontSize || a.fontName.localeCompare(b.fontName));
  const availableFontSizes = [...new Set(availableFonts.map(f => String(f.fontSize)))];
  const availableFontNames = [...new Set(availableFonts.map(f => f.fontName))];
  return { availableFonts, availableFontSizes, availableFontNames };
}
