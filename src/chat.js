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
    this.pending = this._newAssistantTurn();
    this.pending.innerHTML = '<div class="typing" aria-label="Thinking"></div>';
    this._scrollToBottom();
  }

  completePending(text, tools) {
    const turn = this.pending || this._newAssistantTurn();
    this.pending = null;
    this._fillAssistant(turn, text, tools || []);
    this._scrollToBottom();
  }

  failPending(message) {
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

  _scrollToBottom() {
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }
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
