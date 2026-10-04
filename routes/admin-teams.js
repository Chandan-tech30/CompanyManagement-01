// Admin side of teams: create a team, add/remove members, decide who may write in the chat,
// hand out assignments, review what members submit.
const express = require('express');
const db = require('../db');
const storage = require('../utils/storage');
const { UserError } = require('../utils/errors');
const { renderAdminPage } = require('../utils/pages');
const files = require('../services/files');
const chat = require('../services/chat');
const teams = require('../services/teams');

const router = express.Router();
const MODES = ['all', 'admin_only', 'selected'];
const asArray = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]);

async function detail(req) {
  const d = await teams.getAdminDetail(Number(req.params.id));
  if (!d) throw new UserError('Team not found.', 404);
  return d;
}
// full = membership / chat rules changed (member pages reload); otherwise only the assignments block refreshes
const tellMembers = (req, teamId, memberIds, full = false) => {
  const io = req.app.get('io');
  memberIds.forEach((id) => io.to(`user-${id}`).emit('team:updated', { teamId, full }));
};

// ---- create ------------------------------------------------------------------------
router.post('/', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 120);
    if (!name) throw new UserError('Give the team a name.');
    const mode = MODES.includes(req.body.chat_mode) ? req.body.chat_mode : 'all';
    const memberIds = chat.parseIds(req.body.members);
    const teamId = await db.tx(async (t) => {
      const row = await t.get(`INSERT INTO teams (name, description, chat_mode, created_by) VALUES (?,?,?,?) RETURNING id`,
        [name, String(req.body.description || '').trim().slice(0, 1000), mode, req.user.id]);
      await t.run(`INSERT INTO threads (type, team_id) VALUES ('team', ?)`, [row.id]);
      if (memberIds.length) {
        await t.run(
          `INSERT INTO team_members (team_id, user_id) SELECT ?::int, u.id FROM users u WHERE u.role = 'employee' AND u.status = 'approved' AND u.id = ANY(?) ON CONFLICT DO NOTHING`,
          [row.id, memberIds]
        );
      }
      return row.id;
    });
    tellMembers(req, teamId, memberIds, true);
    if (req.headers['hx-request']) res.set('HX-Push-Url', `/admin/teams/${teamId}`);
    req.params.id = teamId;
    await sendPage(req, res);
  } catch (err) { next(err); }
});

async function sendPage(req, res) {
  const d = await detail(req);
  const thread = await chat.getTeamThread(d.team.id);
  const ctx = await chat.getThreadContext(req.user, thread.id);
  const locals = { ...d, ...(await chat.chatLocals(req.user, ctx)) };
  renderAdminPage(req, res, { tab: 'teams', partial: 'team-detail', locals, title: d.team.name });
}
router.get('/:id', async (req, res, next) => { try { await sendPage(req, res); } catch (err) { next(err); } });

// region: assignments + submissions (also refreshed live when an employee submits)
router.get('/:id/assignments', async (req, res, next) => {
  try { res.render('admin/partials/team-assignments', await detail(req)); } catch (err) { next(err); }
});

// ---- settings / members (returns the header block) ---------------------------------------
const sendHead = async (req, res) => res.render('admin/partials/team-head', await detail(req));

router.post('/:id/settings', async (req, res, next) => {
  try {
    const d = await detail(req);
    const name = String(req.body.name || '').trim().slice(0, 120) || d.team.name;
    const mode = MODES.includes(req.body.chat_mode) ? req.body.chat_mode : d.team.chat_mode;
    await db.run('UPDATE teams SET name = ?, description = ?, chat_mode = ? WHERE id = ?',
      [name, String(req.body.description || '').trim().slice(0, 1000), mode, d.team.id]);
    tellMembers(req, d.team.id, d.members.map((m) => m.id), true); // their composer must follow the new rule
    await sendHead(req, res);
  } catch (err) { next(err); }
});

router.post('/:id/members', async (req, res, next) => {
  try {
    const d = await detail(req);
    const ids = chat.parseIds(req.body.user_id);
    if (ids.length) {
      await db.run(
        `INSERT INTO team_members (team_id, user_id) SELECT ?::int, u.id FROM users u WHERE u.role = 'employee' AND u.status = 'approved' AND u.id = ANY(?) ON CONFLICT DO NOTHING`,
        [d.team.id, ids]
      );
      tellMembers(req, d.team.id, ids, true);
    }
    await sendHead(req, res);
  } catch (err) { next(err); }
});

router.post('/:id/members/:uid/remove', async (req, res, next) => {
  try {
    const d = await detail(req);
    await db.run('DELETE FROM team_members WHERE team_id = ? AND user_id = ?', [d.team.id, Number(req.params.uid)]);
    tellMembers(req, d.team.id, [Number(req.params.uid)], true);
    await sendHead(req, res);
  } catch (err) { next(err); }
});

// when the chat mode is "selected members only": who may write
router.post('/:id/members/:uid/post', async (req, res, next) => {
  try {
    const d = await detail(req);
    await db.run('UPDATE team_members SET can_post = NOT can_post WHERE team_id = ? AND user_id = ?', [d.team.id, Number(req.params.uid)]);
    tellMembers(req, d.team.id, [Number(req.params.uid)], true);
    await sendHead(req, res);
  } catch (err) { next(err); }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const d = await detail(req);
    const memberIds = d.members.map((m) => m.id);
    const keys = await db.tx(async (t) => {
      const submissionIds = (await t.all(
        `SELECT s.id FROM team_submissions s JOIN team_assignments a ON a.id = s.assignment_id WHERE a.team_id = ?`, [d.team.id]
      )).map((r) => r.id);
      const messageIds = (await t.all(
        `SELECT m.id FROM messages m JOIN threads th ON th.id = m.thread_id WHERE th.type = 'team' AND th.team_id = ?`, [d.team.id]
      )).map((r) => r.id);
      const k = [...(await files.detachFiles(t, 'team_submission', submissionIds)), ...(await files.detachFiles(t, 'message', messageIds))];
      await t.run('DELETE FROM teams WHERE id = ?', [d.team.id]); // cascades: members, assignments, submissions, thread, messages
      return k;
    });
    await storage.deleteKeys(keys);
    tellMembers(req, d.team.id, memberIds, true);
    res.set('HX-Redirect', '/admin/tab/teams').status(200).end();
  } catch (err) { next(err); }
});

// ---- assignments ------------------------------------------------------------------------
const sendAssignments = async (req, res) => res.render('admin/partials/team-assignments', await detail(req));

router.post('/:id/assignments', async (req, res, next) => {
  try {
    const d = await detail(req);
    const title = String(req.body.title || '').trim().slice(0, 200);
    if (!title) throw new UserError('Give the assignment a title.');
    await db.run('INSERT INTO team_assignments (team_id, title, description, deadline) VALUES (?,?,?,?)',
      [d.team.id, title, String(req.body.description || '').trim().slice(0, 4000), req.body.deadline || null]);
    tellMembers(req, d.team.id, d.members.map((m) => m.id));
    await sendAssignments(req, res);
  } catch (err) { next(err); }
});

router.post('/:id/assignments/:aid/delete', async (req, res, next) => {
  try {
    const d = await detail(req);
    const a = d.assignments.find((x) => x.id === Number(req.params.aid));
    if (a) {
      const keys = await db.tx(async (t) => {
        const k = await files.detachFiles(t, 'team_submission', a.submissions.map((s) => s.id));
        await t.run('DELETE FROM team_assignments WHERE id = ?', [a.id]);
        return k;
      });
      await storage.deleteKeys(keys);
      tellMembers(req, d.team.id, d.members.map((m) => m.id));
    }
    await sendAssignments(req, res);
  } catch (err) { next(err); }
});

// Approve a submission, or send it back with feedback (the member can then submit again).
router.post('/:id/submissions/:sid/review', async (req, res, next) => {
  try {
    const d = await detail(req);
    const decision = req.body.decision === 'approve' ? 'approved' : req.body.decision === 'reject' ? 'rejected' : null;
    if (!decision) throw new UserError('Choose approve or send back.');
    const sub = await db.get(
      `SELECT s.* FROM team_submissions s JOIN team_assignments a ON a.id = s.assignment_id WHERE s.id = ? AND a.team_id = ? AND s.status = 'submitted'`,
      [Number(req.params.sid), d.team.id]
    );
    if (sub) {
      await db.run(`UPDATE team_submissions SET status = ?, admin_feedback = ?, reviewed_at = NOW() WHERE id = ?`,
        [decision, String(req.body.feedback || '').trim().slice(0, 2000), sub.id]);
      tellMembers(req, d.team.id, [sub.member_id]);
    }
    await sendAssignments(req, res);
  } catch (err) { next(err); }
});

module.exports = router;
