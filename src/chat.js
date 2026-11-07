class Chat {
  constructor(thread, scroller, main) {
    this.thread = thread;
    this.scroller = scroller;
    this.main = main;
    this.pending = null;
  }

  clear() {
    this.thread.innerHTML = '';
    this.pending = null;
    this._updateEmpty();
  }

  loadConversation(messages) {
    this.thread.innerHTML = '';
    this.pending = null;
    for (const msg of messages) {
      if (msg.role === 'user') this._userTurn(msg.content, msg.attachments || []);
      else this._fillAssistant(this._newAssistantTurn(), msg.content, []);
    }
    this._updateEmpty();
    this._scrollToBottom();
  }

  addUserMessage(text, files) {
    this._userTurn(text, files || []);
    this._updateEmpty();
    this._scrollToBottom();
  }

  startPending() {
    this._stopStream();
    this.pending = this._newAssistantTurn();
    this.pending.innerHTML = '<div class="typing" aria-label="Thinking"></div>';
    this._scrollToBottom();
  }

  // The server sends text in bursts every ~100-150ms; reveal each burst gradually
  // (like chatgpt.com) instead of jumping a whole paragraph at once.
  streamDelta(kind, delta) {
    if (!this.pending) return;
    if (kind !== 'text') {
      if (!this.stream && !this.pending.querySelector('.thinking-label')) {
        this.pending.innerHTML = '<div class="thinking-label">Thinking</div>';
      }
      return;
    }
    if (!this.stream) {
      this.pending.innerHTML = '';
      const body = document.createElement('div');
      body.className = 'msg-assistant streaming';
      this.pending.appendChild(body);
      this.stream = { body, target: '', shown: 0, frame: 0 };
    }
    this.stream.target += delta;
    if (!this.stream.frame) this.stream.frame = requestAnimationFrame(() => this._revealStep());
  }

  _revealStep() {
    const s = this.stream;
    if (!s) return;
    s.frame = 0;
    const remaining = s.target.length - s.shown;
    if (remaining <= 0) return;
    let next = s.shown + Math.max(3, Math.ceil(remaining / 8));
    if (next < s.target.length) {
      const code = s.target.charCodeAt(next);
      if (code >= 0xdc00 && code <= 0xdfff) next++; // don't split an emoji's surrogate pair
    }
    s.shown = Math.min(next, s.target.length);
    const nearBottom = this._isNearBottom();
    s.body.innerHTML = renderMarkdown(streamSafe(s.target.slice(0, s.shown)));
    if (nearBottom) this._scrollToBottom();
    if (s.shown < s.target.length) s.frame = requestAnimationFrame(() => this._revealStep());
  }

  _stopStream() {
    if (this.stream && this.stream.frame) cancelAnimationFrame(this.stream.frame);
    this.stream = null;
  }

  async completePending(text, tools) {
    // Let the reveal animation catch up before swapping in the final render.
    const deadline = performance.now() + 1500;
    while (this.stream && this.stream.shown < this.stream.target.length && performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    this._stopStream();
    const turn = this.pending || this._newAssistantTurn();
    this.pending = null;
    const nearBottom = this._isNearBottom();
    this._fillAssistant(turn, text, tools || []);
    if (nearBottom) this._scrollToBottom();
  }

  failPending(message) {
    this._stopStream();
    const turn = this.pending || this._newAssistantTurn();
    this.pending = null;
    turn.innerHTML = '';
    const err = document.createElement('div');
    err.className = 'msg-error';
    err.textContent = message;
    turn.appendChild(err);
    this._scrollToBottom();
  }

  addNotice(text) {
    const el = document.createElement('div');
    el.className = 'notice';
    el.textContent = text;
    this.thread.appendChild(el);
    this._updateEmpty();
    this._scrollToBottom();
    return el;
  }

  _userTurn(text, files) {
    const turn = document.createElement('div');
    turn.className = 'turn turn-user';
    if (files.length) {
      const row = document.createElement('div');
      row.className = 'msg-files';
      for (const f of files) {
        if (f.preview) {
          const img = document.createElement('img');
          img.src = f.preview;
          img.alt = f.name;
          img.title = f.name;
          row.appendChild(img);
          continue;
        }
        const card = document.createElement('div');
        card.className = 'att att-file';
        card.title = f.name;
        const isImage = (f.mime_type || '').startsWith('image/');
        card.innerHTML = '<div class="att-icon' + (isImage ? ' att-icon-image' : '') + '">' + icon(isImage ? 'image' : 'file', 20) + '</div>';
        const meta = document.createElement('div');
        meta.className = 'att-meta';
        const nameEl = document.createElement('div');
        nameEl.className = 'att-name';
        nameEl.textContent = f.name;
        const typeEl = document.createElement('div');
        typeEl.className = 'att-type';
        typeEl.textContent = fileExt(f.name);
        meta.appendChild(nameEl);
        meta.appendChild(typeEl);
        card.appendChild(meta);
        row.appendChild(card);
      }
      turn.appendChild(row);
    }
    if (text) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubble.textContent = text;
      turn.appendChild(bubble);
    }
    this.thread.appendChild(turn);
  }

  _newAssistantTurn() {
    const turn = document.createElement('div');
    turn.className = 'turn turn-assistant';
    this.thread.appendChild(turn);
    this._updateEmpty();
    return turn;
  }

  _fillAssistant(turn, text, tools) {
    turn.innerHTML = '';
    for (const t of tools) turn.appendChild(renderToolBlock(t.call, t.result));
    if (!text) return;
    turn._raw = text;
    const body = document.createElement('div');
    body.className = 'msg-assistant';
    body.innerHTML = renderMarkdown(text);
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.innerHTML = '<button type="button" class="act-btn" data-action="copy-msg" title="Copy">' + icon('copy', 18) + '</button>';
    turn.appendChild(body);
    turn.appendChild(actions);
    hydrateGenUI(body);
  }

  _updateEmpty() {
    this.main.classList.toggle('is-empty', this.thread.children.length === 0);
  }

  _isNearBottom() {
    const el = this.scroller;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  _scrollToBottom() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }
}

// Partial text mid-stream: hide constructs that aren't complete yet so raw markup
// (a half-written tag, an unfinished widget) never flashes on screen.
function streamSafe(text) {
  text = text.replace(/<[^>\n]*$/, '');
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  if (/^\s*\{/.test(lastLine) && lastLine.indexOf('}') < 0) text = text.slice(0, text.length - lastLine.length);
  let cut = text.length;
  [['{#each', '{/each}'], ['{#if', '{/if}'], ['<radio-group', '</radio-group>'], ['<button', '</button>'], ['<textarea', '>']].forEach(([open, close]) => {
    for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + open.length)) {
      if (text.indexOf(close, start + open.length) < 0) { cut = Math.min(cut, start); break; }
    }
  });
  return text.slice(0, cut);
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-action="copy-msg"]');
  if (!btn) return;
  const turn = btn.closest('.turn');
  const raw = turn._raw || '';
  // GenUI/DIL markup is not useful outside the app; copy the rendered text instead.
  const text = /<(box|row|radio-group|text)\b|DIL\.|GenUI\./.test(raw)
    ? turn.querySelector('.msg-assistant').innerText
    : raw;
  copyToClipboard(text).then(() => flashCopied(btn), (err) => console.error(err));
});
