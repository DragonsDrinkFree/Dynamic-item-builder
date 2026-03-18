import { DynamicItemBuilderApp } from './app/DynamicItemBuilderApp.js';

Hooks.once('init', () => {
  console.log('Dynamic Item Builder | Initializing');

  // Handlebars helpers
  Handlebars.registerHelper('proseText', (row) => {
    if (!row?.items) return '';
    return row.items.map(i => i.text).join(' ');
  });

  // Resolve a dot-notation field path on a flat object (e.g. "system.damage" on {system.damage: "1d8"})
  Handlebars.registerHelper('getField', (obj, field) => obj?.[field] ?? '');

  game.settings.register('dynamic-item-builder', 'savedRuleSets', {
    name: 'Saved Rule Sets',
    scope: 'world',
    config: false,
    type: Object,
    default: {}
  });
});

Hooks.once('ready', () => {
  game.dynamicItemBuilder = {
    _app: null,
    open() {
      if (!this._app || this._app.rendered === false) {
        this._app = new DynamicItemBuilderApp();
      }
      this._app.render({ force: true });
    }
  };
});

// Add an "Import from PDF" button to the Items sidebar, after Create Item + Create Folder
Hooks.on('renderItemDirectory', (app, html) => {
  // In v13 the second arg is the root HTMLElement; guard for both cases
  const el = html instanceof HTMLElement ? html : html[0];
  if (!el) return;

  if (el.querySelector('.dib-open-btn')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.classList.add('dib-open-btn');
  button.innerHTML = '<i class="fas fa-file-import"></i> Import from PDF';
  button.addEventListener('click', () => game.dynamicItemBuilder.open());

  // Insert as a new full-width row AFTER the Create Item / Create Folder row
  const actions = el.querySelector('.action-buttons, .header-actions');
  if (actions) {
    const row = document.createElement('div');
    row.classList.add('dib-sidebar-row');
    row.appendChild(button);
    actions.insertAdjacentElement('afterend', row);
  }
});
