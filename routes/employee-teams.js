// Employee side of teams: see my teams, read/write the team chat (if allowed), submit work to the admin.
const express = require('express');
const db = require('../db');
const storage = require('../utils/storage');
const { uploadWork, collectUploads } = require('../utils/upload');
const { UserError } = require('../utils/errors');
const { logActivity } = require('../utils/helpers');
const { renderEmployeePage } = require('../utils/pages');
const files = require('../services/files');
const chat = require('../services/chat');
const teams = require('../services/teams');

const router = express.Router();

async function loadDetail(req) {
  const detail = await teams.getEmployeeDetail(req.user.id, Number(req.params.id));
  if (!detail) throw new UserError('You are not a member of this team.', 404);
  return detail;
}

router.get('/:id', async (req, res, next) => {
  try {
    const detail = await loadDetail(req);
    const thread = await chat.getTeamThread(detail.team.id);
    const ctx = await chat.getThreadContext(req.user, thread.id);
    const locals = { ...detail, ...(await chat.chatLocals(req.user, ctx)) };
    renderEmployeePage(req, res, { tab: 'teams', partial: 'team-detail', locals, title: detail.team.name });
  } catch (err) { next(err); }
});

// just the assignments block (refreshed live when the admin reviews something)
router.get('/:id/assignments', async (req, res, next) => {
  try { res.render('employee/partials/team-assignments', await loadDetail(req)); } catch (err) { next(err); }
});

// Submit files/folders for an assignment. Allowed when nothing was sent yet, or the admin sent it back.
router.post('/:id/assignments/:aid/submit', uploadWork, async (req, res, next) => {
  try {
    const detail = await loadDetail(req);
    const assignment = detail.assignments.find((a) => a.id === Number(req.params.aid));
    if (!assignment) throw new UserError('Assignment not found.', 404);
    if (assignment.latest && assignment.latest.status !== 'rejected') throw new UserError('You already submitted this assignment.');
    const uploads = collectUploads(req);
    const note = String((req.body && req.body.note) || '').trim().slice(0, 3000);
    if (!uploads.length && !note) throw new UserError('Attach at least one file or folder, or write a note.');

    const uploaded = await files.uploadToStorage(uploads, 'team-submissions');
    try {
      await db.tx(async (t) => {
        const row = await t.get(
          `INSERT INTO team_submissions (assignment_id, member_id, note) VALUES (?,?,?) RETURNING id`,
          [assignment.id, req.user.id, note]
        );
        await files.insertFileRows(t, uploaded, { refType: 'team_submission', refId: row.id, uploaderId: req.user.id });
      });
    } catch (err) { await storage.deleteKeys(uploaded.map((u) => u.key)); throw err; }
    await logActivity(req.user.id, 'team_submitted');
    req.app.get('io').to('admins').emit('team:updated', { teamId: detail.team.id, by: req.user.full_name });
    res.render('employee/partials/team-assignments', await loadDetail(req));
  } catch (err) { next(err); }
});

// Remove an approved (finished) assignment from MY list — the admin's records are untouched.
router.post('/:id/assignments/:aid/hide', async (req, res, next) => {
  try {
    const detail = await loadDetail(req);
    const assignment = detail.assignments.find((a) => a.id === Number(req.params.aid));
    if (!assignment || !assignment.latest || assignment.latest.status !== 'approved') throw new UserError('Only approved assignments can be removed from your list.');
    await db.run(`INSERT INTO hidden_items (user_id, kind, item_id) VALUES (?, 'team_assignment', ?) ON CONFLICT DO NOTHING`, [req.user.id, assignment.id]);
    res.render('employee/partials/team-assignments', await loadDetail(req));
  } catch (err) { next(err); }
});

module.exports = router;
