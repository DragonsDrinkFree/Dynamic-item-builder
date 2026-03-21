/**
 * DynamicItemBuilderApp — three-panel ApplicationV2 UI.
 *
 * Left panel   : rule list
 * Center panel : planning — PDF Planner (canvas + region painter) | Item Planner (rule editor)
 * Right panel  : previews — Table Preview | Text Preview | Item Preview
 */

import {
  loadPDF, extractPages, parsePageString, mergePageItems, filterItemsToRegion,
  collectTableRegionItems, detectTables, renderPageToCanvas,
  applyManualHeaderOverrides, applyColumnMerges, applyColumnSplits,
  parseTextRegion, extractRegionFonts, normalizeItemName
} from '../pdf-parser.js';
import { applyRule }   from '../rule-engine.js';
import { buildItems }  from '../item-builder.js';
import { escapeRegex } from '../utils.js';
import { showContextMenu } from './context-menu.js';
import { computeSuggestionsForRule, enrichScanDataColumns } from './suggestions.js';
import { getSystemItemTypes, getItemAttributePaths, makeDefaultRule, makeDefaultAttribute, TRANSFORMS } from './factories.js';
import { showSetHeadersPopover as _showSetHeadersPopover, showSplitColumnPopover as _showSplitColumnPopover, showCellEditPopover as _showCellEditPopover, showMultiCellEditPopover as _showMultiCellEditPopover } from './popovers.js';
import { applyCellSelClasses, applyTestErrorClasses, applyOverrideClasses, bulkTransformColumn } from './cell-operations.js';
import { buildPreviewSummary, buildAttributeList } from './prepare-context.js';
import { getPdfCoords, createRegionData, buildRegionOverlay } from './planner.js';
import { validateItems } from './validation.js';

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
      refreshPreview:      DynamicItemBuilderApp.#refreshPreview,
      openAttributeMenu:   DynamicItemBuilderApp.#openAttributeMenu,
      acceptSuggestion:    DynamicItemBuilderApp.#acceptSuggestion,
      linkAllSuggestions:  DynamicItemBuilderApp.#linkAllSuggestions,
      testRun:             DynamicItemBuilderApp.#testRun,
      addTextRule:         DynamicItemBuilderApp.#addTextRule,
      deleteTextRule:      DynamicItemBuilderApp.#deleteTextRule,
      addTextField:        DynamicItemBuilderApp.#addTextField,
      deleteTextField:     DynamicItemBuilderApp.#deleteTextField,
      moveTextField:       DynamicItemBuilderApp.#moveTextField,
      addTextFieldRule:    DynamicItemBuilderApp.#addTextFieldRule,
      deleteTextFieldRule: DynamicItemBuilderApp.#deleteTextFieldRule,
      moveTextFieldRule:   DynamicItemBuilderApp.#moveTextFieldRule
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

  /** @type {string|null} Global default destination folder for all rules */
  _selectedFolderId = null;

  /** @type {Object|null} detectTables() result for current rule */
  _scanData = null;

  /** @type {Object} region.id → parsed text entries array */
  _textScanData = {};

  /** @type {Object} region.id → [{fontSize, fontName}] unique fonts in region */
  _textRegionFonts = {};

  // ── Tab state ──────────────────────────────────────────────────────────────

  /** @type {'planner'|'item-planner'} */
  _centerTab = 'planner';

  /** @type {'tables'|'preview'} */
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

  /** @type {Object} Keyed [ruleId][dibKey][field] — value overrides for preview cells */
  _cellOverrides = {};

  /** @type {Object} Keyed [ruleId][dibKey][field|'_row'] — test-run validation errors */
  _testErrors = {};

  /** @type {Array<{ruleId,dibKey,field}>} Currently highlighted column cells */
  _cellSel       = [];
  _cellSelField  = null;
  _cellSelRuleId = null;
  _lastCellKey   = null;
  _wasCellDrag   = false;

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
    const previewSummary = buildPreviewSummary(this._rules, this._preview, this._cellOverrides);

    const hasIgnoredItems = this._rules.some(r => (r.ignoredItems ?? []).length > 0);

    if (attributePaths.length) this._cachedAttributePaths = attributePaths;

    const itemFolders = game.folders
      .filter(f => f.type === 'Item')
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
      .map(f => ({ id: f.id, name: '\u00a0'.repeat((f.depth ?? 0) * 2) + f.name }));

    // Guard: removed tabs — fall back to tables
    if (this._rightTab === 'suggested') this._rightTab = 'tables';

    // Attribute link suggestions — computed from detected columns vs available paths
    const suggestions = rule && attributePaths.length && this._scanData
      ? computeSuggestionsForRule(rule, this._scanData, attributePaths)
      : [];

    // Flat attribute list for the mapping UI (all system fields + orphan mappings)
    const { attributeList, suggestionCount } = buildAttributeList(rule, attributePaths, suggestions);

    const textScanContext = this.#buildTextScanContext(rule);
    const textFontsJson   = JSON.stringify(textScanContext?.availableFonts ?? []);

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
      transforms:      TRANSFORMS,
      itemFolders,
      selectedFolderId: this._selectedFolderId,
      scanData:  enrichScanDataColumns(this._scanData, rule, suggestions),
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
      hasTextRegions:   (rule?.regions ?? []).some(r => r.type === 'text'),
      // Text scan data for the Text Preview tab
      textScanContext,
      textFontsJson,
      // Attribute mapping list
      attributeList,
      suggestionCount,
      previewHasContent: previewSummary.some(r => (r.items ?? []).length > 0),
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
    // Mark overridden, multi-selected, and errored preview cells
    this.#applyOverrideClasses();
    this.#applyCellSelClasses();
    this.#applyTestErrorClasses();
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

    // Global folder picker
    el.querySelector('#dib-folder-select')?.addEventListener('change', e => {
      this._selectedFolderId = e.target.value || null;
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

    // Region sidebar: label + group + text region config field changes
    el.querySelector('.dib-region-sidebar')?.addEventListener('change', e => {
      const input = e.target.closest('[data-region-field]');
      if (!input) return;
      const id    = input.dataset.regionId;
      const field = input.dataset.regionField;
      const rule  = this.selectedRule;
      const region = (rule?.regions ?? []).find(r => r.id === id);
      if (!region) return;
      // Checkboxes use .checked; selects and text inputs use .value
      region[field] = input.type === 'checkbox' ? input.checked : input.value;
      this.#schedulePreview();
      this.#updateRegionOverlay();
    });

    // Legacy Name Rules inputs — update data only, no auto-refresh
    el.querySelector('.dib-text-rules-section')?.addEventListener('input', e => {
      const input = e.target.closest('.dib-text-rule-input');
      if (!input) return;
      const rule = this.selectedRule;
      const tr = (rule?.textRules ?? []).find(r => r.id === input.dataset.textRuleId);
      if (tr) tr.pattern = input.value;
    });

    // Field Rules: input changes (header, foundryAttr, rule patterns) — no auto-refresh
    el.querySelector('.dib-field-rules-section')?.addEventListener('input', e => {
      const rule = this.selectedRule;
      if (!rule) return;
      const fieldEl = e.target.closest('[data-field-id]');
      if (!fieldEl) return;
      const tf = (rule.textFields ?? []).find(f => f.id === fieldEl.dataset.fieldId);
      if (!tf) return;
      const prop = e.target.dataset.fieldProp;
      if (prop === 'header')      { tf.header      = e.target.value; return; }
      if (prop === 'foundryAttr') { tf.foundryAttr = e.target.value; return; }
      // Rule pattern input inside this field — only when the target itself has data-rule-id
      // (avoids picking up checkboxes/selects inside format rule rows whose ancestor has it)
      if (e.target.dataset.ruleId) {
        const tr = (tf.rules ?? []).find(r => r.id === e.target.dataset.ruleId);
        if (tr) tr.pattern = e.target.value;
      }
    });

    // Field Rules: font-target select changes (font size filters font name dropdown)
    el.querySelector('.dib-field-rules-section')?.addEventListener('change', e => {
      const rule     = this.selectedRule;
      if (!rule) return;
      const fieldEl  = e.target.closest('[data-field-id]');
      const ruleEl   = e.target.closest('[data-rule-id]');
      if (!fieldEl || !ruleEl) return;
      const tf = (rule.textFields ?? []).find(f => f.id === fieldEl.dataset.fieldId);
      const tr = (tf?.rules ?? []).find(r => r.id === ruleEl.dataset.ruleId);
      if (!tr) return;

      // Format rule: checkboxes and header select
      if (tr.type === 'format') {
        const prop = e.target.dataset.formatProp;
        if (!prop) return;
        tr[prop] = e.target.type === 'checkbox' ? e.target.checked
                 : e.target.type === 'number'   ? Number(e.target.value)
                 : e.target.value;
        this.#schedulePreview();
        return;
      }

      // Regex-target / target rule: group number input
      if (tr.type === 'regex-target' || tr.type === 'target') {
        if (e.target.dataset.ruleProp !== 'group') return;
        tr.group = Number(e.target.value);
        this.#schedulePreview();
        return;
      }

      if (tr.type !== 'font-target') return;

      if (e.target.classList.contains('dib-font-size-select')) {
        tr.fontSize = e.target.value;
        // Filter the adjacent font-name select options
        const section   = e.target.closest('.dib-field-rules-section');
        const allFonts  = JSON.parse(section?.dataset.fonts ?? '[]');
        const nameSelect = ruleEl.querySelector('.dib-font-name-select');
        if (nameSelect) {
          const filtered = tr.fontSize === 'ALL'
            ? [...new Set(allFonts.map(f => f.fontName))]
            : [...new Set(allFonts.filter(f => String(f.fontSize) === tr.fontSize).map(f => f.fontName))];
          // Reset to ALL if current selection is no longer valid
          if (tr.fontName !== 'ALL' && !filtered.includes(tr.fontName)) tr.fontName = 'ALL';
          nameSelect.innerHTML = '<option value="ALL">ALL</option>'
            + filtered.map(n => `<option value="${n}"${n === tr.fontName ? ' selected' : ''}>${n}</option>`).join('');
        }
      } else if (e.target.classList.contains('dib-font-name-select')) {
        tr.fontName = e.target.value;
      }
      this.#schedulePreview();
    });

    // Text Preview: column header clicks
    el.querySelector('.dib-text-preview')?.addEventListener('click', e => {
      const th = e.target.closest('.dib-text-preview-th');
      if (th) this.#showTextColumnMenu(e, th);
    });

    // Scan cell clicks (Table Preview)
    el.querySelector('.dib-scan-content')?.addEventListener('click', e => {
      const hdrBtn = e.target.closest('.dib-set-headers-btn');
      if (hdrBtn) { e.stopPropagation(); this.#showSetHeadersPopover(e, hdrBtn.dataset.tableId); return; }
      this.#handleScanClick(e);
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

    // Row selection — only triggered from the dedicated selection column cell
    this.#bindListSelection(
      el.querySelector('.preview-list'), this._previewSel,
      '_lastPreviewClickKey', () => this.#updatePreviewToolbar(this.element),
      '.dib-sel-cell'
    );
    this.#bindListSelection(
      el.querySelector('.ignore-list'), this._ignoreSel,
      '_lastIgnoreClickKey', () => this.#updateIgnoreToolbar(this.element),
      '.dib-sel-cell'
    );

    // Column-cell drag selection (mousedown to support drag-range)
    const previewList = el.querySelector('.preview-list');
    previewList?.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const td = e.target.closest('.preview-td');
      if (!td) return;
      e.preventDefault();

      const ruleEl  = td.closest('[data-rule-id]');
      const rowEl   = td.closest('[data-item-key]');
      const ruleId  = ruleEl?.dataset.ruleId;
      const itemKey = rowEl?.dataset.itemKey;
      const field   = td.dataset.field;
      if (!ruleId || !itemKey || !field) return;
      const dibKey = itemKey.substring(ruleId.length + 2);

      if (e.shiftKey && this._lastCellKey
          && this._cellSelField === field && this._cellSelRuleId === ruleId) {
        this.#cellRangeSelect(ruleId, field, this._lastCellKey, dibKey);
      } else if (e.ctrlKey || e.metaKey) {
        if (this._cellSelField !== field || this._cellSelRuleId !== ruleId) {
          this._cellSel = [];
          this._cellSelField = field;
          this._cellSelRuleId = ruleId;
        }
        const idx = this._cellSel.findIndex(c => c.dibKey === dibKey);
        if (idx >= 0) this._cellSel.splice(idx, 1);
        else this._cellSel.push({ ruleId, dibKey, field });
        this._lastCellKey = dibKey;
      } else {
        const alreadyInMulti = this._cellSel.length > 1
          && this.#isCellSelected(ruleId, dibKey, field)
          && this._cellSelField === field && this._cellSelRuleId === ruleId;

        if (!alreadyInMulti) {
          this._cellSel      = [{ ruleId, dibKey, field }];
          this._cellSelField = field;
          this._cellSelRuleId = ruleId;
          this._lastCellKey  = dibKey;

          // Drag to extend range within same column
          this._wasCellDrag = false;
          const startDibKey = dibKey;
          const onMove = ev => {
            const overTd = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.preview-td');
            if (!overTd || overTd.dataset.field !== field) return;
            const overRuleEl = overTd.closest('[data-rule-id]');
            if (overRuleEl?.dataset.ruleId !== ruleId) return;
            const overKey = overTd.closest('[data-item-key]')?.dataset.itemKey?.substring(ruleId.length + 2);
            if (!overKey) return;
            this.#cellRangeSelect(ruleId, field, startDibKey, overKey);
            this._wasCellDrag = true;
            this.#applyCellSelClasses();
          };
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', () => {
            document.removeEventListener('mousemove', onMove);
            this.#applyCellSelClasses();
          }, { once: true });
        }
      }
      this.#applyCellSelClasses();
    });

    // Column header menu + per-cell context menu in Item Preview
    previewList?.addEventListener('click', e => {
      // Always eat the click that follows a drag regardless of where mouse was released
      if (this._wasCellDrag) { this._wasCellDrag = false; return; }
      const th = e.target.closest('.preview-th');
      if (th) { this.#showColumnMenu(e, th); return; }
      const td = e.target.closest('.preview-td');
      if (td) {
        this.#showCellMenu(e, td);
        return;
      }
      // Clicked outside any cell — clear column selection
      if (this._cellSel.length > 0) {
        this._cellSel = []; this._cellSelField = null; this._cellSelRuleId = null;
        this.#applyCellSelClasses();
      }
    });
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

    const regions = (this.selectedRule?.regions ?? []).filter(r => r.page === this._plannerPage);
    overlay.innerHTML = '';
    overlay.appendChild(
      buildRegionOverlay(regions, this._plannerScale, canvas.width, canvas.height, this._drawRect, this._drawMode)
    );
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
    return getPdfCoords(event, this.element?.querySelector('#dib-pdf-canvas'), this._plannerScale);
  }

  #addRegion(rect) {
    const rule = this.selectedRule;
    if (!rule) return;
    rule.regions ??= [];
    rule.regions.push(createRegionData(this._drawMode, rect, this._plannerPage, rule.regions));
    this.#schedulePreview();
    this.render();
  }

  // -------------------------------------------------------------------------
  // Preview / Ignore selection
  // -------------------------------------------------------------------------

  #bindListSelection(listEl, selSet, lastKeyProp, onUpdate, triggerSelector = null) {
    if (!listEl) return;
    listEl.addEventListener('mousedown', e => {
      const origin = triggerSelector
        ? e.target.closest(triggerSelector)
        : e.target.closest('[data-item-key]');
      if (!origin) return;
      const row = origin.closest('[data-item-key]');
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
        ?.find((_item, idx) => `_${idx}` === dibKey);
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
    this._testErrors = {};   // stale test results no longer valid after a re-scan
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
      this._scanData        = null;
      this._textScanData    = {};
      this._textRegionFonts = {};
      return;
    }

    try {
      const pageNums     = parsePageString(rule.pages, this._pdf.numPages);
      const pages        = await extractPages(this._pdf, pageNums);
      const tableRegions = (rule.regions ?? []).filter(r => r.type === 'table');
      const textRegions  = (rule.regions ?? []).filter(r => r.type === 'text');

      if (tableRegions.length > 0) {
        this._scanData = collectTableRegionItems(pages, tableRegions);
      } else {
        // Auto-detect fallback
        const allItems = mergePageItems(pages);
        this._scanData = detectTables(allItems);
      }

      // Scan text regions
      this._textScanData    = {};
      this._textRegionFonts = {};
      for (const region of textRegions) {
        const page = pages.find(p => p.pageNum === region.page);
        if (!page) continue;
        const regionItems = filterItemsToRegion(page.items, region);
        if (!regionItems.length) continue;

        this._textRegionFonts[region.id] = extractRegionFonts(regionItems);
        this._textScanData[region.id] = parseTextRegion(regionItems, rule);
      }
    } catch (err) {
      console.warn('Dynamic Item Builder | Scan error:', err);
      this._scanData = null;
    }

    // Apply any manually-set column headers stored in the rule
    applyManualHeaderOverrides(this._scanData?.tables, rule?.manualHeaders);

    // Apply any column merges defined for this rule
    this.#applyColumnMerges(rule);

    // Apply any column splits defined for this rule
    this.#applyColumnSplits(rule);

    // Auto-populate headerPattern from the first labeled column if not already set
    if (rule && !rule.headerPattern?.trim() && this._scanData?.tables?.[0]?.columns?.length) {
      const firstHeader = this._scanData.tables[0].columns.find(c => c.header)?.header;
      if (firstHeader) rule.headerPattern = firstHeader;
    }
  }

  #applyColumnMerges(rule) {
    if (!this._scanData?.tables || !rule?.columnMerges) return;
    applyColumnMerges(this._scanData.tables, rule.columnMerges);
  }

  #applyColumnSplits(rule) {
    if (!this._scanData?.tables || !rule?.columnSplits) return;
    applyColumnSplits(this._scanData.tables, rule.columnSplits);
  }

  /**
   * Build the data context for the Text Preview tab.
   * Returns an array of region objects, each with their parsed entries enriched
   * with match status (matched/unmatched/unlinked) relative to the table scan.
   */
  #buildTextScanContext(rule) {
    if (!rule) return null;
    const textRegions = (rule.regions ?? []).filter(r => r.type === 'text');
    if (!textRegions.length) return null;

    const textFields = rule.textFields?.length ? rule.textFields : null;
    const nameAttr   = (rule.attributes ?? []).find(a => a.foundryField === 'name' && !a.isVirtual);
    const allEntries = [];

    for (const region of textRegions) {
      const entries = this._textScanData[region.id] ?? [];
      allEntries.push(...entries);
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

    // Determine whether we have a table to match against
    const hasTables = (this._scanData?.tables?.length ?? 0) > 0;
    const joinField = textFields?.find(f => f.isJoinTarget);

    const enrichedEntries = allEntries.map(entry => {
      let matchStatus = 'unlinked';
      const canMatch = hasTables && (joinField || nameAttr);
      if (canMatch) {
        const normEntry = normalizeItemName(entry._textName ?? '');
        let found = false;
        for (const table of (this._scanData?.tables ?? [])) {
          for (const row of table.rows) {
            if (row._injected || row._sectionHeader) continue;
            const nameCell = nameAttr
              ? row.cells.find(c => c.column === nameAttr.columnHeader)
              : row.cells[0];
            if (!nameCell) continue;
            const normRow = normalizeItemName(nameCell.value);
            if (normRow === normEntry || normRow.includes(normEntry) || normEntry.includes(normRow)) {
              found = true; break;
            }
          }
          if (found) break;
        }
        matchStatus = found ? 'matched' : 'unmatched';
      }
      const _cols = columns.map(c => ({ id: c.id, header: c.header, isJoinTarget: c.isJoinTarget, value: entry[c.id] ?? '' }));
      return { ...entry, _matchStatus: matchStatus, _cols };
    });

    // Aggregate unique fonts across all text regions for the field rule dropdowns
    const fontSet = new Map();
    for (const region of textRegions) {
      for (const f of (this._textRegionFonts[region.id] ?? [])) {
        const key = `${f.fontSize}::${f.fontName}`;
        if (!fontSet.has(key)) fontSet.set(key, f);
      }
    }
    const availableFonts     = [...fontSet.values()].sort((a, b) => b.fontSize - a.fontSize || a.fontName.localeCompare(b.fontName));
    const availableFontSizes = [...new Set(availableFonts.map(f => String(f.fontSize)))];
    const availableFontNames = [...new Set(availableFonts.map(f => f.fontName))];

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

  // -------------------------------------------------------------------------
  // Text column header menu
  // -------------------------------------------------------------------------

  #showTextColumnMenu(event, th) {
    event.stopPropagation();
    const fieldId = th.dataset.fieldId;
    if (!fieldId) return;
    const rule = this.selectedRule;
    if (!rule) return;
    const tf = (rule.textFields ?? []).find(f => f.id === fieldId);
    if (!tf) return;

    const menuItems = [];

    // Join Target toggle
    if (tf.isJoinTarget) {
      menuItems.push({
        icon: 'fa-unlink',
        label: 'Remove Join Target',
        action: () => { tf.isJoinTarget = false; this.#schedulePreview(); this.render(); }
      });
    } else {
      menuItems.push({
        icon: 'fa-link',
        label: 'Set as Join Target',
        action: () => {
          for (const f of (rule.textFields ?? [])) f.isJoinTarget = false;
          tf.isJoinTarget = true;
          this.#schedulePreview();
          this.render();
        }
      });
    }

    // Link Attribute
    if (this._cachedAttributePaths?.length) {
      menuItems.push({ separator: true });
      menuItems.push({ heading: `Map "${tf.header || 'field'}" to attribute:` });
      menuItems.push({ filterInput: true });
      for (const attr of this._cachedAttributePaths) {
        menuItems.push({
          icon: 'fa-database', label: attr.path, filterable: true,
          action: () => { tf.foundryAttr = attr.path; this.#schedulePreview(); this.render(); }
        });
      }
      if (tf.foundryAttr) {
        menuItems.push({ separator: true });
        menuItems.push({
          icon: 'fa-times',
          label: 'Clear attribute mapping',
          action: () => { tf.foundryAttr = ''; this.render(); }
        });
      }
    }

    this.#showContextMenu(event, menuItems);
  }

  // -------------------------------------------------------------------------
  // Text rules
  // -------------------------------------------------------------------------

  static #addTextRule(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    rule.textRules ??= [];
    rule.textRules.push({ id: foundry.utils.randomID(), type: target.dataset.ruleType ?? 'target', pattern: '' });
    this.render();
  }

  static #deleteTextRule(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    const id = target.closest('[data-text-rule-id]')?.dataset.textRuleId;
    rule.textRules = (rule.textRules ?? []).filter(r => r.id !== id);
    this.#schedulePreview();
    this.render();
  }

  // -------------------------------------------------------------------------
  // Field rules actions
  // -------------------------------------------------------------------------

  static #addTextField() {
    const rule = this.selectedRule;
    if (!rule) return;
    rule.textFields ??= [];
    rule.textFields.push({
      id:           foundry.utils.randomID(),
      header:       '',
      isJoinTarget: false,
      foundryAttr:  '',
      rules:        []
    });
    this.render();
  }

  static #deleteTextField(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    const id = target.closest('[data-field-id]')?.dataset.fieldId;
    rule.textFields = (rule.textFields ?? []).filter(f => f.id !== id);
    this.#schedulePreview();
    this.render();
  }

  static #moveTextField(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    const id  = target.closest('[data-field-id]')?.dataset.fieldId;
    const dir = target.dataset.dir;
    const arr = rule.textFields ?? [];
    const idx = arr.findIndex(f => f.id === id);
    if (idx < 0) return;
    const swap = dir === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= arr.length) return;
    [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
    this.render();
  }

  static #addTextFieldRule(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    const fieldId = target.closest('[data-field-id]')?.dataset.fieldId;
    const tf = (rule.textFields ?? []).find(f => f.id === fieldId);
    if (!tf) return;
    tf.rules ??= [];
    const ruleType = target.dataset.ruleType ?? 'regex-target';
    if (ruleType === 'font-target') {
      tf.rules.push({ id: foundry.utils.randomID(), type: 'font-target', fontSize: 'ALL', fontName: 'ALL' });
    } else if (ruleType === 'format') {
      tf.rules.push({
        id: foundry.utils.randomID(), type: 'format', pattern: '',
        group: 0,
        lineBreakBefore: false, lineBreakAfter: false,
        bold: false, italic: false, underline: false, indent: false, header: ''
      });
    } else {
      tf.rules.push({ id: foundry.utils.randomID(), type: ruleType, pattern: '', group: 0 });
    }
    this.render();
  }

  static #deleteTextFieldRule(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    const fieldId = target.closest('[data-field-id]')?.dataset.fieldId;
    const ruleId  = target.closest('[data-rule-id]')?.dataset.ruleId;
    const tf = (rule.textFields ?? []).find(f => f.id === fieldId);
    if (!tf) return;
    tf.rules = (tf.rules ?? []).filter(r => r.id !== ruleId);
    this.#schedulePreview();
    this.render();
  }

  static #moveTextFieldRule(event, target) {
    const rule = this.selectedRule;
    if (!rule) return;
    const fieldId = target.closest('[data-field-id]')?.dataset.fieldId;
    const ruleId  = target.closest('[data-rule-id]')?.dataset.ruleId;
    const dir     = target.dataset.dir;
    const tf = (rule.textFields ?? []).find(f => f.id === fieldId);
    if (!tf) return;
    const arr = tf.rules ?? [];
    const idx = arr.findIndex(r => r.id === ruleId);
    if (idx < 0) return;
    const swap = dir === 'up' ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= arr.length) return;
    [arr[idx], arr[swap]] = [arr[swap], arr[idx]];
    this.render();
  }

  // -------------------------------------------------------------------------
  // Scan context menus
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
      const tableId = headerCell.dataset.tableId;
      menuItems.push({
        icon: 'fa-heading',
        label: `Set Header Pattern: "${col}"`,
        action: () => { rule.headerPattern = col; this.#schedulePreview(); this.render(); }
      });
      const hasSplit = rule.columnSplits?.[tableId]?.[col];
      menuItems.push({
        icon: 'fa-columns',
        label: hasSplit ? `Edit Split: "${col}" (on "${hasSplit}")` : `Split Column: "${col}"`,
        action: () => this.#showSplitColumnPopover(event, tableId, col)
      });
      if (hasSplit) {
        menuItems.push({
          icon: 'fa-times',
          label: `Remove Split: "${col}"`,
          action: () => {
            delete rule.columnSplits[tableId][col];
            if (!Object.keys(rule.columnSplits[tableId]).length) delete rule.columnSplits[tableId];
            this.#schedulePreview();
          }
        });
      }
      const table   = this._scanData?.tables?.find(t => t.id === tableId);
      const colIdx  = table?.columns.findIndex(c => c.header === col) ?? -1;
      const nextCol = colIdx >= 0 && colIdx < (table.columns.length - 1) ? table.columns[colIdx + 1].header : null;
      const hasMerge = rule.columnMerges?.[tableId]?.some(([a, b]) => {
        return a === col || b === col || [a, b].filter(h => h.trim()).join(' ') === col;
      });
      if (nextCol !== null) {
        menuItems.push({
          icon: 'fa-compress-alt',
          label: `Merge "${col || '(unlabeled)'}" → "${nextCol || '(unlabeled)'}"`,
          action: () => {
            if (!rule.columnMerges) rule.columnMerges = {};
            if (!rule.columnMerges[tableId]) rule.columnMerges[tableId] = [];
            rule.columnMerges[tableId].push([col, nextCol]);
            this.#schedulePreview();
          }
        });
      }
      if (hasMerge) {
        menuItems.push({
          icon: 'fa-expand-alt',
          label: `Remove Merge: "${col || '(unlabeled)'}"`,
          action: () => {
            rule.columnMerges[tableId] = rule.columnMerges[tableId].filter(([a, b]) => {
              return a !== col && b !== col && [a, b].filter(h => h.trim()).join(' ') !== col;
            });
            if (!rule.columnMerges[tableId].length) delete rule.columnMerges[tableId];
            this.#schedulePreview();
          }
        });
      }
    }
    if (dataCell) {
      const val = dataCell.dataset.value;
      menuItems.push({
        icon: 'fa-ban',
        label: `Add to Skip Pattern: "${val}"`,
        action: () => {
          rule.skipPattern = rule.skipPattern ? `${rule.skipPattern}|${escapeRegex(val)}` : escapeRegex(val);
          this.#schedulePreview(); this.render();
        }
      });
      menuItems.push({
        icon: 'fa-flag',
        label: `Set as Item Start Pattern`,
        action: () => { rule.rowDetectionPattern = `^${escapeRegex(val)}`; this.#schedulePreview(); this.render(); }
      });
    }
    if (proseBlock) {
      const text = proseBlock.dataset.text?.slice(0, 40);
      menuItems.push({
        icon: 'fa-flag',
        label: `Set as Item Start Pattern: "${text}…"`,
        action: () => {
          rule.rowDetectionPattern = escapeRegex(proseBlock.dataset.text.split(' ')[0]);
          this.#schedulePreview(); this.render();
        }
      });
    }
    if (col && this._cachedAttributePaths.length) {
      menuItems.push({ separator: true });
      menuItems.push({ heading: `Map column "${col}" to field:` });
      menuItems.push({ filterInput: true });
      for (const attr of this._cachedAttributePaths) {
        menuItems.push({
          icon: 'fa-link', label: attr.path, filterable: true,
          action: () => { this.#mapColumnToField(rule, col, attr.path); this.render(); }
        });
      }
    }
    this.#showContextMenu(event, menuItems);
  }

  #showSetHeadersPopover(event, tableId) {
    const rule  = this.selectedRule;
    const table = this._scanData?.tables?.find(t => t.id === tableId);
    if (!rule || !table) return;

    const anchor = event.target.closest('.dib-set-headers-btn')
      ?? { getBoundingClientRect: () => ({ bottom: event.clientY, left: event.clientX, top: event.clientY }) };

    _showSetHeadersPopover(anchor, table, rule.manualHeaders?.[tableId], (headers, originalHeaders) => {
      if (!rule.manualHeaders) rule.manualHeaders = {};
      rule.manualHeaders[tableId] = { headers, originalHeaders };

      // Remove any previously injected row, then remap existing cells by index
      table.rows = table.rows.filter(r => !r._injected);
      for (const row of table.rows) {
        row.cells = row.cells.map((cell, i) => ({ ...cell, column: headers[i] ?? cell.column }));
      }

      // Inject original header values as the first data row
      if (originalHeaders.some(h => h)) {
        table.rows.unshift({
          cells:   headers.map((h, i) => ({ column: h, value: originalHeaders[i] ?? '' })),
          rawText: originalHeaders.join(' '),
          _injected: true
        });
      }

      // Apply new column names
      headers.forEach((h, i) => { if (table.columns[i]) table.columns[i].header = h; });
      this.render();
    });
  }

  #showSplitColumnPopover(event, tableId, col) {
    const rule = this.selectedRule;
    if (!rule || !tableId || !col) return;

    const anchor = event.target.closest('[data-scan]')
      ?? { getBoundingClientRect: () => ({ bottom: event.clientY, left: event.clientX, top: event.clientY }) };

    _showSplitColumnPopover(anchor, col, rule.columnSplits?.[tableId]?.[col] ?? '', (delimiter) => {
      if (delimiter) {
        if (!rule.columnSplits) rule.columnSplits = {};
        if (!rule.columnSplits[tableId]) rule.columnSplits[tableId] = {};
        rule.columnSplits[tableId][col] = delimiter;
      }
      this.#schedulePreview();
    });
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

  #isCellSelected(ruleId, dibKey, field) {
    return this._cellSel.some(c => c.ruleId === ruleId && c.dibKey === dibKey && c.field === field);
  }

  #cellRangeSelect(ruleId, field, fromDibKey, toDibKey) {
    const ruleEl  = this.element?.querySelector(`.preview-rule[data-rule-id="${CSS.escape(ruleId)}"]`);
    if (!ruleEl) return;
    const allRows = [...ruleEl.querySelectorAll('.preview-tr[data-item-key]')];
    const keys    = allRows.map(r => r.dataset.itemKey.substring(ruleId.length + 2));
    const fromIdx = keys.indexOf(fromDibKey);
    const toIdx   = keys.indexOf(toDibKey);
    if (fromIdx < 0 || toIdx < 0) return;
    const [lo, hi] = [Math.min(fromIdx, toIdx), Math.max(fromIdx, toIdx)];
    this._cellSel       = keys.slice(lo, hi + 1).map(dibKey => ({ ruleId, dibKey, field }));
    this._cellSelField  = field;
    this._cellSelRuleId = ruleId;
  }

  #applyCellSelClasses() {
    applyCellSelClasses(this.element, this._cellSel);
  }

  #showMultiCellEditPopover(anchorTd, ruleId, field) {
    _showMultiCellEditPopover(anchorTd, this._cellSel.length, field.split('.').pop(), (val) => {
      for (const { ruleId: rid, dibKey, field: f } of this._cellSel) {
        if (!this._cellOverrides[rid])         this._cellOverrides[rid] = {};
        if (!this._cellOverrides[rid][dibKey]) this._cellOverrides[rid][dibKey] = {};
        this._cellOverrides[rid][dibKey][f] = val;
        this.#clearTestError(rid, dibKey, f);
      }
      this.render();
    });
  }

  #clearTestError(ruleId, dibKey, field) {
    const item = this._testErrors[ruleId]?.[dibKey];
    if (!item) return;
    delete item[field];
    // If no specific field errors remain, clear the row-level error too
    if (!Object.keys(item).some(k => k !== '_row')) {
      delete this._testErrors[ruleId][dibKey];
      if (!Object.keys(this._testErrors[ruleId]).length) delete this._testErrors[ruleId];
    }
  }

  #applyTestErrorClasses() {
    applyTestErrorClasses(this.element, this._testErrors);
  }

  #applyOverrideClasses() {
    applyOverrideClasses(this.element, this._cellOverrides);
  }

  #showColumnMenu(event, th) {
    const ruleEl = th.closest('[data-rule-id]');
    const ruleId = ruleEl?.dataset.ruleId;
    const field  = th.dataset.field;
    if (!ruleId || !field) return;

    const bulkOpts = () => {
      const rule        = this._rules.find(r => r.id === ruleId);
      const ignoredKeys = new Set((rule?.ignoredItems ?? []).map(i => i._dibKey));
      return { ruleId, field, items: this._preview[ruleId] ?? [], cellOverrides: this._cellOverrides, ignoredKeys };
    };

    this.#showContextMenu(event, [
      {
        icon: 'fa-font',
        label: 'Lowercase all values',
        action: () => {
          if (bulkTransformColumn({ ...bulkOpts(), transform: v => v.toLowerCase() }) > 0) this.render();
        }
      },
      {
        icon: 'fa-hashtag',
        label: 'Convert to integer',
        action: () => {
          const changed = bulkTransformColumn({
            ...bulkOpts(),
            transform: v => {
              const parsed = parseInt(v.replace(/,/g, ''), 10);
              return isNaN(parsed) ? null : String(parsed);
            }
          });
          if (changed > 0) this.render();
        }
      }
    ]);
  }

  #showCellMenu(event, td) {
    event.stopPropagation();
    const ruleEl  = td.closest('[data-rule-id]');
    const rowEl   = td.closest('[data-item-key]');
    const ruleId  = ruleEl?.dataset.ruleId;
    const itemKey = rowEl?.dataset.itemKey;
    const field   = td.dataset.field;
    if (!ruleId || !itemKey || !field) return;

    const dibKey      = itemKey.substring(ruleId.length + 2);
    const hasOverride = this._cellOverrides[ruleId]?.[dibKey]?.[field] !== undefined;
    const inMultiSel  = this._cellSel.length > 1
      && this._cellSelField === field
      && this._cellSelRuleId === ruleId
      && this.#isCellSelected(ruleId, dibKey, field);

    const menuItems = [];

    if (inMultiSel) {
      menuItems.push({
        icon: 'fa-edit',
        label: `Override Selected (${this._cellSel.length} cells)`,
        action: () => this.#showMultiCellEditPopover(td, ruleId, field)
      });
      menuItems.push({ separator: true });
    }

    menuItems.push({
      icon: 'fa-edit',
      label: 'Override Value',
      action: () => this.#showCellEditPopover(td, ruleId, dibKey, field)
    });

    if (hasOverride) {
      menuItems.push(
        { separator: true },
        { icon: 'fa-undo', label: 'Restore Default',
          action: () => { delete this._cellOverrides[ruleId][dibKey][field]; this.render(); }
        }
      );
    }

    if (inMultiSel) {
      const anyOverrides = this._cellSel.some(
        c => this._cellOverrides[c.ruleId]?.[c.dibKey]?.[c.field] !== undefined
      );
      if (anyOverrides) {
        menuItems.push({
          icon: 'fa-undo',
          label: `Restore All Selected`,
          action: () => {
            for (const c of this._cellSel) {
              if (this._cellOverrides[c.ruleId]?.[c.dibKey])
                delete this._cellOverrides[c.ruleId][c.dibKey][c.field];
            }
            this.render();
          }
        });
      }
    }

    this.#showContextMenu(event, menuItems);
  }

  #showCellEditPopover(td, ruleId, dibKey, field) {
    const existing = this._cellOverrides[ruleId]?.[dibKey]?.[field];
    const startVal = existing !== undefined ? existing : td.textContent.trim();

    _showCellEditPopover(td, field.split('.').pop(), startVal, (val) => {
      if (!this._cellOverrides[ruleId])         this._cellOverrides[ruleId] = {};
      if (!this._cellOverrides[ruleId][dibKey]) this._cellOverrides[ruleId][dibKey] = {};
      this._cellOverrides[ruleId][dibKey][field] = val;
      this.#clearTestError(ruleId, dibKey, field);
      this.render();
    });
  }

  #showContextMenu(event, items) {
    showContextMenu(event, items);
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
    delete this._cellOverrides[id];
    delete this._testErrors[id];
    if (this._selectedRuleId === id) this._selectedRuleId = this._rules[0]?.id ?? null;
    this.render();
  }

  static async #selectRule(event, target) {
    if (event.target.closest('[data-action="deleteRule"]')) return;
    const id = target.closest('[data-rule-id]')?.dataset.ruleId;
    if (!id || id === this._selectedRuleId) return;
    this._selectedRuleId  = id;
    this._scanData        = null;
    this._textScanData    = {};
    this._textRegionFonts = {};
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

  static async #testRun() {
    const hasPreviews = this._rules.some(r => (this._preview[r.id]?.length ?? 0) > 0);
    if (!hasPreviews) {
      ui.notifications.warn('Run a Refresh first so there are items to validate.');
      return;
    }

    // Suppress Foundry notification toasts during validation
    const origError = ui.notifications.error.bind(ui.notifications);
    const origWarn  = ui.notifications.warn.bind(ui.notifications);
    const origInfo  = ui.notifications.info.bind(ui.notifications);
    ui.notifications.error = () => {};
    ui.notifications.warn  = () => {};
    ui.notifications.info  = () => {};

    try {
      this._testErrors = validateItems(this._rules, this._preview, this._cellOverrides, CONFIG.Item.documentClass);
    } finally {
      ui.notifications.error = origError;
      ui.notifications.warn  = origWarn;
      ui.notifications.info  = origInfo;
    }

    const errorCount = Object.values(this._testErrors)
      .reduce((n, items) => n + Object.values(items).filter(f => f._row).length, 0);

    this._rightTab = 'preview';
    if (errorCount === 0) {
      ui.notifications.info('Test Run: All items passed validation.');
    } else {
      ui.notifications.warn(`Test Run: ${errorCount} item(s) have validation errors — see red rows in Items Preview.`);
    }
    this.render();
  }

  // ── Suggested Links actions ──────────────────────────────────────────────

  // ── Attribute mapping actions ────────────────────────────────────────────

  static async #openAttributeMenu(event, target) {
    const foundryField = target.dataset.foundryField;
    const rule = this.selectedRule;
    if (!rule || !foundryField) return;

    const mapping  = rule.attributes.find(a => a.foundryField === foundryField && a.columnHeader);
    const inPreview = (rule.manualColumns ?? []).includes(foundryField);
    const menuItems = [
      {
        icon: 'fa-search',
        label: 'Inspect / Edit Mapping',
        action: () => this.#showAttributeDialog(foundryField)
      }
    ];
    if (mapping) {
      menuItems.push({
        icon: 'fa-unlink',
        label: `Remove Link  (${mapping.columnHeader})`,
        action: () => {
          rule.attributes = rule.attributes.filter(
            a => !(a.foundryField === foundryField && a.columnHeader === mapping.columnHeader)
          );
          this.#schedulePreview();
          this.render();
        }
      });
    } else if (inPreview) {
      menuItems.push({
        icon: 'fa-eye-slash',
        label: 'Remove from Preview',
        action: () => {
          rule.manualColumns = (rule.manualColumns ?? []).filter(p => p !== foundryField);
          this.render();
        }
      });
    } else {
      menuItems.push({
        icon: 'fa-eye',
        label: 'Add to Preview',
        action: () => {
          rule.manualColumns = [...(rule.manualColumns ?? []), foundryField];
          this.render();
        }
      });
    }
    this.#showContextMenu(event, menuItems);
  }

  static async #acceptSuggestion(event, target) {
    const rule   = this.selectedRule;
    const header = target.dataset.columnHeader;
    const field  = target.dataset.suggestedField;
    if (!rule || !header || !field) return;
    if (!rule.attributes.some(a => a.columnHeader === header && a.foundryField === field)) {
      rule.attributes.push({ ...makeDefaultAttribute(), columnHeader: header, foundryField: field });
      this.#schedulePreview();
      this.render();
    }
  }

  static async #linkAllSuggestions(event, target) {
    const rule = this.selectedRule;
    if (!rule || !this._scanData) return;
    const attrPaths = this._cachedAttributePaths ?? [];
    if (!attrPaths.length) return;
    const suggestions = computeSuggestionsForRule(rule, this._scanData, attrPaths);
    let added = 0;
    for (const s of suggestions) {
      if (!rule.attributes.some(a => a.columnHeader === s.columnHeader && a.foundryField === s.suggestedField)) {
        rule.attributes.push({ ...makeDefaultAttribute(), columnHeader: s.columnHeader, foundryField: s.suggestedField });
        added++;
      }
    }
    if (added > 0) { this.#schedulePreview(); this.render(); }
  }

  async #showAttributeDialog(foundryField) {
    const rule = this.selectedRule;
    if (!rule) return;

    const existing = rule.attributes.find(a => a.foundryField === foundryField && a.columnHeader);
    const columns  = [...new Set(
      this._scanData?.tables?.flatMap(t => t.columns.map(c => c.header)).filter(h => h) ?? []
    )];

    const colOpts = columns.map(h =>
      `<option value="${h.replace(/"/g, '&quot;')}"${existing?.columnHeader === h ? ' selected' : ''}>${h}</option>`
    ).join('');
    const txOpts = [
      ['trim','Trim whitespace'], ['number','Number'], ['lowercase','Lowercase'],
      ['uppercase','Uppercase'],  ['boolean','Boolean (yes/true/1/x)']
    ].map(([v, l]) =>
      `<option value="${v}"${(existing?.transform ?? 'trim') === v ? ' selected' : ''}>${l}</option>`
    ).join('');

    const content = `
      <div style="display:flex;flex-direction:column;gap:10px;padding:4px 0">
        <div>
          <div style="font-size:0.75em;color:#9494a0;margin-bottom:2px">Foundry Field</div>
          <div style="font-family:monospace;font-size:0.9em;color:#7ab0d4">${foundryField}</div>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#9494a0;margin-bottom:3px">Column Header</label>
          <select id="dib-dlg-col" style="width:100%">
            <option value="">— Remove mapping —</option>
            ${colOpts}
          </select>
        </div>
        <div>
          <label style="display:block;font-size:0.8em;color:#9494a0;margin-bottom:3px">Transform</label>
          <select id="dib-dlg-tx" style="width:100%">${txOpts}</select>
        </div>
      </div>`;

    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Map: ${foundryField.split('.').pop()}` },
      content,
      ok: {
        label: 'Save',
        callback: (_e, _btn, dlg) => ({
          column:    dlg.element.querySelector('#dib-dlg-col').value,
          transform: dlg.element.querySelector('#dib-dlg-tx').value
        })
      },
      rejectClose: false
    });
    if (!result) return;

    rule.attributes = rule.attributes.filter(a => a.foundryField !== foundryField);
    if (result.column) {
      rule.attributes.push({
        ...makeDefaultAttribute(), foundryField,
        columnHeader: result.column, transform: result.transform
      });
    }
    this.#schedulePreview();
    this.render();
  }

  static async #buildItems() {
    if (!this._pdf) { ui.notifications.warn('Load a PDF first.'); return; }
    const hasPreviews = this._rules.some(r => (this._preview[r.id]?.length ?? 0) > 0);
    if (!hasPreviews) { ui.notifications.warn('No items detected. Check your rules and refresh.'); return; }

    let total = 0;
    for (const rule of this._rules) {
      const rawItems = this._preview[rule.id];
      if (!rawItems?.length || !rule.itemType) continue;

      // Apply ignored-item filter and cell overrides — same logic as _prepareContext
      const ignoredKeys = new Set((rule.ignoredItems ?? []).map(i => i._dibKey));
      const items = rawItems
        .map((item, idx) => {
          const dibKey = `_${idx}`;
          if (ignoredKeys.has(dibKey)) return null;
          const effective = { ...item };
          const ovr = this._cellOverrides[rule.id]?.[dibKey] ?? {};
          for (const [f, v] of Object.entries(ovr)) effective[f] = v;
          return effective;
        })
        .filter(Boolean);

      if (!items.length) continue;
      const folderId = rule.folderId || this._selectedFolderId;
      const folder   = folderId ? game.folders.get(folderId) ?? null : null;
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
        this._selectedRuleId  = imported[0]?.id ?? this._selectedRuleId;
        this._scanData        = null;
        this._textScanData    = {};
        this._textRegionFonts = {};
        // Snap planner page to the first valid page for the imported rule
        // (inlined from #snapPlannerPage to avoid TS error inside arrow callback)
        if (this._pdfPages) {
          const validPages = parsePageString(this.selectedRule?.pages ?? '', this._pdfPages);
          if (validPages.length && !validPages.includes(this._plannerPage)) {
            this._plannerPage = validPages[0];
          }
        }
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
