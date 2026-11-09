class Sidebar {
  constructor(container, { onSelect, onDelete, onMoveToProject, onChatMenu, onPin }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onDelete = onDelete;
    this.onMoveToProject = onMoveToProject;
    this.onChatMenu = onChatMenu;
    this.onPin = onPin;
    this.activeId = null;
    this.items = [];
    this.filter = '';
    this.error = null;
    this.busy = new Set();
  }

  pinnedOf(id) {
    const item = this.items.find((i) => i.id === id);
    return !!(item && item.pinned);
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
    const base = this.filter
      ? this.items.filter((i) => (i.title || '').toLowerCase().includes(this.filter))
      : this.items;
    // Pinned chats sort to the top (newest-pinned first), like chatgpt.com; the
    // server already returns the rest newest-first, so keep that order within each group.
    const items = base
      .map((it, idx) => ({ it, idx }))
      .sort((a, b) => {
        const ap = a.it.pinned ? 1 : 0, bp = b.it.pinned ? 1 : 0;
        if (ap !== bp) return bp - ap;
        if (ap) {
          // Both pinned: newest-pinned first. A missing pinned_time sorts as "" (oldest),
          // so the comparison always applies and the order stays transitive.
          const at = a.it.pinned_time || '', bt = b.it.pinned_time || '';
          if (at !== bt) return at < bt ? 1 : -1;
        }
        return a.idx - b.idx;
      })
      .map((x) => x.it);
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
      if (item.pinned) {
        const pin = document.createElement('span');
        pin.className = 'sb-chat-pinned';
        pin.title = 'Pinned';
        pin.innerHTML = icon('pin', 14);
        row.appendChild(pin);
      }
      if (this.busy.has(item.id)) {
        const spin = document.createElement('span');
        spin.className = 'sb-chat-busy';
        spin.title = 'Working…';
        row.appendChild(spin);
      }

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'sb-chat-pin';
      pinBtn.title = item.pinned ? 'Unpin' : 'Pin';
      pinBtn.innerHTML = icon('pin', 16);
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this.onPin) this.onPin(item.id, !item.pinned);
      });
      row.appendChild(pinBtn);

      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'sb-chat-more';
      more.title = 'Chat options';
      more.innerHTML = icon('ellipsis', 18);
      more.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onChatMenu(item.id, item.title, more);
      });
      row.appendChild(more);

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
