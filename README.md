# OTS Teen Agent

The **Outsmart the System Money & Motivation Map** — a ~15–20 minute AI-guided self-discovery
interview that shows a teen where they are on five money dimensions, names the gap
between where they are and where they want to be, and produces two outputs: a warm
result for the **teen** and a separate, **teen-approved** report for the **parent**.

Architecturally it forks the `ots-deep-work` skeleton (Express on Render, rate limiting,
static-file security) but diverges sharply: the interview, scoring, and safety all run
**server-side**. A **four-prompt** flow — A (interview) → B (scoring), plus an optional
C (money-decision scenarios) → D (scenario scoring) — runs entirely on the server (the
browser sends only the teen's answer), behind opaque server-side sessions (Postgres)
with HttpOnly-cookie auth. Plus four safety sentinels, a preview/veto gate before
anything reaches the parent, server-side safety routing (direct email alerts), and the
teen agent's **own** Make webhook.

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

The safety backend (server-side sentinel detection + direct email alerts to a
responder) **is built and live-verified**. The remaining launch gate is the
`[NEEDS COUNSEL]` policy in `docs/SAFETY-SOP.md`, plus the audit's P0 rearchitecture
(opaque server-side sessions). See **Roadmap** below.

Prompts are the single source of truth in `prompts/*.md`; `node build-prompts.js`
regenerates `prompts.js`, which the **server** loads. Phase 4: the prompts are no
longer sent to the browser, and `/prompts.js` + `/prompts/` are not served over HTTP.

## Run locally

```bash
npm install
cp .env.example .env        # then fill in the values
npm run dev                 # node --env-file=.env (Node >= 20.6); http://localhost:3000
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

## Session architecture (opaque server-side sessions)

The parent registers; the server creates an **opaque** session row (Postgres) and
returns a one-use link `/?s=<random-id>`. The teen opens it; the server exchanges the
id for an **HttpOnly** cookie and strips the id from the address bar. That cookie — not
any client-held token — authenticates every request. The interview transcript and the
scored draft live in the session row **server-side**; the browser holds nothing durable.

| Endpoint | Who | Purpose |
|---|---|---|
| `POST /api/register` | parent | validate → create session → return `{ teen_url }` (opaque `?s=` link) |
| `POST /api/session/start` | teen (first open) | exchange the `?s=` id for the HttpOnly cookie → teen-safe fields |
| `GET /api/session` | teen (reload) | re-establish teen-safe fields from the cookie |
| `POST /api/interview/turn` | teen | one interview turn — sends only `{ answer }`; server owns Prompt A + the transcript + the per-turn anchor |
| `POST /api/skills/turn` | teen | one money-decision-scenario turn (Prompt C) |
| `GET /api/interview/state` | teen (resume) | the stored transcript, to rebuild the chat on reload |
| `POST /api/score` · `/api/skills-score` | teen | server scores its **own** completed stored transcript (no client transcript) |
| `POST /api/parent-report` | teen (after veto) | build the email from the stored draft + the teen's selections; one-time + atomic |
| `POST /api/session/end` | teen | clear the cookie + purge the transcript ("End & clear this device") |
| `GET /api/health` | ops | liveness + readiness (`ready`, `db`, `durable_db`, `archive_recording`) |

There is **no** `/api/chat` proxy and **no** client-held token — both were removed in
Phase 4. `/api/session` returns only `teen_first_name`, `teen_age`, `teen_age_plus_3`
(pre-computed — the model is unreliable at arithmetic), `parent_first_name`, and status
flags; never `parent_email`.

### Safety/privacy properties

1. **The teen never sees the parent's email** — it lives only in the server row.
2. **The teen can't redirect or forge the report** — destination and content both come
   from the server-side row, never the request body; sending is one-time and atomic.
3. **Prompts and transcript aren't on the device or tamperable** — the server holds
   them, and scoring runs on the server's own stored transcript (a completed interview
   is required; there is no client-transcript path).
4. **Safety disclosures never reach the parent** — CRISIS/ABUSE end the session, purge
   the transcript, and alert a responder with no teen quotes.

## Environment

See `.env.example`. Full var list:

| Var | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | powers the server-side interview + scoring calls |
| `DATABASE_URL` | Postgres (Render Internal URL) for durable opaque sessions; without it the app runs a NON-durable in-memory store (dev only) and `/api/health` reports `ready:false` |
| `TEEN_MAKE_WEBHOOK_URL` | the teen agent's **own** Make webhook for the parent report — do **not** reuse the deep-work / Family Money Story webhook |
| `MAKE_SHARED_SECRET` | sent as `auth` in the parent-report body; the Make scenario filters on it so the webhook isn't an open email relay |
| `EMAIL_USER` / `EMAIL_PASS` | Gmail (app password) the server uses to send safety alerts (and, in the test phase, session archives) |
| `SAFETY_ALERT_TO` | where CRISIS/ABUSE alerts go (defaults to `EMAIL_USER`) |
| `ARCHIVE_EMAIL_TO` | **test phase only**: a full session record (transcript + assessment) is emailed here; clearing it disables recording |
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
   **PDF** download (jsPDF, text-drawn, light-themed keepsake).

The prompts themselves live in `prompts/` once added (Prompt A = interview, Prompt B
= scoring); both are designed and version-locked at build v4.

## Provenance

Forked conceptually from `outsmartthesystem/ots-deep-work`. The teen flow is **not**
a drop-in port — it adds a second model call, a consent/veto gate, and a safety layer
the parent interview never needed.
