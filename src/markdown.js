const renderer = new marked.Renderer();

renderer.code = function ({ text, lang }) {
  const language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
  const highlighted = hljs.highlight(text, { language }).value;
  const langLabel = lang || '';
  return `<div class="code-block">
    <div class="code-header">
      <span class="code-lang">${langLabel}</span>
      <button class="copy-btn" onclick="copyCode(this)">Copy</button>
    </div>
    <pre><code class="hljs language-${language}">${highlighted}</code></pre>
  </div>`;
};

marked.setOptions({
  renderer,
  gfm: true,
  breaks: true,
});

export function renderMarkdown(text) {
  if (!text) return '';
  try {
    return marked.parse(text);
  } catch {
    return escapeHtml(text);
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

window.copyCode = function (btn) {
  const pre = btn.closest('.code-block').querySelector('pre code');
  const text = pre.textContent;
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => (btn.textContent = 'Copy'), 1500);
  });
};
