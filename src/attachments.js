// Files waiting in the composer. Each upload starts as soon as the file is added,
// like chatgpt.com; sending waits until every file is ready.

var MAX_ATTACHMENTS = 10;
var IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

function fileExt(name) {
  var m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
  return m ? m[1].toUpperCase() : 'FILE';
}

function readAsBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
    reader.onerror = function () { reject(reader.error || new Error('Could not read file')); };
    reader.readAsDataURL(file);
  });
}

class Attachments {
  constructor(tray, onChange) {
    this.tray = tray;
    this.onChange = onChange;
    this.items = [];
    this.seq = 0;
    this.tray.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove]');
      if (btn) this.remove(Number(btn.getAttribute('data-remove')));
    });
  }

  addPath(path) {
    const name = path.split(/[\\/]/).pop();
    this._start(name, null, () => window.__TAURI__.core.invoke('upload_path', { path }));
  }

  addFile(file) {
    const name = file.name || (file.type === 'image/png' ? 'image.png' : 'file');
    const preview = file.type && file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
    this._start(name, preview, async () => {
      const dataBase64 = await readAsBase64(file);
      return window.__TAURI__.core.invoke('upload_bytes', { name, dataBase64 });
    });
  }

  _start(name, preview, run) {
    if (this.items.length >= MAX_ATTACHMENTS) {
      this.onChange(`You can attach up to ${MAX_ATTACHMENTS} files at a time.`);
      return;
    }
    const item = { key: ++this.seq, name, preview, status: 'uploading', file: null, error: null };
    this.items.push(item);
    this.render();
    this.onChange();
    run().then((res) => {
      item.status = 'ready';
      item.file = res.file;
      if (!item.preview && res.preview) item.preview = res.preview;
    }, (err) => {
      item.status = 'error';
      item.error = String(err);
    }).finally(() => {
      if (!this.items.includes(item)) return;
      this.render();
      this.onChange();
    });
  }

  remove(key) {
    const item = this.items.find((i) => i.key === key);
    if (item && item.preview && item.preview.startsWith('blob:')) URL.revokeObjectURL(item.preview);
    this.items = this.items.filter((i) => i.key !== key);
    this.render();
    this.onChange();
  }

  busy() { return this.items.some((i) => i.status === 'uploading'); }
  hasErrors() { return this.items.some((i) => i.status === 'error'); }
  count() { return this.items.length; }

  // Files to send plus what the chat should display for them.
  take() {
    const ready = this.items.filter((i) => i.status === 'ready');
    const result = {
      files: ready.map((i) => i.file),
      display: ready.map((i) => ({ name: i.name, mime_type: i.file.mime_type, preview: i.preview })),
    };
    this.items = [];
    this.render();
    this.onChange();
    return result;
  }

  render() {
    this.tray.hidden = this.items.length === 0;
    this.tray.innerHTML = '';
    for (const item of this.items) {
      const isImage = !!item.preview || IMAGE_EXT.test(item.name);
      const el = document.createElement('div');
      el.className = 'att' + (isImage ? ' att-image' : ' att-file') + (item.status === 'error' ? ' att-error' : '');
      el.title = item.status === 'error' ? item.error : item.name;

      if (isImage && item.preview) {
        const img = document.createElement('img');
        img.src = item.preview;
        img.alt = item.name;
        el.appendChild(img);
      } else {
        const iconBox = document.createElement('div');
        iconBox.className = 'att-icon';
        iconBox.innerHTML = icon(isImage ? 'image' : 'file', 20);
        const meta = document.createElement('div');
        meta.className = 'att-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'att-name';
        nameEl.textContent = item.name;
        const typeEl = document.createElement('div');
        typeEl.className = 'att-type';
        typeEl.textContent = item.status === 'error' ? 'Upload failed' : fileExt(item.name);
        meta.appendChild(nameEl);
        meta.appendChild(typeEl);
        el.appendChild(iconBox);
        el.appendChild(meta);
      }

      if (item.status === 'uploading') {
        const spin = document.createElement('div');
        spin.className = 'att-spinner';
        spin.innerHTML = icon('loader', 20);
        el.appendChild(spin);
      }

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'att-remove';
      rm.title = 'Remove';
      rm.setAttribute('data-remove', String(item.key));
      rm.innerHTML = icon('x', 12);
      el.appendChild(rm);

      this.tray.appendChild(el);
    }
  }
}
