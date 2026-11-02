// Client behaviour of the LinkedIn stand-in: the invitation dialog, the "More" menu, chat windows, and the
// messaging page where a row is a div that opens its thread on click (no link), as on LinkedIn today.
(() => {
  const body = document.body;
  const dialogRoot = document.getElementById('dialog-root');
  const msgRoot = document.getElementById('msg-root');

  function toast(text) {
    const el = document.createElement('div');
    el.setAttribute('role', 'alert');
    el.className = 'artdeco-toast-item';
    el.textContent = text;
    document.body.appendChild(el);
  }

  function closeDialog() {
    if (dialogRoot) dialogRoot.innerHTML = '';
  }

  function showLimit() {
    dialogRoot.innerHTML =
      '<div role="dialog" class="artdeco-modal" aria-labelledby="limit-title">' +
      '<h2 id="limit-title">You’ve reached the weekly invitation limit</h2>' +
      '<p>LinkedIn limits how many invitations you can send each week. Try again next week.</p>' +
      '<button aria-label="Got it" data-dialog="close">Got it</button></div>';
  }

  function markPending(slug, name) {
    if (slug !== body.dataset.slug) return;
    const actions = document.querySelector('.pvs-profile-actions');
    if (actions) {
      actions.innerHTML =
        '<button class="artdeco-button" aria-label="Pending, click to withdraw invitation sent to ' + name + '"><span class="artdeco-button__text">Pending</span></button>';
    }
  }

  async function postInvite(slug, name, note) {
    const res = await fetch('/__invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, note }) });
    if (res.status === 429) return showLimit();
    closeDialog();
    // An error closes the dialog too; only a successful send leaves a Pending button behind.
    if (res.status !== 200) return toast('Something went wrong. Please try again.');
    window.__invited = { slug, note };
    markPending(slug, name);
  }

  function showInvite(slug, name) {
    dialogRoot.innerHTML =
      '<div role="dialog" class="artdeco-modal send-invite" aria-labelledby="invite-title">' +
      '<button aria-label="Dismiss" data-dialog="close">x</button>' +
      '<h2 id="invite-title">Add a note to your invitation?</h2>' +
      '<p>Personalize your invitation to ' + name + ' by adding a note.</p>' +
      '<button aria-label="Add a note" data-dialog="note">Add a note</button>' +
      '<button aria-label="Send without a note" data-dialog="send-plain">Send without a note</button></div>';
    const dialog = dialogRoot.firstElementChild;
    dialog.addEventListener('click', (e) => {
      const kind = e.target.closest('[data-dialog]')?.dataset.dialog;
      if (kind === 'close') closeDialog();
      if (kind === 'send-plain') postInvite(slug, name, '');
      if (kind === 'note' && body.dataset.notes === 'upsell') {
        // A free account that has used its personalised notes: a Premium offer, no text box, no way to send from it.
        dialog.innerHTML =
          '<button aria-label="Dismiss" data-dialog="close">x</button>' +
          '<h2 id="invite-title">Add a note to your invitation</h2>' +
          '<p>You’ve used your personalized invitations for this month. Try Premium to send more.</p>' +
          '<button aria-label="Try Premium for free" data-dialog="premium">Try Premium for free</button>';
      } else if (kind === 'note') {
        dialog.innerHTML =
          '<button aria-label="Dismiss" data-dialog="close">x</button>' +
          '<h2 id="invite-title">Add a note to your invitation</h2>' +
          '<textarea id="custom-message" name="message" maxlength="300" placeholder="Ex: We know each other from..."></textarea>' +
          '<button aria-label="Send invitation" data-dialog="send" disabled>Send</button>';
        const box = dialog.querySelector('textarea');
        const send = dialog.querySelector('[data-dialog="send"]');
        box.addEventListener('input', () => { send.disabled = box.value.trim() === ''; });
      }
      if (kind === 'send') postInvite(slug, name, dialog.querySelector('textarea').value);
    });
  }

  // Chat windows. `sticky` ones ignore their close button, so the test can tell scoping from closing.
  function showComposer(slug, name, opts = {}) {
    const bubble = document.createElement('aside');
    bubble.className = 'msg-overlay-conversation-bubble';
    bubble.innerHTML =
      '<header class="msg-overlay-bubble-header"><span class="msg-overlay-bubble-header__title">' + name + '</span>' +
      '<button aria-label="Close your conversation with ' + name + '" class="msg-overlay-bubble-header__control--close-btn">x</button></header>' +
      '<ul class="msg-s-message-list"></ul>' +
      '<form class="msg-form"><div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message…"></div>' +
      '<button type="submit" class="msg-form__send-button" disabled>Send</button></form>';
    msgRoot.appendChild(bubble);
    const box = bubble.querySelector('.msg-form__contenteditable');
    const send = bubble.querySelector('.msg-form__send-button');
    const list = bubble.querySelector('.msg-s-message-list');
    bubble.querySelector('header button').addEventListener('click', () => { if (!opts.sticky) bubble.remove(); });
    box.addEventListener('input', () => { send.disabled = box.innerText.trim() === ''; });
    bubble.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = box.innerText.trim();
      // The box empties straight away, as LinkedIn does; whether the message was really sent shows in the list.
      box.innerHTML = '';
      send.disabled = true;
      const res = await fetch('/__message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, text }) });
      if (res.status !== 200) return toast('Message failed to send. Try again.');
      const item = document.createElement('li');
      item.className = 'msg-s-message-list__event';
      const text_ = document.createElement('div');
      text_.className = 'msg-s-event-listitem__body';
      text_.textContent = text;
      item.appendChild(text_);
      list.appendChild(item);
      window.__sent = { slug, text };
    });
  }

  // Messaging page: rows without links open their thread in the panel and move the address.
  function renderPanel(thread) {
    const panel = document.getElementById('thread-panel');
    panel.innerHTML =
      '<header class="msg-title-bar"><a class="msg-thread__link-to-profile" href="/in/' + thread.slug + '/">' + thread.name + '</a></header>' +
      '<ul class="msg-s-message-list">' +
      thread.messages.map((m) => '<li class="msg-s-message-list__event"><div class="msg-s-event-listitem__body"></div></li>').join('') +
      '</ul>';
    panel.querySelectorAll('.msg-s-event-listitem__body').forEach((el, i) => { el.textContent = thread.messages[i]; });
  }

  document.addEventListener('click', async (e) => {
    const row = e.target.closest('div[data-thread]');
    if (row) {
      const id = row.dataset.thread;
      const res = await fetch('/__thread/' + id);
      const thread = await res.json();
      // The address changes first, then the panel fills in, as on the real site.
      history.pushState({}, '', '/messaging/thread/' + id + '/');
      setTimeout(() => renderPanel(thread), 150);
      return;
    }
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const action = target.dataset.action;
    const slug = target.dataset.slug || body.dataset.slug;
    const name = target.dataset.name || body.dataset.name;
    if (action === 'more') {
      const menu = document.getElementById('more-menu');
      if (menu) menu.hidden = !menu.hidden;
    }
    if (action === 'connect') {
      const menu = document.getElementById('more-menu');
      if (menu) menu.hidden = true;
      if (body.dataset.limit === 'on-connect' && slug === body.dataset.slug) showLimit();
      else showInvite(slug, name);
    }
    if (action === 'message') showComposer(slug, name);
  });
  if (dialogRoot) {
    dialogRoot.addEventListener('click', (e) => {
      if (e.target.closest('[data-dialog="close"]')) closeDialog();
    });
  }
  // LinkedIn restores chat windows opened earlier when a page loads.
  if (msgRoot && body.dataset.bubble) showComposer('decoy-two', 'Yan Decoy', { sticky: body.dataset.bubble === 'sticky' });
})();
