const db = require('../db');

function setFlash(req, type, message) { req.session.flash = { type, message }; }
function consumeFlash(req, res, next) {
  res.locals.flash = req.session.flash || null;
  if (req.session) delete req.session.flash;
  next();
}

async function logActivity(employeeId, action) {
  await db.run('INSERT INTO activity_log (employee_id, action) VALUES (?, ?)', [employeeId, action]);
}

function timeAgo(dateValue) {
  if (!dateValue) return '';
  const then = new Date(dateValue);
  if (isNaN(then.getTime())) return '';
  const diffMs = Date.now() - then.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return then.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDeadline(deadlineStr) {
  if (!deadlineStr) return { label: 'No deadline set', cls: 'muted', iso: null };
  const deadline = new Date(deadlineStr);
  const diffMs = deadline - Date.now();
  const dateLabel = deadline.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  if (diffMs < 0) return { label: `Overdue - was due ${dateLabel}`, cls: 'overdue', iso: deadlineStr };
  if (diffMs < 1000 * 60 * 60 * 48) return { label: `Due soon - ${dateLabel}`, cls: 'soon', iso: deadlineStr };
  return { label: `Due ${dateLabel}`, cls: 'ok', iso: deadlineStr };
}

const ICONS = {
  home: '<path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  trending: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1"/>',
  inbox: '<path d="M3 12h5l2 3h4l2-3h5"/><path d="M5 5h14l2 7v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7z"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M2.5 21c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><circle cx="17" cy="8" r="2.6"/><path d="M15.7 15.6c2.7.3 4.8 2 4.8 5.4"/>',
  sliders: '<circle cx="16" cy="6" r="2"/><path d="M4 6h10M18 6h2"/><circle cx="8" cy="12" r="2"/><path d="M4 12h2M10 12h10"/><circle cx="17" cy="18" r="2"/><path d="M4 18h11M19 18h1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  clip: '<path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/>',
  dots: '<circle cx="12" cy="5" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="12" cy="19" r="1.4"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  megaphone: '<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1z"/><path d="M16.5 8.5a5 5 0 0 1 0 7"/>',
  team: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="10" r="2.2"/><circle cx="19" cy="10" r="2.2"/><path d="M6.5 20c0-3.3 2.5-5 5.5-5s5.5 1.7 5.5 5"/>',
  download: '<path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  send: '<path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4z"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  calendar: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3A4 4 0 0 0 11 18.7l1-1"/>',
  play: '<path d="M8 5l11 7-11 7z"/>',
  door: '<path d="M14 3h5a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1h-5"/><path d="M10 17l5-5-5-5"/><path d="M15 12H3"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4"/><path d="M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.5-1.9-.3-1 .4-2.1 1.5-2.1H17a4 4 0 0 0 4-4c0-5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M6 15l6-6 6 6"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/>',
  compress: '<path d="M9 3v3a2 2 0 0 1-2 2H4"/><path d="M15 3v3a2 2 0 0 0 2 2h3"/><path d="M15 21v-3a2 2 0 0 1 2-2h3"/><path d="M9 21v-3a2 2 0 0 0-2-2H4"/>'
};

function icon(name, size = 18) {
  const body = ICONS[name] || '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}


// ---- Files -----------------------------------------------------------------
const IMAGE_RE = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;
const VIDEO_RE = /\.(mp4|webm|mov|m4v|ogv)$/i;
function fileKind(file) {
  const name = (file && (file.name || file.rel_path)) || '';
  if (IMAGE_RE.test(name)) return 'image';
  if (VIDEO_RE.test(name)) return 'video';
  return 'file';
}
function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10485760 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
// JSON that is safe inside <script> ... </script>
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

// ---- Appearance settings (stored per user in users.settings) ---------------
const ACCENTS = [
  { key: 'default', label: 'Portal default', color: '#8b5cf6' },
  { key: 'indigo', label: 'Indigo', color: '#6d5ef5' },
  { key: 'teal', label: 'Teal', color: '#14b8a6' },
  { key: 'emerald', label: 'Emerald', color: '#22c55e' },
  { key: 'amber', label: 'Amber', color: '#f59e0b' },
  { key: 'rose', label: 'Rose', color: '#f43f5e' },
  { key: 'sky', label: 'Sky', color: '#0ea5e9' },
  { key: 'orchid', label: 'Orchid', color: '#d946ef' },
];
const DEFAULT_UI = { theme: 'dark', fixedSidebar: true, compactSidebar: false, density: 'grid', accent: 'default' };

function uiSettings(user) {
  const raw = (user && user.settings && typeof user.settings === 'object') ? user.settings : {};
  const out = { ...DEFAULT_UI };
  if (['light', 'dark', 'system'].includes(raw.theme)) out.theme = raw.theme;
  if (typeof raw.fixedSidebar === 'boolean') out.fixedSidebar = raw.fixedSidebar;
  if (typeof raw.compactSidebar === 'boolean') out.compactSidebar = raw.compactSidebar;
  if (['grid', 'comfortable'].includes(raw.density)) out.density = raw.density;
  if (ACCENTS.some((a) => a.key === raw.accent)) out.accent = raw.accent;
  return out;
}
// Attributes for <html>, rendered on the server so there is no flash of the wrong theme.
function htmlAttrs(user) {
  const ui = uiSettings(user);
  const shownTheme = ui.theme === 'light' ? 'light' : 'dark'; // "system" is resolved by a tiny inline script
  return `data-theme-pref="${ui.theme}" data-theme="${shownTheme}" data-sidebar="${ui.fixedSidebar ? 'fixed' : 'scroll'}" data-compact="${ui.compactSidebar ? '1' : '0'}" data-density="${ui.density}" data-accent="${ui.accent}"`;
}

// ---- Timezone (what counts as "a day" for activity tracking) ----------------
function appTimezone() {
  const tz = process.env.APP_TIMEZONE || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; }
  catch { console.warn(`[config] APP_TIMEZONE "${tz}" is not a valid IANA timezone; using UTC.`); return 'UTC'; }
}
// 'YYYY-MM-DD' for "today" in the app timezone
function todayKey(tz = appTimezone()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function addDaysKey(key, delta) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

module.exports = {
  setFlash, consumeFlash, logActivity, timeAgo, formatDeadline, icon,
  fileKind, formatSize, safeJson, ACCENTS, uiSettings, htmlAttrs, appTimezone, todayKey, addDaysKey,
};

