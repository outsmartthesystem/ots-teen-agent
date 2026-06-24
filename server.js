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
app.post('/api/parent-report', async (req, res) => {
  const payload = verifyToken(req.body && req.body.t);
  if (!payload) return res.status(401).json({ error: 'invalid or expired token' });
  const webhook = process.env.TEEN_MAKE_WEBHOOK_URL;
  if (!webhook) return res.status(500).json({ error: 'Server not configured: TEEN_MAKE_WEBHOOK_URL missing' });
  const approved = req.body && req.body.approved_report;
  if (!approved || typeof approved !== 'object') return res.status(400).json({ error: 'approved_report required' });

  const out = {
    sid: payload.sid,
    parent_email: payload.parent_email,       // from the signed token only
    parent_first_name: payload.parent_first_name,
    teen_first_name: payload.teen_first_name,
    teen_age: payload.teen_age,
    approved_report: approved,
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
