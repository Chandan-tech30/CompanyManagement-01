// Files = bytes in object storage + a row in the `files` table.
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const storage = require('../utils/storage');
const { UserError } = require('../utils/errors');

// ---- name / path hygiene -----------------------------------------------------
// Browsers send file names as UTF-8 but multer decodes them as latin1.
function fixEncoding(name) {
  const decoded = Buffer.from(String(name || ''), 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? String(name) : decoded;
}
function cleanName(name) {
  const base = path.basename(fixEncoding(name).replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').trim();
  return (base || 'file').slice(0, 200);
}
// Folder uploads: "MyProject/src/app.js". Drop leading slashes, "." and ".." segments.
function cleanRelPath(rel) {
  if (!rel) return null;
  const parts = fixEncoding(rel).replace(/\\/g, '/').split('/')
    .map((p) => p.replace(/[\u0000-\u001f]/g, '').trim())
    .filter((p) => p && p !== '.' && p !== '..');
  if (parts.length < 2) return null; // a plain file, not part of a folder
  return parts.join('/').slice(0, 400);
}

// ---- upload -------------------------------------------------------------------
// Sends multer's in-memory files to the bucket. Returns metadata to insert into `files`.
// If any file fails, everything already sent is removed again (all or nothing).
async function uploadToStorage(uploads, prefix) {
  const sent = [];
  const d = new Date();
  const folder = `${prefix}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  try {
    for (let i = 0; i < uploads.length; i += 4) { // 4 at a time
      const batch = uploads.slice(i, i + 4);
      await Promise.all(batch.map(async ({ file, relPath }) => {
        const name = cleanName(file.originalname);
        const key = `${folder}/${crypto.randomUUID()}${path.extname(name).toLowerCase().slice(0, 12)}`;
        await storage.putObject(key, file.buffer, file.mimetype);
        sent.push({ key, name, rel_path: cleanRelPath(relPath), mime: file.mimetype || null, size: file.size || file.buffer.length });
      }));
    }
    return sent;
  } catch (err) {
    await storage.deleteKeys(sent.map((s) => s.key));
    console.error('[files] upload to storage failed:', err);
    throw new UserError(`Could not save your file(s) to storage (${err.name || 'error'}). Nothing was sent — please try again. If it keeps happening, tell the admin to check the storage settings.`, 502);
  }
}

// `q` is `db` or a transaction handle from db.tx(). Returns the inserted rows.
async function insertFileRows(q, uploaded, { refType, refId, uploaderId }) {
  const rows = [];
  for (const u of uploaded) {
    const r = await q.get(
      `INSERT INTO files (ref_type, ref_id, key, name, rel_path, mime, size, uploader_id) VALUES (?,?,?,?,?,?,?,?) RETURNING *`,
      [refType, refId, u.key, u.name, u.rel_path, u.mime, u.size, uploaderId || null]
    );
    rows.push(r);
  }
  return rows;
}

// Convenience: upload + insert in one go (for places that have no other DB work to do atomically).
async function saveUploads(uploads, { refType, refId, uploaderId, prefix }) {
  if (!uploads.length) return [];
  const uploaded = await uploadToStorage(uploads, prefix || refType);
  try {
    return await insertFileRows(db, uploaded, { refType, refId, uploaderId });
  } catch (err) {
    await storage.deleteKeys(uploaded.map((u) => u.key));
    throw err;
  }
}

// ---- reading -------------------------------------------------------------------
async function filesFor(refType, refIds) {
  const ids = [...new Set(refIds)].filter(Boolean);
  const byRef = new Map(ids.map((id) => [id, []]));
  if (!ids.length) return byRef;
  const rows = await db.all(
    `SELECT id, ref_id, name, rel_path, mime, size, created_at FROM files WHERE ref_type = ? AND ref_id = ANY(?) ORDER BY rel_path NULLS FIRST, id`,
    [refType, ids]
  );
  rows.forEach((f) => byRef.get(f.ref_id).push(f));
  return byRef;
}

// ---- deleting ------------------------------------------------------------------
// Removes rows and returns their object keys; call storage.deleteKeys(keys) AFTER your transaction commits.
async function detachFiles(q, refType, refIds) {
  const ids = [...new Set(refIds)].filter(Boolean);
  if (!ids.length) return [];
  const rows = await q.all(`DELETE FROM files WHERE ref_type = ? AND ref_id = ANY(?) RETURNING key`, [refType, ids]);
  return rows.map((r) => r.key).filter(Boolean);
}
async function purgeFiles(refType, refIds) {
  const keys = await detachFiles(db, refType, refIds);
  await storage.deleteKeys(keys);
}
// For avatars / logo stored as "/files/123" in another table.
async function purgeByUrl(url) {
  const m = /^\/files\/(\d+)$/.exec(url || '');
  if (!m) return;
  const rows = await db.all('DELETE FROM files WHERE id = ? RETURNING key', [Number(m[1])]);
  await storage.deleteKeys(rows.map((r) => r.key));
}

// ---- access control -------------------------------------------------------------
async function isTeamMember(teamId, userId) {
  return Boolean(await db.get('SELECT 1 AS ok FROM team_members WHERE team_id = ? AND user_id = ?', [teamId, userId]));
}

async function canSeeAnnouncement(userId, announcementId) {
  return Boolean(await db.get(
    `SELECT 1 AS ok FROM announcements a WHERE a.id = ? AND (a.audience = 'all' OR EXISTS (SELECT 1 FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.user_id = ?))`,
    [announcementId, userId]
  ));
}

// Who may open files that belong to (refType, refId)?
async function canAccessRef(user, refType, refId) {
  if (refType === 'public') return true;
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.status !== 'approved') return false;
  switch (refType) {
    case 'avatar': return true;
    case 'message': {
      const r = await db.get(`SELECT t.type, t.employee_id, t.team_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.id = ?`, [refId]);
      if (!r) return false;
      return r.type === 'dm' ? r.employee_id === user.id : isTeamMember(r.team_id, user.id);
    }
    case 'project': return Boolean(await db.get('SELECT 1 AS ok FROM personal_projects WHERE id = ? AND user_id = ?', [refId, user.id]));
    case 'task': return Boolean(await db.get('SELECT 1 AS ok FROM tasks WHERE id = ? AND employee_id = ?', [refId, user.id]));
    case 'team_submission': return Boolean(await db.get('SELECT 1 AS ok FROM team_submissions WHERE id = ? AND member_id = ?', [refId, user.id]));
    case 'announcement': return canSeeAnnouncement(user.id, refId);
    default: return false;
  }
}

module.exports = {
  cleanName, cleanRelPath, uploadToStorage, insertFileRows, saveUploads, filesFor,
  detachFiles, purgeFiles, purgeByUrl, isTeamMember, canSeeAnnouncement, canAccessRef,
};
