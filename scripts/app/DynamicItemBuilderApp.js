/**
 * DynamicItemBuilderApp — three-panel ApplicationV2 UI.
 *
 * Left panel   : rule list
 * Center panel : planning — PDF Planner (canvas + region painter) | Item Planner (rule editor)
 * Right panel  : previews — Table Preview | Text Preview | Item Preview
 */

import {
  loadPDF, extractPages, parsePageString, mergePageItems,
  detectTables, detectTextSections, renderPageToCanvas
} from '../pdf-parser.js';
import { applyRule }   from '../rule-engine.js';
import { buildItems }  from '../item-builder.js';

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
      addRule:             DynamicItemBuilderApp.#addRule,
      deleteRule:          DynamicItemBuilderApp.#deleteRule,
      selectRule:          DynamicItemBuilderApp.#selectRule,
      duplicateRule:       DynamicItemBuilderApp.#duplicateRule,
      addAttribute:        DynamicItemBuilderApp.#addAttribute,
      deleteAttribute:     DynamicItemBuilderApp.#deleteAttribute,
      deleteRegion:        DynamicItemBuilderApp.#deleteRegion,
      autoDetectRegions:   DynamicItemBuilderApp.#autoDetectRegions,
      buildItems:          DynamicItemBuilderApp.#buildItems,
      exportRules:         DynamicItemBuilderApp.#exportRules,
      importRules:         DynamicItemBuilderApp.#importRules,
      loadPdf:             DynamicItemBuilderApp.#loadPdfDialog,
      refreshPreview:      DynamicItemBuilderApp.#refreshPreview
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
  _pdf      = null;
  _pdfName  = '';
  _pdfPages = 0;

  /** @type {Array} */
  _rules = [];

  /** @type {string|null} */
  _selectedRuleId = null;

  /** @type {Object<string, Array>} rule.id → detected items */
  _preview = {};

  _previewLoading = false;

  /** @type {Object|null} detectTables() result for current rule */
  _scanData = null;

  /** @type {Object|null} detectTextSections() result for current rule */
  _textData = null;

  // ── Tab state ──────────────────────────────────────────────────────────────

  /** @type {'planner'|'item-planner'} */
  _centerTab = 'planner';

  /** @type {'tables'|'text'|'preview'} */
  _rightTab = 'tables';

  // ── PDF Planner state ──────────────────────────────────────────────────────

  /** @type {Object<string, number>} rule.id → current planner page for that rule */
  _plannerPageByRule = {};

  /** Per-rule planner page — automatically scoped to the selected rule. */
  get _plannerPage()    { return this._plannerPageByRule[this._selectedRuleId] ?? 1; }
  set _plannerPage(v)   { if (this._selectedRuleId) this._plannerPageByRule[this._selectedRuleId] = v; }

  /** @type {null|'table'|'text'} Active drawing mode */
  _drawMode = null;

  /** @type {number} Actual render scale (pixels per PDF unit) — set on each canvas render */
  _plannerScale = 1.0;

  /** @type {{x,y}|null} Draw start point in PDF coordinates */
  _drawStart = null;

  /** @type {{x,y,w,h}|null} In-progress rectangle in PDF coordinates */
  _drawRect = null;

  // ── Preview / ignore selection ─────────────────────────────────────────────

  _previewSel = new Set();
  _ignoreSel  = new Set();
  _lastPreviewClickKey = null;
  _lastIgnoreClickKey  = null;

  /** @type {Array<{path,label}>} */
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
    const rule         = this.selectedRule;
    const itemTypes    = getSystemItemTypes();
    const attributePaths = rule ? await getItemAttributePaths(rule.itemType) : [];

    // Build preview summary
    const previewSummary = this._rules.map(r => {
      const cols = r.attributes
        .filter(a => a.foundryField)
        .map(a => ({ field: a.foundryField, label: a.foundryField.split('.').pop() }));

      const ignoredKeys = new Set((r.ignoredItems ?? []).map(i => i._dibKey));
      const rawItems    = this._preview[r.id] ?? null;
      const flatItems   = rawItems
        ? rawItems
            .map((item, idx) => {
              const dibKey = item.name ?? `_${idx}`;
              const flat   = foundry.utils.flattenObject(item);
              flat._dibKey = dibKey;
              flat._key    = `${r.id}::${dibKey}`;
              return flat;
            })
            .filter(item => !ignoredKeys.has(item._dibKey))
        : null;

      const ignoredFlatItems = (r.ignoredItems ?? []).map(item => {
        const flat   = foundry.utils.flattenObject(item);
        flat._dibKey = item._dibKey;
        flat._key    = `${r.id}::${item._dibKey}`;
        return flat;
      });

      return { id: r.id, name: r.name, columns: cols, items: flatItems, ignoredItems: ignoredFlatItems };
    });

    const hasIgnoredItems = this._rules.some(r => (r.ignoredItems ?? []).length > 0);

    if (attributePaths.length) this._cachedAttributePaths = attributePaths;

    const itemFolders = game.folders
      .filter(f => f.type === 'Item')
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map(f => ({ id: f.id, name: '\u00a0'.repeat((f.depth ?? 0) * 2) + f.name }));

    return {
      hasPdf:    !!this._pdf,
      pdfName:   this._pdfName,
      pdfPages:  this._pdfPages,
      rules:     this._rules,
      selectedRuleId: this._selectedRuleId,
      selectedRule:   rule,
      itemTypes,
      attributePaths,
      previewSummary,
      hasIgnoredItems,
      previewLoading:  this._previewLoading,
      contentTypes:    CONTENT_TYPES,
      transforms:      TRANSFORMS,
      itemFolders,
      scanData:  this._scanData,
      textData:  this._textData,
      // Center panel tabs
      plannerTabActive:     this._centerTab === 'planner',
      itemPlannerTabActive: this._centerTab === 'item-planner',
      plannerPage: this._plannerPage,
      drawMode:    this._drawMode,
      // Right panel tabs
      tablesTabActive:  this._rightTab === 'tables',
      textTabActive:    this._rightTab === 'text',
      previewTabActive: this._rightTab === 'preview',
      // Region counts for badges
      tableRegionCount: (rule?.regions ?? []).filter(r => r.type === 'table').length,
      textRegionCount:  (rule?.regions ?? []).filter(r => r.type === 'text').length,
      // Planner page navigation — restrict to pages defined in rule
      plannerAtFirst: !this.#plannerPages().length || this._plannerPage <= this.#plannerPages()[0],
      plannerAtLast:  !this.#plannerPages().length || this._plannerPage >= this.#plannerPages()[this.#plannerPages().length - 1]
    };
  }

  _onRender(context, options) {
    super._onRender(context, options);
    this._bindEvents();
    // Reapply selection highlights
    const previewList = this.element.querySelector('.preview-list');
    const ignoreList  = this.element.querySelector('.ignore-list');
    if (previewList) this.#applySelectionClasses(previewList, this._previewSel);
    if (ignoreList)  this.#applySelectionClasses(ignoreList,  this._ignoreSel);
    this.#updatePreviewToolbar(this.element);
    this.#updateIgnoreToolbar(this.element);
    // Render planner canvas async (no await — fires and updates DOM independently)
    this.#renderPlannerCanvas();
  }

  // -------------------------------------------------------------------------
  // Event binding
  // -------------------------------------------------------------------------

  _bindEvents() {
    const el = this.element;

    // PDF file picker
    el.querySelector('#dib-pdf-input')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) this.#handlePdfFile(file);
    });

    // Center panel tab bar
    el.querySelector('.dib-center-tab-bar')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-center-tab]');
      if (!btn) return;
      this._centerTab = btn.dataset.centerTab;
      this.render();
    });

    // Right panel tab bar
    el.querySelector('.dib-tab-bar')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      this._rightTab = btn.dataset.tab;
      this.render();
    });

    // Rule editor field changes — covers both the topbar and the item planner tab
    el.querySelector('.dib-panel-editor')?.addEventListener('change', e => {
      this.#onEditorChange(e);
    });

    // Attribute list changes
    el.querySelector('.attributes-list')?.addEventListener('change', e => {
      this.#onAttributeChange(e);
    });

    // ── PDF Planner ────────────────────────────────────────────────────────

    // Page navigation — step only through pages defined in the rule
    el.querySelector('[data-planner-nav="prev"]')?.addEventListener('click', () => {
      const valid = this.#plannerPages();
      const idx   = valid.indexOf(this._plannerPage);
      if (idx > 0) { this._plannerPage = valid[idx - 1]; this.#renderPlannerCanvas(); this.#syncPlannerPageDisplay(); }
    });
    el.querySelector('[data-planner-nav="next"]')?.addEventListener('click', () => {
      const valid = this.#plannerPages();
      const idx   = valid.indexOf(this._plannerPage);
      if (idx !== -1 && idx < valid.length - 1) { this._plannerPage = valid[idx + 1]; this.#renderPlannerCanvas(); this.#syncPlannerPageDisplay(); }
    });

    // Draw mode toggle buttons
    el.querySelectorAll('[data-draw-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.drawMode;
        this._drawMode = this._drawMode === mode ? null : mode;
        // Update button active states without full re-render
        el.querySelectorAll('[data-draw-mode]').forEach(b => {
          b.classList.toggle('active', b.dataset.drawMode === this._drawMode);
        });
        const wrap = el.querySelector('.dib-planner-canvas-wrap');
        if (wrap) wrap.classList.toggle('draw-active', !!this._drawMode);
      });
    });

    // Canvas drawing (mousedown on viewport to start rectangle)
    const viewport = el.querySelector('.dib-pdf-viewport');
    if (viewport) {
      viewport.addEventListener('mousedown', e => this.#handlePlannerMousedown(e));
    }

    // Region sidebar: label + group field changes
    el.querySelector('.dib-region-sidebar')?.addEventListener('change', e => {
      const input = e.target.closest('[data-region-field]');
      if (!input) return;
      const id    = input.dataset.regionId;
      const field = input.dataset.regionField;
      const rule  = this.selectedRule;
      const region = (rule?.regions ?? []).find(r => r.id === id);
      if (region) { region[field] = input.value; this.#updateRegionOverlay(); }
    });

    // Scan cell clicks (Table Preview)
    el.querySelector('.dib-scan-content')?.addEventListener('click', e => {
      this.#handleScanClick(e);
    });

    // Text entry clicks (Text Preview)
    el.querySelector('.text-scan-content')?.addEventListener('click', e => {
      this.#handleTextEntryClick(e);
    });

    // Preview toolbar
    el.querySelector('.dib-preview-toolbar')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.action) {
        case 'preview-select-all':   this.#previewSelectAll();      break;
        case 'preview-deselect-all': this.#previewDeselectAll();    break;
        case 'preview-remove':       this.#previewRemoveSelected(); break;
      }
    });

    // Ignore toolbar
    el.querySelector('.dib-ignore-toolbar')?.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      switch (btn.dataset.action) {
        case 'ignore-select-all':   this.#ignoreSelectAll();         break;
        case 'ignore-deselect-all': this.#ignoreDeselectAll();       break;
        case 'ignore-restore':      this.#ignoreRestoreSelected();   break;
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

  /** Returns the sorted list of page numbers valid for the current rule. */
  #plannerPages() {
    const rule = this.selectedRule;
    if (!rule?.pages || !this._pdfPages) return [];
    return parsePageString(rule.pages, this._pdfPages);
  }

  /** Snap `_plannerPage` to the nearest valid page for the current rule. */
  #snapPlannerPage() {
    const valid = this.#plannerPages();
    if (!valid.length) return;
    if (!valid.includes(this._plannerPage)) {
      this._plannerPage = valid[0];
    }
  }

  // -------------------------------------------------------------------------
  // PDF Planner — canvas rendering & region painting
  // -------------------------------------------------------------------------

  async #renderPlannerCanvas() {
    const canvas = this.element?.querySelector('#dib-pdf-canvas');
    const wrap   = this.element?.querySelector('.dib-planner-canvas-wrap');
    if (!canvas || !wrap || !this._pdf) return;

    const availableWidth = Math.max(100, wrap.clientWidth - 24); // minus padding
    try {
      const result = await renderPageToCanvas(this._pdf, this._plannerPage, canvas, availableWidth);
      this._plannerScale = result.scale;
      this.#updateRegionOverlay();
    } catch (err) {
      console.warn('Dynamic Item Builder | Canvas render error:', err);
    }
  }

  /** Rebuild the absolutely-positioned region rectangles on the overlay div. */
  #updateRegionOverlay() {
    const overlay = this.element?.querySelector('.dib-region-overlay');
    const canvas  = this.element?.querySelector('#dib-pdf-canvas');
    if (!overlay || !canvas) return;

    const rule    = this.selectedRule;
    const regions = (rule?.regions ?? []).filter(r => r.page === this._plannerPage);
    const cw      = canvas.width;
    const ch      = canvas.height;

    overlay.innerHTML = '';

    const makeRegionEl = (region, isDrawing = false) => {
      const div = document.createElement('div');
      div.className = `dib-region dib-region-${region.type}${isDrawing ? ' dib-region-drawing' : ''}`;
      if (!isDrawing) div.dataset.regionId = region.id;

      const s = this._plannerScale;
      div.style.left   = `${(region.x * s / cw) * 100}%`;
      div.style.top    = `${(region.y * s / ch) * 100}%`;
      div.style.width  = `${(region.w * s / cw) * 100}%`;
      div.style.height = `${(region.h * s / ch) * 100}%`;

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

    for (const region of regions) overlay.appendChild(makeRegionEl(region));

    // In-progress draw ghost
    if (this._drawRect && this._drawRect.w > 2 && this._drawRect.h > 2) {
      overlay.appendChild(makeRegionEl(
        { ...this._drawRect, type: this._drawMode ?? 'table', label: '' },
        true
      ));
    }
  }

  /** Update only the page indicator text — no re-render needed. */
  #syncPlannerPageDisplay() {
    const el = this.element?.querySelector('.dib-planner-page-label');
    if (el) el.textContent = `${this._plannerPage} / ${this._pdfPages}`;
    this.#updateRegionOverlay();
  }

  // ── Drawing interaction ──────────────────────────────────────────────────

  #handlePlannerMousedown(event) {
    if (!this._drawMode) return;
    // Don't start a draw if the user clicked a region button or input
    if (event.target.closest('.dib-region-delete, .dib-region-label')) return;

    const coords = this.#getPdfCoords(event);
    if (!coords) return;

    this._drawStart = coords;
    this._drawRect  = { ...coords, w: 0, h: 0 };
    event.preventDefault();

    const onMove = ev => {
      const c = this.#getPdfCoords(ev);
      if (!c || !this._drawStart) return;
      this._drawRect = {
        x: Math.min(this._drawStart.x, c.x),
        y: Math.min(this._drawStart.y, c.y),
        w: Math.abs(c.x - this._drawStart.x),
        h: Math.abs(c.y - this._drawStart.y)
      };
      this.#updateRegionOverlay();
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      const rect = this._drawRect;
      this._drawStart = null;
      this._drawRect  = null;
      if (rect && rect.w > 10 && rect.h > 10) this.#addRegion(rect);
      else this.#updateRegionOverlay();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  }

  #getPdfCoords(event) {
    const canvas = this.element?.querySelector('#dib-pdf-canvas');
    if (!canvas || !this._plannerScale) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, (event.clientX - rect.left)  / this._plannerScale),
      y: Math.max(0, (event.clientY - rect.top)   / this._plannerScale)
    };
  }

  #addRegion(rect) {
    const rule = this.selectedRule;
    if (!rule) return;
    rule.regions ??= [];

    const typeLabel = this._drawMode === 'table' ? 'Table' : 'Text';
    const count     = rule.regions.filter(r => r.type === this._drawMode).length + 1;
    const group     = `${this._drawMode}-${count}`;

    rule.regions.push({
      id:    foundry.utils.randomID(),
      type:  this._drawMode,
      group,
      page:  this._plannerPage,
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      label: `${typeLabel} ${count}`
    });

    this.#schedulePreview();
    this.render();
  }

  // -------------------------------------------------------------------------
  // Preview / Ignore selection
  // -------------------------------------------------------------------------

  #bindListSelection(listEl, selSet, lastKeyProp, onUpdate) {
    if (!listEl) return;
    listEl.addEventListener('mousedown', e => {
      const row = e.target.closest('[data-item-key]');
      if (!row) return;
      e.preventDefault();

      const key     = row.dataset.itemKey;
      const allRows = [...listEl.querySelectorAll('[data-item-key]')];
      const keys    = allRows.map(r => r.dataset.itemKey);
      const idx     = keys.indexOf(key);

      if (e.shiftKey && this[lastKeyProp]) {
        const fromIdx = keys.indexOf(this[lastKeyProp]);
        const [lo, hi] = [Math.min(fromIdx, idx), Math.max(fromIdx, idx)];
        for (let i = lo; i <= hi; i++) selSet.add(keys[i]);
      } else if (e.ctrlKey || e.metaKey) {
        if (selSet.has(key)) selSet.delete(key);
        else selSet.add(key);
        this[lastKeyProp] = key;
      } else {
        selSet.clear();
        selSet.add(key);
        this[lastKeyProp] = key;

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
      this._pdf      = await loadPDF(file);
      this._pdfName  = file.name;
      this._pdfPages = this._pdf.numPages;
      // Reset planner to page 1
      this.#snapPlannerPage();
      ui.notifications.info(`Loaded "${file.name}" — ${this._pdfPages} pages.`);
      this.render();
    } catch (err) {
      ui.notifications.error(`Failed to load PDF: ${err.message}`);
      console.error('Dynamic Item Builder | PDF load error', err);
    }
  }

  // -------------------------------------------------------------------------
  // Rule field change handlers
  // -------------------------------------------------------------------------

  #onEditorChange(event) {
    const rule  = this.selectedRule;
    if (!rule) return;
    const field = event.target.dataset.field;
    if (!field) return;
    const raw   = event.target.value;
    const value = event.target.type === 'number' ? (raw === '' ? null : Number(raw)) : raw;
    foundry.utils.setProperty(rule, field, value);

    if (field === 'name') {
      const label = this.element.querySelector(`[data-rule-id="${rule.id}"] .rule-name`);
      if (label) label.textContent = value || '(unnamed)';
    }
    if (field === 'pages') this.#snapPlannerPage();
    this.#schedulePreview();
  }

  #onAttributeChange(event) {
    const rule = this.selectedRule;
    if (!rule) return;
    const idx  = Number(event.target.closest('[data-attr-index]')?.dataset.attrIndex);
    if (isNaN(idx)) return;
    const field = event.target.dataset.field;
    if (!field) return;
    const raw   = event.target.value;
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
  // PDF Scan — region-based or auto-detect fallback
  // -------------------------------------------------------------------------

  async #runScan() {
    const rule = this.selectedRule;
    if (!this._pdf || !rule?.pages) {
      this._scanData = null;
      this._textData = null;
      return;
    }

    try {
      const pageNums     = parsePageString(rule.pages, this._pdf.numPages);
      const pages        = await extractPages(this._pdf, pageNums);
      const tableRegions = (rule.regions ?? []).filter(r => r.type === 'table');
      const textRegions  = (rule.regions ?? []).filter(r => r.type === 'text');

      if (tableRegions.length > 0 || textRegions.length > 0) {
        // Region-based: extract only items inside defined rectangles
        this._scanData = this.#scanTableRegions(pages, tableRegions);
        this._textData = this.#scanTextRegions(pages, textRegions);
      } else {
        // Auto-detect fallback
        const allItems     = mergePageItems(pages);
        this._scanData     = detectTables(allItems);
        this._textData     = detectTextSections(allItems);
      }
    } catch (err) {
      console.warn('Dynamic Item Builder | Scan error:', err);
      this._scanData = null;
      this._textData = null;
    }
  }

  /** Filter a single page's items to those inside a region bounding box. */
  #filterItemsToRegion(page, region) {
    return page.items.filter(item =>
      item.x >= region.x            &&
      item.x <= region.x + region.w &&
      item.y >= region.y            &&
      item.y <= region.y + region.h
    );
  }

  /**
   * Extract and collate table regions.
   * Regions sharing the same `group` have their rows merged (columns from
   * the first region in the group are used as the canonical schema).
   */
  #scanTableRegions(pages, regions) {
    // Group regions by their `group` key, in page→Y order
    const groups = new Map();
    for (const region of [...regions].sort((a, b) => a.page - b.page || a.y - b.y)) {
      if (!groups.has(region.group)) groups.set(region.group, []);
      groups.get(region.group).push(region);
    }

    const tables    = [];
    const proseRows = [];

    for (const [, groupRegions] of groups) {
      let yOffset    = 0;
      const groupItems = [];

      for (const region of groupRegions) {
        const page = pages.find(p => p.pageNum === region.page);
        if (!page) continue;
        const regionItems = this.#filterItemsToRegion(page, region);
        for (const item of regionItems) {
          groupItems.push({ ...item, y: item.y + yOffset });
        }
        if (regionItems.length) {
          yOffset += Math.max(...regionItems.map(i => i.y)) + 50;
        }
      }

      if (!groupItems.length) continue;
      const result = detectTables(groupItems);
      tables.push(...result.tables);
      proseRows.push(...result.proseRows);
    }

    tables.forEach((t, i) => { t.id = `tbl-${i}`; });
    return { tables, proseRows };
  }

  /** Extract and collate text regions. */
  #scanTextRegions(pages, regions) {
    if (!regions.length) return { sections: [] };

    const groups = new Map();
    for (const region of [...regions].sort((a, b) => a.page - b.page || a.y - b.y)) {
      if (!groups.has(region.group)) groups.set(region.group, []);
      groups.get(region.group).push(region);
    }

    const sections = [];

    for (const [, groupRegions] of groups) {
      let yOffset    = 0;
      const groupItems = [];

      for (const region of groupRegions) {
        const page = pages.find(p => p.pageNum === region.page);
        if (!page) continue;
        const regionItems = this.#filterItemsToRegion(page, region);
        for (const item of regionItems) {
          groupItems.push({ ...item, y: item.y + yOffset });
        }
        if (regionItems.length) {
          yOffset += Math.max(...regionItems.map(i => i.y)) + 50;
        }
      }

      if (!groupItems.length) continue;
      const result = detectTextSections(groupItems);
      sections.push(...result.sections);
    }

    return { sections };
  }

  // -------------------------------------------------------------------------
  // Scan / Text context menus
  // -------------------------------------------------------------------------

  #handleScanClick(event) {
    const rule       = this.selectedRule;
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
          rule.skipPattern = rule.skipPattern ? `${rule.skipPattern}|${_esc(val)}` : _esc(val);
          this.#schedulePreview(); this.render();
        }
      });
      menuItems.push({
        icon: 'fa-flag',
        label: `Set as Item Start Pattern`,
        action: () => { rule.rowDetectionPattern = `^${_esc(val)}`; this.#schedulePreview(); this.render(); }
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
    if (col && this._cachedAttributePaths.length) {
      menuItems.push({ separator: true });
      menuItems.push({ heading: `Map column "${col}" to field:` });
      for (const attr of this._cachedAttributePaths) {
        menuItems.push({
          icon: 'fa-link', label: attr.path,
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
        menuItems.push({ heading: `Map name to field:` });
        for (const attr of this._cachedAttributePaths) {
          menuItems.push({
            icon: 'fa-link', label: attr.path,
            action: () => {
              rule.attributes.push({ ...makeDefaultAttribute(), pattern: _esc(name), foundryField: attr.path });
              this.#schedulePreview(); this.render();
            }
          });
        }
      }
    }
    this.#showContextMenu(event, menuItems);
  }

  #mapColumnToField(rule, columnHeader, foundryField) {
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
      if (item.separator) { const hr = document.createElement('hr'); hr.className = 'dib-ctx-sep'; menu.appendChild(hr); continue; }
      if (item.heading)   { const h  = document.createElement('div'); h.className = 'dib-ctx-heading'; h.textContent = item.heading; menu.appendChild(h); continue; }
      const btn = document.createElement('button');
      btn.className = 'dib-ctx-item';
      btn.innerHTML = `<i class="fas ${item.icon ?? 'fa-circle'}"></i> ${item.label}`;
      btn.addEventListener('click', () => { item.action(); menu.remove(); });
      menu.appendChild(btn);
    }

    document.body.appendChild(menu);
    const { clientX: x, clientY: y } = event;
    const { offsetWidth: w, offsetHeight: h } = menu;
    menu.style.left = `${Math.min(x, window.innerWidth  - w - 8)}px`;
    menu.style.top  = `${Math.min(y, window.innerHeight - h - 8)}px`;

    const close = e => {
      if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('pointerdown', close, true); }
    };
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
    if (event.target.closest('[data-action="deleteRule"]')) return;
    const id = target.closest('[data-rule-id]')?.dataset.ruleId;
    if (!id || id === this._selectedRuleId) return;
    this._selectedRuleId = id;
    this._scanData = null;
    this.#snapPlannerPage();
    this.render();
    await this.#runScan();
    this.render();
  }

  static async #duplicateRule(event, target) {
    const id     = target.closest('[data-rule-id]')?.dataset.ruleId;
    const source = this._rules.find(r => r.id === id);
    if (!source) return;
    const copy  = foundry.utils.deepClone(source);
    copy.id   = foundry.utils.randomID();
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

  static async #deleteRegion(event, target) {
    const id   = target.closest('[data-region-id]')?.dataset.regionId;
    const rule = this.selectedRule;
    if (!id || !rule) return;
    rule.regions = (rule.regions ?? []).filter(r => r.id !== id);
    this.#schedulePreview();
    this.render();
  }

  static async #autoDetectRegions() {
    const rule = this.selectedRule;
    if (!this._pdf || !rule?.pages) {
      ui.notifications.warn('Load a PDF and set a page range first.');
      return;
    }
    try {
      const { extractPages, parsePageString, mergePageItems, detectTables } =
        await import('../pdf-parser.js');
      const pageNums = parsePageString(rule.pages, this._pdf.numPages);
      const pages    = await extractPages(this._pdf, pageNums);
      const allItems = mergePageItems(pages);
      const result   = detectTables(allItems);

      rule.regions ??= [];
      let added = 0;

      for (const table of result.tables) {
        // Compute bounding box of all items in this table
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

        // Determine which page this table is on (use page of first item)
        const firstItem = tableItems[0];
        const page      = firstItem?.page ?? pageNums[0];

        const count = rule.regions.filter(r => r.type === 'table').length + 1 + added;
        rule.regions.push({
          id: foundry.utils.randomID(),
          type: 'table', group: `table-${count}`,
          page, x: Math.round(x), y: Math.round(y),
          w: Math.round(w), h: Math.round(h),
          label: `Table ${count}`
        });
        added++;
      }

      if (added) {
        ui.notifications.info(`Auto-detected ${added} table region(s).`);
        this.render();
      } else {
        ui.notifications.warn('No tables detected. Try drawing regions manually.');
      }
    } catch (err) {
      ui.notifications.error(`Auto-detect failed: ${err.message}`);
      console.error(err);
    }
  }

  static async #refreshPreview() {
    await this.#runPreview();
  }

  static async #buildItems() {
    if (!this._pdf) { ui.notifications.warn('Load a PDF first.'); return; }
    const hasPreviews = this._rules.some(r => (this._preview[r.id]?.length ?? 0) > 0);
    if (!hasPreviews) { ui.notifications.warn('No items detected. Check your rules and refresh.'); return; }

    let total = 0;
    for (const rule of this._rules) {
      const items = this._preview[rule.id];
      if (!items?.length || !rule.itemType) continue;
      const folder = rule.folderId ? game.folders.get(rule.folderId) ?? null : null;
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
      _dibVersion: '1.0', system: game.system.id,
      exportedAt: new Date().toISOString(),
      rules: this._rules.map(r => foundry.utils.deepClone(r))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), {
      href: url, download: `dib-rules-${game.system.id}-${Date.now()}.json`
    });
    a.click();
    URL.revokeObjectURL(url);
  }

  static async #importRules() {
    const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json' });
    input.addEventListener('change', async e => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const data     = JSON.parse(await file.text());
        if (!Array.isArray(data.rules)) throw new Error('Missing "rules" array.');
        const imported = data.rules.map(r => ({ ...makeDefaultRule(), ...r, id: foundry.utils.randomID() }));
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
  const paths = [{ path: 'name', label: 'Name' }, { path: 'img', label: 'Image' }];
  if (!itemType) return paths;
  const template = game.system.template?.Item?.[itemType] ?? {};
  const flat = foundry.utils.flattenObject(template);
  for (const key of Object.keys(flat)) paths.push({ path: `system.${key}`, label: key });

  if (paths.length <= 2 && game.documentTypes?.Item?.includes(itemType)) {
    try {
      const tmp = new Item({ name: '_tmp', type: itemType });
      const sysFlat = foundry.utils.flattenObject(tmp.toObject().system ?? {});
      for (const key of Object.keys(sysFlat)) {
        if (!paths.some(p => p.path === `system.${key}`)) paths.push({ path: `system.${key}`, label: key });
      }
    } catch { /* ignore */ }
  }
  return paths;
}

// -------------------------------------------------------------------------
// Default factories
// -------------------------------------------------------------------------

function _esc(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function makeDefaultRule() {
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
    mixedConfig:         { tableXMin: 0, tableXMax: 9999, textXMin: 0, textXMax: 9999 },
    descriptionField:    '',
    attributes:          [],
    ignoredItems:        [],
    regions:             []
  };
}

function makeDefaultAttribute() {
  return {
    foundryField: '', columnHeader: '', columnIndex: '',
    pattern: '', flags: 'i', group: 1, transform: 'trim'
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
