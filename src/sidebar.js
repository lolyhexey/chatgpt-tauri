class Sidebar {
  constructor(container, { onSelect, onDelete }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onDelete = onDelete;
    this.activeId = null;
    this.items = [];
    this.filter = '';
    this.error = null;
    this.busy = new Set();
  }

  // Chats with a reply still running (shown with a spinner, like chatgpt.com).
  setBusy(id, on) {
    if (!id) return;
    if (on) this.busy.add(id); else this.busy.delete(id);
    this.render();
  }

  // update_time as listed, so callers can tell whether a cached copy is still current.
  updatedOf(id) {
    const item = this.items.find((i) => i.id === id);
    return item ? item.updated : null;
  }

  async refresh() {
    try {
      const data = await window.__TAURI__.core.invoke('list_conversations_cmd', { offset: 0, limit: 50 });
      this.items = data.items || [];
      this.error = null;
    } catch (e) {
      console.error('Failed to load conversations:', e);
      this.error = String(e);
    }
    this.render();
  }

  titleOf(id) {
    const item = this.items.find((i) => i.id === id);
    return item ? item.title : null;
  }

  setFilter(q) {
    this.filter = q.trim().toLowerCase();
    this.render();
  }

  setActive(id) {
    this.activeId = id;
    this.render();
  }

  render() {
    this.container.innerHTML = '';
    if (this.error) {
      this._note('Could not load chats');
      return;
    }
    const items = this.filter
      ? this.items.filter((i) => (i.title || '').toLowerCase().includes(this.filter))
      : this.items;
    if (items.length === 0) {
      this._note(this.filter ? 'No matching chats' : 'No chats yet');
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'sb-chat' + (item.id === this.activeId ? ' active' : '');
      row.title = item.title || 'Untitled';

      const title = document.createElement('span');
      title.className = 'sb-chat-title';
      title.textContent = item.title || 'Untitled';
      row.appendChild(title);
      if (this.busy.has(item.id)) {
        const spin = document.createElement('span');
        spin.className = 'sb-chat-busy';
        spin.title = 'Working…';
        row.appendChild(spin);
      }

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sb-chat-del';
      del.title = 'Delete chat';
      del.innerHTML = icon('trash', 16);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onDelete(item.id, item.title);
      });
      row.appendChild(del);

      row.addEventListener('click', () => this.onSelect(item.id));
      this.container.appendChild(row);
    }
  }

  _note(text) {
    const el = document.createElement('div');
    el.className = 'sb-note';
    el.textContent = text;
    this.container.appendChild(el);
  }
}
