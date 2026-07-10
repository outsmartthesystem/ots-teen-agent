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
      body: JSON.stringify({ model, max_tokens: Math.min(max_tokens || 4000, 8000), system, messages }),
      timeout: 60000 // bound a stalled upstream so the teen never waits forever
    });
    if ((r.status === 429 || r.status === 529) && attempt < 3) { await wait(attempt * 3000); continue; }
    break;
  }
  data = await r.json();
  if (!r.ok) throw new Error('anthropic ' + r.status);
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// ─── FUNNEL ANALYTICS + CRM SYNC (env-guarded, fire-and-forget) ─────────────
// Mirror the website's server-side GA4 Measurement Protocol + an optional CRM
// sync webhook so the Map funnel reports the same click→lead→paid events as the
// diagnostic. BOTH are no-ops unless their env vars are set, and neither is
// awaited in a request's critical path — a failure here can never break an
// interview turn, a score, or a report send.
function ga4Event(clientId, name, params) {
  const id = process.env.GA4_MEASUREMENT_ID, secret = process.env.GA4_MP_API_SECRET;
  if (!id || !secret) return; // unconfigured → silent no-op
  fetch(`https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(id)}&api_secret=${encodeURIComponent(secret)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId || 'anon', events: [{ name, params: params || {} }] }),
    timeout: 8000
  }).catch(err => console.warn('[GA4]', name, 'failed:', err.message));
}
function ghlSync(event, s, tag) {
  const url = process.env.GHL_SYNC_WEBHOOK_URL;
  if (!url || !s) return; // unconfigured → silent no-op
  fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, tag, parent_email: s.parent_email, parent_first_name: s.parent_first_name, teen_first_name: s.teen_first_name, teen_age: s.teen_age }),
    timeout: 10000
  }).catch(err => console.warn('[GHL_SYNC]', event, 'failed:', err.message));
}
// Client-only funnel events allowed through /api/event (server relays to GA4).
const EVENT_WHITELIST = new Set(['map_pdf_saved', 'map_share_opened', 'map_preview_started']);

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
const TOTAL_QUESTIONS = 22; // v5: was 16 — splits of the old double-barrels + 2 new questions
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

// Coarse phase label for the visible progress bar (the interview is model-paced,
// so this is an approximate map, not a strict state machine).
function phaseFor(q) {
  // v5 phase map (22 questions): Arrival 1–3 · What You Want 4–10 ·
  // The Reality Check 11–15 · Family Patterns 16–18 · The Gap 19–22.
  if (q <= 3) return 'Arrival';
  if (q <= 10) return 'What you want';
  if (q <= 15) return 'The reality check';
  if (q <= 18) return 'Family patterns';
  return 'The gap';
}

// Quick-answer chips: when the model asks one of the list-style questions, offer
// tappable options (the teen can still type). Keyed off the question wording, so
// chips only appear when the matching question is actually asked.
const CHIP_SETS = [
  // Q2 — school/work status
  { test: /school.*work|work.*school|year off/i, chips: ['In school', 'Working', 'Both', 'Taking time off'] },
  // Q3 — how they think about money (multi-select ok; free text always open)
  { test: /money's on your mind|what's it usually about/i, chips: ['Curiosity', 'Planning ahead', 'Wanting things', 'Stress', 'Barely think about it'] },
  // Q10 — control split (in-control vs not)
  { test: /actually up to you/i, chips: ['Mostly me', 'Mostly not up to me', 'Honestly both'] },
  // Q13 — money-amount ranges, with an honesty-preserving "Rather not say"
  { test: /how much money is actually yours|money is actually yours/i, chips: ['Under $50', '$50–250', '$250–1,000', 'Over $1,000', 'Rather not say'] },
  // Q17 — home money climate
  { test: /sound most like home/i, chips: ['Planned & talked about openly', 'Mostly avoided', 'Spent pretty freely', 'Saved really cautiously', 'Often stressful or tense', 'Different depending on the adult'] }
];
function chipsFor(msg) { const f = CHIP_SETS.find(c => c.test.test(String(msg || ''))); return f ? f.chips : null; }
// The goal-priority question — the teen's NEXT answer becomes the pinned goal chip.
const GOAL_Q_RE = /matters most|which one matters|of those three/i;

// Format a stored turn array into the speaker-labelled transcript the scoring
// prompts expect (identical to the client's previous buildTranscript output).
function formatTranscript(turns, userLabel, asstLabel) {
  return (turns || [])
    .filter(t => t.content !== SEED_MARKER)
    .map(t => (t.role === 'user' ? userLabel : asstLabel) + ':\n' + t.content)
    .join('\n\n———\n\n');
}

// Anti-hallucination: null out any teen/parent-facing evidence_quote that isn't
// actually present in the transcript (audit: "verify every verbatim quote").
function normForQuote(s) {
  return String(s || '').toLowerCase().replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"').replace(/\s+/g, ' ').trim();
}
function quoteFound(quote, normTranscript) {
  const q = normForQuote(quote);
  if (q.length < 8) return true; // too short to verify meaningfully — leave it
  return normTranscript.includes(q);
}
function stripUnverifiedQuotes(parsed, transcriptText) {
  const norm = normForQuote(transcriptText);
  let dropped = 0;
  const ds = parsed.teen_output && parsed.teen_output.demonstrated_strength;
  if (ds && ds.evidence_quote && !quoteFound(ds.evidence_quote, norm)) { ds.evidence_quote = null; dropped++; }
  const items = parsed.parent_report_draft && parsed.parent_report_draft.shareable_items;
  if (Array.isArray(items)) items.forEach(it => { if (it && it.evidence_quote && !quoteFound(it.evidence_quote, norm)) { it.evidence_quote = null; dropped++; } });
  if (dropped) console.warn('[QUOTE_VERIFY] nulled ' + dropped + ' unverified quote(s)');
}

const INTERVIEW_SUB = (s) => SERVER_PROMPTS.A
  .split('{{TEEN_FIRST_NAME}}').join(s.teen_first_name)
  .split('{{PARENT_FIRST_NAME}}').join(s.parent_first_name)
  .split('{{TEEN_AGE_PLUS_3}}').join(String(s.teen_age + 3))
  .split('{{TEEN_AGE}}').join(String(s.teen_age));
const SKILLS_SUB = (s) => SERVER_PROMPTS.C
  .split('{{TEEN_FIRST_NAME}}').join(s.teen_first_name)
  .split('{{TEEN_AGE}}').join(String(s.teen_age))
  .split('{{TEEN_CONTEXT}}').join((s.turns && s.turns.context_hint) ? s.turns.context_hint : 'their own goals and interests');

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

// SHA-256 hex — we store only the HASH of an invite token, never the token itself.
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

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
    "img-src 'self' data:; connect-src 'self'; " +
    // Allow the OTS pathway's optional Jay video: YouTube/Vimeo embeds + https <video>.
    "media-src 'self' https:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
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

// Fail closed: if the durable store was configured but did not initialize (e.g.
// DATABASE_URL set but Postgres unreachable), refuse API traffic rather than
// silently running on a broken/missing store. Health stays reachable so the
// problem is visible. (audit P2)
app.use('/api/', (req, res, next) => {
  if ((req.originalUrl || '').split('?')[0] === '/api/health') return next();
  if (!db.ready()) return res.status(503).json({ error: 'service unavailable: data store not ready' });
  next();
});

// ============================================================================
// SESSIONS  (parent → teen handoff)
// ============================================================================
// Phase 1+4 replaced the old stateless HMAC token with OPAQUE server-side
// sessions: the parent registers, the server stores a session row and returns a
// one-use ?s=<random-id> link; /api/session/start exchanges it for an HttpOnly
// cookie (cookie helpers above). parent_email lives only in the row and is never
// returned to the teen; report destination and content are server-side only.
// The old signToken/verifyToken/TOKEN_SIGNING_SECRET code was removed here.
// ============================================================================

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
  const inviteToken = crypto.randomBytes(24).toString('base64url'); // one-time LINK secret; the session id is NEVER in the link
  const expires_at = Date.now() + SESSION_TTL_SECONDS * 1000;
  try {
    await db.createSession({ id, teen_first_name: tName, teen_age: age, parent_first_name: pName, parent_email: pEmail, expires_at, invite_token_hash: sha256(inviteToken) });
  } catch (e) {
    console.error('register/createSession error:', e.message);
    return res.status(500).json({ error: 'Could not create the session. Try again.' });
  }
  ga4Event('sess.' + id, 'map_registered', { teen_age: age });
  ghlSync('map_registered', { parent_email: pEmail, parent_first_name: pName, teen_first_name: tName, teen_age: age }, 'map-registered');
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  res.json({ teen_url: `${base}/?i=${inviteToken}`, expires_at: Math.floor(expires_at / 1000) });
});

// ─── START (teen opens the link) ───────────────────────────────────────────
// Exchanges the opaque link id for an HttpOnly session cookie. The client then
// strips ?s= from the URL; all later calls authenticate by cookie.
app.post('/api/session/start', async (req, res) => {
  // One-time claim: `i` = new invite token; `s` = legacy session-id link (minted
  // before invite tokens existed). Either way the invite is atomically consumed
  // and the cookie is set to the session id — which new links never contained.
  // A used or expired link can never re-open the session (closes the TRUST-0 hole
  // where the parent, holding the link, could view a result the teen kept private).
  const b = req.body || {};
  const claimed = await db.claimInvite(b.i ? { tokenHash: sha256(String(b.i)) } : { sessionId: b.s ? String(b.s) : null });
  if (!claimed) return res.status(410).json({ error: 'This private link has already been used. Ask for a fresh one if you need it.' });
  setSessionCookie(req, res, claimed.id);
  res.json(teenSafe(claimed));
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
  const priorQ = (turns.length && turns[turns.length - 1].role === 'assistant') ? turns[turns.length - 1].content : '';
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
    // Pin a goal chip when the answer just given was to the goal-priority question.
    const goalChip = (answer && GOAL_Q_RE.test(priorQ)) ? answer.trim().slice(0, 80) : (store.goal_chip || '');
    const newStore = Object.assign({}, store, { interview: turns });
    if (goalChip) newStore.goal_chip = goalChip;
    await db.updateSession(session.id, Object.assign({ turns: newStore }, complete ? { interview_complete: true } : {}));
    // Progress for the header bar: the opening frame isn't a numbered question.
    const q = Math.max(0, turns.filter(t => t.role === 'assistant').length - 1);
    res.json({ message: clean, complete, progress: { q, total: TOTAL_QUESTIONS, phase: phaseFor(q) }, chips: chipsFor(clean) || undefined, goal: goalChip || undefined });
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
    await db.updateSession(session.id, { turns: Object.assign({}, store, { skills: turns }, complete ? { skills_done: true } : {}) });
    // Skills opens directly on scenario 1 (no frame), so q = scenario number.
    const q = Math.min(turns.filter(t => t.role === 'assistant').length, 5);
    res.json({ message: clean, complete, progress: { q, total: 5, phase: 'Scenario ' + Math.max(1, q) } });
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
  res.json({ interview_complete: s.interview_complete, report_sent: s.report_sent, safety_blocked: s.safety_blocked, turns, goal: (s.turns && s.turns.goal_chip) || undefined });
});

// ─── RESULT (recovery on reload) ───────────────────────────────────────────
// A finished session can re-render its result so a teen who didn't save/share
// isn't stuck on "already complete". Assembles the stored teen result + the
// parent draft (single source) + the optional money-judgment.
app.get('/api/result', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  if (!s.interview_complete || !s.result) return res.status(404).json({ error: 'no result' });
  const r = s.result || {};
  res.json({
    teen_output: r.teen_output || null,
    level: r.level || null,
    parent_report_draft: s.report_draft || null,
    money_judgment: r.money_judgment || null,
    report_sent: !!s.report_sent
  });
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
  // Score ONLY the server's own completed transcript — no client-supplied
  // transcript, and only after the interview actually completed. This blocks a
  // session holder from submitting an arbitrary transcript to scoring (audit P0).
  if (!session.interview_complete) return res.status(409).json({ error: 'interview not complete' });
  // Idempotent: if we've already scored this session, return the stored result
  // rather than re-running the (paid) model call. Only /api/score/refine regenerates.
  if (session.result && (session.result.teen_output || session.result.level)) {
    return res.json({ result: { safety_check: { clear: true, flag: null }, level: session.result.level || null, teen_output: session.result.teen_output || null, parent_report_draft: session.report_draft || {}, money_judgment: session.result.money_judgment || null } });
  }
  const storedI = (session.turns && Array.isArray(session.turns.interview)) ? session.turns.interview : null;
  if (!storedI || !storedI.length) return res.status(409).json({ error: 'no interview transcript' });
  const transcript = formatTranscript(storedI, 'TEEN', 'INTERVIEWER');
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
    stripUnverifiedQuotes(parsed, transcript); // drop any quote not actually in the transcript
    // Capture a short goal/interest hint so the optional Decision Lab can personalize a scenario.
    const contextHint = (parsed.teen_output && parsed.teen_output.goal_reflected) ? String(parsed.teen_output.goal_reflected).slice(0, 300) : '';
    const mergedTurns = Object.assign({}, session.turns || {}, { context_hint: contextHint });
    // Store the teen-facing result so a reload can re-render it (recovery).
    const teenResult = { teen_output: parsed.teen_output || null, level: parsed.level || null };
    await db.updateSession(session.id, { report_draft: parsed.parent_report_draft || {}, interview_complete: true, turns: mergedTurns, result: teenResult, completed_at: new Date() });
    sendArchiveEmail(session, 'interview + assessment', transcript, parsed); // test-phase recording (gated by ARCHIVE_EMAIL_TO)
    ga4Event('sess.' + session.id, 'map_interview_complete', {});
    ga4Event('sess.' + session.id, 'map_result_viewed', { stage: (parsed.level && parsed.level.stage) || '' });
    res.json({ result: parsed }); // no parent_email anywhere in the model output
  } catch (e) {
    console.error('score error:', e.message);
    res.status(502).json({ error: 'scoring error' });
  }
});

// ─── REFINE ("Does this feel true?" → Not really) ──────────────────────────
// Re-score the SAME stored transcript with the teen's correction in mind, so a
// read the teen says is wrong gets corrected before any parent report is built.
app.post('/api/score/refine', async (req, res) => {
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'no active session' });
  if (session.safety_blocked) return res.status(403).json({ error: 'session closed' });
  if (!process.env.ANTHROPIC_API_KEY || !SERVER_PROMPTS.B) return res.status(500).json({ error: 'scoring not configured' });
  if (!session.interview_complete) return res.status(409).json({ error: 'interview not complete' });
  const storedI = (session.turns && Array.isArray(session.turns.interview)) ? session.turns.interview : null;
  if (!storedI || !storedI.length) return res.status(409).json({ error: 'no interview transcript' });
  const correction = (req.body && typeof req.body.correction === 'string') ? req.body.correction.trim().slice(0, 1000) : '';
  if (!correction) return res.status(400).json({ error: 'correction required' });
  // Cap refinements so a session holder can't churn the read or burn model spend.
  const refined = await db.claimRefine(session.id, 2);
  if (refined === null) return res.status(429).json({ error: 'refine limit reached' });

  const baseTranscript = formatTranscript(storedI, 'TEEN', 'INTERVIEWER');
  const transcript = baseTranscript + '\n\n=== TEEN\'S CORRECTION ===\n' + correction;
  const system = SERVER_PROMPTS.B.split('{{TEEN_AGE}}').join(String(session.teen_age));
  try {
    let parsed = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const text = await callAnthropic({ model: 'claude-opus-4-8', system, messages: [{ role: 'user', content: transcript }], max_tokens: 4000 });
      const c = parseScoringJSON(text);
      if (c && validateScoring(c)) { parsed = c; break; }
    }
    if (!parsed) return res.status(502).json({ error: 'could not refine' });
    if (parsed.safety_check && parsed.safety_check.clear === false) {
      const flag = String(parsed.safety_check.flag || 'DISTRESS').toUpperCase();
      if (SAFETY_BLOCK_FLAGS.has(flag)) await db.updateSession(session.id, { safety_blocked: true, safety_flag: flag });
      fireSafetyAlert(flag, { sid: session.id, teen_first_name: session.teen_first_name, teen_age: session.teen_age });
      return res.json({ safety: flag });
    }
    stripUnverifiedQuotes(parsed, baseTranscript); // verify quotes against the REAL transcript, not the correction
    const refreshed = Object.assign({}, session.result || {}, { teen_output: parsed.teen_output || null, level: parsed.level || null });
    await db.updateSession(session.id, { report_draft: parsed.parent_report_draft || {}, result: refreshed });
    sendArchiveEmail(session, 'refined assessment', transcript, parsed);
    res.json({ result: parsed });
  } catch (e) {
    console.error('refine error:', e.message);
    res.status(502).json({ error: 'refine error' });
  }
});

// ─── SKILLS SCORE (Prompt D, server-side) ──────────────────────────────────
app.post('/api/skills-score', async (req, res) => {
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'no active session' });
  if (session.safety_blocked) return res.status(403).json({ error: 'session closed' });
  if (!process.env.ANTHROPIC_API_KEY || !SERVER_PROMPTS.D) return res.status(500).json({ error: 'scoring not configured' });
  // Same as scoring: only the server's own completed skills transcript.
  const storedS = (session.turns && Array.isArray(session.turns.skills)) ? session.turns.skills : null;
  if (!(session.turns && session.turns.skills_done) || !storedS || !storedS.length) {
    return res.status(409).json({ error: 'skills not complete' });
  }
  const transcript = formatTranscript(storedS, 'PERSON', 'GUIDE');
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
      }
      const resultObj = Object.assign({}, (fresh && fresh.result) || {}, { money_judgment: mj }); // recovery
      await db.updateSession(session.id, { report_draft: draft, result: resultObj });
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
  money_judgment: 'Money decision skills',
  growth_horizon: 'Where they are, and where they could be',
  confidence: 'How solid this read is',
  program_fit: 'How OTS could help',
  support_request: 'How they’d like your support',
  parent_action: 'Your move this week',
  conversation_starter: 'One question to ask'
};
// Build the approved parent-report items from the SERVER-STORED draft + the
// teen's selections. Pure + exported so the forgery-resistance is unit-tested:
// only ids that exist in the stored draft can appear; unknown/forged ids are
// dropped; quotes ride only when includeQuote isn't false.
function buildApprovedItems(draft, selections, supportRaw) {
  draft = draft || {};
  const selById = {};
  (Array.isArray(selections) ? selections : []).forEach(x => { if (x && x.id) selById[x.id] = x; });
  const available = Array.isArray(draft.shareable_items) ? draft.shareable_items.slice() : [];
  if (draft.growth_horizon) available.push({ id: 'gh1', category: 'growth_horizon', text: draft.growth_horizon, evidence_quote: null });
  if (draft.confidence_summary) available.push({ id: 'cs1', category: 'confidence', text: draft.confidence_summary, evidence_quote: null });
  if (draft.program_fit && draft.program_fit.text) available.push({ id: 'pf1', category: 'program_fit', text: draft.program_fit.text, evidence_quote: null });
  // Personalized parent guidance is teen-approvable too — nothing personalized bypasses the veto.
  if (draft.parent_action) available.push({ id: 'pa1', category: 'parent_action', text: draft.parent_action, evidence_quote: null });
  if (draft.conversation_starter) available.push({ id: 'cq1', category: 'conversation_starter', text: draft.conversation_starter, evidence_quote: null });
  const items = [];
  available.forEach(it => {
    const sel = selById[it.id];
    if (!sel || !sel.include) return; // not selected, or forged id with no stored item
    const edited = (typeof sel.text === 'string' && sel.text.trim()) ? sel.text.trim().slice(0, 2000) : it.text;
    items.push({ id: it.id, category: it.category, text: edited, evidence_quote: sel.includeQuote === false ? null : (it.evidence_quote || null) });
  });
  const support = (typeof supportRaw === 'string') ? supportRaw.trim().slice(0, 500) : '';
  if (support) items.push({ id: 'sr1', category: 'support_request', text: support, evidence_quote: null });
  return items;
}

function buildParentEmail(report, teenName, parentName) {
  const allItems = Array.isArray(report.shareable_items) ? report.shareable_items : [];
  // The Handshake pulls these three (all teen-approved items); they never appear in the generic list.
  const HANDSHAKE_CATS = new Set(['support_request', 'parent_action', 'conversation_starter']);
  const items = allItems.filter(it => !HANDSHAKE_CATS.has(it.category));
  const support = allItems.find(it => it.category === 'support_request' && it.text); // teen's ask → Handshake
  const parentAction = allItems.find(it => it.category === 'parent_action' && it.text); // teen-approved (pa1)
  const convoStarter = allItems.find(it => it.category === 'conversation_starter' && it.text); // teen-approved (cq1)
  const ff = report.fixed_framing || {};
  const hasHandshake = !!(support || parentAction || convoStarter);

  // ── HTML ──
  let h = '';
  h += `<p>Hi ${escHtml(parentName)},</p>`;
  h += `<p>${escHtml(teenName)} just completed their Teen Money & Momentum Map. They saw their own result first and chose what to share with you — here it is.</p>`;
  if (ff.limitation) h += `<p style="font-size:13px;color:#555;background:#f5f6f8;padding:11px 14px;border-radius:8px;margin:16px 0">${escHtml(ff.limitation)}</p>`;
  items.forEach(it => {
    h += `<div style="margin:14px 0;padding:12px 16px;border-left:3px solid #2f6df0;background:#f6f9ff;border-radius:0 8px 8px 0">`;
    h += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8a93a6;margin-bottom:5px">${escHtml(REPORT_CATEGORY_LABEL[it.category] || 'Shared')}</div>`;
    h += `<div>${escHtml(it.text)}</div>`;
    if (it.evidence_quote) h += `<div style="margin-top:7px;font-style:italic;color:#555">&ldquo;${escHtml(it.evidence_quote)}&rdquo;</div>`;
    h += `</div>`;
  });
  // Family Handshake — the teen's ask + your move + a way in, in one place.
  if (hasHandshake) {
    const row = (label, val, q) => `<div style="margin-bottom:11px"><div style="font-size:11px;color:#8a93a6;text-transform:uppercase;letter-spacing:.04em;margin-bottom:2px">${label}</div><div style="color:#333">${q ? '&ldquo;' : ''}${escHtml(val)}${q ? '&rdquo;' : ''}</div></div>`;
    h += `<div style="margin:22px 0;padding:16px 18px;background:#f0fbf5;border:1px solid #cdeede;border-radius:12px">`;
    h += `<div style="font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#3a9b6e;margin-bottom:11px;font-weight:600">A Family Handshake</div>`;
    if (support) h += row(`What ${escHtml(teenName)} asked for`, support.text, false);
    if (parentAction) h += row('Your move this week', parentAction.text, false);
    if (convoStarter) h += row('One question to ask', convoStarter.text, true);
    h += `</div>`;
  }
  if (Array.isArray(ff.what_not_to_do) && ff.what_not_to_do.length) {
    h += `<p style="font-weight:600;margin:18px 0 6px">A few things to keep in mind:</p><ul style="color:#444;margin:0;padding-left:20px">`;
    ff.what_not_to_do.forEach(x => h += `<li style="margin-bottom:4px">${escHtml(x)}</li>`);
    h += `</ul>`;
  }
  h += `<p style="font-size:12px;color:#999;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Outsmart the System &middot; outsmartthesystem.org<br>This snapshot was approved by ${escHtml(teenName)} before it was sent.</p>`;
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:600px;margin:0 auto;color:#1a1a1a;line-height:1.55;font-size:15px">${h}</div>`;

  // ── plaintext ──
  let t = `Hi ${parentName},\n\n${teenName} just completed their Teen Money & Momentum Map. They saw their own result first and chose what to share with you.\n\n`;
  if (ff.limitation) t += ff.limitation + '\n\n';
  items.forEach(it => {
    t += (REPORT_CATEGORY_LABEL[it.category] || 'Shared').toUpperCase() + '\n' + it.text + '\n';
    if (it.evidence_quote) t += '"' + it.evidence_quote + '"\n';
    t += '\n';
  });
  if (hasHandshake) {
    t += 'A FAMILY HANDSHAKE\n';
    if (support) t += '- What ' + teenName + ' asked for: ' + support.text + '\n';
    if (parentAction) t += '- Your move this week: ' + parentAction.text + '\n';
    if (convoStarter) t += '- One question to ask: "' + convoStarter.text + '"\n';
    t += '\n';
  }
  if (Array.isArray(ff.what_not_to_do) && ff.what_not_to_do.length) {
    t += 'A few things to keep in mind:\n';
    ff.what_not_to_do.forEach(x => t += '- ' + x + '\n');
    t += '\n';
  }
  t += 'Outsmart the System — outsmartthesystem.org\nApproved by ' + teenName + ' before sending.';

  return { subject: `${teenName}'s Money & Momentum Map — what they chose to share`, html, text: t };
}

// ─── SHARE DECLINE ("Keep this private" / "Don't send anything") ────────────
// Durable private decision: block any future parent-report send, drop the stored
// report draft + transcript, clear the cookie. Survives reopen via sharing_status.
app.post('/api/share/decline', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  if (s.sharing_status === 'pending') {
    await db.updateSession(s.id, {
      sharing_status: 'declined', sharing_decided_at: new Date(),
      report_draft: null, turns: { interview: [], skills: [] } // private means no retained transcript/draft
    });
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/parent-report', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  // Server-enforced, durable: a flagged session never sends a report, and a
  // session sends at most once — regardless of what a modified client claims.
  // The 200 shape mirrors success so a probing client learns nothing.
  if (s.safety_blocked) { console.warn('[PARENT_REPORT_BLOCKED] safety sid=' + s.id); return res.json({ success: true }); }
  // A declined or already-sent session never sends (durable sharing state).
  if (s.sharing_status !== 'pending') { console.warn('[PARENT_REPORT_BLOCKED] sharing_status=' + s.sharing_status + ' sid=' + s.id); return res.json({ success: true }); }

  const webhook = process.env.TEEN_MAKE_WEBHOOK_URL;
  if (!webhook) return res.status(500).json({ error: 'Server not configured: TEEN_MAKE_WEBHOOK_URL missing' });

  // FORGERY FIX: build the report from the SERVER-STORED draft, never from
  // client-supplied content. The client sends only selections (which item ids to
  // include, optional rephrasings, quote on/off) + an optional support line.
  const draft = s.report_draft;
  if (!draft) return res.status(400).json({ error: 'no report to send' });

  // Build the report from the SERVER-STORED draft + the teen's selections only.
  const approvedItems = buildApprovedItems(draft, req.body && req.body.selections, req.body && req.body.support_request);
  const approved = { shareable_items: approvedItems, fixed_framing: draft.fixed_framing || null }; // pa1/cq1 now ride inside approvedItems (teen-approved)

  // ATOMIC one-time claim: exactly one caller wins; concurrent/repeat callers and
  // safety-blocked sessions get false (no double-send race). (audit P2)
  const claimed = await db.claimReportSend(s.id);
  if (!claimed) { console.warn('[PARENT_REPORT_DUP_OR_BLOCKED] sid=' + s.id); return res.json({ success: true }); }

  const email = buildParentEmail(approved, s.teen_first_name, s.parent_first_name);
  // Data minimization: send ONLY what the Make scenario uses to deliver the email
  // (no duplicate structured report, no plaintext copy) — less teen data at rest in Make.
  const out = {
    auth: process.env.MAKE_SHARED_SECRET || '', // gates the Make webhook
    sid: s.id,
    parent_email: s.parent_email,               // from the server-side row only
    parent_first_name: s.parent_first_name,
    teen_first_name: s.teen_first_name,
    email_subject: email.subject,
    email_html: email.html,
    sent_at: new Date().toISOString()
  };
  try {
    const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(out), timeout: 15000 });
    if (!r.ok) {
      console.error('Parent-report webhook non-OK:', r.status);
      await db.updateSession(s.id, { report_sent: false }); // allow a retry
      return res.status(502).json({ error: 'webhook rejected', status: r.status });
    }
    ga4Event('sess.' + s.id, 'map_report_sent', {});
    ghlSync('map_report_sent', s, 'map-report-sent');
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
  const subject = `⚠️ OTS Money & Momentum Map — ${flag} flag — ${info.teen_first_name || 'teen'} (age ${info.teen_age})`;
  let h = '';
  h += `<div style="background:${flag === 'ABUSE' ? '#7a1f1f' : '#8a4b00'};color:#fff;padding:12px 16px;border-radius:10px 10px 0 0;font-weight:700;font-size:16px">Safety flag: ${escHtml(flag)}</div>`;
  h += `<div style="border:1px solid #e2e2e2;border-top:none;border-radius:0 0 10px 10px;padding:16px">`;
  h += `<p>A teen using the Money & Momentum Map just triggered a <b>${escHtml(flag)}</b> safety flag.</p>`;
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
  h += `<p style="color:#444;font-size:14px;margin-top:0">Follow the OTS Money & Momentum Map Safety SOP. OTS's role is to connect the teen to real help, not to counsel. Never forward this to the parent.</p>`;
  h += `<p style="font-size:12px;color:#999;border-top:1px solid #eee;padding-top:10px;margin-top:16px">Outsmart the System — Money & Momentum Map safety routing</p>`;
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
  const subject = `[Money & Momentum Map archive] ${session.teen_first_name} (${session.teen_age}) — ${kind}`;
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

// ─── CLIENT EVENT (funnel analytics) ───────────────────────────────────────
// Cookie-gated relay for client-only funnel events (PDF saved, share opened).
// Whitelisted names only; forwarded to GA4 server-side. No-op if GA4 is unset.
app.post('/api/event', async (req, res) => {
  const s = await currentSession(req);
  if (!s) return res.status(401).json({ error: 'no active session' });
  const name = String((req.body && req.body.name) || '');
  if (!EVENT_WHITELIST.has(name)) return res.status(400).json({ error: 'unknown event' });
  ga4Event('sess.' + s.id, name, {});
  res.json({ ok: true });
});

// ─── ANTHROPIC CHAT (removed) ──────────────────────────────────────────────
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
    durable_db: db.backend() === 'postgres' && db.ready()   // configured AND actually initialized
  };
  const missing = Object.keys(configured).filter(k => !configured[k]);
  // archive_recording is OPTIONAL (test-phase only) — reported, but never gates ready.
  res.json({ ok: true, service: 'ots-teen-agent', ready: missing.length === 0, db: db.backend(), archive_recording: archiveEnabled(), configured, missing });
});

// Serve ONLY the public asset directory (whitelist, not a blacklist). Backend
// source, prompts, secrets, and node_modules live OUTSIDE public/, so they can
// never be requested over HTTP — the server reads prompts.js from disk directly.
app.use(express.static(path.join(__dirname, 'public')));

// ─── START SERVER ──────────────────────────────────────────────────────────
// Only when run directly (node server.js). When require()'d by the test suite,
// nothing listens and no DB init runs — the exported pure helpers are testable.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  db.init()
    .then(() => console.log('session store ready:', db.backend()))
    .catch(e => console.error('[DB_INIT_FAILED] data store unreachable — API will FAIL CLOSED (503) until it recovers:', e.message))
    .finally(() => app.listen(PORT, () => console.log(`ots-teen-agent running on port ${PORT} (db: ${db.backend()}, ready: ${db.ready()})`)));
  // Purge expired session rows daily (getSession already treats them as gone; this
  // reclaims storage). Unref'd so it never keeps the process alive on its own.
  const sweepExpired = () => db.deleteExpired()
    .then(n => { if (n) console.log('[CLEANUP] purged ' + n + ' expired session(s)'); })
    .catch(e => console.warn('[CLEANUP] failed:', e.message));
  setInterval(sweepExpired, 24 * 60 * 60 * 1000).unref();
}

module.exports = {
  app,
  buildApprovedItems, buildParentEmail,
  formatTranscript, stripUnverifiedQuotes, validateScoring, validScore,
  parseScoringJSON, phaseFor, interviewQuestionNum
};
