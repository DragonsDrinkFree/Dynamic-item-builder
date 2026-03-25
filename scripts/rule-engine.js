/**
 * Rule Engine — applies a parsing rule to extracted PDF data and returns
 * an array of detected items: [{ name, [foundryField]: value, ... }]
 */

import { extractPages, parsePageString, mergePageItems, filterItemsToRegion, collectTableRegionItems, groupIntoRows, detectColumns, mapRowsToCells, applyManualHeaderOverrides, applyColumnMerges, applyColumnSplits, parseTextRegion, normalizeItemName } from './pdf-parser.js';
import { safeRegex, setNestedValue } from './utils.js';

// Run `DIB_RULE_ENGINE_VERSION` in the browser console to confirm this build is loaded.
globalThis.DIB_RULE_ENGINE_VERSION = 'multi-region-combine-v1';

/**
 * Debug helper — call `DIB_DEBUG_STREAM()` in the browser console after a
 * preview run to inspect the text stream that was built from combined regions.
 *
 * `DIB_DEBUG_STREAM(true)` prints a compact numbered list of rows.
 * `DIB_DEBUG_STREAM(false)` (default) prints a full table with font metadata.
 */
globalThis._DIB_lastStreamDebug = null;
globalThis.DIB_DEBUG_STREAM = function(compact = false) {
  const d = globalThis._DIB_lastStreamDebug;
  if (!d) { console.warn('[DIB] No stream data yet — run a preview first.'); return; }
  console.group(`[DIB] Text stream — ${d.regionCount} region(s), ${d.rows.length} row(s), ${d.items.length} item(s)`);
  console.log('Regions (in processing order):', d.regionOrder);
  if (compact) {
    d.rows.forEach((r, i) => console.log(`  row ${String(i).padStart(3, '0')}  fakeY=${r.fakeY}  "${r.text}"`));
  } else {
    console.table(d.rows.map(r => ({ row: r.index, fakeY: r.fakeY, region: r.regionLabel, text: r.text, fontSize: r.fontSize, fontName: r.fontName })));
  }
  console.group(`Parsed entries (${d.entries.length})`);
  d.entries.forEach((entry, i) => {
    console.group(`Entry ${i}: "${entry._textName ?? '(no name)'}"`);
    for (const [k, v] of Object.entries(entry)) {
      if (k.endsWith('__html')) continue;
      const display = typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '…' : v;
      console.log(`  ${k}:`, display);
    }
    console.groupEnd();
  });
  console.groupEnd();
  console.groupEnd();
};

/**
 * Apply a rule to a loaded PDF document.
 * @param {Object} rule
 * @param {Object} pdfDoc  — return value of loadPDF()
 * @returns {Promise<Array>}  detected item objects
 */
export async function applyRule(rule, pdfDoc) {
  const pageNums = parsePageString(rule.pages ?? '1', pdfDoc.numPages);
  const pages    = await extractPages(pdfDoc, pageNums);

  // Region-based path: when the user has painted regions, use the same
  // detectTables() pipeline as the Table Preview so column structure is identical.
  const tableRegions = (rule.regions ?? []).filter(r => r.type === 'table');
  const textRegions  = (rule.regions ?? []).filter(r => r.type === 'text');

  if (tableRegions.length > 0 || textRegions.length > 0) {
    return applyRuleWithRegions(rule, pages, tableRegions, textRegions);
  }

  // Auto-detect fallback (no regions defined)
  let items = mergePageItems(pages);
  items = applyFontFilter(items, rule.fontFilter);
  return parseTable(items, rule);
}

/**
 * Region-aware extraction path.
 * Handles table regions (existing behaviour) and text regions (new).
 * Text regions are parsed into a name-keyed map and either:
 *   - injected as virtual column values into matched table rows, or
 *   - used to create standalone items when region.standalone === true.
 */
function applyRuleWithRegions(rule, pages, regions, textRegions = []) {
  const { tables: allTables } = collectTableRegionItems(pages, regions);

  // Apply the same transforms as the Table Preview so attribute mappings align
  applyManualHeaderOverrides(allTables, rule.manualHeaders);
  applyColumnMerges(allTables, rule.columnMerges);
  applyColumnSplits(allTables, rule.columnSplits);

  // Parse text regions → build per-region name→entry maps
  // regionTextMaps: Map<regionId, Map<normalizedName, entryObject>>
  const regionTextMaps = new Map();
  const standaloneTextItems = [];
  const textFields = rule.textFields?.length ? rule.textFields : null;

  // Combine all non-standalone text regions into one continuous stream so that
  // multi-column stat blocks and multi-region prose descriptions flow as a single
  // sequence. Regions are processed in draw order (per page) so the user controls
  // the reading order by painting boxes in the intended sequence.
  const nonStandaloneRegions = textRegions.filter(r => !r.standalone);
  const standaloneRegions    = textRegions.filter(r =>  r.standalone);

  if (nonStandaloneRegions.length > 0) {
    // Sort by page only — preserve draw order within the same page so that
    // multi-column text regions flow in the order the user painted them.
    const sorted = [...nonStandaloneRegions].sort((a, b) => a.page - b.page);

    // Group each region's items into rows individually (correct intra-region
    // ordering), then stamp sequential fake-Y values so that downstream
    // groupIntoRows() sees one flat, correctly-ordered stream regardless of
    // PDF coordinate direction or overlapping page coordinates between regions.
    const allItems = [];
    let fakeY = 0;
    const _dbgRows = [];
    const _dbgRegionOrder = [];
    let _dbgRowIdx = 0;
    for (const region of sorted) {
      const page = pages.find(p => p.pageNum === region.page);
      if (!page) continue;
      const regionItems = filterItemsToRegion(page.items, region);
      const regionLabel = `p${region.page} (${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.w)}×${Math.round(region.h)})`;
      _dbgRegionOrder.push(regionLabel);
      const rows = groupIntoRows(regionItems);
      for (const row of rows) {
        const sorted2 = [...row.items].sort((a, b) => a.x - b.x);
        const rowText = sorted2.map(i => i.text).join(' ').trim();
        const rep = sorted2[0];
        _dbgRows.push({ index: _dbgRowIdx++, fakeY, regionLabel, text: rowText, fontSize: rep?.fontSize ?? '', fontName: rep?.fontName ?? '' });
        for (const item of row.items) {
          allItems.push({ ...item, y: fakeY });
        }
        fakeY += 100;
      }
    }
    if (allItems.length) {
      const entries = parseTextRegion(allItems, rule);
      globalThis._DIB_lastStreamDebug = { regionCount: sorted.length, regionOrder: _dbgRegionOrder, rows: _dbgRows, items: allItems, entries };
      const nameMap = new Map();
      for (const entry of entries) {
        nameMap.set(normalizeItemName(entry._textName ?? ''), entry);
      }
      regionTextMaps.set('_combined', nameMap);
    }
  }

  for (const region of standaloneRegions) {
    const page = pages.find(p => p.pageNum === region.page);
    if (!page) continue;
    const regionItems = filterItemsToRegion(page.items, region);
    if (!regionItems.length) continue;
    const entries = parseTextRegion(regionItems, rule);
    standaloneTextItems.push(...entries);
  }

  // Virtual-column attributes: attributes with source === 'textRegion'
  const virtualAttrs  = (rule.attributes ?? []).filter(a => a.isVirtual && a.textRegionId);
  const regularAttrs  = (rule.attributes ?? []).filter(a => !a.isVirtual);

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

      const item = extractAttributes(cells, regularAttrs);
      if (!item) continue;

      // Inject text region data into matched table rows
      if (regionTextMaps.size > 0) {
        const nameAttr = regularAttrs.find(a => a.foundryField === 'name');
        const rowName  = nameAttr ? (cells[nameAttr.columnHeader] ?? '') : '';
        const normName = normalizeItemName(rowName);

        if (textFields) {
          for (const [, nameMap] of regionTextMaps) {
            const matched = findTextMatch(normName, nameMap);
            if (matched) applyTextFieldValues(item, matched, textFields);
          }
        } else if (virtualAttrs.length) {
          // Old path: virtual attribute column mapping
          for (const vAttr of virtualAttrs) {
            const nameMap = regionTextMaps.get(vAttr.textRegionId) ?? regionTextMaps.get('_combined');
            if (!nameMap) continue;
            const matched = findTextMatch(normName, nameMap);
            if (!matched) continue;
            const rawValue = matched[vAttr.columnHeader] ?? '';
            const value = applyTransform(String(rawValue).trim(), vAttr.transform);
            if (value !== '') setNestedValue(item, vAttr.foundryField, value);
          }
        }
      }

      results.push(item);
    }
  }

  // Text-region-as-items path: when no table produced results, use text entries directly.
  // Each entry in regionTextMaps becomes its own item via foundryAttr mappings.
  if (results.length === 0 && regionTextMaps.size > 0 && textFields?.length) {
    for (const [, nameMap] of regionTextMaps) {
      for (const [, entry] of nameMap) {
        const item = {};
        let hasData = applyTextFieldValues(item, entry, textFields);
        hasData = applyTextFieldSplitValues(item, entry, rule) || hasData;
        if (hasData) {
          const rowText = Object.values(entry).join(' ');
          if (skipRe?.test(rowText)) continue;
          results.push(item);
        }
      }
    }
  }

  // Standalone text-only items
  if (standaloneTextItems.length) {
    for (const entry of standaloneTextItems) {
      const item = {};
      let hasData = false;

      if (textFields) {
        hasData = applyTextFieldValues(item, entry, textFields);
        hasData = applyTextFieldSplitValues(item, entry, rule) || hasData;
      } else {
        // Old path: virtual attrs
        const standaloneRegionIds = new Set(textRegions.filter(r => r.standalone).map(r => r.id));
        const textOnlyAttrs = (rule.attributes ?? []).filter(
          a => a.isVirtual && standaloneRegionIds.has(a.textRegionId)
        );
        for (const attr of textOnlyAttrs) {
          if (!attr.foundryField) continue;
          const rawValue = entry[attr.columnHeader] ?? '';
          const value = applyTransform(String(rawValue).trim(), attr.transform);
          if (value !== '') { hasData = true; setNestedValue(item, attr.foundryField, value); }
        }
      }

      if (hasData) results.push(item);
    }
  }

  return results;
}

/**
 * Apply text field values from a parsed entry onto an item object.
 * Handles HTML-enriched values and tracks them in __htmlFields.
 *
 * @param {Object} item       — target item to populate
 * @param {Object} entry      — parsed text entry (keyed by field.id)
 * @param {Array}  textFields — rule.textFields definitions
 * @returns {boolean} true if any value was set
 */
function applyTextFieldValues(item, entry, textFields) {
  let hasData = false;
  for (const field of textFields) {
    if (!field.foundryAttr) continue;
    const htmlVal  = entry[field.id + '__html'] ?? null;
    const rawValue = htmlVal ?? String(entry[field.id] ?? '').trim();
    if (rawValue !== '') { hasData = true; setNestedValue(item, field.foundryAttr, rawValue); }
    if (htmlVal) {
      if (!item.__htmlFields) item.__htmlFields = {};
      item.__htmlFields[field.foundryAttr] = htmlVal;
    }
  }
  return hasData;
}

/**
 * Apply split field values from rule.textFieldSplits / rule.textFieldSplitAttrs onto an item.
 * @returns {boolean} true if any value was set
 */
function applyTextFieldSplitValues(item, entry, rule) {
  const splits = rule.textFieldSplits;
  if (!splits) return false;
  let hasData = false;
  for (const [fieldId, delimiter] of Object.entries(splits)) {
    if (!delimiter) continue;
    const val = entry[fieldId] ?? '';
    if (!val) continue;
    const parts     = val.split(delimiter).map(p => p.trim());
    const splitAttrs = rule.textFieldSplitAttrs?.[fieldId] ?? [];
    for (let i = 0; i < parts.length; i++) {
      const attr = splitAttrs[i];
      if (attr && parts[i]) { setNestedValue(item, attr, parts[i]); hasData = true; }
    }
  }
  return hasData;
}

/**
 * Find a text entry in a name map by exact match then substring match.
 * @param {string} normName  normalizeItemName() result for the table row
 * @param {Map}    nameMap   Map<normalizedName, entry>
 */
function findTextMatch(normName, nameMap) {
  if (!normName) return null;
  // Exact match
  if (nameMap.has(normName)) return nameMap.get(normName);
  // Substring: table name contained in text name, or vice versa
  for (const [key, entry] of nameMap) {
    if (key.includes(normName) || normName.includes(key)) return entry;
  }
  return null;
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

    const item = extractAttributes(cells, rule.attributes);
    if (item) results.push(item);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

function extractAttributes(context, attributeRules) {
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

function applyTransform(value, transform) {
  switch (transform) {
    case 'number':    { const n = Number(value); return isNaN(n) ? value : n; }
    case 'lowercase': return value.toLowerCase();
    case 'uppercase': return value.toUpperCase();
    case 'boolean':   return ['true', 'yes', '1', 'x', '✓'].includes(value.toLowerCase());
    case 'trim':
    default:          return value.trim();
  }
}

