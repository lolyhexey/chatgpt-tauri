function renderToolCall(name, args) {
  const div = document.createElement('div');
  div.className = 'tool-block';

  const header = document.createElement('div');
  header.className = 'tool-header';
  header.innerHTML = `<span class="tool-icon">🔧</span> <span class="tool-name">${escapeHtml(name)}</span>`;

  const argsEl = document.createElement('pre');
  argsEl.className = 'tool-args';
  argsEl.textContent = typeof args === 'string' ? args : JSON.stringify(args, null, 2);

  const content = document.createElement('div');
  content.className = 'tool-content';
  content.appendChild(argsEl);

  header.onclick = () => content.classList.toggle('collapsed');

  div.appendChild(header);
  div.appendChild(content);
  return div;
}

function renderToolResult(result, error) {
  const div = document.createElement('div');
  div.className = 'tool-result' + (error ? ' tool-error' : '');

  const text = error || result || '(no output)';
  const pre = document.createElement('pre');
  pre.textContent = text.length > 2000 ? text.slice(0, 2000) + '\n...(truncated)' : text;

  div.appendChild(pre);
  return div;
}

function renderAgentProgress(agents) {
  const div = document.createElement('div');
  div.className = 'agent-panel';
  div.innerHTML = `<div class="agent-header">🤖 Parallel Agents (${agents.length})</div>`;

  for (const agent of agents) {
    const row = document.createElement('div');
    row.className = 'agent-row';
    const icon = agent.error ? '✗' : agent.result ? '✓' : '⟳';
    const cls = agent.error ? 'agent-failed' : agent.result ? 'agent-done' : 'agent-running';
    row.innerHTML = `<span class="${cls}">${icon}</span> ${escapeHtml(agent.task)} <span class="agent-time">${agent.seconds?.toFixed(1) || '...'}s</span>`;
    div.appendChild(row);
  }

  return div;
}

function escapeHtml(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el.innerHTML;
}
