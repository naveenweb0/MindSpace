'use strict';
/* Memberships page: render plans + purchase flow (test-mode checkout). */

(function () {
  const $ = (s, c) => (c || document).querySelector(s);
  const fmtINR = (n) => '₹' + Number(n).toLocaleString('en-IN');
  let plans = [];
  let selected = null;

  async function api(url, opts) {
    const r = await fetch(url, opts);
    const j = await r.json().catch(() => ({ ok: false, message: 'Something went wrong.' }));
    if (!j.ok) throw new Error(j.message || 'Something went wrong.');
    return j;
  }

  function renderPlans() {
    const grid = $('#planGrid');
    const dropIn = grid.querySelector('.plan-card');
    grid.innerHTML = '';
    grid.appendChild(dropIn);
    dropIn.classList.add('in');

    plans.forEach((p, i) => {
      const card = document.createElement('div');
      card.className = 'plan-card reveal in ' + (p.slug === 'unlimited' ? 'featured' : '');
      card.style.transitionDelay = (i * 0.08) + 's';
      const unlimited = !p.sessions_included;
      card.innerHTML = `
        <div class="plan-badge">${unlimited ? 'Most loved' : 'Routine'}</div>
        <h2 class="plan-name">${p.name}</h2>
        <p class="plan-tag">${p.tagline || ''}</p>
        <div class="plan-price">${fmtINR(p.price)}<span> / ${p.interval_days >= 30 ? 'month' : p.interval_days + ' days'}</span></div>
        <ul class="plan-benefits">${(p.benefits || []).map((b) => `<li>${b}</li>`).join('')}</ul>
        <button class="btn ${p.slug === 'unlimited' ? 'btn-primary' : 'btn-outline'} btn-block" data-plan="${p.id}">${unlimited ? 'Join Unlimited' : 'Become a Member'} <span class="arr">→</span></button>`;
      grid.appendChild(card);
      card.querySelector('button').addEventListener('click', () => openModal(p));
    });
  }

  function openModal(p) {
    selected = p;
    $('#memPlanName').textContent = p.name + (p.sessions_included ? ' · ' + p.sessions_included + ' sessions' : ' · unlimited sessions');
    $('#memPrice').textContent = fmtINR(p.price);
    $('#memStatus').className = 'co-status';
    $('#memStatus').textContent = '';
    $('#memModal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }
  function closeModal() {
    $('#memModal').classList.remove('open');
    document.body.style.overflow = '';
  }

  function wire() {
    $('#memClose').addEventListener('click', closeModal);
    $('#memModal').addEventListener('click', (e) => { if (e.target === $('#memModal')) closeModal(); });

    $('#memPay').addEventListener('click', async () => {
      const name = $('#mName').value.trim();
      const phone = $('#mPhone').value.trim();
      const email = $('#mEmail').value.trim();
      let ok = true;
      const mark = (id, bad) => { $(id).closest('.form-field').classList.toggle('invalid', bad); if (bad) ok = false; };
      mark('#mName', !name);
      mark('#mPhone', !/^[0-9+\-\s()]{7,15}$/.test(phone));
      if (!ok) return;
      const btn = $('#memPay');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Activating…';
      try {
        const j = await api('/api/memberships/purchase', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan_id: selected.id, name, phone, email, mock: true }),
        });
        const m = j.membership;
        $('#memBody').innerHTML = `
          <div style="text-align:center;padding:10px 0 6px">
            <div style="font-size:44px;margin-bottom:10px">🌿</div>
            <h3 style="font-size:24px;margin-bottom:6px">You're a member!</h3>
            <p class="muted" style="margin-bottom:18px">Welcome to ${selected.name} at The Pause Studio.</p>
            <div class="confirm-card" style="margin:0;text-align:left">
              <div class="cc-body"><div class="cc-grid">
                <div class="cc-item"><div class="k">Membership ID</div><div class="v">${m.membership_reference}</div></div>
                <div class="cc-item"><div class="k">Plan</div><div class="v">${selected.name}</div></div>
                <div class="cc-item"><div class="k">Valid until</div><div class="v">${new Date(m.end_date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div></div>
                <div class="cc-item"><div class="k">Sessions</div><div class="v">${m.sessions_total ? m.sessions_total + ' / month' : 'Unlimited'}</div></div>
                <div class="cc-item"><div class="k">Paid</div><div class="v">${fmtINR(m.price_paid)}</div></div>
                <div class="cc-item"><div class="k">Status</div><div class="v" style="color:var(--sage-deep)">Active ✓</div></div>
              </div></div>
            </div>
            <p class="sum-note" style="margin-top:14px">A confirmation is on its way. Show your ID at the studio when you visit.</p>
            <button class="btn btn-primary btn-block" id="memDone" style="margin-top:16px">Done</button>
          </div>`;
        $('#memDone').addEventListener('click', closeModal);
      } catch (e) {
        const st = $('#memStatus');
        st.className = 'co-status err';
        st.textContent = e.message;
        btn.disabled = false;
        btn.innerHTML = 'Pay &amp; activate <span class="arr">→</span>';
      }
    });
  }

  (async function init() {
    wire();
    try {
      const j = await api('/api/memberships/plans');
      plans = j.plans;
      renderPlans();
    } catch (e) { /* plans stay as drop-in only */ }
  })();
})();
