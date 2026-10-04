const express = require('express');
const db = require('../db');
const { requireEmployee } = require('../middleware/auth');
const { logActivity } = require('../utils/helpers');
const { imageUploader, uploadWork, collectUploads } = require('../utils/upload');
const { UserError } = require('../utils/errors');
const { renderEmployeePage, employeeNav } = require('../utils/pages');
const files = require('../services/files');
const storage = require('../utils/storage');
const chat = require('../services/chat');
const tasks = require('../services/tasks');
const activity = require('../services/activity');
const teams = require('../services/teams');
const announcements = require('../services/announcements');
const { projectsFor } = require('../services/projects');

const router = express.Router();
router.use(requireEmployee);
router.use(async (req, res, next) => {
  try { res.locals.nav = await employeeNav(req.user); next(); } catch (err) { next(err); }
});

const TABS = ['overview', 'profile', 'roles', 'work', 'progress', 'projects', 'teams', 'announcements', 'company'];

async function counts(userId) {
  const r = await db.get(
    `SELECT
       (SELECT COUNT(*)::int FROM tasks WHERE employee_id = ? AND status = 'assigned') AS assigned,
       (SELECT COUNT(*)::int FROM tasks WHERE employee_id = ? AND status = 'submitted') AS submitted,
       (SELECT COUNT(*)::int FROM tasks WHERE employee_id = ? AND status = 'approved') AS approved,
       (SELECT COUNT(*)::int FROM personal_projects WHERE user_id = ?) AS projects,
       (SELECT COUNT(*)::int FROM personal_projects WHERE user_id = ? AND completed_at IS NOT NULL) AS projects_done`,
    [userId, userId, userId, userId, userId]
  );
  return r;
}

async function buildTabLocals(req, tab, extra = {}) {
  const user = req.user;
  switch (tab) {
    case 'profile': return { user, ...extra };
    case 'roles': return { user, ...extra };
    case 'work': {
      await db.run('UPDATE users SET employee_unread = 0 WHERE id = ?', [user.id]);
      const thread = await chat.getDmThread(user.id);
      const ctx = await chat.getThreadContext(user, thread.id);
      return { ...(await tasks.panelLocals(user, user)), ...(await chat.chatLocals(user, ctx)), ...extra };
    }
    case 'progress': {
      const range = [7, 14, 30].includes(Number(req.query.range)) ? Number(req.query.range) : 14;
      const c = await counts(user.id);
      const t = await teams.teamStats(user.id);
      const stats = { ...c, teamSubmitted: t.submitted, teamApproved: t.approved };
      return { activity: await activity.getActivity(user.id, range), stats, exportUrl: `/employee/progress/export.csv?range=${range}`, canPickRange: true, ...extra };
    }
    case 'projects': return { projects: await projectsFor(user.id), editable: true, ...extra };
    case 'teams': return { teams: await teams.listForEmployee(user.id), ...extra };
    case 'announcements': {
      const list = await announcements.visibleTo(user.id);
      await db.run('UPDATE users SET announcements_seen_at = NOW() WHERE id = ?', [user.id]);
      return { announcements: list, highlight: extra.highlight || null, isAdmin: false, ...extra };
    }
    case 'company': return { company: await db.get('SELECT * FROM company WHERE id = 1'), ...extra };
    case 'overview':
    default: {
      const upcoming = await db.get(`SELECT * FROM tasks WHERE employee_id = ? AND status = 'assigned' AND deadline IS NOT NULL ORDER BY deadline ASC LIMIT 1`, [user.id]);
      const c = await counts(user.id);
      const company = await db.get('SELECT * FROM company WHERE id = 1');
      return { user, company, stats: { ...c, unread: user.employee_unread }, upcoming, ...extra };
    }
  }
}

async function renderTab(req, res, next, tab, extra = {}) {
  try {
    const safeTab = TABS.includes(tab) ? tab : 'overview';
    const locals = await buildTabLocals(req, safeTab, extra);
    renderEmployeePage(req, res, { tab: safeTab, locals, title: 'Employee dashboard' });
  } catch (err) { next(err); }
}

router.get('/dashboard', (req, res, next) => renderTab(req, res, next, 'overview'));
router.get('/tab/:tab', (req, res, next) => renderTab(req, res, next, req.params.tab));

// Shareable link of one announcement (the admin's "copy link" button)
router.get('/announcements/:id', (req, res, next) => renderTab(req, res, next, 'announcements', { highlight: Number(req.params.id) || null }));

// ---- profile -----------------------------------------------------------------
router.post('/profile', imageUploader.single('avatar'), async (req, res, next) => {
  try {
    const { phone, bio, skills } = req.body;
    const cleanSkills = (skills || '').split(',').map((s) => s.trim()).filter(Boolean).join(', ');
    if (req.file) {
      const [row] = await files.saveUploads([{ file: req.file, relPath: '' }], { refType: 'avatar', refId: req.user.id, uploaderId: req.user.id, prefix: 'avatars' });
      const old = req.user.avatar_path;
      await db.run('UPDATE users SET phone=?, bio=?, skills=?, avatar_path=? WHERE id=?', [phone || '', bio || '', cleanSkills, `/files/${row.id}`, req.user.id]);
      await files.purgeByUrl(old);
    } else {
      await db.run('UPDATE users SET phone=?, bio=?, skills=? WHERE id=?', [phone || '', bio || '', cleanSkills, req.user.id]);
    }
    await logActivity(req.user.id, 'profile_updated');
    req.user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
    res.locals.currentUser = req.user;
    renderTab(req, res, next, 'profile', { justSaved: true });
  } catch (err) { next(err); }
});

// ---- tasks -------------------------------------------------------------------
router.get('/work/tasks-panel', async (req, res, next) => {
  try { res.render('partials/tasks-panel', await tasks.panelLocals(req.user, req.user)); } catch (err) { next(err); }
});

// Submit work: note + any number of files or whole folders.
router.post('/tasks/:id/submit', uploadWork, async (req, res, next) => {
  try {
    const task = await db.get('SELECT * FROM tasks WHERE id = ? AND employee_id = ?', [req.params.id, req.user.id]);
    if (!task) throw new UserError('Task not found.', 404);
    if (task.status !== 'assigned') throw new UserError('This task has already been submitted.');
    const uploads = collectUploads(req);
    const uploaded = await files.uploadToStorage(uploads, 'tasks');
    try {
      await db.tx(async (t) => {
        await files.insertFileRows(t, uploaded, { refType: 'task', refId: task.id, uploaderId: req.user.id });
        await t.run(`UPDATE tasks SET status='submitted', submission_note=?, updated_at=NOW() WHERE id=?`, [(req.body.submission_note || '').slice(0, 3000), task.id]);
        await t.run('UPDATE users SET admin_unread = 1 WHERE id = ?', [req.user.id]);
      });
    } catch (err) { await storage.deleteKeys(uploaded.map((u) => u.key)); throw err; }
    await logActivity(req.user.id, 'task_submitted');
    const io = req.app.get('io');
    io.to('admins').emit('task:updated', { employeeId: req.user.id });
    res.render('partials/tasks-panel', await tasks.panelLocals(req.user, req.user));
  } catch (err) { next(err); }
});

// "Delete" completed (approved) tasks from MY view only — the admin keeps their own copy.
router.post('/tasks/hide', async (req, res, next) => {
  try {
    const ids = chat.parseIds(req.body.ids);
    if (!ids.length) throw new UserError('No tasks selected.');
    await db.run(
      `INSERT INTO hidden_items (user_id, kind, item_id)
       SELECT ?::int, 'task', t.id FROM tasks t WHERE t.employee_id = ? AND t.status = 'approved' AND t.id = ANY(?)
       ON CONFLICT DO NOTHING`,
      [req.user.id, req.user.id, ids]
    );
    res.render('partials/tasks-panel', await tasks.panelLocals(req.user, req.user));
  } catch (err) { next(err); }
});

// ---- progress ----------------------------------------------------------------
router.post('/heartbeat', async (req, res, next) => {
  try { res.json({ added: await activity.recordHeartbeat(req.user) }); } catch (err) { next(err); }
});

router.get('/progress/export.csv', async (req, res, next) => {
  try {
    const range = [7, 14, 30].includes(Number(req.query.range)) ? Number(req.query.range) : 14;
    const data = await activity.getActivity(req.user.id, range);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="daily-activity-${range}d.csv"` });
    res.send('\uFEFF' + activity.activityCsv(data));
  } catch (err) { next(err); }
});

router.use('/teams', require('./employee-teams'));

module.exports = router;
