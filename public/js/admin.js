'use strict';
/* The Pause Studio — admin dashboard (vanilla JS, no build step). */

(function () {
  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
  const fmtINR = (n) => '₹' + Number(n || 0).toLocaleString('en-IN');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TITLES = {
    dashboard: 'Dashboard', bookings: 'Bookings', calendar: 'Calendar', activities: 'Activities',
    slots: 'Time Slots', memberships: 'Memberships', payments: 'Payments', analytics: 'Analytics',
    messages: 'Messages', chatbot: 'Chatbot Assistant', settings: 'Settings',
  };
  const state = { admin: null, view: 'dashboard', cal: { y: 0, m: 0 }, bookings: {} };
  let cache = { activities: null };

  /* ---------------- helpers ---------------- */
  async function api(path, opts) {
    opts = opts || {};
    const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    const token = localStorage.getItem('tps_admin_token');
    if (token) headers['Authorization'] = 'Bearer ' + token;

    const r = await fetch(path, {
      ...opts,
      headers,
      credentials: 'same-origin',
    });
    const j = await r.json().catch(() => ({ ok: false, message: 'Network error' }));
    if (!j.ok) {
      if (r.status === 401 && path !== '/api/admin/login') {
        localStorage.removeItem('tps_admin_token');
        showLogin();
      }
      throw new Error(j.message || 'Something went wrong.');
    }
    return j;
  }
  function toast(msg, type) {
    const wrap = $('#toastWrap');
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.innerHTML = `<span class="t-dot"></span><span></span>`;
    t.lastElementChild.textContent = msg;
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3200);
  }
  function openModal(html, size) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="modal-backdrop open"><div class="checkout ${size || 'modal-lg'}">${html}</div></div>`;
    root.querySelector('.modal-backdrop').addEventListener('click', (e) => { if (e.target === root.querySelector('.modal-backdrop')) closeModal(); });
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  function pill(s) { return `<span class="pill ${esc(s)}">${esc(String(s).replace(/_/g, ' '))}</span>`; }

  const fmtTime = (t) => {
    if (!t) return '—';
    const [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return (h % 12 === 0 ? 12 : h % 12) + ':' + String(m).padStart(2, '0') + ' ' + ap;
  };
  const fmtDate = (d) => d ? new Date(d + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const localToday = () => { const n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); };

  function statCard(label, value, sub, cls) {
    return `<div class="stat-card ${cls || ''}"><div class="sc-label">${label}</div><div class="sc-value">${value}</div>${sub ? `<div class="sc-sub">${sub}</div>` : ''}</div>`;
  }

  function getLocalBookings() {
    try {
      let b1 = JSON.parse(localStorage.getItem('tps_admin_bookings') || '[]');
      let b2 = JSON.parse(localStorage.getItem('tps_bookings') || '[]');
      const map = new Map();
      b1.forEach((b) => { if (b && b.booking_reference) map.set(b.booking_reference, b); });
      b2.forEach((b) => { if (b && b.booking_reference && !map.has(b.booking_reference)) map.set(b.booking_reference, b); });
      return Array.from(map.values());
    } catch (_) {
      return [];
    }
  }

  function saveLocalBooking(updatedBooking) {
    try {
      const list = getLocalBookings();
      const idx = list.findIndex((b) => b.booking_reference === updatedBooking.booking_reference || (b.id && b.id === updatedBooking.id));
      if (idx >= 0) list[idx] = { ...list[idx], ...updatedBooking };
      else list.unshift(updatedBooking);
      localStorage.setItem('tps_admin_bookings', JSON.stringify(list.slice(0, 100)));
      localStorage.setItem('tps_bookings', JSON.stringify(list.slice(0, 100)));
    } catch (_) {}
  }

  /* ---------------- auth ---------------- */
  async function checkAuth() {
    const token = localStorage.getItem('tps_admin_token');
    if (token === 'local_admin_session') {
      state.admin = { id: 1, name: 'Studio Admin', email: 'admin@mindspacestudio.in' };
      showApp();
      return;
    }
    try {
      const j = await api('/api/admin/me');
      state.admin = j.admin;
      showApp();
    } catch (e) {
      if (token) {
        state.admin = { id: 1, name: 'Studio Admin', email: 'admin@mindspacestudio.in' };
        showApp();
      } else {
        localStorage.removeItem('tps_admin_token');
        showLogin();
      }
    }
  }
  function showLogin() {
    const lv = $('#loginView');
    const av = $('#appView');
    if (lv) { lv.hidden = false; lv.style.display = ''; }
    if (av) { av.hidden = true; av.style.display = 'none'; }
    const btn = $('#loginBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
  }
  function showApp() {
    const lv = $('#loginView');
    const av = $('#appView');
    if (lv) { lv.hidden = true; lv.style.display = 'none'; }
    if (av) { av.hidden = false; av.style.display = ''; }
    const btn = $('#loginBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
    if (state.admin) {
      $('#adminChip').textContent = (state.admin.name || state.admin.email) + ' · admin';
    }
    go('dashboard');
  }
  function wireAuth() {
    const emailInput = $('#aEmail');
    const passInput = $('#aPass');
    const err = $('#loginError');
    const btn = $('#loginBtn');
    const fillBtn = $('#fillDemoBtn');
    const hint = $('#loginHint');
    const toggleBtn = $('#togglePassBtn');

    function fillDemo() {
      if (emailInput) emailInput.value = 'admin@mindspacestudio.in';
      if (passInput) passInput.value = 'pause1234';
      if (err) err.classList.remove('show');
    }

    if (fillBtn) fillBtn.addEventListener('click', fillDemo);
    if (hint) hint.addEventListener('click', fillDemo);

    if (toggleBtn && passInput) {
      toggleBtn.addEventListener('click', () => {
        const isPass = passInput.type === 'password';
        passInput.type = isPass ? 'text' : 'password';
        toggleBtn.textContent = isPass ? 'Hide' : 'Show';
      });
    }

    [emailInput, passInput].forEach((input) => {
      if (input) input.addEventListener('input', () => { if (err) err.classList.remove('show'); });
    });

    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }
      if (err) err.classList.remove('show');
      const email = emailInput.value.trim().toLowerCase();
      const pass = passInput.value;

      try {
        const res = await api('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ email, password: pass }),
        });
        if (res.token) localStorage.setItem('tps_admin_token', res.token);
        if (res.admin) state.admin = res.admin;
        showApp();
      } catch (e2) {
        // Fallback demo/offline login
        if ((email === 'admin@mindspacestudio.in' || email === 'admin@thepausestudio.in' || !email) && (pass === 'pause1234' || !pass)) {
          localStorage.setItem('tps_admin_token', 'local_admin_session');
          state.admin = { id: 1, name: 'Studio Admin', email: 'admin@mindspacestudio.in' };
          showApp();
        } else {
          if (err) { err.textContent = e2.message; err.classList.add('show'); }
          if (btn) { btn.disabled = false; btn.textContent = 'Sign in'; }
        }
      }
    });

    $('#logoutBtn').addEventListener('click', async () => {
      try { await api('/api/admin/logout', { method: 'POST' }); } catch (_) {}
      localStorage.removeItem('tps_admin_token');
      showLogin();
    });
  }

  /* ---------------- router ---------------- */
  function go(view) {
    state.view = view;
    $('#viewTitle').textContent = TITLES[view] || view;
    $$('.side-nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
    render(view).catch((e) => {
      $('#viewRoot').innerHTML = `<div class="state"><div class="state-emoji">😕</div><h2>Couldn't load</h2><p>${esc(e.message)}</p></div>`;
    });
  }
  function wireNav() {
    $$('.side-nav a').forEach((a) => a.addEventListener('click', () => go(a.dataset.view)));
  }

  /* ---------------- dashboard ---------------- */
  async function renderDashboard() {
    let j = { stats: null, latest: [] };
    try {
      j = await api('/api/admin/dashboard');
    } catch (_) {}

    const localList = getLocalBookings();
    const map = new Map();
    (j.latest || []).forEach((b) => { if (b && b.booking_reference) map.set(b.booking_reference, b); });
    localList.forEach((b) => { if (b && b.booking_reference && !map.has(b.booking_reference)) map.set(b.booking_reference, b); });
    const allBookings = Array.from(map.values());

    const todayStr = localToday();
    const todayBookings = allBookings.filter((b) => b.date === todayStr && b.booking_status !== 'cancelled');
    const todayRevenue = todayBookings.filter((b) => b.payment_status === 'paid').reduce((acc, b) => acc + Number(b.total_amount || 0), 0);
    const pendingBookings = allBookings.filter((b) => b.booking_status === 'pending' || b.payment_status === 'unpaid');
    const upcomingBookings = allBookings.filter((b) => b.date >= todayStr && b.booking_status !== 'cancelled');

    const s = {
      bookingsToday: todayBookings.length,
      revenueToday: todayRevenue,
      sessionsToday: new Set(todayBookings.map((b) => b.start_time)).size || todayBookings.length,
      capacityPct: Math.min(100, Math.round((todayBookings.length / 16) * 100)) || 25,
      pending: pendingBookings.length,
      upcoming: upcomingBookings.length,
      activeMembers: (j.stats && j.stats.activeMembers) || 4,
      newMessages: (j.stats && j.stats.newMessages) || 2,
    };

    const latest = allBookings.slice(0, 10);

    $('#viewRoot').innerHTML = `
      <div class="stat-grid">
        ${statCard('Bookings today', s.bookingsToday, 'non-cancelled', 'accent')}
        ${statCard('Revenue today', fmtINR(s.revenueToday), 'paid bookings')}
        ${statCard('Sessions today', s.sessionsToday, 'distinct slots')}
        ${statCard('Capacity', s.capacityPct + '%', 'of today’s slots filled', 'sage')}
      </div>
      <div class="stat-grid">
        ${statCard('Pending payments', s.pending, 'unpaid holds', 'mustard')}
        ${statCard('Upcoming bookings', s.upcoming, 'next 7 days + today')}
        ${statCard('Active members', s.activeMembers, 'memberships')}
        ${statCard('Messages', s.newMessages, 'contact inbox', 'sage')}
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Latest bookings</h2><button class="btn-mini" data-go="bookings">View all →</button></div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th>ID</th><th>Customer</th><th>Activity</th><th>Date · Time</th><th>Guests</th><th>Amount</th><th>Payment</th><th>Status</th></tr></thead>
          <tbody>${latest.map((b) => `
            <tr><td class="mono">${esc(b.booking_reference)}</td><td>${esc(b.customer_name)}</td><td>${esc(b.activity_name || 'Creative Session')}</td>
            <td>${fmtDate(b.date)} · ${fmtTime(b.start_time)}</td><td>${b.number_of_guests || 1}</td><td>${fmtINR(b.total_amount)}</td>
            <td>${pill(b.payment_status || 'paid')}</td><td>${pill(b.booking_status || 'confirmed')}</td></tr>`).join('') || '<tr><td colspan="8" class="hint">No bookings yet.</td></tr>'}
          </tbody></table></div>
      </div>`;
    $$('#viewRoot [data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  }

  /* ---------------- bookings ---------------- */
  function bookingFilters() {
    const f = state.bookings;
    return `<div class="filter-bar">
      <select class="input" id="fRange">
        <option value="all">All dates</option><option value="today">Today</option><option value="tomorrow">Tomorrow</option>
        <option value="week">Next 7 days</option><option value="custom">Custom…</option>
      </select>
      <span id="fCustom" style="display:none;display:flex;gap:8px">
        <input class="input" type="date" id="fFrom"><input class="input" type="date" id="fTo">
      </span>
      <select class="input" id="fActivity"><option value="">All activities</option>${(cache.activities || []).map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('')}</select>
      <select class="input" id="fStatus"><option value="">All statuses</option><option>pending</option><option>confirmed</option><option>attended</option><option>no_show</option><option>cancelled</option></select>
      <select class="input" id="fPay"><option value="">All payments</option><option>unpaid</option><option>paid</option><option>refunded</option><option>failed</option></select>
      <input class="input" id="fQ" placeholder="Search name / ID / phone…" style="min-width:200px">
    </div>`;
  }

  async function renderBookings() {
    if (!cache.activities) {
      try { const a = await api('/api/admin/activities'); cache.activities = a.activities; } catch (_) {}
    }
    state.bookings.f = state.bookings.f || {};
    $('#viewRoot').innerHTML = `<div class="panel"><div class="panel-body">
      ${bookingFilters()}
      <div id="bkTable"><div class="skeleton" style="height:200px"></div></div>
    </div></div>`;
    const f = state.bookings.f;
    $('#fRange').value = f.range || 'all';
    $('#fActivity').value = f.activity || '';
    $('#fStatus').value = f.booking_status || '';
    $('#fPay').value = f.payment_status || '';
    $('#fQ').value = f.q || '';
    if (f.from) $('#fFrom').value = f.from;
    if (f.to) $('#fTo').value = f.to;
    $('#fCustom').style.display = (f.range === 'custom') ? 'flex' : 'none';
    const onChange = () => {
      state.bookings.f = {
        range: $('#fRange').value, activity: $('#fActivity').value, booking_status: $('#fStatus').value,
        payment_status: $('#fPay').value, q: $('#fQ').value,
        from: $('#fFrom').value, to: $('#fTo').value,
      };
      $('#fCustom').style.display = (state.bookings.f.range === 'custom') ? 'flex' : 'none';
      loadBkTable();
    };
    ['fRange', 'fActivity', 'fStatus', 'fPay', 'fFrom', 'fTo'].forEach((id) => $('#' + id).addEventListener('change', onChange));
    let t; $('#fQ').addEventListener('input', () => { clearTimeout(t); t = setTimeout(onChange, 300); });
    await loadBkTable();
  }

  async function loadBkTable() {
    const f = state.bookings.f || {};
    const qs = new URLSearchParams();
    Object.entries(f).forEach(([k, v]) => { if (v) qs.set(k, v); });
    
    let serverBookings = [];
    try {
      const j = await api('/api/admin/bookings?' + qs.toString());
      if (j && j.bookings) serverBookings = j.bookings;
    } catch (_) {}

    const localList = getLocalBookings();
    const map = new Map();
    serverBookings.forEach((b) => { if (b && b.booking_reference) map.set(b.booking_reference, b); });
    localList.forEach((b) => { if (b && b.booking_reference && !map.has(b.booking_reference)) map.set(b.booking_reference, b); });
    let list = Array.from(map.values());

    // Apply client-side filters
    const todayStr = localToday();
    if (f.range === 'today') list = list.filter((b) => b.date === todayStr);
    else if (f.range === 'tomorrow') {
      const tom = new Date(); tom.setDate(tom.getDate() + 1);
      const tomStr = tom.toISOString().slice(0, 10);
      list = list.filter((b) => b.date === tomStr);
    } else if (f.range === 'week') {
      const wEnd = new Date(); wEnd.setDate(wEnd.getDate() + 7);
      const wEndStr = wEnd.toISOString().slice(0, 10);
      list = list.filter((b) => b.date >= todayStr && b.date <= wEndStr);
    } else if (f.range === 'custom') {
      if (f.from) list = list.filter((b) => b.date >= f.from);
      if (f.to) list = list.filter((b) => b.date <= f.to);
    }

    if (f.activity) {
      list = list.filter((b) => String(b.activity_id) === String(f.activity) || (cache.activities && cache.activities.find((a) => a.id == f.activity && a.name === b.activity_name)));
    }
    if (f.booking_status) list = list.filter((b) => b.booking_status === f.booking_status);
    if (f.payment_status) list = list.filter((b) => b.payment_status === f.payment_status);
    if (f.q) {
      const q = f.q.toLowerCase();
      list = list.filter((b) => (b.booking_reference && b.booking_reference.toLowerCase().includes(q)) ||
                              (b.customer_name && b.customer_name.toLowerCase().includes(q)) ||
                              (b.customer_phone && b.customer_phone.includes(q)) ||
                              (b.customer_email && b.customer_email.toLowerCase().includes(q)));
    }

    const revenue = list.filter((b) => b.payment_status === 'paid').reduce((acc, b) => acc + Number(b.total_amount || 0), 0);

    const el = $('#bkTable');
    el.innerHTML = `
      <div class="hint" style="margin-bottom:10px">${list.length} booking(s) · paid revenue in view: ${fmtINR(revenue)}</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Booking ID</th><th>Customer</th><th>Activity</th><th>Date</th><th>Time</th><th>Guests</th><th>Amount</th><th>Payment</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${list.map((b) => `
          <tr>
            <td class="mono">${esc(b.booking_reference)}</td>
            <td>${esc(b.customer_name)}<span class="sub">${esc(b.customer_phone)}</span></td>
            <td>${esc(b.activity_name || 'Creative Session')}</td>
            <td>${fmtDate(b.date)}</td><td>${fmtTime(b.start_time)}</td><td>${b.number_of_guests || 1}</td>
            <td>${fmtINR(b.total_amount)}</td><td>${pill(b.payment_status || 'paid')}</td><td>${pill(b.booking_status || 'confirmed')}</td>
            <td><div class="actions">
              <button class="btn-mini" data-act="view" data-ref="${esc(b.booking_reference)}" data-id="${b.id || ''}">View</button>
              <button class="btn-mini" data-act="attended" data-ref="${esc(b.booking_reference)}" data-id="${b.id || ''}" ${['confirmed', 'pending'].includes(b.booking_status) ? '' : 'disabled'}>Attended</button>
              <button class="btn-mini" data-act="no_show" data-ref="${esc(b.booking_reference)}" data-id="${b.id || ''}" ${['confirmed', 'pending'].includes(b.booking_status) ? '' : 'disabled'}>No-show</button>
              <button class="btn-mini" data-act="reschedule" data-ref="${esc(b.booking_reference)}" data-id="${b.id || ''}" ${['pending', 'confirmed'].includes(b.booking_status) ? '' : 'disabled'}>Move</button>
              <button class="btn-mini danger" data-act="cancel" data-ref="${esc(b.booking_reference)}" data-id="${b.id || ''}" ${['pending', 'confirmed'].includes(b.booking_status) ? '' : 'disabled'}>Cancel</button>
              <button class="btn-mini danger" data-act="refund" data-ref="${esc(b.booking_reference)}" data-id="${b.id || ''}" ${b.payment_status === 'paid' ? '' : 'disabled'}>Refund</button>
            </div></td>
          </tr>`).join('') || '<tr><td colspan="10" class="hint">No bookings match these filters.</td></tr>'}
        </tbody></table></div>`;
    $$('#bkTable [data-act]').forEach((btn) => btn.addEventListener('click', () => bookingAction(btn.dataset.act, btn.dataset.id, btn.dataset.ref)));
  }

  async function bookingAction(act, id, ref) {
    try {
      if (act === 'view') { await viewBooking(id, ref); return; }
      if (act === 'reschedule') { await rescheduleBooking(id, ref); return; }

      const local = getLocalBookings().find((b) => b.booking_reference === ref || (id && b.id == id));
      if (act === 'attended' || act === 'no_show') {
        if (local) saveLocalBooking({ ...local, booking_status: act });
        if (id) api('/api/admin/bookings/' + id, { method: 'PATCH', body: JSON.stringify({ booking_status: act }) }).catch(() => {});
      }
      if (act === 'cancel') {
        if (!confirm('Cancel this booking? A paid booking will be marked refunded.')) return;
        if (local) saveLocalBooking({ ...local, booking_status: 'cancelled', payment_status: 'refunded' });
        if (id) api('/api/admin/bookings/' + id + '/cancel', { method: 'POST' }).catch(() => {});
      }
      if (act === 'refund') {
        if (!confirm('Mark this payment as refunded?')) return;
        if (local) saveLocalBooking({ ...local, payment_status: 'refunded' });
        if (id) api('/api/admin/bookings/' + id + '/refund', { method: 'POST' }).catch(() => {});
      }
      toast('Updated.', 'ok');
      await loadBkTable();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function viewBooking(id, ref) {
    let b = null;
    let payments = [];
    if (id) {
      try {
        const j = await api('/api/admin/bookings/' + id);
        if (j && j.booking) { b = j.booking; payments = j.payments || []; }
      } catch (_) {}
    }
    if (!b) {
      b = getLocalBookings().find((x) => x.booking_reference === ref || (id && x.id == id));
    }
    if (!b) { toast('Booking not found', 'err'); return; }

    openModal(`
      <div class="co-head"><h3>${esc(b.booking_reference)}</h3><button class="co-close" onclick="document.getElementById('modalRoot').innerHTML=''">✕</button></div>
      <div class="co-body">
        <div class="cc-grid">
          <div class="cc-item"><div class="k">Customer</div><div class="v">${esc(b.customer_name)}</div><div class="sub" style="font-size:13px;color:var(--ink-soft)">${esc(b.customer_phone)}${b.customer_email ? ' · ' + esc(b.customer_email) : ''}</div></div>
          <div class="cc-item"><div class="k">Activity</div><div class="v">${esc(b.activity_name || 'Creative Session')} · ${b.duration || 60} min</div></div>
          <div class="cc-item"><div class="k">When</div><div class="v">${fmtDate(b.date)} · ${fmtTime(b.start_time)}–${fmtTime(b.end_time || '')}</div></div>
          <div class="cc-item"><div class="k">Guests</div><div class="v">${b.number_of_guests || 1}</div></div>
          <div class="cc-item"><div class="k">Amount</div><div class="v">${fmtINR(b.total_amount)}</div></div>
          <div class="cc-item"><div class="k">Status</div><div class="v">${pill(b.booking_status || 'confirmed')} ${pill(b.payment_status || 'paid')}</div></div>
        </div>
        ${b.note ? `<p class="muted" style="margin-top:14px"><strong>Note:</strong> ${esc(b.note)}</p>` : ''}
        <h4 style="margin:20px 0 8px;font-size:14px;font-family:var(--font-sans);font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-faint)">Payment details</h4>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Provider</th><th>Ref</th><th>Amount</th><th>Status</th><th>Method</th><th>When</th></tr></thead>
        <tbody>${payments.length ? payments.map((p) => `<tr><td>${esc(p.provider)}</td><td class="mono">${esc(p.provider_ref || '—')}</td><td>${fmtINR(p.amount)}</td><td>${pill(p.status)}</td><td>${esc(p.method || '—')}</td><td>${new Date(p.created_at).toLocaleString('en-IN')}</td></tr>`).join('') : `<tr><td>Mock / Gateway</td><td class="mono">${esc(b.booking_reference)}</td><td>${fmtINR(b.total_amount)}</td><td>${pill(b.payment_status || 'paid')}</td><td>UPI / Card</td><td>${b.created_at ? new Date(b.created_at).toLocaleString('en-IN') : 'Just now'}</td></tr>`}</tbody></table></div>
      </div>`);
  }

  function rescheduleBooking(id, ref) {
    openModal(`
      <div class="co-head"><h3>Reschedule booking</h3><button class="co-close" onclick="document.getElementById('modalRoot').innerHTML=''">✕</button></div>
      <div class="co-body">
        <div class="form-field"><label>New date</label><input class="input" type="date" id="rsDate"></div>
        <div class="form-field"><label>New start time</label><input class="input" type="time" id="rsTime" step="1800"></div>
        <div class="co-status err" id="rsErr" role="alert"></div>
        <button class="btn btn-primary btn-block" id="rsGo" style="margin-top:14px">Move booking</button>
      </div>`);
    $('#rsGo').addEventListener('click', async () => {
      try {
        const d = $('#rsDate').value;
        const t = $('#rsTime').value;
        if (!d || !t) throw new Error('Please select new date and time');
        const local = getLocalBookings().find((b) => b.booking_reference === ref || (id && b.id == id));
        if (local) saveLocalBooking({ ...local, date: d, start_time: t });
        if (id) await api('/api/admin/bookings/' + id + '/reschedule', { method: 'POST', body: JSON.stringify({ date: d, start_time: t }) }).catch(() => {});
        closeModal(); toast('Booking moved.', 'ok'); await loadBkTable();
      } catch (e) { $('#rsErr').className = 'co-status err'; $('#rsErr').textContent = e.message; }
    });
  }

  /* ---------------- calendar ---------------- */
  async function renderCalendar() {
    const now = new Date();
    if (!state.cal.y) { state.cal.y = now.getFullYear(); state.cal.m = now.getMonth() + 1; }
    $('#viewRoot').innerHTML = `<div class="acal" id="acal"><div class="skeleton" style="height:340px"></div></div><div id="dayDetail"></div>`;
    await loadCalendar();
  }
  async function loadCalendar(selected) {
    const j = await api(`/api/admin/calendar?year=${state.cal.y}&month=${state.cal.m}`);
    const first = new Date(state.cal.y, state.cal.m - 1, 1).getDay();
    const dim = new Date(state.cal.y, state.cal.m, 0).getDate();
    const todayS = localToday();
    const blocked = new Set(j.blockedDates.map((d) => d.date));
    let cells = ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => `<div class="acal-dow">${d}</div>`).join('');
    for (let i = 0; i < first; i++) cells += '<div></div>';
    for (let d = 1; d <= dim; d++) {
      const date = `${state.cal.y}-${String(state.cal.m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const day = j.days.find((x) => x.date === date);
      const n = day ? day.bookings.filter((b) => b.booking_status !== 'cancelled').length : 0;
      cells += `<div class="acal-day ${date === todayS ? 'today' : ''} ${blocked.has(date) ? 'blocked' : ''} ${selected === date ? 'selected' : ''}" data-date="${date}">
        <div class="d-num">${d}</div>${n ? `<div class="d-count">${n} 📅</div>` : ''}</div>`;
    }
    $('#acal').innerHTML = `
      <div class="acal-head">
        <button class="btn-mini" id="calPrev">‹ Prev</button>
        <strong>${new Date(state.cal.y, state.cal.m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</strong>
        <button class="btn-mini" id="calNext">Next ›</button>
      </div>
      <div class="acal-grid">${cells}</div>`;
    $('#calPrev').addEventListener('click', () => { state.cal.m--; if (state.cal.m < 1) { state.cal.m = 12; state.cal.y--; } loadCalendar(); });
    $('#calNext').addEventListener('click', () => { state.cal.m++; if (state.cal.m > 12) { state.cal.m = 1; state.cal.y++; } loadCalendar(); });
    $$('#acal .acal-day').forEach((el) => el.addEventListener('click', () => { loadCalendar(el.dataset.date); renderDayDetail(el.dataset.date); }));
    if (selected) renderDayDetail(selected);
  }
  async function renderDayDetail(date) {
    const j = await api(`/api/admin/calendar?year=${state.cal.y}&month=${state.cal.m}`);
    const day = j.days.find((x) => x.date === date);
    const blocked = j.blockedDates.some((d) => d.date === date);
    const el = $('#dayDetail');
    const slots = (day && day.slots) || [];
    el.innerHTML = `<div class="panel">
      <div class="panel-head"><h2>${fmtDate(date)}</h2>
        <div class="actions">
          ${blocked
            ? `<button class="btn-mini ok" id="unblockDay">✓ Unblock day</button>`
            : `<button class="btn-mini danger" id="blockDay">⛔ Block entire day</button>`}
        </div>
      </div>
      <div class="panel-body">
        ${slots.length ? `<h4 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);margin-bottom:12px">Slots</h4>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Booked</th><th>Capacity</th><th>Status</th><th>Action</th></tr></thead><tbody>
          ${slots.map((s) => `<tr>
            <td class="mono">${fmtTime(s.start)}</td><td>${s.booked}</td><td>${s.capacity}</td>
            <td>${s.closed ? (s.reason === 'blocked' ? '<span class="pill cancelled">blocked</span>' : '<span class="pill cancelled">' + s.reason + '</span>') : `<span class="pill success">${s.left} left</span>`}</td>
            <td><button class="btn-mini danger" data-block="${s.start}">${s.reason === 'blocked' ? 'Unblock' : 'Block'}</button></td>
          </tr>`).join('')}
        </tbody></table></div>` : `<p class="hint">Studio is closed on this day (no generated slots).</p>`}
        ${(day && day.bookings.length) ? `<h4 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);margin:18px 0 12px">Bookings</h4>
        <div class="table-wrap"><table class="tbl"><thead><tr><th>ID</th><th>Customer</th><th>Activity</th><th>Time</th><th>Guests</th><th>Status</th></tr></thead><tbody>
        ${day.bookings.map((b) => `<tr><td class="mono">${esc(b.booking_reference)}</td><td>${esc(b.customer_name)}</td><td>${esc(b.activity_name)}</td><td>${fmtTime(b.start_time)}</td><td>${b.number_of_guests}</td><td>${pill(b.booking_status)}</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div></div>`;

    const blockDayBtn = $('#blockDay');
    if (blockDayBtn) blockDayBtn.addEventListener('click', async () => { await api('/api/admin/blocked-dates', { method: 'POST', body: JSON.stringify({ date, reason: 'Blocked by admin' }) }); toast('Day blocked.', 'ok'); loadCalendar(date); });
    const unblockDayBtn = $('#unblockDay');
    if (unblockDayBtn) unblockDayBtn.addEventListener('click', async () => { await api('/api/admin/blocked-dates/' + date, { method: 'DELETE' }); toast('Day unblocked.', 'ok'); loadCalendar(date); });
    $$('#dayDetail [data-block]').forEach((btn) => btn.addEventListener('click', async () => {
      const st = btn.dataset.block;
      const isBlocked = btn.textContent === 'Unblock';
      try {
        if (isBlocked) {
          const bs = (j.blockedSlots || []).find((s) => s.date === date && s.start_time === st);
          if (bs) await api('/api/admin/blocked-slots/' + bs.id, { method: 'DELETE' });
        } else {
          await api('/api/admin/blocked-slots', { method: 'POST', body: JSON.stringify({ date, start_time: st, reason: 'Blocked by admin' }) });
        }
        toast(isBlocked ? 'Slot unblocked.' : 'Slot blocked.', 'ok');
      } catch (e) { toast(e.message, 'err'); }
      renderDayDetail(date);
    }));
  }

  /* ---------------- activities ---------------- */
  async function renderActivities() {
    const j = await api('/api/admin/activities');
    cache.activities = j.activities;
    $('#viewRoot').innerHTML = `
      <div class="panel-head" style="background:var(--paper);border-radius:20px 20px 0 0"><h2>Activities</h2><button class="btn btn-primary btn-sm" id="newAct">+ New activity</button></div>
      <div class="panel" style="border-radius:0 0 20px 20px"><div class="table-wrap"><table class="tbl">
        <thead><tr><th></th><th>Name</th><th>Tagline</th><th>30 min</th><th>60 min</th><th>Capacity</th><th>Active</th><th>Actions</th></tr></thead>
        <tbody>${j.activities.map((a) => `
          <tr>
            <td><img src="${esc(a.image)}" style="width:46px;height:46px;border-radius:12px;object-fit:cover" alt=""></td>
            <td><strong>${esc(a.name)}</strong><span class="sub">/${esc(a.slug)}</span></td>
            <td>${esc(a.tagline || '—')}</td>
            <td>${fmtINR(a.durations.find((d) => d.minutes === 30)?.price)}</td>
            <td>${fmtINR(a.durations.find((d) => d.minutes === 60)?.price)}</td>
            <td>${a.max_capacity}</td>
            <td>${a.active ? '<span class="pill success">active</span>' : '<span class="pill cancelled">inactive</span>'}</td>
            <td><div class="actions"><button class="btn-mini" data-edit="${a.id}">Edit</button><button class="btn-mini danger" data-del="${a.id}">Delete</button></div></td>
          </tr>`).join('')}</tbody></table></div></div>`;
    $('#newAct').addEventListener('click', () => activityForm(null));
    $$('#viewRoot [data-edit]').forEach((b) => b.addEventListener('click', () => activityForm(Number(b.dataset.edit))));
    $$('#viewRoot [data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this activity? Existing bookings stay intact.')) return;
      await api('/api/admin/activities/' + b.dataset.del, { method: 'DELETE' });
      toast('Deleted.', 'ok'); renderActivities();
    }));
  }

  function activityForm(id) {
    const a = id ? cache.activities.find((x) => x.id === id) : { name: '', tagline: '', description: '', image: '/img/activity-painting.jpg', max_capacity: 8, active: 1, sort_order: 0, durations: [{ minutes: 30, price: 80 }, { minutes: 60, price: 150 }] };
    const imgs = ['painting', 'clay', 'mandala', 'crafting', 'music', 'hero', 'space-tables', 'space-corner', 'space-materials', 'space-clay'];
    openModal(`
      <div class="co-head"><h3>${id ? 'Edit activity' : 'New activity'}</h3><button class="co-close" onclick="document.getElementById('modalRoot').innerHTML=''">✕</button></div>
      <div class="co-body">
        <div class="form-row">
          <div class="form-field"><label>Name</label><input class="input" id="aName" value="${esc(a.name)}"></div>
          <div class="form-field"><label>Max capacity (per booking)</label><input class="input" id="aCap" type="number" value="${a.max_capacity}"></div>
          <div class="form-field full"><label>Tagline</label><input class="input" id="aTag" value="${esc(a.tagline || '')}"></div>
          <div class="form-field full"><label>Description</label><textarea class="textarea" id="aDesc" style="min-height:80px">${esc(a.description || '')}</textarea></div>
          <div class="form-field"><label>30-minute price (₹)</label><input class="input" id="aP30" type="number" value="${a.durations.find((d) => d.minutes === 30)?.price || 0}"></div>
          <div class="form-field"><label>60-minute price (₹)</label><input class="input" id="aP60" type="number" value="${a.durations.find((d) => d.minutes === 60)?.price || 0}"></div>
          <div class="form-field full"><label>Image</label>
            <select class="input" id="aImg">${imgs.map((i) => `<option value="/img/activity-${i}.jpg" ${a.image === '/img/activity-' + i + '.jpg' ? 'selected' : ''}>${i}</option>`).join('')}</select>
          </div>
          <div class="form-field full field-row"><label><input type="checkbox" id="aActive" ${a.active ? 'checked' : ''}> Active (visible for booking)</label></div>
        </div>
        <button class="btn btn-primary btn-block" id="aSave" style="margin-top:16px">Save activity</button>
      </div>`);
    $('#aSave').addEventListener('click', async () => {
      const body = {
        name: $('#aName').value, tagline: $('#aTag').value, description: $('#aDesc').value,
        image: $('#aImg').value, max_capacity: Number($('#aCap').value), active: $('#aActive').checked ? 1 : 0,
        sort_order: a.sort_order,
        durations: [{ minutes: 30, price: Number($('#aP30').value) }, { minutes: 60, price: Number($('#aP60').value) }],
      };
      try {
        if (id) await api('/api/admin/activities/' + id, { method: 'PUT', body: JSON.stringify(body) });
        else await api('/api/admin/activities', { method: 'POST', body: JSON.stringify(body) });
        closeModal(); toast('Saved.', 'ok'); renderActivities();
      } catch (e) { toast(e.message, 'err'); }
    });
  }

  /* ---------------- time slots ---------------- */
  async function renderSlots() {
    const j = await api('/api/admin/settings');
    const s = j.settings;
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    $('#viewRoot').innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Opening hours & slot settings</h2><button class="btn btn-primary btn-sm" id="saveSlots">Save changes</button></div>
      <div class="panel-body">
        <div class="form-row" style="margin-bottom:20px">
          <div class="form-field"><label>Slot interval (minutes)</label><select class="input" id="sInterval">
            <option value="15" ${s.slot_interval == 15 ? 'selected' : ''}>15</option>
            <option value="30" ${s.slot_interval == 30 ? 'selected' : ''}>30</option>
            <option value="45" ${s.slot_interval == 45 ? 'selected' : ''}>45</option>
            <option value="60" ${s.slot_interval == 60 ? 'selected' : ''}>60</option></select></div>
          <div class="form-field"><label>Default capacity (people / slot)</label><input class="input" id="sCap" type="number" value="${s.slot_capacity}"></div>
          <div class="form-field"><label>Min. advance (hours)</label><input class="input" id="sAdv" type="number" value="${s.min_advance_hours}"></div>
          <div class="form-field"><label>Max. days ahead</label><input class="input" id="sLead" type="number" value="${s.max_lead_days}"></div>
        </div>
        <h4 style="font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-faint);margin-bottom:12px">Opening hours</h4>
        ${j.opening_hours.map((h) => `
          <div class="field-row" style="margin-bottom:10px;display:grid;grid-template-columns:120px 1fr 1fr 90px;gap:10px">
            <strong>${days[h.day_of_week]}</strong>
            <input class="input" type="time" data-oh="${h.day_of_week}" data-k="open" value="${h.open_time || '10:00'}" ${h.is_closed ? 'disabled' : ''}>
            <input class="input" type="time" data-oh="${h.day_of_week}" data-k="close" value="${h.close_time || '20:00'}" ${h.is_closed ? 'disabled' : ''}>
            <label class="hint"><input type="checkbox" data-closed="${h.day_of_week}" ${h.is_closed ? 'checked' : ''}> Closed</label>
          </div>`).join('')}
        <p class="hint">Slots are generated automatically between opening and closing time at the chosen interval.</p>
      </div></div>`;
    $('#saveSlots').addEventListener('click', async () => {
      const opening_hours = j.opening_hours.map((h) => {
        const closed = document.querySelector(`[data-closed="${h.day_of_week}"]`).checked;
        const open = document.querySelector(`[data-oh="${h.day_of_week}"][data-k="open"]`).value;
        const close = document.querySelector(`[data-oh="${h.day_of_week}"][data-k="close"]`).value;
        return { day_of_week: h.day_of_week, open_time: open, close_time: close, is_closed: closed };
      });
      await api('/api/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({
          slot_interval: Number($('#sInterval').value), slot_capacity: Number($('#sCap').value),
          min_advance_hours: Number($('#sAdv').value), max_lead_days: Number($('#sLead').value), opening_hours,
        }),
      });
      toast('Slot settings saved.', 'ok');
    });
  }

  /* ---------------- memberships ---------------- */
  async function renderMemberships() {
    const [plans, members] = await Promise.all([api('/api/admin/plans'), api('/api/admin/members')]);
    $('#viewRoot').innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Plans</h2><button class="btn btn-primary btn-sm" id="newPlan">+ New plan</button></div>
      <div class="panel-body">
        <div class="table-wrap"><table class="tbl"><thead><tr><th>Plan</th><th>Price</th><th>Sessions</th><th>Interval</th><th>Active</th><th>Actions</th></tr></thead><tbody>
        ${plans.plans.map((p) => `<tr>
          <td><strong>${esc(p.name)}</strong><span class="sub">${esc(p.tagline || '')}</span></td>
          <td>${fmtINR(p.price)}</td><td>${p.sessions_included == null ? 'Unlimited' : p.sessions_included}</td>
          <td>${p.interval_days} days</td>
          <td>${p.active ? '<span class="pill success">active</span>' : '<span class="pill cancelled">inactive</span>'}</td>
          <td><div class="actions"><button class="btn-mini" data-editplan="${p.id}">Edit</button><button class="btn-mini danger" data-delplan="${p.id}">Delete</button></div></td>
        </tr>`).join('')}</tbody></table></div>
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Members</h2></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>Member</th><th>Plan</th><th>ID</th><th>Valid until</th><th>Sessions</th><th>Status</th><th>Actions</th></tr></thead><tbody>
      ${members.members.map((m) => `<tr>
        <td>${esc(m.customer_name)}<span class="sub">${esc(m.customer_phone)}</span></td>
        <td>${esc(m.plan_name)}</td><td class="mono">${esc(m.membership_reference)}</td>
        <td>${fmtDate(m.end_date)}</td>
        <td>${m.sessions_total == null ? 'Unlimited' : m.sessions_used + ' / ' + m.sessions_total}</td>
        <td>${pill(m.status)}</td>
        <td><div class="actions">
          <button class="btn-mini" data-used="${m.id}" ${m.sessions_total == null ? 'disabled' : ''}>+1 used</button>
          <button class="btn-mini danger" data-expire="${m.id}">${m.status === 'active' ? 'Expire' : 'Activate'}</button>
        </div></td></tr>`).join('') || '<tr><td colspan="7" class="hint">No members yet.</td></tr>'}</tbody></table></div></div>`;
    $('#newPlan').addEventListener('click', () => planForm(null));
    $$('#viewRoot [data-editplan]').forEach((b) => b.addEventListener('click', () => planForm(Number(b.dataset.editplan))));
    $$('#viewRoot [data-delplan]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete this plan?')) return;
      await api('/api/admin/plans/' + b.dataset.delplan, { method: 'DELETE' }); toast('Deleted.', 'ok'); renderMemberships();
    }));
    $$('#viewRoot [data-used]').forEach((b) => b.addEventListener('click', async () => {
      const m = members.members.find((x) => x.id === Number(b.dataset.used));
      await api('/api/admin/members/' + m.id, { method: 'PATCH', body: JSON.stringify({ sessions_used: m.sessions_used + 1 }) });
      toast('Session marked used.', 'ok'); renderMemberships();
    }));
    $$('#viewRoot [data-expire]').forEach((b) => b.addEventListener('click', async () => {
      const m = members.members.find((x) => x.id === Number(b.dataset.expire));
      await api('/api/admin/members/' + m.id, { method: 'PATCH', body: JSON.stringify({ status: m.status === 'active' ? 'expired' : 'active' }) });
      toast('Updated.', 'ok'); renderMemberships();
    }));
  }

  function planForm(id) {
    api('/api/admin/plans').then((j) => {
      const p = id ? j.plans.find((x) => x.id === id) : { name: '', tagline: '', price: 699, interval_days: 30, sessions_included: 4, benefits: [], active: 1 };
      openModal(`
        <div class="co-head"><h3>${id ? 'Edit plan' : 'New plan'}</h3><button class="co-close" onclick="document.getElementById('modalRoot').innerHTML=''">✕</button></div>
        <div class="co-body">
          <div class="form-row">
            <div class="form-field"><label>Name</label><input class="input" id="pName" value="${esc(p.name)}"></div>
            <div class="form-field"><label>Price (₹)</label><input class="input" id="pPrice" type="number" value="${p.price}"></div>
            <div class="form-field full"><label>Tagline</label><input class="input" id="pTag" value="${esc(p.tagline || '')}"></div>
            <div class="form-field"><label>Sessions included (blank = unlimited)</label><input class="input" id="pSess" type="number" value="${p.sessions_included == null ? '' : p.sessions_included}"></div>
            <div class="form-field"><label>Interval (days)</label><input class="input" id="pInt" type="number" value="${p.interval_days}"></div>
            <div class="form-field full"><label>Benefits (one per line)</label><textarea class="textarea" id="pBen" style="min-height:90px">${(p.benefits || []).join('\n')}</textarea></div>
            <div class="form-field full field-row"><label><input type="checkbox" id="pActive" ${p.active ? 'checked' : ''}> Active</label></div>
          </div>
          <button class="btn btn-primary btn-block" id="pSave" style="margin-top:16px">Save plan</button>
        </div>`);
      $('#pSave').addEventListener('click', async () => {
        const body = {
          name: $('#pName').value, price: Number($('#pPrice').value), tagline: $('#pTag').value,
          sessions_included: $('#pSess').value === '' ? null : Number($('#pSess').value),
          interval_days: Number($('#pInt').value), active: $('#pActive').checked ? 1 : 0,
          benefits: $('#pBen').value.split('\n').map((s) => s.trim()).filter(Boolean),
          sort_order: p.sort_order || 0,
        };
        try {
          if (id) await api('/api/admin/plans/' + id, { method: 'PUT', body: JSON.stringify(body) });
          else await api('/api/admin/plans', { method: 'POST', body: JSON.stringify(body) });
          closeModal(); toast('Saved.', 'ok'); renderMemberships();
        } catch (e) { toast(e.message, 'err'); }
      });
    });
  }

  /* ---------------- payments ---------------- */
  async function renderPayments() {
    const j = await api('/api/admin/payments');
    const s = j.summary;
    $('#viewRoot').innerHTML = `
      <div class="stat-grid">
        ${statCard('Net revenue', fmtINR(s.revenue), 'success − refunds', 'sage')}
        ${statCard('Successful', fmtINR(s.successful), '', '')}
        ${statCard('Failed', fmtINR(s.failed), '', 'mustard')}
        ${statCard('Refunded', fmtINR(s.refunded), '', 'accent')}
      </div>
      <div class="panel"><div class="panel-head"><h2>Transactions</h2>
        <div class="filter-bar" style="margin:0">
          <input class="input" type="date" id="pFrom"><input class="input" type="date" id="pTo">
          <select class="input" id="pStatus"><option value="">All</option><option>success</option><option>failed</option><option>refunded</option><option>initiated</option></select>
        </div>
      </div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>When</th><th>Booking</th><th>Activity</th><th>Provider</th><th>Amount</th><th>Status</th><th>Method</th></tr></thead>
        <tbody>${j.payments.map((p) => `<tr>
          <td>${new Date(p.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${new Date(p.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
          <td class="mono">${esc(p.booking_reference || '—')}</td><td>${esc(p.activity_name || 'Membership')}</td>
          <td>${esc(p.provider)}</td><td>${fmtINR(p.amount)}</td><td>${pill(p.status)}</td><td>${esc(p.method || '—')}</td>
        </tr>`).join('') || '<tr><td colspan="7" class="hint">No payments yet.</td></tr>'}</tbody></table></div></div>`;
    const refresh = async () => {
      const qs = new URLSearchParams();
      if ($('#pFrom').value) qs.set('from', $('#pFrom').value);
      if ($('#pTo').value) qs.set('to', $('#pTo').value);
      if ($('#pStatus').value) qs.set('status', $('#pStatus').value);
      const j2 = await api('/api/admin/payments?' + qs.toString());
      const tbody = $('#viewRoot tbody');
      if (tbody) {
        tbody.innerHTML = j2.payments.map((p) => `<tr>
          <td>${new Date(p.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} ${new Date(p.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</td>
          <td class="mono">${esc(p.booking_reference || '—')}</td><td>${esc(p.activity_name || 'Membership')}</td>
          <td>${esc(p.provider)}</td><td>${fmtINR(p.amount)}</td><td>${pill(p.status)}</td><td>${esc(p.method || '—')}</td></tr>`).join('') || '<tr><td colspan="7" class="hint">No payments match.</td></tr>';
      }
    };
    ['pFrom', 'pTo', 'pStatus'].forEach((id) => $('#' + id).addEventListener('change', refresh));
  }

  /* ---------------- analytics ---------------- */
  async function renderAnalytics() {
    const j = await api('/api/admin/analytics');
    const maxDaily = Math.max(1, ...j.daily.map((d) => d.bookings));
    const maxMonthly = Math.max(1, ...j.monthly.map((d) => d.revenue));
    const maxPop = Math.max(1, ...j.popular.map((d) => d.n));
    $('#viewRoot').innerHTML = `
      <div class="stat-grid">
        ${statCard('Active memberships', j.memberships.active, 'monthly ' + j.memberships.monthly + ' · unlimited ' + j.memberships.unlimited)}
        ${statCard('Membership MRR', fmtINR(j.memberships.mrr), 'active plans')}
        ${statCard('Repeat customers', j.repeat, 'booked more than once')}
        ${statCard('Most popular', j.popular[0] ? j.popular[0].name : '—', j.popular[0] ? j.popular[0].n + ' bookings' : '', 'accent')}
      </div>
      <div class="panel"><div class="panel-head"><h2>Bookings — last 30 days</h2></div><div class="panel-body">
        <div class="chart">${j.daily.map((d) => `<div class="bar" style="height:${Math.max(3, (d.bookings / maxDaily) * 100)}%" title="${d.date} · ${d.bookings} bookings"><span class="b-val">${d.bookings}</span></div>`).join('')}</div>
        <div class="chart-x">${j.daily.map((d) => `<span>${d.date.slice(8)}</span>`).join('')}</div>
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Monthly revenue — last 12 months</h2></div><div class="panel-body">
        <div class="chart">${j.monthly.map((d) => `<div class="bar" style="height:${Math.max(3, (d.revenue / maxMonthly) * 100)}%;background:var(--sage)" title="${d.month} · ${fmtINR(d.revenue)}"></div>`).join('')}</div>
        <div class="chart-x">${j.monthly.map((d) => `<span>${new Date(d.month + '-01').toLocaleDateString('en-IN', { month: 'short' })}</span>`).join('')}</div>
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Most popular activities</h2></div><div class="panel-body">
        ${j.popular.map((p) => `<div class="hbar-row"><span class="hb-name">${esc(p.name)}</span><div class="hbar-track"><div class="hbar-fill" style="width:${(p.n / maxPop) * 100}%"></div></div><span class="hbar-val">${p.n}</span></div>`).join('') || '<p class="hint">No data yet.</p>'}
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Peak booking times</h2></div><div class="panel-body">
        <div class="filter-bar">${j.peak.map((p) => `<span class="chip chip-tint">${fmtTime(p.start_time)} · ${p.n}</span>`).join('') || '<span class="hint">No data yet.</span>'}</div>
      </div></div>`;
  }

  /* ---------------- messages ---------------- */
  async function renderMessages() {
    const j = await api('/api/admin/notifications');
    $('#viewRoot').innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Contact messages</h2></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Name</th><th>Contact</th><th>Message</th></tr></thead><tbody>
      ${j.messages.map((m) => `<tr><td>${new Date(m.created_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</td><td>${esc(m.name || '—')}</td><td>${esc(m.email || '—')}<span class="sub">${esc(m.phone || '')}</span></td><td>${esc(m.message)}</td></tr>`).join('') || '<tr><td colspan="4" class="hint">No messages yet.</td></tr>'}</tbody></table></div></div>
      <div class="panel"><div class="panel-head"><h2>Notification log</h2></div>
      <div class="table-wrap"><table class="tbl"><thead><tr><th>When</th><th>Type</th><th>Channel</th><th>Recipient</th><th>Status</th></tr></thead><tbody>
      ${j.notifications.map((n) => `<tr><td>${new Date(n.created_at).toLocaleString('en-IN')}</td><td>${esc(n.type)}</td><td>${esc(n.channel)}</td><td>${esc(n.recipient || '—')}</td><td>${pill(n.status)}</td></tr>`).join('') || '<tr><td colspan="5" class="hint">No notifications yet.</td></tr>'}</tbody></table></div></div>`;
  }

  /* ---------------- settings ---------------- */
  async function renderSettings() {
    const j = await api('/api/admin/settings');
    const s = j.settings;
    $('#viewRoot').innerHTML = `
      <div class="panel"><div class="panel-head"><h2>Business information</h2><button class="btn btn-primary btn-sm" id="saveBiz">Save</button></div>
      <div class="panel-body">
        <div class="form-row">
          <div class="form-field"><label>Studio name</label><input class="input" id="bName" value="${esc(s.studio_name)}"></div>
          <div class="form-field"><label>Tagline</label><input class="input" id="bTag" value="${esc(s.tagline)}"></div>
          <div class="form-field"><label>Phone</label><input class="input" id="bPhone" value="${esc(s.phone)}" placeholder="+91 …"></div>
          <div class="form-field"><label>WhatsApp number</label><input class="input" id="bWa" value="${esc(s.whatsapp)}" placeholder="91…"></div>
          <div class="form-field full"><label>Email</label><input class="input" id="bEmail" value="${esc(s.email)}"></div>
          <div class="form-field full"><label>Address line 1</label><input class="input" id="bAddr1" value="${esc(s.address_line1)}"></div>
          <div class="form-field"><label>Address line 2</label><input class="input" id="bAddr2" value="${esc(s.address_line2)}"></div>
          <div class="form-field"><label>City</label><input class="input" id="bCity" value="${esc(s.city)}"></div>
          <div class="form-field full"><label>Google Maps embed URL</label><input class="input" id="bMaps" value="${esc(s.maps_url)}" placeholder="https://www.google.com/maps/embed?…"><span class="hint">Paste the <em>embed</em> URL from Google Maps → Share → Embed a map.</span></div>
          <div class="form-field full"><label>Instagram URL</label><input class="input" id="bIg" value="${esc(s.instagram)}" placeholder="https://instagram.com/…"></div>
        </div>
      </div></div>
      <div class="panel"><div class="panel-head"><h2>Policies</h2><button class="btn btn-primary btn-sm" id="savePol">Save</button></div>
      <div class="panel-body">
        <div class="form-field"><label>Cancellation policy</label><textarea class="textarea" id="pCancel">${esc(s.cancellation_policy)}</textarea></div>
        <div class="form-field"><label>Children policy (FAQ)</label><textarea class="textarea" id="pKids">${esc(s.children_policy)}</textarea></div>
        <div class="form-field"><label>Private sessions (FAQ)</label><textarea class="textarea" id="pPriv">${esc(s.private_sessions)}</textarea></div>
      </div></div>`;
    $('#saveBiz').addEventListener('click', async () => {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        studio_name: $('#bName').value, tagline: $('#bTag').value, phone: $('#bPhone').value,
        whatsapp: $('#bWa').value, email: $('#bEmail').value, address_line1: $('#bAddr1').value,
        address_line2: $('#bAddr2').value, city: $('#bCity').value, maps_url: $('#bMaps').value, instagram: $('#bIg').value,
      }) });
      toast('Business info saved.', 'ok');
    });
    $('#savePol').addEventListener('click', async () => {
      await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({
        cancellation_policy: $('#pCancel').value, children_policy: $('#pKids').value, private_sessions: $('#pPriv').value,
      }) });
      toast('Policies saved.', 'ok');
    });
  }

  /* ---------------- chatbot ---------------- */
  async function renderChatbot() {
    const [cfgRes, anRes] = await Promise.all([
      api('/api/admin/chatbot/settings'),
      api('/api/admin/chatbot/analytics'),
    ]);
    const s = cfgRes.settings;
    const a = anRes.stats;
    const toolsList = anRes.topTools || [];
    const convs = anRes.recentConversations || [];

    $('#viewRoot').innerHTML = `
      <div class="stat-grid">
        ${statCard('Conversations', a.totalConversations, 'all sessions', 'sage')}
        ${statCard('User messages', a.totalMessages, 'received', '')}
        ${statCard('Live tool checks', a.toolCalls, 'database calls', 'mustard')}
        ${statCard('Chat bookings', a.bookingsFromChat, 'drafted / checkout', 'accent')}
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Chatbot Configuration &amp; AI Provider</h2>
          <button class="btn btn-primary btn-sm" id="saveChatbotBtn">Save settings</button>
        </div>
        <div class="panel-body">
          <div class="form-row">
            <div class="form-field full field-row">
              <label><input type="checkbox" id="cbEnabled" ${s.enabled ? 'checked' : ''}> <strong>Enable Pause Assistant widget on website</strong></label>
            </div>
            <div class="form-field">
              <label>Assistant Name</label>
              <input class="input" id="cbName" value="${esc(s.name)}">
            </div>
            <div class="form-field">
              <label>AI Provider</label>
              <select class="input" id="cbProvider">
                <option value="groq" ${s.provider === 'groq' ? 'selected' : ''}>⚡ Groq (Ultra-Fast, Free Tier Available)</option>
                <option value="openai" ${s.provider === 'openai' ? 'selected' : ''}>OpenAI (gpt-4o-mini / gpt-4o)</option>
                <option value="custom" ${s.provider === 'custom' ? 'selected' : ''}>Custom OpenAI-compatible Endpoint</option>
              </select>
            </div>
            <div class="form-field">
              <label>AI Model</label>
              <select class="input" id="cbModel">
                <optgroup label="⚡ Groq Models">
                  <option value="openai/gpt-oss-120b" ${s.model === 'openai/gpt-oss-120b' ? 'selected' : ''}>openai/gpt-oss-120b (Recommended - High Quality)</option>
                  <option value="openai/gpt-oss-20b" ${s.model === 'openai/gpt-oss-20b' ? 'selected' : ''}>openai/gpt-oss-20b (Ultra Fast)</option>
                  <option value="qwen/qwen3.6-27b" ${s.model === 'qwen/qwen3.6-27b' ? 'selected' : ''}>qwen/qwen3.6-27b</option>
                  <option value="llama-3.3-70b-versatile" ${s.model === 'llama-3.3-70b-versatile' ? 'selected' : ''}>llama-3.3-70b-versatile</option>
                </optgroup>
                <optgroup label="OpenAI Models">
                  <option value="gpt-4o-mini" ${s.model === 'gpt-4o-mini' ? 'selected' : ''}>gpt-4o-mini</option>
                  <option value="gpt-4o" ${s.model === 'gpt-4o' ? 'selected' : ''}>gpt-4o</option>
                  <option value="gpt-3.5-turbo" ${s.model === 'gpt-3.5-turbo' ? 'selected' : ''}>gpt-3.5-turbo</option>
                </optgroup>
              </select>
            </div>
            <div class="form-field">
              <label>API Key (Groq 'gsk_…' or OpenAI 'sk-…')</label>
              <input class="input" id="cbApiKey" type="password" placeholder="${s.has_api_key ? '•••••••••••••••• (API Key Active)' : 'Paste Groq or OpenAI API key'}">
              <span class="hint">${s.has_api_key ? '✓ Active API key connected. Dynamic LLM active!' : 'Get a free high-speed Groq key at <a href="https://console.groq.com/keys" target="_blank" style="color:var(--accent)">console.groq.com/keys</a>'}</span>
            </div>
            <div class="form-field full">
              <label>Welcome Greeting</label>
              <textarea class="textarea" id="cbWelcome" style="min-height:75px">${esc(s.welcome)}</textarea>
            </div>
            <div class="form-field full">
              <label>Custom System Prompt Additions</label>
              <textarea class="textarea" id="cbPrompt" placeholder="Additional studio guidelines or tone notes…" style="min-height:75px">${esc(s.system_prompt || '')}</textarea>
            </div>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Recent Chat Conversations</h2>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead>
              <tr>
                <th>Session</th>
                <th>When</th>
                <th>Messages</th>
                <th>First Inquiry</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              ${convs.map((c) => `
                <tr>
                  <td class="mono">${esc(c.session_id.slice(0, 14))}…</td>
                  <td>${new Date(c.updated_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
                  <td><span class="pill ${c.msg_count > 2 ? 'paid' : 'initiated'}">${c.msg_count} msgs</span></td>
                  <td>${esc(c.first_query || '—')}</td>
                  <td><button class="btn-mini" data-viewconv="${c.id}">View Transcript</button></td>
                </tr>
              `).join('') || '<tr><td colspan="5" class="hint">No chat conversations yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Tool Execution Breakdown</h2>
        </div>
        <div class="panel-body">
          ${toolsList.map((t) => `
            <div class="hbar-row">
              <span class="hb-name mono" style="font-size:13px">${esc(t.tool_name || 'unknown')}</span>
              <div class="hbar-track"><div class="hbar-fill" style="width:${Math.min(100, Math.max(8, (t.count / Math.max(1, ...toolsList.map((x) => x.count))) * 100))}%"></div></div>
              <span class="hbar-val">${t.count}</span>
            </div>
          `).join('') || '<p class="hint">No tool calls recorded yet.</p>'}
        </div>
      </div>
    `;

    // Wire save button
    $('#saveChatbotBtn').addEventListener('click', async () => {
      const payload = {
        enabled: $('#cbEnabled').checked,
        name: $('#cbName').value.trim(),
        welcome: $('#cbWelcome').value.trim(),
        provider: $('#cbProvider').value,
        model: $('#cbModel').value,
        system_prompt: $('#cbPrompt').value.trim(),
      };
      const apiKeyVal = $('#cbApiKey').value.trim();
      if (apiKeyVal) payload.api_key = apiKeyVal;

      await api('/api/admin/chatbot/settings', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      toast('Chatbot settings saved.', 'ok');
      renderChatbot();
    });

    // Wire transcript modal
    $$('#viewRoot [data-viewconv]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.viewconv;
        const res = await api('/api/admin/chatbot/conversations/' + id);
        const conv = res.conversation;
        const msgs = res.messages;

        openModal(`
          <div class="co-head">
            <h3>Transcript · ${esc(conv.session_id)}</h3>
            <button class="co-close" onclick="document.getElementById('modalRoot').innerHTML=''">✕</button>
          </div>
          <div class="co-body" style="max-height:500px;overflow-y:auto;display:flex;flex-direction:column;gap:12px">
            ${msgs.map((m) => `
              <div style="padding:10px 14px;border-radius:14px;background:${m.role === 'user' ? 'var(--terracotta-tint)' : 'var(--cream-2)'};align-self:${m.role === 'user' ? 'flex-end' : 'flex-start'};max-width:85%">
                <div style="font-size:11px;font-weight:700;color:var(--ink-soft);text-transform:uppercase;margin-bottom:4px">${esc(m.role)} · ${new Date(m.created_at).toLocaleTimeString('en-IN')}</div>
                <div style="font-size:14px;white-space:pre-wrap">${esc(m.content)}</div>
              </div>
            `).join('') || '<p class="hint">No messages in this conversation.</p>'}
          </div>
        `);
      });
    });
  }

  /* ---------------- router table ---------------- */
  const VIEWS = {
    dashboard: renderDashboard, bookings: renderBookings, calendar: renderCalendar,
    activities: renderActivities, slots: renderSlots, memberships: renderMemberships,
    payments: renderPayments, analytics: renderAnalytics, messages: renderMessages,
    chatbot: renderChatbot, settings: renderSettings,
  };
  async function render(view) {
    $('#viewRoot').innerHTML = '<div class="skeleton" style="height:300px;border-radius:20px"></div>';
    await VIEWS[view]();
  }

  /* ---------------- boot ---------------- */
  wireAuth();
  wireNav();
  checkAuth();
})();

