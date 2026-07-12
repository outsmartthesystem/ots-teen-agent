// Parent registration page logic. External (not inline) so the server's strict
// Content-Security-Policy (script-src 'self') can stay in place.
(function () {
  const form = document.getElementById('form');
  const success = document.getElementById('success');
  const submitBtn = document.getElementById('submitBtn');
  const formError = document.getElementById('formError');

  function showFieldError(id, show) {
    document.getElementById(id).classList.toggle('show', show);
  }
  function setText(id, t) { const el = document.getElementById(id); if (el) el.textContent = t; }
  function show(id, on) { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; }

  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  const teenBtnLabel = 'Create my teen’s link';
  const adultBtnLabel = 'Create my Map';

  // One entry page, two audiences. The age picker routes the person: 13–17 keeps
  // the parent-sets-it-up flow; "18 or older" flips the whole form to a one-party
  // self-signup (their own name/email/age, self-consent, their own copy).
  function isAdultMode() { return document.getElementById('teenAge').value === '18plus'; }

  function applyMode() {
    const adult = isAdultMode();
    show('adultAgeField', adult);       // exact 18+ age input
    show('teenNameField', !adult);      // no separate "teen" in self-signup
    show('teenAgeAdult', adult);        // "you're setting this up for yourself" note
    if (adult) {
      setText('pageH1', 'Your Money & Momentum Map — see what you actually want, and what’s quietly slowing you down.');
      setText('pageLede', 'A private System Map for you: what you want, what’s already working, the one habit slowing your momentum, and one move to try this week. About 15–20 minutes.');
      setText('introBlock', 'This is for you. You do it on your own and see your result first. Nothing is shared with anyone — at the end you choose whether to email yourself a copy. This is not a crisis service, therapy, or a clinical assessment; if something you say raises a serious safety concern, it may pause and show resources, and in rare cases a designated OTS responder may review a minimal safety alert.');
      setText('emailLabel', 'Your email — where your copy comes if you want one');
      setText('ageLabel', 'Your age');
      setText('consentText', 'I’m 18 or older, and I understand this is a money-and-momentum snapshot — not a crisis service, therapy, or a clinical assessment.');
      submitBtn.textContent = adultBtnLabel;
    } else {
      setText('emailLabel', 'Your email — where your teen’s approved report comes');
      setText('ageLabel', 'Their age');
      submitBtn.textContent = teenBtnLabel;
    }
  }
  document.getElementById('teenAge').addEventListener('change', applyMode);

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    formError.classList.remove('show');

    const adult = isAdultMode();
    const parentName = document.getElementById('parentName').value.trim();
    const parentEmail = document.getElementById('parentEmail').value.trim();
    const teenName = document.getElementById('teenName').value.trim();
    const teenAgeRaw = document.getElementById('teenAge').value;
    const adultAge = Number(document.getElementById('adultAge').value);
    const consent = document.getElementById('consent').checked;

    // In self-signup, the one person's name IS the "teen" name sent to the API.
    const personName = adult ? parentName : teenName;
    const age = adult ? adultAge : Number(teenAgeRaw);

    const checks = {
      parentNameErr: !parentName,
      parentEmailErr: !validEmail(parentEmail),
      teenNameErr: !adult && !teenName,
      teenAgeErr: !adult && !(age >= 13 && age <= 17),
      adultAgeErr: adult && !(Number.isInteger(adultAge) && adultAge >= 18 && adultAge <= 99),
      consentErr: !consent
    };
    let ok = true;
    Object.keys(checks).forEach(id => { showFieldError(id, checks[id]); if (checks[id]) ok = false; });
    if (!ok) return;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';

    try {
      const r = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // "Your first name" (parentName) is the parent in teen mode and the adult
          // themselves in adult mode — so it's always the parent_first_name. Only the
          // teen_first_name differs: the teen's name (teen mode) or the adult's (self).
          parent_first_name: parentName,
          parent_email: parentEmail,
          teen_first_name: personName,
          teen_age: age,
          consent: true
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong.');

      document.getElementById('teenLink').value = j.teen_url;
      if (adult) {
        setText('successHeading', 'Your private Map is ready');
        setText('sendGuide', 'Start it now, or save the link to come back to. It’s just for you.');
        const startBtn = document.getElementById('startBtn');
        if (startBtn) { startBtn.style.display = ''; startBtn.onclick = function () { location.href = j.teen_url; }; }
        show('againBtn', false);
      } else {
        setText('successHeading', "Here's " + personName + "'s private link");
        setText('sendGuide', 'Send this to ' + personName + ' — text it, AirDrop it, or open it on their phone. It’s just for them.');
      }
      form.style.display = 'none';
      success.classList.add('show');
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.add('show');
      submitBtn.disabled = false;
      submitBtn.textContent = adult ? adultBtnLabel : teenBtnLabel;
    }
  });

  document.getElementById('copyBtn').addEventListener('click', function () {
    const input = document.getElementById('teenLink');
    input.select();
    const btn = this;
    const done = () => { btn.textContent = 'Copied ✓'; setTimeout(() => btn.textContent = 'Copy', 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(input.value).then(done, () => { document.execCommand('copy'); done(); });
    else { document.execCommand('copy'); done(); }
  });

  document.getElementById('againBtn').addEventListener('click', function () {
    form.reset();
    form.style.display = '';
    success.classList.remove('show');
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create my teen’s link';
    ['parentNameErr', 'parentEmailErr', 'teenNameErr', 'teenAgeErr'].forEach(id => showFieldError(id, false));
  });

  // PR E: payment gate — when enabled, the parent pays upfront (Stripe) before
  // the form is shown. Beta (payment_required=false) leaves the form open.
  (async function initPayGate() {
    const params = new URLSearchParams(location.search);
    if (params.get('payfail') === '1') { formError.textContent = 'Payment wasn’t confirmed. Try again, or contact us.'; formError.classList.add('show'); }
    try {
      const cfg = await (await fetch('/api/config')).json();
      if (cfg.payment_required && params.get('paid') !== '1') {
        const gate = document.getElementById('payGate');
        const payBtn = document.getElementById('payBtn');
        if (gate) gate.style.display = 'block';
        form.style.display = 'none';
        if (payBtn && cfg.payment_url) payBtn.onclick = function () { location.href = cfg.payment_url; };
      }
    } catch (e) { /* if config fails, leave the form visible (beta-safe) */ }
  })();
})();
