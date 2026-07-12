// Replay harness for the deterministic interview path (D1). Boots the app with
// DETERMINISTIC_INTERVIEW=true and a STUBBED model that echoes the server-anchored
// [ASKED:Qn] marker, then drives a full interview and asserts the server served
// Q1..Q12 in order (no repeats/skips), surfaced chips on the right questions,
// pinned the goal after the goal question, stripped the markers, and completed.
//   node test/interview-deterministic.js   (run WITHOUT DATABASE_URL)
'use strict';
delete process.env.DATABASE_URL;
process.env.DETERMINISTIC_INTERVIEW = 'true';
process.env.ANTHROPIC_API_KEY = 'test-key';

// Stub node-fetch (before requiring server) so the "model" echoes [ASKED:Qn].
const Module = require('module');
const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'node-fetch') {
    return function mockFetch(url, opts) {
      if (String(url).includes('api.anthropic.com')) {
        let text = 'Hey — you good to start? Ready?';
        try {
          const body = JSON.parse(opts.body);
          const users = body.messages.filter(m => m.role === 'user');
          const last = users.length ? users[users.length - 1].content : '';
          const m = String(last).match(/\[ASKED:Q(\d+)\]/);
          if (m) text = 'Alright — here is question ' + m[1] + '. [ASKED:Q' + m[1] + ']';
        } catch (e) {}
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ content: [{ text }] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    };
  }
  return origLoad.apply(this, arguments);
};

const assert = require('assert');
const srv = require('../server');
const app = srv.app;
const db = require('../db');

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); console.log('  ✓ ' + name); pass++; } catch (e) { console.log('  ✗ ' + name + '\n      ' + (e && e.message)); fail++; } }
function cookieFrom(res) { const sc = res.headers.get('set-cookie') || ''; const m = sc.match(/ots_sid=[^;]*/); return m ? m[0] : ''; }

(async () => {
  await db.init();
  const server = app.listen(0);
  const B = 'http://localhost:' + server.address().port;
  const post = (path, body, cookie) => fetch(B + path, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: JSON.stringify(body || {}) });

  await t('deterministic interview serves Q1..Q12 in order, with chips + goal + completion, markers stripped', async () => {
    const reg = await post('/api/register', { parent_first_name: 'P', parent_email: 'p@x.com', teen_first_name: 'T', teen_age: 15, consent: true });
    const token = new URL((await reg.json()).teen_url).searchParams.get('i');
    const cookie = cookieFrom(await post('/api/session/start', { i: token }));
    await post('/api/session/confirm-age', { age: 15 }, cookie);

    // Seed turn (opening frame, no question yet).
    await post('/api/interview/turn', {}, cookie);

    const served = []; const chipsAt = {}; let goalSeen = false; let completed = false;
    for (let i = 0; i < 25; i++) {
      const data = await (await post('/api/interview/turn', { answer: 'answer number ' + i }, cookie)).json();
      if (data.complete) { completed = true; break; }
      assert.ok(!/\[ASKED|\[REPAIR/.test(data.message || ''), 'markers stripped from the teen-facing message');
      served.push(data.progress.q);
      if (data.chips && data.chips.length) chipsAt[data.progress.q] = data.chips.length;
      if (data.goal) goalSeen = true;
    }
    assert.deepStrictEqual(served, Array.from({ length: 12 }, (_, k) => k + 1), 'served Q1..Q12 in order (no skips/repeats)');
    assert.ok(completed, 'interview completes after Q12');
    [2, 3, 5, 6, 7, 8, 10].forEach(n => assert.ok(chipsAt[n] > 0, 'chips surfaced on Q' + n));
    assert.ok(goalSeen, 'goal pinned after the goal question (Q4)');
  });

  server.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
