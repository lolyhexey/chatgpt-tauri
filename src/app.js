import { Sidebar } from './sidebar.js';
import { Chat } from './chat.js';

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
const goalBtn = document.getElementById('goal-btn');

let currentConversationId = null;
let sending = false;

const chat = new Chat(messagesEl);

const sidebar = new Sidebar(chatList, {
  onSelect: async (id) => {
    currentConversationId = id;
    sidebar.setActive(id);
    statusText.textContent = 'Loading...';
    try {
      const conv = await invoke('get_conversation_cmd', { id });
      await invoke('set_conversation', { id: conv.id, parentId: conv.current_node });
      chat.loadConversation(conv.messages);
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
  chat.clear();
  invoke('new_conversation');
  sidebar.setActive(null);
  statusText.textContent = 'New chat';
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || sending) return;
  sending = true;
  sendBtn.disabled = true;
  chatInput.value = '';
  chatInput.style.height = 'auto';

  chat.addUserMessage(text);
  chat.startAssistantMessage();
  statusText.textContent = 'Thinking...';

  try {
    const events = await invoke('send_message', { text });
    for (const ev of events) {
      if (ev.type === 'text') {
        chat.appendDelta(ev.delta);
      } else if (ev.type === 'thinking') {
        chat.addThinkingBlock(ev.delta);
      } else if (ev.type === 'done') {
        currentConversationId = ev.conversation_id;
        sidebar.setActive(ev.conversation_id);
      }
    }
    chat.finishMessage();
    statusText.textContent = 'Ready';
    sidebar.refresh();
  } catch (e) {
    chat.finishMessage();
    chat.addErrorMessage(`Error: ${e}`);
    statusText.textContent = 'Error';
    if (String(e).includes('401') || String(e).includes('expired')) {
      loginOverlay.classList.remove('hidden');
    }
  }
  sending = false;
  sendBtn.disabled = false;
  chatInput.focus();
}

// Token save
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
  if (e.key === 'Escape') {
    // TODO: cancel stream
  }
});

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
