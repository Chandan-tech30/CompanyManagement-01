// Serving files. The bucket is private: after checking who is asking, we redirect to a
// short-lived signed URL, so big downloads/videos stream from the bucket, not through this server.
const path = require('path');
const express = require('express');
const archiver = require('archiver');
const db = require('../db');
const storage = require('../utils/storage');
const { requireLogin } = require('../middleware/auth');
const { canAccessRef } = require('../services/files');
const { UserError } = require('../utils/errors');

const router = express.Router();
const ZIPPABLE = ['project', 'task', 'team_submission', 'announcement'];

// Only these are shown inside the browser; everything else is forced to download.
const INLINE_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.m4v': 'video/mp4', '.ogv': 'video/ogg', '.pdf': 'application/pdf',
};

// Zip of every file in one place (a project, a task submission, ...). Folder structure is kept.
router.get('/zip/:refType/:refId', requireLogin, async (req, res, next) => {
  try {
    const refType = req.params.refType;
    const refId = Number(req.params.refId);
    if (!ZIPPABLE.includes(refType) || !Number.isInteger(refId)) throw new UserError('Nothing to download here.', 404);
    if (!(await canAccessRef(req.user, refType, refId))) throw new UserError('You do not have access to these files.', 403);
    const files = await db.all(`SELECT * FROM files WHERE ref_type = ? AND ref_id = ? AND key IS NOT NULL ORDER BY rel_path NULLS FIRST, id`, [refType, refId]);
    if (!files.length) throw new UserError('There are no files to download.', 404);
    await sendZip(res, files, `${refType}-${refId}.zip`);
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) throw new UserError('File not found.', 404);
    const file = await db.get('SELECT * FROM files WHERE id = ?', [id]);
    if (!file) throw new UserError('This file no longer exists.', 404);

    if (file.ref_type !== 'public') {
      if (!req.user) return res.redirect('/');
      if (!(await canAccessRef(req.user, file.ref_type, file.ref_id))) throw new UserError('You do not have access to this file.', 403);
    }
    if (!file.key) { // uploaded before object storage was introduced
      if (file.legacy_url && /^https?:\/\//.test(file.legacy_url)) return res.redirect(file.legacy_url);
      throw new UserError('This older file is no longer available (it was stored on a disk that has been wiped). Please ask the sender to upload it again.', 410);
    }

    const ext = path.extname(file.name).toLowerCase();
    const inlineType = INLINE_TYPES[ext];
    const wantsDownload = req.query.dl === '1';
    const url = await storage.signedUrl(file.key, {
      name: file.name,
      inline: Boolean(inlineType) && !wantsDownload,
      contentType: inlineType || 'application/octet-stream',
      expiresIn: 300,
    });
    res.set('Cache-Control', 'private, max-age=120');
    res.redirect(302, url);
  } catch (err) { next(err); }
});

// Streams a zip built from bucket objects. Used by the routes above and by chat "download selected".
async function sendZip(res, files, zipName) {
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${zipName}"`, 'Cache-Control': 'no-store' });
  const archive = archiver('zip', { zlib: { level: 6 } });
  const used = new Set();
  archive.on('error', (err) => { console.error('[zip] failed:', err); res.destroy(err); });
  res.on('close', () => archive.abort());
  archive.pipe(res);

  for (const f of files) {
    if (!f.key) continue;
    let name = (f.rel_path || f.name).replace(/^\/+/, '');
    if (used.has(name)) { // avoid two files with the same path overwriting each other
      const ext = path.extname(name);
      let n = 2;
      while (used.has(`${name.slice(0, name.length - ext.length)} (${n})${ext}`)) n++;
      name = `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
    }
    used.add(name);
    try {
      archive.append(await storage.getObjectStream(f.key), { name });
    } catch (err) {
      console.error(`[zip] could not read ${f.key}:`, err.message);
      archive.append(`This file could not be read from storage: ${name}\n`, { name: `${name}.MISSING.txt` });
    }
  }
  await archive.finalize();
}

router.sendZip = sendZip;
module.exports = router;
