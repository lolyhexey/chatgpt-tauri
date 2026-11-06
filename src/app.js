const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);

const appEl = $('app');
const mainEl = $('main');
const loginOverlay = $('login-overlay');
const tokenInput = $('token-input');
const loginError = $('login-error');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');
const goalBtn = $('goal-btn');
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
  sendBtn.disabled = sending || !chatInput.value.trim();
  sendBtn.classList.toggle('busy', sending);
}

function setSending(value) {
  sending = value;
  updateSendState();
  setStatus(value ? 'Thinking…' : 'Ready');
}

function setGoalMode(value) {
  goalMode = value;
  goalBtn.classList.toggle('active', value);
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

async function sendText(text) {
  text = text.trim();
  if (!text || sending) return;
  if (goalMode) return startGoal(text);

  setSending(true);
  chat.addUserMessage(text);
  chat.startPending();
  try {
    const response = await invoke('send_message', { text, isFirst: isFirstMessage });
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
  if (!text.trim() || sending) return;
  chatInput.value = '';
  autosize();
  updateSendState();
  sendText(text);
}

window.chatApp = { sendText, canSend: () => !sending };

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitComposer();
  }
});
chatInput.addEventListener('input', () => { autosize(); updateSendState(); });
sendBtn.addEventListener('click', submitComposer);
goalBtn.addEventListener('click', () => { setGoalMode(!goalMode); chatInput.focus(); });
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
