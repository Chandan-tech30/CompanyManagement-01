// File / folder picker with live previews, plus the XHR upload used by every upload form.
//
//  * Any element with [data-uploader] becomes an Uploader (buttons [data-pick=files|folder],
//    inputs [data-input=files|folder], preview area [data-previews]).
//  * A <form data-upload-form> is submitted with XHR: text fields + every picked file
//    (`files`) with its folder path (`paths`), progress bar, inline errors. The server answers
//    with HTML (data-response="html", swapped into data-target) or JSON.
(function () {
  const MB = 1024 * 1024;
  const BLOCKED = /\.(exe|msi|bat|cmd|scr|com|pif|vbs|dll)$/i;
  const instances = new WeakMap();

  const fmt = (n) => (n < 1024 ? n + ' B' : n < MB ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB' : (n / MB).toFixed(n < 10 * MB ? 1 : 0) + ' MB');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const toast = (msg, type) => (window.toast ? window.toast(msg, type) : window.alert(msg));

  const ICON_FILE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
  const ICON_FOLDER = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

  class Uploader {
    static of(root) {
      if (!instances.has(root)) instances.set(root, new Uploader(root));
      return instances.get(root);
    }
    constructor(root) {
      this.root = root;
      this.items = []; // { id, file, path }
      this.seq = 1;
      this.urls = new Map();
      this.maxBytes = (parseFloat(root.dataset.maxMb) || 25) * MB;
    }
    get previews() { return this.root.querySelector('[data-previews]'); }
    entries() { return this.items.map(({ file, path }) => ({ file, path })); }
    count() { return this.items.length; }

    notify(msg) {
      const scope = this.root.closest('form') || this.root.parentElement || document;
      const box = scope.querySelector('[data-error]');
      if (box) { box.textContent = msg; box.hidden = false; } else toast(msg, 'error');
    }
    clearNotice() {
      const scope = this.root.closest('form') || this.root.parentElement || document;
      const box = scope.querySelector('[data-error]');
      if (box) box.hidden = true;
    }

    // list = [{ file, path }]
    add(list) {
      const problems = [];
      list.forEach(({ file, path }) => {
        if (BLOCKED.test(file.name)) { problems.push(`"${file.name}" is a program file and is blocked for security.`); return; }
        if (file.size > this.maxBytes) { problems.push(`"${file.name}" is ${fmt(file.size)}, over the ${fmt(this.maxBytes)} limit.`); return; }
        if (this.items.some((i) => i.path === path && i.file.name === file.name && i.file.size === file.size)) return; // same file twice
        this.items.push({ id: this.seq++, file, path: path || '' });
      });
      if (problems.length) this.notify(problems.slice(0, 3).join(' ') + (problems.length > 3 ? ` (+${problems.length - 3} more skipped)` : ''));
      else this.clearNotice();
      this.render();
    }
    remove(key) {
      if (key.startsWith('folder:')) this.items = this.items.filter((i) => this.folderOf(i) !== key.slice(7));
      else this.items = this.items.filter((i) => String(i.id) !== key);
      this.render();
    }
    clear() { this.items = []; this.render(); this.clearNotice(); }
    folderOf(item) { return item.path ? item.path.split('/')[0] : null; }

    render() {
      const box = this.previews;
      this.urls.forEach((u) => URL.revokeObjectURL(u));
      this.urls.clear();
      if (!box) { this.root.dispatchEvent(new CustomEvent('uploader-change', { bubbles: true, detail: { count: this.items.length } })); return; }
      box.hidden = this.items.length === 0;
      const chips = [];
      const seenFolders = new Set();
      this.items.forEach((item) => {
        const folder = this.folderOf(item);
        if (folder) {
          if (seenFolders.has(folder)) return;
          seenFolders.add(folder);
          const inFolder = this.items.filter((i) => this.folderOf(i) === folder);
          const size = inFolder.reduce((s, i) => s + i.file.size, 0);
          chips.push(this.chip('folder:' + folder, ICON_FOLDER, folder, `${inFolder.length} file${inFolder.length === 1 ? '' : 's'} · ${fmt(size)}`, true));
        } else {
          let thumb = ICON_FILE;
          if (/^image\//.test(item.file.type) || /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(item.file.name)) {
            const url = URL.createObjectURL(item.file);
            this.urls.set(item.id, url);
            thumb = `<img src="${url}" alt="">`;
          } else {
            const ext = (item.file.name.split('.').pop() || '').slice(0, 4).toUpperCase();
            thumb = `<span class="chip-ext">${esc(ext || 'FILE')}</span>`;
          }
          chips.push(this.chip(String(item.id), thumb, item.file.name, fmt(item.file.size), false));
        }
      });
      box.innerHTML = chips.join('');
      this.root.dispatchEvent(new CustomEvent('uploader-change', { bubbles: true, detail: { count: this.items.length } }));
    }
    chip(key, thumb, name, meta, isFolder) {
      return `<div class="chip${isFolder ? ' chip-folder' : ''}">
        <div class="chip-thumb">${thumb}</div>
        <div class="chip-text"><strong title="${esc(name)}">${esc(name)}</strong><small>${esc(meta)}</small></div>
        <button type="button" class="chip-remove" data-remove="${esc(key)}" aria-label="Remove ${esc(name)}">&times;</button>
      </div>`;
    }
  }

  // ---- reading dropped folders (DataTransferItem.webkitGetAsEntry) ----------
  async function readEntry(entry, parent, out) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: parent ? `${parent}/${file.name}` : '' });
    } else if (entry.isDirectory) {
      const here = parent ? `${parent}/${entry.name}` : entry.name;
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await readEntry(child, here, out);
      }
    }
  }
  async function filesFromDrop(dt) {
    const out = [];
    const items = dt.items ? [...dt.items].filter((i) => i.kind === 'file') : [];
    const entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
    if (entries.length && entries.every(Boolean)) {
      for (const e of entries) await readEntry(e, '', out);
    } else {
      [...dt.files].forEach((file) => out.push({ file, path: '' }));
    }
    return out;
  }

  // ---- delegated events (work for content swapped in by HTMX) ---------------
  const rootOf = (el) => el.closest('[data-uploader]');

  document.addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const root = rootOf(pick) || pick.closest('form');
      const input = root && root.querySelector(`input[data-input="${pick.dataset.pick}"]`);
      if (input) input.click();
      return;
    }
    const rm = e.target.closest('[data-remove]');
    if (rm) {
      const root = rootOf(rm);
      if (root) Uploader.of(root).remove(rm.dataset.remove);
    }
  });

  document.addEventListener('change', (e) => {
    const input = e.target.closest && e.target.closest('input[data-input]');
    if (!input) return;
    const root = rootOf(input);
    if (!root) return;
    const isFolder = input.dataset.input === 'folder';
    const list = [...input.files].map((file) => ({ file, path: isFolder ? (file.webkitRelativePath || '') : '' }));
    input.value = ''; // so picking the same file again still fires "change"
    Uploader.of(root).add(list);
  });

  ['dragenter', 'dragover'].forEach((type) => document.addEventListener(type, (e) => {
    const zone = e.target.closest && e.target.closest('[data-drop], [data-uploader]');
    if (!zone || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    zone.classList.add('dragging');
  }));
  ['dragleave', 'drop'].forEach((type) => document.addEventListener(type, (e) => {
    const zone = e.target.closest && e.target.closest('[data-drop], [data-uploader]');
    if (zone && (type === 'drop' || !zone.contains(e.relatedTarget))) zone.classList.remove('dragging');
  }));
  document.addEventListener('drop', async (e) => {
    const zone = e.target.closest && e.target.closest('[data-uploader]');
    if (!zone || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    const hasFolderPicker = zone.querySelector('input[data-input="folder"]');
    let list = await filesFromDrop(e.dataTransfer);
    if (!hasFolderPicker) list = list.map((x) => ({ file: x.file, path: '' })); // chat / announcements: files only
    Uploader.of(zone).add(list);
  });

  // ---- XHR with progress -----------------------------------------------------
  function send({ url, formData, method = 'POST', onProgress }) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.setRequestHeader('Accept', 'application/json, text/html');
      xhr.withCredentials = true;
      if (onProgress && xhr.upload) {
        xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
      }
      xhr.onload = () => {
        let json = null;
        try { json = JSON.parse(xhr.responseText); } catch (err) { /* HTML response */ }
        const ok = xhr.status >= 200 && xhr.status < 300;
        resolve({ ok, status: xhr.status, text: xhr.responseText, json, error: ok ? '' : ((json && json.error) || `The server answered with an error (HTTP ${xhr.status}).`) });
      };
      xhr.onerror = () => resolve({ ok: false, status: 0, text: '', json: null, error: 'Network problem: the upload did not reach the server. Your files are still selected, so you can try again.' });
      xhr.onabort = () => resolve({ ok: false, status: 0, text: '', json: null, error: 'Upload cancelled.' });
      xhr.send(formData);
    });
  }

  // ---- <form data-upload-form> ----------------------------------------------
  document.addEventListener('submit', async (e) => {
    const form = e.target;
    if (!form.matches || !form.matches('form[data-upload-form]')) return;
    e.preventDefault();
    if (form.dataset.busy) return;

    const box = form.querySelector('[data-uploader]');
    const up = box ? Uploader.of(box) : null;
    const fd = new FormData(form);
    if (up) up.entries().forEach(({ file, path }) => { fd.append('files', file, file.name); fd.append('paths', path || ''); });

    const bar = form.querySelector('[data-progress]');
    const barFill = form.querySelector('[data-progress-bar]');
    const barText = form.querySelector('[data-progress-text]');
    const errBox = form.querySelector('[data-error]');
    const submitBtns = form.querySelectorAll('button[type="submit"]');
    if (errBox) errBox.hidden = true;
    form.dataset.busy = '1';
    submitBtns.forEach((b) => { b.disabled = true; });
    const hasFiles = up && up.count() > 0;
    if (bar && hasFiles) { bar.hidden = false; barFill.style.width = '0%'; barText.textContent = 'Uploading…'; }

    const res = await send({
      url: form.getAttribute('action') || location.href, formData: fd,
      onProgress: (p) => {
        if (!bar || !hasFiles) return;
        barFill.style.width = Math.round(p * 100) + '%';
        barText.textContent = p >= 1 ? 'Saving…' : `Uploading ${Math.round(p * 100)}%`;
      },
    });

    delete form.dataset.busy;
    submitBtns.forEach((b) => { b.disabled = false; });
    if (bar) bar.hidden = true;

    if (!res.ok) {
      if (errBox) { errBox.textContent = res.error; errBox.hidden = false; } else toast(res.error, 'error');
      if (res.status === 401) setTimeout(() => { location.href = '/'; }, 1500);
      return;
    }

    form.dispatchEvent(new CustomEvent('upload-success', { bubbles: true, detail: res.json }));
    if (form.dataset.response !== 'json') {
      const target = document.querySelector(form.dataset.target);
      if (target) {
        const outer = form.dataset.swap === 'outerHTML';
        const holder = outer ? target.parentElement : target;
        if (outer) target.outerHTML = res.text; else target.innerHTML = res.text;
        if (window.htmx) window.htmx.process(holder);
      }
    }
    if (form.isConnected) { form.reset(); if (up) up.clear(); }
  });

  window.PortalUpload = { Uploader, send, fmt, esc };
})();
