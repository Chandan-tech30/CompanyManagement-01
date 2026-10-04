const db = require('../db');

async function projectsFor(userId) {
  return db.all(
    `SELECT p.*,
       (SELECT COUNT(*)::int FROM files f WHERE f.ref_type = 'project' AND f.ref_id = p.id) AS file_count,
       (SELECT COALESCE(SUM(f.size), 0)::float8 FROM files f WHERE f.ref_type = 'project' AND f.ref_id = p.id) AS total_size
     FROM personal_projects p WHERE p.user_id = ? ORDER BY p.created_at DESC`,
    [userId]
  );
}

module.exports = { projectsFor };
