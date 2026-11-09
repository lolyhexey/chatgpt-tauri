// Thinking-effort / model picker in the composer, like chatgpt.com's: a 3-step slider and a
// model list. What each step sends was checked on chatgpt.com (GPT-6):
//   Instant -> model "gpt-6"                                   (no thinking_effort)
//   Medium  -> model "gpt-6-thinking", thinking_effort "standard"
//   High    -> model "gpt-6-thinking", thinking_effort "extended"
const EFFORT_LEVELS = [
  { label: 'Instant', effort: null },
  { label: 'Medium', effort: 'standard' },
  { label: 'High', effort: 'extended' },
];

function storedPick(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : v; } catch (e) { return fallback; }
}
function storePick(key, value) {
  try { localStorage.setItem(key, value); } catch (e) { /* settings just won't persist */ }
}

class ModelPicker {
  constructor(button, label, panel) {
    this.button = button;
    this.labelEl = label;
    this.panel = panel;
    this.families = [];
    const lvl = parseInt(storedPick('picker.level', '2'), 10);
    this.level = lvl >= 0 && lvl <= 2 ? lvl : 2;
    this.family = storedPick('picker.family', '');
    this.showModels = false;
    // Which effort steps are offered (indices into EFFORT_LEVELS), set in Settings.
    this.enabled = this._loadEnabled();
    this._clampToEnabled();

    button.addEventListener('click', (e) => { e.stopPropagation(); this.toggle(); });
    panel.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.getAttribute('data-act') === 'models') { this.showModels = !this.showModels; this._render(); }
      if (act.getAttribute('data-act') === 'family') { this.setFamily(act.getAttribute('data-slug')); }
    });
    panel.addEventListener('input', (e) => {
      if (e.target.matches('.effort-range')) this.setLevel(parseInt(e.target.value, 10));
    });
    document.addEventListener('click', () => this.close());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.close(); });
    this._updateButton();
  }

  async load() {
    try {
      const list = await window.__TAURI__.core.invoke('models_cmd');
      this.families = list.families || [];
      if (!this.families.some((f) => f.slug === this.family)) {
        this.family = (this.families[0] && this.families[0].slug) || list.default_slug || '';
      }
    } catch (e) {
      console.warn('Loading models failed', e);
    }
    this._render();
  }

  _current() { return this.families.find((f) => f.slug === this.family); }

  // What send_message / start_goal should use; empty until the model list has loaded.
  request() {
    const fam = this._current();
    if (!fam) return {};
    const lvl = EFFORT_LEVELS[this.level];
    if (!lvl.effort || !fam.efforts.includes(lvl.effort)) return { model: fam.slug, thinkingEffort: null };
    return { model: fam.thinking_slug, thinkingEffort: lvl.effort };
  }

  // n is a slider position (0..enabled.length-1); map it to an absolute effort index.
  setLevel(n) {
    const pos = Math.max(0, Math.min(this.enabled.length - 1, n));
    this.level = this.enabled[pos];
    storePick('picker.level', String(this.level));
    this._updateButton();
    const head = this.panel.querySelector('.model-level-name');
    if (head) head.textContent = EFFORT_LEVELS[this.level].label;
  }

  _loadEnabled() {
    const raw = storedPick('picker.efforts', '0,1,2');
    const arr = [...new Set(raw.split(',').map((n) => parseInt(n, 10)))]
      .filter((i) => i >= 0 && i < EFFORT_LEVELS.length)
      .sort((a, b) => a - b);
    return arr.length ? arr : [0, 1, 2];
  }
  _clampToEnabled() {
    if (this.enabled.includes(this.level)) return;
    // Snap to the nearest enabled step so the button/slider stay valid.
    this.level = this.enabled.reduce(
      (best, i) => (Math.abs(i - this.level) < Math.abs(best - this.level) ? i : best),
      this.enabled[0]);
    storePick('picker.level', String(this.level));
  }
  // All effort labels (for the Settings "Available reasoning efforts" control).
  allEffortLabels() { return EFFORT_LEVELS.map((l) => l.label); }
  getEfforts() { return this.enabled.slice(); }
  setEfforts(indices) {
    const arr = [...new Set(indices)].filter((i) => i >= 0 && i < EFFORT_LEVELS.length).sort((a, b) => a - b);
    this.enabled = arr.length ? arr : [0, 1, 2];
    storePick('picker.efforts', this.enabled.join(','));
    this._clampToEnabled();
    this._updateButton();
    this._render();
  }

  setFamily(slug) {
    this.family = slug;
    storePick('picker.family', slug);
    this._render();
  }

  toggle() { if (this.panel.hidden) this.open(); else this.close(); }
  open() { this._render(); this.panel.hidden = false; this.button.classList.add('open'); }
  close() { this.panel.hidden = true; this.button.classList.remove('open'); }

  _updateButton() { this.labelEl.textContent = EFFORT_LEVELS[this.level].label; }

  _render() {
    this._updateButton();
    const models = this.families.map((f) =>
      '<button type="button" class="model-row' + (f.slug === this.family ? ' selected' : '') + '" data-act="family" data-slug="' + escAttr(f.slug) + '">' +
      '<span>' + escText(f.title) + '</span>' + (f.slug === this.family ? icon('check', 16) : '') + '</button>').join('');
    const pos = Math.max(0, this.enabled.indexOf(this.level));
    const ticks = this.enabled.map((i) => '<span>' + escText(EFFORT_LEVELS[i].label) + '</span>').join('');
    const slider = this.enabled.length > 1
      ? '<input type="range" class="effort-range" min="0" max="' + (this.enabled.length - 1) + '" step="1" value="' + pos + '" aria-label="Thinking effort">' +
        '<div class="effort-ticks">' + ticks + '</div>'
      : '';
    this.panel.innerHTML =
      '<button type="button" class="model-level" data-act="models" title="Choose model">' +
      '<span class="model-level-name">' + EFFORT_LEVELS[this.level].label + '</span>' + icon(this.showModels ? 'chevron-down' : 'chevron-right', 14) + '</button>' +
      slider +
      (this.showModels ? '<div class="model-list">' + (models || '<div class="model-empty">Models unavailable</div>') + '</div>' : '');
  }
}
