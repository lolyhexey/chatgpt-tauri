import { Sidebar } from './sidebar.js';
import { Chat } from './chat.js';
import { renderToolCall, renderToolResult, renderAgentProgress } from './tools-ui.js';

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
let isFirstMessage = true;

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
      isFirstMessage = false;
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
  isFirstMessage = true;
  chat.clear();
  invoke('new_conversation');
  sidebar.setActive(null);
  statusText.textContent = 'New chat';
}

function processResponse(response) {
  // Show tool calls inline
  for (let i = 0; i < response.tool_calls.length; i++) {
    const tc = response.tool_calls[i];
    const tr = response.tool_results[i];
    messagesEl.appendChild(renderToolCall(tc.name, tc.args));
    if (tr) {
      messagesEl.appendChild(renderToolResult(tr.result, tr.error));
    }
  }

  // Collect full assistant text from events
  let fullText = '';
  for (const ev of response.events) {
    if (ev.type === 'text') fullText += ev.delta;
    if (ev.type === 'done') {
      currentConversationId = ev.conversation_id;
      sidebar.setActive(ev.conversation_id);
    }
  }

  return fullText;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || sending) return;
  sending = true;
  sendBtn.disabled = true;
  goalBtn.disabled = true;
  chatInput.value = '';
  chatInput.style.height = 'auto';

  chat.addUserMessage(text);
  chat.startAssistantMessage();
  statusText.textContent = 'Thinking...';

  try {
    const response = await invoke('send_message', { text, isFirst: isFirstMessage });
    isFirstMessage = false;

    // Process tool calls
    for (let i = 0; i < response.tool_calls.length; i++) {
      const tc = response.tool_calls[i];
      const tr = response.tool_results[i];
      messagesEl.appendChild(renderToolCall(tc.name, tc.args));
      if (tr) messagesEl.appendChild(renderToolResult(tr.result, tr.error));
    }

    // Show final response
    const fullText = response.full_text || response.events
      .filter(e => e.type === 'text')
      .map(e => e.delta)
      .join('');

    if (fullText) {
      chat.appendDelta(fullText);
    }
    chat.finishMessage();

    // Update conversation from done event
    const doneEv = response.events.find(e => e.type === 'done');
    if (doneEv) {
      currentConversationId = doneEv.conversation_id;
      sidebar.setActive(doneEv.conversation_id);
    }

    statusText.textContent = response.tool_calls.length > 0
      ? `Ready (${response.tool_calls.length} tools used)`
      : 'Ready';
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
  goalBtn.disabled = false;
  chatInput.focus();
}

async function startGoal() {
  const task = prompt('Enter your goal:');
  if (!task?.trim()) return;

  sending = true;
  sendBtn.disabled = true;
  goalBtn.disabled = true;

  chat.addUserMessage(`[Goal] ${task}`);

  const banner = document.createElement('div');
  banner.className = 'goal-banner';
  banner.textContent = '🎯 Goal Mode — working autonomously...';
  messagesEl.appendChild(banner);

  statusText.textContent = 'Goal: working...';

  try {
    const result = await invoke('start_goal', { task });

    banner.textContent = result.complete
      ? `✅ Goal complete! (${result.iterations} iterations, ${result.total_calls} API calls)`
      : `⏹ Goal stopped (${result.iterations} iterations, ${result.total_calls} API calls)`;

    // Show final response
    if (result.responses.length > 0) {
      const last = result.responses[result.responses.length - 1];

      for (let i = 0; i < last.tool_calls.length; i++) {
        messagesEl.appendChild(renderToolCall(last.tool_calls[i].name, last.tool_calls[i].args));
        if (last.tool_results[i]) messagesEl.appendChild(renderToolResult(last.tool_results[i].result, last.tool_results[i].error));
      }

      chat.startAssistantMessage();
      const text = last.full_text.replace('[GOAL_COMPLETE]', '').trim();
      if (text) chat.appendDelta(text);
      chat.finishMessage();
    }

    statusText.textContent = result.complete ? 'Goal complete!' : 'Goal stopped';
    sidebar.refresh();
  } catch (e) {
    banner.textContent = `❌ Goal failed: ${e}`;
    chat.addErrorMessage(`Goal error: ${e}`);
    statusText.textContent = 'Error';
  }
  sending = false;
  sendBtn.disabled = false;
  goalBtn.disabled = false;
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
goalBtn.addEventListener('click', startGoal);

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
});

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
