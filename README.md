# OTS Teen Agent

The **Outsmart the System Teen Check** — a ~15–20 minute AI-guided self-discovery
interview that shows a teen where they are on five money dimensions, names the gap
between where they are and where they want to be, and produces two outputs: a warm
result for the **teen** and a separate, **teen-approved** report for the **parent**.

Architecturally it forks the `ots-deep-work` skeleton (Express on Render, `/api/chat`
Anthropic proxy, rate limiting, static-file security) but diverges in the model layer:
a **two-prompt** flow (interview → scoring), four safety sentinels, a preview/veto
gate before anything reaches the parent, and the teen agent's **own** Make webhook.

## Status

**Foundation + session-token contract — done.** Deployable baseline: the server,
the parent→teen handoff, the security/rate-limit plumbing, and the endpoint
contracts the rest of the app fills in.

**chat.js interview engine — done.** Runs Prompt A turn-by-turn, catches all four
sentinels (`[INTERVIEW_COMPLETE]` + the three `[SAFETY_EVENT:*]`), and on completion
hands the transcript to Prompt B for scoring. Verified end-to-end in a browser
against a mock model: boot/placeholder substitution, the turn loop, native click +
Enter, completion → scoring → fence-tolerant JSON parse → result, and the **CRISIS**
path (halt + resources + suppressed scoring + blocked parent report).

**Teen result UI — done.** `renderResult` builds the warm teen-facing result from
the Prompt B output: stage badge (+ partial-evidence note), the goal mirror, the
five-bar chart (null dimensions render as "not enough info yet"), strength + verbatim
quote, the biggest unlock, the seven-day move, an optional high-scorer pathway, and
the two-way choice. All model text goes in via `textContent`. Verified in-browser
with a full scoring payload (including a null bar + partial note).

**Preview/veto gate — done.** From the result, the teen reviews each
`shareable_item` with share / keep-private + inline edit; the fixed framing,
confidence summary, and program fit are shown read-only. On approval the report is
**frozen** (no Prompt B re-call) and only the approved + edited items POST to
`/api/parent-report`; the parent is never told what was withheld. A "Don't send
anything" path is included. Verified end-to-end against the mock: a vetoed item is
excluded, an edited item carries its new text, and the framing always rides along.

**Registration page — done.** `register.html` is the parent-facing entry: it sets
expectations about the consent model up front (the teen sees their result first and
curates what's shared), validates the fields, calls `/api/register`, and hands back
the teen's link with copy-to-clipboard. Verified end-to-end: register → real signed
token → opening the link boots the interview as the right teen.

**Parent-report delivery — done.** `/api/parent-report` pre-renders the parent email
(subject + HTML) from the frozen approved items, so Make just delivers it. The teen
agent's **own** Make scenario ("OTS Teen Agent — Parent Report", a webhook → Gmail
flow separate from the parent Family Money Story scenario) is live. Verified end-to-
end: a real approved report rendered an email and arrived in the parent inbox. The
webhook URL is server-side only (the browser never sees it) — set it as
`TEEN_MAKE_WEBHOOK_URL` in Render.

Not yet built: the safety backend. See **Roadmap** below.

Prompts are the single source of truth in `prompts/*.md`; `node build-prompts.js`
regenerates `prompts.js` (the runtime copy the frontend loads).

## Run locally

```bash
npm install
cp .env.example .env        # then fill in the values
npm start                   # http://localhost:3000
```

Open `/register.html`, fill in the parent + teen fields, and you get the teen's
link; opening it boots the interview at `/`. That's the full entry round trip.
`/api/health` reports which env vars are configured.

> **Drive note:** this repo lives in a Google-Drive-synced folder. `npm install`
> writes ~70 packages as thousands of tiny files, which the Drive sync layer makes
> painfully slow (minutes, and it locks `node_modules` mid-sync). `node_modules` is
> gitignored and Render installs its own deps on deploy, so for local dev either
> copy the app to an off-Drive folder first, or accept one slow install. Don't try
> to commit or delete `node_modules` while Drive is mid-sync.

## The session-token contract (locked)

The parent registers; the server mints a **stateless, HMAC-signed** token that
encodes the registration. The teen opens `/?t=<token>`. No database — the token is
the session.

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/register` | parent (registration page) | validate input → return `{ token, teen_url }` |
| `GET /api/session?t=` | teen (interview page) | verify → return teen-safe fields for Prompt A |
| `POST /api/chat` | both | Anthropic proxy for Prompt A turns **and** the Prompt B scoring call |
| `POST /api/parent-report` | teen (after veto) | verify → forward approved report to the teen Make webhook |
| `GET /api/health` | ops | liveness + which env vars are set |

**Signed payload:** `{ v, sid, teen_first_name, teen_age, parent_first_name, parent_email, iat, exp }`
(30-day TTL). **Token:** `base64url(payload) + "." + base64url(HMAC-SHA256(secret, payload))`.

**`/api/session` returns only** `teen_first_name`, `teen_age`, `teen_age_plus_3`
(pre-computed — the model is unreliable at arithmetic), and `parent_first_name`.

### Safety/privacy properties baked into the contract

1. **The teen never sees the parent's email.** `/api/session` omits `parent_email`.
2. **The teen can't redirect the report.** `/api/parent-report` reads `parent_email`
   from the *verified token*, never from the request body.
3. **Age can't be spoofed.** `teen_age` is signed, so scoring's age-banding is trustworthy.

## Environment

See `.env.example`. Full var list:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | powers `/api/chat` (interview + scoring) |
| `TOKEN_SIGNING_SECRET` | signs/verifies session tokens |
| `TEEN_MAKE_WEBHOOK_URL` | the teen agent's **own** Make webhook for the parent report — do **not** reuse the deep-work / Family Money Story webhook |
| `MAKE_SHARED_SECRET` | sent as `auth` in the parent-report body; the Make scenario filters on it so the webhook isn't an open email relay |
| `EMAIL_USER` / `EMAIL_PASS` | Gmail (app password) the server uses to send safety alerts |
| `SAFETY_ALERT_TO` | where CRISIS/ABUSE alerts go (defaults to `EMAIL_USER`) |
| `PUBLIC_BASE_URL` | optional; base for the teen link (else derived from request host) |

## Deploy (Render)

`render.yaml` defines the Node web service with `/api/health` as the health check.
Set the env vars in the Render dashboard (they're `sync: false`, i.e. not stored in
the repo).

**Live at https://ots-teen-agent.onrender.com** (starter plan — no idle spin-down).
The full pipeline is production-verified end to end: register → interview → scored
result → preview/veto → teen-approved parent email. The model layer is live-validated
(a real interview scored sensibly across all five dimensions; the CRISIS **and** ABUSE
paths fire correctly and email a responder alert with no teen quotes). The
parent-report webhook is secret-gated (forged direct POSTs are filtered out), and
`/api/health` is excluded from rate limiting so Render's probe can't flap the instance.

## Roadmap

1. ✅ Foundation + session-token contract
2. ✅ chat.js port — Prompt A turn loop, all four sentinels, session save/resume,
   completion → Prompt B scoring call → JSON parse (result render stubbed)
3. ✅ Teen result UI — stage badge, 5-bar chart (null-safe), and
   mirror/strength/unlock/seven-day-move/choice prose from the Prompt B output
4. ✅ Preview/veto gate → freeze approved + edited items → `POST /api/parent-report`
5. ✅ Registration page (`register.html`) — parent-facing entry; replaces the old
   dev harness
6. ✅ Make parent-report scenario — webhook → Gmail, live and verified (separate
   from the parent Family Money Story scenario)
7. ✅ **Safety backend** — server-side sentinel detection in `/api/chat`
   (tamper-resistant) + `/api/safety-event`, deduped through `fireSafetyAlert`.
   CRISIS/ABUSE are **emailed directly** (nodemailer + Gmail app password — not via
   Make, so the critical path has no no-code dependency); the alert never goes to
   the parent, ABUSE carries a do-not-contact banner, no teen quotes are included,
   SUPPORT/DISTRESS are logged only. Live-verified (both flags emailed cleanly).
   SOP in `docs/SAFETY-SOP.md`. **Before public launch:** the **[NEEDS COUNSEL]**
   items (mandatory-reporting, post-CRISIS parent contact).
8. ✅ Hardening — `/api/health` excluded from rate limiting (fixes the Render
   health-check 429 flap); parent-report webhook secret-gated via `MAKE_SHARED_SECRET`
   + a Make-side filter (forged direct POSTs are dropped). Both live-verified.
9. ✅ Custom domain **https://teen.outsmartthesystem.org** (CNAME → Render, TLS
   issued); bare root redirects to `/register.html`. Plus a one-click teen-result
   **PDF** download (html2pdf, light-themed keepsake).

The prompts themselves live in `prompts/` once added (Prompt A = interview, Prompt B
= scoring); both are designed and version-locked at build v4.

## Provenance

Forked conceptually from `outsmartthesystem/ots-deep-work`. The teen flow is **not**
a drop-in port — it adds a second model call, a consent/veto gate, and a safety layer
the parent interview never needed.
