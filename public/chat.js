// ============================================================================
// OTS Teen Agent — interview engine (chat.js port, step 2)
// ============================================================================
// Runs Prompt A turn-by-turn, catches the four sentinels, and on
// [INTERVIEW_COMPLETE] hands the transcript to Prompt B for scoring.
//
// Ported from ots-deep-work's proven patterns (retry/backoff, session
// save/resume, sentinel stripping, safe text rendering, progress anchoring),
// but rebuilt for the teen two-prompt + safety architecture rather than the
// parent single-prompt blueprint flow.
//
// Prompt A and Prompt B come from prompts.js (window.PROMPT_A / PROMPT_B),
// generated from prompts/*.md by build-prompts.js.
// ============================================================================

'use strict';

// ─── CONFIG ──────────────────────────────────────────────────────────────
const MODEL_INTERVIEW = 'claude-sonnet-4-6';
const MODEL_SCORING   = 'claude-opus-4-8';      // scoring is one careful call; use the stronger model
const COMPLETE_SENTINEL = '[INTERVIEW_COMPLETE]';
const SKILLS_SENTINEL = '[SKILLS_COMPLETE]';      // ends the optional scenario check
const SAFETY_SENTINEL_RE = /\[SAFETY_EVENT:(CRISIS|ABUSE|EXPLOITATION|THREAT|SUPPORT)\]/;
// Serious flags halt the interview, block the parent report, and are never persisted
// or resumed on the device. SUPPORT/DISTRESS are not serious (interview continues).
const SERIOUS_SAFETY = ['CRISIS', 'ABUSE', 'EXPLOITATION', 'THREAT'];
const TOTAL_QUESTIONS = 22;      // v5: 22 interview turns (server-side count is authoritative)
const SESSION_KEY = 'ots_teen_session_v1';
const SESSION_MAX_AGE_HOURS = 24;
const SEED_MARKER = '__SEED_BEGIN__';           // hidden first user turn that triggers the opening frame

// ─── STATE ───────────────────────────────────────────────────────────────
const conversationHistory = []; // interview turns [{ role, content }]
const skillsHistory = [];       // optional scenario-check turns [{ role, content }]
window.mode = 'interview';      // 'interview' | 'skills' — which loop is running
window.session = null;          // teen-safe fields from /api/session(/start); auth is the cookie
window.safetyEvent = null;      // null | 'CRISIS' | 'ABUSE' | 'EXPLOITATION' | 'THREAT' | 'SUPPORT'
window.halted = false;          // hard stop (CRISIS): no more turns, no scoring
window.blockParentReport = false; // CRISIS or ABUSE: this session never produces a parent report
window.interviewComplete = false;
window.skillsComplete = false;
window.scoringResult = null;
window.moneyJudgment = null;    // money_judgment from Prompt D, once the skills check runs
window.decisionLabStatus = null; // 'pending' | 'completed' | 'skipped' — persisted server-side
window.supportRequest = '';     // the teen's Family Handshake support line

function activeHistory() { return window.mode === 'skills' ? skillsHistory : conversationHistory; }

// ─── BOOT ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const params = new URLSearchParams(location.search);
  const inviteToken = params.get('i');       // new one-time invite token
  const legacyId = params.get('s');           // legacy session-id link (pre-hardening)
  const linkId = inviteToken || legacyId;
  let session;
  try {
    if (linkId) {
      // First open: atomically CLAIM the one-time invite and get an HttpOnly cookie
      // (the session id — which the new link never contained).
      const r = await fetch('/api/session/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(inviteToken ? { i: inviteToken } : { s: legacyId })
      });
      const j = await r.json();
      if (!r.ok) {
        return showError(r.status === 410
          ? "This private link has already been used. Ask whoever set it up to create a fresh one."
          : (j.error || 'Could not start the session.'));
      }
      session = j;
      // Strip the token from the URL so it isn't left in the address bar / history.
      history.replaceState(null, '', location.pathname);
      // Fresh start — drop any stale transcript left in this tab by another session.
      clearSession();
    } else {
      // Reload (no link in the URL): re-establish from the cookie.
      const r = await fetch('/api/session');
      if (!r.ok) { location.replace('/register.html'); return; }
      session = await r.json();
    }
  } catch (e) {
    return showError("Couldn't reach the server. Check your connection and reload.");
  }
  window.session = session;

  if (session.safety_blocked) {
    return showError("This check is closed. If you’re carrying something heavy, you can call or text <b>988</b> any time — it’s free and people who can help answer.");
  }
  // Recovery: a finished session re-renders its SAVED result so a teen who didn't
  // save or share isn't stuck on a dead-end "already complete" message.
  if (session.report_sent || session.interview_complete) {
    return recoverResult(session);
  }

  if (!linkId) {
    // Resume mid-interview from the SERVER-held transcript (the device no longer
    // stores it). If there are turns, rebuild and continue; otherwise start fresh.
    try {
      const r = await fetch('/api/interview/state');
      if (r.ok) {
        const st = await r.json();
        if (st.turns && st.turns.length) { resumeFromServer(st.turns); if (st.goal) setGoalChip(st.goal); return; }
      }
    } catch (e) { /* fall through to a fresh start */ }
  }
  showOnboarding();
}

// Re-render a finished session's saved result on reload (recovery). If shared,
// it's read-only with a re-save option; if not yet shared, the full result with
// the "Before you go" choices.
async function recoverResult(session) {
  try {
    const r = await fetch('/api/result');
    if (r.ok) {
      const data = await r.json();
      if (data && data.teen_output) {
        window.scoringResult = { teen_output: data.teen_output, level: data.level || {}, parent_report_draft: data.parent_report_draft || {} };
        window.moneyJudgment = data.money_judgment || null;
        window.skillsComplete = !!window.moneyJudgment;
        window.decisionLabStatus = data.decision_lab_status || null;
        window.alreadyShared = !!data.report_sent;
        renderResult(window.scoringResult);
        return;
      }
    }
  } catch (e) { /* fall through */ }
  showError(session.report_sent
    ? "This check is already done — your result was shared the way you chose. Nice work."
    : "This check is already complete.");
}

// 3-card onboarding before the interview (replaces the long opening message).
function showOnboarding() {
  const share = document.getElementById('onboardShare');
  if (share && window.session && window.session.parent_first_name) {
    share.textContent = 'If anything goes to ' + window.session.parent_first_name +
      ', you preview every line and approve it first. Keep anything private — they’re never told what you left out.';
  }
  const btn = document.getElementById('onboardStart');
  if (btn) btn.onclick = showAgeCheck;
  showScreen('onboarding');
}

// Deterministic age confirmation — the interview can't start until this passes
// (server-enforced: /api/interview/turn 409s until teen_age_confirmed_at is set).
// Under-13 (COPPA) and 18+ are routed out server-side and the session is purged.
function showAgeCheck() {
  showScreen('agecheck');
  const valEl = document.getElementById('ageVal');
  if (valEl) valEl.textContent = String(window.session.teen_age);
  const yes = document.getElementById('ageYes');
  const no = document.getElementById('ageNo');
  const correctBox = document.getElementById('ageCorrect');
  const input = document.getElementById('ageInput');
  const save = document.getElementById('ageSave');
  if (yes) yes.onclick = () => confirmAge(window.session.teen_age);
  if (no) no.onclick = () => { if (correctBox) correctBox.style.display = 'block'; if (input) { input.value = ''; input.focus(); } };
  if (save) save.onclick = () => { const v = Number(input.value); if (!Number.isInteger(v)) { input.focus(); return; } confirmAge(v); };
}

async function confirmAge(age) {
  try {
    const r = await fetch('/api/session/confirm-age', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ age: Number(age) })
    });
    const j = await r.json();
    if (j && j.ok) {
      window.session.teen_age = j.teen_age;
      window.session.teen_age_plus_3 = j.teen_age + 3;
      startInterview();
      return;
    }
    // Routed out (under 13 or 18+): the server already purged the session.
    const block = document.getElementById('ageBlock');
    const buttons = document.getElementById('ageButtons');
    const correct = document.getElementById('ageCorrect');
    if (buttons) buttons.style.display = 'none';
    if (correct) correct.style.display = 'none';
    if (block) {
      block.style.display = 'block';
      block.textContent = (j && j.reason === 'under_13')
        ? 'Thanks for being honest. This one’s built for ages 13–17, so we’ll stop here — nothing was saved.'
        : 'Thanks! Since you’re 18 or older, the teen version isn’t the right fit — a Young Adult Map is coming soon. Nothing was saved.';
    }
    window.halted = true;
  } catch (e) {
    const block = document.getElementById('ageBlock');
    if (block) { block.style.display = 'block'; block.textContent = 'Couldn’t confirm just now — check your connection and try again.'; }
  }
}

// Rebuild the chat from the server's stored transcript and let the teen continue.
function resumeFromServer(turns) {
  window.mode = 'interview';
  showScreen('chat');
  setHeading();
  const messages = document.getElementById('messages');
  while (messages.firstChild) messages.removeChild(messages.firstChild);
  conversationHistory.length = 0;
  turns.forEach(t => {
    conversationHistory.push({ role: t.role, content: t.content });
    if (t.role === 'user') addMessage(t.content, 'user');
    else renderAssistantMessage(t.content);
  });
  const asst = turns.filter(t => t.role === 'assistant').length;
  updateProgress({ q: Math.max(0, asst - 1), total: TOTAL_QUESTIONS, phase: '' });
  scrollToBottom();
  reEnableInput();
}

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────
function buildInterviewSystemPrompt() {
  const s = window.session;
  return window.PROMPT_A
    .split('{{TEEN_FIRST_NAME}}').join(s.teen_first_name)
    .split('{{PARENT_FIRST_NAME}}').join(s.parent_first_name)
    .split('{{TEEN_AGE_PLUS_3}}').join(String(s.teen_age_plus_3))
    .split('{{TEEN_AGE}}').join(String(s.teen_age));
}

function buildSkillsSystemPrompt() {
  const s = window.session;
  return window.PROMPT_C
    .split('{{TEEN_FIRST_NAME}}').join(s.teen_first_name)
    .split('{{TEEN_AGE}}').join(String(s.teen_age));
}

// ─── START / RESUME ──────────────────────────────────────────────────────
function startInterview() {
  showScreen('chat');
  setHeading();
  window.mode = 'interview';
  // The server seeds the opening frame on the first (answer-less) turn.
  requestTurn();
}

function showResume(saved) {
  showScreen('resume');
  const btnResume = document.getElementById('resumeBtn');
  const btnFresh = document.getElementById('freshBtn');
  btnResume.onclick = () => {
    conversationHistory.length = 0;
    saved.conversationHistory.forEach(t => conversationHistory.push(t));
    window.safetyEvent = saved.safetyEvent || null;
    window.blockParentReport = !!saved.blockParentReport;
    showScreen('chat');
    setHeading();
    rebuildChat();
  };
  btnFresh.onclick = () => { clearSession(); startInterview(); };
}

function setHeading() {
  const h = document.getElementById('chatHeading');
  if (h) h.textContent = window.session.teen_first_name + "’s Money Map";
}

function rebuildChat() {
  const messages = document.getElementById('messages');
  while (messages.firstChild) messages.removeChild(messages.firstChild);
  conversationHistory.forEach(turn => {
    if (turn.role === 'user') {
      if (turn.content === SEED_MARKER) return;
      addMessage(stripInternalNote(turn.content), 'user');
    } else {
      renderAssistantMessage(turn.content);
    }
  });
  scrollToBottom();
}

// ─── SENDING A USER TURN ─────────────────────────────────────────────────
function sendMessage() {
  if (window.halted) return;
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  const text = input.value.trim();
  if (!text || sendBtn.disabled) return;

  clearChips();
  addMessage(text, 'user');
  input.value = '';
  autoResize(input);
  activeHistory().push({ role: 'user', content: text });
  requestTurn(text);
}

// ─── CORE TURN: ask the server for the next message (Phase 4) ────────────
// The browser sends only { answer } (or {} to open). The server holds the
// prompt + transcript, injects the anchor, detects sentinels, and persists the
// turn. We just render what comes back.
async function requestTurn(answer) {
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;

  const thinking = addThinking();
  const skills = window.mode === 'skills';
  const endpoint = skills ? '/api/skills/turn' : '/api/interview/turn';

  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(answer ? { answer } : {})
    });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    thinking.remove();

    if (r.status === 401) return showError("This check isn’t active anymore. Ask for a fresh link.");
    if (r.status === 403) { window.halted = true; return showError("This check is closed."); }
    if (!r.ok && !data.message && !data.safety && !data.complete) {
      addMessage('Hit a small snag. Tap send again and we’ll pick right back up.', 'system');
      reEnableInput();
      return;
    }

    if (data.message) {
      (skills ? skillsHistory : conversationHistory).push({ role: 'assistant', content: data.message });
      renderAssistantMessage(data.message);
    }
    if (data.progress) updateProgress(data.progress);
    if (data.goal) setGoalChip(data.goal);
    renderChips(data.chips);

    if (data.safety) { handleSafety(data.safety); reEnableInput(); return; }

    if (data.complete && !window.halted && !window.blockParentReport) {
      if (skills) handleSkillsComplete(); else handleComplete();
      return;
    }

    reEnableInput();
  } catch (error) {
    thinking.remove();
    addMessage('Hit a small snag. Tap send again and we’ll pick right back up.', 'system');
    console.error('Turn error:', error);
    reEnableInput();
  }
}

function reEnableInput() {
  if (window.halted) return;
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.disabled = false;
  if (input) { input.disabled = false; input.focus(); }
  scrollToBottom();
}

// Visible progress bar in the chat header. Driven by server-supplied metadata so
// the client never has to infer where the teen is.
function updateProgress(p) {
  const wrap = document.getElementById('chatProgress');
  const fill = document.getElementById('cpFill');
  const label = document.getElementById('cpLabel');
  if (!wrap || !fill || !label || !p) return;
  const total = p.total || TOTAL_QUESTIONS;
  const q = Math.max(0, Math.min(p.q || 0, total));
  fill.style.width = Math.round((q / total) * 100) + '%';
  label.textContent = window.mode === 'skills'
    ? (p.phase || 'Scenarios') + ' · ' + q + ' of ' + total
    : (p.phase ? p.phase + ' · ' : '') + 'Q' + q + ' of ~' + total;
  wrap.style.display = 'flex';
}

// ─── QUICK-ANSWER CHIPS + GOAL CHIP ──────────────────────────────────────
// Server-supplied tappable options for list-style questions (the teen can still
// type). Tapping fills + sends. A pinned goal chip appears once the teen names
// their main goal, so every later question visibly relates to it.
function renderChips(chips) {
  const box = document.getElementById('quickChips');
  if (!box) return;
  box.innerHTML = '';
  if (!chips || !chips.length || window.mode === 'skills') return;
  chips.forEach(label => {
    const b = elem('button', 'quick-chip', label);
    b.addEventListener('click', () => {
      const input = document.getElementById('userInput');
      if (input && !input.disabled) { input.value = label; sendMessage(); }
    });
    box.appendChild(b);
  });
}
function clearChips() { const box = document.getElementById('quickChips'); if (box) box.innerHTML = ''; }
function setGoalChip(goal) {
  const el = document.getElementById('goalChip');
  if (!el || !goal) return;
  el.textContent = 'Your goal: ' + goal;
  el.style.display = '';
}

// ─── SAFETY HANDLING ─────────────────────────────────────────────────────
// In-conversation behavior is interim-safe; the BACKEND routing (who is
// notified, escalation SOP, region-aware resources, the parent-may-be-unsafe
// path) is step 7 and is NOT built. reportSafetyEvent is the seam for it.
function handleSafety(flag) {
  window.safetyEvent = flag;
  // Serious flags halt the interview, block the parent report, and purge the
  // transcript from the device NOW so the disclosure can't be reopened on a
  // shared/parent device. saveSession() also refuses to write once safetyEvent
  // is one of these. The server independently sets a durable safety_blocked and
  // purges its copy — the client stop is UX, the server block is authoritative.
  const serious = SERIOUS_SAFETY.indexOf(flag) !== -1;
  if (serious) clearSession();
  showResources(flag);
  reportSafetyEvent(flag);

  if (serious) {
    window.halted = true;
    window.blockParentReport = true;
    let msg;
    if (flag === 'CRISIS') msg = 'Paused. The most important thing right now is talking to someone who can help — the options above are there for you.';
    else if (flag === 'THREAT') msg = 'Let’s pause here. If someone could get hurt, the numbers above can help right now.';
    else msg = 'This is a good place to pause. The people and numbers above can actually help with what you’re carrying.';
    disableInputPermanently(msg);
  }
  // SUPPORT: resources shown, interview continues.
}

function reportSafetyEvent(flag) {
  // Best-effort report to the server's safety routing (token-gated). The server
  // also detects sentinels itself and dedupes, so this is redundancy + the path
  // for the Prompt B STEP-0 result (which is JSON, not a sentinel). Never routes
  // anything toward the parent.
  console.warn('[SAFETY_EVENT]', flag);
  try {
    fetch('/api/safety-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flag: flag })
    }).catch(() => {});
  } catch (e) { /* never let reporting break the safety UX */ }
}

// ─── COMPLETION → SCORING (Prompt B) ─────────────────────────────────────
function handleComplete() {
  window.interviewComplete = true;
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;
  runScoring();
}

async function runScoring() {
  const status = addStatus('Putting your result together — about 30 seconds. Your answers are saved, so you won’t lose anything.');
  try {
    // Scoring runs SERVER-side (Prompt B) from the server's OWN stored transcript
    // — we send no transcript. The server validates, retries, handles its safety
    // pass, and STORES the authentic report draft. The result never contains the
    // parent's email.
    const r = await fetch('/api/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await r.json();
    status.remove();

    if (data && data.safety) {
      window.blockParentReport = true;
      handleSafety(String(data.safety));
      addStatus('Thanks for being honest with me. There’s no scored result here — what you shared matters more than that.');
      return;
    }
    if (!r.ok || !data.result) throw new Error((data && data.error) || 'Could not get a valid result');

    window.scoringResult = data.result;
    // Guided completion (Avi/ChatGPT feedback): instead of dropping the teen on a
    // passive result, offer the Decision Lab as the clear recommended next step
    // FIRST — so the 5 scenarios aren't a buried afterthought.
    if (!window.blockParentReport && !window.moneyJudgment && !window.skillsComplete) showDecisionLabPrompt();
    else renderResult(data.result);
  } catch (e) {
    status.remove();
    console.error('Scoring error:', e);
    // The transcript is still in memory this page session — offer a real retry
    // rather than telling them to refresh (a refresh would NOT resume it).
    addStatus('Your result hit a snag while generating — your answers are still right here.');
    const retry = elem('button', 'btn btn-primary', 'Try generating my result again');
    retry.style.marginTop = '10px';
    retry.addEventListener('click', () => { retry.remove(); runScoring(); });
    document.getElementById('messages').appendChild(retry);
    scrollToBottom();
  }
}

// Client-side schema check on the scoring object — scores are 1–5 integers or
// null, confidence is from the allowed enum, the result shape is present.
const CONFIDENCE_ENUM = ['high', 'moderate', 'limited', 'insufficient'];
function validScore(s) { return s === null || (Number.isInteger(s) && s >= 1 && s <= 5); }
function validateScoring(p) {
  if (!p || typeof p !== 'object' || !p.safety_check) return false;
  if (p.safety_check.clear === false) return true; // a safety result is valid as-is
  const t = p.teen_output;
  if (!t || !Array.isArray(t.bars) || !t.bars.length) return false;
  if (p.scoring && typeof p.scoring === 'object') {
    for (const k of Object.keys(p.scoring)) {
      const d = p.scoring[k] || {};
      if (!validScore(d.score)) return false;
      if (d.confidence && CONFIDENCE_ENUM.indexOf(d.confidence) === -1) return false;
    }
  }
  for (const b of t.bars) { if (!validScore(b.score)) return false; }
  return true;
}

function parseScoringJSON(text) {
  // Defensive: strip stray code fences / prose around the JSON object.
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try { return JSON.parse(t.slice(start, end + 1)); } catch { return null; }
}

// Guided interstitial after scoring: the Decision Lab is the recommended next
// step BEFORE the full result, so it's a clear decision, not a buried button.
function showDecisionLabPrompt() {
  showScreen('result');
  const root = document.getElementById('resultBody');
  root.innerHTML = '';
  const name = window.session.teen_first_name;
  const box = elem('div', 'dl-prompt');
  box.appendChild(elem('div', 'dl-pill', 'Last part'));
  box.appendChild(elem('h1', 'result-h1', name + ', last part before your result'));
  box.appendChild(elem('p', 'dl-text', 'One more short round: five quick real-life money calls, about 3 minutes. It’s part of your map — it sharpens the read and it’s the part most people find most interesting. Then you get your full result.'));
  const add = elem('button', 'btn btn-primary dl-add', 'Keep going → 5 quick scenarios');
  add.addEventListener('click', startSkills);
  const skip = elem('button', 'btn btn-ghost dl-skip', 'I’d rather stop here and see my result');
  skip.addEventListener('click', () => {
    window.decisionLabStatus = 'skipped';
    try { fetch('/api/skills/skip', { method: 'POST' }).catch(() => {}); } catch (e) {}
    renderResult(window.scoringResult);
  });
  box.appendChild(add); box.appendChild(skip);
  root.appendChild(box);
  scrollResultTop();
}

// STEP 3: the teen result view. Warm by design (the interview was neutral).
// Renders teen_output: stage badge, the goal mirror, the five-bar chart (null
// dimensions render as "not enough info yet"), strength + verbatim quote, the
// biggest unlock, the seven-day move, an optional high-scorer pathway, and the
// two-way choice. Every model-authored string goes in via textContent — never
// innerHTML — so nothing the model wrote can render as markup.
function renderResult(parsed) {
  showScreen('result');
  const t = parsed.teen_output || {};
  const level = parsed.level || {};
  const root = document.getElementById('resultBody');
  root.innerHTML = '';
  const name = window.session.teen_first_name;

  // 1) Your System Map — the branded heart of the result: North Star → what's
  //    already working → the system you're running → friction → lever → 7-day
  //    move. The teen feels UNDERSTOOD before being EVALUATED (stage/bars below).
  root.appendChild(elem('h1', 'result-h1', name + ', here’s where you are'));
  if (!window.blockParentReport) {
    const banner = elem('div', 'result-banner');
    banner.appendChild(elem('span', 'rb-check', '✓'));
    banner.appendChild(elem('span', 'rb-text', window.alreadyShared
      ? 'You already shared this with ' + window.session.parent_first_name + ' — this is your saved result, and you can re-save it as a PDF below.'
      : 'Your result is ready — nothing’s been sent yet. Your choices (save, sharpen, share) are at the bottom.'));
    root.appendChild(banner);
  }
  root.appendChild(buildSystemMap(t));

  // 5) The evidence behind it — stage, confidence, the dimension map. Placed
  //    AFTER the narrative so it reads as support, not a report card. Bars show
  //    qualitative labels (Starting…Systemized), not bare 1–5 grades.
  const evid = elem('div', 'evidence-block');
  evid.appendChild(elem('h3', 'section-title', 'Why I’m saying that'));
  if (t.stage_display) {
    evid.appendChild(elem('span', 'stage-badge', t.stage_display));
    if (level.partial_note) evid.appendChild(elem('div', 'partial-note', 'Based on partial evidence — some questions got skipped, which is fine.'));
  }
  if (t.confidence_note) { const c = elem('p', 'confidence-note'); appendTextWithLineBreaks(c, t.confidence_note); evid.appendChild(c); }
  if (Array.isArray(t.bars) && t.bars.length) {
    evid.appendChild(elem('p', 'bars-legend', 'These aren’t grades — they’re where each money skill is starting from right now.'));
    evid.appendChild(buildBars(t.bars));
  }
  root.appendChild(evid);
  if (t.stage_display || t.growth_horizon) root.appendChild(buildGapSection(t));

  // 6) Money decisions (from the optional scenario check), if completed.
  if (window.moneyJudgment) root.appendChild(buildMoneyJudgmentSection(window.moneyJudgment));
  else if (window.decisionLabStatus === 'skipped' && !window.alreadyShared) root.appendChild(elem('p', 'confidence-note', 'Money decision skills were skipped — not included in this map. You can still add them below.'));

  // 7) High-scorer pathway.
  if (t.high_scorer_pathway) {
    const sec = section('Where this can go', 'pathway');
    sec.appendChild(para(t.high_scorer_pathway));
    root.appendChild(sec);
  }

  // 8) Two ways forward — both are real, clickable controls.
  if (t.choice && (t.choice.solo || t.choice.ots)) {
    root.appendChild(elem('h3', 'choice-title', 'Two ways to go from here'));
    const wrap = elem('div', 'choice');
    if (t.choice.solo) {
      const c = elem('button', 'choice-card'); appendTextWithLineBreaks(c, t.choice.solo);
      c.addEventListener('click', () => markSoloMove(wrap));
      wrap.appendChild(c);
    }
    if (t.choice.ots) {
      const c = elem('button', 'choice-card primary'); appendTextWithLineBreaks(c, t.choice.ots);
      c.addEventListener('click', showOtsPath);
      wrap.appendChild(c);
    }
    root.appendChild(wrap);
    const panel = elem('div', 'ots-panel'); panel.id = 'otsPanel'; panel.style.display = 'none';
    root.appendChild(panel);
  }

  // 9) Accuracy check — "Does this feel true?" before anything is shared. Skipped
  //    once the report has been sent (the read is settled).
  if (!window.alreadyShared) root.appendChild(buildAccuracyCheck());

  // 10) Guided "What's next": the optional scenarios, save-as-PDF, and the share
  //     step (the PRIMARY action) — each clearly labeled so nothing gets missed.
  root.appendChild(buildNextSteps());

  scrollResultTop();
}

// A clear, guided end-of-result block. Avi's run-through showed teens miss the
// share button, skip the PDF, and won't find the scenarios — so they're now
// explicit, labeled steps, with the share as the obvious primary action.
function buildNextSteps() {
  const parent = window.session.parent_first_name;
  const box = elem('div', 'next-steps');

  // Already shared (recovery): read-only with a re-save option.
  if (window.alreadyShared) {
    box.appendChild(elem('div', 'ns-title', 'Your saved result'));
    box.appendChild(elem('div', 'ns-status', '✓ You already shared this with ' + parent + '.'));
    const pdfStep = elem('div', 'ns-step');
    pdfStep.appendChild(elem('div', 'ns-step-h', 'Keep your result'));
    pdfStep.appendChild(elem('div', 'ns-step-p', 'Save it before you close this — it won’t be here later.'));
    const pdfBtn = elem('button', 'btn btn-ghost result-pdf ns-btn', '⤓  Save as PDF');
    pdfBtn.addEventListener('click', downloadResultPDF);
    pdfStep.appendChild(pdfBtn);
    box.appendChild(pdfStep);
    return box;
  }

  box.appendChild(elem('div', 'ns-title', 'Before you go'));
  if (!window.blockParentReport) box.appendChild(elem('div', 'ns-status', 'Your result is ready — and nothing’s been sent to ' + parent + ' yet.'));

  if (!window.blockParentReport && !window.moneyJudgment && !window.skillsComplete) {
    const step = elem('div', 'ns-step');
    step.appendChild(elem('div', 'ns-step-h', 'Put it to the test  ·  optional, ~3 min'));
    step.appendChild(elem('div', 'ns-step-p', 'Five quick real-life money calls. They add a “money decision skills” read to your result — most people find this the most interesting part.'));
    const b = elem('button', 'btn btn-primary ns-btn', 'Try the 5 scenarios →');
    b.addEventListener('click', startSkills);
    step.appendChild(b);
    box.appendChild(step);
  }

  const pdfStep = elem('div', 'ns-step');
  pdfStep.appendChild(elem('div', 'ns-step-h', 'Keep your result'));
  pdfStep.appendChild(elem('div', 'ns-step-p', 'Save it before you close this — it won’t be here later.'));
  const pdfBtn = elem('button', 'btn btn-ghost result-pdf ns-btn', '⤓  Save as PDF');
  pdfBtn.addEventListener('click', downloadResultPDF);
  pdfStep.appendChild(pdfBtn);
  const cardBtn = elem('button', 'btn btn-ghost ns-btn', '⤓  Save a shareable card');
  cardBtn.style.marginTop = '8px';
  cardBtn.addEventListener('click', downloadShareCard);
  pdfStep.appendChild(cardBtn);
  box.appendChild(pdfStep);

  if (window.blockParentReport) {
    box.appendChild(elem('div', 'next-note', 'Nothing from this goes to ' + parent + '. This result is just for you.'));
  } else {
    const shareStep = elem('div', 'ns-step ns-primary');
    shareStep.appendChild(elem('div', 'ns-step-h', 'Share with ' + parent + '  ·  your call'));
    shareStep.appendChild(elem('div', 'ns-step-p', 'This is the only thing ' + parent + ' sees — and you choose every single line before it sends. You can also send nothing.'));
    const cta = elem('button', 'btn btn-primary result-cta ns-btn-lg', 'Choose what ' + parent + ' sees →');
    cta.addEventListener('click', showPreview);
    shareStep.appendChild(cta);
    const priv = elem('button', 'btn btn-ghost ns-private', 'Keep this private — send nothing');
    priv.addEventListener('click', keepPrivate);
    shareStep.appendChild(priv);
    box.appendChild(shareStep);
  }
  return box;
}

// Explicit "keep private" — a durable end state, so a teen who doesn't want to
// share isn't left in limbo. Ends the session (clears the cookie) and confirms.
async function keepPrivate() {
  const parent = window.session.parent_first_name;
  if (!confirm('Keep this just for you? Nothing will be sent to ' + parent + '.')) return;
  declineShare();
}

// Durable "private" decision: tell the server to block any future send and purge
// the draft/transcript, then confirm. Used by the result screen AND the preview.
async function declineShare() {
  clearSession();
  try { await fetch('/api/share/decline', { method: 'POST' }); } catch (e) {}
  renderSent(false);
}

// ─── YOUR SYSTEM MAP (branded result heart) ──────────────────────────────
const COMPASS_SVG =
  '<svg class="sm-compass" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
  '<circle cx="20" cy="20" r="17" fill="none" stroke="var(--accent)" stroke-width="2"/>' +
  '<path d="M20 5 L24 20 L20 35 L16 20 Z" fill="var(--accent-2)"/>' +
  '<path d="M5 20 L20 16 L35 20 L20 24 Z" fill="var(--accent)" opacity="0.55"/>' +
  '<circle cx="20" cy="20" r="2.6" fill="#fff"/></svg>';

function buildSystemMap(t) {
  const map = elem('div', 'system-map');
  const header = elem('div', 'sm-header');
  header.innerHTML = COMPASS_SVG; // static brand glyph (no user text)
  header.appendChild(elem('div', 'sm-title', 'Your System Map'));
  map.appendChild(header);

  const stations = elem('div', 'sm-stations');
  const station = (icon, label, text, extraClass, quote) => {
    if (!text) return;
    const s = elem('div', 'sm-station' + (extraClass ? ' ' + extraClass : ''));
    s.appendChild(elem('div', 'sm-dot', icon));
    s.appendChild(elem('div', 'sm-label', label));
    const tx = elem('div', 'sm-text'); appendTextWithLineBreaks(tx, text); s.appendChild(tx);
    if (quote) s.appendChild(elem('div', 'sm-quote', '“' + quote + '”'));
    stations.appendChild(s);
  };

  const str = t.demonstrated_strength || {};
  const unlock = t.biggest_unlock || {};
  station('★', 'Your North Star', t.goal_reflected, 'sm-star');
  station('✓', 'What’s already working', str.text, null, str.evidence_quote || null);
  station('⚙', 'The system you’re running', t.current_pattern);
  if (unlock.skill) station('!', 'The friction', 'The one skill slowing your momentum right now: ' + unlock.skill + '.');
  station('▲', 'The lever', unlock.framing);
  station('→', 'Your 7-day move', t.seven_day_move, 'sm-move');
  map.appendChild(stations);
  return map;
}

// ─── "DOES THIS FEEL TRUE?" accuracy check ───────────────────────────────
// The teen confirms or corrects the read before sharing. "Not really" opens a
// one-line correction that re-reads the result (server re-scores with it in mind)
// — so a parent report is never built from a read the teen says is plainly wrong.
function buildAccuracyCheck() {
  const wrap = elem('div', 'accuracy-check'); wrap.id = 'accuracyCheck';
  wrap.appendChild(elem('div', 'ac-q', 'Does this feel true?'));
  const btns = elem('div', 'ac-btns');
  ['Yes', 'Mostly', 'Not really'].forEach(label => {
    const b = elem('button', 'ac-btn', label);
    b.addEventListener('click', () => handleAccuracy(label, wrap));
    btns.appendChild(b);
  });
  wrap.appendChild(btns);
  return wrap;
}

function handleAccuracy(answer, wrap) {
  window.accuracyAnswer = answer;
  wrap.querySelectorAll('.ac-btn').forEach(b => b.classList.toggle('sel', b.textContent === answer));
  const old = wrap.querySelector('.ac-followup'); if (old) old.remove();
  const fu = elem('div', 'ac-followup');
  if (answer === 'Not really') {
    fu.appendChild(elem('div', 'ac-fu-label', 'What did I miss? A line or two — I’ll re-read with that in mind.'));
    const ta = document.createElement('textarea');
    ta.className = 'ac-input'; ta.id = 'acInput'; ta.rows = 2;
    ta.placeholder = 'e.g. “the goal is actually X, not Y,” or “I’m way more cautious than this says”';
    fu.appendChild(ta);
    const rb = elem('button', 'btn btn-primary ac-refine', 'Refine my result →');
    rb.addEventListener('click', () => refineResult(ta.value));
    fu.appendChild(rb);
  } else {
    fu.appendChild(elem('div', 'ac-fu-ok', answer === 'Yes' ? 'Love it — that’s yours.' : 'Good — close enough to be useful.'));
  }
  wrap.appendChild(fu);
}

async function refineResult(correction) {
  const text = (correction || '').trim();
  if (!text) return;
  const rb = document.querySelector('.ac-refine');
  if (rb) { rb.disabled = true; rb.textContent = 'Re-reading…'; }
  try {
    const r = await fetch('/api/score/refine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correction: text })
    });
    const data = await r.json();
    if (!r.ok || !data.result) throw new Error((data && data.error) || 'refine failed');
    window.scoringResult = data.result;
    window.accuracyAnswer = null;
    renderResult(data.result);
  } catch (e) {
    if (rb) { rb.disabled = false; rb.textContent = 'Refine my result →'; }
    const wrap = document.getElementById('accuracyCheck');
    if (wrap) wrap.appendChild(elem('div', 'ac-err', 'Couldn’t refine just now — your result is unchanged. Try again in a moment.'));
    console.error('refine error:', e);
  }
}

// ─── SKILLS CHECK (optional scenario layer) ──────────────────────────────
// Reuses the chat UI in 'skills' mode: Prompt C runs five scenarios, then
// [SKILLS_COMPLETE] → Prompt D scores a "Money Judgment" read that's shown as a
// distinct section (not folded into the readiness total) and offered to the
// parent report as a vetoable line.
function startSkills() {
  window.mode = 'skills';
  skillsHistory.length = 0;
  const messages = document.getElementById('messages');
  while (messages.firstChild) messages.removeChild(messages.firstChild);
  const cp = document.getElementById('chatProgress'); if (cp) cp.style.display = 'none'; // reset bar for scenarios
  const bar = document.getElementById('inputBar');
  if (bar) bar.style.display = '';
  const h = document.getElementById('chatHeading');
  if (h) h.textContent = window.session.teen_first_name + ' — quick scenarios';
  showScreen('chat');
  // Server seeds the first scenario on the answer-less turn.
  requestTurn();
}

function handleSkillsComplete() {
  window.skillsComplete = true;
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;
  scoreSkills();
}

async function scoreSkills() {
  const status = addStatus('Folding your scenarios into your result — a few seconds.');
  try {
    // Skills scoring (Prompt D) runs server-side from the stored skills transcript
    // and adds the money-judgment line to the STORED report draft.
    const r = await fetch('/api/skills-score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    const data = await r.json();
    status.remove();
    window.mode = 'interview';
    if (data && data.safety) {
      handleSafety(String(data.safety));
      renderResult(window.scoringResult);
      return;
    }
    if (!r.ok) throw new Error((data && data.error) || 'skills scoring failed');
    window.moneyJudgment = data.money_judgment || null;
    mergeMoneyJudgmentIntoReport();
    renderResult(window.scoringResult);
  } catch (e) {
    status.remove();
    window.mode = 'interview';
    console.error('Skills scoring error:', e);
    renderResult(window.scoringResult);
    addStatus('Couldn’t fold in the scenarios just now, but your main result is here.');
  }
}

// Offer the money-judgment line to the parent report as a vetoable shareable item.
function mergeMoneyJudgmentIntoReport() {
  const mj = window.moneyJudgment;
  if (!mj || mj.score == null) return;
  const draft = window.scoringResult && window.scoringResult.parent_report_draft;
  if (!draft) return;
  if (!Array.isArray(draft.shareable_items)) draft.shareable_items = [];
  if (draft.shareable_items.some(i => i.id === 'mj1')) return;
  draft.shareable_items.push({
    id: 'mj1', category: 'money_judgment',
    text: mj.parent_line || mj.teen_summary || '', evidence_quote: null
  });
}

function buildMoneyJudgmentSection(mj) {
  const wrap = elem('div', 'mj-section');
  wrap.appendChild(elem('div', 'mj-title', 'Money decision skills — from your scenarios'));
  if (mj.score != null) {
    const row = elem('div', 'bar-row');
    row.appendChild(elem('div', 'bar-label', 'Decisions'));
    const track = elem('div', 'bar-track');
    const fill = elem('div', 'bar-fill');
    fill.style.width = (clamp(mj.score, 0, 5) / 5 * 100) + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(elem('div', 'bar-score', String(mj.score)));
    wrap.appendChild(row);
  } else {
    wrap.appendChild(elem('p', 'confidence-note', 'Not enough in the scenarios to read this one yet.'));
  }
  if (mj.teen_summary) {
    const p = elem('p', 'mj-summary');
    appendTextWithLineBreaks(p, mj.teen_summary);
    wrap.appendChild(p);
  }
  // Per-scenario insight cards — the personalized, educational read (previously
  // discarded). One compact card per scenario: lesson, what you showed, quote.
  if (Array.isArray(mj.per_scenario) && mj.per_scenario.length) {
    const grid = elem('div', 'mj-scenarios');
    mj.per_scenario.forEach(s => {
      if (!s || !s.read) return;
      const card = elem('div', 'mj-scenario');
      card.appendChild(elem('div', 'mj-scenario-lesson', s.lesson || ''));
      const r = elem('div', 'mj-scenario-read'); appendTextWithLineBreaks(r, s.read); card.appendChild(r);
      if (s.quote) card.appendChild(elem('div', 'mj-scenario-quote', '“' + s.quote + '”'));
      grid.appendChild(card);
    });
    if (grid.children.length) wrap.appendChild(grid);
  }
  return wrap;
}

// ─── PREVIEW / VETO (step 4) ─────────────────────────────────────────────
// The teen reviews each shareable disclosure and chooses share / keep-private
// (with inline edit). The fixed framing, confidence summary, and program fit
// are shown read-only — they're framing, not the teen's disclosures. On approval
// the report is FROZEN (no Prompt B re-call) and only the approved + edited items
// are sent. The parent is never told how many items were withheld.
function showPreview() {
  if (window.blockParentReport) return; // safety guard — never reachable, but defensive
  postEvent('map_share_opened');
  const draft = (window.scoringResult && window.scoringResult.parent_report_draft) || {};
  const items = (draft.shareable_items || []).map(it => ({
    id: it.id, category: it.category, text: it.text, evidence_quote: it.evidence_quote || null, shared: true
  }));
  // EVERY personalized inference is teen-controlled — including the growth
  // horizon, confidence summary, and program fit, which used to send regardless
  // of veto. Only truly generic framing (limitation + what-not-to-do) stays fixed.
  if (draft.growth_horizon) items.push({ id: 'gh1', category: 'growth_horizon', text: draft.growth_horizon, evidence_quote: null, shared: true });
  if (draft.confidence_summary) items.push({ id: 'cs1', category: 'confidence', text: draft.confidence_summary, evidence_quote: null, shared: true });
  if (draft.program_fit && draft.program_fit.text) items.push({ id: 'pf1', category: 'program_fit', text: draft.program_fit.text, evidence_quote: null, shared: true });
  if (draft.parent_action) items.push({ id: 'pa1', category: 'parent_action', text: draft.parent_action, evidence_quote: null, shared: true });
  if (draft.conversation_starter) items.push({ id: 'cq1', category: 'conversation_starter', text: draft.conversation_starter, evidence_quote: null, shared: true });
  window.previewItems = items;
  showScreen('preview');
  showHandshakeStep(draft); // first-class Family Handshake step, then the line-by-line preview
}

// ─── FAMILY HANDSHAKE (first-class step before the item preview) ──────────
const HANDSHAKE_CHIPS = ['Ask before giving advice', 'Let me try first', 'Help me find resources', 'Check in once', 'Don’t make it a lecture'];
function showHandshakeStep(draft) {
  const root = document.getElementById('previewBody');
  root.innerHTML = '';
  const parent = window.session.parent_first_name;
  root.appendChild(elem('h1', 'pv-h1', 'The Family Handshake'));
  root.appendChild(elem('p', 'pv-intro', 'Before you choose what to share — how do you want ' + parent + ' to help with this, without taking it over? Tap what fits, add your own, or skip.'));
  const chipsRow = elem('div', 'hs-chips');
  const ta = document.createElement('textarea');
  ta.id = 'hsSupport'; ta.className = 'pv-support-input'; ta.rows = 3;
  ta.placeholder = 'e.g. “ask before stepping in,” “let me try first,” “help me set up the account”…';
  if (window.supportRequest) ta.value = window.supportRequest;
  HANDSHAKE_CHIPS.forEach(label => {
    const b = elem('button', 'quick-chip', label); b.type = 'button';
    b.addEventListener('click', () => {
      const cur = ta.value.trim().replace(/[.\s]+$/, '');
      ta.value = cur ? (cur + '. ' + label) : label;
    });
    chipsRow.appendChild(b);
  });
  root.appendChild(chipsRow);
  root.appendChild(ta);
  const next = elem('button', 'btn btn-primary pv-send', 'Next: choose what ' + parent + ' sees →');
  next.style.marginTop = '16px';
  next.addEventListener('click', () => { window.supportRequest = ta.value.trim(); renderPreview(draft); });
  root.appendChild(next);
  const s = document.getElementById('screen-preview'); if (s) s.scrollTop = 0;
}

function renderPreview(draft) {
  const root = document.getElementById('previewBody');
  root.innerHTML = '';
  const parent = window.session.parent_first_name;

  root.appendChild(elem('h1', 'pv-h1', 'What goes to ' + parent));
  root.appendChild(elem('p', 'pv-intro', 'You decide what ' + parent + ' sees. Switch anything to private to keep it to yourself, or edit to reword it. They won’t be told anything was left out.'));

  window.previewItems.forEach(it => root.appendChild(buildPreviewItem(it)));

  // Read-only framing the teen can see but not veto.
  const fixed = draft.fixed_framing || {};
  const ro = elem('div', 'pv-readonly');
  ro.appendChild(elem('div', 'pv-ro-title', 'The only part you can’t change — general ground rules, not anything about you'));
  if (fixed.limitation) ro.appendChild(para(fixed.limitation));
  if (Array.isArray(fixed.what_not_to_do) && fixed.what_not_to_do.length) {
    const ul = document.createElement('ul');
    fixed.what_not_to_do.forEach(x => { const li = document.createElement('li'); appendTextWithLineBreaks(li, x); ul.appendChild(li); });
    ro.appendChild(ul);
  }
  root.appendChild(ro);

  // Teen-authored support request — often the most useful line for the parent.
  const sr = elem('div', 'pv-support');
  sr.appendChild(elem('label', 'pv-support-label', 'One way you’d want ' + parent + ' to support this — without taking it over (optional)'));
  const srInput = document.createElement('textarea');
  srInput.id = 'pvSupport'; srInput.className = 'pv-support-input'; srInput.rows = 2;
  srInput.placeholder = 'e.g. “ask before stepping in,” “let me try first,” “help me set up the account”…';
  if (window.supportRequest) srInput.value = window.supportRequest;
  sr.appendChild(srInput);
  root.appendChild(sr);

  const send = elem('button', 'btn btn-primary pv-send', 'Send to ' + parent);
  send.addEventListener('click', sendParentReport);
  const skip = elem('button', 'btn btn-ghost pv-skip', 'Don’t send anything');
  skip.addEventListener('click', declineShare);
  const row = elem('div', 'pv-send-row');
  row.appendChild(send); row.appendChild(skip);
  root.appendChild(row);

  const s = document.getElementById('screen-preview');
  if (s) s.scrollTop = 0;
}

function buildPreviewItem(item) {
  // Exact quotes default OFF — sharing your literal words is an affirmative opt-in,
  // not a default (audit). The teen can flip "My exact words" on per item.
  if (item.evidence_quote && item.includeQuote === undefined) item.includeQuote = false;
  const card = elem('div', 'pv-item');
  card.appendChild(elem('div', 'pv-cat', categoryLabel(item.category)));
  const textEl = elem('div', 'pv-text');
  appendTextWithLineBreaks(textEl, item.text);
  card.appendChild(textEl);

  let quoteEl = null;
  if (item.evidence_quote) quoteEl = elem('blockquote', 'pv-quote', '“' + item.evidence_quote + '”');
  if (quoteEl) card.appendChild(quoteEl);

  const actions = elem('div', 'pv-actions');
  const toggle = elem('button', 'pv-toggle');
  toggle.setAttribute('aria-pressed', String(!!item.shared));
  const edit = elem('button', 'pv-edit', 'Edit');
  actions.appendChild(toggle); actions.appendChild(edit);
  // Separate control for the exact verbatim quote (audit #4).
  let quoteToggle = null;
  if (item.evidence_quote) {
    quoteToggle = elem('button', 'pv-quote-toggle');
    actions.appendChild(quoteToggle);
  }
  card.appendChild(actions);

  function applyShared() {
    card.classList.toggle('private', !item.shared);
    toggle.textContent = item.shared ? 'Sharing ✓' : 'Private';
    toggle.classList.toggle('off', !item.shared);
    toggle.setAttribute('aria-pressed', String(!!item.shared));
  }
  function applyQuote() {
    if (!quoteToggle) return;
    quoteToggle.textContent = item.includeQuote ? 'My exact words: on' : 'My exact words: off';
    quoteToggle.classList.toggle('off', !item.includeQuote);
    quoteToggle.setAttribute('aria-pressed', String(!!item.includeQuote));
    if (quoteEl) quoteEl.style.display = item.includeQuote ? '' : 'none';
  }
  applyShared(); applyQuote();
  toggle.addEventListener('click', () => { item.shared = !item.shared; applyShared(); });
  if (quoteToggle) quoteToggle.addEventListener('click', () => { item.includeQuote = !item.includeQuote; applyQuote(); });

  let ta = null;
  edit.addEventListener('click', () => {
    if (!ta) {
      ta = document.createElement('textarea');
      ta.className = 'pv-edit-area';
      ta.value = item.text;
      textEl.style.display = 'none';
      card.insertBefore(ta, textEl.nextSibling);
      edit.textContent = 'Save';
    } else {
      const reworded = ta.value.trim() && ta.value.trim() !== item.text;
      item.text = ta.value.trim() || item.text;
      // If they reworded it, default the exact quote OFF — their words, their call.
      if (reworded && item.evidence_quote) { item.includeQuote = false; applyQuote(); }
      textEl.textContent = '';
      appendTextWithLineBreaks(textEl, item.text);
      textEl.style.display = '';
      ta.remove(); ta = null;
      edit.textContent = 'Edit';
    }
  });

  return card;
}

function categoryLabel(cat) {
  return ({
    what_matters: 'What matters to you',
    strength: 'A strength you showed',
    growth_area: 'A growth area',
    environmental: 'Context worth knowing',
    money_judgment: 'Money decision skills',
    growth_horizon: 'Where you are → where you could be',
    confidence: 'How solid this read is',
    program_fit: 'How OTS could help',
    parent_action: 'Your parent’s move this week',
    conversation_starter: 'A question they can ask'
  })[cat] || 'Shared';
}

async function sendParentReport() {
  const sendBtn = document.querySelector('.pv-send');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = 'Sending…'; }
  const draft = (window.scoringResult && window.scoringResult.parent_report_draft) || {};

  // FREEZE: approved (shared) items with their possibly-edited text. No Prompt B
  // re-call. Personalized fields (growth horizon, confidence, program fit) now
  // travel as approved items only — nothing personalized bypasses the veto.
  // Send only SELECTIONS (which stored items to include, optional rewording,
  // quote on/off) + the teen's support line. The server builds the email from
  // its own stored, server-authored draft — the client can't inject content that
  // wasn't scored. (audit P0 #9)
  const selections = window.previewItems.map(i => ({
    id: i.id, include: !!i.shared, text: i.text, includeQuote: i.includeQuote !== false
  }));
  const supportEl = document.getElementById('pvSupport');
  const support_request = supportEl && supportEl.value.trim() ? supportEl.value.trim() : '';

  try {
    const r = await fetch('/api/parent-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selections, support_request })
    });
    const j = await r.json();
    if (!r.ok || !j.success) throw new Error(j.error || 'send failed');
    clearSession();
    renderSent(true);
  } catch (e) {
    if (sendBtn) { sendBtn.disabled = false; sendBtn.textContent = 'Send to ' + window.session.parent_first_name; }
    const prev = document.querySelector('.pv-error');
    if (prev) prev.remove();
    document.getElementById('previewBody').appendChild(
      elem('div', 'pv-error', 'Couldn’t send just now: ' + e.message + '. Try again in a moment.'));
    console.error('parent-report send error:', e);
  }
}

function renderSent(didSend) {
  showScreen('sent');
  const root = document.getElementById('sentBody');
  root.innerHTML = '';
  const parent = window.session.parent_first_name;
  root.appendChild(elem('div', 'stage-badge', didSend ? 'Sent ✓' : 'Kept private'));
  root.appendChild(elem('h1', 'result-h1', didSend ? 'Done.' : 'Nothing sent.'));
  root.appendChild(para(didSend
    ? 'Your result went to ' + parent + ' — only what you chose. That’s how this works.'
    : 'Nothing went to ' + parent + '. This stays with you.'));
}

// Qualitative labels so a "2" doesn't read like a school grade (audit UI #6).
const SCORE_LABELS = { 1: 'Starting', 2: 'Developing', 3: 'Practicing', 4: 'Strong', 5: 'Systemized' };
function buildBars(bars) {
  const wrap = elem('div', 'bars');
  bars.forEach(b => {
    const row = elem('div', 'bar-row');
    row.appendChild(elem('div', 'bar-label', b.dimension));
    const track = elem('div', 'bar-track');
    if (b.score == null) {
      track.className = 'bar-track empty';
      track.appendChild(elem('span', 'bar-empty', 'not enough info yet'));
      row.appendChild(track);
      row.appendChild(elem('div', 'bar-score muted', '—'));
    } else {
      const fill = elem('div', 'bar-fill');
      fill.style.width = (clamp(b.score, 0, 5) / 5 * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(elem('div', 'bar-score', SCORE_LABELS[b.score] || String(b.score)));
    }
    wrap.appendChild(row);
  });
  return wrap;
}

// Clickable OTS path — shows the teen's actual recommended first skills, not a
// generic sales card (audit UI #7 — the biggest conversion gap).
// Set to a YouTube/Vimeo or hosted .mp4 URL to show Jay's short intro video on
// the OTS pathway. Empty -> a placeholder slot. (CSP allows youtube/vimeo +
// https media — see server.js security headers.)
const JAY_VIDEO_URL = '';

function buildVideoSlot() {
  const slot = elem('div', 'ots-video');
  if (!JAY_VIDEO_URL) {
    slot.classList.add('ots-video-ph');
    slot.appendChild(elem('div', 'ots-video-icon', '▶'));
    slot.appendChild(elem('div', 'ots-video-label', 'A short word from Jay — coming soon'));
    return slot;
  }
  if (/youtube|youtu\.be|vimeo/.test(JAY_VIDEO_URL)) {
    const f = document.createElement('iframe');
    f.src = JAY_VIDEO_URL; f.className = 'ots-video-frame';
    f.setAttribute('allow', 'fullscreen; picture-in-picture'); f.setAttribute('loading', 'lazy'); f.setAttribute('title', 'A word from Jay');
    slot.appendChild(f);
  } else {
    const v = document.createElement('video');
    v.src = JAY_VIDEO_URL; v.controls = true; v.className = 'ots-video-frame'; v.setAttribute('playsinline', '');
    slot.appendChild(v);
  }
  return slot;
}

function showOtsPath() {
  const panel = document.getElementById('otsPanel');
  if (!panel) return;
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  const t = (window.scoringResult && window.scoringResult.teen_output) || {};
  const pf = (window.scoringResult && window.scoringResult.parent_report_draft && window.scoringResult.parent_report_draft.program_fit) || {};
  const lessons = Array.isArray(pf.lessons) ? pf.lessons : [];
  const unlock = t.biggest_unlock || {};
  panel.innerHTML = '';
  panel.appendChild(elem('div', 'ots-panel-title', 'Your first 3 missions'));
  panel.appendChild(elem('p', 'ots-panel-text', 'Three concrete moves to turn this into momentum — at your pace, with your goal at the center.'));

  const missions = elem('div', 'ots-missions');
  let n = 0;
  const mission = (label, text) => {
    if (!text) return;
    const m = elem('div', 'ots-mission');
    m.appendChild(elem('div', 'ots-mission-num', String(++n)));
    const body = document.createElement('div');
    body.appendChild(elem('div', 'ots-mission-label', label));
    const p = elem('div', 'ots-mission-text'); appendTextWithLineBreaks(p, text); body.appendChild(p);
    m.appendChild(body);
    missions.appendChild(m);
  };
  mission('Start this week', t.seven_day_move);
  if (unlock.skill) mission('Build the skill', 'Get real reps on ' + unlock.skill + ' — the one thing that turns what you already have into what you want.');
  mission('With Outsmart the System', lessons.length
    ? 'Your first lessons: ' + lessons.join(' · ') + '.'
    : 'A guided system for turning what you just saw into real skills.');
  panel.appendChild(missions);

  panel.appendChild(buildVideoSlot());

  const link = document.createElement('a');
  link.className = 'btn btn-primary ots-link';
  link.href = 'https://outsmartthesystem.org';
  link.target = '_blank'; link.rel = 'noopener';
  link.textContent = 'See what my first week looks like →';
  panel.appendChild(link);
  panel.style.display = 'block';
}

function markSoloMove(wrap) {
  if (document.getElementById('soloNote')) return;
  const note = elem('div', 'solo-note', 'Love it — your move is up there under “This week.” Screenshot it or save the PDF so you don’t lose it.');
  note.id = 'soloNote';
  wrap.parentNode.insertBefore(note, wrap.nextSibling);
}

// The five OTS stages, in order — used to draw the "where you could be" ladder.
const STAGES = ['Waking Up', 'Aware', 'In Motion', 'Building', 'Outsmarting'];

function buildGapSection(t) {
  const wrap = elem('div', 'gap-section');
  wrap.appendChild(elem('div', 'gap-title', 'Where you are → where you could be'));

  const idx = STAGES.indexOf(t.stage_display);
  if (idx !== -1) {
    const ladder = elem('div', 'ladder');
    STAGES.forEach(function (s, i) {
      let cls = 'ladder-step';
      if (i === idx) cls += ' current';
      else if (i === idx + 1) cls += ' next';
      else if (i < idx) cls += ' done';
      ladder.appendChild(elem('div', cls, s));
    });
    wrap.appendChild(ladder);
    const next = STAGES[idx + 1];
    wrap.appendChild(elem('div', 'ladder-label', next
      ? 'You’re at “' + t.stage_display + '.” Next: “' + next + '.”'
      : 'You’re at “' + t.stage_display + '” — the top. Keep compounding.'));
  }

  if (t.growth_horizon) {
    const p = elem('p', 'gap-horizon');
    appendTextWithLineBreaks(p, t.growth_horizon);
    wrap.appendChild(p);
  }
  return wrap;
}

// Small DOM builders. text goes in via textContent (safe for model output).
function elem(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function para(text) { const p = document.createElement('p'); appendTextWithLineBreaks(p, text); return p; }
function section(title, extraCls) {
  const sec = document.createElement('section');
  sec.className = 'result-section' + (extraCls ? ' ' + extraCls : '');
  sec.appendChild(elem('h3', 'section-title', title));
  return sec;
}
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function scrollResultTop() {
  const s = document.getElementById('screen-result');
  if (s) s.scrollTop = 0;
}

// ─── RESULT PDF ──────────────────────────────────────────────────────────
// Drawn directly with jsPDF (vendored locally, no CDN). No html2canvas/DOM
// rasterization — that approach hung the main thread on some browsers and the
// window.print() fallback froze the tab. This is synchronous, fast, and crisp.
function downloadResultPDF() {
  const btn = document.querySelector('.result-pdf');
  if (!window.jspdf || !window.jspdf.jsPDF) {
    console.error('jsPDF not loaded');
    if (btn) btn.textContent = 'PDF unavailable — reload the page';
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try {
    const safeName = (window.session.teen_first_name || 'result').replace(/[^a-z0-9]/gi, '') || 'result';
    buildResultPdfDoc().save('OTS-Money-Map-' + safeName + '.pdf');
    postEvent('map_pdf_saved');
    if (btn) { btn.disabled = false; btn.textContent = '⤓  Save my result as a PDF'; }
  } catch (e) {
    console.error('PDF error:', e);
    if (btn) { btn.disabled = false; btn.textContent = 'Couldn’t make the PDF — try again'; }
  }
}

function buildResultPdfDoc() {
  const t = (window.scoringResult && window.scoringResult.teen_output) || {};
  const jsPDF = window.jspdf.jsPDF;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const L = 18, R = 192, W = R - L, PT = 0.3528, BOTTOM = 281;
  let y = 22;

  function ensureSpace(needed) { if (y + (needed || 12) > BOTTOM) { doc.addPage(); y = 22; } }
  function block(str, o) {
    o = o || {};
    const size = o.size || 11;
    const width = o.width || W;
    doc.setFont('helvetica', o.bold ? 'bold' : (o.italic ? 'italic' : 'normal'));
    doc.setFontSize(size);
    const c = o.color || [26, 26, 26];
    doc.setTextColor(c[0], c[1], c[2]);
    const lines = doc.splitTextToSize(String(str), width);
    const h = lines.length * size * PT * 1.16;
    ensureSpace(h + (o.after == null ? 4 : o.after));
    doc.text(lines, o.x || L, y);
    y += h + (o.after == null ? 4 : o.after);
  }
  // One System Map station: a dot marker + label + text (no raw numbers).
  function station(label, text, accent) {
    if (!text) return;
    // Keep the label with its text — never orphan a label at a page bottom.
    doc.setFont('helvetica', 'normal'); doc.setFontSize(11);
    const stLines = doc.splitTextToSize(String(text), W - 8);
    ensureSpace(6 + stLines.length * 11 * PT * 1.16 + 5);
    doc.setDrawColor(accent[0], accent[1], accent[2]); doc.setLineWidth(0.5);
    doc.setFillColor(255, 255, 255); doc.circle(L + 2, y - 1.2, 1.9, 'FD');
    block(label, { size: 8.5, bold: true, color: [138, 147, 166], x: L + 8, width: W - 8, after: 1.5 });
    block(text, { size: 11, x: L + 8, width: W - 8, after: 5 });
  }

  // Branded header with a small drawn compass.
  const cx = L + 5, cy = y + 2;
  doc.setDrawColor(47, 109, 240); doc.setLineWidth(0.6); doc.circle(cx, cy, 5, 'S');
  doc.setFillColor(111, 179, 255); doc.triangle(cx, cy - 4.4, cx - 2.2, cy, cx + 2.2, cy, 'F');
  doc.setFillColor(47, 109, 240); doc.triangle(cx, cy + 4.4, cx - 2.2, cy, cx + 2.2, cy, 'F');
  doc.setFillColor(255, 255, 255); doc.circle(cx, cy, 0.9, 'F');
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(47, 109, 240);
  doc.text('OUTSMART THE SYSTEM', cx + 9, cy - 1.4);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(138, 147, 166);
  doc.text('Your System Map', cx + 9, cy + 2.6);
  y = cy + 12;

  block((window.session.teen_first_name || '') + ' — here’s where you are', { size: 19, bold: true, after: 3 });
  if (t.stage_display) block('Stage: ' + t.stage_display, { size: 10, bold: true, color: [47, 109, 240], after: 7 });

  // System Map stations — the branded heart, no raw numbers.
  station('YOUR NORTH STAR', t.goal_reflected, [240, 198, 116]);
  const s = t.demonstrated_strength;
  if (s && s.text) {
    station('WHAT’S ALREADY WORKING', s.text, [47, 109, 240]);
    if (s.evidence_quote) block('“' + s.evidence_quote + '”', { size: 10, italic: true, color: [110, 110, 110], x: L + 8, width: W - 8, after: 6 });
  }
  station('THE SYSTEM YOU’RE RUNNING', t.current_pattern, [47, 109, 240]);
  const u = t.biggest_unlock || {};
  if (u.skill) station('THE FRICTION', 'The one skill slowing your momentum right now: ' + u.skill + '.', [240, 140, 90]);
  if (u.framing) station('THE LEVER', u.framing, [47, 109, 240]);
  station('YOUR 7-DAY MOVE', t.seven_day_move, [111, 211, 160]);

  // Where each money skill is starting from — qualitative labels, NEVER numbers.
  const bars = (t.bars || []).filter(b => b.score != null);
  if (bars.length) {
    ensureSpace(8 + bars.length * 7);
    block('WHERE EACH MONEY SKILL IS STARTING FROM', { size: 8.5, bold: true, color: [138, 147, 166], after: 3 });
    bars.forEach(function (b) {
      ensureSpace(8);
      const rowY = y;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(85, 85, 85);
      doc.text(String(b.dimension), L, rowY + 1.4);
      const tx = L + 52, tw = 86, th = 3.2, ty = rowY - 1.2;
      doc.setFillColor(236, 236, 236); doc.roundedRect(tx, ty, tw, th, 1.6, 1.6, 'F');
      const w = Math.max(2, clamp(b.score, 0, 5) / 5 * tw);
      doc.setFillColor(47, 109, 240); doc.roundedRect(tx, ty, w, th, 1.6, 1.6, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(90, 90, 90);
      doc.text(SCORE_LABELS[b.score] || '', tx + tw + 3, rowY + 1.4);
      y += 7;
    });
    y += 3;
  }
  if (t.confidence_note) block(t.confidence_note, { size: 9, italic: true, color: [138, 147, 166], after: 6 });

  // Optional money-decision-skills line (qualitative).
  const mj = window.moneyJudgment;
  if (mj && mj.teen_summary) station('MONEY DECISION SKILLS', mj.teen_summary, [47, 109, 240]);

  // Footer on the final page.
  doc.setDrawColor(225, 225, 225); doc.setLineWidth(0.2); doc.line(L, 286, R, 286);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(150, 150, 150);
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.text('Outsmart the System  ·  outsmartthesystem.org  ·  ' + date, L, 291);
  return doc;
}

// ─── SHAREABLE CARD (teen-safe: name + goal + move + brand; no scores/quotes) ──
// A social-friendly PNG the teen can share and OTS can screenshot for marketing —
// deliberately excludes scores, evidence quotes, family/money-amount content.
function downloadShareCard() {
  const t = (window.scoringResult && window.scoringResult.teen_output) || {};
  const W = 1080, H = 1350;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#0c0f14'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#2f6df0'; g.fillRect(0, 0, W, 12);
  g.textBaseline = 'top';
  const wrap = (text, x, y, maxW, lh, font, color) => {
    g.font = font; g.fillStyle = color;
    const words = String(text || '').split(/\s+/); let line = ''; let yy = y;
    words.forEach(w => {
      const test = line ? line + ' ' + w : w;
      if (g.measureText(test).width > maxW && line) { g.fillText(line, x, yy); line = w; yy += lh; }
      else line = test;
    });
    if (line) g.fillText(line, x, yy);
    return yy + lh;
  };
  const SANS = '-apple-system, Segoe UI, Roboto, sans-serif';
  g.font = '600 34px ' + SANS; g.fillStyle = '#6fb3ff'; g.fillText('YOUR SYSTEM MAP', 90, 150);
  let y = wrap((window.session.teen_first_name || 'Your') + '’s map is ready', 90, 205, W - 180, 82, '700 70px ' + SANS, '#e8eaed') + 60;
  if (t.goal_reflected) {
    g.font = '600 28px ' + SANS; g.fillStyle = '#8a93a6'; g.fillText('NORTH STAR', 90, y); y += 46;
    y = wrap(t.goal_reflected, 90, y, W - 180, 52, '400 40px ' + SANS, '#e8eaed') + 50;
  }
  if (t.seven_day_move) {
    g.font = '600 28px ' + SANS; g.fillStyle = '#8a93a6'; g.fillText('THIS WEEK’S MOVE', 90, y); y += 46;
    wrap(t.seven_day_move, 90, y, W - 180, 52, '400 40px ' + SANS, '#6fd3a0');
  }
  g.font = '500 30px ' + SANS; g.fillStyle = '#8a93a6'; g.fillText('Powered by Outsmart the System', 90, H - 96);
  try {
    const a = document.createElement('a');
    const safeName = (window.session.teen_first_name || 'result').replace(/[^a-z0-9]/gi, '') || 'result';
    a.href = c.toDataURL('image/png'); a.download = 'OTS-System-Map-' + safeName + '.png'; a.click();
  } catch (e) { console.error('share card error:', e); }
}

// ─── TRANSCRIPT (for scoring) ────────────────────────────────────────────
function buildTranscript() {
  return conversationHistory
    .filter(t => t.content !== SEED_MARKER)
    .map(t => (t.role === 'user' ? 'TEEN' : 'INTERVIEWER') + ':\n' + stripInternalNote(t.content))
    .join('\n\n———\n\n');
}

function stripInternalNote(content) {
  if (content.includes('[Internal note for the interviewer:')) {
    const parts = content.split('\n\n');
    return parts[parts.length - 1];
  }
  return content;
}

function getApiMessages() {
  return activeHistory().map(t => ({ role: t.role, content: t.content }));
}

function estimateQuestion() {
  // Each assistant turn after the opening frame ≈ one question asked.
  const assistantTurns = conversationHistory.filter(t => t.role === 'assistant').length;
  return Math.max(1, Math.min(assistantTurns, TOTAL_QUESTIONS));
}

// ─── SESSION PERSISTENCE ─────────────────────────────────────────────────
// Uses sessionStorage, NOT localStorage: the transcript survives an accidental
// reload but is wiped when the tab/browser closes — important because the app is
// often set up on a shared or parent's device. After a CRISIS/ABUSE disclosure
// nothing is persisted at all, and any prior state is purged immediately.
function saveSession() {
  if (!window.session) return;
  // Never write a transcript to the device once a serious safety event has fired.
  if (SERIOUS_SAFETY.indexOf(window.safetyEvent) !== -1) return;
  const state = {
    conversationHistory,
    safetyEvent: window.safetyEvent,
    blockParentReport: window.blockParentReport,
    interviewComplete: window.interviewComplete,
    savedAt: new Date().toISOString()
  };
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Could not save session:', e); }
}

function loadSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state.savedAt || !state.conversationHistory) return null;
    const ageH = (Date.now() - new Date(state.savedAt).getTime()) / 36e5;
    if (ageH > SESSION_MAX_AGE_HOURS) { clearSession(); return null; }
    if (state.interviewComplete) { clearSession(); return null; }
    // Never resume or re-display a safety-flagged session.
    if (SERIOUS_SAFETY.indexOf(state.safetyEvent) !== -1) { clearSession(); return null; }
    return state;
  } catch (e) { return null; }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {} // purge any legacy localStorage copy
  conversationHistory.length = 0;
  skillsHistory.length = 0;
}

// ─── RENDERING (safe: never innerHTML on model/user text) ────────────────
function renderAssistantMessage(text) {
  const div = document.createElement('div');
  div.className = 'message agent';
  appendTextWithLineBreaks(div, text);
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
}

function addMessage(text, type) {
  const div = document.createElement('div');
  div.className = 'message ' + type;
  appendTextWithLineBreaks(div, text);
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
  return div;
}

function addStatus(text) {
  const div = document.createElement('div');
  div.className = 'message status';
  appendTextWithLineBreaks(div, text);
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
  return div;
}

function addThinking() {
  const div = document.createElement('div');
  div.className = 'message thinking';
  div.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
  return {
    remove: () => div.remove(),
    setText: (t) => { div.textContent = t; div.classList.add('thinking-text'); }
  };
}

function showResources(flag) {
  const existing = document.getElementById('resourcesCard');
  if (existing) return;
  const div = document.createElement('div');
  div.id = 'resourcesCard';
  div.className = 'resources';
  // US resources per Prompt A. Region-aware list is a documented follow-up. Never
  // described as "private" or "anonymous"; never promises confidentiality.
  let html =
    '<strong>If you’re carrying something heavy</strong>' +
    '<p>You can call or text <b>988</b> (Suicide &amp; Crisis Lifeline) any time — it’s free and trained people answer. ' +
    'You can also chat at <b>988lifeline.org</b>. If you might be in immediate danger, call <b>911</b>.</p>';
  if (flag === 'EXPLOITATION') {
    // Sextortion / image-based coercion: point to removal + reporting help.
    html +=
      '<p>If someone is pressuring you over private or sexual images, you’re not in trouble and this can be stopped. ' +
      'You can get free help getting images taken down at <b>takeitdown.ncmec.org</b>, and report it at <b>report.cybertip.org</b>.</p>';
  }
  div.innerHTML = html;
  document.getElementById('messages').appendChild(div);
  scrollToBottom();
}

function disableInputPermanently(message) {
  const bar = document.getElementById('inputBar');
  if (bar) bar.style.display = 'none';
  if (message) addStatus(message);
}

function appendTextWithLineBreaks(parent, text) {
  const lines = String(text).split('\n');
  lines.forEach((line, i) => {
    if (i > 0) parent.appendChild(document.createElement('br'));
    parent.appendChild(document.createTextNode(line));
  });
}

// ─── UI PLUMBING ─────────────────────────────────────────────────────────
function showScreen(name) {
  ['loading', 'error', 'resume', 'onboarding', 'agecheck', 'chat', 'result', 'preview', 'sent'].forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.style.display = (s === name) ? 'flex' : 'none';
  });
  // Move keyboard focus to the new screen's heading (rAF so content rendered
  // right after this call exists). Helps screen-reader and keyboard users.
  requestAnimationFrame(() => {
    const active = document.getElementById('screen-' + name);
    if (!active) return;
    const h = active.querySelector('h1, h2, h3');
    if (h) { h.setAttribute('tabindex', '-1'); try { h.focus({ preventScroll: true }); } catch (e) {} }
  });
}

function showError(html) {
  showScreen('error');
  const el = document.getElementById('errorBody');
  if (el) el.innerHTML = html;
}

function scrollToBottom() {
  const area = document.getElementById('messagesArea');
  if (area) area.scrollTop = area.scrollHeight;
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// Fire-and-forget funnel event → server (which relays to GA4). Best-effort only.
function postEvent(name) {
  try { fetch('/api/event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name }) }).catch(() => {}); }
  catch (e) { /* analytics must never break the UX */ }
}

// One-tap Skip — no need to type "skip" (audit UI #2).
function skipQuestion() {
  const sendBtn = document.getElementById('sendButton');
  if (window.halted || (sendBtn && sendBtn.disabled)) return;
  const input = document.getElementById('userInput');
  if (input) { input.value = 'skip'; }
  sendMessage();
}

// End & clear this device — purges the transcript and leaves. Important when the
// app is on a shared or parent's device.
async function endAndClear() {
  if (!confirm('End now and clear this from this device? Your answers won’t be saved or sent.')) return;
  clearSession();
  // Clear the HttpOnly cookie + purge the server-side transcript (JS can't touch
  // the cookie itself, so the server does it).
  try { await fetch('/api/session/end', { method: 'POST' }); } catch (e) {}
  location.replace('/register.html');
}

// Input wiring (Enter to send, Shift+Enter for newline).
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  const skipBtn = document.getElementById('skipBtn');
  if (skipBtn) skipBtn.addEventListener('click', skipQuestion);
  const endBtn = document.getElementById('endBtn');
  if (endBtn) endBtn.addEventListener('click', endAndClear);
  if (input) {
    input.addEventListener('input', () => { autoResize(input); scrollToBottom(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    // When the input is focused (keyboard opening), keep the input + the latest
    // messages in view above the keyboard.
    input.addEventListener('focus', () => setTimeout(() => { syncChatViewport(); scrollToBottom(); }, 250));
  }
  syncChatViewport();
});

// Pin the chat to the VISUAL viewport so the on-screen keyboard never covers the
// input or what's being typed (the core mobile fix). No-op on desktop.
function syncChatViewport() {
  const el = document.getElementById('screen-chat');
  if (!el) return;
  const vv = window.visualViewport;
  el.style.height = (vv ? vv.height : window.innerHeight) + 'px';
  el.style.transform = 'translateY(' + (vv ? vv.offsetTop : 0) + 'px)';
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncChatViewport);
  window.visualViewport.addEventListener('scroll', syncChatViewport);
}
window.addEventListener('orientationchange', () => setTimeout(syncChatViewport, 250));
