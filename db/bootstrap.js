const bcrypt = require('bcryptjs');
const db = require('./index');

// Creates the admin account from ADMIN_* env vars.
//   force=false (server start): only if there is no admin yet — never overwrites anything.
//   force=true  (npm run seed): also resets the existing admin's e-mail/password.
async function ensureAdmin({ force = false } = {}) {
  const email = (process.env.ADMIN_EMAIL || 'admin@company.local').toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD || 'Admin@12345';
  const name = process.env.ADMIN_NAME || 'Company Admin';
  const existing = await db.get(`SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1`);

  if (existing && !force) return { created: false, email };
  const hash = bcrypt.hashSync(password, 10);
  if (existing) {
    await db.run(`UPDATE users SET full_name=?, email=?, password_hash=?, status='approved' WHERE id=?`, [name, email, hash, existing.id]);
    return { created: false, updated: true, email, password };
  }
  await db.run(
    `INSERT INTO users (full_name, email, password_hash, phone, role, status, job_role) VALUES (?, ?, ?, '', 'admin', 'approved', 'Administrator')`,
    [name, email, hash]
  );
  return { created: true, email, password };
}

module.exports = { ensureAdmin };
