// Real-time layer + WhatsApp-style chat panel.
//   * one Socket.IO connection per page (authenticated with the normal session cookie)
//   * chat panel: history paging, multi-select (checkbox or long-press), bulk delete
//     (for me / for everyone), bulk download, attachment previews inside the input bar,
//     optimistic "sending…" bubbles with retry, reconnect handling
//   * live events for tasks, announcements, teams, leave requests
(function () {
  if (!window.io) return;
  const U = window.PortalUpload;
  const toast = (m, t) => window.toast && window.toast(m, t);
  const isCoarse = matchMedia('(pointer: coarse)').matches;

  let socket = null;
  let state = null; // the chat panel currently on screen
  let wasDisconnected = false;

  const AJAX = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ------------------------------------------------------------------ socket
  function connect() {
    socket = window.io({ withCredentials: true });

    socket.on('connect', () => {
      if (state) {
        join();
        if (wasDisconnected) syncLatest().finally(() => setStatus('ok')); else setStatus('ok');
      }
      wasDisconnected = false;
    });
    socket.on('disconnect', () => { wasDisconnected = true; setStatus('reconnecting'); });
    socket.io.on('reconnect_attempt', () => setStatus('reconnecting'));
    socket.on('connect_error', (err) => {
      wasDisconnected = true;
      if (err && err.message === 'unauthorized') { setStatus('expired'); socket.disconnect(); return; }
      setStatus('reconnecting');
    });

    socket.on('message:new', (m) => {
      if (!state || m.threadId !== state.threadId) return;
      // our own message is about to be swapped in from the HTTP response; don't show it twice
      const probe = document.createElement('template'); probe.innerHTML = m.html;
      const first = probe.content.querySelector('.chat-bubble');
      if (first && first.dataset.sender === state.myKey && state.log.querySelector('.chat-bubble.pending:not(.failed)')) return;
      appendHtml(m.html, false);
    });
    socket.on('message:deleted', (m) => {
      if (!state || m.threadId !== state.threadId) return;
      m.ids.forEach((id) => { const b = bubbleById(id); if (b) markDeleted(b); });
    });
    socket.on('chat:notify', (n) => {
      if (state && n.threadId === state.threadId) return;
      toast(`New message from ${n.from}`);
      const work = document.querySelector('.nav-link[href="/employee/tab/work"]');
      if (work && !work.querySelector('.nav-dot')) work.insertAdjacentHTML('beforeend', '<span class="nav-dot" data-nav="work"></span>');
    });

    socket.on('task:updated', (d) => {
      const p = document.getElementById('tasks-panel');
      if (!p || Number(p.dataset.employeeId) !== Number(d.employeeId)) return;
      const typing = [...p.querySelectorAll('textarea')].some((t) => t.value) || p.querySelector('[data-uploader] .chip');
      if (typing) return toast('Work list changed. Reload the tab to see the update (your draft is kept for now).');
      window.htmx.ajax('GET', p.dataset.refreshUrl, { target: '#tasks-panel', swap: 'outerHTML' });
    });

    socket.on('announcement:new', (a) => {
      toast(`New announcement: ${a.topic}`);
      if (document.getElementById('employee-announcements')) {
        window.htmx.ajax('GET', '/employee/tab/announcements', { target: '#main-panel', swap: 'innerHTML' });
      } else {
        const link = document.querySelector('.nav-link[href="/employee/tab/announcements"]');
        if (!link) return;
        let badge = link.querySelector('.nav-badge');
        if (!badge) { link.insertAdjacentHTML('beforeend', '<span class="nav-badge" data-nav="announcements">0</span>'); badge = link.querySelector('.nav-badge'); }
        badge.textContent = String((parseInt(badge.textContent, 10) || 0) + 1);
      }
    });
    socket.on('announcement:deleted', (a) => {
      const card = document.getElementById(`announcement-${a.id}`);
      if (card) card.remove();
    });

    socket.on('team:updated', (t) => {
      const teamRoot = document.getElementById('team-root');
      const here = teamRoot && Number(teamRoot.dataset.teamId) === Number(t.teamId);
      const role = teamRoot && teamRoot.dataset.role;
      if (!here) return toast(t.by ? `${t.by} submitted work to a team` : 'One of your teams was updated');
      if (t.full) return window.htmx.ajax('GET', location.pathname, { target: '#main-panel', swap: 'innerHTML' });
      const typing = document.querySelector('#team-assignments textarea') && [...document.querySelectorAll('#team-assignments textarea')].some((x) => x.value);
      if (typing || document.querySelector('#team-assignments [data-uploader] .chip')) return toast('The assignments changed. Reload this page when you are done typing.');
      const base = role === 'admin' ? '/admin/teams/' : '/employee/teams/';
      window.htmx.ajax('GET', `${base}${t.teamId}/assignments`, { target: '#team-assignments', swap: 'outerHTML' });
    });

    socket.on('leave:new', (d) => toast(`${d.name} sent a leave request`));
    socket.on('leave:decided', (d) => toast(`Your leave request was ${d.status}.`, d.status === 'approved' ? 'success' : undefined));
  }

  // ------------------------------------------------------------ status banner
  function setStatus(kind) {
    if (!state) return;
    const el = state.el.querySelector('[data-chat-status]');
    const txt = state.el.querySelector('[data-chat-status-text]');
    if (!el) return;
    el.classList.toggle('is-error', kind === 'expired' || kind === 'error');
    if (kind === 'ok') { el.hidden = true; return; }
    el.hidden = false;
    txt.textContent = kind === 'reconnecting' ? 'Reconnecting… messages you send will wait until you are back online.'
      : kind === 'expired' ? 'Your session ended. Please log in again.' : 'Could not open this conversation.';
  }

  function join() {
    if (!state || !socket || !socket.connected) return;
    socket.emit('join', { threadId: state.threadId }, (res) => { if (!res || !res.ok) setStatus('error'); });
  }

  // ------------------------------------------------------------- panel setup
  function initPanel() {
    const el = document.getElementById('chat-panel');
    if (state && state.el !== el) {
      if (socket && socket.connected) socket.emit('leave', { threadId: state.threadId });
      state = null;
    }
    if (!el || (state && state.el === el)) return;
    const form = el.querySelector('#chat-form');
    state = {
      el, log: el.querySelector('#chat-log'), form,
      threadId: Number(el.dataset.threadId), myKey: el.dataset.myKey, isAdmin: el.dataset.isAdmin === '1',
      hasMore: el.dataset.hasMore === '1', oldestId: el.dataset.oldestId ? Number(el.dataset.oldestId) : null,
      selected: new Set(), selecting: false, loadingOlder: false, suppressClick: false,
      selectbar: el.querySelector('[data-chat-selectbar]'), dialog: el.querySelector('[data-chat-dialog]'),
      older: el.querySelector('[data-chat-older]'),
    };
    decorate(state.log);
    scrollToBottom();
    bindPanel();
    if (socket && socket.connected) join();
  }

  const fmtTime = (iso) => {
    const d = new Date(iso); const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (d.toDateString() === now.toDateString()) return time;
    const opts = d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' };
    return `${d.toLocaleDateString([], opts)}, ${time}`;
  };

  // left/right placement + local time; done in the browser because the HTML is the same for everybody
  function decorate(scope) {
    scope.querySelectorAll('.chat-bubble:not([data-decorated])').forEach((b) => {
      b.dataset.decorated = '1';
      const mine = b.dataset.sender === state.myKey;
      b.classList.toggle('mine', mine);
      b.classList.toggle('theirs', !mine);
      const t = b.querySelector('time[datetime]');
      if (t) t.textContent = fmtTime(t.getAttribute('datetime'));
    });
  }

  const bubbleById = (id) => state && state.log.querySelector(`.chat-bubble[data-id="${id}"]`);
  const nearBottom = () => state.log.scrollHeight - state.log.scrollTop - state.log.clientHeight < 140;
  const scrollToBottom = () => { if (state) state.log.scrollTop = state.log.scrollHeight; };

  function appendHtml(html, forceScroll) {
    const stick = forceScroll || nearBottom();
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    let added = false;
    tpl.content.querySelectorAll('.chat-bubble').forEach((b) => {
      if (bubbleById(b.dataset.id)) return; // already there (own message via response AND socket)
      state.log.appendChild(b);
      added = true;
    });
    if (added) { const empty = state.log.querySelector('.chat-empty'); if (empty) empty.remove(); decorate(state.log); }
    if (stick) scrollToBottom();
  }

  function markDeleted(b) {
    b.classList.add('is-deleted');
    b.classList.remove('selected');
    b.dataset.fileIds = '';
    b.querySelectorAll('.bubble-body, .bubble-files').forEach((n) => n.remove());
    b.insertAdjacentHTML('beforeend', '<p class="bubble-body bubble-deleted">This message was deleted</p>');
  }

  // ------------------------------------------------------------ history paging
  async function loadOlder() {
    if (!state || state.loadingOlder || !state.hasMore) return;
    state.loadingOlder = true;
    state.older.textContent = 'Loading…';
    try {
      const res = await fetch(`/chat/${state.threadId}/messages?before=${state.oldestId}`, { credentials: 'same-origin', headers: AJAX });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const before = state.log.scrollHeight;
      state.older.insertAdjacentHTML('afterend', data.html);
      decorate(state.log);
      state.log.scrollTop += state.log.scrollHeight - before; // keep the reading position
      state.hasMore = data.hasMore;
      if (data.oldestId) state.oldestId = data.oldestId;
    } catch (err) { toast('Could not load earlier messages.', 'error'); }
    state.older.textContent = 'Load earlier messages';
    state.older.hidden = !state.hasMore;
    state.loadingOlder = false;
  }

  // After a dropped connection / Render waking up: fetch the newest page again from PostgreSQL.
  async function syncLatest() {
    if (!state) return;
    try {
      const res = await fetch(`/chat/${state.threadId}/messages`, { credentials: 'same-origin', headers: AJAX });
      if (res.status === 401) return setStatus('expired');
      if (!res.ok) return;
      const data = await res.json();
      const stick = nearBottom();
      const keep = new Set(state.selected);
      state.log.querySelectorAll('.chat-bubble:not(.pending), .chat-empty').forEach((n) => n.remove());
      state.older.insertAdjacentHTML('afterend', data.html || '<p class="chat-empty">No messages yet. Say hello.</p>');
      state.hasMore = data.hasMore; state.oldestId = data.oldestId;
      state.older.hidden = !data.hasMore;
      decorate(state.log);
      state.selected = new Set([...keep].filter((id) => bubbleById(id)));
      state.selected.forEach((id) => bubbleById(id).classList.add('selected'));
      if (state.selecting && !state.selected.size) setSelecting(false); else updateBar();
      if (stick) scrollToBottom();
    } catch (err) { /* the next reconnect will try again */ }
  }

  // ---------------------------------------------------------------- selection
  function setSelecting(on) {
    state.selecting = on;
    state.el.classList.toggle('selecting', on);
    state.selectbar.hidden = !on;
    if (!on) { state.selected.clear(); state.log.querySelectorAll('.chat-bubble.selected').forEach((b) => b.classList.remove('selected')); }
    updateBar();
  }
  function toggleSelect(b) {
    const id = Number(b.dataset.id);
    if (!id || b.classList.contains('pending')) return;
    if (state.selected.has(id)) { state.selected.delete(id); b.classList.remove('selected'); }
    else { state.selected.add(id); b.classList.add('selected'); }
    if (!state.selected.size) setSelecting(false); else updateBar();
  }
  function updateBar() {
    const n = state.selected.size;
    state.el.querySelector('[data-chat-count]').textContent = `${n} selected`;
    const hasFiles = [...state.selected].some((id) => { const b = bubbleById(id); return b && b.dataset.fileIds; });
    state.el.querySelector('[data-chat-download]').disabled = !hasFiles;
  }

  function triggerDownload(url) {
    const a = document.createElement('a');
    a.href = url; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  function downloadSelected() {
    const ids = [...state.selected];
    const fileIds = ids.flatMap((id) => (bubbleById(id).dataset.fileIds || '').split(',').filter(Boolean));
    if (!fileIds.length) return toast('None of the selected messages has an attachment.');
    if (fileIds.length === 1) triggerDownload(`/files/${fileIds[0]}?dl=1`);
    else triggerDownload(`/chat/${state.threadId}/download?ids=${ids.join(',')}`);
  }

  function openDeleteDialog() {
    const bubbles = [...state.selected].map(bubbleById).filter(Boolean);
    const canEveryone = bubbles.length > 0 && bubbles.every((b) => !b.classList.contains('is-deleted') && (state.isAdmin || b.dataset.sender === state.myKey));
    const n = bubbles.length;
    state.dialog.querySelector('[data-dialog-title]').textContent = `Delete ${n} message${n === 1 ? '' : 's'}?`;
    state.dialog.querySelector('[data-dialog-text]').textContent = canEveryone
      ? '"Delete for me" removes them only from your view. "Delete for everyone" replaces them with "This message was deleted" for all participants and removes attachments.'
      : 'Some of the selected messages are not yours, so they can only be deleted for you. Everyone else keeps seeing them.';
    const everyoneBtn = state.dialog.querySelector('[data-do-delete="everyone"]');
    everyoneBtn.disabled = !canEveryone;
    everyoneBtn.title = canEveryone ? '' : 'You can only delete your own messages for everyone';
    state.dialog.hidden = false;
  }
  async function doDelete(mode) {
    const ids = [...state.selected];
    state.dialog.hidden = true;
    try {
      const res = await fetch(`/chat/${state.threadId}/delete`, {
        method: 'POST', credentials: 'same-origin', headers: { ...AJAX, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, mode }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return toast(data.error || 'Could not delete.', 'error');
      (data.ids || []).forEach((id) => {
        const b = bubbleById(id);
        if (!b) return;
        if (mode === 'me') b.remove(); else markDeleted(b);
      });
      if (data.skipped) toast(`${data.skipped} message${data.skipped === 1 ? ' was' : 's were'} not deleted (only the sender can delete for everyone).`);
      setSelecting(false);
      if (!state.log.querySelector('.chat-bubble')) state.older.insertAdjacentHTML('afterend', '<p class="chat-empty">No messages.</p>');
    } catch (err) { toast('Network problem. Nothing was deleted.', 'error'); }
  }

  // ------------------------------------------------------------------ sending
  function pendingBubble(text, entries) {
    const b = document.createElement('div');
    b.className = 'chat-bubble mine pending';
    b.dataset.decorated = '1'; // already placed on the right; decorate() must leave it alone
    const files = entries.map((e) => `<div class="bubble-file"><span class="bubble-file-icon">&#128196;</span><span class="bubble-file-text"><strong>${esc(e.file.name)}</strong><small>${U.fmt(e.file.size)}</small></span></div>`).join('');
    b.innerHTML = `<div class="bubble-meta"><span class="bubble-sender">You</span><time data-state>Sending…</time></div>
      ${text ? `<p class="bubble-body">${esc(text)}</p>` : ''}
      ${files ? `<div class="bubble-files">${files}</div>` : ''}
      <div class="pending-bar"><span class="pending-progress"></span></div>
      <div class="pending-actions" hidden><span class="pending-error"></span><button type="button" data-retry>Retry</button><button type="button" data-discard>Discard</button></div>`;
    b._payload = { text, entries };
    return b;
  }

  async function transmit(b) {
    const { text, entries } = b._payload;
    const bar = b.querySelector('.pending-progress');
    b.classList.remove('failed');
    b.querySelector('.pending-actions').hidden = true;
    b.querySelector('.pending-bar').hidden = !entries.length;
    b.querySelector('[data-state]').textContent = 'Sending…';
    const fd = new FormData();
    fd.append('body', text);
    entries.forEach((e) => { fd.append('files', e.file, e.file.name); fd.append('paths', ''); });
    const res = await U.send({ url: `/chat/${state.threadId}/messages`, formData: fd, onProgress: (p) => { bar.style.width = Math.round(p * 100) + '%'; } });
    if (!state || !document.body.contains(b)) return;
    if (res.ok && res.json && res.json.html) {
      const existing = bubbleById(res.json.id);
      if (existing) b.remove();
      else {
        const tpl = document.createElement('template'); tpl.innerHTML = res.json.html;
        b.replaceWith(tpl.content.firstElementChild);
        decorate(state.log);
      }
      scrollToBottom();
    } else {
      b.classList.add('failed');
      b.querySelector('[data-state]').textContent = 'Not sent';
      b.querySelector('.pending-bar').hidden = true;
      b.querySelector('.pending-error').textContent = res.error || 'Could not send.';
      b.querySelector('.pending-actions').hidden = false;
      if (res.status === 401) setStatus('expired');
    }
  }

  function send() {
    const ta = state.form.querySelector('textarea');
    const up = U.Uploader.of(state.form);
    const text = ta.value.trim();
    const entries = up.entries();
    if (!text && !entries.length) return;
    const b = pendingBubble(text, entries);
    const empty = state.log.querySelector('.chat-empty'); if (empty) empty.remove();
    state.log.appendChild(b);
    scrollToBottom();
    ta.value = ''; ta.style.height = 'auto';
    up.clear();
    transmit(b);
  }

  // ---------------------------------------------------------- event wiring
  function bindPanel() {
    const { el, log } = state;
    let timer = null; let sx = 0; let sy = 0;
    const cancelPress = () => { if (timer) { clearTimeout(timer); timer = null; } };

    // long-press (touch or mouse) starts selecting, like WhatsApp
    log.addEventListener('pointerdown', (e) => {
      const b = e.target.closest('.chat-bubble');
      if (!b || b.classList.contains('pending') || (e.button && e.button > 0)) return;
      sx = e.clientX; sy = e.clientY;
      cancelPress();
      timer = setTimeout(() => {
        timer = null;
        state.suppressClick = true;
        setTimeout(() => { if (state) state.suppressClick = false; }, 700);
        if (!state.selecting) setSelecting(true);
        toggleSelect(b);
      }, 450);
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => log.addEventListener(t, cancelPress));
    log.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > 8) cancelPress(); });
    log.addEventListener('contextmenu', (e) => { if (isCoarse && e.target.closest('.chat-bubble')) e.preventDefault(); });

    log.addEventListener('click', (e) => {
      const retry = e.target.closest('[data-retry]');
      if (retry) return transmit(retry.closest('.chat-bubble'));
      const discard = e.target.closest('[data-discard]');
      if (discard) return discard.closest('.chat-bubble').remove();
      if (e.target.closest('[data-chat-older]')) return loadOlder();

      const b = e.target.closest('.chat-bubble');
      if (!b) return;
      if (state.suppressClick) { state.suppressClick = false; e.preventDefault(); return; }
      if (state.selecting) { e.preventDefault(); toggleSelect(b); return; }
      if (e.target.closest('.bubble-check')) { setSelecting(true); toggleSelect(b); }
    });
    log.addEventListener('scroll', () => { if (log.scrollTop < 40 && state.hasMore) loadOlder(); }, { passive: true });

    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-chat-cancel]')) setSelecting(false);
      else if (e.target.closest('[data-chat-download]')) downloadSelected();
      else if (e.target.closest('[data-chat-delete]')) openDeleteDialog();
      else if (e.target.closest('[data-dialog-cancel]')) state.dialog.hidden = true;
      else { const d = e.target.closest('[data-do-delete]'); if (d && !d.disabled) doDelete(d.dataset.doDelete); }
    });
    state.dialog.addEventListener('click', (e) => { if (e.target === state.dialog) state.dialog.hidden = true; });

    if (state.form) {
      const ta = state.form.querySelector('textarea');
      state.form.addEventListener('submit', (e) => { e.preventDefault(); send(); });
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !isCoarse) { e.preventDefault(); send(); }
      });
      ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; });
    }
  }

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state) return;
    if (!state.dialog.hidden) state.dialog.hidden = true; else if (state.selecting) setSelecting(false);
  });

  // ---------------------------------------------------------------- start up
  const boot = () => { if (!socket) connect(); initPanel(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  document.addEventListener('htmx:afterSettle', initPanel);
  document.addEventListener('htmx:historyRestore', initPanel);
})();
