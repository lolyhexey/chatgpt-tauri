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
      else this._fillAssistant(this._newAssistantTurn(), msg.content, replyContext(msg.sources, msg.images));
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
    this.activity = null;
    this.ctx = replyContext();
    this.pending = this._newAssistantTurn();
    this.pending.innerHTML = '<div class="typing" aria-label="Thinking"></div>';
    this._scrollToBottom();
  }

  // One live event from the backend: {type:'text', delta}, {type:'step', ...} or {type:'images', images}.
  onLive(ev) {
    if (!this.pending) return;
    if (ev.type === 'step') this._step(ev);
    else if (ev.type === 'text') this._text(ev.delta);
    else if (ev.type === 'images') (ev.images || []).forEach((img) => this.ctx.images.set(img.query, img));
  }

  // Text so far in the current reply (used by Goal mode to close a round).
  currentText() {
    return this.stream ? this.stream.target : '';
  }

  // The server sends text in bursts every ~100-150ms; reveal each burst gradually
  // (like chatgpt.com) instead of jumping a whole paragraph at once.
  _text(delta) {
    if (!this.stream) {
      const typing = this.pending.querySelector('.typing');
      if (typing) typing.remove();
      const body = document.createElement('div');
      body.className = 'msg-assistant streaming';
      this.pending.appendChild(body);
      this.stream = { body, target: '', shown: 0, frame: 0 };
      if (this.activity) this.activity.el.classList.remove('running');
    }
    this.stream.target += delta;
    if (!this.stream.frame) this.stream.frame = requestAnimationFrame(() => this._revealStep());
  }

  // What ChatGPT is doing right now (searching, running code, calling a connector,
  // thinking). The header shows the latest step; clicking it lists every step.
  _step(ev) {
    (ev.sources || []).forEach((s) => this.ctx.sources.set(s.id, s));
    const a = this._ensureActivity();
    a.el.classList.add('running');
    if (ev.kind === 'recap') {
      if (ev.title) a.recap = ev.title;
      return;
    }
    if (ev.kind === 'tool_query' || ev.kind === 'tool_result') {
      const call = a.lastCall && a.items.get(a.lastCall);
      if (call && ev.title) {
        call.querySelector('.step-title').textContent = ev.title;
        a.label.textContent = ev.title;
      }
      if (call && ev.kind === 'tool_query') {
        const d = call.querySelector('.step-detail');
        d.textContent = ev.detail;
        d.hidden = !ev.detail;
        return;
      }
      if (call && ev.detail) {
        let out = call.querySelector('.step-result');
        if (!out) {
          out = document.createElement('div');
          out.className = 'step-result';
          call.appendChild(out);
        }
        out.textContent = ev.detail;
      }
      return;
    }
    let item = a.items.get(ev.id);
    if (!item) {
      item = document.createElement('div');
      item.className = 'activity-step';
      item.innerHTML = '<div class="step-head"><span class="step-icon"></span><span class="step-title"></span></div><div class="step-detail"></div>';
      a.list.appendChild(item);
      a.items.set(ev.id, item);
    }
    if (ev.kind === 'tool_call') a.lastCall = ev.id;
    const title = ev.title || (ev.kind === 'thought' ? 'Thinking' : 'Working');
    item.querySelector('.step-icon').innerHTML = icon(stepIcon(ev), 14);
    item.querySelector('.step-title').textContent = title;
    const detail = item.querySelector('.step-detail');
    // A thought's summary is already its title; only show the rest.
    const extra = ev.kind === 'thought' && ev.detail.startsWith(title) ? ev.detail.slice(title.length).trim() : ev.detail;
    detail.textContent = extra;
    detail.hidden = !extra;
    a.label.textContent = title;
    a.count.textContent = a.items.size > 1 ? `${a.items.size} steps` : '';
  }

  _ensureActivity() {
    if (this.activity) return this.activity;
    const typing = this.pending.querySelector('.typing');
    if (typing) typing.remove();
    const el = document.createElement('div');
    el.className = 'activity running';
    el.innerHTML =
      '<button type="button" class="activity-head" data-action="toggle-activity">' +
      '<span class="activity-label">Thinking</span><span class="activity-count"></span>' +
      icon('chevron-right', 14, 'activity-chevron') + '</button>' +
      '<div class="activity-list" hidden></div>';
    this.pending.insertBefore(el, this.pending.firstChild);
    this.activity = {
      el,
      label: el.querySelector('.activity-label'),
      count: el.querySelector('.activity-count'),
      list: el.querySelector('.activity-list'),
      items: new Map(),
      lastCall: null,
      recap: '',
      started: performance.now(),
    };
    return this.activity;
  }

  // Detach the activity panel from the pending turn and freeze its header.
  _takeActivity() {
    const a = this.activity;
    this.activity = null;
    if (!a) return null;
    a.el.classList.remove('running');
    const secs = Math.max(1, Math.round((performance.now() - a.started) / 1000));
    a.label.textContent = a.recap || `Worked for ${secs}s`;
    a.count.textContent = a.items.size ? `${a.items.size} ${a.items.size === 1 ? 'step' : 'steps'}` : '';
    if (!a.items.size) a.el.querySelector('.activity-head').disabled = true;
    return a.el;
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
    s.body.innerHTML = renderMarkdown(streamSafe(s.target.slice(0, s.shown)), Object.assign({ streaming: true }, this.ctx));
    hydrateMedia(s.body);
    if (nearBottom) this._scrollToBottom();
    if (s.shown < s.target.length) s.frame = requestAnimationFrame(() => this._revealStep());
  }

  _stopStream() {
    if (this.stream && this.stream.frame) cancelAnimationFrame(this.stream.frame);
    this.stream = null;
  }

  async completePending(text) {
    // Let the reveal animation catch up before swapping in the final render.
    const deadline = performance.now() + 1500;
    while (this.stream && this.stream.shown < this.stream.target.length && performance.now() < deadline) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    this._stopStream();
    const turn = this.pending || this._newAssistantTurn();
    this.pending = null;
    const activity = this._takeActivity();
    const nearBottom = this._isNearBottom();
    this._fillAssistant(turn, text, this.ctx);
    if (activity) turn.insertBefore(activity, turn.firstChild);
    if (nearBottom) this._scrollToBottom();
  }

  failPending(message) {
    this._stopStream();
    const turn = this.pending || this._newAssistantTurn();
    this.pending = null;
    const activity = this._takeActivity();
    turn.innerHTML = '';
    if (activity) turn.appendChild(activity);
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
      renderUserText(bubble, text);
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

  _fillAssistant(turn, text, ctx) {
    turn.innerHTML = '';
    if (!text) return;
    turn._raw = text;
    const body = document.createElement('div');
    body.className = 'msg-assistant';
    body.innerHTML = renderMarkdown(text, ctx);
    hydrateMedia(body);
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

// Data a reply's components refer to: citation sources and resolved images.
function replyContext(sources, images) {
  return {
    sources: new Map((sources || []).map((s) => [s.id, s])),
    images: new Map((images || []).map((i) => [i.query, i])),
  };
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

function stepIcon(ev) {
  if (ev.kind === 'thought') return 'zap';
  const t = (ev.tool || '').toLowerCase();
  if (t.startsWith('web') || /search/.test(t) && !/file/.test(t)) return 'globe';
  if (t.startsWith('container') || t.startsWith('python')) return 'terminal';
  if (/file|browser/.test(t)) return 'file';
  if (/image|dalle/.test(t)) return 'image';
  return 'wrench';
}

document.addEventListener('click', (e) => {
  const head = e.target.closest && e.target.closest('[data-action="toggle-activity"]');
  if (!head) return;
  const panel = head.closest('.activity');
  const list = panel.querySelector('.activity-list');
  list.hidden = !list.hidden;
  panel.classList.toggle('open', !list.hidden);
});

document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('[data-action="copy-msg"]');
  if (!btn) return;
  const turn = btn.closest('.turn');
  const raw = stripCites(turn._raw || '');
  // GenUI/DIL markup is not useful outside the app; copy the rendered text instead.
  const text = /<(box|row|radio-group|text)\b|DIL\.|GenUI\./.test(raw)
    ? turn.querySelector('.msg-assistant').innerText
    : raw;
  copyToClipboard(text).then(() => flashCopied(btn), (err) => console.error(err));
});
