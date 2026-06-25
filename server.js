const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const db = require('./db');   // durable server-side session/report store

// Scoring prompts (B + D) run SERVER-side now, so the report draft is
// server-authored and can't be forged by the client. Loaded from the same
// generated prompts.js (single source of truth) at startup.
const SERVER_PROMPTS = (() => {
  try {
    const win = {};
    new Function('window', fs.readFileSync(path.join(__dirname, 'prompts.js'), 'utf8'))(win);
    return { A: win.PROMPT_A, B: win.PROMPT_B, C: win.PROMPT_C, D: win.PROMPT_D };
  } catch (e) { console.error('prompt load error:', e.message); return {}; }
})();

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
async function callAnthropic({ model, system, messages, max_tokens }) {
  let r, data;
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: Math.min(max_tokens || 4000, 8000), system, messages })
    });
    if ((r.status === 429 || r.status === 529) && attempt < 3) { await wait(attempt * 3000); continue; }
    break;
  }
  data = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status);
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// Server-side copies of the scoring JSON parse + validate (mirror the client).
function parseScoringJSON(text) {
  let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}
const CONFIDENCE_ENUM = new Set(['high', 'moderate', 'limited', 'insufficient']);
function validScore(s) { return s === null || (Number.isInteger(s) && s >= 1 && s <= 5); }
function validateScoring(p) {
  if (!p || typeof p !== 'object' || !p.safety_check) return false;
  if (p.safety_check.clear === false) return true;
  const t = p.teen_output;
  if (!t || !Array.isArray(t.bars) || !t.bars.length) return false;
  if (p.scoring && typeof p.scoring === 'object') {
    for (const k of Object.keys(p.scoring)) {
      const d = p.scoring[k] || {};
      if (!validScore(d.score)) return false;
      if (d.confidence && !CONFIDENCE_ENUM.has(d.confidence)) return false;
    }
  }
  for (const bar of t.bars) { if (!validScore(bar.score)) return false; }
  return true;
}

// ─── INTERVIEW ORCHESTRATION (Phase 4) ──────────────────────────────────────
// The interview/skills turns now run server-side: the server holds the prompts
// and the transcript, injects the per-turn anchor, detects sentinels, and feeds
// scoring from its OWN stored transcript — the client never supplies the prompt
// or the transcript, so neither can be tampered with.
const SEED_MARKER = '__SEED_BEGIN__';
const TOTAL_QUESTIONS = 16;
const COMPLETE_SENTINEL = '[INTERVIEW_COMPLETE]';
const SKILLS_SENTINEL = '[SKILLS_COMPLETE]';
const SAFETY_SENTINEL_RE = /\[SAFETY_EVENT:(CRISIS|ABUSE|SUPPORT)\]/;

function stripSentinels(s) {
  return String(s || '')
    .replace(/\[SAFETY_EVENT:[^\]]*\]/g, '')
    .split(COMPLETE_SENTINEL).join('')
    .split(SKILLS_SENTINEL).join('')
    .trim();
}

// Keeps Prompt A asking the next numbered question in order without leaking
// scoring intent (this used to be injected client-side; now server-side).
function interviewAnchor(qNum) {
  return `[Internal note: based on the conversation so far, ask the NEXT question from your list that hasn't been asked yet, in order — never skip ahead, never repeat one already asked (you're roughly on question ${qNum} of ${TOTAL_QUESTIONS}). One question only. Vary your acknowledgment — never repeat "Got it," and about half the time skip the acknowledgment and go straight to the question. Honor skips. Do not score, rate, or praise. Watch for safety.]`;
}
function interviewQuestionNum(turns) {
  const asked = (turns || []).filter(t => t.role === 'assistant').length;
  return Math.max(1, Math.min(asked, TOTAL_QUESTIONS));
}

// Format a stored turn array into the speaker-labelled transcript the scoring
// prompts expect (identical to the client's previous buildTranscript output).
function formatTranscript(turns, userLabel, asstLabel) {
  return (turns || [])
    .filter(t => t.content !== SEED_MARKER)
    .map(t => (t.role === 'user' ? userLabel : asstLabel) + ':\n' + t.content)
    .join('\n\n———\n\n');
}

const INTERVIEW_SUB = (s) => SERVER_PROMPTS.A
  .split('{{TEEN_FIRST_NAME}}').join(s.teen_first_name)
  .split('{{PARENT_FIRST_NAME}}').join(s.parent_first_name)
  .split('{{TEEN_AGE_PLUS_3}}').join(String(s.teen_age + 3))
  .split('{{TEEN_AGE}}').join(String(s.teen_age));
const SKILLS_SUB = (s) => SERVER_PROMPTS.C
  .split('{{TEEN_FIRST_NAME}}').join(s.teen_first_name)
  .split('{{TEEN_AGE}}').join(String(s.teen_age));

// ─── SESSION COOKIE ─────────────────────────────────────────────────────────
// The teen link carries an opaque session id (?s=…). On open it's exchanged for
// an HttpOnly cookie, and the id is stripped from the URL. The cookie — not a
// client-held token — authenticates /api/chat and /api/parent-report afterward.
const SESSION_COOKIE = 'ots_sid';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function setSessionCookie(req, res, id) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
}
function sessionIdFromCookie(req) {
  const raw = req.headers.cookie || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + SESSION_COOKIE + '=([^;]+)'));
  return m ? m[1] : null;
}
// Resolve the current session from the cookie; null if none/expired.
async function currentSession(req) {
  return db.getSession(sessionIdFromCookie(req));
}

// Direct mail transport for SAFETY alerts only (not the parent report, which
// goes via Make). Safety is critical enough that it shouldn't depend on a
// no-code tool's plan/uptime. Configured iff EMAIL_USER + EMAIL_PASS are set
// (a Gmail address + app password, same approach as ots-deep-work).
const safetyMailer = (process.env.EMAIL_USER && process.env.EMAIL_PASS)
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } })
  : null;

const app = express();
app.set('trust proxy', 1); // Render terminates TLS at a proxy; needed for real client IPs.
app.use(express.json({ limit: '256kb' })); // text-only payloads; 10mb was excessive

// Security headers on every response. The app loads only same-origin assets
// (jsPDF is vendored locally), so a tight CSP is safe. API responses are
// no-store so session/result JSON isn't cached on shared devices.
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// ─── STATIC FILE SECURITY ──────────────────────────────────────────────────
// express.static(__dirname) serves the whole repo, so explicitly block backend
// source, manifests, secrets, and git internals from public download.
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (
    p === '/server.js' ||
    p === '/package.json' ||
    p === '/package-lock.json' ||
    p === '/.env' ||
    p === '/.env.example' ||
    p === '/render.yaml' ||
    p.startsWith('/.git') ||
    p.startsWith('/node_modules')
  ) {
    return res.status(404).send('Not found');
  }
  next();
});

// ─── RATE LIMITING ─────────────────────────────────────────────────────────
// Per-IP limit on the API. An interview averages ~one message/minute, so this
// is generous for a real teen while stopping bots from burning the Anthropic
// key or spamming registrations/reports.
const rateBuckets = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const WINDOW_MS = 5 * 60 * 1000;
  const MAX_REQUESTS = 60;
  const hits = (rateBuckets.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= MAX_REQUESTS) {
    rateBuckets.set(ip, hits);
    return true;
  }
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (rateBuckets.size > 5000) {
    for (const [key, times] of rateBuckets) {
      if (!times.some(t => now - t < WINDOW_MS)) rateBuckets.delete(key);
    }
  }
  return false;
}

app.use('/api/', (req, res, next) => {
  // Never rate-limit the health check. Render probes /api/health every few
  // seconds; a 429 there fails the check and flaps the instance
  // (unhealthy → recover loop). Health is infrastructure, not user traffic.
  if ((req.originalUrl || '').split('?')[0] === '/api/health') return next();
  if (isRateLimited(req.ip)) {
    // Shaped like Anthropic's rate-limit error so client-side retry/backoff
    // handles it gracefully.
    return res.status(429).json({ error: { type: 'rate_limit_error', message: 'Too many requests. Please wait a moment.' } });
  }
  next();
});

// ============================================================================
// SESSION-TOKEN CONTRACT  (parent → teen handoff)
// ============================================================================
// The parent registers; the server mints a stateless, HMAC-signed token that
// encodes the registration. The teen opens /?t=<token>. No database required —
// the token IS the session.
//
// Signed payload (never trust any of this from the client once minted):
//   { v, sid, teen_first_name, teen_age, parent_first_name, parent_email, iat, exp }
//
// Token string:  base64url(JSON payload) + "." + base64url(HMAC-SHA256)
//
// SAFETY/PRIVACY PROPERTIES BAKED INTO THE CONTRACT:
//   1. The teen-facing read (/api/session) NEVER returns parent_email. The
//      report destination is server-side only — a teen can't see or change it.
//   2. The parent-report send (/api/parent-report) pulls parent_email from the
//      *verified token*, never from the request body. A teen cannot redirect
//      the report to a different address by tampering with the client.
//   3. teen_age is signed, so the age-banding in scoring can't be spoofed.
// ============================================================================

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days from registration

function signToken(payloadObj) {
  const secret = process.env.TOKEN_SIGNING_SECRET;
  const body = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  if (!process.env.TOKEN_SIGNING_SECRET) return null;
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', process.env.TOKEN_SIGNING_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload;
}

// Teen-facing session fields. parent_email is NEVER returned — it lives only in
// the server-side row and is read directly from there when the report sends.
function teenSafe(s) {
  return {
    teen_first_name: s.teen_first_name,
    teen_age: s.teen_age,
    teen_age_plus_3: s.teen_age + 3, // pre-computed: the model is unreliable at arithmetic
    parent_first_name: s.parent_first_name,
    interview_complete: !!s.interview_complete,
    report_sent: !!s.report_sent,
    safety_blocked: !!s.safety_blocked
  };
}

// ─── REGISTER (parent) ─────────────────────────────────────────────────────
// Creates an opaque server-side session and returns the teen's link (?s=<id>).
// The id is unguessable random; the PII lives in the row, not the link.
app.post('/api/register', async (req, res) => {
  const { teen_first_name, teen_age, parent_first_name, parent_email } = req.body || {};
  const tName = String(teen_first_name || '').trim();
  const pName = String(parent_first_name || '').trim();
  const pEmail = String(parent_email || '').trim();
  const age = Number(teen_age);

  if (tName.length < 1 || tName.length > 40) return res.status(400).json({ error: 'teen_first_name required (1–40 chars)' });
  if (pName.length < 1 || pName.length > 40) return res.status(400).json({ error: 'parent_first_name required (1–40 chars)' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail)) return res.status(400).json({ error: 'valid parent_email required' });
  if (!Number.isInteger(age) || age < 13 || age > 25) return res.status(400).json({ error: 'age must be an integer 13–25' });

  const id = crypto.randomBytes(24).toString('base64url');
  const expires_at = Date.now() + SESSION_TTL_SECONDS * 1000;
  try {
    await db.createSession({ id, teen_first_name: tName, teen_age: age, parent_first_name: pName, parent_email: pEmail, expires_at });
  } catch (e) {
    console.error('register/createSession error:', e.message);
    return res.status(500).json({ error: 'Could not create the session. Try again.' });
  }
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  res.json({ teen_url: `${base}/?s=${id}`, expires_at: Math.floor(expires_at / 1000) });
});

// ─── START (teen opens the link) ───────────────────────────────────────────
// Exchanges the opaque link id for an HttpOnly session cookie. The client then
// strips ?s= from the URL; all later calls authenticate by cookie.
app.post('/api/session/start', async (req, res) => {
  const s = await db.getSession(req.body && req.body.s);
  if (!s) return res.status(401).json({ error: 'invalid or expired link' });
  setSessionCookie(req, res, s.id);
  res.json(teenSafe(s));
});

// ─── SESSION (current, via cookie) ─────────────────────────────────────────
// Used on reload to re-establish state without the link in the URL.
app.get('/api/session', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  res.json(teenSafe(s));
});

// ─── INTERVIEW TURN (server-orchestrated, Phase 4) ──────────────────────────
// The browser sends only { answer }; the server holds Prompt A + the transcript,
// injects the per-turn anchor, calls the model, detects sentinels, and persists
// the CLEAN turn (never the anchor). First call (empty transcript) seeds the
// opening frame and ignores `answer`.
app.post('/api/interview/turn', async (req, res) => {
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'no active session' });
  if (session.safety_blocked) return res.status(403).json({ error: 'session closed' });
  if (session.interview_complete) return res.json({ complete: true, message: '' });
  if (!process.env.ANTHROPIC_API_KEY || !SERVER_PROMPTS.A) return res.status(500).json({ error: 'not configured' });

  const answer = (req.body && typeof req.body.answer === 'string') ? req.body.answer.trim().slice(0, 4000) : '';
  const store = session.turns || {};
  let turns = Array.isArray(store.interview) ? store.interview.slice() : [];
  if (turns.length === 0) {
    turns.push({ role: 'user', content: SEED_MARKER });
  } else {
    if (!answer) return res.status(400).json({ error: 'answer required' });
    turns.push({ role: 'user', content: answer });
  }
  // Inject the anchor into a COPY for the API; the stored turn stays clean.
  const apiMessages = turns.map(t => ({ role: t.role, content: t.content }));
  const last = apiMessages[apiMessages.length - 1];
  if (last.role === 'user' && last.content !== SEED_MARKER) {
    last.content = interviewAnchor(interviewQuestionNum(turns)) + '\n\n' + last.content;
  }
  try {
    const raw = await callAnthropic({ model: 'claude-sonnet-4-6', system: INTERVIEW_SUB(session), messages: apiMessages, max_tokens: 1200 });
    const safety = raw.match(SAFETY_SENTINEL_RE);
    const clean = stripSentinels(raw);
    if (safety) {
      const flag = safety[1].toUpperCase();
      if (SAFETY_BLOCK_FLAGS.has(flag)) {
        await db.updateSession(session.id, { safety_blocked: true, safety_flag: flag, turns: Object.assign({}, store, { interview: [] }) }); // purge
      }
      fireSafetyAlert(flag, { sid: session.id, teen_first_name: session.teen_first_name, teen_age: session.teen_age });
      return res.json({ safety: flag, message: clean });
    }
    const complete = raw.includes(COMPLETE_SENTINEL);
    turns.push({ role: 'assistant', content: clean });
    await db.updateSession(session.id, Object.assign({ turns: Object.assign({}, store, { interview: turns }) }, complete ? { interview_complete: true } : {}));
    res.json({ message: clean, complete });
  } catch (e) {
    console.error('interview turn error:', e.message);
    res.status(502).json({ error: 'interview error' });
  }
});

// ─── SKILLS TURN (server-orchestrated, Phase 4) ─────────────────────────────
app.post('/api/skills/turn', async (req, res) => {
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'no active session' });
  if (session.safety_blocked) return res.status(403).json({ error: 'session closed' });
  if (!process.env.ANTHROPIC_API_KEY || !SERVER_PROMPTS.C) return res.status(500).json({ error: 'not configured' });

  const answer = (req.body && typeof req.body.answer === 'string') ? req.body.answer.trim().slice(0, 4000) : '';
  const store = session.turns || {};
  let turns = Array.isArray(store.skills) ? store.skills.slice() : [];
  if (turns.length === 0) {
    turns.push({ role: 'user', content: SEED_MARKER });
  } else {
    if (!answer) return res.status(400).json({ error: 'answer required' });
    turns.push({ role: 'user', content: answer });
  }
  const apiMessages = turns.map(t => ({ role: t.role, content: t.content }));
  try {
    const raw = await callAnthropic({ model: 'claude-sonnet-4-6', system: SKILLS_SUB(session), messages: apiMessages, max_tokens: 1200 });
    const safety = raw.match(SAFETY_SENTINEL_RE);
    const clean = stripSentinels(raw);
    if (safety) {
      const flag = safety[1].toUpperCase();
      if (SAFETY_BLOCK_FLAGS.has(flag)) {
        await db.updateSession(session.id, { safety_blocked: true, safety_flag: flag, turns: Object.assign({}, store, { skills: [] }) });
      }
      fireSafetyAlert(flag, { sid: session.id, teen_first_name: session.teen_first_name, teen_age: session.teen_age });
      return res.json({ safety: flag, message: clean });
    }
    const complete = raw.includes(SKILLS_SENTINEL);
    turns.push({ role: 'assistant', content: clean });
    await db.updateSession(session.id, { turns: Object.assign({}, store, { skills: turns }) });
    res.json({ message: clean, complete });
  } catch (e) {
    console.error('skills turn error:', e.message);
    res.status(502).json({ error: 'skills error' });
  }
});

// ─── INTERVIEW STATE (resume on reload) ─────────────────────────────────────
// Server is the single source of truth for the transcript now, so a reload
// rebuilds from here rather than from device storage.
app.get('/api/interview/state', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  const turns = (s.turns && Array.isArray(s.turns.interview))
    ? s.turns.interview.filter(t => t.content !== SEED_MARKER)
    : [];
  res.json({ interview_complete: s.interview_complete, report_sent: s.report_sent, safety_blocked: s.safety_blocked, turns });
});

// ─── SCORE (Prompt B, server-side) ─────────────────────────────────────────
// Runs the scoring on the server so the parent_report_draft is server-authored
// and gets stored on the session — the client can never forge the report
// content; at send time it can only pick from this stored draft.
app.post('/api/score', async (req, res) => {
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'no active session' });
  if (session.safety_blocked) return res.status(403).json({ error: 'session closed' });
  if (!process.env.ANTHROPIC_API_KEY || !SERVER_PROMPTS.B) return res.status(500).json({ error: 'scoring not configured' });
  // Prefer the SERVER-held transcript (Phase 4). Fall back to a client-supplied
  // one only while the pre-Phase-4 client is still in the wild.
  const storedI = (session.turns && Array.isArray(session.turns.interview)) ? session.turns.interview : null;
  const transcript = (storedI && storedI.length)
    ? formatTranscript(storedI, 'TEEN', 'INTERVIEWER')
    : String((req.body && req.body.transcript) || '');
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  const system = SERVER_PROMPTS.B.split('{{TEEN_AGE}}').join(String(session.teen_age));
  try {
    let parsed = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const text = await callAnthropic({ model: 'claude-opus-4-8', system, messages: [{ role: 'user', content: transcript }], max_tokens: 4000 });
      const c = parseScoringJSON(text);
      if (c && validateScoring(c)) { parsed = c; break; }
      console.warn('score: invalid output attempt ' + attempt);
    }
    if (!parsed) return res.status(502).json({ error: 'could not produce a valid result' });
    if (parsed.safety_check && parsed.safety_check.clear === false) {
      const flag = String(parsed.safety_check.flag || 'DISTRESS').toUpperCase();
      if (SAFETY_BLOCK_FLAGS.has(flag)) await db.updateSession(session.id, { safety_blocked: true, safety_flag: flag });
      fireSafetyAlert(flag, { sid: session.id, teen_first_name: session.teen_first_name, teen_age: session.teen_age });
      return res.json({ safety: flag });
    }
    await db.updateSession(session.id, { report_draft: parsed.parent_report_draft || {}, interview_complete: true });
    sendArchiveEmail(session, 'interview + assessment', transcript, parsed); // test-phase recording (gated by ARCHIVE_EMAIL_TO)
    res.json({ result: parsed }); // no parent_email anywhere in the model output
  } catch (e) {
    console.error('score error:', e.message);
    res.status(502).json({ error: 'scoring error' });
  }
});

// ─── SKILLS SCORE (Prompt D, server-side) ──────────────────────────────────
app.post('/api/skills-score', async (req, res) => {
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'no active session' });
  if (session.safety_blocked) return res.status(403).json({ error: 'session closed' });
  if (!process.env.ANTHROPIC_API_KEY || !SERVER_PROMPTS.D) return res.status(500).json({ error: 'scoring not configured' });
  const storedS = (session.turns && Array.isArray(session.turns.skills)) ? session.turns.skills : null;
  const transcript = (storedS && storedS.length)
    ? formatTranscript(storedS, 'PERSON', 'GUIDE')
    : String((req.body && req.body.transcript) || '');
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  const system = SERVER_PROMPTS.D.split('{{TEEN_AGE}}').join(String(session.teen_age));
  try {
    const text = await callAnthropic({ model: 'claude-opus-4-8', system, messages: [{ role: 'user', content: transcript }], max_tokens: 2000 });
    const parsed = parseScoringJSON(text);
    if (!parsed) return res.status(502).json({ error: 'could not parse skills result' });
    if (parsed.safety_check && parsed.safety_check.clear === false) {
      const flag = String(parsed.safety_check.flag || 'DISTRESS').toUpperCase();
      if (SAFETY_BLOCK_FLAGS.has(flag)) await db.updateSession(session.id, { safety_blocked: true, safety_flag: flag });
      fireSafetyAlert(flag, { sid: session.id, teen_first_name: session.teen_first_name, teen_age: session.teen_age });
      return res.json({ safety: flag });
    }
    const mj = parsed.money_judgment || null;
    if (mj && mj.score != null) {
      const fresh = await db.getSession(session.id);
      const draft = (fresh && fresh.report_draft) || {};
      if (!Array.isArray(draft.shareable_items)) draft.shareable_items = [];
      if (!draft.shareable_items.some(i => i.id === 'mj1')) {
        draft.shareable_items.push({ id: 'mj1', category: 'money_judgment', text: mj.parent_line || mj.teen_summary || '', evidence_quote: null });
        await db.updateSession(session.id, { report_draft: draft });
      }
    }
    sendArchiveEmail(session, 'money scenarios', transcript, parsed); // test-phase recording (gated by ARCHIVE_EMAIL_TO)
    res.json({ money_judgment: mj });
  } catch (e) {
    console.error('skills-score error:', e.message);
    res.status(502).json({ error: 'skills scoring error' });
  }
});

// ─── PARENT REPORT (post preview/veto) ─────────────────────────────────────
// Fires only after the teen approves the preview. Destination is taken from the
// SIGNED token, never the client body. Forwards to the teen agent's OWN Make
// webhook (NOT the parent Family Money Story / deep-work webhook).
// Build the parent-facing email from the FROZEN, teen-approved report. The
// teen's browser sends only the approved + edited items; the server templates
// them into the email so the wording lives in version-controlled code, not the
// browser. This is templating already-approved content — not a re-score.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const REPORT_CATEGORY_LABEL = {
  what_matters: 'What matters to them',
  strength: 'A strength',
  growth_area: 'A growth area',
  environmental: 'Context worth knowing',
  money_judgment: 'Money decisions',
  growth_horizon: 'Where they are, and where they could be',
  confidence: 'How solid this read is',
  program_fit: 'How OTS could help',
  support_request: 'How they’d like your support'
};
function buildParentEmail(report, teenName, parentName) {
  const items = Array.isArray(report.shareable_items) ? report.shareable_items : [];
  const ff = report.fixed_framing || {};
  const pf = report.program_fit || {};
  let h = '';
  h += `<p>Hi ${escHtml(parentName)},</p>`;
  h += `<p>${escHtml(teenName)} just completed the Outsmart the System Teen Check. They saw their own result first and chose what to share with you — here it is.</p>`;
  if (ff.limitation) h += `<p style="font-size:13px;color:#555;background:#f5f6f8;padding:11px 14px;border-radius:8px;margin:16px 0">${escHtml(ff.limitation)}</p>`;
  items.forEach(it => {
    h += `<div style="margin:14px 0;padding:12px 16px;border-left:3px solid #2f6df0;background:#f6f9ff;border-radius:0 8px 8px 0">`;
    h += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8a93a6;margin-bottom:5px">${escHtml(REPORT_CATEGORY_LABEL[it.category] || 'Shared')}</div>`;
    h += `<div>${escHtml(it.text)}</div>`;
    if (it.evidence_quote) h += `<div style="margin-top:7px;font-style:italic;color:#555">&ldquo;${escHtml(it.evidence_quote)}&rdquo;</div>`;
    h += `</div>`;
  });
  // growth horizon, confidence, and program fit now arrive as approved items
  // above (teen-vetoable) — they are no longer auto-appended here.
  if (report.parent_action) {
    h += `<div style="margin:20px 0;padding:14px 16px;background:#f0fbf5;border:1px solid #cdeede;border-radius:10px">`;
    h += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#3a9b6e;margin-bottom:5px">What you can do this week</div>`;
    h += `<div style="color:#333">${escHtml(report.parent_action)}</div></div>`;
  }
  if (Array.isArray(ff.what_not_to_do) && ff.what_not_to_do.length) {
    h += `<p style="font-weight:600;margin:18px 0 6px">A few things to keep in mind:</p><ul style="color:#444;margin:0;padding-left:20px">`;
    ff.what_not_to_do.forEach(x => h += `<li style="margin-bottom:4px">${escHtml(x)}</li>`);
    h += `</ul>`;
  }
  h += `<p style="font-size:12px;color:#999;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Outsmart the System &middot; outsmartthesystem.org<br>This snapshot was approved by ${escHtml(teenName)} before it was sent.</p>`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.55;font-size:15px">${h}</div>`;

  let t = `Hi ${parentName},\n\n${teenName} just completed the Outsmart the System Teen Check. They saw their own result first and chose what to share with you.\n\n`;
  if (ff.limitation) t += ff.limitation + '\n\n';
  items.forEach(it => {
    t += (REPORT_CATEGORY_LABEL[it.category] || 'Shared').toUpperCase() + '\n' + it.text + '\n';
    if (it.evidence_quote) t += '"' + it.evidence_quote + '"\n';
    t += '\n';
  });
  if (report.parent_action) t += 'WHAT YOU CAN DO THIS WEEK\n' + report.parent_action + '\n\n';
  if (Array.isArray(ff.what_not_to_do) && ff.what_not_to_do.length) {
    t += 'A few things to keep in mind:\n';
    ff.what_not_to_do.forEach(x => t += '- ' + x + '\n');
    t += '\n';
  }
  t += 'Outsmart the System — outsmartthesystem.org\nApproved by ' + teenName + ' before sending.';

  return { subject: `${teenName}'s Teen Check — what they chose to share`, html, text: t };
}

app.post('/api/parent-report', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  // Server-enforced, durable: a flagged session never sends a report, and a
  // session sends at most once — regardless of what a modified client claims.
  // The 200 shape mirrors success so a probing client learns nothing.
  if (s.safety_blocked) { console.warn('[PARENT_REPORT_BLOCKED] safety sid=' + s.id); return res.json({ success: true }); }
  if (s.report_sent) { console.warn('[PARENT_REPORT_DUP] already sent sid=' + s.id); return res.json({ success: true }); }

  const webhook = process.env.TEEN_MAKE_WEBHOOK_URL;
  if (!webhook) return res.status(500).json({ error: 'Server not configured: TEEN_MAKE_WEBHOOK_URL missing' });

  // FORGERY FIX: build the report from the SERVER-STORED draft, never from
  // client-supplied content. The client sends only selections (which item ids to
  // include, optional rephrasings, quote on/off) + an optional support line.
  const draft = s.report_draft;
  if (!draft) return res.status(400).json({ error: 'no report to send' });
  const selections = Array.isArray(req.body && req.body.selections) ? req.body.selections : [];
  const selById = {};
  selections.forEach(x => { if (x && x.id) selById[x.id] = x; });

  // The full set of vetoable items the teen could have seen, all from the stored
  // draft (mirrors the client preview): the model's shareable_items plus the
  // personalized growth-horizon / confidence / program-fit lines.
  const available = Array.isArray(draft.shareable_items) ? draft.shareable_items.slice() : [];
  if (draft.growth_horizon) available.push({ id: 'gh1', category: 'growth_horizon', text: draft.growth_horizon, evidence_quote: null });
  if (draft.confidence_summary) available.push({ id: 'cs1', category: 'confidence', text: draft.confidence_summary, evidence_quote: null });
  if (draft.program_fit && draft.program_fit.text) available.push({ id: 'pf1', category: 'program_fit', text: draft.program_fit.text, evidence_quote: null });

  const approvedItems = [];
  available.forEach(it => {
    const sel = selById[it.id];
    if (!sel || !sel.include) return; // teen kept it private (or never selected it)
    const edited = (typeof sel.text === 'string' && sel.text.trim()) ? sel.text.trim().slice(0, 2000) : it.text;
    approvedItems.push({
      id: it.id, category: it.category, text: edited,
      evidence_quote: sel.includeQuote === false ? null : (it.evidence_quote || null)
    });
  });
  const support = (req.body && typeof req.body.support_request === 'string') ? req.body.support_request.trim().slice(0, 500) : '';
  if (support) approvedItems.push({ id: 'sr1', category: 'support_request', text: support, evidence_quote: null });

  const approved = { shareable_items: approvedItems, fixed_framing: draft.fixed_framing || null, parent_action: draft.parent_action || '' };

  // Mark sent BEFORE the network call so a concurrent retry can't double-send.
  await db.updateSession(s.id, { report_sent: true });

  const email = buildParentEmail(approved, s.teen_first_name, s.parent_first_name);
  const out = {
    auth: process.env.MAKE_SHARED_SECRET || '', // gates the Make webhook
    sid: s.id,
    parent_email: s.parent_email,               // from the server-side row only
    parent_first_name: s.parent_first_name,
    teen_first_name: s.teen_first_name,
    teen_age: s.teen_age,
    email_subject: email.subject,
    email_html: email.html,
    email_text: email.text,
    approved_report: approved,
    sent_at: new Date().toISOString()
  };
  try {
    const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out) });
    if (!r.ok) {
      console.error('Parent-report webhook non-OK:', r.status);
      await db.updateSession(s.id, { report_sent: false }); // allow a retry
      return res.status(502).json({ error: 'webhook rejected', status: r.status });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Parent-report webhook error:', err.message);
    await db.updateSession(s.id, { report_sent: false });
    res.status(502).json({ error: err.message });
  }
});

// ============================================================================
// SAFETY EVENT ROUTING  (step 7)
// ============================================================================
// When a [SAFETY_EVENT:*] fires, get a designated human aware — WITHOUT routing
// anything toward the parent and WITHOUT storing the teen's disclosure.
//
// Two detection paths, one funnel (deduped per session+flag so they can't
// double-alert):
//   1. Server-side: /api/chat scans the model's reply for the sentinel
//      (tamper-resistant — fires even if the browser is modified).
//   2. Client-side: /api/safety-event, for the Prompt B STEP-0 safety result
//      (which lives inside JSON, not a sentinel) and as redundancy.
//
// Severity: CRISIS and ABUSE email the responder immediately. SUPPORT/DISTRESS
// are recorded only (no email) so alert fatigue can't bury a real CRISIS.
// The alert carries NO quotes from the teen — only flag, first name, age, sid.
// ABUSE alerts are stamped do_not_contact_parent: the parent may be the threat.
const SAFETY_FLAGS = new Set(['CRISIS', 'ABUSE', 'SUPPORT', 'DISTRESS']);
const SAFETY_EMAIL_FLAGS = new Set(['CRISIS', 'ABUSE']);
const SAFETY_BLOCK_FLAGS = new Set(['CRISIS', 'ABUSE']); // these block any parent report
const alertedEvents = new Set();   // dedup keys: `${sid}:${flag}` (alert dedup only)
// The durable parent-report block now lives in the session row (safety_blocked),
// set by the callers below — not an in-memory set.

// Pre-render the responder alert email. Contains NO teen disclosure — only the
// flag, first name, age, session id. ABUSE carries a do-not-contact-parent banner.
function buildSafetyEmail(flag, info) {
  const name = escHtml(info.teen_first_name || 'a teen');
  const age = escHtml(info.teen_age);
  const subject = `⚠️ OTS Teen Check — ${flag} flag — ${info.teen_first_name || 'teen'} (age ${info.teen_age})`;
  let h = '';
  h += `<div style="background:${flag === 'ABUSE' ? '#7a1f1f' : '#8a4b00'};color:#fff;padding:12px 16px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px">Safety flag: ${escHtml(flag)}</div>`;
  h += `<div style="border:1px solid #e2e2e2;border-top:none;border-radius:0 0 10px 10px;padding:16px">`;
  h += `<p>A teen using the Teen Check just triggered a <b>${escHtml(flag)}</b> safety flag.</p>`;
  if (flag === 'ABUSE') {
    h += `<p style="background:#fdecec;border:1px solid #f5b5b5;color:#7a1f1f;padding:11px 14px;border-radius:8px;font-weight:600">⚠️ Do NOT contact the parent. The parent who set this up may be the concern. Follow the ABUSE branch of the SOP.</p>`;
  }
  h += `<table style="border-collapse:collapse;margin:12px 0;font-size:14px"><tbody>`;
  h += `<tr><td style="color:#777;padding:3px 14px 3px 0">Teen</td><td><b>${name}</b>, age ${age}</td></tr>`;
  h += `<tr><td style="color:#777;padding:3px 14px 3px 0">Session</td><td>${escHtml(info.sid)}</td></tr>`;
  h += `<tr><td style="color:#777;padding:3px 14px 3px 0">Detected</td><td>${escHtml(new Date().toISOString())}</td></tr>`;
  h += `</tbody></table>`;
  h += `<p style="color:#555;font-size:13px">This alert contains <b>no quotes</b> from the teen, by policy. The teen has already been shown crisis resources (988/911) in the conversation, and no report will go to the parent for this session.</p>`;
  h += `<p style="font-weight:600;margin:14px 0 4px">What to do now</p>`;
  h += `<p style="color:#444;font-size:14px;margin-top:0">Follow the OTS Teen Check Safety SOP. OTS's role is to connect the teen to real help, not to counsel. Never forward this to the parent.</p>`;
  h += `<p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:10px;margin-top:16px">Outsmart the System — Teen Check safety routing</p>`;
  h += `</div>`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.5;font-size:15px">${h}</div>`;
  return { subject, html };
}

async function fireSafetyAlert(flag, info) {
  flag = String(flag || '').toUpperCase();
  if (!SAFETY_FLAGS.has(flag)) return;
  const key = (info.sid || '?') + ':' + flag;
  if (alertedEvents.has(key)) return;
  alertedEvents.add(key);
  if (alertedEvents.size > 10000) alertedEvents.clear(); // bound memory

  console.warn('[SAFETY_EVENT]', flag, '| sid=' + info.sid, '| teen=' + info.teen_first_name, '| age=' + info.teen_age);

  if (!SAFETY_EMAIL_FLAGS.has(flag)) return; // SUPPORT/DISTRESS: recorded, not emailed
  if (!safetyMailer) {
    console.error('Safety email not configured (EMAIL_USER/EMAIL_PASS) — a', flag, 'alert was NOT delivered.');
    return;
  }
  const email = buildSafetyEmail(flag, info);
  const to = process.env.SAFETY_ALERT_TO || process.env.EMAIL_USER;
  try {
    await safetyMailer.sendMail({ from: process.env.EMAIL_USER, to, subject: email.subject, html: email.html });
    console.warn('[SAFETY_ALERT_SENT]', flag, '→', to, '| sid=' + info.sid);
  } catch (err) {
    console.error('Safety email send error:', err.message);
  }
}

// ─── TEST-PHASE SESSION ARCHIVE ─────────────────────────────────────────────
// During the supervised pilot, email a FULL record (transcript + assessment) to
// ARCHIVE_EMAIL_TO so there's data to improve the product. Gated entirely by
// that env var: unset = OFF. Remove it (or clear it) to turn recording off at
// go-live. It reuses the Gmail transport, so EMAIL_USER/EMAIL_PASS must be set.
//
// SAFETY CARVE-OUT: a safety-flagged session is NEVER archived. CRISIS/ABUSE
// disclosures are purged on the device and handled by the (quote-free) safety
// alert — they must not land verbatim in an archive inbox.
function archiveEnabled() { return !!(process.env.ARCHIVE_EMAIL_TO && safetyMailer); }

async function sendArchiveEmail(session, kind, transcript, assessment) {
  if (!archiveEnabled()) return;
  if (session.safety_blocked) { console.warn('[ARCHIVE_SKIP] safety-flagged sid=' + session.id); return; }
  const to = process.env.ARCHIVE_EMAIL_TO;
  const pretty = (() => { try { return JSON.stringify(assessment, null, 2); } catch { return String(assessment); } })();
  const pre = 'white-space:pre-wrap;word-break:break-word;background:#f6f8fa;border:1px solid #e1e4e8;border-radius:8px;padding:12px;font-size:12px';
  const subject = `[Teen Check archive] ${session.teen_first_name} (${session.teen_age}) — ${kind}`;
  const html =
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:760px;color:#1a1a1a;line-height:1.5;font-size:14px">` +
    `<p style="background:#fff7e6;border:1px solid #ffe0a3;padding:8px 12px;border-radius:8px;font-size:12px">TEST-PHASE RECORDING — internal improvement data. Turn off by clearing <b>ARCHIVE_EMAIL_TO</b> before go-live.</p>` +
    `<p><b>Session:</b> ${escHtml(session.id)}<br><b>Teen:</b> ${escHtml(session.teen_first_name)} (age ${escHtml(session.teen_age)})<br><b>Parent:</b> ${escHtml(session.parent_first_name)} &lt;${escHtml(session.parent_email)}&gt;<br><b>Stage:</b> ${escHtml(kind)}</p>` +
    `<h3 style="margin:18px 0 6px">Full assessment</h3><pre style="${pre}">${escHtml(pretty)}</pre>` +
    `<h3 style="margin:18px 0 6px">Full transcript</h3><pre style="${pre}">${escHtml(transcript)}</pre>` +
    `</div>`;
  const text =
    `TEST-PHASE RECORDING — internal improvement data (clear ARCHIVE_EMAIL_TO to disable).\n` +
    `Session: ${session.id}\nTeen: ${session.teen_first_name} (age ${session.teen_age})\n` +
    `Parent: ${session.parent_first_name} <${session.parent_email}>\nStage: ${kind}\n\n` +
    `===== FULL ASSESSMENT =====\n${pretty}\n\n===== FULL TRANSCRIPT =====\n${transcript}\n`;
  try {
    await safetyMailer.sendMail({ from: process.env.EMAIL_USER, to, subject, html, text });
    console.log('[ARCHIVE_SENT]', kind, '→', to, '| sid=' + session.id);
  } catch (err) {
    console.error('Archive email error:', err.message);
  }
}

// Client-reported safety event (cookie-gated). Acks regardless so the client
// never learns whether/how an alert was routed. Persists the durable block.
app.post('/api/safety-event', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  const flag = String(req.body && req.body.flag || '').toUpperCase();
  if (!SAFETY_FLAGS.has(flag)) return res.status(400).json({ error: 'invalid flag' });
  if (SAFETY_BLOCK_FLAGS.has(flag)) { try { await db.updateSession(s.id, { safety_blocked: true, safety_flag: flag }); } catch (e) { console.error('safety block persist:', e.message); } }
  fireSafetyAlert(flag, { sid: s.id, teen_first_name: s.teen_first_name, teen_age: s.teen_age });
  res.json({ ok: true });
});

// ─── ANTHROPIC CHAT (Prompt A turns AND the Prompt B scoring call) ─────────
// Model-agnostic proxy. The frontend supplies system/messages/max_tokens and a
// whitelisted model, plus the session token `t` (used only for server-side
// safety attribution — it is NOT forwarded to Anthropic).
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-opus-4-8',
  'claude-haiku-4-5-20251001'
]);

// The generic /api/chat proxy is GONE (Phase 4). The interview, skills, and
// scoring all run through server-orchestrated endpoints that own the prompt and
// the transcript — there is no longer any path that forwards a client-supplied
// prompt to the model. (Closes the open-AI-proxy P0.)

// ─── END & CLEAR THIS DEVICE ────────────────────────────────────────────────
// Clears the HttpOnly cookie (JS can't) and purges the in-progress transcript,
// honoring "your answers won't be saved." Always 200.
app.post('/api/session/end', async (req, res) => {
  const s = await currentSession(req);
  if (s && !s.interview_complete) {
    try { await db.updateSession(s.id, { turns: { interview: [], skills: [] } }); } catch (e) {}
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ─── HEALTH ────────────────────────────────────────────────────────────────
// Always 200 (liveness for Render), but reports a readiness signal: `ready` is
// false and `missing` lists any launch-critical config that's absent, so a fresh
// blueprint deploy that came up without (e.g.) the safety email is visible.
app.get('/api/health', (req, res) => {
  const configured = {
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    teen_webhook: !!process.env.TEEN_MAKE_WEBHOOK_URL,
    make_secret: !!process.env.MAKE_SHARED_SECRET,
    safety_email: !!safetyMailer,
    durable_db: db.backend() === 'postgres'   // in-memory is dev-only, not launch-ready
  };
  const missing = Object.keys(configured).filter(k => !configured[k]);
  // archive_recording is OPTIONAL (test-phase only) — reported, but never gates ready.
  res.json({ ok: true, service: 'ots-teen-agent', ready: missing.length === 0, db: db.backend(), archive_recording: archiveEnabled(), configured, missing });
});

// Prompts live server-side only (Phase 4): the server reads them from disk, but
// they are not served over HTTP. Block before the static handler.
app.use((req, res, next) => {
  const p = (req.path || '').toLowerCase();
  if (p === '/prompts.js' || p.startsWith('/prompts/')) return res.status(404).end();
  next();
});
app.use(express.static(path.join(__dirname)));

// ─── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
db.init()
  .then(() => console.log('session store ready:', db.backend()))
  .catch(e => console.error('db.init error (continuing):', e.message))
  .finally(() => app.listen(PORT, () => console.log(`ots-teen-agent running on port ${PORT} (db: ${db.backend()})`)));
