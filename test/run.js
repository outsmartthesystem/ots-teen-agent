// Zero-dependency test suite for the security-critical pure logic.
//   npm test   (node test/run.js)  — requires deps installed (npm install).
// Run WITHOUT DATABASE_URL so the db uses its in-memory backend.
'use strict';
const assert = require('assert');
const db = require('../db');
const srv = require('../server'); // exported helpers; require.main guard => no listen

let pass = 0, fail = 0;
const queue = [];
const test = (name, fn) => queue.push({ name, fn });
const ok = (v, m) => assert.ok(v, m);
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);
let _n = 0; const nid = () => 'sess_test_' + (++_n);

// ─────────────────────────── db.js ───────────────────────────
test('db: create + get returns the row', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'Avi', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  const row = await db.getSession(id);
  ok(row && row.teen_first_name === 'Avi', 'row returned');
});
test('db: expired session returns null', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() - 1000 });
  eq(await db.getSession(id), null, 'expired -> null');
});
test('db: claimReportSend is one-time (atomic)', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  eq(await db.claimReportSend(id), true, 'first claim wins');
  eq(await db.claimReportSend(id), false, 'second claim loses');
});
test('db: claimReportSend refuses a safety-blocked session', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  await db.updateSession(id, { safety_blocked: true });
  eq(await db.claimReportSend(id), false, 'blocked -> no claim');
});
test('db: updateSession persists report_draft (only allowed fields)', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  await db.updateSession(id, { report_draft: { shareable_items: [{ id: 's1' }] }, parent_email: 'EVIL@x.com' });
  const row = await db.getSession(id);
  ok(row.report_draft && row.report_draft.shareable_items[0].id === 's1', 'draft stored');
  eq(row.parent_email, 'p@x.com', 'disallowed field (parent_email) not overwritten');
});

// ─── go-live hardening: invite / sharing / refine / delete ───────────────
test('db: one-time invite claim by token hash', async () => {
  const id = nid(); const hash = 'hash_' + id;
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000, invite_token_hash: hash });
  const c1 = await db.claimInvite({ tokenHash: hash });
  ok(c1 && c1.id === id, 'first claim returns the session row');
  eq(await db.claimInvite({ tokenHash: hash }), null, 'second claim by token fails (one-time)');
});
test('db: one-time invite claim by legacy session id', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  const c1 = await db.claimInvite({ sessionId: id });
  ok(c1 && c1.id === id, 'legacy first claim works');
  eq(await db.claimInvite({ sessionId: id }), null, 'legacy second claim fails (one-time)');
});
test('db: expired invite cannot be claimed', async () => {
  const id = nid(); const hash = 'h_' + id;
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() - 1000, invite_token_hash: hash });
  eq(await db.claimInvite({ tokenHash: hash }), null, 'expired -> null');
});
test('db: claimReportSend refuses a declined session', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  await db.updateSession(id, { sharing_status: 'declined' });
  eq(await db.claimReportSend(id), false, 'declined -> no send');
});
test('db: claimReportSend marks sharing_status sent, one-time', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  eq(await db.claimReportSend(id), true, 'first send wins');
  eq(await db.claimReportSend(id), false, 'second send loses (already sent)');
  const row = await db.getSession(id);
  eq(row.sharing_status, 'sent', 'status flipped to sent');
});
test('db: claimRefine caps refinements at max', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  eq(await db.claimRefine(id, 2), 1, 'first refine -> 1');
  eq(await db.claimRefine(id, 2), 2, 'second refine -> 2');
  eq(await db.claimRefine(id, 2), null, 'third refine capped -> null');
});
test('db: deleteSession removes the row', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 60000 });
  await db.deleteSession(id);
  eq(await db.getSession(id), null, 'deleted -> null');
});
test('db: deleteExpired purges an unshared finished result past the window', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 6e6 });
  await db.updateSession(id, { completed_at: new Date(Date.now() - 10 * 864e5) }); // finished 10 days ago, still pending
  await db.deleteExpired(7);
  eq(await db.getSession(id), null, 'stale unshared result purged');
});
test('db: deleteExpired keeps a recent unshared result', async () => {
  const id = nid();
  await db.createSession({ id, teen_first_name: 'A', teen_age: 15, parent_first_name: 'P', parent_email: 'p@x.com', expires_at: Date.now() + 6e6 });
  await db.updateSession(id, { completed_at: new Date() });
  await db.deleteExpired(7);
  ok(await db.getSession(id), 'recent unshared result kept');
});
test('db: claimPaymentSession is one-time per Stripe session id', async () => {
  const sid = 'cs_' + nid();
  eq(await db.claimPaymentSession(sid), true, 'first claim wins');
  eq(await db.claimPaymentSession(sid), false, 'reuse of same purchase loses');
  eq(await db.claimPaymentSession(''), false, 'empty id false');
});

// ─────────────────────── server helpers ──────────────────────
test('formatTranscript: labels, seed filtered, separator', () => {
  const turns = [{ role: 'user', content: '__SEED_BEGIN__' }, { role: 'assistant', content: 'Q1' }, { role: 'user', content: 'A1' }];
  const out = srv.formatTranscript(turns, 'TEEN', 'INTERVIEWER');
  ok(!out.includes('__SEED_BEGIN__'), 'seed filtered');
  ok(out.includes('INTERVIEWER:\nQ1'), 'assistant labelled');
  ok(out.includes('TEEN:\nA1'), 'user labelled');
});
test('stripUnverifiedQuotes: drops hallucinated, keeps real', () => {
  const transcript = 'TEEN:\nI set a target and saved up for it.\n\nINTERVIEWER:\nNice.';
  const parsed = {
    teen_output: { demonstrated_strength: { text: 's', evidence_quote: 'I set a target and saved up for it.' } },
    parent_report_draft: { shareable_items: [{ id: 's1', evidence_quote: 'a quote that never appears anywhere' }] }
  };
  srv.stripUnverifiedQuotes(parsed, transcript);
  ok(parsed.teen_output.demonstrated_strength.evidence_quote, 'real quote kept');
  eq(parsed.parent_report_draft.shareable_items[0].evidence_quote, null, 'fake quote dropped');
});
test('validScore: rejects 0/6/decimal, accepts 1-5/null', () => {
  [1, 2, 3, 4, 5, null].forEach(s => eq(srv.validScore(s), true, 'valid ' + s));
  [0, 6, 2.5, -1, '3'].forEach(s => eq(srv.validScore(s), false, 'invalid ' + s));
});
test('validateScoring: accepts valid, rejects malformed, honors safety', () => {
  const good = { safety_check: { clear: true }, scoring: { vision: { score: 4, confidence: 'high' } }, teen_output: { bars: [{ dimension: 'Vision', score: 4 }] } };
  eq(srv.validateScoring(good), true, 'valid passes');
  eq(srv.validateScoring({ safety_check: { clear: false, flag: 'CRISIS' } }), true, 'safety short-circuits');
  eq(srv.validateScoring({ safety_check: { clear: true }, teen_output: { bars: [] } }), false, 'empty bars fails');
  eq(srv.validateScoring({ safety_check: { clear: true }, teen_output: { bars: [{ dimension: 'V', score: 7 }] } }), false, 'bad bar score fails');
});
test('phaseFor: phase boundaries', () => {
  eq(srv.phaseFor(1), 'Arrival');
  eq(srv.phaseFor(4), 'What you want');
  eq(srv.phaseFor(12), 'The reality check');
  eq(srv.phaseFor(17), 'Family patterns');
  eq(srv.phaseFor(21), 'The gap');
});
test('computeScoreMetadata: 5 dims -> total + stage + canonical bars', () => {
  const p = { scoring: { vision:{score:4}, awareness:{score:3}, self_regulation:{score:4}, pattern_awareness:{score:3}, agency:{score:4} }, level:{}, profile:{}, teen_output:{ bars:[], stage_display:'' } };
  srv.computeScoreMetadata(p);
  eq(p.level.total, 18, 'total = sum of scores');
  eq(p.level.stage, 'Building', 'stage from band');
  eq(p.level.show_level, true, 'level shown when all 5 assessed');
  eq(p.teen_output.stage_display, 'Building', 'stage_display set');
  eq(p.teen_output.bars.length, 5, 'five bars');
  eq(p.teen_output.bars[2].dimension, 'Self-Regulation', 'canonical order');
  eq(p.profile.strongest_dimension, 'Vision', 'strongest = first highest');
});
test('computeScoreMetadata: <5 dims hides the level, preserves null bars', () => {
  const p = { scoring: { vision:{score:4}, awareness:{score:null}, self_regulation:{score:3}, pattern_awareness:{score:null}, agency:{score:4} }, level:{ show_level:true, total:11, stage:'Aware' }, profile:{}, teen_output:{ bars:[], stage_display:'Aware' } };
  srv.computeScoreMetadata(p);
  eq(p.level.show_level, false, 'partial level hidden');
  eq(p.level.total, null, 'no total');
  eq(p.teen_output.stage_display, '', 'stage_display cleared');
  eq(p.teen_output.bars[1].score, null, 'null bar preserved');
});
test('stageForTotal: band boundaries', () => {
  eq(srv.stageForTotal(9), 'Waking Up'); eq(srv.stageForTotal(10), 'Aware');
  eq(srv.stageForTotal(14), 'In Motion'); eq(srv.stageForTotal(18), 'Building');
  eq(srv.stageForTotal(22), 'Outsmarting');
});
test('QUESTION_REGISTRY: 22 questions, chips on the right ones, Q5 = goal', () => {
  eq(srv.QUESTION_REGISTRY.length, 22, '22 questions');
  eq(srv.QUESTION_REGISTRY.map(q => q.n).join(','), Array.from({ length: 22 }, (_, i) => i + 1).join(','), 'numbered 1..22');
  [2, 3, 10, 13, 17].forEach(n => ok(srv.QUESTION_REGISTRY[n - 1].chips, 'Q' + n + ' has chips'));
  ok(/matters most/.test(srv.QUESTION_REGISTRY[4].text), 'Q5 is the goal question');
});
test('parseInterviewMarker: ASKED / REPAIR / none', () => {
  eq(srv.parseInterviewMarker('hi [ASKED:Q7]').type, 'ASKED');
  eq(srv.parseInterviewMarker('hi [ASKED:Q7]').n, 7);
  eq(srv.parseInterviewMarker('x [REPAIR:Q3] y').type, 'REPAIR');
  eq(srv.parseInterviewMarker('no marker here'), null);
});
test('deterministicAnchor: injects question text + marker; age-substituted', () => {
  const a = srv.deterministicAnchor(1, null, 14);
  ok(a.includes('[ASKED:Q1]'), 'marker present');
  ok(a.includes('14'), 'age substituted into Q1');
  ok(!a.includes('{{AGE}}'), 'placeholder replaced');
});
test('paid-pass: valid round-trips w/ session id; tamper + expiry + malformed rejected', () => {
  const good = srv.signPaidPass(Date.now() + 60000, 'cs_test_abc');
  eq(srv.verifyPaidPass(good).ok, true, 'fresh pass valid');
  eq(srv.verifyPaidPass(good).sessionId, 'cs_test_abc', 'session id round-trips');
  eq(srv.verifyPaidPass(good + 'x').ok, false, 'tampered sig rejected');
  eq(srv.verifyPaidPass(srv.signPaidPass(Date.now() - 1000, 'cs_x')).ok, false, 'expired rejected');
  eq(srv.verifyPaidPass('').ok, false, 'empty rejected');
  eq(srv.verifyPaidPass('nodelim').ok, false, 'malformed rejected');
});
test('sessionEntitles: paid entitling product unlocks; wrong product / unpaid rejected', () => {
  const map = { payment_status: 'paid', line_items: { data: [{ price: { product: 'prod_MAP' } }] } };
  const other = { payment_status: 'paid', line_items: { data: [{ price: { product: 'prod_OTHER' } }] } };
  const unpaid = { payment_status: 'unpaid', line_items: { data: [{ price: { product: 'prod_MAP' } }] } };
  eq(srv.sessionEntitles(map, ['prod_MAP', 'prod_SH']), true, 'map product entitles');
  eq(srv.sessionEntitles(other, ['prod_MAP', 'prod_SH']), false, 'non-entitling product rejected');
  eq(srv.sessionEntitles(unpaid, ['prod_MAP']), false, 'unpaid rejected');
  eq(srv.sessionEntitles(map, []), true, 'no restriction -> any paid session');
});
test('parseScoringJSON: fenced, plain, garbage', () => {
  eq(srv.parseScoringJSON('```json\n{"a":1}\n```').a, 1, 'fenced');
  eq(srv.parseScoringJSON('noise {"a":2} trailing').a, 2, 'embedded');
  eq(srv.parseScoringJSON('not json at all'), null, 'garbage -> null');
});

// ───────────── buildApprovedItems (forgery resistance) ──────────────
const DRAFT = {
  shareable_items: [
    { id: 's1', category: 'what_matters', text: 'goal', evidence_quote: 'my real words' },
    { id: 's2', category: 'strength', text: 'strength', evidence_quote: 'another real quote' }
  ],
  growth_horizon: 'where you could be',
  program_fit: { text: 'OTS fit' }
};
test('buildApprovedItems: forged id is ignored', () => {
  const items = srv.buildApprovedItems(DRAFT, [{ id: 'FORGED', include: true, text: 'INJECTED' }], '');
  eq(items.length, 0, 'forged id produces no item');
});
test('buildApprovedItems: only included stored ids appear', () => {
  const items = srv.buildApprovedItems(DRAFT, [{ id: 's1', include: true }, { id: 's2', include: false }], '');
  eq(items.map(i => i.id), ['s1'], 's1 in, s2 out');
});
test('buildApprovedItems: includeQuote=false nulls the quote', () => {
  const items = srv.buildApprovedItems(DRAFT, [{ id: 's1', include: true, includeQuote: false }], '');
  eq(items[0].evidence_quote, null, 'quote suppressed');
});
test('buildApprovedItems: top-level fields (gh1) selectable; support_request added', () => {
  const items = srv.buildApprovedItems(DRAFT, [{ id: 'gh1', include: true }], 'help me set up the account');
  ok(items.some(i => i.id === 'gh1'), 'gh1 included from growth_horizon');
  ok(items.some(i => i.id === 'sr1' && i.category === 'support_request'), 'support added as sr1');
});

// ───────── pa1/cq1 into the teen veto (go-live hardening TRUST-2) ─────────
test('buildApprovedItems: pa1/cq1 ride the veto — kept only when included', () => {
  const draft = { shareable_items: [{ id: 's1', category: 'what_matters', text: 'g', evidence_quote: null }], parent_action: 'do X', conversation_starter: 'ask Y' };
  const kept = srv.buildApprovedItems(draft, [{ id: 's1', include: true }, { id: 'pa1', include: true }, { id: 'cq1', include: false }], '');
  ok(kept.some(i => i.id === 'pa1' && i.category === 'parent_action'), 'pa1 kept when included');
  ok(!kept.some(i => i.id === 'cq1'), 'cq1 excluded when toggled private');
});

// ───────────────── buildParentEmail (Family Handshake) ─────────────────
test('buildParentEmail: Handshake renders sr1/pa1/cq1 from approved items only', () => {
  const report = {
    shareable_items: [
      { id: 's1', category: 'what_matters', text: 'goal', evidence_quote: null },
      { id: 'sr1', category: 'support_request', text: 'give me options first', evidence_quote: null },
      { id: 'pa1', category: 'parent_action', text: 'walk through one real bill', evidence_quote: null },
      { id: 'cq1', category: 'conversation_starter', text: 'What money thing are you figuring out?', evidence_quote: null }
    ],
    fixed_framing: { limitation: 'snapshot' }
  };
  const email = srv.buildParentEmail(report, 'Sam', 'Jay');
  ok(email.subject && email.html && email.text, 'returns subject/html/text');
  ok(email.html.includes('A Family Handshake'), 'handshake block present');
  ok(email.html.includes('give me options first'), 'support text in handshake');
  ok(email.html.includes('walk through one real bill'), 'parent action in handshake');
  ok(email.html.includes('What money thing are you figuring out?'), 'conversation starter in handshake');
  // sr1/pa1/cq1 must NOT also render as generic labelled items — only s1 does.
  const genericCount = (email.html.match(/border-left:3px solid #2f6df0/g) || []).length;
  eq(genericCount, 1, 'only the one generic item (what_matters) in the list');
});
test('buildParentEmail: no Handshake when nothing was approved for it', () => {
  const report = { shareable_items: [{ id: 's1', category: 'what_matters', text: 'goal', evidence_quote: null }], fixed_framing: {} };
  const email = srv.buildParentEmail(report, 'Sam', 'Jay');
  ok(!email.html.includes('A Family Handshake'), 'no handshake when pa1/cq1/sr1 all absent');
});

// ───────────── safety taxonomy + enriched responder alert (SOP review) ─────────────
test('SAFETY taxonomy: sentinel + flag sets cover CRISIS/ABUSE/EXPLOITATION/THREAT/SUPPORT', () => {
  ['CRISIS', 'ABUSE', 'EXPLOITATION', 'THREAT', 'SUPPORT'].forEach(f =>
    ok(srv.SAFETY_SENTINEL_RE.test('x [SAFETY_EVENT:' + f + '] y'), f + ' sentinel matches'));
  ['CRISIS', 'ABUSE', 'EXPLOITATION', 'THREAT'].forEach(f => {
    ok(srv.SAFETY_EMAIL_FLAGS.has(f), f + ' emails a responder');
    ok(srv.SAFETY_BLOCK_FLAGS.has(f), f + ' blocks the parent report');
  });
  ['SUPPORT', 'DISTRESS'].forEach(f => {
    ok(srv.SAFETY_FLAGS.has(f), f + ' is a known flag');
    ok(!srv.SAFETY_EMAIL_FLAGS.has(f), f + ' does NOT page a responder (no alert fatigue)');
    ok(!srv.SAFETY_BLOCK_FLAGS.has(f), f + ' does NOT block the report');
  });
});
test('buildSafetyEmail: EXPLOITATION — sextortion class, do-not-contact, removal resources, enriched payload', () => {
  const e = srv.buildSafetyEmail('EXPLOITATION', { teen_first_name: 'Avi', teen_age: 16, sid: 'sess_x', event_id: 'ab12cd', created_at: '2026-07-09T20:14:33Z' });
  ok(/EXPLOITATION_SEXTORTION/.test(e.subject), 'granular class in subject');
  ok(/Event ab12cd/.test(e.subject), 'event id in subject');
  ok(/The parent who set this up may be the concern/i.test(e.html), 'do-not-contact banner');
  ok(/takeitdown\.ncmec\.org/i.test(e.html) && /CyberTipline/i.test(e.html), 'image-removal + reporting resources');
  ok(e.text.includes('Severity: high') && e.text.includes('Interview state: halted') && e.text.includes('Parent report state: blocked'), 'text payload carries severity + states');
});
test('buildSafetyEmail: THREAT — threat-to-others class, supervisor escalation (not abuse banner)', () => {
  const e = srv.buildSafetyEmail('THREAT', { teen_first_name: 'Sam', teen_age: 15, sid: 'sess_y', event_id: 'ff00aa' });
  ok(/CRISIS_THREAT_TO_OTHERS/.test(e.subject), 'threat-to-others class in subject');
  ok(/Escalate to a supervisor/i.test(e.html), 'supervisor escalation banner');
  ok(!/The parent who set this up may be the concern/i.test(e.html), 'not the abuse do-not-contact banner');
});
test('buildSafetyEmail: redaction — no teen disclosure/transcript field ever leaks into the alert', () => {
  const e = srv.buildSafetyEmail('CRISIS', { teen_first_name: 'Kai', teen_age: 15, sid: 's', event_id: 'e', disclosure: 'SECRET_TEEN_WORDS', transcript: 'SECRET_TEEN_WORDS' });
  ok(!/SECRET_TEEN_WORDS/.test(e.html) && !/SECRET_TEEN_WORDS/.test(e.text), 'no quotes/transcript in the alert');
  ok(/CRISIS_SELF_HARM/.test(e.subject), 'self-harm gets its own granular class');
});

test('scoringSafetyFlag: recognized flags honored; missing/garbled fails CLOSED to CRISIS', () => {
  eq(srv.scoringSafetyFlag({ clear: false, flag: 'EXPLOITATION' }), 'EXPLOITATION', 'explicit serious flag honored');
  eq(srv.scoringSafetyFlag({ clear: false, flag: 'distress' }), 'DISTRESS', 'recognized non-blocking flag preserved (case-insensitive)');
  eq(srv.scoringSafetyFlag({ clear: false, flag: null }), 'CRISIS', 'missing flag -> CRISIS (fail closed, blocks report)');
  eq(srv.scoringSafetyFlag({ clear: false, flag: 'weird_thing' }), 'CRISIS', 'unrecognized flag -> CRISIS (fail closed)');
  eq(srv.scoringSafetyFlag({}), 'CRISIS', 'absent flag -> CRISIS');
  ok(srv.SAFETY_BLOCK_FLAGS.has(srv.scoringSafetyFlag({ flag: 'garbage' })), 'the fail-closed default actually blocks the report');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); pass++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + (e && e.message)); fail++; }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
