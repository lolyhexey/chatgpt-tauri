const { invoke } = window.__TAURI__.core;

export class Sidebar {
  constructor(container, { onSelect, onNew, onDelete }) {
    this.container = container;
    this.onSelect = onSelect;
    this.onNew = onNew;
    this.onDelete = onDelete;
    this.activeId = null;
    this.items = [];
  }

  async refresh() {
    try {
      const data = await invoke('list_conversations_cmd', { offset: 0, limit: 50 });
      this.items = data.items;
      this.render();
    } catch (e) {
      console.error('Failed to load conversations:', e);
      this.container.innerHTML = `<div class="chat-item" style="color:var(--text-dim)">Failed to load</div>`;
    }
  }

  render() {
    this.container.innerHTML = '';
    for (const item of this.items) {
      const el = document.createElement('div');
      el.className = 'chat-item' + (item.id === this.activeId ? ' active' : '');

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = item.title;
      el.appendChild(title);

      const del = document.createElement('button');
      del.className = 'delete-btn';
      del.textContent = '×';
      del.onclick = (e) => {
        e.stopPropagation();
        this.onDelete(item.id, item.title);
      };
      el.appendChild(del);

      el.onclick = () => this.onSelect(item.id);
      this.container.appendChild(el);
    }

    if (this.items.length === 0) {
      this.container.innerHTML = `<div class="chat-item" style="color:var(--text-dim)">No conversations</div>`;
    }
  }

  setActive(id) {
    this.activeId = id;
    this.render();
  }
}
