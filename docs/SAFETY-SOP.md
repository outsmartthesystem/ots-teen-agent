# OTS Teen Check — Safety SOP (DRAFT, pending professional review)

> **This is an operational draft, not legal advice.** The items marked
> **[NEEDS COUNSEL]** must be reviewed by a lawyer and/or a licensed child-safety
> professional before public launch. The in-conversation safety behavior is
> interim-safe and live today; this document is the *human* side of the response.

## What the system does automatically

When the interview model detects distress, it emits one of three sentinels. The
app responds **in the conversation** without any human in the loop:

| Flag | In-conversation behavior (already live) | Responder email |
|------|------------------------------------------|-----------------|
| `CRISIS` | Stops the interview, shows 988/911, blocks any parent report | **Yes — immediate** |
| `ABUSE` | Acknowledges, points to help, blocks any parent report, never repeats the disclosure to the parent | **Yes — immediate, "do not contact parent"** |
| `SUPPORT` / `DISTRESS` | Surfaces resources, may continue if the teen chooses | No (recorded only) |

The responder alert is an **email to the designated responder** (currently
jay@outsmartthesystem.org). By policy it contains **no quotes from the teen** —
only the flag, the teen's first name, age, and the session id. The teen's
disclosure is **never stored** server-side and **never** forwarded to the parent.

## The core stance

OTS is **not** a crisis service. The agent is explicitly instructed not to counsel.
The responder's job is **to connect and to check — not to intervene clinically.**
Do not attempt to talk a teen through a crisis. Do not promise confidentiality.

## Responder procedure

### On a `CRISIS` alert
1. **Acknowledge the alert** (note the time you saw it).
2. The teen has already been shown 988/911 in the app. You do **not** contact the
   teen directly to counsel them. **[NEEDS COUNSEL]** — decide whether/how OTS may
   reach the teen at all, and through what contact info, given they are a minor.
3. **The parent:** for a CRISIS (self-harm) flag — *not* abuse — looping in the
   parent is usually appropriate, **but** the teen was promised they see their
   result first. **[NEEDS COUNSEL / POLICY]** — define when and how OTS contacts
   the parent after a CRISIS, what is said, and what is *not* said (never the
   teen's words).
4. **Record** that the alert was received and what action was taken (the alert
   email in the responder inbox is the durable record; add your follow-up notes).

### On an `ABUSE` alert
1. **Do NOT contact the parent.** The person who set this up may be the source of
   harm. The alert email is stamped accordingly.
2. **[NEEDS COUNSEL — highest priority]** — Mandatory-reporting obligations. In
   many U.S. states, certain people and organizations are *mandated reporters* of
   suspected child abuse. Determine: (a) whether OTS / its staff are mandated
   reporters in the relevant state(s), (b) the legally required reporting pathway
   (e.g., a state child-protection hotline), and (c) the timeline. This must be
   settled **before** any teen can disclose abuse to this product publicly.
3. Until that is settled, the safe posture is: the in-app referral (988 can help a
   teen think through next steps; 911 for immediate danger) is the teen's primary
   resource, and OTS does not act on the parent in any way.

### On a `SUPPORT` / `DISTRESS` event
- No email is sent (to prevent alert fatigue that would bury a real CRISIS). The
  event is recorded in the server log. Review periodically if desired. If a pattern
  of `SUPPORT` events on one session suggests escalation, treat as CRISIS.

## Data handling
- The responder alert carries **no teen quotes** — flag, first name, age, sid only.
- The teen's disclosure is **not** persisted server-side.
- Nothing about a safety event is ever included in the parent report, and the
  parent report is hard-blocked for any session that flagged CRISIS or ABUSE.

## Open decisions for review (collect answers, then update this SOP)
1. **[NEEDS COUNSEL]** Are OTS / its staff mandated reporters? In which states?
   What is the required reporting pathway and timeline for `ABUSE`?
2. **[NEEDS COUNSEL / POLICY]** Post-`CRISIS` parent-contact rule: when, how,
   what's said, who makes the call.
3. **[POLICY]** Who is the responder (and a backup) once this is beyond Jay alone?
   What is the expected response time, and what happens outside business hours?
4. **[POLICY]** Region scope. This SOP and the 988/911 resources assume **U.S.
   only**. If non-U.S. teens can access the tool, add region-aware resources and
   reporting pathways.
5. **[POLICY]** Retention: how long are alert emails / server logs kept, and who
   can see them?

## Status
- ✅ In-conversation response (988/911, halt, block parent report) — live & validated
- ✅ Responder alert routing (server detect → email, no disclosure, never to parent) — built
- ⏳ Scenario activation + `SAFETY_WEBHOOK_URL` set in Render — pending
- ⛔ The **[NEEDS COUNSEL]** items above — **required before public launch**
