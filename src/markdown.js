var _markedReady = false;

function _initMarked() {
  if (_markedReady) return;
  if (typeof marked === 'undefined' || typeof hljs === 'undefined') return;
  _markedReady = true;

  var renderer = new marked.Renderer();
  renderer.code = function (opts) {
    var text = opts.text || '';
    var lang = opts.lang || '';
    var language = lang && hljs.getLanguage(lang) ? lang : 'plaintext';
    var highlighted = hljs.highlight(text, { language: language }).value;
    var langDisplay = lang || 'code';
    return '<div class="code-block"><div class="code-header"><span class="code-lang">&lt;/&gt; ' + langDisplay + '</span><button class="copy-btn" onclick="copyCode(this)">&#x1F4CB; Copy</button></div><pre><code class="hljs language-' + language + '">' + highlighted + '</code></pre></div>';
  };

  marked.setOptions({ renderer: renderer, gfm: true, breaks: true });
}

function renderMarkdown(text) {
  if (!text) return '';
  _initMarked();
  if (!_markedReady) return escapeHtml(text);
  try {
    var cleaned = cleanDilMarkup(text);
    return marked.parse(cleaned);
  } catch (e) {
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

function dilTagToHtml(tag, attrStr) {
  const a = parseDilAttrs(attrStr);
  switch (tag) {
    case 'box': {
      const c = ['dil-box'];
      if (attrStr.includes('border') || a.border) c.push('dil-has-border');
      if (a.background === 'surface') c.push('dil-bg-surface');
      if (a.background === 'surface-secondary') c.push('dil-bg-surface-alt');
      if (a.align) c.push(`dil-align-${a.align}`);
      if (a.justify) c.push(`dil-justify-${a.justify}`);
      if (a.padding) c.push(`dil-p-${a.padding}`);
      if (a.gap) c.push(`dil-gap-${a.gap}`);
      if (a.radius) c.push(`dil-r-${a.radius}`);
      if (attrStr.includes('"success"')) c.push('dil-border-success');
      if (attrStr.includes('"error"')) c.push('dil-border-error');
      // Block element: use \n\n so marked treats content as markdown
      return `\n\n<div class="${c.join(' ')}">\n\n`;
    }
    case 'row': {
      // Inline element: use span so markdown inside renders
      const c = ['dil-row'];
      if (a.align) c.push(`dil-align-${a.align}`);
      if (a.justify) c.push(`dil-justify-${a.justify}`);
      if (a.gap) c.push(`dil-gap-${a.gap}`);
      return `<span class="${c.join(' ')}">`;
    }
    case 'text': {
      const c = ['dil-text'];
      if (a.color) c.push(`dil-color-${a.color}`);
      if (a.size) c.push(`dil-size-${a.size}`);
      if (a.weight) c.push(`dil-weight-${a.weight}`);
      return `<span class="${c.join(' ')}">`;
    }
    case 'title': {
      const t = a.size === 'lg' ? 'h2' : 'h3';
      return `\n\n<${t} class="dil-title dil-title-${a.size || 'md'}">`;
    }
    case 'icon': {
      const name = a.name || '';
      const color = a.color || '';
      const symbol = iconSymbol(name);
      const cls = color ? `dil-icon dil-icon-${color}` : 'dil-icon';
      return `<span class="${cls}" title="${name}">${symbol}</span>`;
    }
    case 'divider':
      return '\n\n<hr class="dil-divider">\n\n';
    case 'list':
      return '\n\n<ul class="dil-list">\n\n';
    case 'list-item':
      return '<li class="dil-list-item">';
    case 'button':
      return '<span class="dil-button">';
    case 'badge':
      return '<span class="dil-badge">';
    case 'header':
      return '\n\n<div class="dil-header">\n\n';
    default:
      return '';
  }
}

function dilCloseTag(tag) {
  switch (tag) {
    case 'box': case 'header': return '\n\n</div>\n\n';
    case 'row': return '</span>';
    case 'text': case 'button': case 'badge': return '</span>';
    case 'title': return '</h3>\n\n';
    case 'list': return '\n\n</ul>\n\n';
    case 'list-item': return '</li>';
    case 'icon': return '';
    default: return '';
  }
}

function iconSymbol(name) {
  const map = {
    'arrow-down': '↓', 'arrow-right': '→', 'arrow-left': '←', 'arrow-up': '↑',
    'check-circle': '✓', 'check': '✓',
    'x-circle': '✗', 'x': '✗',
    'info': 'ℹ', 'alert-circle': '⚠', 'alert-triangle': '⚠',
    'workflow': '⚡', 'zap': '⚡',
    'file-json': '📄', 'file': '📄', 'file-text': '📄', 'file-code': '📄',
    'folder-code': '📁', 'folder': '📁',
    'shield': '🛡', 'shield-check': '🛡',
    'lock': '🔒', 'unlock': '🔓', 'key': '🔑',
    'code': '⟨⟩', 'terminal': '▸', 'command': '⌘',
    'database': '🗄', 'server': '🖥',
    'globe': '🌐', 'link': '🔗', 'external-link': '↗',
    'search': '🔍', 'copy': '📋', 'clipboard': '📋',
    'download': '⬇', 'upload': '⬆',
    'settings': '⚙', 'sliders': '⚙',
    'eye': '👁', 'clock': '🕐', 'timer': '⏱',
    'hash': '#', 'at-sign': '@',
    'star': '★', 'heart': '♥',
    'play': '▶', 'pause': '⏸', 'stop': '⏹',
    'refresh-cw': '↻', 'rotate-cw': '↻',
    'trash': '🗑', 'edit': '✏', 'pencil': '✏',
    'plus': '+', 'minus': '−',
    'chevron-right': '›', 'chevron-down': '⌄', 'chevron-up': '⌃',
    'message-square': '💬', 'user': '👤', 'users': '👥',
    'package': '📦', 'cpu': '🔲', 'hard-drive': '💾',
    'wifi': '📶', 'image': '🖼', 'camera': '📷',
    'book': '📖', 'layers': '◫', 'grid': '⊞',
    'activity': '📊', 'bar-chart': '📊',
    'git-branch': '⑂', 'git-commit': '●',
  };
  return map[name] || '•';
}

// Clean DIL markup BEFORE marked.js processes markdown
function cleanDilMarkup(text) {
  // Single regex that handles open, self-closing, and close tags
  // Captures: [1]=optional /, [2]=tag name, [3]=attributes (may end with /)
  return text.replace(
    /<(\/?)(box|row|text|title|icon|divider|list|list-item|button|badge|header)\b([^>]*)>/gi,
    function(full, slash, tag, rawAttrs) {
      var t = tag.toLowerCase();
      if (slash) return dilCloseTag(t);
      // Remove trailing / from self-closing tags
      var attrs = rawAttrs.replace(/\/\s*$/, '').trim();
      return dilTagToHtml(t, attrs);
    }
  );
}

// Legacy function removed — see git history
function _unused_cleanDilMarkup_old(text) {
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
