const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { setFlash } = require('../utils/helpers');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../utils/mailer');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^\+?[0-9\s-]{7,15}$/;
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
// Generous per-IP limit (shared by forgot-password requests, whatever the account) —
// it exists to blunt automated abuse, not to get in a real user's way.
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });

function baseUrl(req) { return process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`; }

router.get('/', async (req, res, next) => {
  try {
    if (req.user && req.user.role === 'employee' && req.user.status === 'approved') return res.redirect('/employee/dashboard');
    if (req.user && req.user.role === 'admin') return res.redirect('/admin/dashboard');
    res.render('landing', { title: 'Company Portal' });
  } catch (err) { next(err); }
});

router.get('/register', (req, res) => {
  res.render('register', { title: 'Create your account', values: {} });
});

router.post('/register', async (req, res, next) => {
  try {
    const { full_name, email, password, confirm_password, phone } = req.body;
    const values = { full_name, email, phone };
    const fail = (message) => res.render('register', { title: 'Create your account', values, flash: { type: 'error', message } });

    if (!full_name || !email || !password || !phone) return fail('Please fill in every field.');
    if (!EMAIL_RE.test(email)) return fail('That email address doesn\'t look valid.');
    if (!PHONE_RE.test(phone)) return fail('Please enter a valid phone number.');
    if (password.length < 8) return fail('Password must be at least 8 characters.');
    if (password !== confirm_password) return fail('Passwords do not match.');

    const existing = await db.get('SELECT id FROM users WHERE email = ?', [email.toLowerCase()]);
    if (existing) return fail('An account with that email already exists.');

    const passwordHash = bcrypt.hashSync(password, 10);
    const token = crypto.randomBytes(24).toString('hex');
    const info = await db.run(`
      INSERT INTO users (full_name, email, password_hash, phone, role, status, verification_token)
      VALUES (?, ?, ?, ?, 'employee', 'pending_verification', ?) RETURNING id
    `, [full_name.trim(), email.toLowerCase().trim(), passwordHash, phone.trim(), token]);

    const link = `${baseUrl(req)}/verify/${token}`;
    sendVerificationEmail(email, link);
    res.render('verify-sent', { title: 'Check your email', email, devLink: link, userId: info.lastInsertRowid });
  } catch (err) { next(err); }
});

router.get('/resend-verification', (req, res) => {
  res.render('resend-verification', { title: 'Resend verification email' });
});

router.post('/resend-verification', async (req, res, next) => {
  try {
    const { email } = req.body;
    const user = await db.get(`SELECT * FROM users WHERE email = ? AND status = 'pending_verification'`, [(email || '').toLowerCase().trim()]);
    if (!user) return res.render('verify-sent', { title: 'Check your email', email, devLink: null, userId: null });

    const token = crypto.randomBytes(24).toString('hex');
    await db.run('UPDATE users SET verification_token = ? WHERE id = ?', [token, user.id]);
    const link = `${baseUrl(req)}/verify/${token}`;
    sendVerificationEmail(user.email, link);
    res.render('verify-sent', { title: 'Check your email', email: user.email, devLink: link, userId: user.id });
  } catch (err) { next(err); }
});

router.get('/verify/:token', async (req, res, next) => {
  try {
    const user = await db.get(`SELECT * FROM users WHERE verification_token = ? AND status = 'pending_verification'`, [req.params.token]);
    if (!user) {
      return res.render('message', { title: 'Link not valid', heading: 'This verification link isn\'t valid', body: 'It may have already been used, or a newer one was requested.', backHref: '/login/employee', backLabel: 'Go to login' });
    }
    await db.run(`UPDATE users SET status = 'pending_approval', verification_token = NULL WHERE id = ?`, [user.id]);
    req.session.userId = user.id;
    res.redirect('/pending');
  } catch (err) { next(err); }
});

router.get('/pending', (req, res) => res.render('pending', { title: 'Awaiting approval' }));

router.get('/login/employee', async (req, res, next) => {
  try {
    if (req.user && req.user.role === 'employee' && req.user.status === 'approved') return res.redirect('/employee/dashboard');
    res.render('login-employee', { title: 'Employee login' });
  } catch (err) { next(err); }
});

router.post('/login/employee', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await db.get(`SELECT * FROM users WHERE email = ? AND role = 'employee'`, [(email || '').toLowerCase().trim()]);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) { setFlash(req, 'error', 'Incorrect email or password.'); return res.redirect('/login/employee'); }
    if (user.status === 'pending_verification') { setFlash(req, 'error', 'Please verify your email first. Check your inbox, or resend the link below.'); return res.redirect('/login/employee'); }
    if (user.status === 'pending_approval') { setFlash(req, 'error', 'Your account is verified and waiting on admin approval.'); return res.redirect('/login/employee'); }
    if (user.status === 'rejected') { setFlash(req, 'error', 'Your registration was not approved. Contact your admin.'); return res.redirect('/login/employee'); }
    if (user.status === 'left') { setFlash(req, 'error', 'This account has been closed. Contact your admin if you think this is a mistake.'); return res.redirect('/login/employee'); }
    const returnTo = req.session.returnTo;
    req.session.userId = user.id;
    delete req.session.returnTo;
    // e.g. a shared announcement link: send them where they were going
    res.redirect(returnTo && /^\/employee\/[\w\-\/]*$/.test(returnTo) ? returnTo : '/employee/dashboard');
  } catch (err) { next(err); }
});

router.get('/login/admin', async (req, res, next) => {
  try {
    if (req.user && req.user.role === 'admin') return res.redirect('/admin/dashboard');
    res.render('login-admin', { title: 'Admin login' });
  } catch (err) { next(err); }
});

router.post('/login/admin', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const user = await db.get(`SELECT * FROM users WHERE email = ? AND role = 'admin'`, [(email || '').toLowerCase().trim()]);
    if (!user || !bcrypt.compareSync(password || '', user.password_hash)) { setFlash(req, 'error', 'Incorrect email or password.'); return res.redirect('/login/admin'); }
    req.session.userId = user.id;
    res.redirect('/admin/dashboard');
  } catch (err) { next(err); }
});

// ---- forgot / reset password (works for both the admin account and employees) ----------
router.get('/forgot-password', (req, res) => {
  const role = req.query.role === 'admin' ? 'admin' : 'employee';
  res.render('forgot-password', { title: 'Reset your password', role });
});

router.post('/forgot-password', forgotLimiter, async (req, res, next) => {
  try {
    const role = req.body.role === 'admin' ? 'admin' : 'employee';
    const email = (req.body.email || '').toLowerCase().trim();
    const render = (extra) => res.render('forgot-password', { title: 'Reset your password', role, ...extra });
    if (!EMAIL_RE.test(email)) return render({ flash: { type: 'error', message: "That email address doesn't look valid." } });

    // Looked up by email ALONE — email is globally unique in this schema (see the register
    // route), so filtering by the submitted/guessed `role` here as well was the actual bug:
    // if the role didn't match the account's real role (e.g. this page loaded without
    // ?role=admin), the lookup silently found nothing and the flow looked completely dead.
    const user = await db.get(`SELECT * FROM users WHERE email = ?`, [email]);
    let devLink = null;
    // Only look-up-able accounts that can actually sign in get a real link; either way the
    // screen shown next is identical, so no one can use this form to test which emails exist.
    if (user && !['rejected', 'left'].includes(user.status)) {
      const token = crypto.randomBytes(32).toString('hex');
      await db.run(
        `UPDATE users SET reset_token_hash = ?, reset_token_expires_at = NOW() + INTERVAL '1 hour' WHERE id = ?`,
        [hashToken(token), user.id]
      );
      const link = `${baseUrl(req)}/reset-password/${token}`;
      const result = await sendPasswordResetEmail(user.email, link);
      if (!result.sent) devLink = link; // dev/no-SMTP fallback, same pattern as verify-sent
    }
    // Use the account's real role for the "back to login" link when we found one;
    // fall back to whatever was guessed/submitted when we didn't (keeps the no-such-account
    // case from looking any different, so the form still can't be used to test who has an account).
    res.render('forgot-password-sent', { title: 'Check your email', email, devLink, role: user ? user.role : role });
  } catch (err) { next(err); }
});

router.get('/reset-password/:token', async (req, res, next) => {
  try {
    const user = await db.get(
      `SELECT id, role FROM users WHERE reset_token_hash = ? AND reset_token_expires_at > NOW()`,
      [hashToken(req.params.token)]
    );
    if (!user) {
      return res.render('message', {
        title: 'Link not valid', heading: "This reset link isn't valid",
        body: 'It may have expired (links last 1 hour) or already been used. Request a new one below.',
        backHref: '/forgot-password', backLabel: 'Request a new link',
      });
    }
    res.render('reset-password', { title: 'Choose a new password', token: req.params.token });
  } catch (err) { next(err); }
});

router.post('/reset-password/:token', async (req, res, next) => {
  try {
    const user = await db.get(
      `SELECT id, role FROM users WHERE reset_token_hash = ? AND reset_token_expires_at > NOW()`,
      [hashToken(req.params.token)]
    );
    if (!user) {
      return res.render('message', {
        title: 'Link not valid', heading: "This reset link isn't valid",
        body: 'It may have expired (links last 1 hour) or already been used. Request a new one below.',
        backHref: '/forgot-password', backLabel: 'Request a new link',
      });
    }
    const { password, confirm_password } = req.body;
    const fail = (error) => res.render('reset-password', { title: 'Choose a new password', token: req.params.token, flash: { type: 'error', message: error } });
    if (!password || password.length < 8) return fail('Password must be at least 8 characters.');
    if (password !== confirm_password) return fail('Passwords do not match.');

    await db.run(
      `UPDATE users SET password_hash = ?, reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = ?`,
      [bcrypt.hashSync(password, 10), user.id]
    );
    // The token is single-use (cleared above) and every existing session for this account is signed out,
    // since whoever had it forgotten/leaked the old password and may still have an open session somewhere.
    try { await db.run(`DELETE FROM session WHERE sess->>'userId' = ?`, [String(user.id)]); }
    catch (e) { console.error('[auth] could not clear sessions after reset:', e.message); }

    setFlash(req, 'success', 'Password changed. You can log in now.');
    res.redirect(user.role === 'admin' ? '/login/admin' : '/login/employee');
  } catch (err) { next(err); }
});

router.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });

module.exports = router;
