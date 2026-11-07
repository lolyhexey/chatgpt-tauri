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

// ctx (optional): { sources: Map citeId -> source, images: Map query -> image, streaming: bool }
// for chatgpt.com components (<Cite/>, <AsyncImage/>) that refer to data outside the text.
function renderMarkdown(text, ctx) {
  if (!text) return '';
  _initMarked();
  if (!_markedReady) return escText(stripCites(text));
  try {
    var math = [];
    var html = marked.parse(transformMarkup(extractMath(text, math), ctx));
    html = html.replace(/<table>/g, '<div class="table-wrap"><table>').replace(/<\/table>/g, '</table></div>');
    return restoreMath(sanitizeHtml(linkifyFilePaths(html)), math);
  } catch (e) {
    console.error('renderMarkdown failed', e);
    return escText(text);
  }
}

// Math as ChatGPT writes it: \[ … \] and $$ … $$ (display), \( … \) (inline); chatgpt.com
// renders it with KaTeX. Markdown would eat the backslashes ("\[" -> "["), so each formula is
// swapped for a plain token first and KaTeX's output goes in after sanitizing (KaTeX escapes
// the TeX itself and builds its own markup). Code blocks and inline code are left alone.
var MATH_RE = /\\\[([\s\S]+?)\\\]|\$\$([\s\S]+?)\$\$|\\\(([\s\S]+?)\\\)/g;

function extractMath(text, store) {
  return text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/).map(function (seg, i) {
    if (i % 2 === 1) return seg;
    return seg.replace(MATH_RE, function (m, a, b, c) {
      var display = c === undefined;
      store.push({ tex: display ? (a !== undefined ? a : b) : c, display: display });
      return 'KXMATH' + (store.length - 1) + 'Z';
    });
  }).join('');
}

function restoreMath(html, store) {
  if (!store.length) return html;
  var render = function (n) {
    var m = store[Number(n)];
    if (!m) return '';
    if (typeof katex === 'undefined') return escText(m.display ? '\\[' + m.tex + '\\]' : '\\(' + m.tex + '\\)');
    var out = katex.renderToString(m.tex.trim(), { displayMode: m.display, throwOnError: false, strict: 'ignore', trust: false });
    return m.display ? '<div class="math-display">' + out + '</div>' : out;
  };
  // A formula alone in its paragraph becomes the block itself.
  return html
    .replace(/<p>\s*KXMATH(\d+)Z\s*<\/p>/g, function (_, n) { return render(n); })
    .replace(/KXMATH(\d+)Z/g, function (_, n) { return render(n); });
}

// Apply GenUI/DIL transforms only outside fenced code blocks.
function transformMarkup(text, ctx) {
  return text.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/).map(function (seg, i) {
    if (i % 2 === 1) return seg;
    seg = transformCites(seg, ctx || {});
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
  var name = siteName(first);
  // One line per source. Titles can contain blank lines (PDFs), and a raw blank line inside an
  // attribute ends the markdown paragraph and breaks the tag, so collapse and encode them.
  var tip = found.map(function (s) {
    var title = (s.title || '').replace(/\s+/g, ' ').trim();
    return (title ? title + ' — ' : '') + s.url.replace(/^https?:\/\//, '').split('?')[0];
  }).join('\n');
  // chatgpt.com loads a favicon from Google here; a letter badge avoids sending cited sites to a third party.
  return '<a class="cite-chip" href="' + escAttr(first.url) + '" title="' + escAttr(tip).replace(/\n/g, '&#10;') + '">' +
    '<span class="cite-fav">' + escText(name.charAt(0).toUpperCase()) + '</span>' + escText(name) +
    (found.length > 1 ? '<span class="cite-more">+' + (found.length - 1) + '</span>' : '') + '</a>';
}

// Short site name like chatgpt.com's chips: "App Store" when given, else from the host
// ("transparency.x.com" -> "Transparency", "x.com" -> "X").
function siteName(s) {
  if (s.name) return s.name;
  var host = (s.attribution || s.url.replace(/^https?:\/\//, '').split(/[\/?#]/)[0]).replace(/^www\./, '');
  var label = host.split('.')[0] || host;
  // A page title like "GitHub - 7723mod/NPatch" carries the site's own spelling of its name.
  var m = /^(.{2,30}?)\s+[-|–—:]\s/.exec(s.title || '');
  if (m && m[1].toLowerCase().replace(/\s+/g, '') === label.toLowerCase()) return m[1];
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function transformCites(seg, ctx) {
  return seg
    .replace(CITE_TAG, function (_, list) { return citeChip(citeIds(list), ctx.sources); })
    .replace(CITE_PUA, function (_, list) { return citeChip(list.split('').filter(Boolean), ctx.sources); })
    .replace(/<([A-Z][A-Za-z]+)\b([^<>]*?)\/>/g, function (_, tag, attrs) { return componentTag(tag, parseDilAttrs(attrs), ctx); });
}

// chatgpt.com's other components. Unknown ones are dropped, never shown raw.
function componentTag(tag, a, ctx) {
  switch (tag) {
    case 'Link': {
      // <Link url="…"/> or <Link ref="turn…view0"/>, a page from this reply's search results.
      var src = a.ref && ctx.sources ? ctx.sources.get(a.ref) : null;
      var url = a.url || (src && src.url) || '';
      var label = a.title || (src && src.title) || url;
      if (!/^https?:\/\//i.test(url)) return escText(label);
      return '<a class="dil-link" href="' + escAttr(url) + '"><span class="dil-link-text">' + escText(label) + '</span>' +
        icon('arrow-up-right', 14) + '</a>';
    }
    case 'Entity':
      return '<span class="entity"' + (a.disambig ? ' title="' + escAttr(a.disambig.replace(/\s+/g, ' ')) + '"' : '') + '>' +
        escText(a.value || '') + '</span>';
    case 'AsyncImage':
      return asyncImage(a, ctx);
    default:
      return '';
  }
}

// An image chatgpt.com already found for this query (metadata componentResults). While the reply
// streams the result may not have arrived yet, so show an empty frame; afterwards drop it.
function asyncImage(a, ctx) {
  var img = ctx.images && ctx.images.get(a.query || '');
  if (!img && !ctx.streaming) return '';
  var small = /^\d+px$/.test(a.maxWidth || '') && parseInt(a.maxWidth, 10) <= 320;
  var frame = ' data-ar="' + escAttr(a.aspectRatio || '') + '" data-w="' + escAttr(a.width || '') + '"' +
    ' data-maxw="' + escAttr(a.maxWidth || '') + '" data-maxh="' + escAttr(a.maxHeight || '') + '"';
  var inner = '';
  if (img) {
    // data-* carry what the full-screen viewer needs (viewer.js).
    inner = '<img src="' + escAttr(small ? img.thumbnail : img.url) + '" alt="' + escAttr(img.title || a.query || '') + '"' +
      ' class="' + (a.fit === 'contain' ? 'fit-contain' : 'fit-cover') + '" loading="lazy"' +
      ' data-full="' + escAttr(img.url) + '" data-source-url="' + escAttr(img.source_url || '') + '"' +
      ' data-source-host="' + escAttr(img.source_host || '') + '" data-title="' + escAttr(img.title || '') + '">';
    if (img.show_url && img.source_url) {
      inner += '<a class="gen-img-src" href="' + escAttr(img.source_url) + '">' + escText(img.source_host) + '</a>';
    }
  }
  return '\n\n<div class="gen-img' + (img ? '' : ' gen-img-loading') + '"' + frame + '>' + inner + '</div>\n\n';
}

// Apply <AsyncImage/> sizing after sanitizing (which strips style attributes). Only plain
// numbers, px and % are accepted.
function hydrateMedia(root) {
  var len = function (v) {
    if (/^\d+(\.\d+)?$/.test(v)) return v + 'px';
    return /^\d+(\.\d+)?(px|%)$/.test(v) ? v : '';
  };
  root.querySelectorAll('.gen-img').forEach(function (el) {
    var ar = (el.getAttribute('data-ar') || '').match(/^(\d+(?:\.\d+)?)\s*[:\/]\s*(\d+(?:\.\d+)?)$/);
    var ratio = ar ? ar[1] + ' / ' + ar[2] : '';
    var w = len(el.getAttribute('data-w') || ''), maxw = len(el.getAttribute('data-maxw') || ''), maxh = len(el.getAttribute('data-maxh') || '');
    if (ratio) el.style.aspectRatio = ratio;
    if (maxw) { el.style.width = maxw; el.style.maxWidth = '100%'; } else el.style.width = w || '100%';
    // chatgpt.com only labels the source on large images, not on list thumbnails.
    if (/px$/.test(maxw) && parseFloat(maxw) < 240) {
      var label = el.querySelector('.gen-img-src');
      if (label) label.remove();
    }
    if (maxh) el.style.maxHeight = maxh;
    var img = el.querySelector('img');
    if (!img) return;
    // Like chatgpt.com: the image keeps the frame's aspect ratio; a max height crops the frame.
    if (ratio) img.style.aspectRatio = ratio;
    img.addEventListener('error', function () { el.remove(); }, { once: true });
  });
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
// A row holding block content (a <box>, an image) is a horizontal box instead.
function collapseRows(seg) {
  return seg.replace(/<row\b([^>]*)>([\s\S]*?)<\/row>/g, function (block, attrs, body) {
    if (/<(box|grid|radio-group)\b|class="gen-img/.test(body)) return '<box direction="row"' + attrs + '>' + body + '</box>';
    return block.split('\n').map(function (l) { return l.trim(); }).join(' ');
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
      if (a.flex) c.push('dil-flex');
      if (a.wrap === 'nowrap') c.push('dil-nowrap');
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
      return '\n\n<hr class="dil-divider' + (a.color === 'subtle' ? ' dil-divider-subtle' : '') + '">\n\n';
    case 'list':
      return '\n\n<ul class="dil-list">\n\n';
    case 'list-item':
      return '<li class="dil-list-item">';
    case 'badge':
      return '<span class="dil-badge' + (/^(success|info|warning|danger|error)$/.test(a.color || '') ? ' dil-badge-' + a.color : '') + '">';
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
