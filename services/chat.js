// Chat threads: one direct thread per employee (admin ↔ employee) and one thread per team.
const db = require('../db');
const { filesFor } = require('./files');

const PAGE_SIZE = 40;

async function getDmThread(employeeId) {
  await db.run(`INSERT INTO threads (type, employee_id) VALUES ('dm', ?) ON CONFLICT DO NOTHING`, [employeeId]);
  return db.get(`SELECT * FROM threads WHERE type = 'dm' AND employee_id = ?`, [employeeId]);
}

async function getTeamThread(teamId) {
  await db.run(`INSERT INTO threads (type, team_id) VALUES ('team', ?) ON CONFLICT DO NOTHING`, [teamId]);
  return db.get(`SELECT * FROM threads WHERE type = 'team' AND team_id = ?`, [teamId]);
}

// Can this user open the thread, and may they write in it?
async function getThreadContext(user, threadId) {
  if (!user || !Number.isInteger(threadId)) return null;
  const thread = await db.get('SELECT * FROM threads WHERE id = ?', [threadId]);
  if (!thread) return null;
  const isAdmin = user.role === 'admin';
  if (isAdmin) return { thread, isAdmin, canPost: true, readOnlyNote: '' };
  if (user.status !== 'approved') return null;

  if (thread.type === 'dm') {
    return thread.employee_id === user.id ? { thread, isAdmin, canPost: true, readOnlyNote: '' } : null;
  }
  const m = await db.get(
    `SELECT tm.can_post, t.chat_mode FROM team_members tm JOIN teams t ON t.id = tm.team_id WHERE tm.team_id = ? AND tm.user_id = ?`,
    [thread.team_id, user.id]
  );
  if (!m) return null;
  const canPost = m.chat_mode === 'all' || (m.chat_mode === 'selected' && m.can_post);
  let readOnlyNote = '';
  if (!canPost) readOnlyNote = m.chat_mode === 'admin_only' ? 'Only the admin can write in this team chat. You can still submit files to the admin from the assignments.' : 'The admin has not given you permission to write in this team chat. You can still submit files from the assignments.';
  return { thread, isAdmin, canPost, readOnlyNote };
}

// Messages are addressed to "who sent it" as a key; the browser compares it with its own key to
// decide left/right. DM: by role (admin / employee). Team: by user id.
const senderKey = (thread, message) => (thread.type === 'dm' ? `r:${message.sender_role}` : `u:${message.sender_id}`);
const viewerKey = (thread, user) => (thread.type === 'dm' ? `r:${user.role}` : `u:${user.id}`);

async function attachFiles(messages) {
  const map = await filesFor('message', messages.map((m) => m.id));
  messages.forEach((m) => { m.files = m.deleted_at ? [] : (map.get(m.id) || []); });
  return messages;
}

// Newest page by default; pass `before` (a message id) to page further back.
async function listMessages(threadId, viewerId, { before, limit = PAGE_SIZE } = {}) {
  const params = [threadId, viewerId];
  let sql = `SELECT m.*, u.full_name AS sender_name
             FROM messages m LEFT JOIN users u ON u.id = m.sender_id
             WHERE m.thread_id = ?
               AND NOT EXISTS (SELECT 1 FROM hidden_items h WHERE h.user_id = ? AND h.kind = 'message' AND h.item_id = m.id)`;
  if (before) { sql += ' AND m.id < ?'; params.push(before); }
  sql += ' ORDER BY m.id DESC LIMIT ?';
  params.push(limit + 1);
  const rows = await db.all(sql, params);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  rows.reverse();
  await attachFiles(rows);
  return { messages: rows, hasMore };
}

async function getMessage(id) {
  const m = await db.get(`SELECT m.*, u.full_name AS sender_name FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`, [id]);
  if (!m) return null;
  await attachFiles([m]);
  return m;
}

// Locals for views/partials/chat-panel.ejs
async function chatLocals(user, ctx) {
  const { messages, hasMore } = await listMessages(ctx.thread.id, user.id);
  const thread = ctx.thread;
  return {
    chat: {
      threadId: thread.id, kind: thread.type, myKey: viewerKey(thread, user), isAdmin: ctx.isAdmin,
      canPost: ctx.canPost, readOnlyNote: ctx.readOnlyNote, messages, hasMore,
      keyOf: (m) => senderKey(thread, m),
    },
  };
}

function render(app, view, locals) {
  return new Promise((resolve, reject) => app.render(view, locals, (err, html) => (err ? reject(err) : resolve(html))));
}
const renderBubble = (app, thread, message) => render(app, 'partials/chat-bubble', { message, senderKey: senderKey(thread, message) });

function parseIds(value) {
  const arr = Array.isArray(value) ? value : (value == null ? [] : String(value).split(','));
  return [...new Set(arr.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
}

module.exports = {
  PAGE_SIZE, getDmThread, getTeamThread, getThreadContext, listMessages, getMessage,
  chatLocals, renderBubble, senderKey, viewerKey, parseIds, render,
};
