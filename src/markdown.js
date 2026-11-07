var _markedReady = false;

function _initMarked() {
  if (_markedReady) return;
  if (typeof marked === 'undefined' || typeof hljs === 'undefined') return;
  _markedReady = true;

  var renderer = new marked.Renderer();
  // marked v12 calls code(code, lang, escaped) with positional args
  renderer.code = function (code, lang) {
    var text = code || '';
    var name = (lang || '').trim().split(/\s+/)[0];
    var language = name && hljs.getLanguage(name) ? name : 'plaintext';
    var highlighted = hljs.highlight(text, { language: language, ignoreIllegals: true }).value;
    return '<div class="code-block">' +
      '<div class="code-header">' +
        '<span class="code-lang">' + icon('code-xml', 16) + '<span>' + escText(name || 'text') + '</span></span>' +
        '<span class="code-actions">' +
          '<button type="button" class="code-btn" data-action="wrap-code" title="Wrap lines">' + icon('wrap-text', 18) + '</button>' +
          '<button type="button" class="code-btn" data-action="copy-code" title="Copy">' + icon('copy', 18) + '</button>' +
        '</span>' +
      '</div>' +
      '<pre class="code-pre"><code class="hljs language-' + language + '">' + highlighted + '</code></pre>' +
    '</div>';
  };

  marked.setOptions({ renderer: renderer, gfm: true, breaks: true });
}

// sources: optional Map of citation id -> {url, title, attribution} for <Cite refs> chips.
function renderMarkdown(text, sources) {
  if (!text) return '';
  _initMarked();
  if (!_markedReady) return escText(stripCites(text));
  try {
    var html = marked.parse(transformMarkup(text, sources));
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
    return sanitizeHtml(linkifyFilePaths(html));
  } catch (e) {
    console.error('renderMarkdown failed', e);
    return escText(text);
  }
}

// Apply GenUI/DIL transforms only outside fenced code blocks.
function transformMarkup(text, sources) {
  return text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/).map(function (seg, i) {
    if (i % 2 === 1) return seg;
    seg = transformCites(seg, sources);
    seg = collapseRows(dedentDilBlocks(seg));
    seg = transformDil(transformGenUI(seg));
    // Indented HTML lines would otherwise become markdown code blocks.
    return seg.replace(/^[ \t]+(?=<)/gm, '');
  }).join('');
}

// Citations: <Cite refs={["turn1search5",...]}/> (current) or citeidid (older replies).
var CITE_TAG = /<Cite\s+refs=\{(\[[^\]]*\])\}\s*\/?>/g;
var CITE_PUA = /cite([^]*)/g;

function citeIds(list) {
  try {
    var ids = JSON.parse(list);
    if (Array.isArray(ids)) return ids.map(String);
  } catch (e) {}
  return list.match(/[\w-]+/g) || [];
}

function citeChip(ids, sources) {
  var found = [];
  ids.forEach(function (id) {
    var s = sources && sources.get(id);
    if (s && found.indexOf(s) < 0) found.push(s);
  });
  // A citation whose source we don't have is dropped rather than shown as raw markup.
  if (!found.length) return '';
  var first = found[0];
  var name = first.attribution || first.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
  // One line per source. Titles can contain blank lines (PDFs), and a raw blank line inside an
  // attribute ends the markdown paragraph and breaks the tag, so collapse and encode them.
  var tip = found.map(function (s) {
    var title = (s.title || '').replace(/\s+/g, ' ').trim();
    return (title ? title + ' — ' : '') + s.url.replace(/^https?:\/\//, '').split('?')[0];
  }).join('\n');
  return '<a class="cite-chip" href="' + escAttr(first.url) + '" title="' + escAttr(tip).replace(/\n/g, '&#10;') + '">' + escText(name) +
    (found.length > 1 ? '<span class="cite-more">+' + (found.length - 1) + '</span>' : '') + '</a>';
}

function transformCites(seg, sources) {
  return seg
    .replace(CITE_TAG, function (_, list) { return citeChip(citeIds(list), sources); })
    .replace(CITE_PUA, function (_, list) { return citeChip(list.split('').filter(Boolean), sources); })
    .replace(/<([A-Z][A-Za-z]+)\b([^<>]*?)\/>/g, function (_, tag, attrs) { return componentTag(tag, parseDilAttrs(attrs)); });
}

// chatgpt.com's other inline components. AsyncImage needs ChatGPT's server-side image search,
// which this app can't call, so it is dropped like any unknown component (never shown raw).
function componentTag(tag, a) {
  switch (tag) {
    case 'Link':
      if (!/^https?:\/\//i.test(a.url || '')) return escText(a.title || '');
      return '<a href="' + escAttr(a.url) + '">' + escText(a.title || a.url) + '</a>';
    case 'Entity':
      return '<span class="entity"' + (a.disambig ? ' title="' + escAttr(a.disambig.replace(/\s+/g, ' ')) + '"' : '') + '>' +
        escText(a.value || '') + '</span>';
    default:
      return '';
  }
}

// Plain-text form for copying: citations dropped, Link/Entity reduced to their text.
function stripCites(text) {
  return text.replace(CITE_TAG, '').replace(CITE_PUA, '').replace(/<([A-Z][A-Za-z]+)\b([^<>]*?)\/>/g, function (_, tag, attrs) {
    var a = parseDilAttrs(attrs);
    return tag === 'Link' ? (a.title || a.url || '') : tag === 'Entity' ? (a.value || '') : '';
  });
}

var DIL_CONTAINER_OPEN = /<(box|grid-item|grid|row|radio-group)(\s[^>]*[^\/]|)>/g;
var DIL_CONTAINER_CLOSE = /<\/(box|grid-item|grid|row|radio-group)>/g;

// Content indented inside DIL containers is layout indentation, not a markdown code block.
function dedentDilBlocks(seg) {
  if (!/<(box|grid|row|radio-group)\b/.test(seg)) return seg;
  var depth = 0;
  return seg.split('\n').map(function (line) {
    var out = depth > 0 ? line.replace(/^[ \t]+/, '') : line;
    depth += (line.match(DIL_CONTAINER_OPEN) || []).length - (line.match(DIL_CONTAINER_CLOSE) || []).length;
    if (depth < 0) depth = 0;
    return out;
  }).join('\n');
}

// A <row> is one flex line; join its lines so markdown inside it renders inline.
function collapseRows(seg) {
  return seg.replace(/<row\b[^>]*>[\s\S]*?<\/row>/g, function (block) {
    return /<(box|grid|radio-group)\b/.test(block) ? block : block.split('\n').map(function (l) { return l.trim(); }).join(' ');
  });
}

function transformDil(text) {
  return text.replace(
    /<(\/?)(box|row|text|title|icon|divider|list-item|list|badge|header|grid-item|grid|caption)\b([^>]*)>/gi,
    function (full, slash, tag, rawAttrs) {
      var t = tag.toLowerCase();
      if (slash) return dilCloseTag(t);
      return dilTagToHtml(t, rawAttrs.replace(/\/\s*$/, '').trim());
    }
  );
}

function dilTagToHtml(tag, attrStr) {
  var a = parseDilAttrs(attrStr);
  var c;
  switch (tag) {
    case 'box':
      c = ['dil-box'];
      if (/(^|\s)border\b/.test(attrStr)) c.push('dil-has-border');
      if (a.background === 'surface') c.push('dil-bg-surface');
      if (a.background === 'surface-secondary') c.push('dil-bg-surface-alt');
      if (a.direction === 'row' || /(^|\s)row(\s|$)/.test(attrStr)) c.push('dil-dir-row');
      if (a.align) c.push('dil-align-' + a.align);
      if (a.justify) c.push('dil-justify-' + a.justify);
      if (a.padding) c.push('dil-p-' + a.padding);
      if (a.gap) c.push('dil-gap-' + a.gap);
      if (a.radius) c.push('dil-r-' + a.radius);
      if (/"success"/.test(attrStr)) c.push('dil-border-success');
      if (/"error"/.test(attrStr)) c.push('dil-border-error');
      return '\n\n<div class="' + c.join(' ') + '">\n\n';
    case 'row':
      c = ['dil-row'];
      if (a.align) c.push('dil-align-' + a.align);
      if (a.justify) c.push('dil-justify-' + a.justify);
      if (a.gap) c.push('dil-gap-' + a.gap);
      return '<span class="' + c.join(' ') + '">';
    case 'text':
      c = ['dil-text'];
      if (a.color) c.push('dil-color-' + a.color);
      if (a.size) c.push('dil-size-' + a.size);
      if (a.weight) c.push('dil-weight-' + a.weight);
      return '<span class="' + c.join(' ') + '">';
    case 'title':
      return '\n\n<h3 class="dil-title dil-title-' + (a.size || 'md') + (/tabularNums/.test(attrStr) ? ' dil-tabular' : '') + '">';
    case 'grid':
      c = ['dil-grid', 'dil-cols-' + Math.min(Math.max(parseInt(a.columns, 10) || 2, 1), 4)];
      if (a.gap) c.push('dil-gap-' + a.gap);
      return '\n\n<div class="' + c.join(' ') + '">\n\n';
    case 'grid-item':
      return '\n\n<div class="dil-grid-item">\n\n';
    case 'caption':
      return '<span class="dil-caption">';
    case 'icon':
      var svg = icon(a.name || '', a.size === 'xl' ? 24 : a.size === 'lg' ? 22 : a.size === 'sm' ? 16 : 18);
      return '<span class="dil-icon' + (a.color ? ' dil-icon-' + a.color : '') + '">' + (svg || '•') + '</span>';
    case 'divider':
      return '\n\n<hr class="dil-divider">\n\n';
    case 'list':
      return '\n\n<ul class="dil-list">\n\n';
    case 'list-item':
      return '<li class="dil-list-item">';
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
    case 'box': case 'header': case 'grid': case 'grid-item': return '\n\n</div>\n\n';
    case 'row': case 'text': case 'badge': case 'caption': return '</span>';
    case 'title': return '</h3>\n\n';
    case 'list': return '\n\n</ul>\n\n';
    case 'list-item': return '</li>';
    default: return '';
  }
}

function parseDilAttrs(attrString) {
  var result = {};
  var re = /([\w-]+)(?:="([^"]*)"|=\{([^}]*)\}|=(\S+))?/g, m;
  while ((m = re.exec(attrString))) {
    result[m[1]] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return result;
}

function linkifyFilePaths(html) {
  return html.replace(/<code>([^<]+)<\/code>/g, function (full, content) {
    var raw = content.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
    if (!isFilePath(raw)) return full;
    return '<code class="file-link" data-path="' + escAttr(raw.replace(/:\d+(?::\d+)?$/, '')) + '" title="Show in folder">' + content + '</code>';
  });
}

function isFilePath(text) {
  if (/\s/.test(text) || /:\/\//.test(text)) return /^[A-Za-z]:\\/.test(text);
  if (/^[A-Za-z]:\\/.test(text)) return true;
  if (/^\/[A-Za-z]/.test(text) && /\//.test(text.slice(1))) return true;
  return /[\/\\]/.test(text) && /\.\w{1,10}(:\d+){0,2}$/.test(text);
}

// Model output is untrusted and the webview can call backend commands,
// so strip active content before it reaches innerHTML.
var BLOCKED_TAGS = { SCRIPT: 1, IFRAME: 1, FRAME: 1, FRAMESET: 1, OBJECT: 1, EMBED: 1, LINK: 1, META: 1, BASE: 1, STYLE: 1, FORM: 1 };

function sanitizeHtml(html) {
  var tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('*').forEach(function (el) {
    if (BLOCKED_TAGS[el.tagName.toUpperCase()]) { el.remove(); return; }
    for (var i = el.attributes.length - 1; i >= 0; i--) {
      var name = el.attributes[i].name.toLowerCase();
      var value = el.attributes[i].value;
      if (name.indexOf('on') === 0 || name === 'style' || name === 'formaction' || name === 'srcdoc') {
        el.removeAttribute(el.attributes[i].name);
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href' || name === 'action') &&
                 /^\s*(javascript|vbscript|data):/i.test(value) && !/^\s*data:image\//i.test(value)) {
        el.removeAttribute(el.attributes[i].name);
      }
    }
  });
  return tpl.innerHTML;
}

function copyToClipboard(text) {
  if (window.__TAURI__ && window.__TAURI__.core) {
    return window.__TAURI__.core.invoke('copy_text', { text: text });
  }
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:-9999px;top:0';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  if (ok) return Promise.resolve();
  return navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('Clipboard unavailable'));
}

function flashCopied(btn) {
  var original = btn.innerHTML;
  btn.innerHTML = icon('check', 18);
  btn.classList.add('copied');
  setTimeout(function () { btn.innerHTML = original; btn.classList.remove('copied'); }, 1500);
}

document.addEventListener('click', function (e) {
  var target = e.target;
  if (!target.closest) return;

  var actionEl = target.closest('[data-action]');
  if (actionEl) {
    var action = actionEl.getAttribute('data-action');
    if (action === 'copy-code') {
      var code = actionEl.closest('.code-block').querySelector('pre code');
      copyToClipboard(code.textContent).then(function () { flashCopied(actionEl); }, function (err) { console.error(err); });
      return;
    }
    if (action === 'wrap-code') {
      var pre = actionEl.closest('.code-block').querySelector('pre');
      pre.classList.toggle('wrap');
      actionEl.classList.toggle('active', pre.classList.contains('wrap'));
      return;
    }
  }

  var fileLink = target.closest('.file-link');
  if (fileLink && window.__TAURI__) {
    window.__TAURI__.core.invoke('open_file_path', { path: fileLink.getAttribute('data-path') })
      .catch(function (err) { console.warn(err); });
    return;
  }

  var anchor = target.closest('.msg-assistant a[href]');
  if (anchor) {
    e.preventDefault();
    var href = anchor.getAttribute('href');
    if (/^https?:\/\//i.test(href) && window.__TAURI__) {
      window.__TAURI__.core.invoke('open_url', { url: href }).catch(function (err) { console.warn(err); });
    }
  }
});
