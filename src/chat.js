class Chat {
  constructor(container) {
    this.container = container;
    this.currentAssistant = null;
    this.currentRaw = '';
    this.renderTimeout = null;
  }

  clear() {
    this.container.innerHTML = '';
    this.currentAssistant = null;
    this.currentRaw = '';
  }

  loadConversation(messages) {
    this.clear();
    for (const msg of messages) {
      if (msg.role === 'user') {
        this._addUserEl(msg.content);
      } else {
        this._addAssistantEl(msg.content);
      }
    }
    this._scrollToBottom();
  }

  addUserMessage(text) {
    this._addUserEl(text);
    this._scrollToBottom();
  }

  startAssistantMessage() {
    const div = document.createElement('div');
    div.className = 'msg-assistant';
    div.innerHTML = '<span class="cursor-blink">▌</span>';
    this.container.appendChild(div);
    this.currentAssistant = div;
    this.currentRaw = '';
    this._scrollToBottom();
  }

  appendDelta(text) {
    this.currentRaw += text;
    if (!this.renderTimeout) {
      this.renderTimeout = setTimeout(() => {
        this._renderCurrent();
        this.renderTimeout = null;
      }, 80);
    }
  }

  finishMessage() {
    if (this.renderTimeout) {
      clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    this._renderCurrent();
    this.currentAssistant = null;
  }

  addThinkingBlock(text) {
    const div = document.createElement('div');
    div.className = 'msg-thinking';
    const header = document.createElement('div');
    header.className = 'thinking-header';
    header.textContent = '💭 Thinking...';
    header.onclick = () => {
      content.classList.toggle('collapsed');
      header.textContent = content.classList.contains('collapsed') ? '💭 Thinking (collapsed)' : '💭 Thinking...';
    };
    const content = document.createElement('div');
    content.className = 'thinking-content';
    content.textContent = text;
    div.appendChild(header);
    div.appendChild(content);
    this.container.appendChild(div);
    this._scrollToBottom();
  }

  addErrorMessage(text) {
    const div = document.createElement('div');
    div.className = 'msg-error';
    div.textContent = text;
    this.container.appendChild(div);
    this._scrollToBottom();
  }

  _addUserEl(text) {
    const div = document.createElement('div');
    div.className = 'msg-user';
    div.textContent = text;
    this.container.appendChild(div);
  }

  _addAssistantEl(text) {
    const div = document.createElement('div');
    div.className = 'msg-assistant';
    div.innerHTML = renderMarkdown(text);
    this.container.appendChild(div);
  }

  _renderCurrent() {
    if (!this.currentAssistant) return;
    const isAtBottom = this._isNearBottom();
    this.currentAssistant.innerHTML = renderMarkdown(this.currentRaw) + '<span class="cursor-blink">▌</span>';
    if (isAtBottom) this._scrollToBottom();
  }

  _isNearBottom() {
    const el = this.container;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  _scrollToBottom() {
    this.container.scrollTop = this.container.scrollHeight;
  }
}
