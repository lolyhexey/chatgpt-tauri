const { invoke } = window.__TAURI__.core;

const loginOverlay = document.getElementById('login-overlay');
const tokenInput = document.getElementById('token-input');
const tokenSaveBtn = document.getElementById('token-save-btn');
const statusText = document.getElementById('status-text');
const newChatBtn = document.getElementById('new-chat-btn');

async function init() {
  const token = await invoke('get_token');
  if (!token) {
    loginOverlay.classList.remove('hidden');
    statusText.textContent = 'No token';
  } else {
    loginOverlay.classList.add('hidden');
    statusText.textContent = 'Ready';
  }
}

tokenSaveBtn.addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) return;
  try {
    await invoke('save_token', { token });
    loginOverlay.classList.add('hidden');
    statusText.textContent = 'Token saved';
    tokenInput.value = '';
  } catch (e) {
    statusText.textContent = `Error: ${e}`;
  }
});

newChatBtn.addEventListener('click', () => {
  document.getElementById('messages').innerHTML = '';
  statusText.textContent = 'New chat';
});

init();
