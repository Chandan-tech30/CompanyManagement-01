// Chat API shared by every conversation (admin ↔ employee DMs and team chats).
//   GET  /chat/:threadId/messages   history, newest page or `?before=<id>`
//   POST /chat/:threadId/messages   send (text and/or files) → saved in PostgreSQL, then pushed via Socket.IO
//   POST /chat/:threadId/delete     { ids, mode: 'me' | 'everyone' }
//   GET  /chat/:threadId/download   ?ids=1,2,3  → attachments of the selected messages (zip if several)
const express = require('express');
const db = require('../db');
const storage = require('../utils/storage');
const { requireLogin } = require('../middleware/auth');
const { uploadWork, collectUploads } = require('../utils/upload');
const { UserError } = require('../utils/errors');
const { logActivity } = require('../utils/helpers');
const files = require('../services/files');
const chat = require('../services/chat');
const { sendZip } = require('./files');

const router = express.Router();
router.use(requireLogin);

router.param('threadId', async (req, res, next, value) => {
  try {
    req.ctx = await chat.getThreadContext(req.user, Number(value));
    if (!req.ctx) throw new UserError('This conversation does not exist or you are not part of it.', 404);
    next();
  } catch (err) { next(err); }
});

// "New message from X" toast + dot for people who do not have this chat open.
async function notifyOthers(io, thread, sender) {
  const payload = { threadId: thread.id, from: sender.role === 'admin' ? 'Admin' : sender.full_name };
  if (thread.type === 'dm') {
    if (sender.role === 'admin') io.to(`user-${thread.employee_id}`).emit('chat:notify', payload);
    else io.to('admins').emit('chat:notify', { ...payload, from: sender.full_name });
    return;
  }
  const members = await db.all('SELECT user_id FROM team_members WHERE team_id = ?', [thread.team_id]);
  members.filter((m) => m.user_id !== sender.id).forEach((m) => io.to(`user-${m.user_id}`).emit('chat:notify', { ...payload, from: `${payload.from} (team)` }));
  if (sender.role !== 'admin') io.to('admins').emit('chat:notify', { ...payload, from: `${sender.full_name} (team)` });
}

router.get('/:threadId/messages', async (req, res, next) => {
  try {
    const before = Number(req.query.before) || null;
    const { messages, hasMore } = await chat.listMessages(req.ctx.thread.id, req.user.id, { before });
    const html = (await Promise.all(messages.map((m) => chat.renderBubble(req.app, req.ctx.thread, m)))).join('');
    res.json({ html, hasMore, oldestId: messages.length ? messages[0].id : null, count: messages.length });
  } catch (err) { next(err); }
});

router.post('/:threadId/messages', uploadWork, async (req, res, next) => {
  let uploaded = [];
  let committed = false;
  try {
    if (!req.ctx.canPost) throw new UserError(req.ctx.readOnlyNote || 'You cannot write in this chat.', 403);
    const { thread } = req.ctx;
    const body = String((req.body && req.body.body) || '').trim().slice(0, 5000);
    const uploads = collectUploads(req);
    if (!body && !uploads.length) throw new UserError('Write a message or attach a file first.');

    // 1) bytes to the bucket   2) message + file rows in ONE transaction   3) only then tell everyone
    uploaded = await files.uploadToStorage(uploads, 'chat');
    const messageId = await db.tx(async (t) => {
      const row = await t.get(
        `INSERT INTO messages (thread_id, sender_id, sender_role, body) VALUES (?,?,?,?) RETURNING id`,
        [thread.id, req.user.id, req.user.role, body]
      );
      await files.insertFileRows(t, uploaded, { refType: 'message', refId: row.id, uploaderId: req.user.id });
      return row.id;
    });
    committed = true; // from here on the message exists — never delete its files

    try { // best-effort bookkeeping; must not turn a saved message into an error
      if (thread.type === 'dm') {
        const flag = req.user.role === 'admin' ? 'employee_unread' : 'admin_unread';
        await db.run(`UPDATE users SET ${flag} = 1 WHERE id = ?`, [thread.employee_id]);
      }
      if (req.user.role === 'employee') await logActivity(req.user.id, 'message_sent');
    } catch (bookkeepingErr) { console.error('[chat] bookkeeping failed:', bookkeepingErr.message); }

    const message = await chat.getMessage(messageId);
    const html = await chat.renderBubble(req.app, thread, message);
    const io = req.app.get('io');
    io.to(`thread-${thread.id}`).emit('message:new', { threadId: thread.id, id: messageId, html });
    notifyOthers(io, thread, req.user).catch((e) => console.error('[chat] notify failed:', e.message)); // pop-up for people who are not looking at this chat
    res.json({ id: messageId, html });
  } catch (err) {
    if (uploaded.length && !committed) await storage.deleteKeys(uploaded.map((u) => u.key)); // don't leave orphans behind
    next(err);
  }
});

router.post('/:threadId/delete', async (req, res, next) => {
  try {
    const { thread } = req.ctx;
    const ids = chat.parseIds(req.body.ids);
    const mode = req.body.mode === 'everyone' ? 'everyone' : 'me';
    if (!ids.length) throw new UserError('No messages selected.');

    if (mode === 'me') {
      // only hides them for this person; everybody else keeps them
      await db.run(
        `INSERT INTO hidden_items (user_id, kind, item_id)
         SELECT ?::int, 'message', m.id FROM messages m WHERE m.thread_id = ? AND m.id = ANY(?)
         ON CONFLICT DO NOTHING`,
        [req.user.id, thread.id, ids]
      );
      return res.json({ mode, ids });
    }

    // delete for everyone: the sender (or the admin) blanks the message; attachments are removed from storage
    const params = [thread.id, ids];
    let ownerClause = '';
    if (!req.ctx.isAdmin) { ownerClause = ' AND sender_id = ?'; params.push(req.user.id); }
    let keys = [];
    const done = await db.tx(async (t) => {
      const rows = await t.all(
        `UPDATE messages SET body = '', deleted_at = NOW() WHERE thread_id = ? AND id = ANY(?) AND deleted_at IS NULL${ownerClause} RETURNING id`,
        params
      );
      const okIds = rows.map((r) => r.id);
      keys = await files.detachFiles(t, 'message', okIds);
      return okIds;
    });
    await storage.deleteKeys(keys);
    if (done.length) req.app.get('io').to(`thread-${thread.id}`).emit('message:deleted', { threadId: thread.id, ids: done });
    res.json({ mode, ids: done, skipped: ids.length - done.length });
  } catch (err) { next(err); }
});

router.get('/:threadId/download', async (req, res, next) => {
  try {
    const ids = chat.parseIds(req.query.ids);
    if (!ids.length) throw new UserError('No messages selected.');
    const rows = await db.all(
      `SELECT f.* FROM files f JOIN messages m ON m.id = f.ref_id
       WHERE f.ref_type = 'message' AND m.thread_id = ? AND m.id = ANY(?) AND m.deleted_at IS NULL AND f.key IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM hidden_items h WHERE h.user_id = ? AND h.kind = 'message' AND h.item_id = m.id)
       ORDER BY m.id, f.id`,
      [req.ctx.thread.id, ids, req.user.id]
    );
    if (!rows.length) throw new UserError('The selected messages have no attachments to download.', 404);
    if (rows.length === 1) return res.redirect(`/files/${rows[0].id}?dl=1`);
    await sendZip(res, rows, `chat-attachments-${req.ctx.thread.id}.zip`);
  } catch (err) { next(err); }
});

module.exports = router;
