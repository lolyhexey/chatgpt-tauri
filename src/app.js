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
  exitProjectView();
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
  onMoveToProject: moveToProjectPicker,
});

const projects = new Projects($('project-list'), { onSelect: openProject });
let projectsCollapsed = false;
const projectOverlay = $('project-overlay');
const projectNameInput = $('project-name-input');
const projectError = $('project-error');
const pvTitle = $('pv-title');
const pvChats = $('pv-chats');
let currentProjectId = null;
let currentProjectName = '';
const psOverlay = $('project-settings-overlay');
const psName = $('ps-name');
const psInstructions = $('ps-instructions');
const psError = $('ps-error');
const psMemory = $('ps-memory');
const pdOverlay = $('project-delete-overlay');
let psEditId = null;

$('projects-toggle').addEventListener('click', () => {
  projectsCollapsed = !projectsCollapsed;
  appEl.classList.toggle('projects-collapsed', projectsCollapsed);
  projects.setCollapsed(projectsCollapsed);
});
$('project-add-btn').addEventListener('click', openCreateProject);
$('project-cancel-btn').addEventListener('click', closeCreateProject);
$('project-create-btn').addEventListener('click', submitCreateProject);
projectNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitCreateProject(); }
  else if (e.key === 'Escape') closeCreateProject();
});
projectOverlay.addEventListener('click', (e) => { if (e.target === projectOverlay) closeCreateProject(); });

$('pv-settings-btn').addEventListener('click', () => openProjectSettings(currentProjectId));
$('ps-cancel-btn').addEventListener('click', closeProjectSettings);
$('ps-save-btn').addEventListener('click', saveProjectSettings);
$('ps-delete-btn').addEventListener('click', openDeleteConfirm);
$('pd-cancel-btn').addEventListener('click', closeDeleteConfirm);
$('pd-confirm-btn').addEventListener('click', confirmDeleteProject);
psName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); saveProjectSettings(); }
  else if (e.key === 'Escape') closeProjectSettings();
});
psOverlay.addEventListener('click', (e) => { if (e.target === psOverlay) closeProjectSettings(); });
pdOverlay.addEventListener('click', (e) => { if (e.target === pdOverlay) closeDeleteConfirm(); });

// Leave the project landing (if any) and return to the normal chat area.
function exitProjectView() {
  if (!mainEl.classList.contains('project-open')) return;
  mainEl.classList.remove('project-open');
  currentProjectId = null;
  projects.setActive(null);
  chatInput.placeholder = 'Ask ChatGPT';
}

// Show a project's landing view (header + its chats), like chatgpt.com.
async function openProject(id, name) {
  currentProjectId = id;
  currentProjectName = name || projects.nameOf(id) || 'Project';
  projects.setActive(id);
  mainEl.classList.add('project-open');
  setTitle(currentProjectName);
  pvTitle.textContent = currentProjectName;
  chatInput.placeholder = `New chat in ${currentProjectName}`;
  pvChats.innerHTML = '';
  const loading = document.createElement('div');
  loading.className = 'sb-note';
  loading.textContent = 'Loading…';
  pvChats.appendChild(loading);
  try {
    const chats = await invoke('list_project_conversations_cmd', { id });
    if (currentProjectId === id) renderProjectChats(chats);
  } catch (e) {
    if (currentProjectId === id) {
      pvChats.innerHTML = '';
      const err = document.createElement('div');
      err.className = 'sb-note';
      err.textContent = 'Could not load chats';
      pvChats.appendChild(err);
    }
    handleAuthError(e);
  }
}

function renderProjectChats(chats) {
  pvChats.innerHTML = '';
  if (!chats || chats.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pv-empty';
    const t = document.createElement('div');
    t.className = 'pv-empty-title';
    t.textContent = 'No chats yet';
    const s = document.createElement('div');
    s.className = 'pv-empty-sub';
    s.textContent = `Chats in ${currentProjectName} will live here`;
    empty.appendChild(t);
    empty.appendChild(s);
    pvChats.appendChild(empty);
    return;
  }
  for (const c of chats) {
    const row = document.createElement('div');
    row.className = 'pv-chat';
    row.title = c.title || 'Untitled';
    const title = document.createElement('span');
    title.className = 'pv-chat-title';
    title.textContent = c.title || 'Untitled';
    row.appendChild(title);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'pv-chat-remove';
    rm.title = 'Remove from project';
    rm.innerHTML = icon('x', 16);
    rm.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await invoke('move_chat_cmd', { id: c.id, gizmoId: null });
        if (currentProjectId) openProject(currentProjectId, currentProjectName);
        sidebar.refresh();
      } catch (err) { setStatus('Could not remove chat'); handleAuthError(err); }
    });
    row.appendChild(rm);
    row.addEventListener('click', () => openConversation(c.id));
    pvChats.appendChild(row);
  }
}

function openCreateProject() {
  projectNameInput.value = '';
  projectError.textContent = '';
  projectOverlay.hidden = false;
  projectNameInput.focus();
}
function closeCreateProject() {
  projectOverlay.hidden = true;
}
async function submitCreateProject() {
  const name = projectNameInput.value.trim();
  if (!name) { projectError.textContent = 'Enter a project name.'; return; }
  try {
    const p = await invoke('create_project_cmd', { name, instructions: '' });
    closeCreateProject();
    await projects.refresh();
    if (p && p.id) openProject(p.id);
  } catch (e) {
    projectError.textContent = String(e);
    handleAuthError(e);
  }
}

async function openProjectSettings(id) {
  if (!id) return;
  psEditId = id;
  psError.textContent = '';
  // Pre-fill from the cached project (the sidebar list already carries name, instructions and
  // memory scope) so saving before the detail GET returns can't wipe real values.
  const cached = projects.items.find((i) => i.id === id) || {};
  psName.value = cached.name || projects.nameOf(id) || '';
  psInstructions.value = cached.instructions || '';
  psMemory.value = cached.memory_scope === 'project_v2' ? 'project_v2' : 'global';
  psOverlay.hidden = false;
  psName.focus();
  try {
    const p = await invoke('get_project_cmd', { id });
    if (psEditId === id) {
      psName.value = p.name || '';
      psInstructions.value = p.instructions || '';
      psMemory.value = p.memory_scope === 'project_v2' ? 'project_v2' : 'global';
    }
  } catch (e) { handleAuthError(e); }
}
function closeProjectSettings() { psOverlay.hidden = true; }

async function saveProjectSettings() {
  const id = psEditId;
  const name = psName.value.trim();
  if (!name) { psError.textContent = 'Enter a project name.'; return; }
  try {
    const p = await invoke('update_project_cmd', { id, name, instructions: psInstructions.value, memoryScope: psMemory.value });
    closeProjectSettings();
    await projects.refresh();
    if (currentProjectId === id) {
      currentProjectName = p.name || name;
      projects.setActive(id);
      pvTitle.textContent = currentProjectName;
      setTitle(currentProjectName);
      chatInput.placeholder = `New chat in ${currentProjectName}`;
    }
  } catch (e) { psError.textContent = String(e); handleAuthError(e); }
}

function openDeleteConfirm() { pdOverlay.hidden = false; }
function closeDeleteConfirm() { pdOverlay.hidden = true; }
async function confirmDeleteProject() {
  const id = psEditId;
  try {
    await invoke('delete_project_cmd', { id });
    closeDeleteConfirm();
    closeProjectSettings();
    await projects.refresh();
    if (currentProjectId === id) startNewChat(); // leaves the project view
  } catch (e) {
    closeDeleteConfirm();
    psError.textContent = String(e);
    handleAuthError(e);
  }
}

function closeProjectPicker() {
  const m = document.getElementById('project-picker');
  if (m) m.remove();
}
// A small popover listing projects, to move a chat into one (from the chat's folder button).
function moveToProjectPicker(chatId, anchor) {
  closeProjectPicker();
  if (!projects.items.length) { setStatus('Create a project first to move chats into it'); return; }
  const menu = document.createElement('div');
  menu.id = 'project-picker';
  menu.className = 'project-picker';
  for (const p of projects.items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'project-picker-item';
    b.innerHTML = icon('folder', 16);
    const span = document.createElement('span');
    span.textContent = p.name;
    b.appendChild(span);
    b.addEventListener('click', async () => {
      closeProjectPicker();
      try {
        await invoke('move_chat_cmd', { id: chatId, gizmoId: p.id });
        await projects.refresh();
        await sidebar.refresh();
        if (currentProjectId === p.id) openProject(p.id, p.name);
      } catch (e) { setStatus('Could not move chat'); handleAuthError(e); }
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) {
    // not enough room below: flip above the anchor, then clamp to the viewport.
    top = r.top - mh - 4;
    if (top < 8) top = Math.max(8, window.innerHeight - mh - 8);
  }
  menu.style.top = top + 'px';
  menu.style.left = Math.min(r.left, window.innerWidth - menu.offsetWidth - 8) + 'px';
  setTimeout(() => {
    const onDoc = (e) => {
      if (!menu.contains(e.target)) { closeProjectPicker(); document.removeEventListener('click', onDoc, true); }
    };
    document.addEventListener('click', onDoc, true);
  }, 0);
}

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
  const stoppable = !!(view && (view.running || view.remote));
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
  // A reply written on another device stops the same way (stop_conversation by chat id); the
  // watcher then sees it complete.
  if (v.remote && !v.running && !v.stopping) {
    v.stopping = true;
    updateSendState();
    setStatus('Stopping…');
    try { await invoke('stop_generation', { streamId: '', conversationId: v.convId }); } catch (e) { console.warn('stop failed', e); }
    return;
  }
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
  exitProjectView(); // leaving the project landing, even on the already-open fast path below
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
  // Already open (or still loading): just make sure it's current.
  if (view.convId === id && !view.running && view.el.childElementCount) { refreshOpenChat(view); return; }
  const v = makeView(id);
  showView(v);
  // A copy from earlier shows at once; the server is asked anyway, since the chat may have
  // been continued elsewhere (e.g. on chatgpt.com).
  const cached = convCache.get(id);
  if (cached) {
    renderConv(v, cached);
    setStatus(sending ? 'Thinking…' : 'Ready');
    refreshOpenChat(v);
    return;
  }
  setStatus('Loading…');
  v.chat.showLoading();
  try {
    const conv = await invoke('get_conversation_cmd', { id });
    convCache.set(id, conv);
    renderConv(v, conv);
    if (v === view) setStatus(sending ? 'Thinking…' : 'Ready');
    watchRemoteReply(v);
  } catch (e) {
    v.chat.clear();
    v.chat.addNotice(`Could not open this chat: ${e}`);
    if (v === view) setStatus('Error');
    handleAuthError(e);
  }
}

// Fetch an open chat again and redraw it only if it moved on (new messages from another client,
// e.g. chatgpt.com). Skipped while a reply or voice call runs there, or if this app changed the
// chat while the request was out.
async function refreshOpenChat(v) {
  if (!v.convId || v.running || v.remote || v.refreshing || v.el.querySelector('.thread-loading')) return;
  v.refreshing = true;
  const before = v.parentId;
  try {
    const conv = await invoke('get_conversation_cmd', { id: v.convId });
    if (v.running || v.remote || v.parentId !== before || (voiceActive && v === view)) return;
    convCache.set(v.convId, conv);
    if (convSig(conv) !== v.sig && !adoptLiveTurns(v, conv)) renderConv(v, conv, { keepScroll: true });
  } catch (e) {
    console.warn('chat refresh failed', e);
  } finally {
    v.refreshing = false;
  }
  watchRemoteReply(v);
}

// What a chat looks like, cheaply: changes when a message is added or a saved reply grows
// (a reply in progress elsewhere keeps its id while its text gets longer).
function convSig(conv) {
  const msgs = conv.messages || [];
  const last = msgs[msgs.length - 1];
  return [conv.current_node, msgs.length, last ? last.content.length : 0, last ? (last.generated || []).length : 0].join(':');
}

// The saved part of a reply still being written can stop mid-tag (seen: a bare "<badge"
// before the finished "<badge>…</badge>"); hide that unfinished tail until it completes.
function partialConv(conv) {
  const msgs = conv.messages.slice();
  const last = msgs[msgs.length - 1];
  if (last && last.role !== 'user') msgs[msgs.length - 1] = { ...last, content: last.content.replace(/<\/?[a-z][^>]*$/i, '') };
  return { ...conv, messages: msgs };
}

// Turns this app built while chatting (your messages, streamed replies) carry no fingerprint,
// so a refresh used to see them all as changed and redraw the whole chat. When the server's
// latest message is the one this view already ends at and the turns line up, they are labelled
// with the server's fingerprints instead and nothing is redrawn.
function adoptLiveTurns(v, conv) {
  if (!conv.current_node || conv.current_node !== v.parentId) return false;
  const list = mergeReplies(conv.messages);
  const turns = [...v.el.children];
  if (turns.length !== list.length || turns.some((t) => !t.classList.contains('turn'))) return false;
  const sigs = list.map(turnSig);
  if (turns.some((t, i) => (t.classList.contains('turn-user') !== (list[i].role === 'user')) || (t.dataset.sig && t.dataset.sig !== sigs[i]))) return false;
  turns.forEach((t, i) => { t.dataset.sig = sigs[i]; });
  v.sig = convSig(conv);
  return true;
}

function renderConv(v, conv, opts) {
  v.parentId = conv.current_node;
  v.sig = convSig(conv);
  v.chat.loadConversation(conv.messages, opts);
  if (v === view) setTitle(conv.title);
}

// A reply being written somewhere else (e.g. chatgpt.com) can't be streamed here: the server
// resumes a stream only for the client holding its token (otherwise 404
// "tokenless_resume_unavailable"). What the web does then, measured: check stream_status and
// fetch the chat about every 5.6 s, showing the saved part as it grows, until it's complete.
const REMOTE_POLL_MS = 5600;
async function watchRemoteReply(v) {
  if (!v.convId || v.running || v.remote || v !== view || voiceActive) return;
  let status;
  try { status = await invoke('stream_status_cmd', { id: v.convId }); } catch (e) { return; }
  if (status !== 'IS_STREAMING' || v.running || v.remote || v !== view || voiceActive) return;
  v.remote = true;
  v.chat.showRemoteBusy();
  sidebar.setBusy(v.convId, true);
  updateSendState();
  setStatus('Replying on another device…');
  try {
    // At most ~20 minutes, and only while this chat is the one on screen.
    for (let i = 0; i < 215; i++) {
      await new Promise((r) => setTimeout(r, REMOTE_POLL_MS));
      if (v !== view || v.running || !v.remote) break;
      status = await invoke('stream_status_cmd', { id: v.convId }).catch(() => 'IS_STREAMING');
      const conv = await invoke('get_conversation_cmd', { id: v.convId });
      if (v !== view || v.running) break;
      convCache.set(v.convId, conv);
      if (convSig(conv) !== v.sig) {
        renderConv(v, status === 'IS_STREAMING' ? partialConv(conv) : conv, { keepScroll: true });
        v.sig = convSig(conv);
        if (status === 'IS_STREAMING') v.chat.showRemoteBusy();
      }
      if (status !== 'IS_STREAMING') break;
    }
    // The chat may have got its title on the other device meanwhile.
    if (v.convId) sidebar.refresh().then(() => sidebar.setActive(view.convId));
  } catch (e) {
    console.warn('watching the reply failed', e);
  } finally {
    v.remote = false;
    v.stopping = false;
    v.chat.hideRemoteBusy();
    sidebar.setBusy(v.convId, false);
    if (v === view) {
      updateSendState();
      setStatus(sending ? 'Thinking…' : 'Ready');
    }
  }
}

// Back from the browser (or another window): pick up chats continued there.
let lastFocusRefresh = 0;
window.addEventListener('focus', () => {
  if (Date.now() - lastFocusRefresh < 3000) return;
  lastFocusRefresh = Date.now();
  sidebar.refresh().then(() => sidebar.setActive(view.convId));
  refreshOpenChat(view);
});

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
  const wasProject = mainEl.classList.contains('project-open');
  exitProjectView();
  if (!view.running && !view.convId && view.el.childElementCount === 0) {
    if (wasProject) { setTitle(null); setStatus(sending ? 'Thinking…' : 'Ready'); }
    chatInput.focus();
    return;
  }
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
  // Goal mode isn't project-scoped yet, but it must still leave the project landing so its
  // reply is visible (not hidden behind the project view).
  if (goalMode && text) { exitProjectView(); return startGoal(text); }

  // Sending from a project landing starts a new chat inside that project (carries gizmo_id).
  if (mainEl.classList.contains('project-open')) {
    const gid = currentProjectId;
    const nv = makeView(null);
    nv.gizmoId = gid;
    showView(nv);
  }

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
      { text, attachments: files, streamId, systemHints, conversationId: v.convId, parentMessageId: v.parentId, gizmoId: v.gizmoId },
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
    // After each round a separate check (a temporary chat) decides: met, not met, impossible.
    // Its reason shows on the next round's notice; the final notice covers the other outcomes.
    let checkReason = '';
    unlisten.push(await window.__TAURI__.event.listen('goal-check', (e) => {
      if (e.payload.stream_id !== streamId) return;
      const v = e.payload.verdict || {};
      later(() => { checkReason = v.verdict === 'not_met' ? (v.reason || '') : ''; });
    }));
    unlisten.push(await window.__TAURI__.event.listen('goal-round', (e) => {
      if (e.payload.stream_id !== streamId || e.payload.round < 2) return;
      later(async () => {
        await vchat.completePending(stripGoalMarker(vchat.currentText()));
        notice.textContent = `Goal mode · round ${e.payload.round}`;
        vchat.addNotice(`Round ${e.payload.round} · not done yet${checkReason ? ' — ' + checkReason : ''} · asked ChatGPT to continue`);
        vchat.startPending();
      });
    }));
    const result = await invoke('start_goal', Object.assign(
      { task, streamId, conversationId: v.convId, parentMessageId: v.parentId }, picker.request()));
    await queue;
    notice.textContent = goalOutcome(result);
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

// Why the goal run ended, from the last check: met, impossible, the check failed, the round
// limit, or Stop.
function goalOutcome(result) {
  const n = result.iterations;
  const rounds = `${n} ${n === 1 ? 'round' : 'rounds'}`;
  const v = result.verdict;
  const why = v && v.reason ? ' — ' + v.reason : '';
  if (v && v.verdict === 'met') return `Goal complete · ${rounds}${why}`;
  if (v && v.verdict === 'impossible') return `Goal stopped: can't be done · ${rounds}${why}`;
  if (v && v.verdict === 'stalled') return `Goal stopped: no tool use · ${rounds}${why}`;
  if (v && v.verdict === 'error') return `Goal stopped: the check failed · ${rounds}${why}`;
  if (v && v.verdict === 'not_met' && n >= 20) return `Goal stopped at the ${rounds} limit${why}`;
  return `Goal stopped · ${rounds}`;
}

function stripGoalMarker(text) {
  return text.replace('[GOAL_COMPLETE]', '').trim();
}

function submitComposer() {
  let text = chatInput.value;
  // Typing during a call is allowed (as on the web) but sending isn't supported yet.
  if (voiceActive) { setStatus('Sending text during a voice call isn’t supported yet'); return; }
  if (sendBtn.disabled) return;
  // The chat is still being fetched: sending now would reply to the wrong message and the
  // loaded history would then replace the new turn.
  if (view.el.querySelector('.thread-loading')) { setStatus('Wait for the chat to finish loading'); return; }
  // Like the web: no new message while a reply is still being written on another device.
  if (view.remote) { setStatus('Wait for the reply on the other device to finish, or stop it'); return; }
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
  transcript(lines, images) {
    if (voiceView) voiceView.chat.setVoiceTurns(lines, images);
  },
  level(v) { voiceOrb.style.setProperty('--level', v.toFixed(3)); },
  muted(on) {
    // chatgpt.com shows the crossed-out mic in both states; muted turns the button red.
    if (!voiceMuteBtn.dataset.icon) { voiceMuteBtn.innerHTML = icon('mic-off', 16); voiceMuteBtn.dataset.icon = '1'; }
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
  // From a project landing a call begins a fresh chat (and leaves the landing so the transcript
  // is visible), never continuing whatever chat was open before entering the project.
  if (mainEl.classList.contains('project-open')) startNewChat();
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
  }, {
    // Pictures already in this chat must not show up again as the call's new images.
    knownImageIds: continueChat ? [...view.el.querySelectorAll('[data-file-id]')].map((f) => f.getAttribute('data-file-id')) : [],
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
sendBtn.addEventListener('click', () => { if (view.running || view.remote) stopCurrent(); else submitComposer(); });
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
    projects.refresh();
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
    projects.refresh();
  }
  chatInput.focus();
}

init();
