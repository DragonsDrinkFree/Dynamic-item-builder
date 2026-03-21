/**
 * PDF Planner helpers — coordinate math, region data construction,
 * and region overlay element building.
 */

/**
 * Convert a mouse event's client coordinates to PDF user-space coordinates.
 *
 * @param {MouseEvent} event
 * @param {HTMLCanvasElement} canvas
 * @param {number} scale — current planner scale factor
 * @returns {{ x: number, y: number } | null}
 */
export function getPdfCoords(event, canvas, scale) {
  if (!canvas || !scale) return null;
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.max(0, (event.clientX - rect.left) / scale),
    y: Math.max(0, (event.clientY - rect.top)  / scale)
  };
}

/**
 * Create a new region data object from a drawn rectangle.
 *
 * @param {string} drawMode    — 'table' or 'text'
 * @param {Object} rect        — { x, y, w, h }
 * @param {number} plannerPage — current page number
 * @param {Array}  existingRegions — rule.regions array (for counting)
 * @returns {Object} new region object (with id, type, page, x, y, w, h, label)
 */
export function createRegionData(drawMode, rect, plannerPage, existingRegions) {
  const typeLabel = drawMode === 'table' ? 'Table' : 'Text';
  const count     = existingRegions.filter(r => r.type === drawMode).length + 1;

  const region = {
    id:    foundry.utils.randomID(),
    type:  drawMode,
    page:  plannerPage,
    x: Math.round(rect.x), y: Math.round(rect.y),
    w: Math.round(rect.w), h: Math.round(rect.h),
    label: `${typeLabel} ${count}`
  };

  if (drawMode === 'text') region.standalone = false;
  return region;
}

/**
 * Build region overlay DOM elements for the given regions.
 *
 * @param {Array}  regions       — filtered regions for the current page
 * @param {number} scale         — planner scale factor
 * @param {number} canvasWidth   — canvas pixel width
 * @param {number} canvasHeight  — canvas pixel height
 * @param {Object} [drawRect]    — in-progress draw rectangle (or null)
 * @param {string} [drawMode]    — current draw mode for the ghost region
 * @returns {DocumentFragment}   fragment containing all region divs
 */
export function buildRegionOverlay(regions, scale, canvasWidth, canvasHeight, drawRect, drawMode) {
  const frag = document.createDocumentFragment();

  const makeEl = (region, isDrawing = false) => {
    const div = document.createElement('div');
    div.className = `dib-region dib-region-${region.type}${isDrawing ? ' dib-region-drawing' : ''}`;
    if (!isDrawing) div.dataset.regionId = region.id;

    div.style.left   = `${(region.x * scale / canvasWidth)  * 100}%`;
    div.style.top    = `${(region.y * scale / canvasHeight) * 100}%`;
    div.style.width  = `${(region.w * scale / canvasWidth)  * 100}%`;
    div.style.height = `${(region.h * scale / canvasHeight) * 100}%`;

    if (!isDrawing) {
      div.innerHTML = `
        <span class="dib-region-label">${region.label ?? ''}</span>
        <button class="dib-region-delete" data-action="deleteRegion"
                data-region-id="${region.id}" title="Remove region">
          <i class="fas fa-times"></i>
        </button>`;
    }
    return div;
  };

  for (const region of regions) frag.appendChild(makeEl(region));

  // In-progress draw ghost
  if (drawRect && drawRect.w > 2 && drawRect.h > 2) {
    frag.appendChild(makeEl(
      { ...drawRect, type: drawMode ?? 'table', label: '' },
      true
    ));
  }

  return frag;
}

/**
 * Compute table region data from auto-detected tables and their source items.
 * Returns an array of region objects ready to push onto rule.regions.
 *
 * @param {Array}  tables          — detectTables() result tables
 * @param {Array}  allItems        — all PDF text items across pages
 * @param {Array}  pageNums        — valid page numbers
 * @param {number} existingCount   — current number of table regions (for labeling)
 * @returns {Array} new region objects
 */
export function computeAutoRegions(tables, allItems, pageNums, existingCount) {
  const regions = [];
  for (const table of tables) {
    const tableItems = allItems.filter(item =>
      table.rows.some(row => row.cells.some(c => c.value && item.text.includes(c.value)))
    );
    if (!tableItems.length) continue;

    const xs = tableItems.map(i => i.x);
    const ys = tableItems.map(i => i.y);
    const x  = Math.min(...xs) - 5;
    const y  = Math.min(...ys) - 5;
    const w  = Math.max(...tableItems.map(i => i.x + (i.width ?? 0))) - x + 5;
    const h  = Math.max(...ys) - y + 20;

    const page  = tableItems[0]?.page ?? pageNums[0];
    const count = existingCount + regions.length + 1;

    regions.push({
      id: foundry.utils.randomID(),
      type: 'table', group: `table-${count}`,
      page, x: Math.round(x), y: Math.round(y),
      w: Math.round(w), h: Math.round(h),
      label: `Table ${count}`
    });
  }
  return regions;
}
