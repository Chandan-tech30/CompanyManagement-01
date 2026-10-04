const db = require('../db');
const { filesFor } = require('./files');

async function listForAdmin() {
  return db.all(
    `SELECT t.*,
       (SELECT COUNT(*)::int FROM team_members m WHERE m.team_id = t.id) AS member_count,
       (SELECT COUNT(*)::int FROM team_assignments a WHERE a.team_id = t.id) AS assignment_count,
       (SELECT COUNT(*)::int FROM team_submissions s JOIN team_assignments a ON a.id = s.assignment_id
          WHERE a.team_id = t.id AND s.status = 'submitted') AS pending_reviews
     FROM teams t ORDER BY t.created_at DESC`
  );
}

async function listForEmployee(userId) {
  return db.all(
    `SELECT t.*, tm.can_post,
       (SELECT COUNT(*)::int FROM team_members m WHERE m.team_id = t.id) AS member_count,
       (SELECT COUNT(*)::int FROM team_assignments a WHERE a.team_id = t.id) AS assignment_count
     FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ?
     ORDER BY t.created_at DESC`,
    [userId]
  );
}

async function getMembers(teamId) {
  return db.all(
    `SELECT u.id, u.full_name, u.email, u.job_role, u.avatar_path, tm.can_post
     FROM team_members tm JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY u.full_name`,
    [teamId]
  );
}

// Everything the admin's team page needs: members, people who could be added, and every assignment
// with each member's submissions (files included).
async function getAdminDetail(teamId) {
  const team = await db.get('SELECT * FROM teams WHERE id = ?', [teamId]);
  if (!team) return null;
  const members = await getMembers(teamId);
  const candidates = await db.all(
    `SELECT id, full_name, job_role FROM users
     WHERE role = 'employee' AND status = 'approved'
       AND NOT EXISTS (SELECT 1 FROM team_members tm WHERE tm.team_id = ? AND tm.user_id = users.id)
     ORDER BY full_name`,
    [teamId]
  );
  const assignments = await db.all('SELECT * FROM team_assignments WHERE team_id = ? ORDER BY created_at DESC', [teamId]);
  const subs = await db.all(
    `SELECT s.*, u.full_name FROM team_submissions s JOIN users u ON u.id = s.member_id
     WHERE s.assignment_id = ANY(?) ORDER BY s.submitted_at DESC`,
    [assignments.map((a) => a.id)]
  );
  const files = await filesFor('team_submission', subs.map((s) => s.id));
  subs.forEach((s) => { s.files = files.get(s.id) || []; });
  assignments.forEach((a) => {
    a.submissions = subs.filter((s) => s.assignment_id === a.id);
    a.notSubmitted = members.filter((m) => !a.submissions.some((s) => s.member_id === m.id));
  });
  return { team, members, candidates, assignments };
}

// The employee's view of one team. Returns null if they are not a member.
async function getEmployeeDetail(userId, teamId) {
  const team = await db.get(
    `SELECT t.*, tm.can_post FROM teams t JOIN team_members tm ON tm.team_id = t.id AND tm.user_id = ? WHERE t.id = ?`,
    [userId, teamId]
  );
  if (!team) return null;
  const members = await getMembers(teamId);
  const assignments = await db.all(
    `SELECT a.* FROM team_assignments a
     WHERE a.team_id = ?
       AND NOT EXISTS (SELECT 1 FROM hidden_items h WHERE h.user_id = ? AND h.kind = 'team_assignment' AND h.item_id = a.id)
     ORDER BY a.created_at DESC`,
    [teamId, userId]
  );
  const subs = await db.all(
    `SELECT * FROM team_submissions WHERE member_id = ? AND assignment_id = ANY(?) ORDER BY submitted_at DESC`,
    [userId, assignments.map((a) => a.id)]
  );
  const files = await filesFor('team_submission', subs.map((s) => s.id));
  subs.forEach((s) => { s.files = files.get(s.id) || []; });
  assignments.forEach((a) => {
    a.mySubmissions = subs.filter((s) => s.assignment_id === a.id);
    a.latest = a.mySubmissions[0] || null;
  });
  return { team, members, assignments };
}

// For the Progress tab
async function teamStats(userId) {
  const r = await db.get(
    `SELECT COUNT(DISTINCT s.assignment_id)::int AS submitted,
            COUNT(DISTINCT CASE WHEN s.status = 'approved' THEN s.assignment_id END)::int AS approved
     FROM team_submissions s WHERE s.member_id = ?`,
    [userId]
  );
  return r || { submitted: 0, approved: 0 };
}

module.exports = { listForAdmin, listForEmployee, getMembers, getAdminDetail, getEmployeeDetail, teamStats };
