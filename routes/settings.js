// Settings modal (gear icon next to "log out"): account + password, appearance, leave.
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { ACCENTS, uiSettings } = require('../utils/helpers');
const { UserError } = require('../utils/errors');

const router = express.Router();
router.use(requireLogin);

const passwordLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function renderModal(req, res, { tab = 'account', ok = '', error = '' } = {}) {
  const leaveRequests = req.user.role === 'employee'
    ? await db.all(
      `SELECT id, kind, start_date::text AS start_date, end_date::text AS end_date, reason, status, admin_note, created_at
       FROM leave_requests WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`, [req.user.id])
    : [];
  res.render('partials/settings-modal', { tab, ok, error, leaveRequests, ui: uiSettings(req.user), ACCENTS, me: req.user });
}

router.get('/', async (req, res, next) => {
  try {
    const tab = ['account', 'appearance', 'leave'].includes(req.query.tab) ? req.query.tab : 'account';
    await renderModal(req, res, { tab });
  } catch (err) { next(err); }
});

router.post('/password', passwordLimiter, async (req, res, next) => {
  try {
    const { current_password, new_password, confirm_password } = req.body;
    const fail = (error) => renderModal(req, res, { tab: 'account', error });
    if (!bcrypt.compareSync(current_password || '', req.user.password_hash)) return fail('Your current password is not correct.');
    if (!new_password || new_password.length < 8) return fail('The new password must be at least 8 characters.');
    if (new_password !== confirm_password) return fail('The new password and its confirmation do not match.');
    if (new_password === current_password) return fail('Choose a password that is different from the current one.');

    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [bcrypt.hashSync(new_password, 10), req.user.id]);
    // sign out every OTHER device; this one stays signed in
    try { await db.run(`DELETE FROM session WHERE sess->>'userId' = ? AND sid <> ?`, [String(req.user.id), req.sessionID]); }
    catch (e) { console.error('[settings] could not clear other sessions:', e.message); }
    await renderModal(req, res, { tab: 'account', ok: 'Password changed. Other devices have been signed out.' });
  } catch (err) { next(err); }
});

// Appearance is saved as you click (JSON) and applied instantly in the browser by ui.js.
router.post('/appearance', async (req, res, next) => {
  try {
    const b = req.body || {};
    const patch = {};
    if (['light', 'dark', 'system'].includes(b.theme)) patch.theme = b.theme;
    if (typeof b.fixedSidebar === 'boolean') patch.fixedSidebar = b.fixedSidebar;
    if (typeof b.compactSidebar === 'boolean') patch.compactSidebar = b.compactSidebar;
    if (['grid', 'comfortable'].includes(b.density)) patch.density = b.density;
    if (ACCENTS.some((a) => a.key === b.accent)) patch.accent = b.accent;
    if (!Object.keys(patch).length) throw new UserError('Nothing to save.');
    const row = await db.get(`UPDATE users SET settings = COALESCE(settings, '{}'::jsonb) || ?::jsonb WHERE id = ? RETURNING settings`, [JSON.stringify(patch), req.user.id]);
    res.json({ ok: true, settings: uiSettings({ settings: row.settings }) });
  } catch (err) { next(err); }
});

// Leave: a time-off request, or a request to leave the portal (account gets closed if the admin approves).
router.post('/leave', async (req, res, next) => {
  try {
    if (req.user.role !== 'employee') throw new UserError('Leave requests are for employees.', 403);
    const { kind, start_date, end_date, reason } = req.body;
    const fail = (error) => renderModal(req, res, { tab: 'leave', error });
    if (!['time_off', 'leave_portal'].includes(kind)) return fail('Choose what kind of leave this is.');
    const note = (reason || '').trim();
    if (note.length < 5) return fail('Please write a short description for the admin (at least a few words).');
    if (note.length > 2000) return fail('The description is too long (max 2000 characters).');
    let start = null; let end = null;
    if (kind === 'time_off') {
      if (!DATE_RE.test(start_date || '') || !DATE_RE.test(end_date || '')) return fail('Choose the first and last day of your leave.');
      if (end_date < start_date) return fail('The last day cannot be before the first day.');
      start = start_date; end = end_date;
    }
    const open = await db.get(`SELECT id FROM leave_requests WHERE user_id = ? AND kind = ? AND status = 'pending'`, [req.user.id, kind]);
    if (open) return fail('You already have a pending request of this kind. Wait for the admin to respond.');

    await db.run('INSERT INTO leave_requests (user_id, kind, start_date, end_date, reason) VALUES (?,?,?,?,?)', [req.user.id, kind, start, end, note]);
    req.app.get('io').to('admins').emit('leave:new', { name: req.user.full_name, kind });
    await renderModal(req, res, { tab: 'leave', ok: 'Sent to your admin. You will see their decision here.' });
  } catch (err) { next(err); }
});

module.exports = router;
