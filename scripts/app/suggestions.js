/**
 * Attribute suggestion helpers — score column headers against Foundry item
 * attribute paths and suggest mappings.
 */

/**
 * Score how well a column header text matches an attribute path (0–1).
 * Handles camelCase paths, abbreviations, and parenthetical suffixes like "(GP)".
 */
export function scoreAttributeMatch(header, attrPath) {
  if (!header || !attrPath) return 0;
  const norm = s => s
    .replace(/([a-z])([A-Z])/g, '$1 $2')   // split camelCase → words
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')           // strip punctuation/parens
    .replace(/\s+/g, ' ')
    .trim();

  const h      = norm(header);
  const last   = norm(attrPath.split('.').pop());
  if (!h || !last) return 0;

  // Exact match
  if (h === last) return 1.0;

  const hWords = h.split(' ').filter(w => w.length >= 2);
  const lWords = last.split(' ').filter(w => w.length >= 1);
  if (!hWords.length || !lWords.length) return 0;

  // Every attribute word is covered by a header word (exact or shared prefix ≥3 chars)
  const allCovered = lWords.every(lw =>
    hWords.some(hw =>
      hw === lw ||
      (hw.length >= 3 && lw.startsWith(hw)) ||
      (lw.length >= 3 && hw.startsWith(lw))
    )
  );
  if (allCovered) return 0.9;

  // Partial word overlap score
  let matched = 0;
  for (const hw of hWords) {
    if (lWords.some(lw =>
      lw === hw ||
      (hw.length >= 3 && lw.startsWith(hw)) ||
      (lw.length >= 3 && hw.startsWith(lw))
    )) matched++;
  }
  if (!matched) return 0;
  return (matched / Math.max(hWords.length, lWords.length)) * 0.75;
}

/**
 * Compute suggested column→field mappings for a rule from its detected table
 * columns and the available item attribute paths.
 */
export function computeSuggestionsForRule(rule, scanData, attrPaths) {
  const allHeaders = [...new Set(
    scanData.tables.flatMap(t => t.columns.map(c => c.header)).filter(h => h)
  )];
  if (!allHeaders.length || !attrPaths.length) return [];

  const MIN_SCORE = 0.4;
  const suggestions = [];

  for (let i = 0; i < allHeaders.length; i++) {
    const header = allHeaders[i];
    let bestPath  = null;
    let bestScore = 0;

    for (const attr of attrPaths) {
      let score = scoreAttributeMatch(header, attr.path);
      // First column is almost always the item name — boost it
      if (i === 0 && attr.path === 'name') score = Math.max(score, 0.80);
      // Explicit "name" word in header → strong hint
      if (/\bname\b/i.test(header) && attr.path === 'name') score = Math.max(score, 0.95);
      if (score > bestScore) { bestScore = score; bestPath = attr.path; }
    }

    const threshold = i === 0 ? 0.5 : MIN_SCORE;
    if (!bestPath || bestScore < threshold) continue;

    const alreadyLinked = rule.attributes.some(a => a.columnHeader === header && a.foundryField);
    suggestions.push({
      columnHeader:   header,
      suggestedField: bestPath,
      score:          bestScore,
      scoreLabel:     bestScore >= 0.9 ? 'High' : bestScore >= 0.65 ? 'Med' : 'Low',
      scoreClass:     bestScore >= 0.9 ? 'high' : bestScore >= 0.65 ? 'med' : 'low',
      alreadyLinked
    });
  }

  return suggestions;
}

/**
 * Return a shallow copy of scanData with each column enriched with a `status`
 * field: 'linked' | 'suggested' | 'none'.
 */
export function enrichScanDataColumns(scanData, rule, suggestions) {
  if (!scanData) return null;
  return {
    ...scanData,
    tables: scanData.tables.map(table => ({
      ...table,
      columns: table.columns.map(col => {
        if (!col.header) return { ...col, status: 'none' };
        const linkedAttr = rule?.attributes.find(a => a.columnHeader === col.header && a.foundryField);
        if (linkedAttr) return { ...col, status: 'linked', mappedField: linkedAttr.foundryField };
        const match = suggestions.find(s => s.columnHeader === col.header);
        return { ...col, status: match ? 'suggested' : 'none', mappedField: match?.suggestedField ?? '' };
      })
    }))
  };
}
