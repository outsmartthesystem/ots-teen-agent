// ─── SESSION / REPORT STORE ─────────────────────────────────────────────────
// Durable server-side session state. The teen link carries a one-time INVITE
// token (not the session id); on first open the server atomically claims the
// invite and issues an HttpOnly cookie carrying the OPAQUE session id — which
// never appears in any link — so the link can never be reused to view a result
// and is not a bearer credential (go-live hardening, TRUST-0/1). Backed by
// Postgres when DATABASE_URL is set; an in-memory Map otherwise (dev/test only).
//
// Row shape (see init() for the authoritative column list):
//   identity/PII: id, teen_first_name, teen_age, parent_first_name, parent_email
//   invite:       invite_token_hash, invite_used_at
//   lifecycle:    created_at, expires_at, completed_at, interview_complete
//   sharing:      sharing_status (pending|sent|declined), sharing_decided_at, report_sent
//   safety:       safety_blocked, safety_flag
//   age:          teen_age_confirmed_at
//   decision lab: decision_lab_status (pending|completed|skipped)
//   scoring:      refine_count
//   JSONB:        report_draft, turns, result

const USE_PG = !!process.env.DATABASE_URL;
let pool = null;
const mem = new Map();
const memPayments = new Set(); // consumed Stripe checkout session ids (memory backend)

if (USE_PG) {
  const { Pool } = require('pg');
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
      turns              JSONB,
      result             JSONB
    )`);
  // Additive migrations (safe on existing tables).
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS turns JSONB`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS result JSONB`);
  // Go-live hardening columns.
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS invite_token_hash TEXT`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS invite_used_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sharing_status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS sharing_decided_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS teen_age_confirmed_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS decision_lab_status TEXT NOT NULL DEFAULT 'pending'`);
  await pool.query(`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS refine_count INTEGER NOT NULL DEFAULT 0`);
  // Look up sessions by invite token hash during the one-time claim.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_sessions_invite ON sessions (invite_token_hash)`);
  // Consumed Stripe checkout sessions — one purchase = one teen setup.
  await pool.query(`CREATE TABLE IF NOT EXISTS payments (stripe_session_id TEXT PRIMARY KEY, consumed_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  initialized = true;
}
function ready() { return initialized; }

// Defaults applied to a fresh in-memory row so the memory backend mirrors PG.
function memRow(s) {
  return {
    id: s.id, teen_first_name: s.teen_first_name, teen_age: s.teen_age,
    parent_first_name: s.parent_first_name, parent_email: s.parent_email,
    invite_token_hash: s.invite_token_hash || null, invite_used_at: null,
    created_at: new Date(), expires_at: new Date(s.expires_at),
    safety_blocked: false, safety_flag: null, interview_complete: false,
    report_sent: false, sharing_status: 'pending', sharing_decided_at: null,
    completed_at: null, teen_age_confirmed_at: null, decision_lab_status: 'pending',
    refine_count: 0, report_draft: null, turns: null, result: null
  };
}

async function createSession(s) {
  if (pool) {
    await pool.query(
      `INSERT INTO sessions (id, teen_first_name, teen_age, parent_first_name, parent_email, expires_at, invite_token_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [s.id, s.teen_first_name, s.teen_age, s.parent_first_name, s.parent_email, new Date(s.expires_at), s.invite_token_hash || null]
    );
  } else {
    mem.set(s.id, memRow(s));
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

// One-time invite claim (TRUST-0/1). Given EITHER an invite token hash (new
// links) OR a legacy session id (links minted before this change), atomically
// mark the invite used and return the session row — but only if it wasn't used
// before and hasn't expired. Concurrent/repeat opens get null. The caller then
// sets the cookie to the returned row's id (which the link never contained for
// new-style links).
async function claimInvite({ tokenHash, sessionId }) {
  if (pool) {
    let r;
    if (tokenHash) {
      r = await pool.query(
        `UPDATE sessions SET invite_used_at = now()
         WHERE invite_token_hash = $1 AND invite_used_at IS NULL AND expires_at > now()
         RETURNING *`, [tokenHash]);
    } else if (sessionId) {
      r = await pool.query(
        `UPDATE sessions SET invite_used_at = now()
         WHERE id = $1 AND invite_used_at IS NULL AND expires_at > now()
         RETURNING *`, [sessionId]);
    } else { return null; }
    return r.rows[0] || null;
  }
  // memory backend
  let row = null;
  if (tokenHash) { for (const v of mem.values()) { if (v.invite_token_hash === tokenHash) { row = v; break; } } }
  else if (sessionId) { row = mem.get(sessionId); }
  if (!row) return null;
  if (row.invite_used_at) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  row.invite_used_at = new Date();
  return row;
}

const ALLOWED_UPDATES = new Set([
  'safety_blocked', 'safety_flag', 'interview_complete', 'report_sent', 'report_draft',
  'turns', 'result', 'sharing_status', 'sharing_decided_at', 'completed_at',
  'teen_age', 'teen_age_confirmed_at', 'decision_lab_status'
]);
const JSONB_FIELDS = new Set(['report_draft', 'turns', 'result']);
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

// Atomically claim the one-and-only send. Returns true to exactly one caller;
// concurrent/repeat callers, a safety-blocked session, or a non-pending sharing
// state (declined/already sent) all get false. Marks the report sent.
async function claimReportSend(id) {
  if (!id) return false;
  if (pool) {
    const r = await pool.query(
      `UPDATE sessions SET report_sent = true, sharing_status = 'sent', sharing_decided_at = now()
       WHERE id = $1 AND report_sent = false AND safety_blocked = false AND sharing_status = 'pending'
       RETURNING id`, [id]);
    return r.rowCount === 1;
  }
  const row = mem.get(id);
  if (row && !row.report_sent && !row.safety_blocked && row.sharing_status === 'pending') {
    row.report_sent = true; row.sharing_status = 'sent'; row.sharing_decided_at = new Date();
    return true;
  }
  return false;
}

// Atomically claim one refinement, capped at `max`. Returns the new refine_count
// on success, or null if the cap is already reached (idempotency/cost guard).
async function claimRefine(id, max) {
  if (!id) return null;
  if (pool) {
    const r = await pool.query(
      `UPDATE sessions SET refine_count = refine_count + 1
       WHERE id = $1 AND refine_count < $2 RETURNING refine_count`, [id, max]);
    return r.rowCount === 1 ? r.rows[0].refine_count : null;
  }
  const row = mem.get(id);
  if (row && (row.refine_count || 0) < max) { row.refine_count = (row.refine_count || 0) + 1; return row.refine_count; }
  return null;
}

// Hard-delete one session (privacy/delete + retention).
async function deleteSession(id) {
  if (!id) return;
  if (pool) { await pool.query('DELETE FROM sessions WHERE id = $1', [id]); }
  else { mem.delete(id); }
}

// Purge rows whose 30-day TTL has passed, PLUS finished-but-unshared results
// past the shorter unshared window. getSession already treats expired rows as
// gone; this reclaims storage and enforces retention. Called daily by the server.
async function deleteExpired(unsharedGraceDays) {
  const grace = Number.isFinite(unsharedGraceDays) ? unsharedGraceDays : 7;
  if (pool) {
    const r1 = await pool.query('DELETE FROM sessions WHERE expires_at < now()');
    // Completed but never sent AND never declined, older than the unshared window.
    const r2 = await pool.query(
      `DELETE FROM sessions
       WHERE completed_at IS NOT NULL AND completed_at < now() - ($1 || ' days')::interval
       AND sharing_status = 'pending'`, [String(grace)]);
    return (r1.rowCount || 0) + (r2.rowCount || 0);
  }
  let n = 0; const now = Date.now();
  const graceMs = grace * 24 * 60 * 60 * 1000;
  for (const [id, row] of mem) {
    const expired = new Date(row.expires_at).getTime() < now;
    const unshared = row.completed_at && (now - new Date(row.completed_at).getTime() > graceMs) && row.sharing_status === 'pending';
    if (expired || unshared) { mem.delete(id); n++; }
  }
  return n;
}

// Atomically claim a Stripe checkout session id as consumed. Returns true exactly
// once per session id (one purchase = one teen setup); false on reuse.
async function claimPaymentSession(sessionId) {
  if (!sessionId) return false;
  if (pool) {
    const r = await pool.query('INSERT INTO payments (stripe_session_id) VALUES ($1) ON CONFLICT (stripe_session_id) DO NOTHING RETURNING stripe_session_id', [sessionId]);
    return r.rowCount === 1;
  }
  if (memPayments.has(sessionId)) return false;
  memPayments.add(sessionId); return true;
}

function backend() { return pool ? 'postgres' : 'memory'; }

module.exports = {
  init, ready, createSession, getSession, claimInvite, updateSession,
  claimReportSend, claimRefine, deleteSession, deleteExpired, claimPaymentSession, backend
};
