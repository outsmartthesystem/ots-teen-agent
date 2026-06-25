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
const SAFETY_SENTINEL_RE = /\[SAFETY_EVENT:(CRISIS|ABUSE|SUPPORT)\]/;
const TOTAL_QUESTIONS = 16;
const SESSION_KEY = 'ots_teen_session_v1';
const SESSION_MAX_AGE_HOURS = 24;
const SEED_MARKER = '__SEED_BEGIN__';           // hidden first user turn that triggers the opening frame

// ─── STATE ───────────────────────────────────────────────────────────────
const conversationHistory = []; // interview turns [{ role, content }]
const skillsHistory = [];       // optional scenario-check turns [{ role, content }]
window.mode = 'interview';      // 'interview' | 'skills' — which loop is running
window.session = null;          // teen-safe fields from /api/session(/start); auth is the cookie
window.safetyEvent = null;      // null | 'CRISIS' | 'ABUSE' | 'SUPPORT'
window.halted = false;          // hard stop (CRISIS): no more turns, no scoring
window.blockParentReport = false; // CRISIS or ABUSE: this session never produces a parent report
window.interviewComplete = false;
window.skillsComplete = false;
window.scoringResult = null;
window.moneyJudgment = null;    // money_judgment from Prompt D, once the skills check runs

function activeHistory() { return window.mode === 'skills' ? skillsHistory : conversationHistory; }

// ─── BOOT ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const linkId = new URLSearchParams(location.search).get('s');
  let session;
  try {
    if (linkId) {
      // First open: exchange the opaque link id for an HttpOnly session cookie.
      const r = await fetch('/api/session/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ s: linkId })
      });
      const j = await r.json();
      if (!r.ok) {
        return showError(j.error === 'invalid or expired link'
          ? "This link has expired or isn't valid anymore. Ask for a fresh one."
          : (j.error || 'Could not start the session.'));
      }
      session = j;
      // Strip the id from the URL so it isn't left in the address bar / history.
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
  if (session.report_sent) {
    return showError("This check is already done — your result was shared the way you chose. Nice work.");
  }

  if (!linkId) {
    if (session.interview_complete) {
      return showError("This check is already complete.");
    }
    // Resume mid-interview from the SERVER-held transcript (the device no longer
    // stores it). If there are turns, rebuild and continue; otherwise start fresh.
    try {
      const r = await fetch('/api/interview/state');
      if (r.ok) {
        const st = await r.json();
        if (st.turns && st.turns.length) return resumeFromServer(st.turns);
      }
    } catch (e) { /* fall through to a fresh start */ }
  }
  startInterview();
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
  updateProgress({ q: Math.max(0, asst - 1), total: 16, phase: '' });
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
  if (h) h.textContent = window.session.teen_first_name + "’s Check";
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
  const total = p.total || 16;
  const q = Math.max(0, Math.min(p.q || 0, total));
  fill.style.width = Math.round((q / total) * 100) + '%';
  label.textContent = window.mode === 'skills'
    ? (p.phase || 'Scenarios') + ' · ' + q + ' of ' + total
    : (p.phase ? p.phase + ' · ' : '') + 'Q' + q + ' of ~' + total;
  wrap.style.display = 'flex';
}

// ─── SAFETY HANDLING ─────────────────────────────────────────────────────
// In-conversation behavior is interim-safe; the BACKEND routing (who is
// notified, escalation SOP, region-aware resources, the parent-may-be-unsafe
// path) is step 7 and is NOT built. reportSafetyEvent is the seam for it.
function handleSafety(flag) {
  window.safetyEvent = flag;
  // Purge the transcript from the device NOW for serious flags, so the
  // disclosure can't be reopened on a shared/parent device. saveSession() also
  // refuses to write once safetyEvent is CRISIS/ABUSE.
  if (flag === 'CRISIS' || flag === 'ABUSE') clearSession();
  showResources(flag);
  reportSafetyEvent(flag);

  if (flag === 'CRISIS') {
    window.halted = true;
    window.blockParentReport = true;
    disableInputPermanently('Paused. The most important thing right now is talking to someone who can help — the options above are there for you.');
  } else if (flag === 'ABUSE') {
    // The server has closed this session — it will never produce a parent report,
    // and further turns are refused. Surface resources and stop here.
    window.halted = true;
    window.blockParentReport = true;
    disableInputPermanently('This is a good place to pause. The people and numbers above can actually help with what you’re carrying.');
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
    renderResult(data.result);
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

  // Reordered so the teen feels UNDERSTOOD before EVALUATED — goal, strength,
  // unlock, and the move come first; the stage/bars/evidence are support below.

  // 1) Their goal, reflected back.
  root.appendChild(elem('h1', 'result-h1', name + ", here's where you are"));
  if (t.goal_reflected) {
    const m = elem('p', 'mirror');
    appendTextWithLineBreaks(m, t.goal_reflected);
    root.appendChild(m);
  }

  // 2) What you've already got (strength + verbatim quote).
  const strength = t.demonstrated_strength;
  if (strength && strength.text) {
    const sec = section('What you’ve already got');
    sec.appendChild(para(strength.text));
    if (strength.evidence_quote) sec.appendChild(elem('blockquote', 'evidence', '“' + strength.evidence_quote + '”'));
    root.appendChild(sec);
  }

  // 3) Biggest unlock.
  const unlock = t.biggest_unlock;
  if (unlock && (unlock.skill || unlock.framing)) {
    const sec = section('Your biggest unlock' + (unlock.skill ? ': ' + unlock.skill : ''));
    if (unlock.framing) sec.appendChild(para(unlock.framing));
    root.appendChild(sec);
  }

  // 4) Seven-day move.
  if (t.seven_day_move) {
    const sec = section('This week', 'move');
    sec.appendChild(para(t.seven_day_move));
    root.appendChild(sec);
  }

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

  // 7) Optional skills check — offered once.
  if (!window.blockParentReport && !window.moneyJudgment && !window.skillsComplete) {
    const card = elem('div', 'skills-optin');
    card.appendChild(elem('div', 'skills-optin-title', 'Want a sharper read?'));
    card.appendChild(elem('p', 'skills-optin-text', 'Answer five quick real-life money scenarios — about three minutes — and I’ll fold a money-decision read into your result.'));
    const sBtn = elem('button', 'btn btn-primary skills-optin-btn', 'Sharpen my read →');
    sBtn.addEventListener('click', startSkills);
    card.appendChild(sBtn);
    root.appendChild(card);
  }

  // 8) High-scorer pathway.
  if (t.high_scorer_pathway) {
    const sec = section('Where this can go', 'pathway');
    sec.appendChild(para(t.high_scorer_pathway));
    root.appendChild(sec);
  }

  // 9) Two ways forward — both are real, clickable controls.
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

  // 10) Save-as-PDF keepsake.
  const pdfBtn = elem('button', 'btn btn-ghost result-pdf', '⤓  Save my result as a PDF');
  pdfBtn.addEventListener('click', downloadResultPDF);
  root.appendChild(pdfBtn);

  // 11) Sharing CTA.
  const parent = window.session.parent_first_name;
  if (window.blockParentReport) {
    root.appendChild(elem('div', 'next-note', 'Nothing from this goes to ' + parent + '. This result is just for you.'));
  } else {
    const cta = elem('button', 'btn btn-primary result-cta', 'Next: choose what ' + parent + ' sees →');
    cta.addEventListener('click', showPreview);
    root.appendChild(cta);
  }

  scrollResultTop();
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
  wrap.appendChild(elem('div', 'mj-title', 'Money decisions — from your scenarios'));
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
  window.previewItems = items;
  showScreen('preview');
  renderPreview(draft);
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
  sr.appendChild(srInput);
  root.appendChild(sr);

  const send = elem('button', 'btn btn-primary pv-send', 'Send to ' + parent);
  send.addEventListener('click', sendParentReport);
  const skip = elem('button', 'btn btn-ghost pv-skip', 'Don’t send anything');
  skip.addEventListener('click', () => renderSent(false));
  const row = elem('div', 'pv-send-row');
  row.appendChild(send); row.appendChild(skip);
  root.appendChild(row);

  const s = document.getElementById('screen-preview');
  if (s) s.scrollTop = 0;
}

function buildPreviewItem(item) {
  if (item.evidence_quote && item.includeQuote === undefined) item.includeQuote = true;
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
    money_judgment: 'Your money judgment',
    growth_horizon: 'Where you are → where you could be',
    confidence: 'How solid this read is',
    program_fit: 'How OTS could help'
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
function showOtsPath() {
  const panel = document.getElementById('otsPanel');
  if (!panel) return;
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  const pf = (window.scoringResult && window.scoringResult.parent_report_draft && window.scoringResult.parent_report_draft.program_fit) || {};
  const lessons = Array.isArray(pf.lessons) ? pf.lessons : [];
  panel.innerHTML = '';
  panel.appendChild(elem('div', 'ots-panel-title', 'Your Outsmart the System path'));
  if (lessons.length) {
    panel.appendChild(elem('p', 'ots-panel-text', 'Based on your result, your first skills would be:'));
    const ul = document.createElement('ul'); ul.className = 'ots-lessons';
    lessons.forEach(l => { const li = document.createElement('li'); li.textContent = l; ul.appendChild(li); });
    panel.appendChild(ul);
  } else {
    panel.appendChild(elem('p', 'ots-panel-text', 'A guided system for turning what you just saw into real skills — at your pace, with your goal at the center.'));
  }
  const link = document.createElement('a');
  link.className = 'btn btn-primary ots-link';
  link.href = 'https://outsmartthesystem.org';
  link.target = '_blank'; link.rel = 'noopener';
  link.textContent = 'See the program →';
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
    buildResultPdfDoc().save('OTS-Teen-Check-' + safeName + '.pdf');
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
  const L = 18, R = 192, W = R - L, PT = 0.3528;
  let y = 24;

  function block(str, o) {
    o = o || {};
    const size = o.size || 11;
    doc.setFont('helvetica', o.bold ? 'bold' : (o.italic ? 'italic' : 'normal'));
    doc.setFontSize(size);
    const c = o.color || [26, 26, 26];
    doc.setTextColor(c[0], c[1], c[2]);
    const lines = doc.splitTextToSize(String(str), W);
    doc.text(lines, L, y);
    y += lines.length * size * PT * 1.2 + (o.after == null ? 4 : o.after);
  }

  block('OUTSMART THE SYSTEM  ·  TEEN CHECK', { size: 8, color: [47, 109, 240], after: 2 });
  block(window.session.teen_first_name, { size: 24, bold: true, after: 2 });
  if (t.stage_display) block(t.stage_display, { size: 11, bold: true, color: [47, 109, 240], after: 4 });
  if (t.goal_reflected) block(t.goal_reflected, { size: 12.5, color: [47, 74, 122], after: 7 });

  (t.bars || []).forEach(function (b) {
    const rowY = y;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(85, 85, 85);
    doc.text(String(b.dimension), L, rowY + 1.6);
    const tx = L + 50, tw = 104, th = 3.4, ty = rowY - 1.2;
    doc.setFillColor(236, 236, 236); doc.roundedRect(tx, ty, tw, th, 1.7, 1.7, 'F');
    if (b.score != null) {
      const w = Math.max(2, clamp(b.score, 0, 5) / 5 * tw);
      doc.setFillColor(47, 109, 240); doc.roundedRect(tx, ty, w, th, 1.7, 1.7, 'F');
      doc.setFont('helvetica', 'bold'); doc.setTextColor(26, 26, 26);
      doc.text(String(b.score), tx + tw + 4, rowY + 1.6);
    } else {
      doc.setFontSize(8); doc.setTextColor(170, 170, 170);
      doc.text('not enough info yet', tx + 3, rowY + 1.3);
    }
    y += 7.5;
  });
  y += 3;

  const s = t.demonstrated_strength;
  if (s && s.text) {
    block('WHAT YOU’VE ALREADY GOT', { size: 9, bold: true, color: [120, 120, 120], after: 2 });
    block(s.text, { size: 11, after: s.evidence_quote ? 2.5 : 6 });
    if (s.evidence_quote) block('“' + s.evidence_quote + '”', { size: 10, italic: true, color: [70, 70, 70], after: 6 });
  }
  const u = t.biggest_unlock;
  if (u && (u.skill || u.framing)) {
    block('YOUR BIGGEST UNLOCK' + (u.skill ? ': ' + String(u.skill).toUpperCase() : ''), { size: 9, bold: true, color: [120, 120, 120], after: 2 });
    if (u.framing) block(u.framing, { size: 11, after: 6 });
  }
  if (t.seven_day_move) {
    block('THIS WEEK', { size: 9, bold: true, color: [83, 150, 110], after: 2 });
    block(t.seven_day_move, { size: 11, after: 6 });
  }

  doc.setDrawColor(225, 225, 225); doc.line(L, 283, R, 283);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(150, 150, 150);
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  doc.text('outsmartthesystem.org  ·  ' + date, L, 289);
  return doc;
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
  if (window.safetyEvent === 'CRISIS' || window.safetyEvent === 'ABUSE') return;
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
    if (state.safetyEvent === 'CRISIS' || state.safetyEvent === 'ABUSE') { clearSession(); return null; }
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
  // US resources per Prompt A. Region-aware list is step 7. Never described as
  // "private" or "anonymous"; never promises confidentiality.
  div.innerHTML =
    '<strong>If you’re carrying something heavy</strong>' +
    '<p>You can call or text <b>988</b> (Suicide &amp; Crisis Lifeline) any time — it’s free and trained people answer. ' +
    'You can also chat at <b>988lifeline.org</b>. If you might be in immediate danger, call <b>911</b>.</p>';
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
  ['loading', 'error', 'resume', 'chat', 'result', 'preview', 'sent'].forEach(s => {
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
    input.addEventListener('input', () => autoResize(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }
});
