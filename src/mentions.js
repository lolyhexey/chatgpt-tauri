// "@" menu for the composer, like chatgpt.com: tools (Web search, Create image, ...) and
// connected apps (Hexey, GitHub, ...) from /backend-api/system_hints. A pick becomes a chip in
// the composer; on send it becomes the same text + system_hints chatgpt.com sends:
//   apps:  "[$hexey](app://asdk_app_…) " with hint "plugin:asdk_app_…"
//   tools: "@Web search "               with hint "search"

// id -> entry, shared with message rendering (app mention pills in user bubbles).
const mentionIndex = new Map();

function mentionSlug(label) {
  return label.toLowerCase().trim().replace(/\s+/g, '-');
}

function mentionLogo(entry, size) {
  if (!entry || !/^(https:|data:image\/svg\+xml;base64,)/.test(entry.logo || '')) return '';
  return '<img class="mention-logo" src="' + escAttr(entry.logo) + '" alt="" width="' + size + '" height="' + size +
    '" referrerpolicy="no-referrer" draggable="false">';
}

class Mentions {
  constructor(input, chipsEl, menuEl, onChange) {
    this.input = input;
    this.chipsEl = chipsEl;
    this.menuEl = menuEl;
    this.onChange = onChange;
    this.items = [];
    this.picked = [];
    this.shown = [];
    this.active = 0;
    this.query = null;

    menuEl.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
    menuEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-index]');
      if (row) this.pick(this.shown[Number(row.getAttribute('data-index'))]);
    });
    menuEl.addEventListener('mousemove', (e) => {
      const row = e.target.closest('[data-index]');
      if (row) this._setActive(Number(row.getAttribute('data-index')), false);
    });
    chipsEl.addEventListener('click', (e) => {
      const x = e.target.closest('[data-remove]');
      if (!x) return;
      this.picked = this.picked.filter((p) => p.id !== x.getAttribute('data-remove'));
      this._renderChips();
      this.input.focus();
    });
    document.addEventListener('click', (e) => {
      if (!this.menuEl.hidden && !e.target.closest('.composer')) this.close();
    });
  }

  async load() {
    try {
      this.items = await window.__TAURI__.core.invoke('system_hints_cmd');
    } catch (e) {
      console.warn('Loading @ menu failed', e);
      return;
    }
    mentionIndex.clear();
    this.items.forEach((i) => mentionIndex.set(i.id, i));
    refreshMentionPills(document);
    if (this.query) this._update();
  }

  count() { return this.picked.length; }

  // The "@query" right before the caret, if any (spaces allowed, like "@google dr").
  _currentQuery() {
    const pos = this.input.selectionStart;
    if (pos !== this.input.selectionEnd) return null;
    const m = /(^|\s)@([^@\n]{0,30})$/.exec(this.input.value.slice(0, pos));
    return m ? { start: pos - m[2].length - 1, end: pos, text: m[2] } : null;
  }

  onInput() {
    this.query = this._currentQuery();
    this._update();
  }

  _matches(text) {
    const t = text.trim().toLowerCase();
    const available = this.items.filter((i) => !this.picked.some((p) => p.id === i.id));
    if (!t) return available.filter((i) => i.initial);
    const scored = [];
    available.forEach((i) => {
      const names = [i.label, i.name].concat(i.aliases || []).map((s) => (s || '').toLowerCase());
      if (names.some((n) => n.startsWith(t))) scored.push([0, i]);
      else if (names.some((n) => n.includes(t))) scored.push([1, i]);
    });
    return scored.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }

  _update() {
    if (!this.query || !this.items.length) { this.close(); return; }
    this.shown = this._matches(this.query.text);
    if (!this.shown.length) { this.close(); return; }
    this.active = 0;
    this.menuEl.innerHTML = this.shown.map((i, n) =>
      '<div class="mention-item" role="option" data-index="' + n + '">' +
      '<span class="mention-item-logo">' + (mentionLogo(i, 18) || icon(i.is_plugin ? 'package' : 'wrench', 16)) + '</span>' +
      '<span class="mention-item-name">' + escText(i.label) + '</span>' +
      (i.description && i.description !== i.label ? '<span class="mention-item-desc">' + escText(i.description) + '</span>' : '') +
      '</div>').join('');
    this.menuEl.hidden = false;
    this._setActive(0, true);
  }

  _setActive(n, scroll) {
    const rows = this.menuEl.querySelectorAll('.mention-item');
    if (!rows.length) return;
    this.active = (n + rows.length) % rows.length;
    rows.forEach((r, k) => r.classList.toggle('active', k === this.active));
    if (scroll) rows[this.active].scrollIntoView({ block: 'nearest' });
  }

  close() {
    this.menuEl.hidden = true;
    this.shown = [];
  }

  // Returns true when the key was used by the menu or the chips.
  onKeyDown(e) {
    if (!this.menuEl.hidden) {
      if (e.key === 'ArrowDown') { this._setActive(this.active + 1, true); e.preventDefault(); return true; }
      if (e.key === 'ArrowUp') { this._setActive(this.active - 1, true); e.preventDefault(); return true; }
      if ((e.key === 'Enter' && !e.shiftKey && !e.isComposing) || e.key === 'Tab') {
        e.preventDefault();
        this.pick(this.shown[this.active]);
        return true;
      }
      if (e.key === 'Escape') { this.close(); e.preventDefault(); return true; }
    }
    if (e.key === 'Backspace' && this.picked.length && this.input.selectionStart === 0 && this.input.selectionEnd === 0) {
      e.preventDefault();
      this.picked.pop();
      this._renderChips();
      return true;
    }
    return false;
  }

  pick(item) {
    if (!item) return;
    const q = this._currentQuery();
    if (q) {
      const v = this.input.value;
      this.input.value = v.slice(0, q.start) + v.slice(q.end).replace(/^ /, '');
      this.input.setSelectionRange(q.start, q.start);
    }
    if (!this.picked.some((p) => p.id === item.id)) this.picked.push(item);
    this.query = null;
    this.close();
    this._renderChips();
    this.input.focus();
  }

  _renderChips() {
    this.chipsEl.innerHTML = this.picked.map((p) =>
      '<span class="mention-chip">' + mentionLogo(p, 16) + '<span>' + escText(p.label) + '</span>' +
      '<button type="button" class="mention-chip-x" data-remove="' + escAttr(p.id) + '" title="Remove">' + icon('x', 12) + '</button></span>'
    ).join('');
    this.chipsEl.hidden = !this.picked.length;
    this.onChange();
  }

  // Text prefix and system_hints for the picked entries; clears the chips.
  take() {
    const prefix = this.picked.map((p) => p.is_plugin
      ? '[$' + mentionSlug(p.label) + '](app://' + p.id.replace(/^plugin:/, '') + ')'
      : '@' + p.label).join(' ');
    const hints = this.picked.map((p) => p.id);
    this.picked = [];
    this._renderChips();
    return { prefix, hints };
  }
}

// ---------- App mentions inside sent messages ----------

var APP_MENTION = /\[\$([^\]\n]{1,60})\]\(app:\/\/([\w.-]{1,120})\)/g;

// Set a user bubble's text, turning "[$hexey](app://id)" into a pill like chatgpt.com.
function renderUserText(el, text) {
  el.textContent = '';
  let last = 0;
  text.replace(APP_MENTION, (full, slug, id, at) => {
    if (at > last) el.appendChild(document.createTextNode(text.slice(last, at)));
    const pill = document.createElement('span');
    pill.className = 'mention-pill';
    pill.setAttribute('data-app-id', id);
    pill.setAttribute('data-slug', slug);
    el.appendChild(pill);
    fillMentionPill(pill);
    last = at + full.length;
    return full;
  });
  if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
}

function fillMentionPill(pill) {
  const entry = mentionIndex.get('plugin:' + pill.getAttribute('data-app-id'));
  const name = entry ? entry.label : pill.getAttribute('data-slug').replace(/-/g, ' ');
  pill.innerHTML = mentionLogo(entry, 16) + '<span>' + escText(name) + '</span>';
}

// The menu list can arrive after messages render; add names and icons then.
function refreshMentionPills(root) {
  root.querySelectorAll('.mention-pill[data-app-id]').forEach(fillMentionPill);
}
