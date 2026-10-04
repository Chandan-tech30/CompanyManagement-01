// Render a tab either as an HTMX partial or inside the full dashboard shell
// (so a browser refresh on /admin/teams/5 or /employee/tab/progress still works).
const db = require('../db');

function renderAdminPage(req, res, { tab, partial, locals = {}, title }) {
  if (req.headers['hx-request']) return res.render(`admin/partials/${partial}`, locals);
  return res.render('admin/dashboard', { activeTab: tab, bodyPartial: partial, bodyLocals: locals, title: title || 'Admin dashboard', user: req.user });
}

function renderEmployeePage(req, res, { tab, partial, locals = {}, title }) {
  const view = `employee/partials/${partial || tab}`;
  if (req.headers['hx-request']) return res.render(view, locals);
  return res.render('employee/dashboard', { activeTab: tab, bodyPartial: partial || tab, tabLocals: locals, title: title || 'Employee dashboard', user: req.user });
}

// Little badges in the sidebars.
async function adminNav() {
  const r = await db.get(
    `SELECT
       (SELECT COUNT(*)::int FROM users WHERE role = 'employee' AND status = 'pending_approval') AS registrations,
       (SELECT COUNT(*)::int FROM leave_requests WHERE status = 'pending') AS leave,
       (SELECT COUNT(*)::int FROM team_submissions WHERE status = 'submitted') AS team_reviews`
  );
  return r || { registrations: 0, leave: 0, team_reviews: 0 };
}

async function employeeNav(user) {
  const r = await db.get(
    `SELECT COUNT(*)::int AS n FROM announcements a
     WHERE a.created_at > ? AND (a.audience = 'all' OR EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.user_id = ?))`,
    [user.announcements_seen_at, user.id]
  );
  return { announcements: r ? r.n : 0, work: user.employee_unread ? 1 : 0 };
}

module.exports = { renderAdminPage, renderEmployeePage, adminNav, employeeNav };
