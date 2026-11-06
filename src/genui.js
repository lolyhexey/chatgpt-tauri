// ChatGPT "GenUI" widgets: DIL.useState state, <radio-group>, {#if} blocks,
// <textarea>, and <button onClick={() => GenUI.issueNewTurn(...)}>.
// Rendered as real form controls; the confirm button sends the chosen
// option's label (or the visible textarea's text) as the next user turn.

var _gxSeq = 0;

function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;');
}

function parseLiteral(src) {
  var s = src.trim();
  try { return JSON.parse(s); } catch (e) {}
  return s.replace(/^["'`]|["'`]$/g, '');
}

// Index of the '>' closing a tag opened before `i`, skipping '>' inside {...} and quotes
// (attribute values like onClick={() => ...} contain '>').
function findTagEnd(s, i) {
  var depth = 0, quote = null;
  for (; i < s.length; i++) {
    var c = s[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth <= 0) return i;
  }
  return -1;
}

function transformTextareas(text) {
  return text.replace(/<textarea\b([^>]*?)\/?>(?:\s*<\/textarea>)?/g, function (_, attrs) {
    var a = parseDilAttrs(attrs);
    var rows = parseInt(a.rows, 10) || 2;
    return '<textarea class="gx-textarea" rows="' + rows + '"' +
      (a.placeholder ? ' placeholder="' + escAttr(a.placeholder) + '"' : '') +
      (a.value ? ' data-state="' + escAttr(a.value) + '"' : '') + '></textarea>';
  });
}

function transformButtons(text) {
  var out = '', i = 0;
  for (;;) {
    var start = text.indexOf('<button', i);
    if (start < 0) break;
    var end = findTagEnd(text, start + 7);
    var close = end < 0 ? -1 : text.indexOf('</button>', end);
    if (close < 0) break;
    var attrs = text.slice(start + 7, end);
    var label = text.slice(end + 1, close).trim();
    out += text.slice(i, start);
    if (/GenUI\.issueNewTurn/.test(attrs)) {
      var block = /(^|\s)block(\s|=|$)/.test(attrs);
      var needsText = /disabled=\{/.test(attrs);
      out += '<button type="button" class="gx-button' + (block ? ' gx-block' : '') + '" data-gx-submit="1"' +
        (needsText ? ' data-gx-needs-text="1"' : '') + '>' + escText(label) + '</button>';
    } else {
      out += '<span class="dil-button">' + escText(label) + '</span>';
    }
    i = close + 9;
  }
  return out + text.slice(i);
}

function transformGenUI(text) {
  if (!/DIL\.|GenUI\.|<radio-group|<textarea|\{#if/.test(text)) return text;
  var state = {};

  text = text.replace(/\{@body\s+const\s+\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*DIL\.useState\(([^\n]*?)\)\s*\}/g,
    function (_, name, init) { state[name] = parseLiteral(init); return ''; });
  text = text.replace(/^[ \t]*\{@body[^\n]*\}[ \t]*$/gm, '');

  text = text.replace(/<radio-group\b([^>]*)>([\s\S]*?)<\/radio-group>/g, function (_, attrs, inner) {
    var a = parseDilAttrs(attrs);
    var stateName = a.value || '';
    var hasState = Object.prototype.hasOwnProperty.call(state, stateName);
    var group = 'gx' + (++_gxSeq);
    var items = '';
    inner.replace(/<radio\b([^>]*)>([\s\S]*?)<\/radio>/g, function (__, rAttrs, label) {
      var val = parseDilAttrs(rAttrs).value || label.trim();
      var checked = hasState && String(state[stateName]) === val;
      items += '<label class="gx-radio"><input type="radio" name="' + group + '" value="' + escAttr(val) + '"' +
        (checked ? ' checked' : '') + '><span class="gx-dot"></span><span class="gx-label">' +
        escText(label.trim()) + '</span></label>';
      return '';
    });
    return '\n\n<div class="gx-radio-group' + (a.direction === 'row' ? ' gx-row' : '') + '" data-state="' +
      escAttr(stateName) + '">' + items + '</div>\n\n';
  });

  text = text.replace(/\{#if\s+(\w+)\s*===?\s*["']([^"']*)["']\s*\}([\s\S]*?)\{\/if\}/g, function (_, name, val, inner) {
    var visible = Object.prototype.hasOwnProperty.call(state, name) && String(state[name]) === val;
    var body = transformTextareas(inner).split('\n').map(function (l) { return l.trim(); }).join(' ').trim();
    return '\n\n<div class="gx-cond" data-state="' + escAttr(name) + '" data-eq="' + escAttr(val) + '"' +
      (visible ? '' : ' hidden') + '>' + body + '</div>\n\n';
  });

  text = transformTextareas(text);
  text = transformButtons(text);
  return text.replace(/\{#(?:if|each)\b[^}]*\}|\{\/(?:if|each)\}|\{:else\}|\{#else\}/g, '');
}

function gxRoot(el) {
  return el.closest('.dil-box') || el.closest('.msg-assistant') || document.body;
}

function gxSync(root) {
  root.querySelectorAll('.gx-radio-group').forEach(function (group) {
    var name = group.getAttribute('data-state');
    var sel = group.querySelector('input:checked');
    root.querySelectorAll('.gx-cond').forEach(function (cond) {
      if (cond.getAttribute('data-state') === name) cond.hidden = !sel || cond.getAttribute('data-eq') !== sel.value;
    });
  });
  if (root.classList.contains('gx-answered')) return;
  root.querySelectorAll('[data-gx-submit]').forEach(function (btn) {
    var ta = root.querySelector('.gx-cond:not([hidden]) .gx-textarea');
    var hasRadios = !!root.querySelector('.gx-radio');
    var chosen = !!root.querySelector('.gx-radio input:checked');
    btn.disabled = (hasRadios && !chosen && !ta) ||
      (btn.hasAttribute('data-gx-needs-text') && !!ta && !ta.value.trim());
  });
}

function gxAnswer(root) {
  var ta = root.querySelector('.gx-cond:not([hidden]) .gx-textarea');
  if (ta && ta.value.trim()) return ta.value.trim();
  var sel = root.querySelector('.gx-radio input:checked');
  if (sel) {
    var label = sel.closest('.gx-radio').querySelector('.gx-label');
    return label ? label.textContent.trim() : sel.value;
  }
  var lone = root.querySelector('.gx-textarea');
  return lone ? lone.value.trim() : '';
}

function hydrateGenUI(el) {
  el.querySelectorAll('[data-gx-submit]').forEach(function (btn) { gxSync(gxRoot(btn)); });
}

document.addEventListener('change', function (e) {
  if (e.target.matches && e.target.matches('.gx-radio input')) gxSync(gxRoot(e.target));
});

document.addEventListener('input', function (e) {
  if (e.target.matches && e.target.matches('.gx-textarea')) gxSync(gxRoot(e.target));
});

document.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('[data-gx-submit]');
  if (!btn || btn.disabled) return;
  var root = gxRoot(btn);
  var text = gxAnswer(root);
  if (!text || !window.chatApp || !window.chatApp.canSend()) return;
  root.classList.add('gx-answered');
  root.querySelectorAll('input, textarea, button').forEach(function (el) { el.disabled = true; });
  window.chatApp.sendText(text);
});
