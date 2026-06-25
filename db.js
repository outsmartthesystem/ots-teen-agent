// ─── SESSION / REPORT STORE ─────────────────────────────────────────────────
// Durable server-side session state — the opaque session id maps to a row here,
// so the teen link no longer carries decodable PII (audit P0 #1). Backed by
// Postgres when DATABASE_URL is set; an in-memory Map otherwise (dev/test only —
// NOT durable across restarts, and the health endpoint reports which is active).
//
// Row shape:
//   id, teen_first_name, teen_age, parent_first_name, parent_email,
//   created_at, expires_at, safety_blocked, safety_flag,
//   interview_complete, report_sent, report_draft (JSONB)

const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
const mem = new Map();

if (USE_PG) {
  const { Pool } = require('pg');
  // Render's internal/managed Postgres requires SSL; localhost does not.
  const ssl = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false };
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });
}

let initialized = false;
async function init() {
  if (!pool) { initialized = true; return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id                 TEXT PRIMARY KEY,
      teen_first_name    TEXT NOT NULL,
      teen_age           INTEGER NOT NULL,
      parent_first_name  TEXT NOT NULL,
      parent_email       TEXT NOT NULL,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at         TIMESTAMPTZ NOT NULL,
      safety_blocked     BOOLEAN NOT NULL DEFAULT false,
      safety_flag        TEXT,
      interview_complete BOOLEAN NOT NULL DEFAULT false,
      report_sent        BOOLEAN NOT NULL DEFAULT false,
      report_draft       JSONB,
      turns              JSONB
    )`);
  // Phase 4: server-held interview/skills transcript. Migration for existing tables.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turns JSONB`);
  initialized = true;
}
// Fail-closed readiness: a configured-but-uninitialized Postgres is NOT ready.
function ready() { return initialized; }

async function createSession(s) {
  if (pool) {
    await pool.query(
      `INSERT INTO sessions (id, teen_first_name, teen_age, parent_first_name, parent_email, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [s.id, s.teen_first_name, s.teen_age, s.parent_first_name, s.parent_email, new Date(s.expires_at)]
    );
  } else {
    mem.set(s.id, {
      id: s.id, teen_first_name: s.teen_first_name, teen_age: s.teen_age,
      parent_first_name: s.parent_first_name, parent_email: s.parent_email,
      created_at: new Date(), expires_at: new Date(s.expires_at),
      safety_blocked: false, safety_flag: null, interview_complete: false,
      report_sent: false, report_draft: null, turns: null
    });
  }
}

// Returns the session row, or null if missing/expired.
async function getSession(id) {
  if (!id) return null;
  let row;
  if (pool) {
    const r = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    row = r.rows[0];
  } else {
    row = mem.get(id);
  }
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  return row;
}

const ALLOWED_UPDATES = new Set(['safety_blocked', 'safety_flag', 'interview_complete', 'report_sent', 'report_draft', 'turns']);
const JSONB_FIELDS = new Set(['report_draft', 'turns']);
async function updateSession(id, fields) {
  const keys = Object.keys(fields).filter(k => ALLOWED_UPDATES.has(k));
  if (!keys.length) return;
  if (pool) {
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const vals = keys.map(k => (JSONB_FIELDS.has(k) && fields[k] != null) ? JSON.stringify(fields[k]) : fields[k]);
    await pool.query(`UPDATE sessions SET ${sets} WHERE id = $1`, [id, ...vals]);
  } else {
    const row = mem.get(id);
    if (row) keys.forEach(k => { row[k] = fields[k]; });
  }
}

// Atomically claim the one-and-only send for a session. Returns true to exactly
// one caller; concurrent or repeat callers, or a safety-blocked session, get
// false. Replaces the check-then-set race in /api/parent-report (audit P2).
async function claimReportSend(id) {
  if (!id) return false;
  if (pool) {
    const r = await pool.query(
      `UPDATE sessions SET report_sent = true
       WHERE id = $1 AND report_sent = false AND safety_blocked = false
       RETURNING id`, [id]);
    return r.rowCount === 1;
  }
  const row = mem.get(id);
  if (row && !row.report_sent && !row.safety_blocked) { row.report_sent = true; return true; }
  return false;
}

function backend() { return pool ? 'postgres' : 'memory'; }

module.exports = { init, ready, createSession, getSession, updateSession, claimReportSend, backend };
