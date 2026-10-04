const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { imageUploader } = require('../utils/upload');
const { UserError } = require('../utils/errors');
const { sendApprovalEmail, sendRejectionEmail } = require('../utils/mailer');
const { renderAdminPage, adminNav } = require('../utils/pages');
const files = require('../services/files');
const chat = require('../services/chat');
const tasks = require('../services/tasks');
const activity = require('../services/activity');
const teams = require('../services/teams');
const announcements = require('../services/announcements');
const { projectsFor } = require('../services/projects');

const router = express.Router();
router.use(requireAdmin);
router.use(async (req, res, next) => {
  try { res.locals.nav = await adminNav(); next(); } catch (err) { next(err); }
});

const TABS = ['registrations', 'employees', 'teams', 'announcements', 'leave', 'company', 'growth', 'projects', 'assign-role', 'personal'];
const approvedEmployees = () => db.all(`SELECT * FROM users WHERE role='employee' AND status='approved' ORDER BY full_name ASC`);

async function buildTabLocals(req, tab, extra = {}) {
  switch (tab) {
    case 'registrations': {
      const pending = await db.all(`SELECT * FROM users WHERE role='employee' AND status='pending_approval' ORDER BY created_at ASC`);
      const unverifiedCount = Number((await db.get(`SELECT COUNT(*) c FROM users WHERE role='employee' AND status='pending_verification'`)).c);
      return { pending, unverifiedCount, ...extra };
    }
    case 'employees': return { employees: await approvedEmployees(), ...extra };
    case 'teams': return { teams: await teams.listForAdmin(), employees: await approvedEmployees(), ...extra };
    case 'announcements': return { announcements: await announcements.listForAdmin(), employees: await approvedEmployees(), isAdmin: true, ...extra };
    case 'leave': {
      const rows = await db.all(
        `SELECT l.id, l.kind, l.start_date::text AS start_date, l.end_date::text AS end_date, l.reason, l.status, l.admin_note, l.created_at, l.decided_at,
                u.full_name, u.email, u.job_role
         FROM leave_requests l JOIN users u ON u.id = l.user_id ORDER BY (l.status = 'pending') DESC, l.created_at DESC LIMIT 100`
      );
      return { pending: rows.filter((r) => r.status === 'pending'), history: rows.filter((r) => r.status !== 'pending'), ...extra };
    }
    case 'company': return { company: await db.get('SELECT * FROM company WHERE id = 1'), ...extra };
    case 'growth': return { points: await db.all('SELECT * FROM growth_points ORDER BY created_at ASC'), ...extra };
    case 'projects': {
      const employees = await db.all(
        `SELECT u.*, (SELECT COUNT(*)::int FROM personal_projects p WHERE p.user_id = u.id) AS project_count
         FROM users u WHERE u.role='employee' AND u.status='approved' ORDER BY u.full_name ASC`
      );
      return { employees, ...extra };
    }
    case 'assign-role': return { employees: await approvedEmployees(), ...extra };
    case 'personal': return { projects: await projectsFor(req.user.id), editable: true, ...extra };
    default: return extra;
  }
}

async function renderTab(req, res, next, tab, extra = {}) {
  try {
    const safeTab = TABS.includes(tab) ? tab : 'registrations';
    renderAdminPage(req, res, { tab: safeTab, partial: safeTab, locals: await buildTabLocals(req, safeTab, extra) });
  } catch (err) { next(err); }
}

router.get('/dashboard', (req, res, next) => renderTab(req, res, next, 'registrations'));
router.get('/tab/:tab', (req, res, next) => renderTab(req, res, next, req.params.tab));

// ---- global search (employees by name) ----------------------------------------
router.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 60);
    let results = [];
    if (q) {
      const escaped = q.replace(/[\\%_]/g, '\\$&');
      const like = `%${escaped}%`;
      const prefix = `${escaped}%`; // names that START with the text are listed first
      results = await db.all(
        `SELECT id, full_name, job_role, avatar_path, status FROM users
         WHERE role = 'employee' AND status IN ('approved','pending_approval') AND (full_name ILIKE ? OR email ILIKE ?)
         ORDER BY (full_name ILIKE ?) DESC, full_name LIMIT 8`,
        [like, like, prefix]
      );
    }
    res.render('admin/partials/search-results', { q, results });
  } catch (err) { next(err); }
});

// ---- registrations -------------------------------------------------------------
router.post('/registrations/:id/approve', async (req, res, next) => {
  try {
    const user = await db.get(`SELECT * FROM users WHERE id=? AND status='pending_approval'`, [req.params.id]);
    if (user) { await db.run(`UPDATE users SET status='approved' WHERE id=?`, [user.id]); sendApprovalEmail(user.email, `${req.protocol}://${req.get('host')}/login/employee`); }
    res.locals.nav = await adminNav();
    renderTab(req, res, next, 'registrations');
  } catch (err) { next(err); }
});

router.post('/registrations/:id/reject', async (req, res, next) => {
  try {
    const user = await db.get(`SELECT * FROM users WHERE id=? AND status='pending_approval'`, [req.params.id]);
    if (user) { await db.run(`UPDATE users SET status='rejected' WHERE id=?`, [user.id]); sendRejectionEmail(user.email); }
    renderTab(req, res, next, 'registrations');
  } catch (err) { next(err); }
});

// ---- one employee: chat + tasks + activity --------------------------------------
async function loadEmployee(id) {
  const employee = await db.get(`SELECT * FROM users WHERE id=? AND role='employee'`, [id]);
  if (!employee) throw new UserError('Employee not found.', 404);
  return employee;
}

router.get('/employees/:id', async (req, res, next) => {
  try {
    const employee = await loadEmployee(req.params.id);
    await db.run('UPDATE users SET admin_unread = 0 WHERE id = ?', [employee.id]);
    const thread = await chat.getDmThread(employee.id);
    const ctx = await chat.getThreadContext(req.user, thread.id);
    // The page itself is only work & deadlines + chat. The activity graph is loaded on demand (Activity button).
    const locals = { employee, ...(await tasks.panelLocals(req.user, employee)), ...(await chat.chatLocals(req.user, ctx)) };
    renderAdminPage(req, res, { tab: 'employees', partial: 'employee-detail', locals, title: employee.full_name });
  } catch (err) { next(err); }
});

// Daily-activity graph, opened as a pop-up from the "Activity" button on the employee page.
router.get('/employees/:id/activity', async (req, res, next) => {
  try {
    const employee = await loadEmployee(req.params.id);
    if (!req.headers['hx-request']) return res.redirect(`/admin/employees/${employee.id}`);
    const range = [7, 14, 30].includes(Number(req.query.range)) ? Number(req.query.range) : 14;
    res.render('admin/partials/employee-activity-modal', {
      employee, activity: await activity.getActivity(employee.id, range),
      exportUrl: `/admin/employees/${employee.id}/activity.csv`, canPickRange: true,
      rangeUrl: `/admin/employees/${employee.id}/activity`, rangeTarget: '#modal-root',
    });
  } catch (err) { next(err); }
});

router.get('/employees/:id/activity.csv', async (req, res, next) => {
  try {
    const employee = await loadEmployee(req.params.id);
    const data = await activity.getActivity(employee.id, 30);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="activity-${employee.id}-30d.csv"` });
    res.send('\uFEFF' + activity.activityCsv(data));
  } catch (err) { next(err); }
});

router.get('/employees/:id/tasks-panel', async (req, res, next) => {
  try { res.render('partials/tasks-panel', await tasks.panelLocals(req.user, await loadEmployee(req.params.id))); } catch (err) { next(err); }
});

router.post('/employees/:id/tasks', async (req, res, next) => {
  try {
    const employee = await loadEmployee(req.params.id);
    const { title, description, deadline } = req.body;
    if (title && title.trim()) {
      await db.run('INSERT INTO tasks (employee_id, title, description, deadline) VALUES (?,?,?,?)', [employee.id, title.trim(), description || '', deadline || null]);
      await db.run('UPDATE users SET employee_unread = 1 WHERE id = ?', [employee.id]);
      req.app.get('io').to(`user-${employee.id}`).emit('task:updated', { employeeId: employee.id });
    }
    res.render('partials/tasks-panel', await tasks.panelLocals(req.user, employee));
  } catch (err) { next(err); }
});

router.post('/employees/:id/tasks/:taskId/approve', async (req, res, next) => {
  try {
    const employee = await loadEmployee(req.params.id);
    await db.run(`UPDATE tasks SET status='approved', approved_at=NOW(), updated_at=NOW() WHERE id=? AND employee_id=? AND status='submitted'`, [req.params.taskId, employee.id]);
    req.app.get('io').to(`user-${employee.id}`).emit('task:updated', { employeeId: employee.id });
    res.render('partials/tasks-panel', await tasks.panelLocals(req.user, employee));
  } catch (err) { next(err); }
});

// Admin "deletes" completed tasks from THEIR view; the employee keeps theirs.
router.post('/employees/:id/tasks/hide', async (req, res, next) => {
  try {
    const employee = await loadEmployee(req.params.id);
    const ids = chat.parseIds(req.body.ids);
    if (!ids.length) throw new UserError('No tasks selected.');
    await db.run(
      `INSERT INTO hidden_items (user_id, kind, item_id)
       SELECT ?::int, 'task', t.id FROM tasks t WHERE t.employee_id = ? AND t.status = 'approved' AND t.id = ANY(?)
       ON CONFLICT DO NOTHING`,
      [req.user.id, employee.id, ids]
    );
    res.render('partials/tasks-panel', await tasks.panelLocals(req.user, employee));
  } catch (err) { next(err); }
});

// ---- employees' projects (read-only) --------------------------------------------
router.get('/employees/:id/projects', async (req, res, next) => {
  try {
    const employee = await loadEmployee(req.params.id);
    const locals = { employee, projects: await projectsFor(employee.id), editable: false };
    renderAdminPage(req, res, { tab: 'projects', partial: 'employee-projects', locals, title: `${employee.full_name} - projects` });
  } catch (err) { next(err); }
});

// ---- company / growth / roles ----------------------------------------------------
router.post('/company', imageUploader.single('logo'), async (req, res, next) => {
  try {
    const { name, ethics, agenda } = req.body;
    if (req.file) {
      const old = (await db.get('SELECT logo_path FROM company WHERE id = 1')).logo_path;
      const [row] = await files.saveUploads([{ file: req.file, relPath: '' }], { refType: 'public', refId: 1, uploaderId: req.user.id, prefix: 'branding' });
      await db.run(`UPDATE company SET name=?, ethics=?, agenda=?, logo_path=?, updated_at=NOW() WHERE id=1`, [name || 'Your Company Name', ethics || '', agenda || '', `/files/${row.id}`]);
      await files.purgeByUrl(old);
    } else {
      await db.run(`UPDATE company SET name=?, ethics=?, agenda=?, updated_at=NOW() WHERE id=1`, [name || 'Your Company Name', ethics || '', agenda || '']);
    }
    res.locals.company = await db.get('SELECT * FROM company WHERE id = 1');
    renderTab(req, res, next, 'company', { justSaved: true });
  } catch (err) { next(err); }
});

router.post('/growth', async (req, res, next) => {
  try {
    const { label, value } = req.body;
    if (label && label.trim() && value !== '' && !isNaN(Number(value))) await db.run('INSERT INTO growth_points (label, value) VALUES (?,?)', [label.trim(), Number(value)]);
    renderTab(req, res, next, 'growth');
  } catch (err) { next(err); }
});

router.post('/growth/:id/delete', async (req, res, next) => {
  try { await db.run('DELETE FROM growth_points WHERE id = ?', [req.params.id]); renderTab(req, res, next, 'growth'); }
  catch (err) { next(err); }
});

router.post('/roles', async (req, res, next) => {
  try {
    const { employee_id, job_role } = req.body;
    const employee = await db.get(`SELECT * FROM users WHERE id=? AND role='employee'`, [employee_id]);
    if (employee && job_role && job_role.trim()) await db.run('UPDATE users SET job_role = ? WHERE id = ?', [job_role.trim().slice(0, 100), employee.id]);
    renderTab(req, res, next, 'assign-role', { justAssigned: true });
  } catch (err) { next(err); }
});

// ---- leave requests -----------------------------------------------------------------
router.post('/leave/:id/decide', async (req, res, next) => {
  try {
    const decision = req.body.decision === 'approve' ? 'approved' : req.body.decision === 'reject' ? 'rejected' : null;
    if (!decision) throw new UserError('Choose approve or reject.');
    const lr = await db.get(`SELECT * FROM leave_requests WHERE id = ? AND status = 'pending'`, [req.params.id]);
    if (lr) {
      await db.tx(async (t) => {
        await t.run(`UPDATE leave_requests SET status=?, admin_note=?, decided_at=NOW() WHERE id=?`, [decision, (req.body.note || '').trim().slice(0, 1000), lr.id]);
        if (decision === 'approved' && lr.kind === 'leave_portal') await t.run(`UPDATE users SET status='left' WHERE id=? AND role='employee'`, [lr.user_id]);
      });
      if (decision === 'approved' && lr.kind === 'leave_portal') {
        try { await db.run(`DELETE FROM session WHERE sess->>'userId' = ?`, [String(lr.user_id)]); } catch (e) { console.error('[admin] could not end sessions:', e.message); }
      }
      req.app.get('io').to(`user-${lr.user_id}`).emit('leave:decided', { status: decision });
    }
    res.locals.nav = await adminNav();
    renderTab(req, res, next, 'leave');
  } catch (err) { next(err); }
});

router.use('/teams', require('./admin-teams'));
router.use('/announcements', require('./admin-announcements'));

module.exports = router;
