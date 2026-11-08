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

  // While a chat is fetched (measured on chatgpt.com): a 28px spinner centred in the thread,
  // shown only if loading takes longer than 0.4 s. Replaced by loadConversation/clear.
  showLoading() {
    this.thread.innerHTML = '<div class="thread-loading" role="status" aria-busy="true" aria-label="Loading chat">'
      + '<svg viewBox="0 0 24 24" width="28" height="28" fill="none" aria-hidden="true">'
      + '<circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="2.5" opacity="0.3"/>'
      + '<path d="M12 2.5a9.5 9.5 0 0 1 9.5 9.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>'
      + '</svg></div>';
    this.pending = null;
    this._updateEmpty();
  }

  // keepScroll: a redraw of the chat already shown (it grew elsewhere); stay where the reader
  // is unless they were following the end.
  // On a redraw, turns that haven't changed are kept as they are (no flash, images and code
  // stay put); only the turns from the first difference on are built again — usually just the
  // reply that is still growing.
  loadConversation(messages, { keepScroll = false } = {}) {
    const follow = !keepScroll || this._isNearBottom();
    const top = this.scroller.scrollTop;
    const list = mergeReplies(messages);
    const sigs = list.map(turnSig);
    const old = [...this.thread.children];
    let same = 0;
    if (keepScroll) while (same < list.length && same < old.length && old[same].dataset.sig === sigs[same]) same++;
    old.slice(same).forEach((el) => el.remove());
    this.pending = null;
    for (let i = same; i < list.length; i++) {
      const msg = list[i];
      if (msg.role === 'user') this._userTurn(msg.content, msg.attachments || []);
      else {
        const turn = this._newAssistantTurn();
        this._fillAssistant(turn, msg.content, replyContext(msg.sources, msg.images, msg.generated));
        addSavedActivity(turn, msg);
      }
      this.thread.lastElementChild.dataset.sig = sigs[i];
    }
    this._updateEmpty();
    if (follow) this._scrollToBottom();
    else this.scroller.scrollTop = top;
  }

  // A reply being written on another device: the thinking dots after the saved part.
  showRemoteBusy() {
    if (this.thread.querySelector('.remote-busy')) return;
    const turn = this._newAssistantTurn();
    turn.classList.add('remote-busy');
    turn.innerHTML = '<div class="typing" aria-label="Replying on another device"></div>';
    if (this._isNearBottom()) this._scrollToBottom();
  }

  hideRemoteBusy() {
    const el = this.thread.querySelector('.remote-busy');
    if (el) el.remove();
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
    else if (ev.type === 'text') this._text(ev.delta, ev.id);
    else if (ev.type === 'images') (ev.images || []).forEach((img) => this.ctx.images.set(img.query, img));
    else if (ev.type === 'generated') this._generated(ev.images || []);
  }

  // Images ChatGPT created: show them right away, even before (or without) any text.
  _generated(images) {
    const fresh = images.filter((g) => !this.ctx.generated.some((x) => x.file_id === g.file_id));
    if (!fresh.length) return;
    this.ctx.generated.push(...fresh);
    const typing = this.pending.querySelector('.typing');
    if (typing) typing.remove();
    let box = this.pending.querySelector('.gen-out');
    if (!box) {
      box = document.createElement('div');
      box.className = 'gen-out';
      const body = this.pending.querySelector('.msg-assistant');
      this.pending.insertBefore(box, body || null);
    }
    renderGenerated(box, fresh);
    if (this.activity) this.activity.el.classList.remove('running');
    if (this._isNearBottom()) this._scrollToBottom();
  }

  // The server's copy of the reply (sent when the stream carried several reply messages):
  // its sources and images join this reply's context before the final render.
  useStored(msg) {
    if (!this.ctx || !msg) return;
    (msg.sources || []).forEach((s) => this.ctx.sources.set(s.id, s));
    (msg.images || []).forEach((i) => this.ctx.images.set(i.query, i));
    (msg.generated || []).forEach((g) => {
      if (!this.ctx.generated.some((x) => x.file_id === g.file_id)) this.ctx.generated.push(g);
    });
  }

  // Voice mode, like chatgpt.com: the transcript appears as normal chat messages (user bubble on
  // the right, ChatGPT on the left), updated live. ChatGPT's consecutive messages form one reply,
  // with any image it created on top (images: [{file_id, width, height, userCount}]).
  setVoiceTurns(lines, images) {
    if (!this.voiceTurns) this.voiceTurns = [];
    const nearBottom = this._isNearBottom();
    const groups = voiceGroups(lines, images || []);
    groups.forEach((g, i) => {
      let t = this.voiceTurns[i];
      if (!t || t.role !== g.role) {
        const el = document.createElement('div');
        el.className = 'turn ' + (g.role === 'user' ? 'turn-user' : 'turn-assistant');
        el.innerHTML = g.role === 'user' ? '<div class="bubble"></div>'
          : '<div class="gen-out" hidden></div><div class="msg-assistant"></div>';
        if (t) t.el.replaceWith(el); else this.thread.appendChild(el);
        t = this.voiceTurns[i] = { role: g.role, el, text: null, imageKey: '' };
      }
      const text = g.texts.join('\n\n');
      if (t.text !== text) {
        t.text = text;
        if (g.role === 'user') t.el.firstChild.textContent = text;
        else {
          const body = t.el.querySelector('.msg-assistant');
          body.innerHTML = renderMarkdown(text);
          hydrateMermaid(body); // this path sets innerHTML directly, bypassing patchHtml/hydrateMedia
        }
      }
      const imageKey = g.images.map((x) => x.file_id).join(',');
      if (g.role === 'assistant' && t.imageKey !== imageKey) {
        const box = t.el.querySelector('.gen-out');
        const shown = new Set([...box.querySelectorAll('[data-file-id]')].map((f) => f.getAttribute('data-file-id')));
        renderGenerated(box, g.images.filter((x) => !shown.has(x.file_id)));
        box.hidden = !g.images.length;
        t.imageKey = imageKey;
      }
    });
    this.voiceTurns.splice(groups.length).forEach((t) => t.el.remove());
    this._updateEmpty();
    if (nearBottom) this._scrollToBottom();
  }

  // Text so far in the current reply (used by Goal mode to close a round).
  currentText() {
    return this.stream ? this.stream.target : '';
  }

  // The server sends text in bursts every ~100-150ms; reveal each burst gradually
  // (like chatgpt.com) instead of jumping a whole paragraph at once.
  // Text is kept per message id: a reply can stream in two messages at once, and appending
  // their pieces to one string interleaves them (the "NPatch" garbling).
  _text(delta, id) {
    if (!this.stream) {
      const typing = this.pending.querySelector('.typing');
      if (typing) typing.remove();
      const body = document.createElement('div');
      body.className = 'msg-assistant streaming';
      this.pending.appendChild(body);
      this.stream = { body, target: '', shown: 0, frame: 0, order: [], texts: new Map() };
      if (this.activity) this.activity.el.classList.remove('running');
    }
    const s = this.stream;
    const key = id || '';
    if (!s.texts.has(key)) { s.order.push(key); s.texts.set(key, ''); }
    s.texts.set(key, s.texts.get(key) + delta);
    const next = joinReplyTexts(s.order.map((k) => s.texts.get(k)));
    // Usually the text only grows; if an earlier message changed, re-reveal from where they differ.
    if (!next.startsWith(s.target.slice(0, s.shown))) {
      let same = 0;
      while (same < s.shown && next.charCodeAt(same) === s.target.charCodeAt(same)) same++;
      s.shown = same;
    }
    s.target = next;
    if (!s.frame) s.frame = requestAnimationFrame(() => this._revealStep());
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
    item.querySelector('.step-icon').innerHTML = stepIconHtml(ev);
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
    // Only the blocks that changed (usually the last one) are replaced, like chatgpt.com.
    patchHtml(s.body, renderMarkdown(streamSafe(s.target.slice(0, s.shown)), Object.assign({ streaming: true }, this.ctx)));
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
    const live = this.stream && this.stream.body;
    this._stopStream();
    const turn = this.pending || this._newAssistantTurn();
    this.pending = null;
    const activity = this._takeActivity();
    const nearBottom = this._isNearBottom();
    this._fillAssistant(turn, text, this.ctx, live && live.isConnected ? live : null);
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
        // An image from history: show the picture itself (fetched through Rust with the token);
        // fall back to the file card below if it can't be loaded.
        if ((f.mime_type || '').startsWith('image/') && f.id) {
          const img = document.createElement('img');
          img.alt = f.name;
          img.title = f.name;
          img.className = 'msg-file-loading';
          row.appendChild(img);
          loadGenerated(f.id).then((src) => { img.src = src; img.classList.remove('msg-file-loading'); }, () => {
            img.replaceWith(fileCard(f));
          });
          continue;
        }
        row.appendChild(fileCard(f));
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

  // reuse: the body that streamed this reply, patched in place instead of rebuilt.
  _fillAssistant(turn, text, ctx, reuse) {
    if (reuse) reuse.remove();
    turn.innerHTML = '';
    const generated = (ctx && ctx.generated) || [];
    // Image-only replies (Create image) have no text, only the generated images.
    if (!text && !generated.length) return;
    turn._raw = text || '';
    if (generated.length) {
      const box = document.createElement('div');
      box.className = 'gen-out';
      renderGenerated(box, generated);
      turn.appendChild(box);
    }
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    if (text) {
      // The body that streamed is kept and patched (finished paragraphs and formulas stay the
      // same nodes, like chatgpt.com); otherwise it's built fresh.
      const body = reuse || document.createElement('div');
      body.className = 'msg-assistant';
      patchHtml(body, renderMarkdown(text, ctx));
      turn.appendChild(body);
      hydrateGenUI(body);
      actions.innerHTML = '<button type="button" class="act-btn" data-action="copy-msg" title="Copy">' + icon('copy', 18) + '</button>';
    }
    if (actions.innerHTML) turn.appendChild(actions);
  }

  // A chat whose reply keeps running after you switch away lives in a hidden thread element;
  // it must not touch the shared scroller or the empty-state of the chat being viewed.
  _visible() {
    return this.thread.isConnected && !this.thread.hidden;
  }

  _updateEmpty() {
    if (!this._visible()) return;
    this.main.classList.toggle('is-empty', this.thread.children.length === 0);
  }

  _isNearBottom() {
    if (!this._visible()) return false;
    const el = this.scroller;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  _scrollToBottom() {
    if (!this._visible()) return;
    this.scroller.scrollTop = this.scroller.scrollHeight;
  }
}

// A non-image attachment in a sent message (or an image that couldn't be loaded).
function fileCard(f) {
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
  return card;
}

// Voice transcript lines -> turns: each of your lines is a turn; ChatGPT's consecutive lines join
// into one reply. An image goes into the reply after the request it answers (userCount = how
// many of your lines came before it); if that reply has no words yet, it starts one.
function voiceGroups(lines, images) {
  const groups = [];
  let users = 0;
  for (const l of lines) {
    const last = groups[groups.length - 1];
    if (l.role === 'user') { users++; groups.push({ role: 'user', texts: [l.text], users, images: [] }); }
    else if (last && last.role === 'assistant') last.texts.push(l.text);
    else groups.push({ role: 'assistant', texts: [l.text], users, images: [] });
  }
  for (const img of images) {
    let g = groups.find((x) => x.role === 'assistant' && x.users === img.userCount);
    if (!g) {
      g = { role: 'assistant', texts: [], users: img.userCount, images: [] };
      const at = groups.findIndex((x) => x.role === 'user' && x.users === img.userCount);
      groups.splice(at === -1 ? groups.length : at + 1, 0, g);
    }
    g.images.push(img);
  }
  return groups;
}

// A short fingerprint of everything a turn shows, so a redraw can tell which turns changed.
function turnSig(msg) {
  const parts = [
    msg.role,
    msg.content || '',
    (msg.attachments || []).map((a) => a.id + '/' + a.name).join(','),
    (msg.generated || []).map((g) => g.file_id).join(','),
    (msg.sources || []).map((s) => s.id || s.url || '').join(','),
    (msg.images || []).map((i) => i.query || i.url || '').join(','),
    msg.recap || '',
    (msg.steps || []).map((s) => s.title + '/' + s.detail.length).join(','),
    (msg.runs || []).map((r) => r.code.length + '/' + r.output.length).join(','),
  ].join('\u0001');
  let h = 5381;
  for (let i = 0; i < parts.length; i++) h = ((h * 33) ^ parts.charCodeAt(i)) >>> 0;
  return h.toString(36) + ':' + parts.length;
}

// History like chatgpt.com: ChatGPT's consecutive messages (e.g. a voice reply said in two
// parts around an image) show as one reply; their texts, sources and images are combined.
function mergeReplies(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (m.role !== 'user' && prev && prev.role !== 'user') {
      prev.content = [prev.content, m.content].filter((t) => t && t.trim()).join('\n\n');
      prev.sources = prev.sources.concat(m.sources || []);
      prev.images = prev.images.concat(m.images || []);
      prev.generated = prev.generated.concat((m.generated || []).filter((g) => !prev.generated.some((x) => x.file_id === g.file_id)));
      prev.steps = prev.steps.concat(m.steps || []);
      prev.runs = prev.runs.concat(m.runs || []);
      if (m.recap) prev.recap = m.recap;
    } else {
      out.push({ ...m, sources: (m.sources || []).slice(), images: (m.images || []).slice(), generated: (m.generated || []).slice(),
        steps: (m.steps || []).slice(), runs: (m.runs || []).slice(), recap: m.recap || '' });
    }
  }
  return out;
}

// Same rule as Rust's join_reply/merge_reply_text: one text per message in arrival order. The
// server can stream a reply whole in one message and cut into consecutive segments in others
// (seen: 788 + 3232 + 4913 chars = the 8933-char whole), so a text already inside the reply is
// a copy and skipped, one containing the reply so far replaces it, one whose start repeats the
// reply's end continues it, and anything else is a separate paragraph.
function joinReplyTexts(texts) {
  let out = '';
  for (const raw of texts) {
    const t = raw.trim();
    if (!t || out.includes(t)) continue;
    if (!out || t.includes(out)) { out = t; continue; }
    const overlap = replyOverlap(out, t);
    out = overlap ? out + t.slice(overlap) : out + '\n\n' + t;
  }
  return out;
}

// Length of t's start that out already ends with (at least 20 chars of it), else 0.
function replyOverlap(out, t) {
  if (t.length < 20) return 0;
  const probe = t.slice(0, 20);
  for (let pos = out.indexOf(probe, Math.max(0, out.length - t.length)); pos >= 0; pos = out.indexOf(probe, pos + 1)) {
    if (t.startsWith(out.slice(pos))) return out.length - pos;
  }
  return 0;
}

// Data a reply's components refer to: citation sources, resolved images, created images.
function replyContext(sources, images, generated) {
  return {
    sources: new Map((sources || []).map((s) => [s.id, s])),
    images: new Map((images || []).map((i) => [i.query, i])),
    generated: (generated || []).slice(),
  };
}

// file id -> Promise<data: URL>. The image's link needs the account token, so Rust fetches it.
const generatedCache = new Map();

function loadGenerated(fileId) {
  if (!generatedCache.has(fileId)) {
    const p = window.__TAURI__.core.invoke('generated_image', { fileId });
    p.catch(() => generatedCache.delete(fileId)); // allow a retry next time
    generatedCache.set(fileId, p);
  }
  return generatedCache.get(fileId);
}

// Created images like chatgpt.com: 480px wide, rounded, click to open the viewer.
function renderGenerated(box, images) {
  images.forEach((g) => {
    const frame = document.createElement('button');
    frame.type = 'button';
    frame.className = 'gen-out-img loading';
    frame.title = g.title || 'Generated image';
    if (g.width && g.height) frame.style.aspectRatio = g.width + ' / ' + g.height;
    frame.setAttribute('data-file-id', g.file_id);
    box.appendChild(frame);
    loadGenerated(g.file_id).then((src) => {
      const img = document.createElement('img');
      img.src = src;
      img.alt = g.title || 'Generated image';
      frame.appendChild(img);
      frame.classList.remove('loading');
    }, (err) => {
      frame.classList.remove('loading');
      frame.classList.add('failed');
      frame.textContent = 'Image unavailable';
      console.warn('generated image', err);
    });
  });
}

document.addEventListener('click', (e) => {
  const frame = e.target.closest && e.target.closest('.gen-out-img');
  if (!frame) return;
  const img = frame.querySelector('img');
  if (!img) return;
  imageViewer.open({ url: img.src, title: frame.title, fileId: frame.getAttribute('data-file-id') });
});

// Partial text mid-stream: hide constructs that aren't complete yet so raw markup
// (a half-written tag, an unfinished widget) never flashes on screen.
function streamSafe(text) {
  text = text.replace(/<[^>\n]*$/, '');
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  if (/^\s*\{/.test(lastLine) && lastLine.indexOf('}') < 0) text = text.slice(0, text.length - lastLine.length);
  let cut = text.length;
  [['{#each', '{/each}'], ['{#if', '{/if}'], ['<radio-group', '</radio-group>'], ['<button', '</button>'], ['<textarea', '>'],
    ['\\[', '\\]'], ['\\(', '\\)'], ['$$', '$$']].forEach(([open, close]) => {
    for (let start = text.indexOf(open); start >= 0; start = text.indexOf(open, start + open.length)) {
      if (text.indexOf(close, start + open.length) < 0) { cut = Math.min(cut, start); break; }
    }
  });
  return text.slice(0, cut);
}

// A saved reply's activity, as chatgpt.com shows it in history (measured): a closed header
// with the recap ("Worked for 13s ›") that opens to the thought summaries and app calls, then
// each code run as an open "Analyzed ⌄" block with its Result, above the reply text.
function addSavedActivity(turn, msg) {
  const steps = msg.steps || [];
  const runs = msg.runs || [];
  if (!msg.recap && !steps.length && !runs.length) return;
  const frag = document.createDocumentFragment();
  if (msg.recap || steps.length) {
    const el = document.createElement('div');
    el.className = 'activity saved';
    el.innerHTML = '<button type="button" class="activity-head" data-action="toggle-activity"><span class="activity-label"></span>' +
      icon('chevron-right', 14, 'activity-chevron') + '</button><div class="activity-list" hidden></div>';
    el.querySelector('.activity-label').textContent = msg.recap || steps[steps.length - 1].title;
    if (!steps.length) el.querySelector('.activity-head').disabled = true;
    const list = el.querySelector('.activity-list');
    for (const s of steps) {
      const item = document.createElement('div');
      item.className = 'activity-step';
      item.innerHTML = '<div class="step-head"><span class="step-icon"></span><span class="step-title"></span></div><div class="step-detail"></div>';
      const tool = s.kind === 'web' ? 'web' : s.kind === 'python' ? 'python' : s.kind === 'tool_call' ? 'api_tool' : '';
      item.querySelector('.step-icon').innerHTML = stepIconHtml({ kind: tool ? 'tool_call' : 'thought', tool, icon: s.icon });
      item.querySelector('.step-title').textContent = s.title;
      const detail = item.querySelector('.step-detail');
      detail.textContent = s.detail || (s.domains || []).join(', ');
      detail.hidden = !detail.textContent;
      list.appendChild(item);
    }
    frag.appendChild(el);
  }
  for (const r of runs) {
    const box = document.createElement('div');
    box.className = 'analyzed open';
    box.innerHTML = '<button type="button" class="analyzed-head" data-action="toggle-analyzed">Analyzed' +
      icon('chevron-right', 14, 'activity-chevron') + '</button><div class="analyzed-body"></div>';
    const body = box.querySelector('.analyzed-body');
    // A fence longer than any backtick run in the code, so the code can't end it early.
    const longest = Math.max(0, ...(r.code.match(/`+/g) || []).map((m) => m.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    body.innerHTML = renderMarkdown(fence + 'python\n' + r.code + '\n' + fence, replyContext());
    if (r.output) {
      const res = document.createElement('div');
      res.className = 'analyzed-result';
      res.innerHTML = '<div class="analyzed-result-label">Result</div><pre></pre>';
      res.querySelector('pre').textContent = r.output;
      body.appendChild(res);
    }
    frag.appendChild(box);
  }
  turn.insertBefore(frag, turn.firstChild);
}

document.addEventListener('click', (e) => {
  const head = e.target.closest && e.target.closest('[data-action="toggle-analyzed"]');
  if (!head) return;
  const box = head.closest('.analyzed');
  box.classList.toggle('open');
});

// The tool's own icon when ChatGPT sends one (e.g. the Hexey logo), else a fitting generic one.
function stepIconHtml(ev) {
  const own = ev.icon || '';
  if (/^https:\/\//.test(own)) {
    return '<img class="step-logo" src="' + escAttr(own) + '" alt="" width="16" height="16" referrerpolicy="no-referrer" draggable="false">';
  }
  if (own === 'globe' || own === 'code') return icon(own, 14);
  return icon(stepIcon(ev), 14);
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
