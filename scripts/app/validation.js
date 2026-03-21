/**
 * Item validation — test-run logic that validates parsed items against
 * Foundry's DataModel schema without actually creating documents.
 */

/**
 * Validate all preview items against the Foundry Item DataModel.
 *
 * @param {Array}    rules          — rule definitions
 * @param {Object}   preview        — { ruleId: parsedItems[] }
 * @param {Object}   cellOverrides  — { ruleId: { dibKey: { field: value } } }
 * @param {Function} ItemClass      — CONFIG.Item.documentClass
 * @returns {Object} testErrors — { ruleId: { dibKey: { _row: msg, field: msg } } }
 */
export function validateItems(rules, preview, cellOverrides, ItemClass) {
  const testErrors = {};

  for (const rule of rules) {
    const rawItems = preview[rule.id];
    if (!rawItems?.length || !rule.itemType) continue;
    const ignoredKeys = new Set((rule.ignoredItems ?? []).map(i => i._dibKey));

    for (const [idx, parsed] of rawItems.entries()) {
      const dibKey = `_${idx}`;
      if (ignoredKeys.has(dibKey)) continue;

      // Apply overrides so test reflects the same data that would be built
      const effective = Object.assign({}, parsed);
      const ovr = cellOverrides[rule.id]?.[dibKey] ?? {};
      for (const [f, v] of Object.entries(ovr)) effective[f] = v;

      // Build the same data structure as buildItems does
      const doc = {
        name: String(effective.name ?? 'Unnamed Item').trim() || 'Unnamed Item',
        type: rule.itemType, system: {}
      };
      for (const [field, value] of Object.entries(effective)) {
        if (['name', 'type', 'folder', '_key', '_dibKey'].includes(field)) continue;
        if (field.startsWith('_')) continue;
        if (field.startsWith('system.')) foundry.utils.setProperty(doc, field, value);
        else doc[field] = value;
      }

      // Test: construct in memory — triggers DataModel schema validation
      let rowError = null;
      let fieldErrors = {};
      try {
        new ItemClass(doc, { parent: null });
      } catch (err) {
        rowError = err.message ?? String(err);
        // DataModelValidationError exposes per-field errors
        const rawFields = err.fields ?? err.errors ?? {};
        for (const [fp, fe] of Object.entries(rawFields)) {
          const norm = fp.includes('.') ? fp : `system.${fp}`;
          fieldErrors[norm] = fe?.message ?? fe?.toString() ?? rowError;
        }
      }

      if (rowError) {
        if (!testErrors[rule.id])         testErrors[rule.id] = {};
        if (!testErrors[rule.id][dibKey]) testErrors[rule.id][dibKey] = {};
        testErrors[rule.id][dibKey]._row = rowError;

        // If no structured field map, isolate by testing each mapped field individually
        if (!Object.keys(fieldErrors).length) {
          for (const attr of rule.attributes) {
            if (!attr.foundryField) continue;
            const val = foundry.utils.getProperty(doc, attr.foundryField);
            if (val === undefined) continue;
            const minDoc = { name: doc.name, type: rule.itemType };
            foundry.utils.setProperty(minDoc, attr.foundryField, val);
            try { new ItemClass(minDoc, { parent: null }); }
            catch (fe) { fieldErrors[attr.foundryField] = fe.message ?? String(fe); }
          }
        }

        Object.assign(testErrors[rule.id][dibKey], fieldErrors);
      }
    }
  }

  return testErrors;
}
