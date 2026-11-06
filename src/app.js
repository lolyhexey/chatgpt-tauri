import { Sidebar } from './sidebar.js';

const { invoke } = window.__TAURI__.core;

const loginOverlay = document.getElementById('login-overlay');
const tokenInput = document.getElementById('token-input');
const tokenSaveBtn = document.getElementById('token-save-btn');
const statusText = document.getElementById('status-text');
const newChatBtn = document.getElementById('new-chat-btn');
const chatList = document.getElementById('chat-list');
const messagesEl = document.getElementById('messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const settingsBtn = document.getElementById('settings-btn');

let currentConversationId = null;
let sending = false;

const sidebar = new Sidebar(chatList, {
  onSelect: async (id) => {
    currentConversationId = id;
    sidebar.setActive(id);
    statusText.textContent = 'Loading...';
    try {
      const conv = await invoke('get_conversation_cmd', { id });
      await invoke('set_conversation', { id: conv.id, parentId: conv.current_node });
      renderMessages(conv.messages);
      statusText.textContent = conv.title;
    } catch (e) {
      statusText.textContent = `Error: ${e}`;
    }
  },
  onNew: () => startNewChat(),
  onDelete: async (id, title) => {
    try {
      await invoke('delete_conversation_cmd', { id });
      if (id === currentConversationId) startNewChat();
      sidebar.refresh();
    } catch (e) {
      statusText.textContent = `Delete failed: ${e}`;
    }
  },
});

function startNewChat() {
  currentConversationId = null;
  messagesEl.innerHTML = '';
  invoke('new_conversation');
  sidebar.setActive(null);
  statusText.textContent = 'New chat';
}

function renderMessages(messages) {
  messagesEl.innerHTML = '';
  for (const msg of messages) {
    const div = document.createElement('div');
    div.className = msg.role === 'user' ? 'msg-user' : 'msg-assistant';
    div.textContent = msg.content;
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, content) {
  const div = document.createElement('div');
  div.className = role === 'user' ? 'msg-user' : 'msg-assistant';
  div.textContent = content;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || sending) return;
  sending = true;
  sendBtn.disabled = true;
  chatInput.value = '';

  addMessage('user', text);
  statusText.textContent = 'Thinking...';

  try {
    const events = await invoke('send_message', { text });
    let fullText = '';
    for (const ev of events) {
      if (ev.type === 'text') fullText += ev.delta;
      if (ev.type === 'done') {
        currentConversationId = ev.conversation_id;
        sidebar.setActive(ev.conversation_id);
      }
    }
    if (fullText) addMessage('assistant', fullText);
    statusText.textContent = 'Ready';
    sidebar.refresh();
  } catch (e) {
    addMessage('assistant', `Error: ${e}`);
    statusText.textContent = 'Error';
    if (String(e).includes('401') || String(e).includes('expired')) {
      loginOverlay.classList.remove('hidden');
    }
  }
  sending = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

// Event listeners
tokenSaveBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return;
  try {
    await invoke('save_token', { token });
    loginOverlay.classList.add('hidden');
    statusText.textContent = 'Token saved';
    tokenInput.value = '';
    sidebar.refresh();
  } catch (e) {
    statusText.textContent = `Error: ${e}`;
  }
});

newChatBtn.addEventListener('click', startNewChat);

sendBtn.addEventListener('click', sendMessage);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// Auto-resize textarea
chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
});

// Init
async function init() {
  const token = await invoke('get_token');
  if (!token) {
    loginOverlay.classList.remove('hidden');
    statusText.textContent = 'No token';
  } else {
    loginOverlay.classList.add('hidden');
    statusText.textContent = 'Ready';
    sidebar.refresh();
  }
  chatInput.focus();
}

init();
