// Transient toast notifications, bottom-center, like the little confirmations on chatgpt.com.
// Exposes window.toast(message, opts?) where opts = { type: 'success'|'error'|'info', duration, icon }.
// Distinct from setStatus(), which keeps the persistent "Ready/Thinking…" label in the footer.
(function () {
  var TYPE_ICON = { success: 'circle-check', error: 'alert-circle', info: 'info' };

  function toast(message, opts) {
    opts = opts || {};
    var stack = document.getElementById('toast-stack');
    if (!stack) return null;

    var el = document.createElement('div');
    el.className = 'toast' + (opts.type ? ' toast-' + opts.type : '');
    el.setAttribute('role', 'status');

    var iconName = opts.icon || TYPE_ICON[opts.type];
    if (iconName && typeof icon === 'function') {
      var ic = document.createElement('span');
      ic.className = 'toast-ico';
      ic.innerHTML = icon(iconName, 17);
      if (ic.firstChild) el.appendChild(ic);
    }

    var msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = message;
    el.appendChild(msg);

    stack.appendChild(el);
    // Keep the stack short so a burst of actions can't pile up forever.
    while (stack.children.length > 4) stack.firstChild.remove();

    // Next frame: flip to the shown state so the enter transition runs.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { el.classList.add('show'); });
    });

    var removed = false;
    function remove() {
      if (removed) return;
      removed = true;
      el.classList.remove('show');
      el.classList.add('hide');
      var gone = function () { el.remove(); };
      el.addEventListener('transitionend', gone, { once: true });
      setTimeout(gone, 400); // fallback if transitionend doesn't fire
    }

    var ms = opts.duration || 2600;
    var timer = setTimeout(remove, ms);
    // Clicking a toast dismisses it early.
    el.addEventListener('click', function () { clearTimeout(timer); remove(); });

    return el;
  }

  window.toast = toast;
})();
