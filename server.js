const express = require('express');
const fetch = require('node-fetch');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.set('trust proxy', 1); // Render terminates TLS at a proxy; needed for real client IPs.
app.use(express.json({ limit: '10mb' }));

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
  const MAX_REQUESTS = 30;
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
  if (!Number.isInteger(age) || age < 13 || age > 18) return res.status(400).json({ error: 'teen_age must be an integer 13–18' });

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
  environmental: 'Context worth knowing'
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
  if (report.confidence_summary) h += `<p style="color:#444;margin:18px 0">${escHtml(report.confidence_summary)}</p>`;
  if (Array.isArray(ff.what_not_to_do) && ff.what_not_to_do.length) {
    h += `<p style="font-weight:600;margin:18px 0 6px">A few things to keep in mind:</p><ul style="color:#444;margin:0;padding-left:20px">`;
    ff.what_not_to_do.forEach(x => h += `<li style="margin-bottom:4px">${escHtml(x)}</li>`);
    h += `</ul>`;
  }
  if (pf.text) {
    h += `<div style="margin:20px 0;padding:13px 16px;background:#f0fbf5;border:1px solid #cdeede;border-radius:10px">`;
    h += `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#3a9b6e;margin-bottom:5px">If it&rsquo;s useful</div>`;
    h += `<div style="color:#333">${escHtml(pf.text)}</div></div>`;
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
  if (report.confidence_summary) t += report.confidence_summary + '\n\n';
  if (Array.isArray(ff.what_not_to_do) && ff.what_not_to_do.length) {
    t += 'A few things to keep in mind:\n';
    ff.what_not_to_do.forEach(x => t += '- ' + x + '\n');
    t += '\n';
  }
  if (pf.text) t += pf.text + '\n\n';
  t += 'Outsmart the System — outsmartthesystem.org\nApproved by ' + teenName + ' before sending.';

  return { subject: `${teenName}'s Teen Check — what they chose to share`, html, text: t };
}

app.post('/api/parent-report', async (req, res) => {
  const payload = verifyToken(req.body && req.body.t);
  if (!payload) return res.status(401).json({ error: 'invalid or expired token' });
  const webhook = process.env.TEEN_MAKE_WEBHOOK_URL;
  if (!webhook) return res.status(500).json({ error: 'Server not configured: TEEN_MAKE_WEBHOOK_URL missing' });
  const approved = req.body && req.body.approved_report;
  if (!approved || typeof approved !== 'object') return res.status(400).json({ error: 'approved_report required' });

  const email = buildParentEmail(approved, payload.teen_first_name, payload.parent_first_name);
  const out = {
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

// ─── ANTHROPIC CHAT (Prompt A turns AND the Prompt B scoring call) ─────────
// Model-agnostic proxy. The frontend supplies system/messages/max_tokens and a
// whitelisted model. One endpoint serves both the interview and the scoring
// call — they differ only by system prompt and token budget.
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
    const body = { ...req.body };
    body.model = ALLOWED_MODELS.has(body.model) ? body.model : 'claude-sonnet-4-6';
    body.max_tokens = Math.min(Number(body.max_tokens) || 1200, 8000);

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
    res.json(data);
  } catch (err) {
    console.error('Chat error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── HEALTH ────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'ots-teen-agent',
    configured: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      token_secret: !!process.env.TOKEN_SIGNING_SECRET,
      teen_webhook: !!process.env.TEEN_MAKE_WEBHOOK_URL
    }
  });
});

app.use(express.static(path.join(__dirname)));

// ─── START SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ots-teen-agent running on port ${PORT}`));
