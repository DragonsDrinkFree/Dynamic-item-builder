/**
 * PDF Parser — loads PDF.js from CDN and provides text extraction utilities.
 *
 * Text items are returned with:
 *   { text, x, y, width, height, fontName, fontSize, page }
 *
 * Coordinates are in PDF user units with Y flipped so (0,0) is top-left.
 */

// Set to true in the browser console to log table-detection internals:
//   DIB_DEBUG = true
// Check: globalThis.DIB_DEBUG

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
 * Render a single PDF page onto a <canvas> element, scaling to fit a target
 * pixel width (defaults to the page's natural width at 1× scale).
 * Returns { scale, pdfWidth, pdfHeight } so callers can convert between
 * screen pixels and PDF coordinate space.
 *
 * @param {Object}            pdfDoc      loadPDF() result
 * @param {number}            pageNum     1-based page number
 * @param {HTMLCanvasElement} canvas      target canvas element
 * @param {number|null}       targetWidth optional pixel width to scale into
 */
export async function renderPageToCanvas(pdfDoc, pageNum, canvas, targetWidth = null) {
  const page         = await pdfDoc.getPage(pageNum);
  const baseViewport = page.getViewport({ scale: 1.0 });
  const scale        = targetWidth ? targetWidth / baseViewport.width : 1.0;
  const viewport     = page.getViewport({ scale });

  canvas.width  = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;

  return {
    scale,
    pdfWidth:  baseViewport.width,
    pdfHeight: baseViewport.height
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
 * Find X positions where a gap divides rows into separate side-by-side tables.
 *
 * Unlike a simple "largest gap" approach, this uses row-coverage asymmetry:
 * a true inter-table gap will have many rows with items on only one side,
 * whereas a within-table gap (e.g. a wide Name column) has rows spanning both
 * sides.
 *
 * Algorithm:
 *   1. Split rows into Y-continuous segments (Y gap > 20 pts) so that page
 *      headers/footers between tables don't pollute the analysis.
 *   2. In each Y-segment, cluster all item X positions into column bands
 *      (items within 15 pts = same column center).
 *   3. For each inter-column gap ≥ 30 pts (left-to-right), count how many
 *      rows have items only left, only right, or on both sides of the gap.
 *   4. If asymmetric rows ≥ 2 AND ≥ 25 % of total rows in the segment, this
 *      gap is a table boundary — record its midpoint and stop (recursion in
 *      detectTables() handles further splits within each band).
 *
 * @param {Array}  rows  output of groupIntoRows
 * @returns {number[]}   sorted divider X positions
 */
function findXGroupDividers(rows) {
  if (!rows.length) return [];

  // Step 1: split into Y-continuous segments
  const yGroups = [[rows[0]]];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].y - rows[i - 1].y > 20) yGroups.push([]);
    yGroups[yGroups.length - 1].push(rows[i]);
  }

  const dividers = [];

  for (const grp of yGroups) {
    // Only consider rows with ≥2 items (single-item rows are titles/prose)
    const tRows = grp.filter(r => r.items.length >= 2);
    if (tRows.length < 3) continue;

    // Step 2: cluster all X positions into column band centers
    const xs = tRows.flatMap(r => r.items.map(i => i.x)).sort((a, b) => a - b);
    const colCenters = [];
    let band = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] <= 15) {
        band.push(xs[i]);
      } else {
        colCenters.push(band.reduce((s, x) => s + x, 0) / band.length);
        band = [xs[i]];
      }
    }
    colCenters.push(band.reduce((s, x) => s + x, 0) / band.length);

    // Need at least 3 column bands to have a meaningful split
    if (colCenters.length < 3) continue;

    // Steps 3-4: scan gaps left-to-right, stop at first asymmetric one
    for (let i = 1; i < colCenters.length; i++) {
      const gap = colCenters[i] - colCenters[i - 1];
      if (gap < 30) continue;

      const splitX = (colCenters[i - 1] + colCenters[i]) / 2;
      let leftOnly = 0, rightOnly = 0, both = 0;

      for (const row of tRows) {
        const L = row.items.some(it => it.x <  splitX);
        const R = row.items.some(it => it.x >= splitX);
        if (L && R)   both++;
        else if (L)   leftOnly++;
        else          rightOnly++;
      }

      const oneSided = leftOnly + rightOnly;
      const total    = oneSided + both;

      // Require exclusive rows on BOTH sides — a sparse column (e.g. armour
      // names only on some rows) produces rightOnly > 0 but leftOnly = 0, which
      // is NOT a table boundary.  True side-by-side tables have rows that belong
      // exclusively to each side.
      if (leftOnly >= 1 && rightOnly >= 1 && oneSided >= 2 && oneSided / total >= 0.25) {
        dividers.push(splitX);
        break; // leftmost gap only; recursion handles further splits
      }
    }
  }

  return dividers.sort((a, b) => a - b);
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
export function detectTables(items, rowThreshold = 8) {
  if (globalThis.DIB_DEBUG) console.debug('DIB | detectTables called, items:', items.length);
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
    // A single-item row inside an active table segment may be a wrapped cell
    // (e.g. "Universal\nAutopistol") — but only if the lone item's X position
    // overlaps an item in the previous row (same column).  A title or caption
    // (e.g. "Weapons") centred over the table won't overlap and must fall
    // through to the normal segment-break logic so it doesn't absorb a
    // spanning header row into the same segment.
    if (kind === 'prose' && row.items.length === 1 && current?.kind === 'table') {
      const prevRow = current.rows[current.rows.length - 1];
      const item    = row.items[0];
      const iEnd    = item.x + (item.width ?? 0);
      const overlaps = prevRow.items.some(pi => {
        const piEnd = pi.x + (pi.width ?? 0);
        return item.x <= piEnd + 20 && iEnd >= pi.x - 20;
      });
      if (overlaps) {
        prevRow.items.push(...row.items);
        continue;
      }
      // No column overlap — fall through to normal processing (breaks segment).
    }
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

  if (globalThis.DIB_DEBUG) {
    console.debug(`DIB | detectTables: ${segments.length} segment(s)`, segments.map(s =>
      `[${s.kind} × ${s.rows.length} rows] first="${s.rows[0].items.map(i=>i.text).join(' | ')}"`));
  }

  for (const seg of segments) {
    if (seg.kind === 'prose' || seg.rows.length < 2) {
      if (globalThis.DIB_DEBUG) console.debug(`DIB | segment → prose/short (kind=${seg.kind}, rows=${seg.rows.length}):`, seg.rows.map(r => r.items.map(i=>i.text).join(' | ')));
      proseRows.push(...seg.rows);
      continue;
    }
    // Build a table from this segment.
    // First verify the header row looks like genuine column headers (not a
    // sentence or page title that happens to have multiple items).
    const headerRow = seg.rows[0];
    if (!isPlausibleHeaderRow(headerRow)) {
      if (globalThis.DIB_DEBUG) console.debug('DIB | segment → prose (header failed plausibility):', headerRow.items.map(i=>i.text).join(' | '));
      proseRows.push(...seg.rows);
      continue;
    }
    const baseColumns = detectColumns(headerRow);
    const dataRows    = seg.rows.slice(1);
    // Extend with synthetic columns for any consistent orphan X bands in data rows
    // (handles PDFs where the first column has no header label, e.g. item names).
    const columns  = addOrphanColumns(baseColumns, dataRows);
    const cellMaps = mapRowsToCells(dataRows, columns);

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

  // Merge consecutive tables that share the same column count into one table.
  // The header row of each merged-in table is injected as a section-label data
  // row so it remains visible in the scan preview and can be filtered by a
  // skipPattern if needed.
  if (tables.length > 1) {
    const merged = [];
    for (const table of tables) {
      const prev = merged[merged.length - 1];
      if (prev && prev.columns.length === table.columns.length) {
        // Inject the second table's header as a section-label row
        prev.rows.push({
          cells:         table.columns.map((col, i) => ({ column: prev.columns[i].header, value: col.header ?? '' })),
          rawText:       table.columns.map(c => c.header ?? '').join(' '),
          _sectionHeader: true
        });
        // Append data rows remapped to the first table's column names
        for (const row of table.rows) {
          prev.rows.push({
            ...row,
            cells: row.cells.map((cell, i) => ({ ...cell, column: prev.columns[i]?.header ?? cell.column }))
          });
        }
      } else {
        merged.push({ ...table });
      }
    }
    merged.forEach((t, i) => { t.id = `tbl-${i}`; });
    return { tables: merged, proseRows };
  }

  return { tables, proseRows };
}

/**
 * Apply manual column header overrides to a set of tables (in-place).
 * Mirrors DynamicItemBuilderApp.#applyManualHeaders so the rule engine can
 * use the same renamed column names when extracting attributes.
 */
export function applyManualHeaderOverrides(tables, manualHeaders) {
  if (!tables || !manualHeaders) return;
  for (const table of tables) {
    const override = manualHeaders[table.id];
    if (!override?.headers?.length) continue;
    const { headers, originalHeaders } = override;
    for (const row of table.rows) {
      row.cells = row.cells.map((cell, i) => ({ ...cell, column: headers[i] ?? cell.column }));
    }
    if (originalHeaders?.some(h => h)) {
      table.rows.unshift({
        cells:     headers.map((h, i) => ({ column: h, value: originalHeaders[i] ?? '' })),
        rawText:   originalHeaders.join(' '),
        _injected: true
      });
    }
    headers.forEach((h, i) => { if (table.columns[i]) table.columns[i].header = h; });
  }
}

/**
 * Split columns in-place according to rule.columnSplits.
 *
 * columnSplits: { [tableId]: { [columnHeader]: delimiter } }
 *
 * For each matching column the cell value is split by the delimiter.
 * The maximum number of parts across all rows in that column determines how
 * many sub-columns are created (e.g. "10/30/40" → 3 columns).
 * Rows with fewer parts have their last value duplicated to fill remaining
 * columns (so "None" with 2-part max → ["None", "None"]).
 */
/**
 * Merge pairs of adjacent columns (in-place).
 * columnMerges: { [tableId]: [[colHeaderA, colHeaderB], ...] }
 * Each pair is applied in order; the left column absorbs the right column's
 * values (non-empty values are joined with a space) and the right column is
 * removed. The merged column header is the two names joined with a space
 * (empty/unlabeled names are skipped).
 */
export function applyColumnMerges(tables, columnMerges) {
  if (!tables || !columnMerges) return;
  for (const table of tables) {
    const mergeList = columnMerges[table.id];
    if (!mergeList?.length) continue;
    for (const [colA, colB] of mergeList) {
      const idxA = table.columns.findIndex(c => c.header === colA);
      const idxB = table.columns.findIndex(c => c.header === colB);
      if (idxA === -1 || idxB === -1) continue;
      const [iLeft, iRight] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
      const mergedHeader = [table.columns[iLeft].header, table.columns[iRight].header]
        .filter(h => h.trim()).join(' ');
      table.columns[iLeft] = { ...table.columns[iLeft], header: mergedHeader };
      table.columns.splice(iRight, 1);
      for (const row of table.rows) {
        const vLeft  = row.cells[iLeft]?.value  ?? '';
        const vRight = row.cells[iRight]?.value ?? '';
        const merged = [vLeft, vRight].filter(v => v.trim()).join(' ');
        row.cells[iLeft] = { column: mergedHeader, value: merged };
        row.cells.splice(iRight, 1);
      }
    }
  }
}

export function applyColumnSplits(tables, columnSplits) {
  if (!tables || !columnSplits) return;
  for (const table of tables) {
    const tableSplits = columnSplits[table.id];
    if (!tableSplits) continue;
    for (const [colHeader, delimiter] of Object.entries(tableSplits)) {
      const colIdx = table.columns.findIndex(c => c.header === colHeader);
      if (colIdx === -1) continue;

      // Determine max number of parts across all rows
      let maxParts = 1;
      for (const row of table.rows) {
        const val = row.cells[colIdx]?.value ?? '';
        if (val === '') continue;
        maxParts = Math.max(maxParts, val.split(delimiter).length);
      }
      if (maxParts <= 1) continue;

      // Build new column descriptors
      const newCols = Array.from({ length: maxParts }, (_, i) => ({ header: `${colHeader} ${i + 1}` }));
      table.columns.splice(colIdx, 1, ...newCols);

      // Split each row's cell; duplicate last value when fewer parts than max
      for (const row of table.rows) {
        const val = row.cells[colIdx]?.value ?? '';
        const parts = val === ''
          ? Array(maxParts).fill('')
          : val.split(delimiter).map(p => p.trim());
        while (parts.length < maxParts) parts.push(parts[parts.length - 1] ?? '');
        row.cells.splice(colIdx, 1, ...parts.map((p, i) => ({ column: newCols[i].header, value: p })));
      }
    }
  }
}

/**
 * Returns true if a row looks like a genuine column-header row.
 * Real table headers have meaningful whitespace between items (column gaps).
 * Tightly-packed items are sentence/title fragments (e.g. "Part Six Equipment").
 */
function isPlausibleHeaderRow(row) {
  if (row.items.length < 2) {
    if (globalThis.DIB_DEBUG) console.debug('DIB | isPlausibleHeaderRow FAIL (< 2 items):', row.items.map(i => i.text));
    return false;
  }
  const sorted = [...row.items].sort((a, b) => a.x - b.x);
  let totalGap = 0;
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].x + Math.max(sorted[i - 1].width ?? 0, 1);
    const gap = Math.max(0, sorted[i].x - prevEnd);
    totalGap += gap;
    gaps.push({ between: `"${sorted[i-1].text}" → "${sorted[i].text}"`, gap: gap.toFixed(1) });
  }
  const avgGap = totalGap / (sorted.length - 1);
  const pass = avgGap >= 8;
  if (globalThis.DIB_DEBUG) {
    console.debug(`DIB | isPlausibleHeaderRow ${pass ? 'PASS' : 'FAIL'} (avgGap=${avgGap.toFixed(1)}, need ≥8)`,
      '\n  items:', sorted.map(i => `"${i.text}" x=${i.x.toFixed(1)} w=${(i.width??0).toFixed(1)}`),
      '\n  gaps:', gaps);
  }
  // Threshold: prose word-spacing is ~3-5 units; real column gaps are ≥8.
  return avgGap >= 8;
}

/**
 * Detect items in data rows that fall outside every detected column and cluster
 * them into synthetic columns (e.g. an unlabelled "Name" column to the left of
 * the first labelled header).  Only adds a column when the orphan band appears
 * in ≥ 30 % of data rows, so stray items don't pollute the structure.
 */
function addOrphanColumns(columns, dataRows) {
  if (!columns.length || !dataRows.length) return columns;

  const orphanXs = [];
  for (const row of dataRows) {
    for (const item of row.items) {
      if (!columns.some(c => item.x >= c.x - 15 && item.x < c.xEnd)) {
        orphanXs.push(item.x);
      }
    }
  }
  if (!orphanXs.length) return columns;

  // Cluster orphan X positions into bands (items within 15 pts = same column)
  orphanXs.sort((a, b) => a - b);
  const bands = [[orphanXs[0]]];
  for (let i = 1; i < orphanXs.length; i++) {
    if (orphanXs[i] - orphanXs[i - 1] <= 15) bands[bands.length - 1].push(orphanXs[i]);
    else bands.push([orphanXs[i]]);
  }

  // Keep only bands that appear in ≥ 30 % of data rows
  const minCount = Math.max(2, dataRows.length * 0.3);
  const synthXs = bands
    .filter(b => b.length >= minCount)
    .map(b => b.reduce((s, x) => s + x, 0) / b.length);
  if (!synthXs.length) return columns;

  const sortedCols = [...columns].sort((a, b) => a.x - b.x);
  const allCols = [...columns];
  for (const cx of synthXs) {
    const nextCol = sortedCols.find(c => c.x > cx);
    allCols.push({
      index: allCols.length,
      header: '',          // unlabelled — displayed as blank in the scan UI
      x: cx - 5,
      xEnd: nextCol ? nextCol.x : cx + 200
    });
  }
  return allCols.sort((a, b) => a.x - b.x).map((c, i) => ({ ...c, index: i }));
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


// ---------------------------------------------------------------------------
// Text region parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a name string for join/match comparisons.
 * Lowercases, trims, removes trailing colon/punctuation, collapses whitespace.
 */
export function normalizeItemName(str) {
  return String(str ?? '')
    .toLowerCase()
    .trim()
    .replace(/:+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Determine whether a PDF text item appears to be bold or a heading.
 *
 * @param {Object} item           PDF text item
 * @param {number} medianFontSize median fontSize of the whole block
 * @param {string} [rowBodyFont]  most-common font name in this row (body text font);
 *                                if provided and differs from item.fontName, the item
 *                                is treated as a heading (handles subset-embedded PDFs
 *                                where bold fonts have non-descriptive names)
 */
function isHeadingItem(item, medianFontSize, rowBodyFont) {
  if (/bold|heavy|black/i.test(item.fontName ?? '')) return true;
  if ((item.fontSize ?? 0) > medianFontSize + 1.5) return true;
  // Mixed-font heuristic: if this row has two distinct font names, the minority
  // font at the start of the row is the name/heading (inline bold pattern).
  if (rowBodyFont && item.fontName && item.fontName !== rowBodyFont) return true;
  return false;
}

/**
 * Parse a block of items that contains multiple named entries
 * (e.g. a page of Edges, armour descriptions, feats).
 *
 * Each entry starts when a heading item is detected (bold font or larger
 * fontSize), optionally refined by a user-supplied namePattern regex.
 *
 * Returns: [{ _textName, _textDescription, [labeledField]: value, ... }]
 *
 * @param {Object[]} items   PDF text items within a region
 * @param {Object}   config
 * @param {string}   [config.namePattern]  optional regex to detect name lines
 * @param {boolean}  [config.useFont=true] use font heuristics for name detection
 */
export function parseDescriptionBlock(items, config = {}) {
  const { namePattern, useFont = true } = config;
  const nameRe = namePattern?.trim() ? safeRegexText(namePattern, 'i') : null;

  const rows = groupIntoRows(items);
  if (!rows.length) return [];

  // Compute median fontSize for the whole block
  const allSizes = items.map(i => i.fontSize).filter(Boolean).sort((a, b) => a - b);
  const medianSize = allSizes[Math.floor(allSizes.length / 2)] ?? 0;

  const entries = [];
  let current = null;

  for (const row of rows) {
    if (!row.items.length) continue;

    const sortedItems = [...row.items].sort((a, b) => a.x - b.x);
    const rowText = sortedItems.map(i => i.text).join(' ').trim();
    if (!rowText) continue;

    let isNameRow = false;
    let nameText = '';
    let descStart = '';

    // Font heuristic: heading items at the start of the row
    if (useFont) {
      const firstX = sortedItems[0].x;

      // Compute the majority (body) font name in this row.
      // If the row has mixed fonts, the most-common font = body text;
      // items at the row start with a different font = heading/name.
      let rowBodyFont = null;
      if (sortedItems.length > 1) {
        const counts = {};
        for (const i of sortedItems) {
          if (i.fontName) counts[i.fontName] = (counts[i.fontName] ?? 0) + 1;
        }
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        // Only use the mixed-font heuristic when there are at least 2 fonts
        // AND the majority font appears more than once (avoids 1-item rows)
        if (sorted.length >= 2 && sorted[0][1] > 1) rowBodyFont = sorted[0][0];
      }

      const headingItems = sortedItems.filter(i =>
        isHeadingItem(i, medianSize, rowBodyFont) && Math.abs(i.x - firstX) < 20
      );

      if (headingItems.length > 0) {
        isNameRow = true;
        nameText = headingItems.map(i => i.text).join(' ').replace(/:$/, '').trim();
        // Remaining non-heading items on the same row start the description
        const restItems = sortedItems.filter(i => !headingItems.includes(i));
        descStart = restItems.map(i => i.text).join(' ').trim();
      }
    }

    // Regex fallback / override
    if (!isNameRow && nameRe) {
      const m = nameRe.exec(rowText);
      if (m) {
        isNameRow = true;
        nameText = (m[1] ?? m[0]).replace(/:$/, '').trim();
        descStart = rowText.slice(m.index + m[0].length).trim();
      }
    }

    if (isNameRow && nameText) {
      if (current) entries.push(current);
      current = { _textName: nameText, _textDescription: descStart };
    } else if (current) {
      // Check for a labeled field line: "FieldName: value text"
      const fieldMatch = /^([A-Z][A-Za-z][A-Za-z\s]{0,28}):\s+(.+)/.exec(rowText);
      if (fieldMatch) {
        const key = fieldMatch[1].trim();
        const val = fieldMatch[2].trim();
        // Avoid clobbering the reserved internal fields
        if (key !== '_textName' && key !== '_textDescription') {
          current[key] = current[key] ? current[key] + ' ' + val : val;
        } else {
          current._textDescription = current._textDescription
            ? current._textDescription + ' ' + rowText
            : rowText;
        }
      } else {
        current._textDescription = current._textDescription
          ? current._textDescription + ' ' + rowText
          : rowText;
      }
    }
  }

  if (current) entries.push(current);
  return entries;
}


// Regex helper local to text parsing (avoids coupling with rule-engine.js)
function safeRegexText(pattern, flags = '') {
  try { return new RegExp(pattern, flags); } catch { return null; }
}

/**
 * Apply strip rules to an array of parsed text entries in-place.
 * Each strip rule removes all matches of its pattern (case-insensitive) from _textName.
 * @param {Object[]} entries
 * @param {{pattern: string}[]} stripRules
 */
export function applyStripRules(entries, stripRules) {
  if (!stripRules?.length) return;
  for (const entry of entries) {
    for (const rule of stripRules) {
      try {
        const re = new RegExp(rule.pattern, 'gi');
        entry._textName = entry._textName.replace(re, '').trim();
      } catch { /* invalid regex — skip */ }
    }
  }
}

/**
 * Parse a block of PDF items using an ordered array of field definitions.
 *
 * Each field has:
 *   - fieldType: 'link' (defines entry boundaries) | 'data' (captures text)
 *   - rules: [{type:'target'|'strip', pattern}]
 *
 * The link field's target rules identify "start of new item" rows and split
 * the text into per-item blocks. Data fields then claim rows within each block
 * using their own target rules; a data field with no target rules is a catch-all
 * that receives all unclaimed rows.
 *
 * @param {Object[]} items   PDF text items within the region
 * @param {Object[]} fields  Ordered array of field definitions
 * @returns {Object[]} Array of entry objects keyed by field.id, plus _textName
 */
export function parseTextFields(items, fields) {
  if (!fields?.length || !items?.length) return [];

  const rows = groupIntoRows(items)
    .map(r => r.items.sort((a, b) => a.x - b.x).map(i => i.text).join(' ').trim())
    .filter(Boolean);
  if (!rows.length) return [];

  // Boundary field: join-target field if present, else first field that has target rules
  const boundaryField = fields.find(f => f.isJoinTarget) ?? fields.find(f =>
    f.rules.some(r => r.type === 'target' && r.pattern?.trim())
  ) ?? null;

  // Compile boundary regex from boundary field target rules
  const boundaryPatterns = (boundaryField?.rules ?? [])
    .filter(r => r.type === 'target' && r.pattern?.trim())
    .map(r => r.pattern.trim());
  const boundaryRe = boundaryPatterns.length
    ? safeRegexText(boundaryPatterns.join('|'), 'i')
    : null;

  // Split all rows into per-item blocks at boundary matches
  let blocks;
  if (boundaryRe) {
    blocks = [];
    let current = null;
    for (const row of rows) {
      if (boundaryRe.test(row)) {
        if (current) blocks.push(current);
        current = [row];
      } else if (current) {
        current.push(row);
      }
    }
    if (current) blocks.push(current);
    if (!blocks.length) return [];
  } else {
    blocks = [rows];
  }

  // Catch-all: non-boundary field with no target rules (gets all remaining text)
  const catchAll = fields.find(f =>
    f !== boundaryField &&
    !f.rules.some(r => r.type === 'target' && r.pattern?.trim())
  ) ?? null;

  return blocks.map(block => _extractTextFieldValues(block, fields, boundaryField, boundaryRe, catchAll));
}

function _extractTextFieldValues(block, fields, boundaryField, boundaryRe, catchAll) {
  const entry = {};
  let remaining = [...block];

  for (const field of fields) {
    const targets = field.rules
      .filter(r => r.type === 'target' && r.pattern?.trim())
      .map(r => r.pattern.trim());

    let rawValue;

    if (field === boundaryField && boundaryRe) {
      // Extract only the matched portion of the boundary row.
      // The text after the match is prepended to remaining so subsequent fields can claim it.
      const firstRow = block[0] ?? '';
      const m = boundaryRe.exec(firstRow);
      rawValue = m ? firstRow.slice(m.index, m.index + m[0].length) : firstRow;
      const afterMatch = m ? firstRow.slice(m.index + m[0].length).trim() : '';
      remaining = afterMatch ? [afterMatch, ...block.slice(1)] : block.slice(1);
    } else if (field === catchAll) {
      rawValue  = remaining.join(' ');
      remaining = [];
    } else if (targets.length) {
      const re      = safeRegexText(targets.join('|'), 'i');
      const claimed = remaining.filter(row => re?.test(row));
      remaining     = remaining.filter(row => !re?.test(row));
      rawValue      = claimed.join(' ');
    } else {
      rawValue = '';
    }

    // Apply strip rules
    rawValue = _applyFieldStrips(rawValue, field.rules);
    entry[field.id] = rawValue;
    if (field === boundaryField) entry._textName = rawValue;
  }

  return entry;
}

function _applyFieldStrips(text, rules) {
  for (const rule of rules.filter(r => r.type === 'strip' && r.pattern?.trim())) {
    try { text = text.replace(new RegExp(rule.pattern, 'gi'), '').trim(); } catch { /* skip */ }
  }
  return text.trim();
}
