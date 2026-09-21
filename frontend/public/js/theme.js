'use strict';
/**
 * Nexus Bot Manager — Theme manager
 * Handles theme (light/dark/system), accent color and density.
 * Persists to localStorage. Can also push settings to the backend.
 */
(function () {
  const STORAGE_KEY = 'nexus.theme';

  const DEFAULTS = {
    theme:   'dark',  // 'dark' | 'light' | 'system'
    accent:  'blue',
    density: 'comfortable' // 'comfortable' | 'compact'
  };

  const ACCENTS = [
    { id: 'blue',    label: 'Bleu',       color: '#2563eb' },
    { id: 'indigo',  label: 'Indigo',     color: '#4f46e5' },
    { id: 'violet',  label: 'Violet',     color: '#7c3aed' },
    { id: 'purple',  label: 'Pourpre',    color: '#9333ea' },
    { id: 'pink',    label: 'Rose',       color: '#db2777' },
    { id: 'red',     label: 'Rouge',      color: '#dc2626' },
    { id: 'orange',  label: 'Orange',     color: '#ea580c' },
    { id: 'amber',   label: 'Ambre',      color: '#d97706' },
    { id: 'emerald', label: 'Émeraude',   color: '#059669' },
    { id: 'teal',    label: 'Sarcelle',   color: '#0d9488' },
    { id: 'cyan',    label: 'Cyan',       color: '#0891b2' },
    { id: 'slate',   label: 'Ardoise',    color: '#475569' },
    { id: 'discord', label: 'Discord',    color: '#5865f2' }
  ];

  const THEMES = [
    { id: 'dark',   label: 'Sombre',     icon: 'ti-moon' },
    { id: 'light',  label: 'Clair',      icon: 'ti-sun' },
    { id: 'system', label: 'Système',    icon: 'ti-device-desktop' }
  ];

  function load() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      return Object.assign({}, DEFAULTS, stored);
    } catch (_) {
      return { ...DEFAULTS };
    }
  }

  function save(s) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
  }

  function apply(s) {
    document.documentElement.setAttribute('data-theme',  s.theme   || DEFAULTS.theme);
    document.documentElement.setAttribute('data-accent', s.accent  || DEFAULTS.accent);
    if (s.density) document.documentElement.setAttribute('data-density', s.density);
  }

  // Public API
  window.NexusTheme = {
    DEFAULTS,
    ACCENTS,
    THEMES,

    get current() { return load(); },

    /** Apply a partial change and persist. */
    apply(patch, { persist = true } = {}) {
      const merged = { ...load(), ...patch };
      apply(merged);
      if (persist) save(merged);
      // Push to backend if available (best effort, fire-and-forget)
      try {
        if (window.NexusAPI?.system?.updateSettings) {
          window.NexusAPI.system.updateSettings({
            theme:    merged.theme,
            accent:   merged.accent,
            density:  merged.density
          }).catch(() => {});
        }
      } catch (_) {}
      return merged;
    },

    /** Reload from storage (call on boot to pick up backend-driven changes). */
    refresh() {
      const s = load();
      apply(s);
      return s;
    },

    /** Build the appearance settings HTML. Returns string. */
    renderSettings() {
      const s = load();
      const themeCards = THEMES.map(t => `
        <div class="theme-pick${s.theme === t.id ? ' active' : ''}" data-theme="${t.id}" role="button" tabindex="0">
          <div class="theme-pick-icon"><i class="ti ${t.icon}"></i></div>
          <div class="theme-pick-label">${t.label}</div>
        </div>`).join('');

      const accentSwatches = ACCENTS.map(a => `
        <button type="button" class="accent-swatch${s.accent === a.id ? ' active' : ''}" data-accent="${a.id}" style="--swatch:${a.color}" title="${a.label}" aria-label="${a.label}">
          <span class="accent-check"><i class="ti ti-check"></i></span>
        </button>`).join('');

      return `
        <!-- Theme -->
        <div class="card" style="margin-bottom:16px;">
          <div class="card-header"><span class="card-title"><i class="ti ti-palette"></i>Thème</span></div>
          <div class="card-body">
            <p style="font-size:12px;color:var(--tx-3);margin-bottom:14px;">Choisissez l'apparence de l'interface. L'option « Système » suit les préférences de votre OS.</p>
            <div class="theme-picker">${themeCards}</div>
          </div>
        </div>

        <!-- Accent -->
        <div class="card" style="margin-bottom:16px;">
          <div class="card-header"><span class="card-title"><i class="ti ti-droplet"></i>Couleur d'accent</span></div>
          <div class="card-body">
            <p style="font-size:12px;color:var(--tx-3);margin-bottom:14px;">La couleur d'accent est utilisée pour les boutons primaires, liens et indicateurs actifs.</p>
            <div class="accent-swatches">${accentSwatches}</div>
          </div>
        </div>

        <!-- Density -->
        <div class="card">
          <div class="card-header"><span class="card-title"><i class="ti ti-layout-density"></i>Densité</span></div>
          <div class="card-body">
            <div style="display:flex;gap:8px;">
              <button type="button" class="btn btn-ghost density-btn${(s.density||'comfortable')==='comfortable'?' active':''}" data-density="comfortable" style="flex:1;"><i class="ti ti-layout-distribute-vertical"></i>Confortable</button>
              <button type="button" class="btn btn-ghost density-btn${s.density==='compact'?' active':''}" data-density="compact" style="flex:1;"><i class="ti ti-layout-distribute-horizontal"></i>Compact</button>
            </div>
          </div>
        </div>`;
    },

    /** Attach event listeners after the settings panel is rendered. */
    bindEvents() {
      document.querySelectorAll('.theme-pick').forEach(el => {
        const handler = () => {
          this.apply({ theme: el.dataset.theme });
          // Move the visual indicator onto the actual selected theme.
          document.querySelectorAll('.theme-pick').forEach(p =>
            p.classList.toggle('active', p.dataset.theme === el.dataset.theme)
          );
        };
        el.addEventListener('click', handler);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
      });
      document.querySelectorAll('.accent-swatch').forEach(el => {
        el.addEventListener('click', () => {
          this.apply({ accent: el.dataset.accent });
          // Move the check icon onto the actual selected accent.
          document.querySelectorAll('.accent-swatch').forEach(s =>
            s.classList.toggle('active', s.dataset.accent === el.dataset.accent)
          );
        });
      });
      document.querySelectorAll('.density-btn').forEach(el => {
        el.addEventListener('click', () => {
          this.apply({ density: el.dataset.density });
          document.querySelectorAll('.density-btn').forEach(b => b.classList.toggle('active', b.dataset.density === el.dataset.density));
        });
      });
    }
  };

  // Apply once on boot
  document.addEventListener('DOMContentLoaded', () => {
    apply(load());
    // Listen for OS theme changes when in system mode
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (load().theme === 'system') apply(load());
    });
  });
})();