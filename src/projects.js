// The sidebar's "Projects" section, like chatgpt.com: lists projects (gizmo "snorlax"), shows
// "No projects" when empty, and opens one on click. A pure renderer — app.js wires the controls.
class Projects {
  constructor(container, { onSelect }) {
    this.container = container;
    this.onSelect = onSelect;
    this.items = [];
    this.activeId = null;
    this.error = null;
    this.collapsed = false;
  }

  async refresh() {
    try {
      const data = await window.__TAURI__.core.invoke('list_projects_cmd');
      this.items = data.items || [];
      this.error = null;
    } catch (e) {
      console.error('Failed to load projects:', e);
      this.error = String(e);
    }
    this.render();
  }

  nameOf(id) {
    const item = this.items.find((i) => i.id === id);
    return item ? item.name : null;
  }

  setActive(id) {
    this.activeId = id;
    this.render();
  }

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.render();
  }

  render() {
    this.container.innerHTML = '';
    if (this.collapsed) return;
    if (this.error) {
      this._note('Could not load projects');
      return;
    }
    if (this.items.length === 0) {
      this._note('No projects');
      return;
    }
    for (const p of this.items) {
      const row = document.createElement('div');
      row.className = 'sb-project' + (p.id === this.activeId ? ' active' : '');
      row.title = p.name || 'Untitled';

      const ic = document.createElement('span');
      ic.className = 'sb-project-icon';
      ic.innerHTML = icon('folder', 16);
      row.appendChild(ic);

      const title = document.createElement('span');
      title.className = 'sb-project-title';
      title.textContent = p.name || 'Untitled';
      row.appendChild(title);

      row.addEventListener('click', () => this.onSelect(p.id, p.name));
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
