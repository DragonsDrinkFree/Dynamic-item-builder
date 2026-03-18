/**
 * Item Builder — takes parsed item data and creates Foundry Item documents.
 */

/**
 * Create Foundry Items from an array of parsed attribute objects.
 *
 * Each object's keys follow these conventions:
 *   "name"           → item name
 *   "img"            → item image path
 *   "system.foo.bar" → nested path inside item.system
 *   "foo"            → top-level field (set directly on the Item)
 *
 * @param {Array<Object>} parsedItems
 * @param {string}        itemType     Foundry item type string (e.g. "weapon")
 * @param {Folder|null}   folder       Optional folder to place items in
 * @returns {Promise<Item[]>}
 */
export async function buildItems(parsedItems, itemType, folder = null) {
  const itemsData = parsedItems.map(parsed => {
    const doc = {
      name: String(parsed.name ?? 'Unnamed Item').trim() || 'Unnamed Item',
      type: itemType,
      folder: folder?.id ?? null,
      system: {}
    };

    for (const [field, value] of Object.entries(parsed)) {
      if (field === 'name') continue; // already set
      if (field.startsWith('system.')) {
        setNestedValue(doc.system, field.slice(7), value);
      } else if (!['type', 'folder'].includes(field)) {
        doc[field] = value;
      }
    }

    return doc;
  });

  return Item.createDocuments(itemsData);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
