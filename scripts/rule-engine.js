/**
 * Rule Engine — applies a parsing rule to extracted PDF data and returns
 * an array of detected items: [{ name, [foundryField]: value, ... }]
 */

import { extractPages, parsePageString, mergePageItems, detectColumns, mapRowsToCells, detectTables, applyManualHeaderOverrides, applyColumnMerges, applyColumnSplits } from './pdf-parser.js';

/**
 * Apply a rule to a loaded PDF document.
 * @param {Object} rule
 * @param {Object} pdfDoc  — return value of loadPDF()
 * @returns {Promise<Array>}  detected item objects
 */
export async function applyRule(rule, pdfDoc) {
  const pageNums = parsePageString(rule.pages ?? '1', pdfDoc.numPages);
  const pages    = await extractPages(pdfDoc, pageNums);

  // Region-based path: when the user has painted table regions, use the same
  // detectTables() pipeline as the Table Preview so column structure is identical.
  const tableRegions = (rule.regions ?? []).filter(r => r.type === 'table');
  if (tableRegions.length > 0) {
    return applyRuleWithRegions(rule, pages, tableRegions);
  }

  // Auto-detect fallback (no regions defined)
  let items = mergePageItems(pages);
  items = applyFontFilter(items, rule.fontFilter);
  return parseTable(items, rule);
}

/**
 * Region-aware extraction path.
 * Mirrors the collation logic in DynamicItemBuilderApp.#scanTableRegions so that
 * the column structure seen in Table Preview exactly matches what is extracted here.
 */
function applyRuleWithRegions(rule, pages, regions) {
  // Group regions by their `group` key, in page→Y order
  const groups = new Map();
  for (const region of [...regions].sort((a, b) => a.page - b.page || a.y - b.y)) {
    if (!groups.has(region.group)) groups.set(region.group, []);
    groups.get(region.group).push(region);
  }

  // Collect all tables across groups then re-index — mirrors
  // DynamicItemBuilderApp.#scanTableRegions so table IDs stay consistent
  // between the Table Preview and the extraction path.
  const allTables = [];
  for (const [, groupRegions] of groups) {
    let yOffset    = 0;
    const groupItems = [];

    for (const region of groupRegions) {
      const page = pages.find(p => p.pageNum === region.page);
      if (!page) continue;
      const regionItems = page.items.filter(item =>
        item.x >= region.x            &&
        item.x <= region.x + region.w &&
        item.y >= region.y            &&
        item.y <= region.y + region.h
      );
      for (const item of regionItems) {
        groupItems.push({ ...item, y: item.y + yOffset });
      }
      if (regionItems.length) {
        yOffset += Math.max(...regionItems.map(i => i.y)) + 50;
      }
    }

    if (!groupItems.length) continue;
    allTables.push(...detectTables(groupItems).tables);
  }

  // Re-index (must match DynamicItemBuilderApp.#scanTableRegions)
  allTables.forEach((t, i) => { t.id = `tbl-${i}`; });

  // Apply the same transforms as the Table Preview so attribute mappings align
  applyManualHeaderOverrides(allTables, rule.manualHeaders);
  applyColumnMerges(allTables, rule.columnMerges);
  applyColumnSplits(allTables, rule.columnSplits);

  const skipRe  = rule.skipPattern?.trim() ? safeRegex(rule.skipPattern) : null;
  const results = [];

  for (const table of allTables) {
    const colIndexMap = {};
    table.columns.forEach((col, i) => { colIndexMap[col.header] = i; });

    for (const row of table.rows) {
      // Skip injected header rows and section-label rows added by merge/split logic
      if (row._injected || row._sectionHeader) continue;

      const cells = {};
      for (const cell of row.cells) {
        cells[cell.column] = cell.value;
        cells[`_col${colIndexMap[cell.column] ?? 0}`] = cell.value;
      }

      const rowText = row.rawText ?? Object.values(cells).join(' ').trim();
      if (!rowText.trim()) continue;
      if (skipRe?.test(rowText)) continue;

      const item = extractAttributes(cells, rule.attributes, rule);
      if (item) results.push(item);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Font filter
// ---------------------------------------------------------------------------

function applyFontFilter(items, filter) {
  if (!filter) return items;
  const { name, minSize, maxSize } = filter;
  return items.filter(item => {
    if (name && !item.fontName.toLowerCase().includes(name.toLowerCase())) return false;
    if (minSize != null && minSize !== '' && item.fontSize < Number(minSize)) return false;
    if (maxSize != null && maxSize !== '' && item.fontSize > Number(maxSize)) return false;
    return true;
  });
}

// ---------------------------------------------------------------------------
// Table parser
// ---------------------------------------------------------------------------

function parseTable(items, rule) {
  const rows = groupIntoRows(items);
  if (rows.length === 0) return [];

  // Locate the header row.
  // A real column-header row has ≥2 items; single-item rows are usually page/section
  // titles (e.g. "WEAPONS") that appear above the actual header and must be skipped.
  let headerIdx = 0;
  if (rule.headerPattern?.trim()) {
    const re = safeRegex(rule.headerPattern, 'i');
    if (re) {
      // First pass: match only inside multi-item rows (true column headers)
      let found = rows.findIndex(row => row.items.length >= 2 && row.items.some(i => re.test(i.text)));
      // Second pass fallback: any row (covers edge-cases)
      if (found === -1) found = rows.findIndex(row => row.items.some(i => re.test(i.text)));
      if (found !== -1) headerIdx = found;
    }
  } else {
    // No pattern supplied — skip leading single-item title rows and use the
    // first row that has multiple items (i.e. looks like a column header row).
    const firstMulti = rows.findIndex(row => row.items.length >= 2);
    if (firstMulti !== -1) headerIdx = firstMulti;
  }

  const columns = detectColumns(rows[headerIdx]);
  const dataRows = rows.slice(headerIdx + 1);
  const cellRows = mapRowsToCells(dataRows, columns);

  const skipRe = rule.skipPattern?.trim() ? safeRegex(rule.skipPattern) : null;
  const results = [];

  for (const cells of cellRows) {
    const rowText = Object.values(cells).join(' ').trim();
    if (!rowText) continue;
    if (skipRe?.test(rowText)) continue;

    const item = extractAttributes(cells, rule.attributes, rule);
    if (item) results.push(item);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

function extractAttributes(context, attributeRules, rule) {
  const result = {};
  let hasData = false;

  for (const attrRule of attributeRules) {
    if (!attrRule.foundryField) continue;

    let value = '';

    // Prefer named column, fall back to column index
    if (attrRule.columnHeader) {
      value = context[attrRule.columnHeader] ?? context[`_col${attrRule.columnIndex}`] ?? '';
    } else if (attrRule.columnIndex != null && attrRule.columnIndex !== '') {
      value = context[`_col${attrRule.columnIndex}`] ?? '';
    }

    // Optionally refine with a regex
    if (attrRule.pattern?.trim()) {
      const re = safeRegex(attrRule.pattern, attrRule.flags ?? 'i');
      if (re) {
        const m = re.exec(String(value));
        value = m ? (attrRule.group != null ? m[Number(attrRule.group)] ?? '' : m[0]) : '';
      }
    }

    value = applyTransform(String(value ?? '').trim(), attrRule.transform);

    if (value !== '' && value !== null && value !== undefined) hasData = true;
    setNestedValue(result, attrRule.foundryField, value);
  }

  return hasData ? result : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeRegex(pattern, flags = '') {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function applyTransform(value, transform) {
  switch (transform) {
    case 'number':    return isNaN(Number(value)) ? 0 : Number(value);
    case 'lowercase': return value.toLowerCase();
    case 'uppercase': return value.toUpperCase();
    case 'boolean':   return ['true', 'yes', '1', 'x', '✓'].includes(value.toLowerCase());
    case 'trim':
    default:          return value.trim();
  }
}

function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur) || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
