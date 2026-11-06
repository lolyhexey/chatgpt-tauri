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
    let cleaned = cleanDilMarkup(text);
    return marked.parse(cleaned);
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

// ChatGPT DIL (Document Intermediate Language) markup transformer
// Maps custom tags to HTML with data attributes matching ChatGPT web's rendering
function cleanDilMarkup(text) {
  return text
    // --- BOX ---
    .replace(/<box\s+([^>]*)>/gi, (_, attrs) => {
      const data = parseDilAttrs(attrs);
      const classes = ['dil-box'];
      if (data.border || attrs.includes('border')) classes.push('dil-has-border');
      if (data.background === 'surface') classes.push('dil-bg-surface');
      if (data.background === 'surface-secondary') classes.push('dil-bg-surface-alt');
      if (data.align) classes.push(`dil-align-${data.align}`);
      if (data.justify) classes.push(`dil-justify-${data.justify}`);
      if (data.padding) classes.push(`dil-p-${data.padding}`);
      if (data.gap) classes.push(`dil-gap-${data.gap}`);
      if (data.radius) classes.push(`dil-r-${data.radius}`);
      // Check for border color
      if (attrs.includes('color:"success"') || attrs.includes("color:'success'")) classes.push('dil-border-success');
      if (attrs.includes('color:"error"') || attrs.includes("color:'error'")) classes.push('dil-border-error');
      return `<div class="${classes.join(' ')}">`;
    })
    .replace(/<box>/gi, '<div class="dil-box">')
    .replace(/<\/box>/gi, '</div>')

    // --- ROW (= box with direction=row) ---
    .replace(/<row\s+([^>]*)>/gi, (_, attrs) => {
      const data = parseDilAttrs(attrs);
      const classes = ['dil-row'];
      if (data.align) classes.push(`dil-align-${data.align}`);
      if (data.justify) classes.push(`dil-justify-${data.justify}`);
      if (data.gap) classes.push(`dil-gap-${data.gap}`);
      return `<div class="${classes.join(' ')}">`;
    })
    .replace(/<row>/gi, '<div class="dil-row">')
    .replace(/<\/row>/gi, '</div>')

    // --- TEXT ---
    .replace(/<text\s+([^>]*)>/gi, (_, attrs) => {
      const data = parseDilAttrs(attrs);
      const classes = ['dil-text'];
      if (data.color === 'secondary') classes.push('dil-color-secondary');
      if (data.color === 'success') classes.push('dil-color-success');
      if (data.color === 'error') classes.push('dil-color-error');
      if (data.size) classes.push(`dil-size-${data.size}`);
      if (data.weight) classes.push(`dil-weight-${data.weight}`);
      return `<span class="${classes.join(' ')}">`;
    })
    .replace(/<text>/gi, '<span class="dil-text">')
    .replace(/<\/text>/gi, '</span>')

    // --- TITLE ---
    .replace(/<title\s+([^>]*)>([\s\S]*?)<\/title>/gi, (_, attrs, content) => {
      const data = parseDilAttrs(attrs);
      const tag = data.size === 'lg' ? 'h2' : 'h3';
      return `<${tag} class="dil-title dil-title-${data.size || 'md'}">${content}</${tag}>`;
    })

    // --- ICON ---
    .replace(/<icon\s+([^>]*)\/?\s*>/gi, (_, attrs) => {
      const data = parseDilAttrs(attrs);
      const name = data.name || '';
      const color = data.color || '';
      const iconMap = {
        'arrow-down': '↓', 'arrow-right': '→', 'arrow-left': '←', 'arrow-up': '↑',
        'check-circle': '✓', 'check': '✓',
        'x-circle': '✗', 'x': '✗',
        'info': 'ℹ', 'alert-circle': '⚠', 'alert-triangle': '⚠',
        'workflow': '⚡', 'zap': '⚡',
        'file-json': '📄', 'file': '📄', 'file-text': '📄', 'file-code': '📄',
        'folder-code': '📁', 'folder': '📁',
        'shield': '🛡', 'shield-check': '🛡',
        'lock': '🔒', 'unlock': '🔓',
        'key': '🔑',
        'code': '⟨⟩', 'terminal': '▸', 'command': '⌘',
        'database': '🗄', 'server': '🖥',
        'globe': '🌐', 'link': '🔗', 'external-link': '↗',
        'search': '🔍',
        'copy': '📋', 'clipboard': '📋',
        'download': '⬇', 'upload': '⬆',
        'settings': '⚙', 'sliders': '⚙',
        'eye': '👁', 'eye-off': '👁',
        'clock': '🕐', 'timer': '⏱',
        'hash': '#', 'at-sign': '@',
        'star': '★', 'heart': '♥',
        'play': '▶', 'pause': '⏸', 'stop': '⏹',
        'refresh-cw': '↻', 'rotate-cw': '↻',
        'trash': '🗑', 'trash-2': '🗑',
        'edit': '✏', 'edit-2': '✏', 'pencil': '✏',
        'plus': '+', 'minus': '−',
        'chevron-right': '›', 'chevron-down': '⌄', 'chevron-up': '⌃',
        'message-square': '💬', 'message-circle': '💬',
        'user': '👤', 'users': '👥',
        'package': '📦', 'box': '📦',
        'cpu': '🔲', 'hard-drive': '💾',
        'wifi': '📶', 'wifi-off': '📵',
        'image': '🖼', 'camera': '📷',
        'book': '📖', 'book-open': '📖',
        'layers': '◫', 'grid': '⊞',
        'activity': '📊', 'bar-chart': '📊', 'pie-chart': '📊',
        'git-branch': '⑂', 'git-commit': '●', 'git-merge': '⑃',
      };
      const symbol = iconMap[name] || '•';
      const cls = color ? `dil-icon dil-icon-${color}` : 'dil-icon';
      return `<span class="${cls}" title="${name}">${symbol}</span>`;
    })
    .replace(/<icon[^>]*>/gi, '<span class="dil-icon">•</span>')
    .replace(/<\/icon>/gi, '')

    // --- DIVIDER ---
    .replace(/<divider[^>]*\/?\s*>/gi, '<hr class="dil-divider">')

    // --- LIST ---
    .replace(/<list\s+([^>]*)>/gi, '<ul class="dil-list">')
    .replace(/<list>/gi, '<ul class="dil-list">')
    .replace(/<\/list>/gi, '</ul>')
    .replace(/<list-item[^>]*>/gi, '<li class="dil-list-item">')
    .replace(/<\/list-item>/gi, '</li>')

    // --- BUTTON ---
    .replace(/<button\s+([^>]*)>([\s\S]*?)<\/button>/gi, (_, attrs, content) => {
      return `<span class="dil-button">${content}</span>`;
    })
    .replace(/<button>([\s\S]*?)<\/button>/gi, '<span class="dil-button">$1</span>')

    // --- BADGE ---
    .replace(/<badge[^>]*>([\s\S]*?)<\/badge>/gi, '<span class="dil-badge">$1</span>')

    // --- TABLE passthrough (already handled by marked.js) ---
    // --- CODE inline (handled by marked.js) ---

    // Clean up empty paragraphs that can result from block-level elements inside <p>
    .replace(/<p>\s*<\/p>/g, '')
    .replace(/<p>\s*(<div)/g, '$1')
    .replace(/<\/div>\s*<\/p>/g, '</div>');
}

function parseDilAttrs(attrString) {
  const result = {};
  // Match key="value" or key={value} or key=value or standalone key
  const matches = attrString.matchAll(/(\w+)(?:="([^"]*)"|=\{([^}]*)\}|=(\S+))?/g);
  for (const m of matches) {
    const key = m[1];
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    result[key] = val;
  }
  return result;
}
