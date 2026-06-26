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
  eq(srv.phaseFor(1), 'Getting started');
  eq(srv.phaseFor(4), 'What you want');
  eq(srv.phaseFor(9), 'Your money reality');
  eq(srv.phaseFor(15), 'Patterns & your move');
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

// ───────────────── buildParentEmail (Family Handshake) ─────────────────
test('buildParentEmail: support pulled into the Handshake, not the item list', () => {
  const report = {
    shareable_items: [
      { id: 's1', category: 'what_matters', text: 'goal', evidence_quote: null },
      { id: 'sr1', category: 'support_request', text: 'give me options first', evidence_quote: null }
    ],
    fixed_framing: { limitation: 'snapshot' },
    parent_action: 'ask about pricing',
    conversation_starter: 'What money thing are you figuring out?'
  };
  const email = srv.buildParentEmail(report, 'Sam', 'Jay');
  ok(email.subject && email.html && email.text, 'returns subject/html/text');
  ok(email.html.includes('A Family Handshake'), 'handshake block present');
  ok(email.html.includes('give me options first'), 'support text in handshake');
  ok(email.html.includes('What money thing are you figuring out?'), 'conversation starter present');
  // support_request should NOT also appear as a generic labelled item
  ok(!email.html.includes('How they'), 'support not duplicated as a generic item');
});

(async () => {
  for (const t of queue) {
    try { await t.fn(); console.log('  ✓ ' + t.name); pass++; }
    catch (e) { console.log('  ✗ ' + t.name + '\n      ' + (e && e.message)); fail++; }
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
