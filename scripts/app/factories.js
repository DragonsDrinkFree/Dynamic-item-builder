/**
 * System introspection helpers, default object factories, and constants.
 */

// -------------------------------------------------------------------------
// System introspection
// -------------------------------------------------------------------------

export function getSystemItemTypes() {
  const types = game.documentTypes?.Item ?? [];
  return types
    .filter(t => t !== 'base' && t !== 'types')
    .map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }));
}

export async function getItemAttributePaths(itemType) {
  const paths = [{ path: 'name', label: 'Name' }, { path: 'img', label: 'Image' }];
  if (!itemType) return paths;

  // Instantiate a temporary item of the target type to get its data model — this
  // works in v12+ without touching the deprecated game.system.template API.
  try {
    const tmp = new Item({ name: '_tmp', type: itemType });
    const sysFlat = foundry.utils.flattenObject(tmp.toObject().system ?? {});
    for (const key of Object.keys(sysFlat)) {
      paths.push({ path: `system.${key}`, label: key });
    }
  } catch { /* ignore — item type may not be valid yet */ }

  return paths;
}

// -------------------------------------------------------------------------
// Default factories
// -------------------------------------------------------------------------

export function makeDefaultRule() {
  return {
    id:                  foundry.utils.randomID(),
    name:                'New Rule',
    itemType:            '',
    pages:               '1',
    folderId:            '',
    contentType:         'table',
    headerPattern:       '',
    rowDetectionPattern: '',
    skipPattern:         '',
    fontFilter:          { name: '', minSize: '', maxSize: '' },
    attributes:          [],
    ignoredItems:        [],
    regions:             [],
    manualColumns:          [],
    manualHeaders:          {},
    manualJoins:            {},
    legacyTextFieldAttrs:   {}
  };
}

export function makeDefaultAttribute() {
  return {
    foundryField: '', columnHeader: '', columnIndex: '',
    pattern: '', flags: 'i', group: 1, transform: 'trim'
  };
}

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

export const TRANSFORMS = [
  { value: 'trim',      label: 'Trim whitespace' },
  { value: 'number',    label: 'Number' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'uppercase', label: 'Uppercase' },
  { value: 'boolean',   label: 'Boolean (yes/true/1/x)' }
];
