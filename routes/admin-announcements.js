// Admin: create / delete announcements (topic, description, photos & videos, optional link,
// all employees or only selected ones). Employees see them live via Socket.IO.
const express = require('express');
const db = require('../db');
const storage = require('../utils/storage');
const { uploadMedia, collectUploads } = require('../utils/upload');
const { UserError } = require('../utils/errors');
const files = require('../services/files');
const { parseIds } = require('../services/chat');
const announcements = require('../services/announcements');

const router = express.Router();

async function sendList(res) {
  res.render('admin/partials/announcement-list', { announcements: await announcements.listForAdmin(), isAdmin: true });
}

function cleanLink(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`); }
  catch { throw new UserError('That link does not look like a valid web address.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new UserError('Only http:// or https:// links are allowed.');
  return url.href.slice(0, 1000);
}

router.post('/', uploadMedia, async (req, res, next) => {
  try {
    const topic = String((req.body && req.body.topic) || '').trim().slice(0, 200);
    if (!topic) throw new UserError('Add a topic for the announcement.');
    const description = String(req.body.description || '').trim().slice(0, 5000);
    const link = cleanLink(req.body.link_url);
    const audience = req.body.audience === 'selected' ? 'selected' : 'all';
    const recipientIds = audience === 'selected' ? parseIds(req.body.recipients) : [];
    if (audience === 'selected' && !recipientIds.length) throw new UserError('Choose at least one employee, or send it to everyone.');

    const uploaded = await files.uploadToStorage(collectUploads(req), 'announcements');
    let id;
    try {
      id = await db.tx(async (t) => {
        const row = await t.get(
          `INSERT INTO announcements (topic, description, link_url, audience, created_by) VALUES (?,?,?,?,?) RETURNING id`,
          [topic, description, link, audience, req.user.id]
        );
        if (audience === 'selected') {
          await t.run(
            `INSERT INTO announcement_recipients (announcement_id, user_id)
             SELECT ?::int, u.id FROM users u WHERE u.role = 'employee' AND u.status = 'approved' AND u.id = ANY(?)`,
            [row.id, recipientIds]
          );
        }
        await files.insertFileRows(t, uploaded, { refType: 'announcement', refId: row.id, uploaderId: req.user.id });
        return row.id;
      });
    } catch (err) { await storage.deleteKeys(uploaded.map((u) => u.key)); throw err; }

    const io = req.app.get('io');
    const payload = { id, topic };
    if (audience === 'all') io.to('employees').emit('announcement:new', payload);
    else recipientIds.forEach((uid) => io.to(`user-${uid}`).emit('announcement:new', payload));
    await sendList(res);
  } catch (err) { next(err); }
});

// Deleting removes it for every employee, immediately (open pages update through Socket.IO).
router.post('/:id/delete', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const a = await db.get('SELECT * FROM announcements WHERE id = ?', [id]);
    if (a) {
      const recipients = (await db.all('SELECT user_id FROM announcement_recipients WHERE announcement_id = ?', [id])).map((r) => r.user_id);
      await files.purgeFiles('announcement', [id]);
      await db.run('DELETE FROM announcements WHERE id = ?', [id]);
      const io = req.app.get('io');
      if (a.audience === 'all') io.to('employees').emit('announcement:deleted', { id });
      else recipients.forEach((uid) => io.to(`user-${uid}`).emit('announcement:deleted', { id }));
    }
    await sendList(res);
  } catch (err) { next(err); }
});

module.exports = router;
