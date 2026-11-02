// Client behaviour of the LinkedIn stand-in: the invitation dialog, the "More" menu and the message composer.
(() => {
  const body = document.body;
  const dialogRoot = document.getElementById('dialog-root');
  const msgRoot = document.getElementById('msg-root');

  function closeDialog() {
    dialogRoot.innerHTML = '';
  }

  function showLimit() {
    dialogRoot.innerHTML =
      '<div role="dialog" class="artdeco-modal" aria-labelledby="limit-title">' +
      '<h2 id="limit-title">You’ve reached the weekly invitation limit</h2>' +
      '<p>LinkedIn limits how many invitations you can send each week. Try again next week.</p>' +
      '<button aria-label="Got it" data-dialog="close">Got it</button></div>';
  }

  async function postInvite(slug, note) {
    const res = await fetch('/__invite', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, note }) });
    if (res.status === 429) return showLimit();
    window.__invited = { slug, note };
    closeDialog();
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
      if (kind === 'send-plain') postInvite(slug, '');
      if (kind === 'note') {
        dialog.innerHTML =
          '<button aria-label="Dismiss" data-dialog="close">x</button>' +
          '<h2 id="invite-title">Add a note to your invitation</h2>' +
          '<textarea id="custom-message" name="message" maxlength="300" placeholder="Ex: We know each other from..."></textarea>' +
          '<button aria-label="Send invitation" data-dialog="send" disabled>Send</button>';
        const box = dialog.querySelector('textarea');
        const send = dialog.querySelector('[data-dialog="send"]');
        box.addEventListener('input', () => { send.disabled = box.value.trim() === ''; });
      }
      if (kind === 'send') postInvite(slug, dialog.querySelector('textarea').value);
    });
  }

  function showComposer(slug, name) {
    msgRoot.innerHTML =
      '<aside class="msg-overlay-conversation-bubble">' +
      '<header>' + name + '</header>' +
      '<ul class="msg-s-message-list"></ul>' +
      '<form class="msg-form"><div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message…"></div>' +
      '<button type="submit" class="msg-form__send-button" disabled>Send</button></form></aside>';
    const box = msgRoot.querySelector('.msg-form__contenteditable');
    const send = msgRoot.querySelector('.msg-form__send-button');
    box.addEventListener('input', () => { send.disabled = box.innerText.trim() === ''; });
    msgRoot.querySelector('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = box.innerText.trim();
      await fetch('/__message', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug, text }) });
      window.__sent = { slug, text };
      box.innerHTML = '';
      send.disabled = true;
    });
  }

  document.addEventListener('click', (e) => {
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
  dialogRoot.addEventListener('click', (e) => {
    if (e.target.closest('[data-dialog="close"]')) closeDialog();
  });
})();
