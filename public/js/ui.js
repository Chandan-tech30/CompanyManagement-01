// Shared UI behaviour: toasts, modals, sidebar hide/show, appearance settings, copy buttons,
// bulk "select & delete", HTMX error messages.
(function () {
  const root = document.documentElement;

  // ---- toasts ---------------------------------------------------------------
  window.toast = function (message, type) {
    const holder = document.getElementById('toast-root');
    if (!holder) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' toast-error' : type === 'success' ? ' toast-success' : '');
    el.textContent = message;
    holder.appendChild(el);
    setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 300); }, type === 'error' ? 7000 : 4000);
  };

  // ---- modals (project / settings dialogs are loaded into #modal-root) ------------
  const modalRoot = () => document.getElementById('modal-root');
  const closeModal = () => { const m = modalRoot(); if (m) m.innerHTML = ''; };
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-modal]')) return closeModal();
    if (e.target.matches('.modal-backdrop[data-modal]')) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalRoot() && modalRoot().children.length) closeModal();
  });

  // ---- chat minimize / maximize (the Work-tab chat, both admin and employee sides) ----
  document.addEventListener('click', (e) => {
    const minBtn = e.target.closest('[data-chat-minimize]');
    const maxBtn = e.target.closest('[data-chat-maximize]');
    // clicking anywhere else on a minimized header restores it too, not just the button
    const barClick = !minBtn && !maxBtn && e.target.closest('.chat-titlebar');
    if (!minBtn && !maxBtn && !barClick) return;
    const panel = (minBtn || maxBtn || barClick).closest('.chat-panel');
    if (!panel) return;
    const mode = panel.getAttribute('data-chat-mode') || 'normal';
    if (minBtn) panel.setAttribute('data-chat-mode', mode === 'min' ? 'normal' : 'min');
    else if (maxBtn) panel.setAttribute('data-chat-mode', mode === 'max' ? 'normal' : 'max');
    else if (barClick && mode === 'min') panel.setAttribute('data-chat-mode', 'normal');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const maxed = document.querySelector('.chat-panel[data-chat-mode="max"]');
    if (maxed) maxed.setAttribute('data-chat-mode', 'normal');
  });

  // ---- keep the work list's scroll position when it is refreshed (assign / approve / live update) ----
  let savedTaskScroll = null;
  document.addEventListener('htmx:beforeSwap', (e) => {
    const t = e.detail && e.detail.target;
    if (t && t.id === 'tasks-panel') { const l = t.querySelector('.task-list'); savedTaskScroll = l ? l.scrollTop : null; }
  });
  document.addEventListener('htmx:afterSettle', () => {
    if (savedTaskScroll === null) return;
    const l = document.querySelector('#tasks-panel .task-list');
    if (l) l.scrollTop = savedTaskScroll;
    savedTaskScroll = null;
  });

  // ---- sidebar highlight follows the page after HTMX navigation (e.g. picking someone in the search box) ----
  function syncNavHighlight() {
    const path = location.pathname;
    let key = path;
    if (/^\/admin\/employees\/\d+\/projects/.test(path)) key = '/admin/tab/projects';
    else if (/^\/admin\/employees\//.test(path)) key = '/admin/tab/employees';
    else if (/^\/admin\/teams/.test(path)) key = '/admin/tab/teams';
    else if (/^\/employee\/teams/.test(path)) key = '/employee/tab/teams';
    document.querySelectorAll('.sidebar .nav-link, .bottom-tabbar .bottom-tab').forEach((a) => {
      a.classList.toggle('active', a.getAttribute('href') === key);
    });
  }
  document.addEventListener('htmx:pushedIntoHistory', syncNavHighlight);
  window.addEventListener('popstate', syncNavHighlight);

  // ---- global search: arrow keys + Enter ----
  document.addEventListener('keydown', (e) => {
    const input = e.target.closest && e.target.closest('.global-search input');
    if (!input || !['ArrowDown', 'ArrowUp', 'Enter'].includes(e.key)) return;
    const hits = Array.from(document.querySelectorAll('#search-results .search-hit'));
    if (!hits.length) return;
    let i = hits.findIndex((h) => h.classList.contains('is-active'));
    if (e.key === 'Enter') { e.preventDefault(); (hits[i] || hits[0]).click(); return; }
    e.preventDefault();
    if (i >= 0) hits[i].classList.remove('is-active');
    i = e.key === 'ArrowDown' ? (i + 1) % hits.length : (i <= 0 ? hits.length - 1 : i - 1);
    hits[i].classList.add('is-active');
    hits[i].scrollIntoView({ block: 'nearest' });
  });

  // ---- sidebar hide / show (the 3-dots button) --------------------------------------
  document.addEventListener('click', (e) => {
    if (!e.target.closest('[data-sidebar-toggle]')) return;
    const hidden = root.getAttribute('data-sidebar-hidden') === '1';
    if (hidden) root.removeAttribute('data-sidebar-hidden'); else root.setAttribute('data-sidebar-hidden', '1');
    try { localStorage.setItem('sidebarHidden', hidden ? '0' : '1'); } catch (err) { /* private mode */ }
  });

  // ---- appearance settings ------------------------------------------------------------
  function applySettings(s) {
    if (s.theme) {
      root.setAttribute('data-theme-pref', s.theme);
      root.setAttribute('data-theme', s.theme === 'system' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : s.theme);
    }
    if (typeof s.fixedSidebar === 'boolean') root.setAttribute('data-sidebar', s.fixedSidebar ? 'fixed' : 'scroll');
    if (typeof s.compactSidebar === 'boolean') root.setAttribute('data-compact', s.compactSidebar ? '1' : '0');
    if (s.density) root.setAttribute('data-density', s.density);
    if (s.accent) root.setAttribute('data-accent', s.accent);
  }
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (root.getAttribute('data-theme-pref') === 'system') applySettings({ theme: 'system' });
  });
  document.addEventListener('change', async (e) => {
    const input = e.target.closest && e.target.closest('[data-setting]');
    if (!input) return;
    const key = input.dataset.setting;
    const patch = { [key]: input.type === 'checkbox' ? input.checked : input.value };
    applySettings(patch); // instant
    const status = document.querySelector('[data-appearance-status]');
    try {
      const res = await fetch('/settings/appearance', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      if (status) status.textContent = 'Saved';
    } catch (err) {
      if (status) status.textContent = 'Applied here, but could not be saved. Check your connection.';
    }
  });

  // ---- copy buttons (announcement links) -----------------------------------------------
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    try { await navigator.clipboard.writeText(text); window.toast('Link copied', 'success'); }
    catch (err) { window.prompt('Copy this link:', text); }
  });

  // ---- bulk select & delete (projects, completed tasks) ---------------------------------
  // root: [data-bulk data-url data-target data-swap data-noun data-verb], items: [data-bulk-item data-id]
  const bulkRoot = (el) => el.closest('[data-bulk]');
  function setBulkMode(r, on) {
    r.classList.toggle('select-mode', on);
    const bar = r.querySelector('[data-bulk-bar]');
    if (bar) bar.hidden = !on;
    if (!on) r.querySelectorAll('[data-bulk-item].selected').forEach((i) => i.classList.remove('selected'));
    updateBulk(r);
  }
  function updateBulk(r) {
    const n = r.querySelectorAll('[data-bulk-item].selected').length;
    const label = r.querySelector('[data-bulk-count]');
    if (label) label.textContent = n + ' selected';
    const del = r.querySelector('[data-bulk-delete]');
    if (del) del.disabled = n === 0;
  }
  async function bulkDelete(r) {
    const ids = [...r.querySelectorAll('[data-bulk-item].selected')].map((i) => Number(i.dataset.id));
    if (!ids.length) return;
    const noun = (r.dataset.noun || 'item') + (ids.length === 1 ? '' : 's');
    const verb = r.dataset.verb || 'Delete';
    const warn = verb === 'Delete' ? 'This cannot be undone.' : 'They stay in the other person\'s view.';
    if (!window.confirm(`${verb} ${ids.length} ${noun}? ${warn}`)) return;
    setBulkMode(r, false);
    try {
      const res = await fetch(r.dataset.url, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Accept: 'text/html, application/json' },
        body: JSON.stringify({ ids }),
      });
      const text = await res.text();
      if (!res.ok) { let msg = 'Could not complete that.'; try { msg = JSON.parse(text).error || msg; } catch (err) { /* html */ } return window.toast(msg, 'error'); }
      const target = document.querySelector(r.dataset.target);
      if (!target) return;
      const holder = r.dataset.swap === 'outerHTML' ? target.parentElement : target;
      if (r.dataset.swap === 'outerHTML') target.outerHTML = text; else target.innerHTML = text;
      if (window.htmx) window.htmx.process(holder);
      window.toast(`${ids.length} ${noun} ${verb === 'Delete' ? 'deleted' : 'removed'}`, 'success');
    } catch (err) { window.toast('Network problem. Nothing was changed.', 'error'); }
  }
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('[data-bulk-toggle]');
    if (toggle) {
      const r = toggle.dataset.bulkToggle ? document.querySelector(toggle.dataset.bulkToggle) : bulkRoot(toggle);
      if (r) setBulkMode(r, !r.classList.contains('select-mode'));
      return;
    }
    const r = bulkRoot(e.target);
    if (!r) return;
    if (e.target.closest('[data-bulk-cancel]')) setBulkMode(r, false);
    else if (e.target.closest('[data-bulk-delete]')) bulkDelete(r);
  });
  // capture phase: in select mode a click on a card selects it instead of opening it
  document.addEventListener('click', (e) => {
    const item = e.target.closest('[data-bulk-item]');
    if (!item) return;
    const r = bulkRoot(item);
    if (!r || !r.classList.contains('select-mode')) return;
    e.preventDefault(); e.stopPropagation();
    item.classList.toggle('selected');
    updateBulk(r);
  }, true);

  // ---- HTMX problems become visible ------------------------------------------------------
  document.addEventListener('htmx:responseError', (e) => {
    let msg = 'Something went wrong.';
    try {
      const body = e.detail.xhr.responseText || '';
      const doc = new DOMParser().parseFromString(body, 'text/html');
      const text = (doc.querySelector('.inline-error') || doc.body).textContent.trim();
      if (text) msg = text.slice(0, 300);
    } catch (err) { /* keep default */ }
    window.toast(msg, 'error');
  });
  document.addEventListener('htmx:sendError', () => window.toast('Network problem: could not reach the server.', 'error'));
})();
