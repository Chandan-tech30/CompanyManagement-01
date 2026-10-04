// Usage: npm run migrate   — applies any pending SQL files from db/migrations.
require('dotenv').config({ quiet: true });
const db = require('./index');

db.initDb()
  .then(() => { console.log('[db] schema is up to date.'); return db.pool.end(); })
  .catch((err) => { console.error(err.message); process.exit(1); });
