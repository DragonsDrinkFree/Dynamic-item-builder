/**
 * Shared utilities for Dynamic Item Builder.
 */

/**
 * Set a value on an object at a dot-notation path, creating intermediate
 * objects as needed.  e.g. setNestedValue(obj, 'a.b.c', 1) → obj.a.b.c = 1
 */
export function setNestedValue(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur) || typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

/**
 * Safely construct a RegExp, returning null on invalid patterns.
 */
export function safeRegex(pattern, flags = '') {
  try { return new RegExp(pattern, flags); } catch { return null; }
}

/**
 * Escape special regex characters in a string so it can be used as a
 * literal pattern inside a RegExp.
 */
export function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Escape HTML special characters for safe insertion into markup.
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Minimal HTML-attribute escape (ampersand + double-quote only).
 * Use for attribute values where full HTML escaping is unnecessary.
 */
export function escapeAttr(str) {
  return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/**
 * Build a Set of _dibKey strings for items in a rule's ignored list.
 */
export function getIgnoredKeySet(rule) {
  return new Set((rule?.ignoredItems ?? []).map(i => i._dibKey));
}
