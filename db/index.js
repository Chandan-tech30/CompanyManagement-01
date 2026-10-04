const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('\nDATABASE_URL is not set. Set it in .env (local) or in the Render dashboard (see .env.example).\n');
  process.exit(1);
}

// --- Connection ------------------------------------------------------------
// We strip `sslmode=` from the URL and decide SSL ourselves: node-pg lets the
// URL override the `ssl` option, and `sslmode=require` makes it verify the
// certificate chain, which fails on several managed providers.
const rawUrl = process.env.DATABASE_URL;
const urlSslMode = (rawUrl.match(/[?&]sslmode=([^&]+)/) || [])[1];
const connectionString = rawUrl.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, '');
const isLocalHost = /@(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(rawUrl);
const sslEnv = (process.env.DATABASE_SSL || '').toLowerCase();

let ssl = { rejectUnauthorized: false };
if (sslEnv === 'false' || sslEnv === 'off' || urlSslMode === 'disable' || (isLocalHost && !sslEnv)) ssl = false;
if (sslEnv === 'verify') ssl = { rejectUnauthorized: true };

const pool = new Pool({
  connectionString,
  ssl,
  max: Number(process.env.PG_POOL_MAX) || 8,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 20000, // serverless Postgres can take a few seconds to wake up
  keepAlive: true,
});
// Managed Postgres closes idle connections now and then; that must not crash the process.
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

// --- Query helpers ---------------------------------------------------------
// SQL in this project is written with `?` placeholders; they are converted to $1, $2, ...
// (Never use a literal `?` in SQL, e.g. jsonb operators.)
function toPgParams(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function makeQueryApi(exec) {
  return {
    async get(sql, params = []) { return (await exec(toPgParams(sql), params)).rows[0]; },
    async all(sql, params = []) { return (await exec(toPgParams(sql), params)).rows; },
    // lastInsertRowid is only set when the statement has `RETURNING id`.
    async run(sql, params = []) {
      const res = await exec(toPgParams(sql), params);
      return { lastInsertRowid: res.rows[0]?.id ?? null, changes: res.rowCount };
    },
    async exec(sql) { await exec(sql, undefined); },
  };
}

const db = makeQueryApi((sql, params) => pool.query(sql, params));

// Run several statements atomically:  await db.tx(async (t) => { await t.run(...); ... })
db.tx = async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(makeQueryApi((sql, params) => client.query(sql, params)));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
};

// --- Migrations ------------------------------------------------------------
// db/migrations/*.sql are applied once, in filename order, each in its own transaction.
async function migrate() {
  const client = await pool.connect();
  const LOCK = 872341;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]); // two instances booting together won't race
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const dir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      console.log(`[db] applying migration ${file}`);
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${file} failed and was rolled back: ${err.message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => {});
    client.release();
  }
}

async function initDb() {
  await migrate();
  const companyRow = await db.get('SELECT id FROM company WHERE id = 1');
  if (!companyRow) {
    await db.run(
      `INSERT INTO company (id, name, logo_path, ethics, agenda) VALUES (1, ?, ?, ?, ?)`,
      ['StartOver', '/images/startover-logo.svg',
       "Add StartOver's values and code of ethics here from the admin Home tab.",
       "Add StartOver's mission and agenda here from the admin Home tab."]
    );
  }
}

db.migrate = migrate;
db.initDb = initDb;
db.pool = pool;
module.exports = db;
