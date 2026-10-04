const db = require('../db');
const { wantsJson } = require('../utils/errors');

async function attachUser(req, res, next) {
  res.locals.currentUser = null;
  req.user = null;
  try {
    if (req.session && req.session.userId) {
      const user = await db.get('SELECT * FROM users WHERE id = ?', [req.session.userId]);
      if (user) { req.user = user; res.locals.currentUser = user; }
    }
    next();
  } catch (err) { next(err); }
}

// Not logged in: full pages redirect, HTMX gets HX-Redirect, XHR/fetch gets a JSON 401.
function deny(req, res, loginUrl) {
  if (req.headers['hx-request']) return res.set('HX-Redirect', loginUrl).status(200).end();
  if (wantsJson(req)) return res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  return res.redirect(loginUrl);
}

function requireEmployee(req, res, next) {
  if (!req.user || req.user.role !== 'employee') {
    // remember where they were going (e.g. a shared announcement link)
    if (!req.user && req.session && req.method === 'GET' && !req.headers['hx-request'] && !wantsJson(req)) req.session.returnTo = req.originalUrl;
    return deny(req, res, '/login/employee');
  }
  if (req.user.status === 'left') return req.session.destroy(() => deny(req, res, '/login/employee'));
  if (req.user.status !== 'approved') return res.redirect('/pending');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return deny(req, res, '/login/admin');
  next();
}

// Any signed-in, approved person (admin or employee) — used by shared endpoints (chat, files, projects...).
function requireLogin(req, res, next) {
  if (!req.user) return deny(req, res, '/');
  if (req.user.role === 'employee' && req.user.status !== 'approved') return deny(req, res, '/pending');
  next();
}

module.exports = { attachUser, requireEmployee, requireAdmin, requireLogin };
