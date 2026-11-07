const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const appEl = $('app');
const mainEl = $('main');
const loginOverlay = $('login-overlay');
const tokenInput = $('token-input');
const loginError = $('login-error');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');
const voiceBtn = $('voice-btn');
const voiceOrb = $('voice-orb');
const voiceMuteBtn = $('voice-mute');
let voiceActive = false;
const plusBtn = $('plus-btn');
const plusMenu = $('plus-menu');
const fileInput = $('file-input');
const dropOverlay = $('drop-overlay');
const goalChip = $('goal-chip');
const composerEl = $('composer');
const titleEl = $('chat-title');
const statusEl = $('status-text');
const searchBox = $('sb-search');
const searchInput = $('sb-search-input');

let currentConversationId = null;
let sending = false;
let goalMode = false;

hydrateIcons();

const mentions = new Mentions(chatInput, $('mention-chips'), $('mention-menu'), () => updateSendState());
const picker = new ModelPicker($('model-btn'), $('model-label'), $('model-panel'));
// One view per open chat: its own thread element, Chat, and place in the conversation
// (convId + parentId, sent with every message). A chat whose reply is still running keeps its
// view when you switch away (hidden, still streaming); others are dropped and reloaded.
const messagesEl = $('messages');
const parkedViews = new Set();
// conversation id -> { conv, updated } so switching back to a chat is instant while unchanged.
const convCache = new Map();

function makeView(convId, el) {
  el = el || document.createElement('div');
  el.classList.add('thread');
  if (!el.parentNode) messagesEl.appendChild(el);
  return { convId, parentId: null, el, chat: new Chat(el, messagesEl, mainEl), running: false };
}

let view = makeView(null, $('thread'));
let chat = view.chat;

function showView(next) {
  if (view !== next) {
    if (view.running) { view.el.hidden = true; parkedViews.add(view); } else view.el.remove();
    if (!next.el.parentNode) messagesEl.appendChild(next.el);
  }
  next.el.hidden = false;
  parkedViews.delete(next);
  view = next;
  chat = next.chat;
  currentConversationId = next.convId;
  chat._updateEmpty();
  updateSendState();
}

// A run finished: if its view isn't shown, drop it (the chat reloads from the server next time).
function finishRun(v) {
  v.running = false;
  v.stopping = false;
  v.streamId = null;
  if (v.convId) {
    sidebar.setBusy(v.convId, false);
    convCache.delete(v.convId);
  }
  if (v !== view) { parkedViews.delete(v); v.el.remove(); }
}

function runningViewFor(convId) {
  if (view.convId === convId && view.running) return view;
  return [...parkedViews].find((v) => v.convId === convId) || null;
}
const attachments = new Attachments($('att-tray'), (message) => {
  if (message) setStatus(message);
  updateSendState();
});
const sidebar = new Sidebar($('chat-list'), {
  onSelect: openConversation,
  onDelete: deleteConversation,
});

function setTitle(title) {
  titleEl.textContent = title || 'ChatGPT';
  document.title = title ? `${title} - ChatGPT` : 'ChatGPT';
}

function setStatus(text) {
  statusEl.textContent = text;
}

function handleAuthError(e) {
  const s = String(e);
  if (s.includes('401') || s.includes('expired') || s.includes('No token')) showLogin('Your session expired. Paste a new access token.');
}

function showLogin(message) {
  loginError.textContent = message || '';
  loginOverlay.hidden = false;
  tokenInput.focus();
}

function updateSendState() {
  // During a voice call (like chatgpt.com): the Voice button becomes a blue ✕ that ends the
  // call, with the microphone toggle beside it; Send is hidden.
  const voiceMode = voiceActive ? 'end' : 'start';
  if (voiceBtn.dataset.mode !== voiceMode) {
    voiceBtn.dataset.mode = voiceMode;
    voiceBtn.innerHTML = icon(voiceActive ? 'x' : 'audio-lines', 18);
    voiceBtn.title = voiceActive ? 'End Voice' : 'Start voice mode';
  }
  voiceMuteBtn.hidden = !voiceActive;
  if (voiceActive) {
    voiceBtn.hidden = false;
    sendBtn.hidden = true;
    return;
  }
  // While the chat you're looking at is replying, the send button is a Stop button (like the web).
  const stoppable = !!(view && view.running);
  const mode = stoppable ? 'stop' : 'send';
  if (sendBtn.dataset.mode !== mode) {
    sendBtn.dataset.mode = mode;
    sendBtn.innerHTML = icon(stoppable ? 'square' : 'arrow-up', 18);
  }
  if (stoppable) {
    sendBtn.hidden = false;
    voiceBtn.hidden = true;
    sendBtn.disabled = !!view.stopping;
    sendBtn.classList.remove('busy');
    sendBtn.title = 'Stop';
    return;
  }
  const hasContent = !!chatInput.value.trim() || attachments.count() > 0 || mentions.count() > 0;
  // Like chatgpt.com: an empty box shows the blue Voice button; typing turns it into Send.
  const showVoice = !hasContent && !sending;
  sendBtn.hidden = showVoice;
  voiceBtn.hidden = !showVoice;
  sendBtn.disabled = sending || attachments.busy() || !hasContent;
  sendBtn.classList.toggle('busy', sending);
  sendBtn.title = attachments.busy() ? 'Waiting for files to upload' : sending ? 'Another chat is still replying' : 'Send';
}

// Stop the reply in the chat being viewed: the server is told (stop_conversation) and the
// text that already arrived stays.
async function stopCurrent() {
  const v = view;
  if (!v.running || v.stopping || !v.streamId) return;
  v.stopping = true;
  updateSendState();
  setStatus('Stopping…');
  try {
    await invoke('stop_generation', { streamId: v.streamId, conversationId: v.convId });
  } catch (e) {
    console.warn('stop failed', e);
  }
}

function setSending(value) {
  sending = value;
  updateSendState();
  setStatus(value ? 'Thinking…' : 'Ready');
}

function setGoalMode(value) {
  goalMode = value;
  goalChip.hidden = !value;
  chatInput.placeholder = value ? 'Describe the goal to work on…' : 'Ask ChatGPT';
}

// Like chatgpt.com: once the text needs more than one line, it takes the full width and the
// buttons move to a row below. Stays that way until the box is emptied (no flip-flopping).
function autosize() {
  chatInput.style.height = 'auto';
  if (!chatInput.value) composerEl.classList.remove('multiline');
  else if (chatInput.value.includes('\n') || chatInput.scrollHeight > 44) composerEl.classList.add('multiline');
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 220) + 'px';
}

async function openConversation(id) {
  sidebar.setActive(id);
  setTitle(sidebar.titleOf(id));
  // Still replying there: show its live view instead of reloading.
  const live = runningViewFor(id);
  if (live) {
    showView(live);
    live.chat._scrollToBottom();
    setStatus(sending ? 'Thinking…' : 'Ready');
    return;
  }
  if (view.convId === id && !view.running && view.el.childElementCount) return;
  const v = makeView(id);
  showView(v);
  const cached = convCache.get(id);
  const fresh = cached && cached.updated === sidebar.updatedOf(id);
  if (!fresh) setStatus('Loading…');
  try {
    const conv = fresh ? cached.conv : await invoke('get_conversation_cmd', { id });
    if (!fresh) convCache.set(id, { conv, updated: sidebar.updatedOf(id) });
    v.parentId = conv.current_node;
    v.chat.loadConversation(conv.messages);
    if (v === view) {
      setTitle(conv.title);
      setStatus(sending ? 'Thinking…' : 'Ready');
    }
  } catch (e) {
    v.chat.clear();
    v.chat.addNotice(`Could not open this chat: ${e}`);
    if (v === view) setStatus('Error');
    handleAuthError(e);
  }
}

async function deleteConversation(id) {
  try {
    await invoke('delete_conversation_cmd', { id });
    convCache.delete(id);
    if (id === currentConversationId) startNewChat();
    await sidebar.refresh();
  } catch (e) {
    setStatus('Delete failed');
    handleAuthError(e);
  }
}

function startNewChat() {
  if (!view.running && !view.convId && view.el.childElementCount === 0) { chatInput.focus(); return; }
  showView(makeView(null));
  chat.clear();
  sidebar.setActive(null);
  setTitle(null);
  setStatus(sending ? 'Thinking…' : 'Ready');
  chatInput.focus();
}

async function afterTurn(v) {
  await sidebar.refresh();
  if (v !== view) return;
  sidebar.setActive(v.convId);
  setTitle(sidebar.titleOf(v.convId));
}

// Live events for one send: text/steps go to that send's own view; the conversation id is
// learned early so a new chat shows up (with a spinner) in the sidebar while it replies.
function liveHandler(v, streamId, wrap) {
  return (e) => {
    if (e.payload.stream_id !== streamId) return;
    if (e.payload.type === 'conversation') {
      const first = !v.convId;
      v.convId = e.payload.conversation_id;
      if (v === view) currentConversationId = v.convId;
      sidebar.setBusy(v.convId, true);
      if (first) sidebar.refresh().then(() => { if (v === view) sidebar.setActive(v.convId); });
      return;
    }
    wrap(() => v.chat.onLive(e.payload));
  };
}

// Where a finished send leaves its conversation: the server's ids for the next message.
function learnThread(v, events) {
  const done = (events || []).filter((e) => e.type === 'done').pop();
  if (done && done.conversation_id) v.convId = done.conversation_id;
  if (done && done.message_id) v.parentId = done.message_id;
}

async function sendText(text, files = [], display = [], systemHints = []) {
  text = text.trim();
  if ((!text && !files.length) || sending) return;
  if (goalMode && text) return startGoal(text);

  // Everything below uses this send's own view, so switching chats mid-reply is safe.
  const v = view;
  const vchat = v.chat;
  v.running = true;
  if (v.convId) sidebar.setBusy(v.convId, true);
  setSending(true);
  vchat.addUserMessage(text, display);
  vchat.startPending();
  const streamId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  v.streamId = streamId;
  updateSendState();
  let unlisten = null;
  try {
    unlisten = await window.__TAURI__.event.listen('chat-delta', liveHandler(v, streamId, (fn) => fn()));
    const response = await invoke('send_message', Object.assign(
      { text, attachments: files, streamId, systemHints, conversationId: v.convId, parentMessageId: v.parentId },
      picker.request()));
    // full_text is joined per message in Rust (or is the server's stored copy).
    if (response.stored) vchat.useStored(response.stored);
    await vchat.completePending(response.full_text || '');
    learnThread(v, response.events);
    finishRun(v);
    await afterTurn(v);
  } catch (e) {
    vchat.failPending(`Something went wrong: ${e}`);
    finishRun(v);
    handleAuthError(e);
  } finally {
    if (unlisten) unlisten();
    setSending(false);
  }
}

async function startGoal(task) {
  setGoalMode(false);
  const v = view;
  const vchat = v.chat;
  v.running = true;
  if (v.convId) sidebar.setBusy(v.convId, true);
  setSending(true);
  vchat.addUserMessage(task);
  const notice = vchat.addNotice('Goal mode · round 1');
  vchat.startPending();
  const streamId = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  v.streamId = streamId;
  updateSendState();
  // Round boundaries close the previous reply asynchronously; queue every live event
  // behind them so the next round's text never lands in the previous reply.
  let queue = Promise.resolve();
  const later = (fn) => { queue = queue.then(fn, fn); };
  const unlisten = [];
  try {
    unlisten.push(await window.__TAURI__.event.listen('chat-delta', liveHandler(v, streamId, later)));
    unlisten.push(await window.__TAURI__.event.listen('goal-round', (e) => {
      if (e.payload.stream_id !== streamId || e.payload.round < 2) return;
      later(async () => {
        await vchat.completePending(stripGoalMarker(vchat.currentText()));
        notice.textContent = `Goal mode · round ${e.payload.round}`;
        vchat.addNotice(`Round ${e.payload.round} · asked ChatGPT to continue`);
        vchat.startPending();
      });
    }));
    const result = await invoke('start_goal', Object.assign(
      { task, streamId, conversationId: v.convId, parentMessageId: v.parentId }, picker.request()));
    await queue;
    notice.textContent = `${result.complete ? 'Goal complete' : 'Goal stopped'} · ${result.iterations} ${result.iterations === 1 ? 'round' : 'rounds'}`;
    const last = result.responses[result.responses.length - 1];
    await vchat.completePending(last ? stripGoalMarker(last.full_text) : '');
    if (last) learnThread(v, last.events);
    finishRun(v);
    await afterTurn(v);
  } catch (e) {
    await queue;
    notice.textContent = 'Goal failed';
    vchat.failPending(`Goal error: ${e}`);
    finishRun(v);
    handleAuthError(e);
  } finally {
    unlisten.forEach((u) => u());
    setSending(false);
  }
}

function stripGoalMarker(text) {
  return text.replace('[GOAL_COMPLETE]', '').trim();
}

function submitComposer() {
  let text = chatInput.value;
  // Typing during a call is allowed (as on the web) but sending isn't supported yet.
  if (voiceActive) { setStatus('Sending text during a voice call isn’t supported yet'); return; }
  if (sendBtn.disabled) return;
  if (attachments.hasErrors()) {
    setStatus('Remove the files that failed to upload first');
    return;
  }
  // Goal mode runs a text-only autonomous loop; leave any files in the tray.
  const { files, display } = goalMode ? { files: [], display: [] } : attachments.take();
  // "@" picks go in front of the text the way chatgpt.com sends them (goal mode keeps them).
  const { prefix, hints } = goalMode ? { prefix: '', hints: [] } : mentions.take();
  if (prefix) text = prefix + ' ' + text.trim();
  chatInput.value = '';
  autosize();
  updateSendState();
  sendText(text, files, display, hints);
}

window.chatApp = { sendText: (text) => sendText(text), canSend: () => !sending };

// ---------- Attaching files: "+" menu, paste, drag and drop ----------

function closePlusMenu() { plusMenu.hidden = true; }

// The "+" menu lists the same tools and apps as "@" (as on chatgpt.com); picking one adds the
// same chip, so it is sent the same way.
function renderPlusTools() {
  const box = $('plus-tools');
  const items = mentions.items.filter((i) => i.initial);
  box.innerHTML = items.length ? '<div class="menu-sep"></div>' + items.map((i, n) =>
    '<button type="button" class="menu-item" data-tool="' + n + '">' +
    '<span class="menu-item-logo">' + (mentionLogo(i, 18) || icon(i.is_plugin ? 'package' : 'wrench', 16)) + '</span>' +
    '<span class="menu-item-name">' + escText(i.label) + '</span>' +
    (i.description && i.description !== i.label ? '<span class="menu-item-desc">' + escText(i.description) + '</span>' : '') +
    '</button>').join('') : '';
  box.onclick = (e) => {
    const row = e.target.closest('[data-tool]');
    if (!row) return;
    closePlusMenu();
    mentions.pick(items[Number(row.getAttribute('data-tool'))]);
  };
}

// ---------- Voice mode ----------

// Which voice ChatGPT speaks with (chatgpt.com keeps this in Settings › Voice). Defaults to the
// voice chosen in the account; a pick here is remembered on this computer.
const voices = { list: [], selected: null, open: false };
function voicePref() {
  try { return localStorage.getItem('voice.name'); } catch (e) { return null; }
}
function currentVoice() {
  const pick = voicePref();
  if (pick && voices.list.some((v) => v.voice === pick)) return pick;
  return voices.selected || 'juniper';
}
function renderPlusVoice() {
  const box = $('plus-voice');
  if (!voices.list.length) { box.innerHTML = ''; return; }
  const now = currentVoice();
  const nowName = (voices.list.find((v) => v.voice === now) || { name: now }).name;
  let html = '<div class="menu-sep"></div>' +
    '<button type="button" class="menu-item" data-voice-toggle><span data-icon="audio-lines"></span>' +
    '<span class="menu-item-name">Voice</span><span class="menu-item-desc">' + escText(nowName) + '</span>' +
    '<span class="menu-item-end">' + icon(voices.open ? 'chevron-down' : 'chevron-right', 14) + '</span></button>';
  if (voices.open) {
    html += voices.list.map((v) =>
      '<button type="button" class="menu-item menu-sub" data-voice="' + escText(v.voice) + '">' +
      '<span class="menu-item-logo">' + (v.voice === now ? icon('check', 16) : '') + '</span>' +
      '<span class="menu-item-name">' + escText(v.name) + '</span>' +
      (v.description ? '<span class="menu-item-desc">' + escText(v.description) + '</span>' : '') +
      '</button>').join('');
  }
  box.innerHTML = html;
  hydrateIcons(box);
}
$('plus-voice').addEventListener('click', (e) => {
  e.stopPropagation();
  if (e.target.closest('[data-voice-toggle]')) { voices.open = !voices.open; renderPlusVoice(); return; }
  const row = e.target.closest('[data-voice]');
  if (!row) return;
  try { localStorage.setItem('voice.name', row.getAttribute('data-voice')); } catch (err) {}
  voices.open = false;
  renderPlusVoice();
  closePlusMenu();
  setStatus('Voice: ' + row.querySelector('.menu-item-name').textContent);
});
async function loadVoices() {
  try {
    const res = await window.__TAURI__.core.invoke('voices_cmd', { locale: navigator.language || 'en-US' });
    voices.list = res.voices || [];
    voices.selected = res.selected || null;
  } catch (e) { console.warn('voices', e); }
  renderPlusVoice();
}

// Like chatgpt.com: the chat page stays, the transcript appears as normal chat messages, a
// large blue orb floats above the box (pulsing with ChatGPT's voice), and the box keeps its
// "Type" field, mic toggle and blue ✕.
let voiceView = null;
const voiceUi = {
  open() {
    voiceActive = true;
    voiceView = view;
    voiceView.chat.voiceTurns = [];
    voiceOrb.hidden = false;
    voiceOrb.style.setProperty('--level', 0);
    composerEl.classList.add('voice-on');
    mainEl.classList.add('voice-on');
    chatInput.placeholder = 'Type';
    this.muted(false);
    updateSendState();
  },
  close() {
    voiceActive = false;
    voiceOrb.hidden = true;
    composerEl.classList.remove('voice-on');
    mainEl.classList.remove('voice-on');
    chatInput.placeholder = goalMode ? 'Describe the goal to work on…' : 'Ask ChatGPT';
    updateSendState();
    chatInput.focus();
  },
  status(text) {
    setStatus(text);
    voiceOrb.dataset.state = String(text).toLowerCase();
  },
  transcript(lines) {
    if (voiceView) voiceView.chat.setVoiceTurns(lines);
  },
  level(v) { voiceOrb.style.setProperty('--level', v.toFixed(3)); },
  muted(on) {
    voiceMuteBtn.innerHTML = icon(on ? 'mic-off' : 'mic', 18);
    voiceMuteBtn.classList.toggle('off', on);
    voiceMuteBtn.title = on ? 'Turn on microphone' : 'Turn off microphone';
  },
  error(message) { setStatus(message); },
};

// After hanging up, open the voice chat as saved by the server (so the next typed message
// continues it).
const voiceCall = new VoiceCall(voiceUi, {
  onEnd: async (convId, failed) => {
    if (failed) setTimeout(() => voiceUi.close(), 2500);
    else setStatus('Ready');
    if (!convId) return;
    convCache.delete(convId);
    await new Promise((r) => setTimeout(r, 1200));
    await sidebar.refresh();
    openConversation(convId);
  },
});

voiceBtn.addEventListener('click', () => {
  if (voiceCall.active) { voiceCall.end(false); return; }
  if (sending) return;
  // Like chatgpt.com: from an open chat the call continues it (the transcript is added after
  // its messages); otherwise it starts a new chat. A chat that is still replying can't be
  // continued, so that case starts a new one too.
  const continueChat = !!(view.convId && !view.running);
  if (!continueChat && (view.running || view.convId || view.el.childElementCount)) startNewChat();
  setStatus('Connecting…');
  voiceCall.start({
    voice: currentVoice(),
    locale: navigator.language || 'en-US',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    conversationId: continueChat ? view.convId : null,
    parentMessageId: continueChat ? view.parentId : null,
  });
});
voiceMuteBtn.addEventListener('click', () => voiceCall.toggleMute());

function loadComposerMenus() {
  mentions.load().then(renderPlusTools);
  picker.load();
  loadVoices();
}

plusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  plusMenu.hidden = !plusMenu.hidden;
});
document.addEventListener('click', (e) => {
  if (!plusMenu.hidden && !e.target.closest('.plus-wrap')) closePlusMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlusMenu(); });

$('attach-btn').addEventListener('click', () => { closePlusMenu(); fileInput.click(); });
$('goal-menu-btn').addEventListener('click', () => { closePlusMenu(); setGoalMode(true); chatInput.focus(); });

fileInput.addEventListener('change', () => {
  for (const file of fileInput.files) attachments.addFile(file);
  fileInput.value = '';
  chatInput.focus();
});

chatInput.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData ? e.clipboardData.files : [])];
  if (!files.length) return;
  if (!e.clipboardData.getData('text/plain')) e.preventDefault();
  files.forEach((f) => attachments.addFile(f));
});

function showDrop(visible) { dropOverlay.hidden = !visible; }

const tauriWebview = window.__TAURI__.webview;
if (tauriWebview && tauriWebview.getCurrentWebview) {
  // Tauri intercepts OS file drops and hands us paths; Rust reads the files itself.
  tauriWebview.getCurrentWebview().onDragDropEvent((event) => {
    const p = event.payload;
    if (p.type === 'enter' || p.type === 'over') showDrop(true);
    else if (p.type === 'leave') showDrop(false);
    else if (p.type === 'drop') {
      showDrop(false);
      (p.paths || []).forEach((path) => attachments.addPath(path));
      chatInput.focus();
    }
  });
} else {
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { depth++; showDrop(true); } });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) { depth = 0; showDrop(false); } });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    showDrop(false);
    [...e.dataTransfer.files].forEach((f) => attachments.addFile(f));
  });
}

chatInput.addEventListener('keydown', (e) => {
  if (mentions.onKeyDown(e)) return;
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitComposer();
  }
});
chatInput.addEventListener('input', () => { autosize(); updateSendState(); mentions.onInput(); });
chatInput.addEventListener('click', () => mentions.onInput());
sendBtn.addEventListener('click', () => { if (view.running) stopCurrent(); else submitComposer(); });
$('goal-chip-close').addEventListener('click', () => { setGoalMode(false); chatInput.focus(); });
$('goal-nav-btn').addEventListener('click', () => { setGoalMode(true); chatInput.focus(); });

$('new-chat-btn').addEventListener('click', startNewChat);
$('topbar-new-btn').addEventListener('click', startNewChat);
$('collapse-btn').addEventListener('click', () => appEl.classList.add('sb-collapsed'));
$('open-sidebar-btn').addEventListener('click', () => appEl.classList.remove('sb-collapsed'));

$('search-btn').addEventListener('click', () => {
  searchBox.hidden = !searchBox.hidden;
  if (searchBox.hidden) { searchInput.value = ''; sidebar.setFilter(''); } else searchInput.focus();
});
searchInput.addEventListener('input', () => sidebar.setFilter(searchInput.value));
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { searchInput.value = ''; sidebar.setFilter(''); searchBox.hidden = true; }
});

$('logout-btn').addEventListener('click', async () => {
  try { await invoke('clear_token'); } catch (e) { console.error(e); }
  showLogin('');
});

$('token-save-btn').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return;
  try {
    await invoke('save_token', { token });
    loadComposerMenus();
    loginOverlay.hidden = true;
    tokenInput.value = '';
    loginError.textContent = '';
    await sidebar.refresh();
  } catch (e) {
    loginError.textContent = String(e);
  }
});

async function init() {
  chat.clear();
  setTitle(null);
  updateSendState();
  const token = await invoke('get_token');
  if (!token) showLogin('');
  else {
    loadComposerMenus();
    await sidebar.refresh();
  }
  chatInput.focus();
}

init();
