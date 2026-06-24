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
const SAFETY_SENTINEL_RE = /\[SAFETY_EVENT:(CRISIS|ABUSE|SUPPORT)\]/;
const TOTAL_QUESTIONS = 16;
const SESSION_KEY = 'ots_teen_session_v1';
const SESSION_MAX_AGE_HOURS = 24;
const SEED_MARKER = '__SEED_BEGIN__';           // hidden first user turn that triggers the opening frame

// ─── STATE ───────────────────────────────────────────────────────────────
const conversationHistory = []; // [{ role: 'user'|'assistant', content }]
window.session = null;          // { teen_first_name, teen_age, teen_age_plus_3, parent_first_name }
window.rawToken = null;
window.safetyEvent = null;      // null | 'CRISIS' | 'ABUSE' | 'SUPPORT'
window.halted = false;          // hard stop (CRISIS): no more turns, no scoring
window.blockParentReport = false; // CRISIS or ABUSE: this session never produces a parent report
window.interviewComplete = false;
window.scoringResult = null;

// ─── BOOT ────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  const token = new URLSearchParams(location.search).get('t');
  if (!token) {
    return showError("This link is missing its access code. Ask whoever set this up to send you the full link — it should end with <code>/?t=…</code>");
  }
  window.rawToken = token;

  let session;
  try {
    const r = await fetch('/api/session?t=' + encodeURIComponent(token));
    const j = await r.json();
    if (!r.ok) {
      return showError(j.error === 'invalid or expired token'
        ? "This link has expired or isn't valid anymore. Ask for a fresh one."
        : (j.error || 'Could not start the session.'));
    }
    session = j;
  } catch (e) {
    return showError("Couldn't reach the server. Check your connection and reload.");
  }
  window.session = session;

  // Offer to resume an in-progress session for this exact token.
  const saved = loadSession();
  if (saved && saved.token === token) {
    return showResume(saved);
  }
  startInterview();
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

// ─── START / RESUME ──────────────────────────────────────────────────────
function startInterview() {
  showScreen('chat');
  setHeading();
  // Seed a hidden first user turn so the model produces its opening frame.
  conversationHistory.push({ role: 'user', content: SEED_MARKER });
  getAssistantTurn();
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
  conversationHistory.push({ role: 'user', content: text });
  getAssistantTurn();
}

// ─── CORE TURN: call the model, handle sentinels, render, persist ────────
async function getAssistantTurn() {
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;

  const thinking = addThinking();

  // Anchor the model to the numbered question without leaking scoring intent.
  // Inject a neutral progress note into the last real user turn (not the seed),
  // then restore the clean text after a successful response.
  const lastIdx = conversationHistory.length - 1;
  const lastTurn = conversationHistory[lastIdx];
  const isSeed = lastTurn && lastTurn.content === SEED_MARKER;
  let cleanUserText = null;
  if (lastTurn && lastTurn.role === 'user' && !isSeed && !window.interviewComplete) {
    cleanUserText = lastTurn.content;
    const q = estimateQuestion();
    conversationHistory[lastIdx] = {
      role: 'user',
      content: `[Internal note for the interviewer: you're around Q${q} of ${TOTAL_QUESTIONS}. Acknowledge this answer neutrally in 1–2 sentences, then ask the next single question in order. Honor skips. Do not score, rate, or praise. Watch for safety.]\n\n${cleanUserText}`
    };
  }

  const system = buildInterviewSystemPrompt();

  try {
    let data = null, attempts = 0;
    const maxAttempts = 4;
    while (attempts < maxAttempts) {
      attempts++;
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL_INTERVIEW,
          max_tokens: 1200,
          system,
          messages: getApiMessages()
        })
      });
      data = await response.json();

      if (data.error && data.error.type === 'rate_limit_error' && attempts < maxAttempts) {
        thinking.setText('One sec — catching my breath…');
        await wait(attempts * 15000);
        continue;
      }
      break;
    }

    if (!data || !data.content || !data.content[0]) {
      throw new Error('Bad response: ' + JSON.stringify(data).slice(0, 300));
    }

    // Restore the clean user text now that the call succeeded.
    if (cleanUserText !== null) {
      conversationHistory[lastIdx] = { role: 'user', content: cleanUserText };
    }

    const raw = data.content[0].text;
    thinking.remove();

    // SAFETY FIRST — a safety sentinel overrides completion in every case.
    const safety = raw.match(SAFETY_SENTINEL_RE);
    const hasComplete = raw.includes(COMPLETE_SENTINEL);

    let displayText = raw.replace(SAFETY_SENTINEL_RE, '').split(COMPLETE_SENTINEL).join('').trim();

    conversationHistory.push({ role: 'assistant', content: displayText });
    renderAssistantMessage(displayText);

    if (safety) {
      handleSafety(safety[1]);
      saveSession();
      reEnableInput();
      return;
    }

    saveSession();

    if (hasComplete && !window.halted && !window.blockParentReport) {
      handleComplete();
      return;
    }

    reEnableInput();
  } catch (error) {
    thinking.remove();
    if (cleanUserText !== null) conversationHistory[lastIdx] = { role: 'user', content: cleanUserText };
    addMessage('Hit a small snag. Type your last message again and we’ll pick right back up.', 'system');
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

// ─── SAFETY HANDLING ─────────────────────────────────────────────────────
// In-conversation behavior is interim-safe; the BACKEND routing (who is
// notified, escalation SOP, region-aware resources, the parent-may-be-unsafe
// path) is step 7 and is NOT built. reportSafetyEvent is the seam for it.
function handleSafety(flag) {
  window.safetyEvent = flag;
  showResources(flag);
  reportSafetyEvent(flag);

  if (flag === 'CRISIS') {
    window.halted = true;
    window.blockParentReport = true;
    disableInputPermanently('Paused. The most important thing right now is talking to someone who can help — the options above are there for you.');
  } else if (flag === 'ABUSE') {
    // Never let an unsafe disclosure flow toward the parent. The session can
    // continue conversationally, but it will never produce a parent report.
    window.blockParentReport = true;
  }
  // SUPPORT: resources shown, interview may continue.
}

function reportSafetyEvent(flag) {
  // TODO (step 7 — safety backend): route to the human-escalation SOP.
  // Deliberately no parent-facing notification here.
  console.warn('[SAFETY_EVENT]', flag, '— backend routing not yet wired (step 7).');
}

// ─── COMPLETION → SCORING (Prompt B) ─────────────────────────────────────
function handleComplete() {
  window.interviewComplete = true;
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.disabled = true;
  if (input) input.disabled = true;
  saveSession();
  runScoring();
}

async function runScoring() {
  const status = addStatus('Putting your result together — about 30 seconds. Your answers are saved, so you won’t lose anything.');

  const transcript = buildTranscript();
  const system = window.PROMPT_B.split('{{TEEN_AGE}}').join(String(window.session.teen_age));

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL_SCORING,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: transcript }]
      })
    });
    const data = await response.json();
    if (!data || !data.content || !data.content[0]) throw new Error('Bad scoring response');

    const parsed = parseScoringJSON(data.content[0].text);
    status.remove();

    if (!parsed) throw new Error('Could not parse scoring JSON');

    // Scoring has its own STEP 0 safety pass — honor it.
    if (parsed.safety_check && parsed.safety_check.clear === false) {
      window.blockParentReport = true;
      showResources(parsed.safety_check.flag || 'SUPPORT');
      addStatus('Thanks for being honest with me. There’s no scored result here — what you shared matters more than that.');
      return;
    }

    window.scoringResult = parsed;
    renderResultStub(parsed); // STEP 3 replaces this with the full teen result + preview/veto
    console.log('SCORING RESULT (full):', parsed);
  } catch (e) {
    status.remove();
    addStatus('Your result hit a snag generating, but your answers are saved. Refresh in a minute and it’ll pick back up.');
    console.error('Scoring error:', e);
  }
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

// STEP-3 STUB: proves the A→complete→B pipeline. The real teen result (stage
// badge, five-bar chart, mirror/strength/unlock/seven-day-move/choice prose)
// and the preview/veto gate live in step 3.
function renderResultStub(parsed) {
  showScreen('result');
  const el = document.getElementById('resultBody');
  const stage = parsed.teen_output && parsed.teen_output.stage_display;
  const strength = parsed.teen_output && parsed.teen_output.demonstrated_strength;
  el.innerHTML = '';
  const pill = document.createElement('div');
  pill.className = 'result-pill';
  pill.textContent = 'Result generated ✓';
  el.appendChild(pill);
  const h = document.createElement('h2');
  h.textContent = window.session.teen_first_name + ", here's where you are";
  el.appendChild(h);
  if (stage) { const p = document.createElement('p'); p.className = 'result-stage'; p.textContent = 'Stage: ' + stage; el.appendChild(p); }
  if (strength && strength.text) { const p = document.createElement('p'); appendTextWithLineBreaks(p, strength.text); el.appendChild(p); }
  const note = document.createElement('p');
  note.className = 'result-note';
  note.textContent = 'The full result view and the parent-report preview/approve step are the next build step. The complete scored result is in the browser console.';
  el.appendChild(note);
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
  return conversationHistory.map(t => ({ role: t.role, content: t.content }));
}

function estimateQuestion() {
  // Each assistant turn after the opening frame ≈ one question asked.
  const assistantTurns = conversationHistory.filter(t => t.role === 'assistant').length;
  return Math.max(1, Math.min(assistantTurns, TOTAL_QUESTIONS));
}

// ─── SESSION PERSISTENCE ─────────────────────────────────────────────────
function saveSession() {
  if (!window.rawToken) return;
  const state = {
    token: window.rawToken,
    conversationHistory,
    safetyEvent: window.safetyEvent,
    blockParentReport: window.blockParentReport,
    interviewComplete: window.interviewComplete,
    savedAt: new Date().toISOString()
  };
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Could not save session:', e); }
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const state = JSON.parse(raw);
    if (!state.savedAt || !state.conversationHistory) return null;
    const ageH = (Date.now() - new Date(state.savedAt).getTime()) / 36e5;
    if (ageH > SESSION_MAX_AGE_HOURS) { clearSession(); return null; }
    if (state.interviewComplete) { clearSession(); return null; }
    if (state.safetyEvent === 'CRISIS') { clearSession(); return null; } // don't resume a crisis
    return state;
  } catch (e) { return null; }
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) {}
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
  ['loading', 'error', 'resume', 'chat', 'result'].forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.style.display = (s === name) ? 'flex' : 'none';
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

// Input wiring (Enter to send, Shift+Enter for newline).
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendButton');
  if (sendBtn) sendBtn.addEventListener('click', sendMessage);
  if (input) {
    input.addEventListener('input', () => autoResize(input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }
});
