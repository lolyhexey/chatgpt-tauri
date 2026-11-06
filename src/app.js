const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const appEl = $('app');
const mainEl = $('main');
const loginOverlay = $('login-overlay');
const tokenInput = $('token-input');
const loginError = $('login-error');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');
const plusBtn = $('plus-btn');
const plusMenu = $('plus-menu');
const fileInput = $('file-input');
const dropOverlay = $('drop-overlay');
const goalChip = $('goal-chip');
const titleEl = $('chat-title');
const statusEl = $('status-text');
const searchBox = $('sb-search');
const searchInput = $('sb-search-input');

let currentConversationId = null;
let sending = false;
let isFirstMessage = true;
let goalMode = false;

hydrateIcons();

const chat = new Chat($('thread'), $('messages'), mainEl);
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

function toolPairs(response) {
  return response.tool_calls.map((call, i) => ({ call, result: response.tool_results[i] }));
}

function updateSendState() {
  const hasContent = !!chatInput.value.trim() || attachments.count() > 0;
  sendBtn.disabled = sending || attachments.busy() || !hasContent;
  sendBtn.classList.toggle('busy', sending);
  sendBtn.title = attachments.busy() ? 'Waiting for files to upload' : 'Send';
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

function autosize() {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 220) + 'px';
}

async function openConversation(id) {
  if (sending) return;
  currentConversationId = id;
  sidebar.setActive(id);
  setTitle(sidebar.titleOf(id));
  setStatus('Loading…');
  try {
    const conv = await invoke('get_conversation_cmd', { id });
    await invoke('set_conversation', { id: conv.id, parentId: conv.current_node });
    chat.loadConversation(conv.messages);
    setTitle(conv.title);
    isFirstMessage = false;
    setStatus('Ready');
  } catch (e) {
    chat.clear();
    chat.addNotice(`Could not open this chat: ${e}`);
    setStatus('Error');
    handleAuthError(e);
  }
}

async function deleteConversation(id) {
  try {
    await invoke('delete_conversation_cmd', { id });
    if (id === currentConversationId) startNewChat();
    await sidebar.refresh();
  } catch (e) {
    setStatus('Delete failed');
    handleAuthError(e);
  }
}

function startNewChat() {
  if (sending) return;
  currentConversationId = null;
  isFirstMessage = true;
  chat.clear();
  invoke('new_conversation');
  sidebar.setActive(null);
  setTitle(null);
  setStatus('Ready');
  chatInput.focus();
}

async function afterTurn() {
  await sidebar.refresh();
  sidebar.setActive(currentConversationId);
  setTitle(sidebar.titleOf(currentConversationId));
}

async function sendText(text, files = [], display = []) {
  text = text.trim();
  if ((!text && !files.length) || sending) return;
  if (goalMode && text) return startGoal(text);

  setSending(true);
  chat.addUserMessage(text, display);
  chat.startPending();
  try {
    const response = await invoke('send_message', { text, isFirst: isFirstMessage, attachments: files });
    isFirstMessage = false;
    const fullText = response.full_text ||
      response.events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
    chat.completePending(fullText, toolPairs(response));
    const done = response.events.find((e) => e.type === 'done');
    if (done && done.conversation_id) currentConversationId = done.conversation_id;
    await afterTurn();
  } catch (e) {
    chat.failPending(`Something went wrong: ${e}`);
    handleAuthError(e);
  } finally {
    setSending(false);
  }
}

async function startGoal(task) {
  setGoalMode(false);
  setSending(true);
  chat.addUserMessage(task);
  const notice = chat.addNotice('Goal mode · working autonomously…');
  chat.startPending();
  try {
    const result = await invoke('start_goal', { task });
    isFirstMessage = false;
    notice.textContent = `${result.complete ? 'Goal complete' : 'Goal stopped'} · ${result.iterations} iterations · ${result.total_calls} API calls`;
    const last = result.responses[result.responses.length - 1];
    const text = last ? last.full_text.replace('[GOAL_COMPLETE]', '').trim() : '';
    chat.completePending(text, result.responses.flatMap(toolPairs));
    await afterTurn();
  } catch (e) {
    notice.textContent = 'Goal failed';
    chat.failPending(`Goal error: ${e}`);
    handleAuthError(e);
  } finally {
    setSending(false);
  }
}

function submitComposer() {
  const text = chatInput.value;
  if (sendBtn.disabled) return;
  if (attachments.hasErrors()) {
    setStatus('Remove the files that failed to upload first');
    return;
  }
  // Goal mode runs a text-only autonomous loop; leave any files in the tray.
  const { files, display } = goalMode ? { files: [], display: [] } : attachments.take();
  chatInput.value = '';
  autosize();
  updateSendState();
  sendText(text, files, display);
}

window.chatApp = { sendText: (text) => sendText(text), canSend: () => !sending };

// ---------- Attaching files: "+" menu, paste, drag and drop ----------

function closePlusMenu() { plusMenu.hidden = true; }

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
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitComposer();
  }
});
chatInput.addEventListener('input', () => { autosize(); updateSendState(); });
sendBtn.addEventListener('click', submitComposer);
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
  else await sidebar.refresh();
  chatInput.focus();
}

init();
