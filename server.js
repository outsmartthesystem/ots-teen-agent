const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');
const nodemailer = require('nodemailer');

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

// ─── REGISTER (parent) ─────────────────────────────────────────────────────
// The future registration page POSTs here. Returns the token + the teen's link.
app.post('/api/register', (req, res) => {
  if (!process.env.TOKEN_SIGNING_SECRET) {
    return res.status(500).json({ error: 'Server not configured: TOKEN_SIGNING_SECRET missing' });
  }
  const { teen_first_name, teen_age, parent_first_name, parent_email } = req.body || {};
  const tName = String(teen_first_name || '').trim();
  const pName = String(parent_first_name || '').trim();
  const pEmail = String(parent_email || '').trim();
  const age = Number(teen_age);

  if (tName.length < 1 || tName.length > 40) return res.status(400).json({ error: 'teen_first_name required (1–40 chars)' });
  if (pName.length < 1 || pName.length > 40) return res.status(400).json({ error: 'parent_first_name required (1–40 chars)' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(pEmail)) return res.status(400).json({ error: 'valid parent_email required' });
  if (!Number.isInteger(age) || age < 13 || age > 25) return res.status(400).json({ error: 'age must be an integer 13–25' });

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    sid: crypto.randomUUID(),
    teen_first_name: tName,
    teen_age: age,
    parent_first_name: pName,
    parent_email: pEmail,
    iat: now,
    exp: now + TOKEN_TTL_SECONDS
  };
  const token = signToken(payload);
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  res.json({ token, teen_url: `${base}/?t=${encodeURIComponent(token)}`, sid: payload.sid, expires_at: payload.exp });
});

// ─── SESSION (teen) ────────────────────────────────────────────────────────
// The teen page reads ?t=<token>, calls this, and injects the result into the
// Prompt A placeholders. parent_email is deliberately NOT returned.
app.get('/api/session', (req, res) => {
  const payload = verifyToken(req.query.t);
  if (!payload) return res.status(401).json({ error: 'invalid or expired token' });
  res.json({
    teen_first_name: payload.teen_first_name,
    teen_age: payload.teen_age,
    teen_age_plus_3: payload.teen_age + 3, // pre-computed: the model is unreliable at arithmetic
    parent_first_name: payload.parent_first_name
  });
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
  money_judgment: 'Money judgment',
  growth_horizon: 'Where they are, and where they could be',
  confidence: 'How solid this read is',
  program_fit: 'How OTS could help'
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
  if (Array.isArray(ff.what_not_to_do) && ff.what_not_to_do.length) {
    t += 'A few things to keep in mind:\n';
    ff.what_not_to_do.forEach(x => t += '- ' + x + '\n');
    t += '\n';
  }
  t += 'Outsmart the System — outsmartthesystem.org\nApproved by ' + teenName + ' before sending.';

  return { subject: `${teenName}'s Teen Check — what they chose to share`, html, text: t };
}

app.post('/api/parent-report', async (req, res) => {
  const payload = verifyToken(req.body && req.body.t);
  if (!payload) return res.status(401).json({ error: 'invalid or expired token' });
  // Server-enforced safety block: if this session ever flagged CRISIS/ABUSE, no
  // report goes out — even if a modified browser or second device asks. (The
  // 200 shape mirrors success so a probing client learns nothing.)
  if (payload.sid && safetyBlockedSids.has(payload.sid)) {
    console.warn('[PARENT_REPORT_BLOCKED] safety-flagged sid=' + payload.sid);
    return res.json({ success: true });
  }
  const webhook = process.env.TEEN_MAKE_WEBHOOK_URL;
  if (!webhook) return res.status(500).json({ error: 'Server not configured: TEEN_MAKE_WEBHOOK_URL missing' });
  const approved = req.body && req.body.approved_report;
  if (!approved || typeof approved !== 'object') return res.status(400).json({ error: 'approved_report required' });

  const email = buildParentEmail(approved, payload.teen_first_name, payload.parent_first_name);
  const out = {
    // Shared secret the Make scenario filters on, so the webhook can't be used
    // as an open email relay by anyone who learns the URL. Set MAKE_SHARED_SECRET
    // in Render to the same value the Make filter checks.
    auth: process.env.MAKE_SHARED_SECRET || '',
    sid: payload.sid,
    parent_email: payload.parent_email,       // from the signed token only
    parent_first_name: payload.parent_first_name,
    teen_first_name: payload.teen_first_name,
    teen_age: payload.teen_age,
    email_subject: email.subject,             // pre-rendered so Make just delivers
    email_html: email.html,
    email_text: email.text,
    approved_report: approved,                // structured copy too, for logging
    sent_at: new Date().toISOString()
  };
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(out)
    });
    if (!r.ok) {
      console.error('Parent-report webhook non-OK:', r.status);
      return res.status(502).json({ error: 'webhook rejected', status: r.status });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Parent-report webhook error:', err.message);
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
const alertedEvents = new Set();   // dedup keys: `${sid}:${flag}`
const safetyBlockedSids = new Set(); // sids that hit CRISIS/ABUSE — parent report refused server-side
// NOTE: in-memory only. Survives the process, not a restart or a second instance.
// The durable fix is server-side session state (see the audit's P0 rearchitecture).

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

  // Server-side block: once a session hits CRISIS/ABUSE, refuse any parent
  // report for it regardless of what a (possibly modified) client claims.
  if (SAFETY_BLOCK_FLAGS.has(flag) && info.sid) safetyBlockedSids.add(info.sid);

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

// Client-reported safety event (token-gated). Acks regardless so the client
// never learns whether/how an alert was routed.
app.post('/api/safety-event', (req, res) => {
  const payload = verifyToken(req.body && req.body.t);
  if (!payload) return res.status(401).json({ error: 'invalid or expired token' });
  const flag = String(req.body && req.body.flag || '').toUpperCase();
  if (!SAFETY_FLAGS.has(flag)) return res.status(400).json({ error: 'invalid flag' });
  fireSafetyAlert(flag, { sid: payload.sid, teen_first_name: payload.teen_first_name, teen_age: payload.teen_age });
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
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server not configured: ANTHROPIC_API_KEY missing' });
  }
  try {
    // Forward ONLY the Anthropic fields — never pass `t` or other extras upstream.
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

    // Server-side safety detection (tamper-resistant). Attribute via the signed
    // token. Fire-and-forget so the teen's turn isn't delayed.
    try {
      const text = (data.content && data.content[0] && data.content[0].text) || '';
      const m = text.match(/\[SAFETY_EVENT:(CRISIS|ABUSE|SUPPORT)\]/);
      if (m) {
        const p = verifyToken(req.body && req.body.t);
        if (p) fireSafetyAlert(m[1], { sid: p.sid, teen_first_name: p.teen_first_name, teen_age: p.teen_age });
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
    token_secret: !!process.env.TOKEN_SIGNING_SECRET,
    teen_webhook: !!process.env.TEEN_MAKE_WEBHOOK_URL,
    make_secret: !!process.env.MAKE_SHARED_SECRET,
    safety_email: !!safetyMailer
  };
  const missing = Object.keys(configured).filter(k => !configured[k]);
  res.json({ ok: true, service: 'ots-teen-agent', ready: missing.length === 0, configured, missing });
});

app.use(express.static(path.join(__dirname)));

// ─── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ots-teen-agent running on port ${PORT}`));
