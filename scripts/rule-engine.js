/**
 * Rule Engine — applies a parsing rule to extracted PDF data and returns
 * an array of detected items: [{ name, [foundryField]: value, ... }]
 */

import { extractPages, parsePageString, mergePageItems, groupIntoRows, detectColumns, mapRowsToCells } from './pdf-parser.js';

/**
 * Apply a rule to a loaded PDF document.
 * @param {Object} rule
 * @param {Object} pdfDoc  — return value of loadPDF()
 * @returns {Promise<Array>}  detected item objects
 */
export async function applyRule(rule, pdfDoc) {
  const pageNums = parsePageString(rule.pages ?? '1', pdfDoc.numPages);
  const pages = await extractPages(pdfDoc, pageNums);
  let items = mergePageItems(pages);

  // Apply optional font filter
  items = applyFontFilter(items, rule.fontFilter);

  switch (rule.contentType) {
    case 'table':  return parseTable(items, rule);
    case 'column': return parseColumn(items, rule);
    case 'mixed':  return parseMixed(items, rule);
    default:       return parseTable(items, rule);
  }
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

    const item = extractAttributes(cells, rule.attributes, 'table', rule);
    if (item) results.push(item);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Column / prose parser
// ---------------------------------------------------------------------------

function parseColumn(items, rule) {
  if (!rule.rowDetectionPattern?.trim()) return [];

  // Build full text preserving approximate line breaks
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const fullText = buildFullText(sorted);

  const startRe = safeRegex(rule.rowDetectionPattern, 'gm');
  if (!startRe) return [];

  const matches = [...fullText.matchAll(startRe)];
  if (matches.length === 0) return [];

  const skipRe = rule.skipPattern?.trim() ? safeRegex(rule.skipPattern) : null;
  const results = [];

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = matches[i + 1]?.index ?? fullText.length;
    const chunk = fullText.slice(start, end);

    if (skipRe?.test(chunk)) continue;

    const context = { _raw: chunk, _match: matches[i] };
    const item = extractAttributes(context, rule.attributes, 'column', rule);
    if (item) results.push(item);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Mixed parser (table data + column descriptions)
// ---------------------------------------------------------------------------

function parseMixed(items, rule) {
  const cfg = rule.mixedConfig ?? {};
  const { tableXMin = 0, tableXMax = 9999, textXMin = 0, textXMax = 9999 } = cfg;

  const tableItems = items.filter(i => i.x >= tableXMin && i.x <= tableXMax);
  const textItems  = items.filter(i => i.x >= textXMin  && i.x <= textXMax);

  // Parse structure from table
  const tableResults = parseTable(tableItems, rule);

  // Optionally augment with prose descriptions keyed by item name
  if (rule.descriptionField && textItems.length > 0) {
    const rows = groupIntoRows(textItems);
    const fullText = buildFullText(rows.flatMap(r => r.items));

    if (rule.rowDetectionPattern?.trim()) {
      const startRe = safeRegex(rule.rowDetectionPattern, 'gm');
      if (startRe) {
        const matches = [...fullText.matchAll(startRe)];
        for (const tableItem of tableResults) {
          const nameVal = tableItem.name ?? '';
          const m = matches.find(m => m[0].toLowerCase().includes(nameVal.toLowerCase()));
          if (m) {
            const start = m.index;
            const end = (matches[matches.indexOf(m) + 1]?.index) ?? fullText.length;
            setNestedValue(tableItem, rule.descriptionField, fullText.slice(start, end).trim());
          }
        }
      }
    }
  }

  return tableResults;
}

// ---------------------------------------------------------------------------
// Attribute extraction
// ---------------------------------------------------------------------------

function extractAttributes(context, attributeRules, mode, rule) {
  const result = {};
  let hasData = false;

  for (const attrRule of attributeRules) {
    if (!attrRule.foundryField) continue;

    let value = '';

    if (mode === 'table') {
      // Prefer named column, fall back to column index
      if (attrRule.columnHeader) {
        value = context[attrRule.columnHeader] ?? context[`_col${attrRule.columnIndex}`] ?? '';
      } else if (attrRule.columnIndex != null && attrRule.columnIndex !== '') {
        value = context[`_col${attrRule.columnIndex}`] ?? '';
      }
    } else {
      // Column / raw text mode
      value = context._raw ?? '';
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

function buildFullText(items) {
  // Insert newlines between items whose Y differs significantly
  let text = '';
  let lastY = null;
  for (const item of items) {
    if (lastY !== null && Math.abs(item.y - lastY) > 6) text += '\n';
    else if (text && !text.endsWith('\n')) text += ' ';
    text += item.text;
    lastY = item.y;
  }
  return text;
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
