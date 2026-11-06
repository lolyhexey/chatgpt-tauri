function renderToolBlock(call, result) {
  var failed = !!(result && result.error);
  var block = document.createElement('div');
  block.className = 'tool-block' + (failed ? ' tool-failed' : '');

  var head = document.createElement('button');
  head.type = 'button';
  head.className = 'tool-head';
  head.innerHTML = icon('wrench', 15) +
    '<span class="tool-title">' + (failed ? 'Failed ' : 'Used ') + '<b>' + escText(call.name) + '</b></span>' +
    icon('chevron-right', 15, 'tool-chev');

  var body = document.createElement('div');
  body.className = 'tool-body';
  body.hidden = true;

  var args = document.createElement('pre');
  args.className = 'tool-pre';
  args.textContent = typeof call.args === 'string' ? call.args : JSON.stringify(call.args, null, 2);
  body.appendChild(args);

  if (result) {
    var out = document.createElement('pre');
    out.className = 'tool-pre tool-out' + (failed ? ' is-error' : '');
    var text = result.error || result.result || '(no output)';
    out.textContent = text.length > 4000 ? text.slice(0, 4000) + '\n…(truncated)' : text;
    body.appendChild(out);
  }

  head.addEventListener('click', function () {
    body.hidden = !body.hidden;
    block.classList.toggle('open', !body.hidden);
  });

  block.appendChild(head);
  block.appendChild(body);
  return block;
}
