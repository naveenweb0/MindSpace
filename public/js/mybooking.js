'use strict';
/* My Booking — look up bookings & memberships by phone / booking ID.
   Bookings are persisted to localStorage at confirmation time so they
   remain visible even if the server database resets (e.g. Vercel cold-start). */

(function () {
  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
  const fmtINR = (n) => '₹' + Number(n).toLocaleString('en-IN');
  const toast = (window.TPS && window.TPS.toast) || (() => {});
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return (h % 12 === 0 ? 12 : h % 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const localToday = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };

  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ ok: false, message: 'Something went wrong.' }));
    if (!j.ok) throw new Error(j.message || 'Something went wrong.');
    return j;
  }

  function statusPill(s) { return `<span class="b-status-pill ${s}">${s.replace('_', ' ')}</span>`; }

  function bookingCard(b) {
    const today = localToday();
    const cancellable = ['pending', 'confirmed'].includes(b.booking_status) && b.date >= today;
    return `
      <div class="confirm-card" style="margin:0;max-width:100%">
        <div class="cc-head" style="flex-wrap:wrap;gap:10px">
          <span class="ref">${esc(b.booking_reference)}</span>
          <span style="display:flex;gap:8px;flex-wrap:wrap">${statusPill(b.booking_status)}${b.payment_status === 'paid' ? '<span class="chip chip-sage">Paid ✓</span>' : b.payment_status === 'refunded' ? '<span class="chip chip-mustard">Refunded</span>' : '<span class="chip chip-tint">Unpaid</span>'}</span>
        </div>
        <div class="cc-body">
          <div class="cc-grid">
            <div class="cc-item"><div class="k">Activity</div><div class="v">${esc(b.activity_name)}</div></div>
            <div class="cc-item"><div class="k">Duration</div><div class="v">${b.duration} min</div></div>
            <div class="cc-item"><div class="k">Date</div><div class="v">${fmtDate(b.date)}</div></div>
            <div class="cc-item"><div class="k">Time</div><div class="v">${fmtTime(b.start_time)}</div></div>
            <div class="cc-item"><div class="k">Guests</div><div class="v">${b.number_of_guests}</div></div>
            <div class="cc-item"><div class="k">Amount</div><div class="v">${fmtINR(b.total_amount)}</div></div>
          </div>
          ${cancellable ? `<div style="margin-top:16px;text-align:right"><button class="btn btn-outline btn-sm cancel-btn" data-ref="${esc(b.booking_reference)}">Cancel booking</button></div>` : ''}
        </div>
      </div>`;
  }

  function membershipCard(m) {
    return `
      <div class="confirm-card" style="margin:0;max-width:100%">
        <div class="cc-head"><span class="ref">${esc(m.membership_reference)}</span>${statusPill(m.status)}</div>
        <div class="cc-body">
          <div class="cc-grid">
            <div class="cc-item"><div class="k">Plan</div><div class="v">${esc(m.plan_name)}</div></div>
            <div class="cc-item"><div class="k">Sessions</div><div class="v">${m.sessions_total ? m.sessions_used + ' / ' + m.sessions_total + ' used' : 'Unlimited'}</div></div>
            <div class="cc-item"><div class="k">Valid until</div><div class="v">${fmtDate(m.end_date)}</div></div>
            <div class="cc-item"><div class="k">Paid</div><div class="v">${fmtINR(m.price_paid)}</div></div>
          </div>
        </div>
      </div>`;
  }

  /* ---- local storage helpers ---- */
  function getLocalBookings() {
    try { return JSON.parse(localStorage.getItem('tps_bookings') || '[]'); } catch (_) { return []; }
  }
  function updateLocalBookingStatus(ref, status) {
    try {
      const saved = getLocalBookings().map((b) => b.booking_reference === ref ? { ...b, booking_status: status } : b);
      localStorage.setItem('tps_bookings', JSON.stringify(saved));
    } catch (_) {}
  }

  function attachCancelListeners(container) {
    $$('.cancel-btn', container).forEach((btn) => btn.addEventListener('click', async () => {
      if (!confirm('Cancel this booking? Refunds follow the studio\'s cancellation policy.')) return;
      try {
        await post('/api/bookings/' + btn.dataset.ref + '/cancel', {});
        toast('Booking cancelled.', 'ok');
        updateLocalBookingStatus(btn.dataset.ref, 'cancelled');
        const head = btn.closest('.confirm-card').querySelector('.cc-head');
        head.innerHTML = head.innerHTML.replace(/<span class="chip chip-sage">Paid ✓<\/span>/, '');
        btn.remove();
      } catch (e) { toast(e.message, 'err'); }
    }));
  }

  function renderBookingList(bookings, container, note) {
    const today = localToday();
    const upcoming = bookings.filter((b) => b.date >= today && ['pending', 'confirmed'].includes(b.booking_status));
    const past = bookings.filter((b) => !(b.date >= today && ['pending', 'confirmed'].includes(b.booking_status)));
    container.innerHTML = `
      <div style="max-width:640px;margin:32px auto 0">
        ${note || ''}
        ${upcoming.length ? '<h2 class="h-md" style="margin:0 0 16px">Upcoming</h2>' + upcoming.map(bookingCard).join('') : ''}
        ${past.length ? '<h2 class="h-md" style="margin:28px 0 16px">Past &amp; cancelled</h2>' + past.map(bookingCard).join('') : ''}
      </div>`;
    attachCancelListeners(container);
  }

  /* ---- bookings ---- */
  async function doBookingFind() {
    const phone = $('#bPhone').value.trim();
    const ref = $('#bRef').value.trim().toUpperCase();
    const out = $('#results');
    if (!/^[0-9+\-\s()]{7,15}$/.test(phone)) { toast('Enter a valid mobile number.', 'err'); return; }
    out.innerHTML = '<div class="skeleton" style="height:120px;border-radius:20px;max-width:640px;margin:28px auto 0"></div>';
    try {
      let bookings = [];
      // try server (may be empty on Vercel cold-start — that's OK)
      try {
        const j = await post('/api/bookings/by-phone', { phone });
        bookings = j.bookings || [];
      } catch (_) {}
      // merge with locally saved bookings matched by phone digits
      const local = getLocalBookings().filter((b) => b.customer_phone && b.customer_phone.replace(/\D/g, '') === phone.replace(/\D/g, ''));
      for (const lb of local) {
        if (!bookings.some((b) => b.booking_reference === lb.booking_reference)) bookings.push(lb);
      }
      bookings.sort((a, b) => (b.date + b.start_time).localeCompare(a.date + a.start_time));
      if (ref) bookings = bookings.filter((b) => b.booking_reference === ref);

      if (!bookings.length) {
        out.innerHTML = `<div class="state"><div class="state-emoji">🕊️</div><h2>No bookings found</h2><p>${ref ? `We couldn't find a booking with ID "${esc(ref)}" under this phone number.` : 'Looks like your calendar is waiting for its first little pause.'}</p><a class="btn btn-primary" href="/book">Book a Session</a></div>`;
        return;
      }
      renderBookingList(bookings, out);
    } catch (e) {
      out.innerHTML = `<div class="state"><div class="state-emoji">🔍</div><h2>Nothing found</h2><p>${esc(e.message)}</p></div>`;
    }
  }

  $('#bFind').addEventListener('click', doBookingFind);
  ['bPhone', 'bRef'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.addEventListener('keydown', (e) => { if (e.key === 'Enter') doBookingFind(); });
  });

  /* ---- auto-load local bookings on page init ---- */
  (function initLocalBookings() {
    // Pre-fill phone field from last confirmed booking
    const lastPhone = localStorage.getItem('tps_last_phone');
    const phoneEl = $('#bPhone');
    if (phoneEl && lastPhone && !phoneEl.value) phoneEl.value = lastPhone;

    // Show saved bookings immediately — no search needed
    const local = getLocalBookings();
    if (!local.length) return;
    const out = $('#results');
    if (!out) return;
    const note = `<p class="muted" style="font-size:13px;margin:0 0 16px;text-align:center">📱 Saved on this device · <button id="clearLocal" style="font-size:13px;color:inherit;cursor:pointer;border:none;background:none;text-decoration:underline;padding:0">clear</button></p>`;
    renderBookingList(local, out, note);
    const clearBtn = $('#clearLocal');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      if (!confirm('Clear all saved bookings from this device?')) return;
      localStorage.removeItem('tps_bookings');
      localStorage.removeItem('tps_last_phone');
      out.innerHTML = '';
    });
  })();

  /* ---- memberships ---- */
  async function doMembershipFind() {
    const phone = $('#mPhone').value.trim();
    const out = $('#mResults');
    if (!/^[0-9+\-\s()]{7,15}$/.test(phone)) { toast('Enter a valid mobile number.', 'err'); return; }
    out.innerHTML = '<div class="skeleton" style="height:90px;border-radius:16px;margin-top:16px"></div>';
    try {
      const j = await post('/api/memberships/by-phone', { phone });
      if (!j.memberships.length) { out.innerHTML = '<p class="muted" style="margin-top:16px">No memberships found for this number.</p>'; return; }
      out.innerHTML = '<div style="margin-top:16px">' + j.memberships.map(membershipCard).join('') + '</div>';
    } catch (e) { out.innerHTML = '<p class="muted" style="margin-top:16px">' + esc(e.message) + '</p>'; }
  }

  $('#mFind').addEventListener('click', doMembershipFind);
  const mPhoneEl = $('#mPhone');
  if (mPhoneEl) mPhoneEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') doMembershipFind(); });
})();
