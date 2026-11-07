// ChatGPT "GenUI" widgets: DIL.useState state, {#each}, {#if}/{:else}, <radio-group>,
// <input>/<textarea>, {expr} text and <button onClick={() => GenUI.issueNewTurn(expr)}>.
// Expressions are evaluated by a small interpreter (gxEval) — model output is never
// executed as JavaScript, because this webview can call backend commands.

var _gxSeq = 0;

function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(s) {
  return escText(s).replace(/"/g, '&quot;');
}

// ---------- Expression interpreter ----------

function gxTokenize(src) {
  var toks = [], i = 0, m;
  while (i < src.length) {
    var c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      var s = '', j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\' && j + 1 < src.length) {
          var n = src[j + 1];
          s += n === 'n' ? '\n' : n === 't' ? '\t' : n;
          j += 2;
        } else {
          if (c === '`' && src[j] === '$' && src[j + 1] === '{') throw new Error('template interpolation unsupported');
          s += src[j++];
        }
      }
      if (j >= src.length) throw new Error('unterminated string');
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if ((m = /^\d+(\.\d+)?/.exec(src.slice(i)))) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i)))) { toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.(?!\d)|=>)/.exec(src.slice(i)))) { toks.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
    if ('+-*!?:()[]{},.<>'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c }); i++; continue; }
    throw new Error('unexpected character ' + c);
  }
  return toks;
}

function gxEval(src, scope) {
  return gxEvalTokens(gxTokenize(src), scope);
}

// Interprets a small, side-effect-free subset of JS expressions (never eval). Arrow functions
// are only allowed as callbacks to the array methods below and run through this interpreter.
function gxEvalTokens(toks, scope) {
  var p = 0;
  function peek(v) { var t = toks[p]; return t && t.t === 'op' && t.v === v; }
  function eat(v) { if (!peek(v)) throw new Error('expected ' + v); p++; }
  function has(o, k) { return o != null && Object.prototype.hasOwnProperty.call(o, k); }

  function expr() {
    var cond = nullish();
    if (peek('?')) { p++; var a = expr(); eat(':'); var b = expr(); return cond ? a : b; }
    return cond;
  }
  function nullish() { var l = or(); while (peek('??')) { p++; var r = or(); l = l != null ? l : r; } return l; }
  function or() { var l = and(); while (peek('||')) { p++; var r = and(); l = l || r; } return l; }
  function and() { var l = eq(); while (peek('&&')) { p++; var r = eq(); l = l && r; } return l; }
  function eq() {
    var l = cmp();
    while (peek('===') || peek('==') || peek('!==') || peek('!=')) {
      var op = toks[p++].v, r = cmp();
      var same = (l === r) || (typeof l === 'object' && typeof r === 'object' && JSON.stringify(l) === JSON.stringify(r));
      l = op.charAt(0) === '!' ? !same : same;
    }
    return l;
  }
  function cmp() {
    var l = add();
    while (peek('<') || peek('>') || peek('<=') || peek('>=')) {
      var op = toks[p++].v, r = add();
      l = op === '<' ? l < r : op === '>' ? l > r : op === '<=' ? l <= r : l >= r;
    }
    return l;
  }
  function add() {
    var l = mul();
    while (peek('+') || peek('-')) {
      var op = toks[p++].v, r = mul();
      l = op === '+' ? ((typeof l === 'string' || typeof r === 'string') ? String(l == null ? '' : l) + String(r == null ? '' : r) : l + r) : l - r;
    }
    return l;
  }
  function mul() { var l = unary(); while (peek('*')) { p++; l = l * unary(); } return l; }
  function unary() {
    if (peek('!')) { p++; return !unary(); }
    if (peek('-')) { p++; return -unary(); }
    return postfix();
  }
  function args() {
    var list = [];
    eat('(');
    var arg = function () { return isLambdaStart() ? lambda() : expr(); };
    if (!peek(')')) { list.push(arg()); while (peek(',')) { p++; list.push(arg()); } }
    eat(')');
    return list;
  }
  // `x => body` or `(x) => body` / `() => body`: capture the body's tokens up to the
  // enclosing ',' ')' ']' '}' and evaluate them per call with the parameter bound.
  function lambda() {
    var params = [];
    if (toks[p] && toks[p].t === 'id') {
      params.push(toks[p++].v);
    } else {
      eat('(');
      while (!peek(')')) {
        var id = toks[p++];
        if (!id || id.t !== 'id') throw new Error('bad parameter');
        params.push(id.v);
        if (peek(',')) p++;
      }
      eat(')');
    }
    eat('=>');
    if (peek('{')) throw new Error('block bodies unsupported');
    var start = p, depth = 0;
    for (; p < toks.length; p++) {
      var t = toks[p];
      if (t.t !== 'op') continue;
      if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
      else if (t.v === ')' || t.v === ']' || t.v === '}') { if (depth === 0) break; depth--; }
      else if (t.v === ',' && depth === 0) break;
    }
    var body = toks.slice(start, p);
    if (!body.length) throw new Error('empty arrow body');
    return function () {
      var s = Object.assign({}, scope);
      for (var i = 0; i < params.length; i++) s[params[i]] = arguments[i];
      return gxEvalTokens(body, s);
    };
  }
  function isLambdaStart() {
    var t = toks[p];
    if (!t) return false;
    if (t.t === 'id') return !!toks[p + 1] && toks[p + 1].v === '=>';
    if (t.v !== '(') return false;
    var q = p + 1;
    while (toks[q] && (toks[q].t === 'id' || toks[q].v === ',')) q++;
    return !!toks[q] && toks[q].v === ')' && !!toks[q + 1] && toks[q + 1].v === '=>';
  }
  function fn(a) {
    if (typeof a !== 'function') throw new Error('callback expected');
    return a;
  }
  function postfix() {
    var v = primary();
    for (;;) {
      if (peek('.') || peek('?.')) {
        var optional = toks[p++].v === '?.';
        var name = toks[p++];
        if (!name || name.t !== 'id') throw new Error('bad property');
        if (optional && v == null) {
          if (peek('(')) args();
          v = undefined;
          continue;
        }
        if (peek('(')) {
          var a = args();
          if (v == null) throw new Error('call on null');
          var s = v, arr = Array.isArray(s);
          switch (name.v) {
            case 'trim': v = String(s).trim(); break;
            case 'toLowerCase': v = String(s).toLowerCase(); break;
            case 'toUpperCase': v = String(s).toUpperCase(); break;
            case 'includes': v = (arr ? s : String(s)).indexOf(a[0]) >= 0; break;
            case 'indexOf': v = (arr ? s : String(s)).indexOf(a[0]); break;
            case 'startsWith': v = String(s).indexOf(String(a[0])) === 0; break;
            case 'join': v = arr ? s.join(a.length ? a[0] : ',') : String(s); break;
            case 'slice': v = (arr ? s : String(s)).slice(a[0], a[1]); break;
            case 'toString': v = String(s); break;
            case 'find': if (!arr) throw new Error('find on non-array'); v = s.find(fn(a[0])); break;
            case 'findIndex': if (!arr) throw new Error('findIndex on non-array'); v = s.findIndex(fn(a[0])); break;
            case 'filter': if (!arr) throw new Error('filter on non-array'); v = s.filter(fn(a[0])); break;
            case 'map': if (!arr) throw new Error('map on non-array'); v = s.map(function (x, i) { return fn(a[0])(x, i); }); break;
            case 'some': if (!arr) throw new Error('some on non-array'); v = s.some(fn(a[0])); break;
            case 'every': if (!arr) throw new Error('every on non-array'); v = s.every(fn(a[0])); break;
            default: throw new Error('unsupported method ' + name.v);
          }
        } else if (name.v === 'length') {
          v = v == null ? undefined : v.length;
        } else {
          v = has(v, name.v) ? v[name.v] : undefined;
        }
      } else if (peek('[')) {
        p++;
        var key = expr();
        eat(']');
        v = has(v, key) ? v[key] : undefined;
      } else {
        return v;
      }
    }
  }
  function primary() {
    var t = toks[p++];
    if (!t) throw new Error('unexpected end');
    if (t.t === 'str' || t.t === 'num') return t.v;
    if (t.t === 'id') {
      if (t.v === 'true') return true;
      if (t.v === 'false') return false;
      if (t.v === 'null') return null;
      if (t.v === 'undefined') return undefined;
      return has(scope, t.v) ? scope[t.v] : undefined;
    }
    if (t.v === '(') { var v = expr(); eat(')'); return v; }
    if (t.v === '[') {
      var arr = [];
      if (!peek(']')) { arr.push(expr()); while (peek(',')) { p++; if (peek(']')) break; arr.push(expr()); } }
      eat(']');
      return arr;
    }
    if (t.v === '{') {
      var obj = {};
      if (!peek('}')) {
        do {
          if (peek('}')) break;
          var k = toks[p++];
          if (!k || (k.t !== 'id' && k.t !== 'str' && k.t !== 'num')) throw new Error('bad key');
          eat(':');
          obj[k.v] = expr();
        } while (peek(',') && ++p);
      }
      eat('}');
      return obj;
    }
    throw new Error('unexpected ' + t.v);
  }

  var result = expr();
  if (p !== toks.length) throw new Error('trailing tokens');
  return result;
}

function gxTry(src, scope, fallback) {
  try { return gxEval(src, scope); } catch (e) { return fallback; }
}

function gxIdentifiers(src) {
  try { return gxTokenize(src).filter(function (t) { return t.t === 'id'; }).map(function (t) { return t.v; }); }
  catch (e) { return []; }
}

// ---------- Markup scanning helpers ----------

// Index of the bracket closing the one at `open`, skipping quoted strings.
function findClose(s, open) {
  var openCh = s[open], closeCh = openCh === '{' ? '}' : openCh === '(' ? ')' : ']';
  var depth = 0, quote = null;
  for (var i = open; i < s.length; i++) {
    var c = s[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === openCh) depth++;
    else if (c === closeCh && --depth === 0) return i;
  }
  return -1;
}

// Index of the '>' ending a tag, skipping '>' inside {...} and quotes (e.g. onClick={() => ...}).
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

// Raw source of attribute `name={...}` inside a tag's attribute text.
function attrExpr(attrs, name) {
  var m = new RegExp('(^|\\s)' + name + '=\\{').exec(attrs);
  if (!m) return null;
  var open = m.index + m[0].length - 1, close = findClose(attrs, open);
  return close < 0 ? null : attrs.slice(open + 1, close).trim();
}

function oneLine(s) {
  return s.split('\n').map(function (l) { return l.trim(); }).join(' ').trim();
}

// ---------- Transforms ----------

function expandEach(text, state) {
  var re = /\{#each\s+([\s\S]+?)\s+as\s+(\w+)(?:\s*,\s*(\w+))?\s*\}([\s\S]*?)\{\/each\}/;
  for (var guard = 0; guard < 50; guard++) {
    var m = re.exec(text);
    if (!m) break;
    var list = gxTry(m[1], state, []);
    if (!Array.isArray(list)) list = [];
    var itemName = m[2], idxName = m[3], body = m[4], out = '';
    list.forEach(function (item, idx) {
      var scope = Object.assign({}, state);
      scope[itemName] = item;
      if (idxName) scope[idxName] = idx;
      out += body.replace(/(=)?\{([^{}#\/:@][^{}]*)\}/g, function (full, eqSign, src) {
        var ids = gxIdentifiers(src);
        if (ids.indexOf(itemName) < 0 && (!idxName || ids.indexOf(idxName) < 0)) return full;
        var v = gxTry(src, scope, undefined);
        if (v === undefined) return full;
        return eqSign ? '="' + escAttr(v) + '"' : escText(v);
      });
    });
    text = text.slice(0, m.index) + out + text.slice(m.index + m[0].length);
  }
  return text;
}

// A radio label may be plain text or markup (a box with a bold title and a secondary line).
// Each non-empty line becomes one line of the label; DIL tags and inline markdown are rendered.
// Output stays on one line so it remains inside the surrounding HTML block for marked.
function radioLabel(text) {
  var lines = text.replace(/<\/?box\b[^>]*>/g, '\n').split('\n')
    .map(function (l) { return l.trim(); }).filter(Boolean);
  if (lines.length === 1 && !/[<*_`]/.test(lines[0])) return escText(lines[0]);
  return lines.map(function (l) {
    var html = typeof marked !== 'undefined' && marked.parseInline ? marked.parseInline(transformDil(l)) : escText(l);
    return '<span class="gx-label-line">' + html.replace(/\n/g, ' ') + '</span>';
  }).join('');
}

function transformRadioGroups(text, state) {
  return text.replace(/<radio-group\b([^>]*)>([\s\S]*?)<\/radio-group>/g, function (_, attrs, inner) {
    var a = parseDilAttrs(attrs);
    var bound = /^\w+$/.test(a.value || '') ? a.value : '';
    var current = bound && Object.prototype.hasOwnProperty.call(state, bound) ? String(state[bound]) : null;
    var group = 'gx' + (++_gxSeq);
    var items = '';
    inner.replace(/<radio\b([^>]*)>([\s\S]*?)<\/radio>/g, function (__, rAttrs, label) {
      var rv = parseDilAttrs(rAttrs).value;
      var valueExpr = attrExpr(rAttrs, 'value');
      if (valueExpr) rv = gxTry(valueExpr, state, valueExpr);
      var text = label.trim();
      var val = rv != null && rv !== '' ? String(rv) : oneLine(text.replace(/<[^>]*>/g, ''));
      items += '<label class="gx-radio"><input type="radio" name="' + group + '" value="' + escAttr(val) + '"' +
        (current !== null && current === val ? ' checked' : '') + '><span class="gx-dot"></span><span class="gx-label">' +
        radioLabel(text) + '</span></label>';
      return '';
    });
    return '\n\n<div class="gx-radio-group' + (a.direction === 'row' ? ' gx-row' : '') + '"' +
      (bound ? ' data-state="' + escAttr(bound) + '"' : '') + '>' + items + '</div>\n\n';
  });
}

function condBlock(cond, body, state) {
  var visible = !!gxTry(cond, state, false);
  return '\n\n<div class="gx-cond" data-gx-if="' + escAttr(cond) + '"' + (visible ? '' : ' hidden') + '>' + oneLine(body) + '</div>\n\n';
}

function transformIfs(text, state) {
  var out = '', i = 0;
  for (;;) {
    var start = text.indexOf('{#if', i);
    if (start < 0) break;
    var condEnd = findClose(text, start);
    if (condEnd < 0) break;
    var cond = text.slice(start + 4, condEnd).trim();
    var depth = 1, j = condEnd + 1, elseAt = -1;
    while (depth > 0) {
      var nIf = text.indexOf('{#if', j), nEnd = text.indexOf('{/if}', j), nElse = text.indexOf('{:else}', j);
      if (nEnd < 0) { depth = -1; break; }
      var next = Math.min.apply(null, [nIf, nEnd, nElse].filter(function (x) { return x >= 0; }));
      if (next === nIf) { depth++; j = nIf + 4; }
      else if (next === nElse) { if (depth === 1 && elseAt < 0) elseAt = nElse; j = nElse + 7; }
      else { depth--; j = nEnd + 5; }
    }
    if (depth !== 0) break;
    var endIdx = j - 5;
    var thenPart = transformIfs(text.slice(condEnd + 1, elseAt >= 0 ? elseAt : endIdx), state);
    var elsePart = elseAt >= 0 ? transformIfs(text.slice(elseAt + 7, endIdx), state) : null;
    out += text.slice(i, start) + condBlock(cond, thenPart, state) +
      (elsePart !== null ? condBlock('!(' + cond + ')', elsePart, state) : '');
    i = j;
  }
  return out + text.slice(i);
}

function transformInputs(text, state) {
  return text.replace(/<(textarea|input)\b([^>]*?)\/?>(?:\s*<\/textarea>)?/g, function (_, tag, attrs) {
    var a = parseDilAttrs(attrs);
    var bound = /^\w+$/.test(a.value || '') ? a.value : '';
    var init = bound && state[bound] != null ? String(state[bound]) : '';
    var common = (a.placeholder ? ' placeholder="' + escAttr(a.placeholder) + '"' : '') +
      (bound ? ' data-state="' + escAttr(bound) + '"' : '');
    if (tag === 'textarea') {
      return '<textarea class="gx-textarea" rows="' + (parseInt(a.rows, 10) || 2) + '"' + common + '>' + escText(init) + '</textarea>';
    }
    return '<input type="text" class="gx-input"' + common + ' value="' + escAttr(init) + '">';
  });
}

// Button text may contain <icon .../>: render icons, drop any other tags, escape the rest.
function buttonLabel(label) {
  return label.split(/(<icon\b[^>]*>)/i).map(function (part, i) {
    if (i % 2 === 0) return escText(part.replace(/<\/?[A-Za-z][^>]*>/g, ''));
    var m = part.match(/^<icon\b([^>]*?)\/?>$/i);
    return m ? dilTagToHtml('icon', m[1].trim()) : '';
  }).join('');
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
    var onClick = attrExpr(attrs, 'onClick') || '';
    var callAt = onClick.indexOf('GenUI.issueNewTurn(');
    if (callAt >= 0) {
      var open = callAt + 'GenUI.issueNewTurn'.length;
      var closeParen = findClose(onClick, open);
      var turnExpr = closeParen > open ? onClick.slice(open + 1, closeParen).trim() : '';
      var disabledExpr = attrExpr(attrs, 'disabled');
      out += '<button type="button" class="gx-button' + (/(^|\s)block(\s|=|\/|$)/.test(attrs) ? ' gx-block' : '') +
        '" data-gx-submit="1" data-gx-turn="' + escAttr(turnExpr) + '"' +
        (disabledExpr ? ' data-gx-disabled="' + escAttr(disabledExpr) + '"' : '') + '>' + buttonLabel(label) + '</button>';
    } else {
      out += '<span class="dil-button">' + buttonLabel(label) + '</span>';
    }
    i = close + 9;
  }
  return out + text.slice(i);
}

function transformTextExprs(text, state) {
  return text.replace(/(^|[^=\w"'])\{([A-Za-z_$][^{}\n]*)\}/g, function (full, lead, src) {
    var ids = gxIdentifiers(src);
    if (!ids.length || ids.some(function (id) { return !Object.prototype.hasOwnProperty.call(state, id) && !/^(true|false|null|undefined)$/.test(id); })) return full;
    var v = gxTry(src, state, undefined);
    return lead + '<span class="gx-expr" data-gx-expr="' + escAttr(src) + '">' + escText(v == null ? '' : v) + '</span>';
  });
}

// {@body const [x, setX] = DIL.useState(init)} and {@body const name = expr} (data such as
// a list of choices, possibly spanning lines). Each declaration is evaluated in order and removed.
function readBodyDeclarations(text, state) {
  var out = '', i = 0;
  for (;;) {
    var start = text.indexOf('{@body', i);
    if (start < 0) break;
    var close = findClose(text, start);
    if (close < 0) break;
    out += text.slice(i, start);
    var decl = text.slice(start + 6, close).trim(), m;
    if ((m = /^const\s+\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*DIL\.useState\(([\s\S]*)\)$/.exec(decl))) {
      state[m[1]] = gxTry(m[2].trim(), state, m[2].trim());
    } else if ((m = /^(?:const|let)\s+(\w+)\s*=\s*([\s\S]+)$/.exec(decl))) {
      var v = gxTry(m[2].trim().replace(/;$/, ''), state, undefined);
      if (v !== undefined) state[m[1]] = v;
    }
    i = close + 1;
    // Drop the rest of the declaration's line if it is otherwise empty.
    var eol = text.indexOf('\n', i);
    if (/^[ \t]*$/.test(text.slice(i, eol < 0 ? text.length : eol)) && /(^|\n)[ \t]*$/.test(out)) i = eol < 0 ? text.length : eol + 1;
  }
  return out + text.slice(i);
}

function transformGenUI(text) {
  if (!/DIL\.|GenUI\.|<radio-group|<textarea|<input|\{#(if|each)/.test(text)) return text;
  var state = {};

  text = readBodyDeclarations(text, state);

  text = expandEach(text, state);
  // Before radio groups: the radio transform emits its own <input type="radio"> tags.
  text = transformInputs(text, state);
  text = transformRadioGroups(text, state);
  text = transformIfs(text, state);
  text = transformButtons(text);
  text = transformTextExprs(text, state);
  text = text.replace(/\{#(?:if|each)\b[^}]*\}|\{\/(?:if|each)\}|\{:else\}|\{#else\}/g, '');

  if (Object.keys(state).length) {
    text = '<span class="gx-state" hidden data-init="' + escAttr(JSON.stringify(state)) + '"></span>\n\n' + text;
  }
  return text;
}

// ---------- Runtime ----------

function gxRoot(el) {
  return el.closest('.msg-assistant') || document.body;
}

function gxState(root) {
  var st = {};
  root.querySelectorAll('.gx-state').forEach(function (el) {
    try { Object.assign(st, JSON.parse(el.getAttribute('data-init'))); } catch (e) {}
  });
  root.querySelectorAll('.gx-radio-group[data-state]').forEach(function (group) {
    var sel = group.querySelector('input:checked');
    if (sel) st[group.getAttribute('data-state')] = sel.value;
  });
  root.querySelectorAll('.gx-textarea[data-state], .gx-input[data-state]').forEach(function (el) {
    st[el.getAttribute('data-state')] = el.value;
  });
  return st;
}

function gxSync(root) {
  var st = gxState(root);
  root.querySelectorAll('[data-gx-if]').forEach(function (el) {
    el.hidden = !gxTry(el.getAttribute('data-gx-if'), st, false);
  });
  root.querySelectorAll('[data-gx-expr]').forEach(function (el) {
    var v = gxTry(el.getAttribute('data-gx-expr'), st, '');
    el.textContent = v == null ? '' : String(v);
  });
  if (root.classList.contains('gx-answered')) return;
  root.querySelectorAll('[data-gx-submit]').forEach(function (btn) {
    var expr = btn.getAttribute('data-gx-disabled');
    btn.disabled = expr ? !!gxTry(expr, st, false) : false;
  });
}

// Fallback when the button's expression can't be interpreted: visible text box, else chosen label.
function gxFallbackAnswer(root) {
  var box = root.querySelector('.gx-cond:not([hidden]) .gx-textarea, .gx-cond:not([hidden]) .gx-input');
  if (box && box.value.trim()) return box.value.trim();
  var sel = root.querySelector('.gx-radio input:checked');
  if (sel) {
    var label = sel.closest('.gx-radio').querySelector('.gx-label-line, .gx-label');
    return label ? label.textContent.trim() : sel.value;
  }
  return '';
}

function gxTurnText(btn, root) {
  var expr = btn.getAttribute('data-gx-turn');
  var v = expr ? gxTry(expr, gxState(root), undefined) : undefined;
  if (v && typeof v === 'object') v = v.text || v.prompt || v.content || JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : gxFallbackAnswer(root);
}

function hydrateGenUI(messageEl) {
  if (messageEl.querySelector('[data-gx-submit], [data-gx-if], [data-gx-expr]')) gxSync(messageEl);
}

document.addEventListener('change', function (e) {
  if (e.target.matches && e.target.matches('.gx-radio input')) gxSync(gxRoot(e.target));
});

document.addEventListener('input', function (e) {
  if (e.target.matches && e.target.matches('.gx-textarea, .gx-input')) gxSync(gxRoot(e.target));
});

document.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('[data-gx-submit]');
  if (!btn || btn.disabled) return;
  var root = gxRoot(btn);
  var text = gxTurnText(btn, root);
  if (!text || !window.chatApp || !window.chatApp.canSend()) return;
  root.classList.add('gx-answered');
  root.querySelectorAll('.gx-radio input, .gx-textarea, .gx-input, [data-gx-submit]').forEach(function (el) { el.disabled = true; });
  window.chatApp.sendText(text);
});
