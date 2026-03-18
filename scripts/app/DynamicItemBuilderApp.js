/**
 * DynamicItemBuilderApp — main three-panel ApplicationV2 UI.
 *
 * Left panel  : rule list
 * Center panel: rule editor (page range, item type, content type, attributes)
 * Right panel : live item preview
 */

import { loadPDF, extractPages, parsePageString, mergePageItems, detectTables, detectTextSections } from '../pdf-parser.js';
import { applyRule } from '../rule-engine.js';
import { buildItems } from '../item-builder.js';

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class DynamicItemBuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {

  static DEFAULT_OPTIONS = {
    id: 'dynamic-item-builder',
    classes: ['dynamic-item-builder'],
    window: {
      title: 'Dynamic Item Builder',
      resizable: true,
      minimizable: true,
      icon: 'fas fa-file-import'
    },
    position: { width: 1700, height: 860 },
    actions: {
      addRule:         DynamicItemBuilderApp.#addRule,
      deleteRule:      DynamicItemBuilderApp.#deleteRule,
      selectRule:      DynamicItemBuilderApp.#selectRule,
      duplicateRule:   DynamicItemBuilderApp.#duplicateRule,
      addAttribute:    DynamicItemBuilderApp.#addAttribute,
      deleteAttribute: DynamicItemBuilderApp.#deleteAttribute,
      buildItems:      DynamicItemBuilderApp.#buildItems,
      exportRules:     DynamicItemBuilderApp.#exportRules,
      importRules:     DynamicItemBuilderApp.#importRules,
      loadPdf:         DynamicItemBuilderApp.#loadPdfDialog,
      refreshPreview:  DynamicItemBuilderApp.#refreshPreview
    }
  };

  static PARTS = {
    main: {
      template: 'modules/dynamic-item-builder/templates/dynamic-item-builder.hbs',
      scrollable: ['.rules-list', '.rule-editor-inner', '.preview-list']
    }
  };

  // -------------------------------------------------------------------------
  // Instance state
  // -------------------------------------------------------------------------

  /** @type {Object|null} PDF.js document wrapper */
  _pdf = null;
  _pdfName = '';
  _pdfPages = 0;

  /** @type {Array<RuleObject>} */
  _rules = [];

  /** @type {string|null} */
  _selectedRuleId = null;

  /** @type {Object<string, Array>} rule.id → detected items */
  _preview = {};

  /** @type {boolean} preview is currently being computed */
  _previewLoading = false;

  /** @type {string|null} ID of selected Item folder for item creation */
  _selectedFolderId = null;

  /** @type {Object|null} Result of detectTables() for the current rule's pages */
  _scanData = null;

  /** @type {Object|null} Result of detectTextSections() for the current rule's pages */
  _textData = null;

  /** @type {'tables'|'text'|'preview'} Active tab in the right panel */
  _activeTab = 'tables';

  /** @type {Set<string>} Keys of selected rows in the preview list */
  _previewSel = new Set();

  /** @type {Set<string>} Keys of selected rows in the ignore list */
  _ignoreSel = new Set();

  /** @type {string|null} Last clicked key in preview (for shift-range) */
  _lastPreviewClickKey = null;

  /** @type {string|null} Last clicked key in ignore (for shift-range) */
  _lastIgnoreClickKey = null;

  /**
   * Cached attribute paths for the current item type — kept in sync so the
   * context menu can use them without an async call.
   * @type {Array<{path,label}>}
   */
  _cachedAttributePaths = [];

  /** @type {number|null} */
  _debounceTimer = null;

  get selectedRule() {
    return this._rules.find(r => r.id === this._selectedRuleId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  async _prepareContext(options) {
    const rule = this.selectedRule;
    const itemTypes = getSystemItemTypes();
    const attributePaths = rule ? await getItemAttributePaths(rule.itemType) : [];

    // Build preview summary — include column headers and flatten item values
    // so the template can render a proper table without needing deep-path helpers.
    const previewSummary = this._rules.map(r => {
      const cols = r.attributes
        .filter(a => a.foundryField)
        .map(a => ({
          field: a.foundryField,
          label: a.foundryField.split('.').pop()
        }));

      // Items in the ignore list, keyed by _dibKey
      const ignoredKeys = new Set((r.ignoredItems ?? []).map(i => i._dibKey));

      const rawItems = this._preview[r.id] ?? null;
      const flatItems = rawItems
        ? rawItems
            .map((item, idx) => {
              const dibKey = item.name ?? `_${idx}`;
              const flat = foundry.utils.flattenObject(item);
              flat._dibKey = dibKey;
              flat._key   = `${r.id}::${dibKey}`;
              return flat;
            })
            .filter(item => !ignoredKeys.has(item._dibKey))
        : null;

      const ignoredFlatItems = (r.ignoredItems ?? []).map(item => {
        const flat = foundry.utils.flattenObject(item);
        flat._dibKey = item._dibKey;
        flat._key   = `${r.id}::${item._dibKey}`;
        return flat;
      });

      return { id: r.id, name: r.name, columns: cols, items: flatItems, ignoredItems: ignoredFlatItems };
    });

    const hasIgnoredItems = this._rules.some(r => (r.ignoredItems ?? []).length > 0);

    // Cache attribute paths for context menu use
    if (attributePaths.length) this._cachedAttributePaths = attributePaths;

    // Build a flat, indented folder list for the picker
    const itemFolders = game.folders
      .filter(f => f.type === 'Item')
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map(f => ({
        id: f.id,
        name: '\u00a0'.repeat((f.depth ?? 0) * 2) + f.name
      }));

    return {
      hasPdf: !!this._pdf,
      pdfName: this._pdfName,
      pdfPages: this._pdfPages,
      rules: this._rules,
      selectedRuleId: this._selectedRuleId,
      selectedRule: rule,
      itemTypes,
      attributePaths,
      previewSummary,
      hasIgnoredItems,
      previewLoading: this._previewLoading,
      contentTypes: CONTENT_TYPES,
      transforms: TRANSFORMS,
      itemFolders,
      selectedFolderId: this._selectedFolderId,
      scanData:         this._scanData,
      textData:         this._textData,
      tablesTabActive:  this._activeTab === 'tables',
      textTabActive:    this._activeTab === 'text',
      previewTabActive: this._activeTab === 'preview'
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this._bindEvents();
    // Reapply selection highlights and button states after every render
    const previewList = this.element.querySelector('.preview-list');
    const ignoreList  = this.element.querySelector('.ignore-list');
    if (previewList) this.#applySelectionClasses(previewList, this._previewSel);
    if (ignoreList)  this.#applySelectionClasses(ignoreList,  this._ignoreSel);
    this.#updatePreviewToolbar(this.element);
    this.#updateIgnoreToolbar(this.element);
  }

  // -------------------------------------------------------------------------
  // Event binding (non-action events)
  // -------------------------------------------------------------------------

  _bindEvents() {
    const el = this.element;

    // PDF file picker
    el.querySelector('#dib-pdf-input')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) this.#handlePdfFile(file);
    });

    // Folder picker
    el.querySelector('#dib-folder-select')?.addEventListener('change', e => {
      this._selectedFolderId = e.target.value || null;
    });

    // Rule editor — field changes delegated to the form section
    el.querySelector('.rule-editor-inner')?.addEventListener('change', e => {
      this.#onEditorChange(e);
    });

    // Attribute list changes
    el.querySelector('.attributes-list')?.addEventListener('change', e => {
      this.#onAttributeChange(e);
    });

    // Tab switching in right panel
    el.querySelector('.dib-tab-bar')?.addEventListener('click', e => {
      const btn = e.target.closest('.dib-tab');
      if (!btn) return;
      this._activeTab = btn.dataset.tab;
      this.render();
    });

    // PDF scan — click any cell or prose block for context menu
    el.querySelector('.dib-scan-content')?.addEventListener('click', e => {
      this.#handleScanClick(e);
    });

    // PDF text — click an entry for context menu
    el.querySelector('.text-scan-content')?.addEventListener('click', e => {
      this.#handleTextEntryClick(e);
    });

    // Preview toolbar buttons
    el.querySelector('.dib-preview-toolbar')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.action) {
        case 'preview-select-all':   this.#previewSelectAll();   break;
        case 'preview-deselect-all': this.#previewDeselectAll(); break;
        case 'preview-remove':       this.#previewRemoveSelected(); break;
      }
    });

    // Ignore toolbar buttons
    el.querySelector('.dib-ignore-toolbar')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.action) {
        case 'ignore-select-all':    this.#ignoreSelectAll();    break;
        case 'ignore-deselect-all':  this.#ignoreDeselectAll();  break;
        case 'ignore-restore':       this.#ignoreRestoreSelected(); break;
      }
    });

    // Row selection
    this.#bindListSelection(
      el.querySelector('.preview-list'), this._previewSel,
      '_lastPreviewClickKey', () => this.#updatePreviewToolbar(this.element)
    );
    this.#bindListSelection(
      el.querySelector('.ignore-list'), this._ignoreSel,
      '_lastIgnoreClickKey', () => this.#updateIgnoreToolbar(this.element)
    );
  }

  // -------------------------------------------------------------------------
  // Preview / Ignore list selection
  // -------------------------------------------------------------------------

  /**
   * Attach mouse-based multi-select to a list element whose rows have
   * [data-item-key] attributes.  Supports click, ctrl+click, shift+click,
   * and click-drag to extend selection.
   */
  #bindListSelection(listEl, selSet, lastKeyProp, onUpdate) {
    if (!listEl) return;
    listEl.addEventListener('mousedown', e => {
      const row = e.target.closest('[data-item-key]');
      if (!row) return;
      e.preventDefault();   // prevent text-selection during drag

      const key     = row.dataset.itemKey;
      const allRows = [...listEl.querySelectorAll('[data-item-key]')];
      const keys    = allRows.map(r => r.dataset.itemKey);
      const idx     = keys.indexOf(key);

      if (e.shiftKey && this[lastKeyProp]) {
        // Range-select from last click to this row
        const fromIdx = keys.indexOf(this[lastKeyProp]);
        const [lo, hi] = [Math.min(fromIdx, idx), Math.max(fromIdx, idx)];
        for (let i = lo; i <= hi; i++) selSet.add(keys[i]);

      } else if (e.ctrlKey || e.metaKey) {
        // Toggle individual row
        if (selSet.has(key)) selSet.delete(key);
        else selSet.add(key);
        this[lastKeyProp] = key;

      } else {
        // Single select (or start of drag)
        selSet.clear();
        selSet.add(key);
        this[lastKeyProp] = key;

        // Drag: sweep rows between anchor and current mouse position
        const onOver = ev => {
          const target = ev.target.closest('[data-item-key]');
          if (!target) return;
          const ti = keys.indexOf(target.dataset.itemKey);
          if (ti < 0) return;
          const [lo, hi] = [Math.min(idx, ti), Math.max(idx, ti)];
          selSet.clear();
          for (let i = lo; i <= hi; i++) selSet.add(keys[i]);
          this.#applySelectionClasses(listEl, selSet);
          onUpdate();
        };
        listEl.addEventListener('mouseover', onOver);
        document.addEventListener('mouseup', () => {
          listEl.removeEventListener('mouseover', onOver);
        }, { once: true });
      }

      this.#applySelectionClasses(listEl, selSet);
      onUpdate();
    });
  }

  /** Toggle .dib-row-selected on each row based on the selection set. */
  #applySelectionClasses(listEl, selSet) {
    for (const row of listEl.querySelectorAll('[data-item-key]')) {
      row.classList.toggle('dib-row-selected', selSet.has(row.dataset.itemKey));
    }
  }

  #updatePreviewToolbar(el) {
    const btn = el?.querySelector('[data-action="preview-remove"]');
    if (btn) btn.disabled = this._previewSel.size === 0;
  }

  #updateIgnoreToolbar(el) {
    const btn = el?.querySelector('[data-action="ignore-restore"]');
    if (btn) btn.disabled = this._ignoreSel.size === 0;
  }

  #previewSelectAll() {
    const listEl = this.element?.querySelector('.preview-list');
    if (!listEl) return;
    listEl.querySelectorAll('[data-item-key]').forEach(r => this._previewSel.add(r.dataset.itemKey));
    this.#applySelectionClasses(listEl, this._previewSel);
    this.#updatePreviewToolbar(this.element);
  }

  #previewDeselectAll() {
    this._previewSel.clear();
    const listEl = this.element?.querySelector('.preview-list');
    if (listEl) this.#applySelectionClasses(listEl, this._previewSel);
    this.#updatePreviewToolbar(this.element);
  }

  #previewRemoveSelected() {
    if (!this._previewSel.size) return;
    for (const key of this._previewSel) {
      const sep    = key.indexOf('::');
      const ruleId = key.slice(0, sep);
      const dibKey = key.slice(sep + 2);
      const rule   = this._rules.find(r => r.id === ruleId);
      if (!rule) continue;
      rule.ignoredItems ??= [];
      if (rule.ignoredItems.some(i => i._dibKey === dibKey)) continue;
      const raw = this._preview[ruleId]
        ?.find((item, idx) => (item.name ?? `_${idx}`) === dibKey);
      if (raw) rule.ignoredItems.push({ ...foundry.utils.deepClone(raw), _dibKey: dibKey });
      else     rule.ignoredItems.push({ _dibKey: dibKey, name: dibKey });
    }
    this._previewSel.clear();
    this.render();
  }

  #ignoreSelectAll() {
    const listEl = this.element?.querySelector('.ignore-list');
    if (!listEl) return;
    listEl.querySelectorAll('[data-item-key]').forEach(r => this._ignoreSel.add(r.dataset.itemKey));
    this.#applySelectionClasses(listEl, this._ignoreSel);
    this.#updateIgnoreToolbar(this.element);
  }

  #ignoreDeselectAll() {
    this._ignoreSel.clear();
    const listEl = this.element?.querySelector('.ignore-list');
    if (listEl) this.#applySelectionClasses(listEl, this._ignoreSel);
    this.#updateIgnoreToolbar(this.element);
  }

  #ignoreRestoreSelected() {
    if (!this._ignoreSel.size) return;
    for (const key of this._ignoreSel) {
      const sep    = key.indexOf('::');
      const ruleId = key.slice(0, sep);
      const dibKey = key.slice(sep + 2);
      const rule   = this._rules.find(r => r.id === ruleId);
      if (!rule) continue;
      rule.ignoredItems = (rule.ignoredItems ?? []).filter(i => i._dibKey !== dibKey);
    }
    this._ignoreSel.clear();
    this.render();
  }

  // -------------------------------------------------------------------------
  // PDF loading
  // -------------------------------------------------------------------------

  async #handlePdfFile(file) {
    try {
      ui.notifications.info('Dynamic Item Builder | Loading PDF…');
      this._pdf = await loadPDF(file);
      this._pdfName = file.name;
      this._pdfPages = this._pdf.numPages;
      ui.notifications.info(`Loaded "${file.name}" — ${this._pdfPages} pages.`);
      this.render();
    } catch (err) {
      ui.notifications.error(`Failed to load PDF: ${err.message}`);
      console.error('Dynamic Item Builder | PDF load error', err);
    }
  }

  // -------------------------------------------------------------------------
  // Rule field change handler
  // -------------------------------------------------------------------------

  #onEditorChange(event) {
    const rule = this.selectedRule;
    if (!rule) return;

    const field = event.target.dataset.field;
    if (!field) return;

    const raw = event.target.value;
    const value = event.target.type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
    foundry.utils.setProperty(rule, field, value);

    // Re-render the rule list label if name changed
    if (field === 'name') {
      const label = this.element.querySelector(`[data-rule-id="${rule.id}"] .rule-name`);
      if (label) label.textContent = value || '(unnamed)';
    }

    this.#schedulePreview();
  }

  #onAttributeChange(event) {
    const rule = this.selectedRule;
    if (!rule) return;

    const idx = Number(event.target.closest('[data-attr-index]')?.dataset.attrIndex);
    if (isNaN(idx)) return;

    const field = event.target.dataset.field;
    if (!field) return;

    const raw = event.target.value;
    const value = event.target.type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
    rule.attributes[idx][field] = value;
    this.#schedulePreview();
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  #schedulePreview() {
    clearTimeout(this._debounceTimer);
    this._debounceTimer = setTimeout(() => this.#runPreview(), 900);
  }

  async #runPreview() {
    if (!this._pdf) return;
    this._previewLoading = true;
    this.render();
    await this.#runScan();

    for (const rule of this._rules) {
      if (!rule.itemType || !rule.pages) {
        this._preview[rule.id] = [];
        continue;
      }
      try {
        this._preview[rule.id] = await applyRule(rule, this._pdf);
      } catch (err) {
        console.warn(`Dynamic Item Builder | Preview error (rule "${rule.name}"):`, err);
        this._preview[rule.id] = [];
      }
    }

    this._previewLoading = false;
    this.render();
  }

  // -------------------------------------------------------------------------
  // PDF Scan
  // -------------------------------------------------------------------------

  async #runScan() {
    const rule = this.selectedRule;
    if (!this._pdf || !rule?.pages) {
      this._scanData = null;
      this._textData = null;
      return;
    }

    try {
      const pageNums = parsePageString(rule.pages, this._pdf.numPages);
      const pages    = await extractPages(this._pdf, pageNums);
      const allItems = mergePageItems(pages);
      this._scanData = detectTables(allItems);
      this._textData = detectTextSections(allItems);
    } catch (err) {
      console.warn('Dynamic Item Builder | Scan error:', err);
      this._scanData = null;
      this._textData = null;
    }
  }

  // -------------------------------------------------------------------------
  // Scan context menu
  // -------------------------------------------------------------------------

  #handleScanClick(event) {
    const rule = this.selectedRule;
    if (!rule) return;

    const headerCell = event.target.closest('[data-scan="header-cell"]');
    const dataCell   = event.target.closest('[data-scan="data-cell"]');
    const proseBlock = event.target.closest('[data-scan="prose"]');

    if (!headerCell && !dataCell && !proseBlock) return;

    event.stopPropagation();
    const menuItems = [];
    const col = (headerCell ?? dataCell)?.dataset.column;

    if (headerCell) {
      menuItems.push({
        icon: 'fa-heading',
        label: `Set Header Pattern: "${col}"`,
        action: () => { rule.headerPattern = col; this.#schedulePreview(); this.render(); }
      });
    }

    if (dataCell) {
      const val = dataCell.dataset.value;
      menuItems.push({
        icon: 'fa-ban',
        label: `Add to Skip Pattern: "${val}"`,
        action: () => {
          rule.skipPattern = rule.skipPattern
            ? `${rule.skipPattern}|${_esc(val)}`
            : _esc(val);
          this.#schedulePreview(); this.render();
        }
      });
      menuItems.push({
        icon: 'fa-flag',
        label: `Set as Item Start Pattern`,
        action: () => {
          rule.rowDetectionPattern = `^${_esc(val)}`;
          this.#schedulePreview(); this.render();
        }
      });
    }

    if (proseBlock) {
      const text = proseBlock.dataset.text?.slice(0, 40);
      menuItems.push({
        icon: 'fa-flag',
        label: `Set as Item Start Pattern: "${text}…"`,
        action: () => {
          rule.rowDetectionPattern = _esc(proseBlock.dataset.text.split(' ')[0]);
          this.#schedulePreview(); this.render();
        }
      });
    }

    // Column → field mapping (for any table cell)
    if (col && this._cachedAttributePaths.length) {
      menuItems.push({ separator: true });
      menuItems.push({ heading: `Map column "${col}" to field:` });
      for (const attr of this._cachedAttributePaths) {
        menuItems.push({
          icon: 'fa-link',
          label: attr.path,
          action: () => { this.#mapColumnToField(rule, col, attr.path); this.render(); }
        });
      }
    }

    this.#showContextMenu(event, menuItems);
  }

  #handleTextEntryClick(event) {
    const rule  = this.selectedRule;
    const entry = event.target.closest('[data-scan="text-entry"]');
    if (!rule || !entry) return;
    event.stopPropagation();

    const name = entry.dataset.name ?? '';
    const desc = entry.dataset.description ?? '';
    const menuItems = [];

    if (name) {
      menuItems.push({
        icon: 'fa-flag',
        label: `Set Item Start Pattern: "${name.slice(0, 35)}"`,
        action: () => {
          rule.rowDetectionPattern = _esc(name.split(/[\s,]/)[0]);
          this.#schedulePreview(); this.render();
        }
      });
      if (this._cachedAttributePaths.length) {
        menuItems.push({ separator: true });
        menuItems.push({ heading: `Map name "${name.slice(0, 30)}" to field:` });
        for (const attr of this._cachedAttributePaths) {
          menuItems.push({
            icon: 'fa-link',
            label: attr.path,
            action: () => {
              rule.attributes.push({
                ...makeDefaultAttribute(),
                pattern: _esc(name),
                foundryField: attr.path
              });
              this.#schedulePreview(); this.render();
            }
          });
        }
      }
    }

    this.#showContextMenu(event, menuItems);
  }

  #mapColumnToField(rule, columnHeader, foundryField) {
    // Only skip if this exact column→field pair already exists
    const duplicate = rule.attributes.find(
      a => a.columnHeader === columnHeader && a.foundryField === foundryField
    );
    if (!duplicate) {
      rule.attributes.push({ ...makeDefaultAttribute(), columnHeader, foundryField });
    }
    this.#schedulePreview();
  }

  #showContextMenu(event, items) {
    document.querySelector('.dib-context-menu')?.remove();
    if (!items.length) return;

    const menu = document.createElement('div');
    menu.className = 'dib-context-menu';

    for (const item of items) {
      if (item.separator) {
        const hr = document.createElement('hr');
        hr.className = 'dib-ctx-sep';
        menu.appendChild(hr);
        continue;
      }
      if (item.heading) {
        const h = document.createElement('div');
        h.className = 'dib-ctx-heading';
        h.textContent = item.heading;
        menu.appendChild(h);
        continue;
      }
      const btn = document.createElement('button');
      btn.className = 'dib-ctx-item';
      btn.innerHTML = `<i class="fas ${item.icon ?? 'fa-circle'}"></i> ${item.label}`;
      btn.addEventListener('click', () => { item.action(); menu.remove(); });
      menu.appendChild(btn);
    }

    // Position near cursor, keep on screen
    document.body.appendChild(menu);
    const { clientX: x, clientY: y } = event;
    const { offsetWidth: w, offsetHeight: h } = menu;
    menu.style.left = `${Math.min(x, window.innerWidth  - w - 8)}px`;
    menu.style.top  = `${Math.min(y, window.innerHeight - h - 8)}px`;

    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); } };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  // -------------------------------------------------------------------------
  // Static action handlers
  // -------------------------------------------------------------------------

  static async #addRule() {
    const rule = makeDefaultRule();
    this._rules.push(rule);
    this._selectedRuleId = rule.id;
    this.render();
  }

  static async #deleteRule(event, target) {
    const id = target.closest('[data-rule-id]')?.dataset.ruleId;
    if (!id) return;

    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Delete Rule' },
      content: 'Delete this rule? This cannot be undone.',
      rejectClose: false
    });
    if (!confirmed) return;

    this._rules = this._rules.filter(r => r.id !== id);
    delete this._preview[id];
    if (this._selectedRuleId === id) this._selectedRuleId = this._rules[0]?.id ?? null;
    this.render();
  }

  static async #selectRule(event, target) {
    // Don't select when clicking the delete button inside the item
    if (event.target.closest('[data-action="deleteRule"]')) return;
    const id = target.closest('[data-rule-id]')?.dataset.ruleId;
    if (!id || id === this._selectedRuleId) return;
    this._selectedRuleId = id;
    this._scanData = null; // clear stale scan until refresh
    this.render();
    // Run scan for the newly selected rule
    await this.#runScan();
    this.render();
  }

  static async #duplicateRule(event, target) {
    const id = target.closest('[data-rule-id]')?.dataset.ruleId;
    const source = this._rules.find(r => r.id === id);
    if (!source) return;
    const copy = foundry.utils.deepClone(source);
    copy.id = foundry.utils.randomID();
    copy.name = source.name + ' (copy)';
    this._rules.push(copy);
    this._selectedRuleId = copy.id;
    this.render();
  }

  static async #addAttribute() {
    const rule = this.selectedRule;
    if (!rule) return;
    rule.attributes.push(makeDefaultAttribute());
    this.render();
  }

  static async #deleteAttribute(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    const idx = Number(target.closest('[data-attr-index]')?.dataset.attrIndex);
    if (isNaN(idx)) return;
    rule.attributes.splice(idx, 1);
    this.#schedulePreview();
    this.render();
  }

  static async #refreshPreview() {
    await this.#runPreview();
  }

  static async #buildItems() {
    if (!this._pdf) {
      ui.notifications.warn('Load a PDF first.');
      return;
    }

    const hasPreviews = this._rules.some(r => (this._preview[r.id]?.length ?? 0) > 0);
    if (!hasPreviews) {
      ui.notifications.warn('No items detected. Check your rules and refresh the preview.');
      return;
    }

    const folder = this._selectedFolderId
      ? game.folders.get(this._selectedFolderId) ?? null
      : null;

    let total = 0;
    for (const rule of this._rules) {
      const items = this._preview[rule.id];
      if (!items?.length || !rule.itemType) continue;
      try {
        const created = await buildItems(items, rule.itemType, folder);
        total += created.length;
      } catch (err) {
        ui.notifications.error(`Error creating "${rule.name}" items: ${err.message}`);
        console.error(err);
      }
    }

    ui.notifications.info(`Dynamic Item Builder | Created ${total} item(s).`);
  }

  static async #exportRules() {
    const data = {
      _dibVersion: '1.0',
      system: game.system.id,
      exportedAt: new Date().toISOString(),
      rules: this._rules.map(r => foundry.utils.deepClone(r))
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `dib-rules-${game.system.id}-${Date.now()}.json`
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  static async #importRules() {
    const input = Object.assign(document.createElement('input'), {
      type: 'file',
      accept: '.json'
    });
    input.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.rules)) throw new Error('Missing "rules" array.');

        const imported = data.rules.map(r => ({
          ...makeDefaultRule(),
          ...r,
          id: foundry.utils.randomID() // fresh IDs to avoid collisions
        }));

        this._rules.push(...imported);
        this._selectedRuleId = imported[0]?.id ?? this._selectedRuleId;
        ui.notifications.info(`Imported ${imported.length} rule(s) from "${file.name}".`);
        this.render();
      } catch (err) {
        ui.notifications.error(`Import failed: ${err.message}`);
      }
    });
    input.click();
  }

  static async #loadPdfDialog() {
    document.getElementById('dib-pdf-input')?.click();
  }
}

// -------------------------------------------------------------------------
// System introspection helpers
// -------------------------------------------------------------------------

function getSystemItemTypes() {
  const types = game.documentTypes?.Item ?? Object.keys(game.system.template?.Item ?? {});
  return types
    .filter(t => t !== 'base' && t !== 'types')
    .map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }));
}

async function getItemAttributePaths(itemType) {
  const paths = [
    { path: 'name', label: 'Name' },
    { path: 'img',  label: 'Image' }
  ];

  if (!itemType) return paths;

  // Try system template first (most compatible)
  const template = game.system.template?.Item?.[itemType] ?? {};
  const flat = foundry.utils.flattenObject(template);
  for (const key of Object.keys(flat)) {
    paths.push({ path: `system.${key}`, label: key });
  }

  // If the system uses DataModel (v11+) and no template entries found,
  // try constructing a temporary item to inspect its schema fields.
  if (paths.length <= 2 && game.documentTypes?.Item?.includes(itemType)) {
    try {
      const tmp = new Item({ name: '_tmp', type: itemType });
      const sysFlat = foundry.utils.flattenObject(tmp.toObject().system ?? {});
      for (const key of Object.keys(sysFlat)) {
        if (!paths.some(p => p.path === `system.${key}`)) {
          paths.push({ path: `system.${key}`, label: key });
        }
      }
    } catch { /* ignore */ }
  }

  return paths;
}

// -------------------------------------------------------------------------
// Default factories
// -------------------------------------------------------------------------

/** Escape a string for use as a literal regex fragment */
function _esc(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeDefaultRule() {
  return {
    id: foundry.utils.randomID(),
    name: 'New Rule',
    itemType: '',
    pages: '1',
    contentType: 'table',
    headerPattern: '',
    rowDetectionPattern: '',
    skipPattern: '',
    fontFilter: { name: '', minSize: '', maxSize: '' },
    mixedConfig: { tableXMin: 0, tableXMax: 9999, textXMin: 0, textXMax: 9999 },
    descriptionField: '',
    attributes: [],
    ignoredItems: []
  };
}

function makeDefaultAttribute() {
  return {
    foundryField: '',
    columnHeader: '',
    columnIndex: '',
    pattern: '',
    flags: 'i',
    group: 1,
    transform: 'trim'
  };
}

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const CONTENT_TYPES = [
  { value: 'table',  label: 'Table (grid layout)' },
  { value: 'column', label: 'Column Text (prose)' },
  { value: 'mixed',  label: 'Mixed (table + prose)' }
];

const TRANSFORMS = [
  { value: 'trim',      label: 'Trim whitespace' },
  { value: 'number',    label: 'Number' },
  { value: 'lowercase', label: 'Lowercase' },
  { value: 'uppercase', label: 'Uppercase' },
  { value: 'boolean',   label: 'Boolean (yes/true/1/x)' }
];
