const db = require('../db');
const { filesFor } = require('./files');

async function withFiles(list) {
  const files = await filesFor('announcement', list.map((a) => a.id));
  list.forEach((a) => { a.files = files.get(a.id) || []; });
  return list;
}

// Announcements an employee may see: sent to everyone, or to them specifically.
async function visibleTo(userId) {
  const list = await db.all(
    `SELECT a.* FROM announcements a
     WHERE a.audience = 'all' OR EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.user_id = ?)
     ORDER BY a.created_at DESC`,
    [userId]
  );
  return withFiles(list);
}

async function listForAdmin() {
  const list = await db.all(
    `SELECT a.*, (SELECT COUNT(*)::int FROM announcement_recipients r WHERE r.announcement_id = a.id) AS recipient_count
     FROM announcements a ORDER BY a.created_at DESC`
  );
  return withFiles(list);
}

module.exports = { visibleTo, listForAdmin };
