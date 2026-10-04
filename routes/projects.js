// Personal projects — used by BOTH portals. A project has Name / Concept / Details, a colour, and a
// file store (files or whole folders) kept in object storage. Owners manage; the admin can open
// (read-only) any employee's project from the Projects tab.
const express = require('express');
const path = require('path');
const db = require('../db');
const { requireLogin } = require('../middleware/auth');
const { uploadWork, collectUploads } = require('../utils/upload');
const { UserError } = require('../utils/errors');
const { logActivity } = require('../utils/helpers');
const storage = require('../utils/storage');
const files = require('../services/files');
const { parseIds } = require('../services/chat');
const { projectsFor } = require('../services/projects');

const router = express.Router();
router.use(requireLogin);

const COLORS = ['#6d5ef5', '#16c9b7', '#2fd992', '#f5a742', '#f0555f', '#e07be0'];

const gridLocals = async (userId) => ({ projects: await projectsFor(userId), editable: true });

// The project if the current user owns it (or is an admin, read-only).
async function loadProject(req, { ownerOnly = false } = {}) {
  const project = await db.get('SELECT * FROM personal_projects WHERE id = ?', [Number(req.params.id)]);
  if (!project) throw new UserError('That project no longer exists.', 404);
  const isOwner = project.user_id === req.user.id;
  if (!isOwner && (ownerOnly || req.user.role !== 'admin')) throw new UserError('You do not have access to this project.', 403);
  return { project, isOwner };
}

// Group files by folder for display: loose files first, then each folder path.
function groupFiles(rows) {
  const groups = new Map();
  rows.forEach((f) => {
    const folder = f.rel_path ? path.posix.dirname(f.rel_path) : '';
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(f);
  });
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folder, list]) => ({ folder, files: list }));
}

async function modalLocals(projectId, isOwner) {
  const project = await db.get('SELECT * FROM personal_projects WHERE id = ?', [projectId]);
  const rows = await db.all(`SELECT * FROM files WHERE ref_type = 'project' AND ref_id = ? ORDER BY rel_path NULLS FIRST, name, id`, [projectId]);
  return {
    project, editable: isOwner, groups: groupFiles(rows), fileCount: rows.length,
    totalSize: rows.reduce((s, f) => s + (f.size || 0), 0),
  };
}
async function sendModal(res, projectId, isOwner) {
  res.render('partials/project-modal', await modalLocals(projectId, isOwner));
}

router.get('/grid', async (req, res, next) => {
  try { res.render('partials/projects-grid', await gridLocals(req.user.id)); } catch (err) { next(err); }
});

// Create (multipart: name, concept, details, color, files[], paths[])
router.post('/', uploadWork, async (req, res, next) => {
  try {
    const { name, concept, details, color } = req.body || {};
    if (!name || !name.trim()) throw new UserError('Give the project a name.');
    const uploads = collectUploads(req);
    const uploaded = await files.uploadToStorage(uploads, 'projects');
    try {
      await db.tx(async (t) => {
        const row = await t.get(
          'INSERT INTO personal_projects (user_id, name, concept, details, color) VALUES (?,?,?,?,?) RETURNING id',
          [req.user.id, name.trim().slice(0, 150), (concept || '').slice(0, 300), (details || '').slice(0, 5000), COLORS.includes(color) ? color : COLORS[0]]
        );
        await files.insertFileRows(t, uploaded, { refType: 'project', refId: row.id, uploaderId: req.user.id });
      });
    } catch (err) { await storage.deleteKeys(uploaded.map((u) => u.key)); throw err; }
    if (req.user.role === 'employee') await logActivity(req.user.id, 'project_created');
    res.render('partials/projects-grid', await gridLocals(req.user.id));
  } catch (err) { next(err); }
});

// Bulk delete (from the "Select" mode): JSON { ids: [..] }
router.post('/delete', async (req, res, next) => {
  try {
    const ids = parseIds(req.body.ids);
    if (!ids.length) throw new UserError('No projects selected.');
    const mine = await db.all('SELECT id FROM personal_projects WHERE user_id = ? AND id = ANY(?)', [req.user.id, ids]);
    const mineIds = mine.map((p) => p.id);
    await files.purgeFiles('project', mineIds);
    await db.run('DELETE FROM personal_projects WHERE user_id = ? AND id = ANY(?)', [req.user.id, mineIds]);
    res.render('partials/projects-grid', await gridLocals(req.user.id));
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { project, isOwner } = await loadProject(req);
    res.render('partials/project-modal', await modalLocals(project.id, isOwner));
  } catch (err) { next(err); }
});

router.post('/:id/files', uploadWork, async (req, res, next) => {
  try {
    const { project } = await loadProject(req, { ownerOnly: true });
    const uploads = collectUploads(req);
    if (!uploads.length) throw new UserError('Choose at least one file or folder.');
    await files.saveUploads(uploads, { refType: 'project', refId: project.id, uploaderId: req.user.id, prefix: 'projects' });
    res.set('HX-Trigger', 'projects-changed');
    await sendModal(res, project.id, true);
  } catch (err) { next(err); }
});

router.post('/:id/files/delete', async (req, res, next) => {
  try {
    const { project } = await loadProject(req, { ownerOnly: true });
    const ids = parseIds(req.body.ids);
    if (!ids.length) throw new UserError('Tick the files you want to delete first.');
    const rows = await db.all(`DELETE FROM files WHERE ref_type = 'project' AND ref_id = ? AND id = ANY(?) RETURNING key`, [project.id, ids]);
    await storage.deleteKeys(rows.map((r) => r.key).filter(Boolean));
    res.set('HX-Trigger', 'projects-changed');
    await sendModal(res, project.id, true);
  } catch (err) { next(err); }
});

router.post('/:id/complete', async (req, res, next) => {
  try {
    const { project } = await loadProject(req, { ownerOnly: true });
    const row = await db.get(
      `UPDATE personal_projects SET completed_at = CASE WHEN completed_at IS NULL THEN NOW() ELSE NULL END WHERE id = ? RETURNING completed_at`,
      [project.id]
    );
    if (row && row.completed_at && req.user.role === 'employee') await logActivity(req.user.id, 'project_completed');
    res.set('HX-Trigger', 'projects-changed');
    await sendModal(res, project.id, true);
  } catch (err) { next(err); }
});

router.post('/:id/delete', async (req, res, next) => {
  try {
    const { project } = await loadProject(req, { ownerOnly: true });
    await files.purgeFiles('project', [project.id]);
    await db.run('DELETE FROM personal_projects WHERE id = ?', [project.id]);
    res.set('HX-Trigger', 'projects-changed');
    res.render('partials/projects-grid', await gridLocals(req.user.id));
  } catch (err) { next(err); }
});

module.exports = router;
