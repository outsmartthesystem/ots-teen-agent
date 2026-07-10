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

  function validEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    formError.classList.remove('show');

    const parentName = document.getElementById('parentName').value.trim();
    const parentEmail = document.getElementById('parentEmail').value.trim();
    const teenName = document.getElementById('teenName').value.trim();
    const teenAgeRaw = document.getElementById('teenAge').value;
    const consent = document.getElementById('consent').checked;

    // 18+ routes out to the (future) Young Adult Map, not the teen flow.
    const adult = teenAgeRaw === '18plus' || Number(teenAgeRaw) >= 18;
    document.getElementById('teenAgeAdult').style.display = adult ? 'block' : 'none';
    const teenAge = Number(teenAgeRaw);

    const checks = {
      parentNameErr: !parentName,
      parentEmailErr: !validEmail(parentEmail),
      teenNameErr: !teenName,
      teenAgeErr: adult || !(teenAge >= 13 && teenAge <= 17),
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
          parent_first_name: parentName,
          parent_email: parentEmail,
          teen_first_name: teenName,
          teen_age: teenAge,
          consent: true
        })
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Something went wrong.');

      document.getElementById('teenLink').value = j.teen_url;
      document.getElementById('successHeading').textContent = "Here's " + teenName + "'s private link";
      document.getElementById('sendGuide').textContent =
        'Send this to ' + teenName + ' — text it, AirDrop it, or open it on their phone. It’s just for them.';
      form.style.display = 'none';
      success.classList.add('show');
    } catch (err) {
      formError.textContent = err.message;
      formError.classList.add('show');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create my teen’s link';
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
