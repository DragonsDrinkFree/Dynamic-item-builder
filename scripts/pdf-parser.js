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
    // Build a table from this segment.
    // First verify the header row looks like genuine column headers (not a
    // sentence or page title that happens to have multiple items).
    const headerRow = seg.rows[0];
    if (!isPlausibleHeaderRow(headerRow)) {
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

  return { tables, proseRows };
}

/**
 * Returns true if a row looks like a genuine column-header row.
 * Real table headers have meaningful whitespace between items (column gaps).
 * Tightly-packed items are sentence/title fragments (e.g. "Part Six Equipment").
 */
function isPlausibleHeaderRow(row) {
  if (row.items.length < 2) return false;
  const sorted = [...row.items].sort((a, b) => a.x - b.x);
  let totalGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = sorted[i - 1].x + Math.max(sorted[i - 1].width ?? 0, 1);
    totalGap += Math.max(0, sorted[i].x - prevEnd);
  }
  return (totalGap / (sorted.length - 1)) >= 15;
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

// detectTextSections removed — text region scanning is not used
