'use strict';
/* Multi-step booking flow: Activity → Duration → Date → Time → Details → Payment.
 * Availability is checked live; a slot is only ever held (and paid for) when still free. */

(function () {
  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
  const fmtINR = (n) => '₹' + Number(n).toLocaleString('en-IN');

  const settings = (function () {
    const el = document.getElementById('studio-settings');
    try { return JSON.parse(el.textContent || '{}'); } catch (e) { return {}; }
  })();
  const toast = (window.TPS && window.TPS.toast) ? window.TPS.toast : (m) => console.warn(m);

  const STEP_LABELS = ['Activity', 'Duration', 'Date', 'Time', 'Details', 'Payment'];
  const state = { activity: null, duration: null, date: null, slot: null, guests: 1, name: '', phone: '', email: '', note: '' };
  let activities = [];
  let calendarCache = {};
  let view = { y: 0, m: 0 };
  let maxGuests = 8;
  let current = 0;
  let currentBooking = null; // reserved (held) booking while paying

  async function api(url, opts) {
    const fullUrl = (url.startsWith('/api') && window.API_BASE) ? window.API_BASE + url : url;
    const res = await fetch(fullUrl, opts);
    let j;
    try { j = await res.json(); } catch (e) { j = { ok: false, message: 'Something went wrong. Please try again.' }; }
    if (!j.ok) { const err = new Error(j.message || 'Something went wrong.'); err.code = j.error; err.extra = j; throw err; }
    return j;
  }

  /* ---------------- step switching ---------------- */
  function goTo(i) {
    current = Math.max(0, Math.min(5, i));
    $$('#stepArea .step-panel').forEach((p, idx) => p.classList.toggle('active', idx === current));
    // progress
    $$('#progress .p-step').forEach((el, idx) => {
      el.classList.toggle('done', idx < current);
      el.classList.toggle('current', idx === current);
    });
    const pmText = $('#pmText'), pmFill = $('#pmFill');
    if (pmText) pmText.textContent = 'Step ' + (current + 1) + ' of 6 · ' + STEP_LABELS[current];
    if (pmFill) pmFill.style.width = ((current + 1) / 6 * 100) + '%';
    renderSummary();
    window.scrollTo({ top: $('#stepArea').getBoundingClientRect().top + window.scrollY - 96, behavior: 'smooth' });
  }

  /* ---------------- build steps ---------------- */
  function buildSteps() {
    const area = $('#stepArea');
    area.innerHTML = `
      <div class="step-panel" data-panel="0"></div>
      <div class="step-panel" data-panel="1"></div>
      <div class="step-panel" data-panel="2"></div>
      <div class="step-panel" data-panel="3"></div>
      <div class="step-panel" data-panel="4"></div>
      <div class="step-panel" data-panel="5"></div>`;
  }

  function renderActivityStep() {
    const p = $('[data-panel="0"]');
    p.innerHTML = `
      <h2 class="step-title">Pick your kind of pause.</h2>
      <p class="step-sub">Different day, different mood. Choose whatever feels right.</p>
      <div class="pick-grid" role="radiogroup" aria-label="Choose an activity">
        ${activities.map((a) => `
          <button class="pick-card ${state.activity && state.activity.id === a.id ? 'selected' : ''}" role="radio"
            aria-checked="${state.activity && state.activity.id === a.id}" data-id="${a.id}">
            <div class="pick-img"><img src="${a.image}" alt="${a.name}" loading="lazy"></div>
            <div class="pick-name">${a.name}</div>
            <div class="pick-from">From ${fmtINR(Math.min(...a.durations.map((d) => d.price)))}</div>
            <span class="check">✓</span>
          </button>`).join('')}
      </div>
      <div class="step-nav">
        <button class="btn btn-ghost" id="back0" disabled>← Back</button>
      </div>`;
    $$('.pick-card', p).forEach((c) => c.addEventListener('click', () => {
      const a = activities.find((x) => x.id === Number(c.dataset.id));
      state.activity = a;
      state.duration = null; state.date = null; state.slot = null;
      maxGuests = a.max_capacity || 8;
      renderActivityStep();
      setTimeout(() => { renderDurationStep(); goTo(1); }, 220);
    }));
  }

  function renderDurationStep() {
    const a = state.activity;
    const p = $('[data-panel="1"]');
    p.innerHTML = `
      <h2 class="step-title">How long is your pause?</h2>
      <p class="step-sub">${a.name} · pick a duration that fits your day.</p>
      <div class="dur-grid" role="radiogroup" aria-label="Choose a duration">
        ${a.durations.map((d) => `
          <button class="dur-card ${state.duration === d.minutes ? 'selected' : ''}" role="radio" aria-checked="${state.duration === d.minutes}" data-min="${d.minutes}">
            <span class="dur-min">${d.minutes} min</span>
            <span class="dur-price">${fmtINR(d.price)}</span>
            <span class="dur-tag">${d.minutes === 30 ? 'A quick reset' : 'A proper unwind'}</span>
          </button>`).join('')}
      </div>
      <div class="step-nav">
        <button class="btn btn-ghost" id="back1">← Back</button>
      </div>`;
    $$('.dur-card', p).forEach((c) => c.addEventListener('click', () => {
      state.duration = Number(c.dataset.min);
      state.date = null; state.slot = null;
      renderDurationStep();
      setTimeout(() => { renderDateStep(); goTo(2); }, 200);
    }));
    $('#back1').addEventListener('click', () => goTo(0));
  }

  /* ---------------- calendar ---------------- */
  async function fetchMonth(y, m) {
    const key = y + '-' + m;
    if (calendarCache[key]) return calendarCache[key];
    const j = await api('/api/availability/calendar?year=' + y + '&month=' + m);
    calendarCache[key] = j.days;
    return j.days;
  }

  async function renderDateStep() {
    const p = $('[data-panel="2"]');
    const now = new Date();
    if (!view.y) { view.y = now.getFullYear(); view.m = now.getMonth() + 1; }
    p.innerHTML = `
      <h2 class="step-title">Pick a day.</h2>
      <p class="step-sub">Days in grey are closed or fully booked — the rest are waiting for you.</p>
      <div class="cal" id="cal"><div class="skeleton" style="height:320px;border-radius:16px"></div></div>
      <div class="step-nav">
        <button class="btn btn-ghost" id="back2">← Back</button>
      </div>`;
    $('#back2').addEventListener('click', () => goTo(1));
    let days;
    try { days = await fetchMonth(view.y, view.m); } catch (e) { toast(e.message, 'err'); return; }
    renderCal(p, days);
  }

  function renderCal(p, days) {
    const cal = $('#cal', p);
    const dow = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const first = new Date(view.y, view.m - 1, 1).getDay();
    const today = new Date();
    const todayS = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const nowM = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
    const maxLead = new Date(); maxLead.setDate(maxLead.getDate() + Number(settings.max_lead_days || 30));
    const canPrev = view.y + '-' + String(view.m).padStart(2, '0') > nowM;
    const canNext = view.y < maxLead.getFullYear() || (view.y === maxLead.getFullYear() && view.m < maxLead.getMonth() + 1);

    let cells = dow.map((d, i) => `<div class="cal-dow">${d}</div>`).join('');
    for (let i = 0; i < first; i++) cells += '<div></div>';
    const byDate = {};
    days.forEach((d) => (byDate[d.date] = d.status));

    days.forEach((d) => {
      const day = Number(d.date.slice(8));
      const cls = d.status; // past | closed | full | open
      const selected = state.date === d.date;
      let sub = '';
      if (cls === 'full') sub = '<span class="cd-sub">FULL</span>';
      else if (cls === 'closed') sub = '<span class="cd-sub">CLOSED</span>';
      cells += `<button class="cal-day ${cls} ${selected ? 'selected' : ''} ${d.date === todayS ? 'today' : ''}"
        data-date="${d.date}" ${cls === 'open' ? '' : 'disabled'} aria-label="${d.date} ${cls}">
        ${day}${sub}</button>`;
    });
    cal.innerHTML = `
      <div class="cal-head">
        <button class="cal-nav" id="calPrev" aria-label="Previous month" ${canPrev ? '' : 'disabled'}>‹</button>
        <span class="cal-month">${new Date(view.y, view.m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span>
        <button class="cal-nav" id="calNext" aria-label="Next month" ${canNext ? '' : 'disabled'}>›</button>
      </div>
      <div class="cal-grid">${cells}</div>
      <div class="cal-legend">
        <span><i class="lg-open"></i> Available</span>
        <span><i class="lg-full"></i> Fully booked</span>
        <span><i class="lg-closed"></i> Closed / past</span>
      </div>`;

    $('#calPrev', cal).addEventListener('click', () => { if (canPrev) { view.m--; if (view.m < 1) { view.m = 12; view.y--; } renderDateStep(); } });
    $('#calNext', cal).addEventListener('click', () => { if (canNext) { view.m++; if (view.m > 12) { view.m = 1; view.y++; } renderDateStep(); } });
    $$('.cal-day.open', cal).forEach((b) => b.addEventListener('click', () => {
      state.date = b.dataset.date; state.slot = null;
      renderDateStep();
      setTimeout(() => { renderTimeStep(); goTo(3); }, 200);
    }));
  }

  /* ---------------- slots ---------------- */
  async function renderTimeStep() {
    const p = $('[data-panel="3"]');
    p.innerHTML = `
      <h2 class="step-title">Pick a time.</h2>
      <p class="step-sub">${new Date(state.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })} · ${state.activity.name} · ${state.duration} min</p>
      <div class="slot-grid" id="slotGrid"><div class="skeleton" style="height:150px;grid-column:1/-1"></div></div>
      <div class="step-nav"><button class="btn btn-ghost" id="back3">← Back</button></div>`;
    $('#back3').addEventListener('click', () => goTo(2));
    let j;
    try { j = await api('/api/availability?date=' + state.date); } catch (e) { toast(e.message, 'err'); return; }
    const av = j.availability;
    if (!av.open) {
      $('#slotGrid', p).innerHTML = `<div class="state" style="grid-column:1/-1"><div class="state-emoji">🌙</div><h2>We're closed that day.</h2><p>Pick another date and we'll get you sorted.</p><button class="btn btn-primary" id="backToCal">Choose another day</button></div>`;
      $('#backToCal', p).addEventListener('click', () => goTo(2));
      return;
    }
    const slots = av.slots.filter((s) => !s.closed);
    if (!slots.length) {
      $('#slotGrid', p).innerHTML = `<div class="state" style="grid-column:1/-1"><div class="state-emoji">🌙</div><h2>That day is fully booked.</h2><p>Try another day — your pause is worth it.</p><button class="btn btn-primary" id="backToCal2">Choose another day</button></div>`;
      $('#backToCal2', p).addEventListener('click', () => goTo(2));
      return;
    }
    $('#slotGrid', p).innerHTML = av.slots.map((s) => {
      const full = s.left <= 0 || s.closed;
      const few = !full && s.left <= 2;
      const label = s.closed ? (s.reason === 'blocked' ? 'Unavailable' : 'Fully booked') : (s.left + (s.left === 1 ? ' spot left' : ' spots left'));
      return `<button class="slot-pill ${full ? 'disabled' : ''} ${state.slot === s.start ? 'selected' : ''}"
        data-start="${s.start}" data-left="${s.left}" ${full ? 'disabled' : ''}>
        <span class="slot-time">${fmtTime(s.start)}</span>
        <span class="slot-left ${few ? 'few' : ''}">${label}</span>
      </button>`;
    }).join('');
    $$('.slot-pill:not(.disabled)', p).forEach((b) => b.addEventListener('click', () => {
      state.slot = b.dataset.start;
      maxGuests = Math.min(state.activity.max_capacity || 8, Number(b.dataset.left));
      if (state.guests > maxGuests) state.guests = maxGuests;
      renderTimeStep();
      setTimeout(() => { renderDetailsStep(); goTo(4); }, 200);
    }));
  }

  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return (h % 12 === 0 ? 12 : h % 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }

  /* ---------------- details ---------------- */
  function renderDetailsStep() {
    const p = $('[data-panel="4"]');
    p.innerHTML = `
      <h2 class="step-title">Who's coming?</h2>
      <p class="step-sub">Tell us a little so we can have everything ready.</p>
      <div class="guest-box">
        <div class="guest-row">
          <div><strong>Number of people</strong><div class="guest-note">₹${unitPrice()} per person</div></div>
          <div class="guest-stepper">
            <button id="gMinus" aria-label="Fewer people" ${state.guests <= 1 ? 'disabled' : ''}>−</button>
            <span class="g-num" id="gNum">${state.guests}</span>
            <button id="gPlus" aria-label="More people" ${state.guests >= maxGuests ? 'disabled' : ''}>+</button>
          </div>
        </div>
        <div class="guest-chips">
          ${[1, 2, 3, 4].map((n) => `<button class="${state.guests === n ? 'on' : ''}" data-n="${n}" ${n > maxGuests ? 'disabled' : ''}>${n}${n === 1 ? ' person' : ' people'}</button>`).join('')}
          <button class="${state.guests >= 5 ? 'on' : ''}" data-n="5" ${5 > maxGuests ? 'disabled' : ''}>5+ people</button>
        </div>
      </div>

      <div class="details-form" style="margin-top:26px">
        <h3 class="h-md" style="margin-bottom:14px">Your details</h3>
        <div class="form-grid">
          <div class="form-field"><label for="fName">Full name <span class="req">*</span></label>
            <input class="input" id="fName" autocomplete="name" value="${state.name}">
            <span class="field-error">Please enter your name.</span></div>
          <div class="form-field"><label for="fPhone">Mobile number <span class="req">*</span></label>
            <input class="input" id="fPhone" inputmode="tel" autocomplete="tel" placeholder="98765 43210" value="${state.phone}">
            <span class="field-error">Enter a valid 10-digit mobile number.</span></div>
          <div class="form-field"><label for="fEmail">Email <span style="color:var(--ink-faint)">(optional)</span></label>
            <input class="input" id="fEmail" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" value="${state.email}">
            <span class="field-error">That email doesn't look right.</span></div>
          <div class="form-field"><label for="fNote">Anything we should know? <span style="color:var(--ink-faint)">(optional)</span></label>
            <input class="input" id="fNote" placeholder="e.g. first time, left-handed, celebrating something…" value="${state.note}"></div>
        </div>
      </div>
      <div class="step-nav">
        <button class="btn btn-ghost" id="back4">← Back</button>
        <button class="btn btn-primary" id="toPay">Continue to payment <span class="arr">→</span></button>
      </div>`;

    $('#back4').addEventListener('click', () => goTo(3));
    const syncGuests = () => {
      state.guests = Math.max(1, Math.min(maxGuests, state.guests));
      $('#gNum').textContent = state.guests;
      $('#gMinus').disabled = state.guests <= 1;
      $('#gPlus').disabled = state.guests >= maxGuests;
      $$('.guest-chips button').forEach((b) => b.classList.toggle('on', Number(b.dataset.n) === state.guests || (b.dataset.n === '5' && state.guests >= 5)));
      renderSummary();
    };
    $('#gMinus').addEventListener('click', () => { state.guests--; syncGuests(); });
    $('#gPlus').addEventListener('click', () => { state.guests++; syncGuests(); });
    $$('.guest-chips button').forEach((b) => b.addEventListener('click', () => { state.guests = Number(b.dataset.n); syncGuests(); }));
    ['fName', 'fPhone', 'fEmail', 'fNote'].forEach((id, i) => {
      $('#' + id).addEventListener('input', (e) => {
        const keys = ['name', 'phone', 'email', 'note'];
        state[keys[i]] = e.target.value;
        e.target.closest('.form-field').classList.remove('invalid');
      });
    });

    $('#toPay').addEventListener('click', () => {
      const name = state.name.trim(), phone = state.phone.trim(), email = state.email.trim();
      let ok = true;
      const bad = (sel, cond) => { const el = $(sel); el.closest('.form-field').classList.toggle('invalid', cond); if (cond) ok = false; };
      bad('#fName', !name);
      bad('#fPhone', !/^[0-9+\-\s()]{7,15}$/.test(phone));
      bad('#fEmail', email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
      if (!ok) { toast('Please fix the highlighted fields.', 'err'); return; }
      renderPaymentStep(); goTo(5);
    });
  }

  function unitPrice() {
    if (!state.activity || !state.duration) return 0;
    const d = state.activity.durations.find((x) => x.minutes === state.duration);
    return d ? d.price : 0;
  }
  function totalAmount() { return unitPrice() * state.guests; }

  /* ---------------- payment ---------------- */
  function renderPaymentStep() {
    const p = $('[data-panel="5"]');
    p.innerHTML = `
      <h2 class="step-title">Ready when you are.</h2>
      <p class="step-sub">A quick review before we hold your spot.</p>
      <div class="confirm-card" style="margin:0;max-width:640px">
        <div class="cc-body">
          <div class="cc-grid">
            <div class="cc-item"><div class="k">Activity</div><div class="v">${state.activity.name}</div></div>
            <div class="cc-item"><div class="k">Duration</div><div class="v">${state.duration} minutes</div></div>
            <div class="cc-item"><div class="k">Date</div><div class="v">${new Date(state.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</div></div>
            <div class="cc-item"><div class="k">Time</div><div class="v">${fmtTime(state.slot)}</div></div>
            <div class="cc-item"><div class="k">People</div><div class="v">${state.guests}</div></div>
            <div class="cc-item"><div class="k">Total</div><div class="v">${fmtINR(totalAmount())}</div></div>
          </div>
        </div>
      </div>
      <div class="state" id="payError" style="display:none;max-width:560px">
        <div class="state-emoji">😕</div>
        <h2>That slot just filled up.</h2>
        <p>Pick another time and we'll get you sorted.</p>
        <button class="btn btn-primary" id="pickAgain">Pick another time</button>
      </div>
      <div class="step-nav" id="payNav">
        <button class="btn btn-ghost" id="back5">← Back</button>
        <button class="btn btn-primary btn-lg" id="payBtn">🔒 Pay ${fmtINR(totalAmount())} securely <span class="arr">→</span></button>
      </div>`;

    $('#back5').addEventListener('click', () => goTo(4));
    $('#pickAgain').addEventListener('click', () => { renderTimeStep(); goTo(3); });
    $('#payBtn').addEventListener('click', reserveAndOpenCheckout);
  }

  async function reserveAndOpenCheckout() {
    const btn = $('#payBtn');
    if (btn) { btn.disabled = true; btn.innerHTML = 'Holding your spot…'; }
    try {
      const j = await api('/api/bookings', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          activity_id: state.activity.id, duration: state.duration, date: state.date,
          start_time: state.slot, number_of_guests: state.guests,
          customer_name: state.name, customer_phone: state.phone, customer_email: state.email, note: state.note,
        }),
      });
      currentBooking = j.booking;
      openCheckout(j.booking, j.payment);
    } catch (e) {
      if (e.code === 'SLOT_FULL') {
        const err = $('#payError');
        if (err) { err.style.display = 'block'; $('#payNav').style.display = 'none'; }
        toast('That slot just filled up. Pick another time.', 'err');
      } else {
        toast(e.message, 'err');
      }
      if (btn) { btn.disabled = false; btn.innerHTML = `🔒 Pay ${fmtINR(totalAmount())} securely <span class="arr">→</span>`; }
    }
  }

  /* ---------------- checkout modal ---------------- */
  function openCheckout(booking, payment) {
    const modal = $('#checkoutModal');
    $('#coAmount').textContent = fmtINR(booking.total_amount);
    $('#coPayAmt').textContent = fmtINR(booking.total_amount);
    $('#coTestBadge').style.display = payment.mode === 'mock' ? '' : 'none';
    $('#coStatus').className = 'co-status';
    $('#coStatus').textContent = '';
    $('#coPay').disabled = false;
    $('#coPay').innerHTML = `Pay ${fmtINR(booking.total_amount)} securely →`;
    modal.classList.add('open');
    document.body.style.overflow = 'hidden';
    window.__pay = { booking, payment, method: 'upi' };
  }
  function closeCheckout() {
    $('#checkoutModal').classList.remove('open');
    document.body.style.overflow = '';
    const btn = $('#payBtn');
    if (btn) { btn.disabled = false; btn.innerHTML = `🔒 Pay ${fmtINR(totalAmount())} securely <span class="arr">→</span>`; }
  }

  function wireCheckout() {
    $$('#payMethods .pay-method').forEach((m) => m.addEventListener('click', () => {
      $$('#payMethods .pay-method').forEach((x) => x.classList.remove('on'));
      m.classList.add('on');
      const method = m.dataset.method;
      if (window.__pay) window.__pay.method = method;
      ['coUpi', 'coCard', 'coNet', 'coWallet'].forEach((id) => { $('#' + id).style.display = 'none'; });
      const map = { upi: 'coUpi', card: 'coCard', netbanking: 'coNet', wallet: 'coWallet' };
      $('#' + map[method]).style.display = '';
    }));
    $('#coClose').addEventListener('click', closeCheckout);
    $('#checkoutModal').addEventListener('click', (e) => { if (e.target === $('#checkoutModal')) closeCheckout(); });

    $('#coPay').addEventListener('click', () => {
      const p = window.__pay;
      if (!p) return;
      const btn = $('#coPay');
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner"></span> Processing…';
      $('#coStatus').className = 'co-status';
      $('#coStatus').textContent = '';
      // simulated gateway latency
      setTimeout(async () => {
        try {
          const j = await api('/api/payments/verify', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ booking_ref: p.booking.booking_reference, method: p.method, mock: p.payment.mode === 'mock' }),
          });
          // persist to localStorage immediately
          try {
            const act = state.activity || {};
            const item = {
              ...p.booking,
              ...j.booking,
              activity_name: act.name || 'Creative Session',
              activity_image: act.image || '/img/activity-painting.jpg',
              customer_name: ($('#cName') && $('#cName').value.trim()) || p.booking.customer_name || 'Customer',
              customer_phone: ($('#cPhone') && $('#cPhone').value.trim()) || p.booking.customer_phone || '',
              customer_email: ($('#cEmail') && $('#cEmail').value.trim()) || p.booking.customer_email || '',
              payment_status: 'paid',
              booking_status: 'confirmed',
              _saved_at: Date.now()
            };
            const saved = JSON.parse(localStorage.getItem('tps_bookings') || '[]');
            const idx = saved.findIndex((b) => b.booking_reference === item.booking_reference);
            if (idx >= 0) saved[idx] = item; else saved.unshift(item);
            localStorage.setItem('tps_bookings', JSON.stringify(saved.slice(0, 50)));

            const adm = JSON.parse(localStorage.getItem('tps_admin_bookings') || '[]');
            const admIdx = adm.findIndex((b) => b.booking_reference === item.booking_reference);
            if (admIdx >= 0) adm[admIdx] = item; else adm.unshift(item);
            localStorage.setItem('tps_admin_bookings', JSON.stringify(adm.slice(0, 50)));

            if (item.customer_phone) localStorage.setItem('tps_last_phone', item.customer_phone);
          } catch (_) {}
          // success!
          window.location.href = '/confirmation?ref=' + j.booking.booking_reference + '&token=' + j.booking.view_token;
        } catch (e) {
          btn.disabled = false;
          btn.innerHTML = `Pay ${fmtINR(p.booking.total_amount)} securely →`;
          const st = $('#coStatus');
          st.className = 'co-status err';
          st.innerHTML = '<strong>Looks like the payment didn’t go through.</strong>';
          const tip = document.createElement('span');
          tip.textContent = ' Your slot hasn’t been confirmed. You can try again.';
          st.appendChild(tip);
          api('/api/payments/fail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ booking_ref: p.booking.booking_reference, method: p.method }) }).catch(() => {});
        }
      }, 1300);
    });

    $('#simFail').addEventListener('click', () => {
      const p = window.__pay; if (!p) return;
      const st = $('#coStatus');
      st.className = 'co-status err';
      st.innerHTML = '<strong>Payment failed.</strong>';
      const tip = document.createElement('span');
      tip.textContent = ' Your slot hasn’t been confirmed — you can try again or pick another time.';
      st.appendChild(tip);
    });
  }

  /* ---------------- summary ---------------- */
  function renderSummary() {
    const s = $('#summary');
    if (!s) return;
    const rows = [];
    if (state.activity) rows.push(['Activity', state.activity.name, 0]);
    if (state.duration) rows.push(['Duration', state.duration + ' min', 1]);
    if (state.date) rows.push(['Date', new Date(state.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', weekday: 'short' }), 2]);
    if (state.slot) rows.push(['Time', fmtTime(state.slot), 3]);
    rows.push(['People', state.guests + (state.guests === 1 ? ' person' : ' people'), 4]);

    const complete = state.activity && state.duration && state.date && state.slot;
    s.innerHTML = `
      <div class="sum-head"><h3>Your pause</h3><p>${complete ? 'Almost there…' : 'Choose as you go'}</p></div>
      <div class="sum-body">
        ${rows.map((r) => `
          <div class="sum-row"><span class="k">${r[0]} <a class="edit" data-go="${r[2]}" aria-label="Edit ${r[0]}">Edit</a></span>
          <span class="v">${r[1]}</span></div>`).join('')}
        ${state.duration ? `<div class="sum-div"></div>
          <div class="sum-row"><span class="k">${fmtINR(unitPrice())} × ${state.guests}</span><span class="v">${fmtINR(totalAmount())}</span></div>
          <div class="sum-total"><span class="k">Total</span><span class="v">${fmtINR(totalAmount())}</span></div>` : ''}
        ${state.duration ? '<p class="sum-note">Pay when you arrive at the payment step · free cancellation per policy</p>' : '<div class="sum-empty">Pick an activity to begin ✨</div>'}
      </div>`;
    $$('.edit', s).forEach((a) => a.addEventListener('click', () => {
      const g = Number(a.dataset.go);
      if (g === 2) renderDateStep(); if (g === 3) renderTimeStep(); if (g === 4) renderDetailsStep();
      if (g === 0) renderActivityStep(); if (g === 1) renderDurationStep();
      goTo(g);
    }));
  }

  /* ---------------- init ---------------- */
  async function init() {
    buildSteps();
    wireCheckout();
    renderSummary();
    try {
      const j = await api('/api/activities');
      activities = j.activities;
      renderActivityStep();
      // preselect from ?activity=slug
      const slug = new URLSearchParams(location.search).get('activity');
      if (slug) {
        const a = activities.find((x) => x.slug === slug);
        if (a) {
          state.activity = a;
          maxGuests = a.max_capacity || 8;
          renderActivityStep();
          renderDurationStep();
          goTo(1);
          return;
        }
      }
      goTo(0);
    } catch (e) {
      $('#stepArea').innerHTML = `<div class="state"><div class="state-emoji">🎨</div><h2>We couldn't load activities.</h2><p>${e.message}</p><button class="btn btn-primary" onclick="location.reload()">Try again</button></div>`;
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
