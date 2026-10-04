require('dotenv').config({ quiet: true });
const path = require('path');
const http = require('http');
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const { Server } = require('socket.io');

const storage = require('./utils/storage');
storage.assertConfigured(); // no local-disk fallback: refuse to start without a bucket

const db = require('./db');
const { ensureAdmin } = require('./db/bootstrap');
const { attachUser } = require('./middleware/auth');
const helpers = require('./utils/helpers');
const { multerMessage, MAX_UPLOAD_MB, MAX_MEDIA_MB } = require('./utils/upload');
const { wantsJson } = require('./utils/errors');
const { attachSockets } = require('./services/sockets');

const authRoutes = require('./routes/auth');
const filesRoutes = require('./routes/files');
const chatRoutes = require('./routes/chat');
const settingsRoutes = require('./routes/settings');
const projectRoutes = require('./routes/projects');
const employeeRoutes = require('./routes/employee');
const adminRoutes = require('./routes/admin');

const isProd = process.env.NODE_ENV === 'production';
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function main() {
  if (isProd && !process.env.SESSION_SECRET) {
    console.error('\nSESSION_SECRET must be set in production (a long random string).\n');
    process.exit(1);
  }
  await db.initDb();
  const boot = await ensureAdmin();
  if (boot.created) {
    console.log(`[admin] created the first admin account: ${boot.email}`);
    if (isProd && !process.env.ADMIN_PASSWORD) console.warn('[admin] WARNING: ADMIN_PASSWORD is not set — the default password is in use. Log in and change it now.');
  }
  await storage.checkConnection(); // logs a clear message if the bucket/keys are wrong; never stops the server from starting

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  app.set('io', io);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', 1); // Render terminates TLS in front of the app

  // Available inside every template, including ones rendered from socket handlers.
  Object.assign(app.locals, {
    icon: helpers.icon, timeAgo: helpers.timeAgo, formatDeadline: helpers.formatDeadline,
    fileKind: helpers.fileKind, formatSize: helpers.formatSize, safeJson: helpers.safeJson,
    htmlAttrs: helpers.htmlAttrs, uiSettings: helpers.uiSettings, ACCENTS: helpers.ACCENTS,
    MAX_UPLOAD_MB, MAX_MEDIA_MB,
  });

  // Health check (Render) — before sessions so it never touches the session store.
  app.get('/healthz', async (req, res) => {
    try { await db.get('SELECT 1 AS ok'); res.type('text').send('ok'); }
    catch { res.status(503).type('text').send('database unavailable'); }
  });

  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  // Sessions are stored in PostgreSQL, so restarts and Render's sleep never log anyone out.
  const sessionMiddleware = session({
    store: new PgSession({ pool: db.pool, tableName: 'session', pruneSessionInterval: 60 * 15 }),
    name: 'portal.sid',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 7 },
  });
  app.use(sessionMiddleware);
  attachSockets(io, sessionMiddleware);

  app.use(attachUser);
  app.use(helpers.consumeFlash);
  app.use(async (req, res, next) => {
    try {
      res.locals.timeAgo = helpers.timeAgo;
      res.locals.formatDeadline = helpers.formatDeadline;
      res.locals.icon = helpers.icon;
      res.locals.path = req.path;
      res.locals.baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
      res.locals.company = await db.get('SELECT * FROM company WHERE id = 1');
      next();
    } catch (err) { next(err); }
  });

  const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
  app.use(['/login/employee', '/login/admin', '/register', '/resend-verification'], authLimiter);

  app.use('/', authRoutes);
  app.use('/files', filesRoutes);
  app.use('/chat', chatRoutes);
  app.use('/settings', settingsRoutes);
  app.use('/projects', projectRoutes);
  app.use('/employee', employeeRoutes);
  app.use('/admin', adminRoutes);

  app.use((req, res) => {
    if (wantsJson(req)) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('message', { title: 'Not found', heading: 'Page not found', body: 'That page doesn\'t exist or may have moved.', backHref: '/', backLabel: 'Go home' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || 500;
    let message = err.expose ? err.message : null;
    if (err instanceof multer.MulterError) { status = 400; message = multerMessage(err); }
    if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
    if (!message) message = isProd ? 'Something went wrong on our side. Please try again.' : (err.message || 'Something went wrong.');
    if (res.headersSent) return next(err);
    if (wantsJson(req)) return res.status(status).json({ error: message });
    if (req.headers['hx-request']) return res.status(status).send(`<div class="inline-error">${escapeHtml(message)}</div>`);
    res.status(status).render('message', { title: 'Something went wrong', heading: 'Something went wrong', body: message, backHref: '/', backLabel: 'Go home' });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`\nCompany portal running at http://localhost:${PORT}\n`));

  // Render sends SIGTERM on every deploy / spin-down.
  const shutdown = () => {
    console.log('Shutting down...');
    io.close(() => server.close(() => db.pool.end().finally(() => process.exit(0))));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
