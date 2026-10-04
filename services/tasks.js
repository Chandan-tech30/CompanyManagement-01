const db = require('../db');
const { filesFor } = require('./files');

// Tasks of one employee, as seen by `viewerId` (tasks the viewer removed from their own view are left out).
async function getTasks(employeeId, viewerId) {
  const tasks = await db.all(
    `SELECT t.* FROM tasks t
     WHERE t.employee_id = ?
       AND NOT EXISTS (SELECT 1 FROM hidden_items h WHERE h.user_id = ? AND h.kind = 'task' AND h.item_id = t.id)
     ORDER BY CASE t.status WHEN 'assigned' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END, t.created_at DESC`,
    [employeeId, viewerId]
  );
  const files = await filesFor('task', tasks.map((t) => t.id));
  tasks.forEach((t) => { t.files = files.get(t.id) || []; });
  return tasks;
}

// Locals for views/partials/tasks-panel.ejs
async function panelLocals(viewer, employee) {
  const isAdmin = viewer.role === 'admin';
  return {
    tasks: await getTasks(employee.id, viewer.id),
    viewerRole: viewer.role,
    employeeId: employee.id,
    employeeName: employee.full_name,
    canAssign: isAdmin,
    tasksRefreshUrl: isAdmin ? `/admin/employees/${employee.id}/tasks-panel` : '/employee/work/tasks-panel',
  };
}

module.exports = { getTasks, panelLocals };
