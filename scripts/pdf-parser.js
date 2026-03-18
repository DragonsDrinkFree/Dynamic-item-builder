/**
 * PDF Parser — loads PDF.js from CDN and provides text extraction utilities.
 *
 * Text items are returned with:
 *   { text, x, y, width, height, fontName, fontSize, page }
 *
 * Coordinates are in PDF user units with Y flipped so (0,0) is top-left.
 */

const PDFJS_VERSION = '4.4.168';
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build`;

let _pdfjs = null;

async function getPdfjsLib() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import(`${PDFJS_CDN}/pdf.min.mjs`);
  _pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/pdf.worker.min.mjs`;
  return _pdfjs;
}

/**
 * Load a PDF from a File object.
 * Returns a lightweight wrapper around the PDF.js document.
 */
export async function loadPDF(file) {
  const lib = await getPdfjsLib();
  const buffer = await file.arrayBuffer();
  const doc = await lib.getDocument({ data: buffer }).promise;
  return {
    numPages: doc.numPages,
    /** @param {number} n 1-based page number */
    getPage: (n) => doc.getPage(n)
  };
}

/**
 * Extract all text items from a single page with position and font metadata.
 */
export async function extractPageText(pdfDoc, pageNum) {
  const page = await pdfDoc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 1.0 });
  const content = await page.getTextContent({ includeMarkedContent: false });

  const items = content.items
    .filter(item => item.str && item.str.trim())
    .map(item => {
      // PDF transform matrix: [a, b, c, d, e, f]
      // e = x position, f = y position (bottom-up in PDF space)
      const [, , , scaleY, x, y] = item.transform;
      const fontSize = Math.abs(scaleY);
      return {
        text: item.str,
        x: Math.round(x * 10) / 10,
        // Flip Y so 0 is the top of the page
        y: Math.round((viewport.height - y) * 10) / 10,
        width: Math.round(item.width * 10) / 10,
        height: Math.round(fontSize * 10) / 10,
        fontName: item.fontName ?? '',
        fontSize: Math.round(fontSize * 10) / 10,
        page: pageNum
      };
    });

  return {
    pageNum,
    items,
    width: viewport.width,
    height: viewport.height
  };
}

/**
 * Parse a page string like "1-25, 45,46, 50-60" into a sorted unique array
 * of 1-based page numbers, clamped to [1, maxPages].
 * @param {string} str
 * @param {number} [maxPages=Infinity]
 * @returns {number[]}
 */
export function parsePageString(str, maxPages = Infinity) {
  const nums = new Set();
  for (const part of String(str).split(',')) {
    const trimmed = part.trim();
    const dash = trimmed.indexOf('-');
    if (dash > 0) {
      const from = parseInt(trimmed.slice(0, dash), 10);
      const to   = parseInt(trimmed.slice(dash + 1), 10);
      if (!isNaN(from) && !isNaN(to)) {
        for (let p = from; p <= Math.min(to, maxPages); p++) {
          if (p >= 1) nums.add(p);
        }
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n >= 1 && n <= maxPages) nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/**
 * Extract text from an explicit list of page numbers.
 * @param {Object} pdfDoc
 * @param {number[]} pageNums  sorted array of 1-based page numbers
 * @returns {Promise<Array>}
 */
export async function extractPages(pdfDoc, pageNums) {
  const results = [];
  for (const p of pageNums) {
    if (p >= 1 && p <= pdfDoc.numPages) {
      results.push(await extractPageText(pdfDoc, p));
    }
  }
  return results;
}

/**
 * Merge items from multiple pages into a single flat array, offsetting each
 * page's Y coordinates so they are sequential rather than all starting at 0.
 * Without this, groupIntoRows incorrectly merges items from different pages
 * that happen to share the same page-relative Y position.
 *
 * @param {Array}  pages    return value of extractPages()
 * @param {number} pageGap  extra spacing to insert between pages (PDF units)
 * @returns {Array}  flat array of text items with globally-unique Y values
 */
export function mergePageItems(pages, pageGap = 50) {
  let yOffset = 0;
  const allItems = [];
  for (const page of pages) {
    for (const item of page.items) {
      allItems.push({ ...item, y: item.y + yOffset });
    }
    yOffset += page.height + pageGap;
  }
  return allItems;
}

/**
 * Group a flat array of text items into rows by Y proximity.
 * Items within `threshold` units of the same Y are considered one row.
 * Returns rows sorted top-to-bottom; items within each row sorted left-to-right.
 */
export function groupIntoRows(items, threshold = 4) {
  const rows = [];
  // Sort top-to-bottom first so we assign to the earliest matching row
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);

  for (const item of sorted) {
    const row = rows.find(r => Math.abs(r.y - item.y) <= threshold);
    if (row) {
      row.items.push(item);
      // Update representative Y toward the centroid
      row.y = row.items.reduce((s, i) => s + i.y, 0) / row.items.length;
    } else {
      rows.push({ y: item.y, items: [item] });
    }
  }

  for (const row of rows) {
    row.items.sort((a, b) => a.x - b.x);
  }

  return rows.sort((a, b) => a.y - b.y);
}

/**
 * Detect column descriptors from a header row.
 * Returns [{ index, header, x, xEnd }]
 *
 * xEnd is extended to the start of the next column so that data cells
 * whose text is wider than the header label still map correctly.
 * The last column gets a generous fixed extension.
 */
export function detectColumns(headerRow) {
  const items = [...headerRow.items].sort((a, b) => a.x - b.x);
  return items.map((item, i) => {
    const nextX = items[i + 1]?.x ?? (item.x + Math.max(item.width, 1) + 400);
    return {
      index: i,
      header: item.text.trim(),
      x: item.x,
      xEnd: nextX
    };
  });
}

/**
 * Find X positions where a consistent, dominant gap divides items into
 * separate horizontal groups (e.g., two tables placed side-by-side in the PDF).
 *
 * For each row with ≥3 items, the largest inter-item gap is recorded if it is
 * both ≥ minGap pts absolute AND ≥ minRatio × the average gap in that row.
 * If such a gap appears in ≥ minConsistency fraction of qualifying rows at
 * roughly the same X position, that X is returned as a divider.
 *
 * @param {Array}  rows            output of groupIntoRows
 * @param {number} minGap          minimum absolute gap (PDF points)
 * @param {number} minRatio        max-gap / avg-gap threshold
 * @param {number} minConsistency  fraction of qualifying rows required
 * @returns {number[]}  sorted divider X positions
 */
function findXGroupDividers(rows, minGap = 40, minRatio = 2.0, minConsistency = 0.3) {
  const candidates = [];

  for (const row of rows) {
    if (row.items.length < 3) continue;
    const sorted = [...row.items].sort((a, b) => a.x - b.x);

    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const prevEnd = sorted[i - 1].x + Math.max(sorted[i - 1].width ?? 1, 1);
      const gap     = sorted[i].x - prevEnd;
      gaps.push({ gap, midX: prevEnd + gap / 2 });
    }

    const avgGap  = gaps.reduce((s, g) => s + g.gap, 0) / gaps.length;
    const maxEntry = gaps.reduce((a, b) => (a.gap >= b.gap ? a : b));

    if (maxEntry.gap >= minGap && maxEntry.gap >= avgGap * minRatio) {
      candidates.push(maxEntry.midX);
    }
  }

  if (!candidates.length) return [];

  // Cluster nearby candidates
  candidates.sort((a, b) => a - b);
  const clusters = [];
  let cluster = [candidates[0]];
  for (let i = 1; i < candidates.length; i++) {
    if (candidates[i] - candidates[i - 1] <= 60) {
      cluster.push(candidates[i]);
    } else {
      clusters.push(cluster);
      cluster = [candidates[i]];
    }
  }
  clusters.push(cluster);

  const qualifyingCount = rows.filter(r => r.items.length >= 3).length;
  if (qualifyingCount === 0) return [];

  return clusters
    .filter(cl => cl.length / qualifyingCount >= minConsistency)
    .map(cl => cl.reduce((s, x) => s + x, 0) / cl.length)
    .sort((a, b) => a - b);
}

/**
 * Analyse a flat list of items and detect table structures.
 *
 * A "table" is a consecutive run of rows that each have ≥2 items whose
 * X positions are consistent with a shared column grid.
 *
 * Returns:
 *   { tables: [{id, headerText, headerPattern, columns, rows}], proseRows }
 *
 * Each table.rows entry: { cells: [{column, value}], rawText }
 */
export function detectTables(items, rowThreshold = 4) {
  const rows = groupIntoRows(items, rowThreshold);

  // Detect side-by-side tables: if a dominant X gap splits all rows into
  // consistent left/right bands, process each band independently.
  const xDividers = findXGroupDividers(rows);
  if (xDividers.length > 0) {
    const result = { tables: [], proseRows: [] };
    const boundaries = [-Infinity, ...xDividers, Infinity];
    for (let b = 0; b < boundaries.length - 1; b++) {
      const xMin = boundaries[b];
      const xMax = boundaries[b + 1];
      const bandItems = items.filter(i => i.x > xMin && i.x <= xMax);
      if (bandItems.length > 1) {
        const band = detectTables(bandItems, rowThreshold);
        result.tables.push(...band.tables);
        result.proseRows.push(...band.proseRows);
      }
    }
    result.tables.forEach((t, i) => { t.id = `tbl-${i}`; });
    return result;
  }

  // Partition rows into table/prose segments
  const segments = [];
  let current = null;
  for (const row of rows) {
    const kind = row.items.length >= 2 ? 'table' : 'prose';
    if (current?.kind === kind) {
      current.rows.push(row);
    } else {
      if (current) segments.push(current);
      current = { kind, rows: [row] };
    }
  }
  if (current) segments.push(current);

  const tables = [];
  const proseRows = [];

  for (const seg of segments) {
    if (seg.kind === 'prose' || seg.rows.length < 2) {
      proseRows.push(...seg.rows);
      continue;
    }
    // Build a table from this segment
    const headerRow = seg.rows[0];
    const columns   = detectColumns(headerRow);
    const dataRows  = seg.rows.slice(1);
    const cellMaps  = mapRowsToCells(dataRows, columns);

    tables.push({
      id: `tbl-${tables.length}`,
      headerText:    headerRow.items.map(i => i.text).join(' | '),
      headerPattern: headerRow.items.map(i => escapeRegex(i.text)).join('|'),
      columns:       columns.map(c => ({ header: c.header })),
      rows: cellMaps.map((map, i) => ({
        cells:   columns.map(c => ({ column: c.header, value: map[c.header] ?? '' })),
        rawText: dataRows[i].items.map(i => i.text).join(' ')
      }))
    });
  }

  return { tables, proseRows };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Given a set of rows and column descriptors, map each row's text items
 * to their respective column headers using X-overlap heuristics.
 * Returns an array of plain objects { [columnHeader]: cellText, _col0: ..., ... }
 */
export function mapRowsToCells(rows, columns) {
  return rows.map(row => {
    const cell = {};
    // Initialise empty strings for all columns
    for (const col of columns) {
      cell[col.header] = '';
      cell[`_col${col.index}`] = '';
    }

    for (const item of row.items) {
      const best = findBestColumn(item, columns);
      if (best) {
        cell[best.header] = (cell[best.header] ? cell[best.header] + ' ' : '') + item.text;
        cell[`_col${best.index}`] = cell[best.header];
      }
    }

    return cell;
  });
}

function findBestColumn(item, columns) {
  let best = null;
  let bestScore = -Infinity;

  for (const col of columns) {
    const itemEnd = item.x + Math.max(item.width, 1);
    // Overlap score (positive = overlap, negative = proximity)
    const overlap = Math.min(itemEnd, col.xEnd) - Math.max(item.x, col.x);
    const score = overlap > 0 ? overlap : -Math.abs(item.x - col.x);

    if (score > bestScore) {
      bestScore = score;
      best = col;
    }
  }

  return best;
}

/**
 * Detect narrative prose sections from a flat list of PDF text items.
 *
 * Recognises three row patterns:
 *   Header       — row has a notably larger font (≥1.2× body) OR is short,
 *                  bold, and fully upper-case (e.g. "WEAPON TYPES")
 *   entry-colon  — first item is bold and a ":" appears within the first
 *                  60 chars  →  "Name: description…"
 *   entry-italic — first item is bold+italic with no nearby colon
 *                  →  "***Flash grenades*** inflict …"
 *   body         — continuation text appended to the current entry
 *
 * Returns { sections: [{header, intro?, entries: [{name, description}]}] }
 */
export function detectTextSections(items, rowThreshold = 4) {
  if (!items.length) return { sections: [] };
  const rows = groupIntoRows(items, rowThreshold);

  // Mode font size = body baseline (most frequently occurring whole-point size)
  const freq = {};
  for (const item of items) {
    const s = Math.round(item.fontSize);
    freq[s] = (freq[s] ?? 0) + 1;
  }
  const bodySize = Number(
    Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10
  );

  const isBold   = item => /bold/i.test(item.fontName);
  const isItalic = item => /italic|oblique/i.test(item.fontName);
  const joined   = row  => row.items.map(i => i.text).join('');
  const spaced   = row  => row.items.map(i => i.text).join(' ').trim();

  const classify = row => {
    if (!row.items.length) return 'blank';
    const avgSize = row.items.reduce((s, i) => s + i.fontSize, 0) / row.items.length;
    const first   = row.items[0];
    const text    = spaced(row);

    // Header: meaningfully larger font
    if (avgSize >= bodySize * 1.2) return 'header';

    // Sub-header: bold + all-caps, short, few items
    if (
      isBold(first) &&
      row.items.length <= 6 &&
      text.length >= 2 && text.length <= 60 &&
      text.replace(/\s/g, '') === text.replace(/\s/g, '').toUpperCase()
    ) return 'header';

    // Named entry with colon: "Battle axe: A heavy axe…"
    if (isBold(first)) {
      const ci = joined(row).indexOf(':');
      if (ci > 0 && ci <= 60) return 'entry-colon';
      // Bold-italic lead: "***Flash grenades*** inflict…"
      if (isItalic(first)) return 'entry-italic';
    }

    return 'body';
  };

  const sections = [];
  let curSection = null;
  let curEntry   = null;

  const flushEntry = () => {
    if (!curEntry) return;
    curSection ??= { header: null, entries: [] };
    curSection.entries.push({
      name:        curEntry.name,
      description: curEntry.description.replace(/\s+/g, ' ').trim()
    });
    curEntry = null;
  };

  const flushSection = () => {
    flushEntry();
    if (curSection && (curSection.header || curSection.entries.length)) {
      sections.push(curSection);
    }
    curSection = null;
  };

  for (const row of rows) {
    const kind = classify(row);

    if (kind === 'header') {
      flushSection();
      curSection = { header: spaced(row), entries: [] };

    } else if (kind === 'entry-colon') {
      flushEntry();
      curSection ??= { header: null, entries: [] };
      const full = joined(row);
      const ci   = full.indexOf(':');
      curEntry = {
        name:        full.slice(0, ci).trim(),
        description: full.slice(ci + 1).trim()
      };

    } else if (kind === 'entry-italic') {
      flushEntry();
      curSection ??= { header: null, entries: [] };
      // Name = leading bold/italic items; description = remaining regular items
      let name = '', desc = '', pastName = false;
      for (const item of row.items) {
        if (!pastName && (isBold(item) || isItalic(item))) {
          name += item.text;
        } else {
          pastName = true;
          desc += item.text;
        }
      }
      curEntry = { name: name.trim(), description: desc.trim() };

    } else if (kind !== 'blank') {
      // Body: append to current entry or section preamble
      const text = spaced(row);
      if (curEntry) {
        curEntry.description += ' ' + text;
      } else {
        curSection ??= { header: null, entries: [] };
        curSection.intro = ((curSection.intro ?? '') + ' ' + text).trim();
      }
    }
  }

  flushSection();
  return { sections: sections.filter(s => s.header || s.entries.length) };
}
