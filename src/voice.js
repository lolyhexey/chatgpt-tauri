// Voice mode (chatgpt.com's blue button). Checked live in this app: the WebRTC offer goes to
// Rust (voice_connect -> POST /realtime/wm), the answer comes back, then audio flows directly.
// Data channel 0 carries {type:"data_message", data:"<json>"} with inner types such as
// state_update, startup_telemetry / conversation_update (conversation_id) and
// chat_message_delta (JSON-patch deltas building each transcript message).

// Apply one JSON-patch style op to a document ({message: {...}}). Paths look like
// "/message/content/parts/0/text"; ops are add / replace / append / patch / remove / truncate.
function voicePatch(doc, op) {
  if (op.o === 'patch') { (op.v || []).forEach((sub) => voicePatch(doc, sub)); return; }
  const keys = (op.p || '').split('/').slice(1).map((k) => k.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (!keys.length) return;
  let node = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (node[k] === undefined || node[k] === null) node[k] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    node = node[k];
    if (typeof node !== 'object') return;
  }
  const last = keys[keys.length - 1];
  switch (op.o) {
    case 'append':
      if (Array.isArray(node[last]) && Array.isArray(op.v)) node[last] = node[last].concat(op.v);
      else node[last] = (node[last] == null ? '' : node[last]) + (op.v == null ? '' : op.v);
      break;
    case 'remove': delete node[last]; break;
    case 'truncate': if (Array.isArray(node[last]) || typeof node[last] === 'string') node[last] = node[last].slice(0, op.v); break;
    default: node[last] = op.v; // add / replace
  }
}

// Text of a transcript message: string parts or {text} parts (audio_transcription).
function voiceMessageText(message) {
  const parts = (message && message.content && message.content.parts) || [];
  return parts.map((p) => typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
}

// Images ChatGPT created during a call. Seen live: they arrive in chat_message_delta as an
// image tool message whose parts are {content_type:"image_asset_pointer",
// asset_pointer:"sediment://file_…", width, height}. Searched anywhere in the value so the exact
// message shape doesn't matter; only plain file ids are accepted.
function voiceFindImages(v, out = []) {
  if (!v || typeof v !== 'object') return out;
  if (Array.isArray(v)) { v.forEach((x) => voiceFindImages(x, out)); return out; }
  if (v.content_type === 'image_asset_pointer' && typeof v.asset_pointer === 'string') {
    const m = v.asset_pointer.match(/^(?:sediment|file-service):\/\/([A-Za-z0-9_-]{1,100})$/);
    if (m && !out.some((x) => x.file_id === m[1])) out.push({ file_id: m[1], width: Number(v.width) || 0, height: Number(v.height) || 0 });
  }
  for (const x of Object.values(v)) if (x && typeof x === 'object') voiceFindImages(x, out);
  return out;
}

// Rebuilds transcript messages from chat_message_delta events. A delta with p:"" and o:"add"
// starts a message (numbered by c); later deltas may omit p/o and reuse the previous ones.
class VoiceTranscript {
  constructor() { this.docs = new Map(); this.order = []; this.current = null; this.lastP = ''; this.lastO = 'append'; }

  apply(delta) {
    if (!delta || typeof delta !== 'object') return;
    if (delta.c !== undefined) this.current = delta.c;
    const p = delta.p !== undefined ? delta.p : this.lastP;
    const o = delta.o !== undefined ? delta.o : (Array.isArray(delta.v) && delta.p === undefined ? 'patch' : this.lastO);
    if (p === '' && o === 'add' && delta.v && typeof delta.v === 'object') {
      const key = this.current !== null ? this.current : this.order.length;
      if (!this.docs.has(key)) this.order.push(key);
      this.docs.set(key, JSON.parse(JSON.stringify(delta.v)));
      this.current = key;
    } else {
      const doc = this.docs.get(this.current);
      if (doc) voicePatch(doc, { p, o, v: delta.v });
    }
    this.lastP = p;
    this.lastO = o;
  }

  // Visible turns: user and assistant messages to "all" with some text.
  lines() {
    return this.order.map((k) => this.docs.get(k).message).filter((m) => m && m.author &&
      (m.author.role === 'user' || m.author.role === 'assistant') && (!m.recipient || m.recipient === 'all'))
      .map((m) => ({ role: m.author.role, text: voiceMessageText(m) })).filter((l) => l.text);
  }
}

// Words the server uses for the call state, shown in the voice bar.
const VOICE_STATES = { listening: 'Listening', speaking: 'Speaking', thinking: 'Thinking', idle: 'Listening', connecting: 'Connecting…' };

class VoiceCall {
  constructor(ui, { onEnd }) {
    this.ui = ui;
    this.onEnd = onEnd;
    this.pc = null;
    this.mic = null;
    this.audio = null;
    this.convId = null;
    this.muted = false;
    this.active = false;
    this.transcript = new VoiceTranscript();
    this._frame = 0;
  }

  // knownImageIds: images already in the chat being continued (shown on screen). They, and any
  // other image the saved chat has when the call starts, are never treated as new.
  async start(settings, { knownImageIds = [] } = {}) {
    if (this.active) return;
    this.active = true;
    this.convId = null;
    this.transcript = new VoiceTranscript();
    this.images = [];
    this._polling = false;
    this._known = new Set(knownImageIds);
    this._knownReady = settings.conversationId ? this._savedImageIds(settings.conversationId)
      .then((ids) => ids.forEach((x) => this._known.add(x)), (e) => console.warn('voice known images', e)) : Promise.resolve();
    this.ui.open();
    this.ui.status('Connecting…');
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.mic.getAudioTracks().forEach((t) => pc.addTrack(t, this.mic));
      const dc = pc.createDataChannel('', { negotiated: true, id: 0 });
      dc.onmessage = (e) => this._onData(e.data);
      pc.ontrack = (e) => {
        this.audio = new Audio();
        this.audio.srcObject = e.streams[0];
        this.audio.play().catch((err) => console.warn('voice audio', err));
        this._watchLevel(e.streams[0]);
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') this.ui.status('Listening');
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this._fail('Connection lost');
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise((r) => {
        if (pc.iceGatheringState === 'complete') return r();
        pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
        setTimeout(r, 2000);
      });
      if (!this.active) return;
      const answer = await window.__TAURI__.core.invoke('voice_connect', { sdp: pc.localDescription.sdp, settings });
      if (!this.active) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
    } catch (e) {
      this._fail(e && e.name === 'NotAllowedError' ? 'Microphone access was denied' : String(e));
    }
  }

  _onData(raw) {
    let inner;
    try {
      const outer = JSON.parse(raw);
      inner = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer.data;
    } catch (e) { return; }
    if (!inner) return;
    const p = inner.payload || inner;
    if (p.conversation_id && !this.convId) this.convId = p.conversation_id;
    if (inner.type === 'state_update' && p.new_state) this.ui.status(VOICE_STATES[p.new_state] || p.new_state);
    if (inner.type === 'chat_message_delta') {
      this.transcript.apply(p.delta);
      this._addImages(voiceFindImages(p.delta));
      this._render();
    }
    // spawn_update (seen live while an image was being made): also watch the saved chat, in
    // case the image doesn't come through the live messages.
    if (inner.type === 'spawn_update') this._pollSavedImages();
  }

  // Each image remembers how many of your turns came before it, so it sits in ChatGPT's reply
  // to the right request.
  _isNew(img) {
    return !this._known.has(img.file_id) && !this.images.some((x) => x.file_id === img.file_id);
  }

  _addImages(found) {
    const users = this.transcript.lines().filter((l) => l.role === 'user').length;
    let added = false;
    for (const img of found) {
      if (!this._isNew(img)) continue;
      this.images.push({ ...img, userCount: users });
      added = true;
    }
    if (added) this._render();
  }

  _render() {
    if (this._frame) return;
    this._frame = requestAnimationFrame(() => {
      this._frame = 0;
      // Images inside messages built up from several deltas.
      for (const doc of this.transcript.docs.values()) {
        for (const img of voiceFindImages(doc)) {
          if (this._isNew(img)) {
            this.images.push({ ...img, userCount: this.transcript.lines().filter((l) => l.role === 'user').length });
          }
        }
      }
      this.ui.transcript(this.transcript.lines(), this.images.slice());
    });
  }

  async _pollSavedImages() {
    if (this._polling) return;
    this._polling = true;
    for (let i = 0; i < 18 && this.active; i++) {
      await new Promise((r) => setTimeout(r, 10000));
      if (!this.active || !this.convId) continue;
      try {
        // Images the chat already had before the call are skipped (the bug: continuing a chat
        // with earlier pictures pulled them into the newest reply).
        await this._knownReady;
        const conv = await window.__TAURI__.core.invoke('get_conversation_cmd', { id: this.convId });
        const saved = [];
        conv.messages.forEach((m) => (m.generated || []).forEach((g) => saved.push({ file_id: g.file_id, width: g.width || 0, height: g.height || 0 })));
        const fresh = saved.filter((g) => this._isNew(g));
        if (fresh.length) { this._addImages(fresh); break; }
      } catch (e) { console.warn('voice images', e); }
    }
    this._polling = false;
  }

  async _savedImageIds(convId) {
    const conv = await window.__TAURI__.core.invoke('get_conversation_cmd', { id: convId });
    const ids = [];
    conv.messages.forEach((m) => (m.generated || []).forEach((g) => ids.push(g.file_id)));
    return ids;
  }

  // How loud ChatGPT is speaking (0..1), so the orb can pulse with its voice like on the web.
  _watchLevel(stream) {
    try {
      this.levelCtx = new AudioContext();
      const analyser = this.levelCtx.createAnalyser();
      analyser.fftSize = 512;
      this.levelCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        if (!this.active) return;
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        this.ui.level(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        this._levelFrame = requestAnimationFrame(tick);
      };
      tick();
    } catch (e) { console.warn('voice level', e); }
  }

  toggleMute() {
    if (!this.mic) return;
    this.muted = !this.muted;
    this.mic.getAudioTracks().forEach((t) => { t.enabled = !this.muted; });
    this.ui.muted(this.muted);
  }

  _fail(message) {
    if (!this.active) return;
    this.ui.status(message);
    this.ui.error(message);
    this.end(true);
  }

  end(failed) {
    if (!this.active) return;
    this.active = false;
    try { if (this.pc) this.pc.close(); } catch (e) { /* already closed */ }
    if (this.mic) this.mic.getTracks().forEach((t) => t.stop());
    if (this.audio) { this.audio.pause(); this.audio.srcObject = null; }
    if (this._levelFrame) cancelAnimationFrame(this._levelFrame);
    if (this.levelCtx) this.levelCtx.close().catch(() => {});
    this.pc = null; this.mic = null; this.audio = null; this.levelCtx = null;
    if (!failed) this.ui.close();
    this.onEnd(this.convId, !!failed);
  }
}
