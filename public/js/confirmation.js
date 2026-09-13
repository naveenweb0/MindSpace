'use strict';
/* Booking confirmation page — loads the booking with a one-time view token. */

(function () {
  const $ = (s, c) => (c || document).querySelector(s);
  const fmtINR = (n) => '₹' + Number(n).toLocaleString('en-IN');
  const root = $('#confirmRoot');

  function fmtTime(t) {
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return (h % 12 === 0 ? 12 : h % 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
  }
  function fmtDate(d) {
    return new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function icsFile(b, actName) {
    const start = b.date.replace(/-/g, '') + 'T' + b.start_time.replace(':', '') + '00';
    const end = b.date.replace(/-/g, '') + 'T' + b.end_time.replace(':', '') + '00';
    const lines = [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//MindSpace Studio//EN', 'BEGIN:VEVENT',
      'UID:' + b.booking_reference + '@mindspacestudio', 'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z',
      'DTSTART:' + start, 'DTEND:' + end, 'SUMMARY:' + actName + ' at MindSpace Studio',
      'DESCRIPTION:Booking ' + b.booking_reference + '\\nCreate space for your mind. No experience. Just create.',
      'LOCATION:MindSpace Studio', 'END:VEVENT', 'END:VCALENDAR',
    ];
    return new Blob([lines.join('\r\n')], { type: 'text/calendar' });
  }

  async function load() {
    const params = new URLSearchParams(location.search);
    const ref = params.get('ref');
    const token = params.get('token');
    if (!ref) return renderMissing();

    let localBooking = null;
    try {
      const saved = JSON.parse(localStorage.getItem('tps_bookings') || '[]');
      localBooking = saved.find((b) => b.booking_reference === ref);
    } catch (_) {}

    try {
      const fullUrl = window.API_BASE ? window.API_BASE + '/api/bookings/lookup' : '/api/bookings/lookup';
      const r = await fetch(fullUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, token }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.message);
      renderBooking(j.booking);
      // ── persist to localStorage so My Booking works even after a server cold-start ──
      try {
        const saved = JSON.parse(localStorage.getItem('tps_bookings') || '[]');
        const idx = saved.findIndex((b) => b.booking_reference === j.booking.booking_reference);
        const entry = {
          ...j.booking,
          activity_name: (j.booking.activity && j.booking.activity.name) || (localBooking && localBooking.activity_name) || 'Session',
          activity_image: (j.booking.activity && j.booking.activity.image) || (localBooking && localBooking.activity_image) || '',
          _saved_at: Date.now(),
        };
        if (idx >= 0) saved[idx] = entry; else saved.unshift(entry);
        localStorage.setItem('tps_bookings', JSON.stringify(saved.slice(0, 50)));

        const adm = JSON.parse(localStorage.getItem('tps_admin_bookings') || '[]');
        const admIdx = adm.findIndex((b) => b.booking_reference === entry.booking_reference);
        if (admIdx >= 0) adm[admIdx] = entry; else adm.unshift(entry);
        localStorage.setItem('tps_admin_bookings', JSON.stringify(adm.slice(0, 50)));

        if (j.booking.customer_phone) localStorage.setItem('tps_last_phone', j.booking.customer_phone);
      } catch (_) {}
      return;
    } catch (e) {
      if (localBooking) {
        renderBooking(localBooking);
      } else {
        renderMissing(e.message);
      }
    }
  }

  function renderBooking(b) {
    const settings = (window.TPS && window.TPS.settings) || {};
    const actName = (b.activity && b.activity.name) || 'Session';
    const status = b.booking_status;
    const done = status === 'confirmed' || status === 'attended' || status === 'pending';

    root.innerHTML = `
      <div class="ce-badge">${done ? '🎨' : '💭'}</div>
      <h1>${done ? 'You’re booked! 🎨' : 'Booking ' + status.replace('_', ' ')}</h1>
      <p class="lead">${done ? 'Your creative space is officially on the calendar.' : 'Here’s the latest on your booking.'}</p>

      <div class="confirm-card">
        <div class="cc-head"><span class="ref">${esc(b.booking_reference)}</span><span class="b-status-pill ${status}">${status.replace('_', ' ')}</span></div>
        <div class="cc-body">
          <div class="cc-grid">
            <div class="cc-item"><div class="k">Activity</div><div class="v">${esc(actName)}</div></div>
            <div class="cc-item"><div class="k">Duration</div><div class="v">${b.duration} minutes</div></div>
            <div class="cc-item"><div class="k">Date</div><div class="v">${fmtDate(b.date)}</div></div>
            <div class="cc-item"><div class="k">Time</div><div class="v">${fmtTime(b.start_time)} – ${fmtTime(b.end_time)}</div></div>
            <div class="cc-item"><div class="k">Guests</div><div class="v">${b.number_of_guests}</div></div>
            <div class="cc-item"><div class="k">Paid</div><div class="v">${fmtINR(b.total_amount)} ${b.payment_status === 'paid' ? '✓' : ''}</div></div>
          </div>
        </div>
      </div>

      <div class="confirm-actions">
        <button class="btn btn-outline" id="addCal">📅 Add to Calendar</button>
        <a class="btn btn-outline" data-maps href="#">📍 Get Directions</a>
        <a class="btn btn-outline" data-wa="${settings.whatsapp || ''}" data-wa-msg="Hi! I just booked ${actName} (${b.booking_reference}) at MindSpace Studio.">💬 WhatsApp Us</a>
        <a class="btn btn-primary" href="/my-booking">View Booking</a>
      </div>

      <div class="arrival">
        <h3>When you arrive</h3>
        <p>📍 <span class="js-settings" data-key="address_line1" data-empty="Studio address — check Admin → Settings"></span> <span class="js-settings" data-key="address_line2"></span></p>
        <p>🕰️ Please arrive about 5 minutes early — your space and materials will be ready.</p>
        <p>🙋 Just tell our host your Booking ID: <strong>${esc(b.booking_reference)}</strong></p>
        <p class="muted" style="font-size:13.5px;margin-top:8px">${esc(settings.cancellation_policy || '')}</p>
      </div>`;

    $('#addCal').addEventListener('click', () => {
      const blob = icsFile(b, actName);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = b.booking_reference + '.ics';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
    // re-run settings hydration for newly injected elements
    if (window.TPS) {
      document.querySelectorAll('.js-settings').forEach((el) => {
        const key = el.getAttribute('data-key');
        const val = window.TPS.settings[key];
        el.textContent = val || el.getAttribute('data-empty') || '';
      });
      document.querySelectorAll('[data-wa]').forEach((a) => {
        const num = window.TPS.settings.whatsapp || a.getAttribute('data-wa');
        a.href = 'https://wa.me/' + String(num).replace(/\D/g, '') + '?text=' + encodeURIComponent(a.getAttribute('data-wa-msg') || '');
        a.target = '_blank'; a.rel = 'noopener';
        if (!window.TPS.settings.whatsapp) a.classList.add('is-muted');
      });
      document.querySelectorAll('[data-maps]').forEach((a) => {
        if (window.TPS.settings.maps_url) a.href = window.TPS.settings.maps_url;
        else a.classList.add('is-muted');
        a.target = '_blank'; a.rel = 'noopener';
      });
    }
  }

  function renderMissing(msg) {
    root.innerHTML = `
      <div class="ce-badge" style="background:var(--mustard-tint)">🔍</div>
      <h1>Hmm, we couldn’t find that booking.</h1>
      <p class="lead">${msg || 'The link may be incomplete. Try looking it up with your booking ID and phone number.'}</p>
      <div class="confirm-actions">
        <a class="btn btn-primary" href="/my-booking">Find my booking</a>
        <a class="btn btn-outline" href="/book">Book a session</a>
      </div>`;
  }

  load();
})();


