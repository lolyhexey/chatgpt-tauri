// Full-screen image viewer, like chatgpt.com's: opens when an <AsyncImage/> in a reply is
// clicked. Top bar: label, zoom (fit <-> 100%), download, close. Bottom: source link.
class ImageViewer {
  constructor() {
    this.el = null;
    this.data = null;
    this.actualSize = false;
  }

  _build() {
    const el = document.createElement('div');
    el.className = 'viewer';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Image viewer');
    el.innerHTML =
      '<div class="viewer-bar">' +
      '<span class="viewer-pill">' + icon('image', 16) + '<span>Image</span></span>' +
      '<span class="viewer-actions">' +
      '<button type="button" class="viewer-pill viewer-zoom" data-viewer="zoom" title="Toggle actual size"></button>' +
      '<button type="button" class="viewer-btn" data-viewer="download" title="Download image">' + icon('download', 18) + '</button>' +
      '<button type="button" class="viewer-btn" data-viewer="close" title="Close viewer">' + icon('x', 18) + '</button>' +
      '</span></div>' +
      '<div class="viewer-stage" data-viewer="backdrop"><img class="viewer-img" alt=""></div>' +
      '<div class="viewer-foot"><a class="viewer-source" href="#"></a></div>' +
      '<div class="viewer-toast" hidden></div>';
    document.body.appendChild(el);
    this.el = el;
    this.stage = el.querySelector('.viewer-stage');
    this.img = el.querySelector('.viewer-img');
    this.zoomBtn = el.querySelector('.viewer-zoom');
    this.source = el.querySelector('.viewer-source');
    this.toast = el.querySelector('.viewer-toast');

    el.addEventListener('click', (e) => {
      const action = e.target.closest('[data-viewer]');
      const name = action && action.getAttribute('data-viewer');
      if (e.target === this.img) this.toggleZoom();
      else if (name === 'zoom') this.toggleZoom();
      else if (name === 'download') this.download();
      else if (name === 'close' || name === 'backdrop') this.close();
    });
    this.source.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = this.data && this.data.sourceUrl;
      if (url && window.__TAURI__) window.__TAURI__.core.invoke('open_url', { url }).catch((err) => console.warn(err));
    });
    this.img.addEventListener('load', () => this._updateZoom());
    window.addEventListener('resize', () => this._updateZoom());
    document.addEventListener('keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
  }

  open(data) {
    if (!this.el) this._build();
    this.data = data;
    this.actualSize = false;
    this.el.classList.remove('actual');
    this.toast.hidden = true;
    this.img.src = data.url;
    this.img.alt = data.title || '';
    const label = [data.sourceHost, data.title].filter(Boolean).join(' · ');
    this.source.textContent = label;
    if (data.sourceUrl) this.source.insertAdjacentHTML('beforeend', icon('arrow-up-right', 14));
    this.source.hidden = !label;
    this.el.hidden = false;
    this._updateZoom();
    this.el.querySelector('[data-viewer="close"]').focus();
  }

  close() {
    if (!this.el || this.el.hidden) return;
    this.el.hidden = true;
    this.img.removeAttribute('src');
    this.data = null;
  }

  toggleZoom() {
    this.actualSize = !this.actualSize;
    this.el.classList.toggle('actual', this.actualSize);
    this._updateZoom();
  }

  // Shown scale relative to the image's real pixels, like chatgpt.com's "76%".
  _updateZoom() {
    if (!this.el || this.el.hidden) return;
    const natural = this.img.naturalWidth;
    const pct = this.actualSize || !natural ? 100 : Math.round((this.img.clientWidth / natural) * 100);
    this.zoomBtn.textContent = pct + '%';
  }

  async download() {
    if (!this.data || !window.__TAURI__) return;
    const invoke = window.__TAURI__.core.invoke;
    try {
      const path = await invoke('download_image', { url: this.data.url, name: this.data.title || 'image' });
      this._toast('Saved to Downloads', () => invoke('open_file_path', { path }));
    } catch (err) {
      this._toast(String(err));
    }
  }

  _toast(text, onClick) {
    this.toast.textContent = text;
    this.toast.classList.toggle('clickable', !!onClick);
    this.toast.title = onClick ? 'Show in folder' : '';
    this.toast.onclick = onClick ? () => { onClick().catch((e) => console.warn(e)); } : null;
    this.toast.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this.toast.hidden = true; }, 4000);
  }
}

const imageViewer = new ImageViewer();

document.addEventListener('click', (e) => {
  const frame = e.target.closest && e.target.closest('.gen-img');
  if (!frame || e.target.closest('.gen-img-src')) return;
  const img = frame.querySelector('img');
  if (!img) return;
  e.preventDefault();
  imageViewer.open({
    url: img.getAttribute('data-full') || img.src,
    title: img.getAttribute('data-title') || img.alt,
    sourceUrl: img.getAttribute('data-source-url') || '',
    sourceHost: img.getAttribute('data-source-host') || '',
  });
});
