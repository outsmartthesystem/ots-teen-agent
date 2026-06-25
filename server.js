const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
const nodemailer = require('nodemailer');
const db = require('./db');   // durable server-side session/report store

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
  const approved = req.body && req.body.approved_report;
  if (!approved || typeof approved !== 'object') return res.status(400).json({ error: 'approved_report required' });

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

app.post('/api/chat', async (req, res) => {
  // Cookie-gate FIRST: only a real, unblocked session can use the proxy, and an
  // unauthenticated caller learns nothing about config. (Closes most of the
  // open-AI-proxy hole; the prompt is still client-supplied until Phase 4.)
  const session = await currentSession(req);
  if (!session) return res.status(401).json({ error: 'no active session' });
  if (session.safety_blocked) return res.status(403).json({ error: 'session closed' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured: ANTHROPIC_API_KEY missing' });
  }
  try {
    const body = {
      model: ALLOWED_MODELS.has(req.body.model) ? req.body.model : 'claude-sonnet-4-6',
      max_tokens: Math.min(Number(req.body.max_tokens) || 1200, 8000),
      system: req.body.system,
      messages: req.body.messages
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    console.log('Model:', body.model, '| Status:', response.status);
    if (!response.ok) return res.status(response.status).json(data);

    // Server-side safety detection (tamper-resistant), attributed to the cookie
    // session. Persist the durable block + alert; don't delay the teen's turn.
    try {
      const text = (data.content && data.content[0] && data.content[0].text) || '';
      const m = text.match(/\[SAFETY_EVENT:(CRISIS|ABUSE|SUPPORT)\]/);
      if (m) {
        if (SAFETY_BLOCK_FLAGS.has(m[1])) db.updateSession(session.id, { safety_blocked: true, safety_flag: m[1] }).catch(() => {});
        fireSafetyAlert(m[1], { sid: session.id, teen_first_name: session.teen_first_name, teen_age: session.teen_age });
      }
    } catch (e) { console.error('safety scan error:', e.message); }

    res.json(data);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
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
  res.json({ ok: true, service: 'ots-teen-agent', ready: missing.length === 0, db: db.backend(), configured, missing });
});

app.use(express.static(path.join(__dirname)));

// ─── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
db.init()
  .then(() => console.log('session store ready:', db.backend()))
  .catch(e => console.error('db.init error (continuing):', e.message))
  .finally(() => app.listen(PORT, () => console.log(`ots-teen-agent running on port ${PORT} (db: ${db.backend()})`)));
