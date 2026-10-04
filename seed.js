// Usage: npm run seed — (re)creates the admin account from ADMIN_* env vars.
// Not needed on Render: the server creates the first admin automatically on boot.
require('dotenv').config({ quiet: true });
const db = require('./db');
const { ensureAdmin } = require('./db/bootstrap');

async function main() {
  await db.initDb();
  const res = await ensureAdmin({ force: true });
  console.log(res.created ? 'Created the admin account.' : 'Updated the existing admin account.');
  console.log('----------------------------------------');
  console.log(' Admin login credentials');
  console.log(' URL     : /login/admin');
  console.log(' Email   :', res.email);
  console.log(' Password:', res.password);
  console.log('----------------------------------------');
  await db.pool.end();
}
main().catch((err) => { console.error('Seed failed:', err); process.exit(1); });
