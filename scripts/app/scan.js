/**
 * Scan pipeline — extracts table and text data from PDF pages using the
 * current rule's region definitions.  Pure data logic with no DOM access.
 */

import {
  extractPages, parsePageString, mergePageItems, filterItemsToRegion,
  collectTableRegionItems, detectTables,
  applyManualHeaderOverrides, applyColumnMerges, applyColumnSplits,
  parseTextRegion, extractRegionFonts, combineTextRegionItems
} from '../pdf-parser.js';
import { enrichTextEntries, aggregateTextFonts } from './prepare-context.js';

/**
 * Run the full scan pipeline for a given rule and PDF.
 *
 * @param {Object} pdf   — pdfDoc returned by loadPDF()
 * @param {Object} rule  — the active rule object
 * @returns {{ scanData: Object, textScanData: Object, textRegionFonts: Object }}
 */
export async function runScan(pdf, rule) {
  const pageNums = parsePageString(rule.pages, pdf.numPages);
  const pages    = await extractPages(pdf, pageNums);

  const tableRegions = (rule.regions ?? []).filter(r => r.type === 'table');
  const textRegions  = (rule.regions ?? []).filter(r => r.type === 'text');

  // Table scan
  let scanData;
  if (tableRegions.length > 0) {
    scanData = collectTableRegionItems(pages, tableRegions);
  } else {
    scanData = detectTables(mergePageItems(pages));
  }

  // Text scan — collect per-region font data for the UI dropdowns
  const textScanData    = {};
  const textRegionFonts = {};
  for (const region of textRegions) {
    const page = pages.find(p => p.pageNum === region.page);
    if (!page) continue;
    const regionItems = filterItemsToRegion(page.items, region);
    if (!regionItems.length) continue;
    textRegionFonts[region.id] = extractRegionFonts(regionItems);
  }

  // Combine non-standalone text regions into one stream
  const nonStandaloneRegions = textRegions.filter(r => !r.standalone);
  const standaloneRegions    = textRegions.filter(r =>  r.standalone);

  if (nonStandaloneRegions.length > 0) {
    const { items: allTextItems } = combineTextRegionItems(pages, nonStandaloneRegions);
    if (allTextItems.length) {
      textScanData['_combined'] = parseTextRegion(allTextItems, rule);
    }
  }

  for (const region of standaloneRegions) {
    const page = pages.find(p => p.pageNum === region.page);
    if (!page) continue;
    const regionItems = filterItemsToRegion(page.items, region);
    if (!regionItems.length) continue;
    textScanData[region.id] = parseTextRegion(regionItems, rule);
  }

  // Apply table transforms
  applyManualHeaderOverrides(scanData?.tables, rule?.manualHeaders);
  if (scanData?.tables) {
    if (rule?.columnMerges) applyColumnMerges(scanData.tables, rule.columnMerges);
    if (rule?.columnSplits) applyColumnSplits(scanData.tables, rule.columnSplits);
  }

  return { scanData, textScanData, textRegionFonts };
}

// ---------------------------------------------------------------------------
// Text preview context
// ---------------------------------------------------------------------------

/**
 * Apply text field splits to columns/entries in-place (preview use).
 * Replaces each split source column with N numbered sub-columns and populates
 * entry[fieldId__split__N] with the corresponding trimmed part.
 */
function applyTextFieldSplitsToContext(columns, entries, textFieldSplits, textFieldSplitAttrs) {
  for (const [fieldId, delimiter] of Object.entries(textFieldSplits)) {
    if (!delimiter) continue;
    const colIdx = columns.findIndex(c => c.id === fieldId);
    if (colIdx === -1) continue;

    let maxParts = 1;
    for (const entry of entries) {
      const val = entry[fieldId] ?? '';
      if (val) maxParts = Math.max(maxParts, val.split(delimiter).length);
    }
    if (maxParts <= 1) continue;

    const sourceCol   = columns[colIdx];
    const splitAttrs  = textFieldSplitAttrs?.[fieldId] ?? [];
    const subCols     = Array.from({ length: maxParts }, (_, i) => ({
      id:           `${fieldId}__split__${i}`,
      header:       `${sourceCol.header || 'Field'} ${i + 1}`,
      isJoinTarget: false,
      foundryAttr:  splitAttrs[i] ?? '',
      _splitFrom:   fieldId,
      _splitIndex:  i
    }));
    columns.splice(colIdx, 1, ...subCols);

    for (const entry of entries) {
      const val   = entry[fieldId] ?? '';
      const parts = val ? val.split(delimiter).map(p => p.trim()) : Array(maxParts).fill('');
      while (parts.length < maxParts) parts.push(parts[parts.length - 1] ?? '');
      for (let i = 0; i < maxParts; i++) entry[`${fieldId}__split__${i}`] = parts[i];
    }
  }
}

/**
 * Build the template context for the Text Preview tab.
 *
 * @param {Object} rule            — active rule
 * @param {Object} textScanData    — { '_combined': entries[], regionId: entries[] }
 * @param {Object} textRegionFonts — { regionId: [{ fontSize, fontName }] }
 * @param {Object} scanData        — table scan data (for match status)
 * @returns {Object|null}
 */
export function buildTextScanContext(rule, textScanData, textRegionFonts, scanData) {
  if (!rule) return null;
  const textRegions = (rule.regions ?? []).filter(r => r.type === 'text');
  if (!textRegions.length) return null;

  const textFields = rule.textFields?.length ? rule.textFields : null;
  const nameAttr   = (rule.attributes ?? []).find(a => a.foundryField === 'name' && !a.isVirtual);
  const allEntries = [];

  const nonStandaloneRegions = textRegions.filter(r => !r.standalone);
  const standaloneRegions    = textRegions.filter(r =>  r.standalone);

  if (nonStandaloneRegions.length > 0) {
    allEntries.push(...(textScanData['_combined'] ?? []));
  }
  for (const region of standaloneRegions) {
    allEntries.push(...(textScanData[region.id] ?? []));
  }

  // Build column definitions
  let columns;
  if (textFields) {
    columns = textFields.map(f => ({
      id:           f.id,
      header:       f.header || (f.isJoinTarget ? 'Name' : 'Data'),
      isJoinTarget: !!f.isJoinTarget,
      foundryAttr:  f.foundryAttr ?? ''
    }));
  } else {
    // Legacy path: fixed Name + Description columns plus any labeled keys
    const extraKeys = new Set();
    for (const e of allEntries) {
      for (const k of Object.keys(e)) { if (!k.startsWith('_')) extraKeys.add(k); }
    }
    columns = [
      { id: '_textName',        header: 'Name',        isJoinTarget: true,  foundryAttr: '' },
      ...[...extraKeys].map(k => ({ id: k, header: k, isJoinTarget: false, foundryAttr: '' })),
      { id: '_textDescription', header: 'Description',  isJoinTarget: false, foundryAttr: '' }
    ];
  }

  if (rule.textFieldSplits) applyTextFieldSplitsToContext(columns, allEntries, rule.textFieldSplits, rule.textFieldSplitAttrs);
  const enrichedEntries = enrichTextEntries(allEntries, columns, scanData, nameAttr);
  const { availableFonts, availableFontSizes, availableFontNames } = aggregateTextFonts(textRegionFonts, textRegions);

  return {
    columns,
    entries:           enrichedEntries,
    hasEntries:        enrichedEntries.length > 0,
    unmatchedCount:    enrichedEntries.filter(e => e._matchStatus === 'unmatched').length,
    availableFonts,
    availableFontSizes,
    availableFontNames
  };
}
