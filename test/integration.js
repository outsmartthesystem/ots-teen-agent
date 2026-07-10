// HTTP integration tests for the security-critical trust/consent flows (go-live
// hardening PRs A + B). Boots the exported Express app on an ephemeral port and
// drives it over real HTTP with the in-memory store. No model/webhook calls are
// exercised, so no network access or API keys are needed.
//   node test/integration.js   (run WITHOUT DATABASE_URL)
'use strict';
delete process.env.DATABASE_URL; // force the in-memory backend
const assert = require('assert');
const { app } = require('../server');
const db = require('../db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); pass++; }
  catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; }
}
function cookieFrom(res) { const sc = res.headers.get('set-cookie') || ''; const m = sc.match(/ots_sid=[^;]*/); return m ? m[0] : ''; }
const REG = { parent_first_name: 'P', parent_email: 'p@x.com', teen_first_name: 'T', teen_age: 15, consent: true };

(async () => {
  await db.init();
  const server = app.listen(0);
  const B = 'http://localhost:' + server.address().port;
  const post = (path, body, cookie) => fetch(B + path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: JSON.stringify(body || {}) });
  const get = (path, cookie) => fetch(B + path, { headers: cookie ? { Cookie: cookie } : {} });
  const tokenOf = async (res) => new URL((await res.json()).teen_url).searchParams.get('i');

  await t('one-time invite: link carries a token (not a session id), claim once, then 410', async () => {
    const token = await tokenOf(await post('/api/register', REG));
    assert.ok(token, 'invite token present in the link');
    const s1 = await post('/api/session/start', { i: token });
    assert.strictEqual(s1.status, 200, 'first claim ok');
    assert.ok(cookieFrom(s1), 'cookie set to the session id (never in the link)');
    const s2 = await post('/api/session/start', { i: token });
    assert.strictEqual(s2.status, 410, 'second claim of the same link -> 410');
  });

  await t('register rejects 18+ and missing consent', async () => {
    const adult = await post('/api/register', Object.assign({}, REG, { teen_age: 19 }));
    assert.strictEqual(adult.status, 400, '18+ rejected at register');
    const noConsent = await post('/api/register', { parent_first_name: 'P', parent_email: 'p@x.com', teen_first_name: 'T', teen_age: 15 });
    assert.strictEqual(noConsent.status, 400, 'missing consent rejected');
  });

  await t('age gate: interview turn 409s until confirmed; adult confirm purges the session', async () => {
    const token = await tokenOf(await post('/api/register', REG));
    const cookie = cookieFrom(await post('/api/session/start', { i: token }));
    const turn = await post('/api/interview/turn', {}, cookie);
    assert.strictEqual(turn.status, 409, 'no interview turn before age is confirmed');
    const adult = await (await post('/api/session/confirm-age', { age: 20 }, cookie)).json();
    assert.strictEqual(adult.ok, false, 'adult routed out');
    assert.strictEqual((await get('/api/session', cookie)).status, 401, 'adult session purged');
  });

  await t('under-13 confirm purges the session (COPPA)', async () => {
    const token = await tokenOf(await post('/api/register', REG));
    const cookie = cookieFrom(await post('/api/session/start', { i: token }));
    const kid = await (await post('/api/session/confirm-age', { age: 11 }, cookie)).json();
    assert.strictEqual(kid.ok, false, 'under-13 routed out');
    assert.strictEqual((await get('/api/session', cookie)).status, 401, 'under-13 session purged');
  });

  await t('decline is durable: parent-report is blocked (mirror-200, not a 500 send attempt)', async () => {
    const token = await tokenOf(await post('/api/register', REG));
    const cookie = cookieFrom(await post('/api/session/start', { i: token }));
    await post('/api/session/confirm-age', { age: 15 }, cookie);
    assert.strictEqual((await post('/api/share/decline', {}, cookie)).status, 200, 'decline ok');
    // The sharing_status guard fires BEFORE the webhook check; if it were missing,
    // an unconfigured webhook would 500. A 200 mirror proves the block held.
    const pr = await post('/api/parent-report', { selections: [] }, cookie);
    assert.strictEqual(pr.status, 200, 'declined session cannot send (blocked, mirrored)');
  });

  await t('privacy delete removes the session', async () => {
    const token = await tokenOf(await post('/api/register', REG));
    const cookie = cookieFrom(await post('/api/session/start', { i: token }));
    assert.strictEqual((await post('/api/privacy/delete', {}, cookie)).status, 200, 'delete ok');
    assert.strictEqual((await get('/api/session', cookie)).status, 401, 'session gone after delete');
  });

  await t('health reports beta mode and ok', async () => {
    const h = await (await get('/api/health')).json();
    assert.strictEqual(h.mode, 'beta', 'default mode is beta');
    assert.strictEqual(h.ok, true, 'health ok');
  });

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
