'use strict';
/* Global behaviours for The Pause Studio. */

(function () {
  const SETTINGS = (function () {
    const el = document.getElementById('studio-settings');
    if (!el) return {};
    try { return JSON.parse(el.textContent || '{}'); } catch (e) { return {}; }
  })();

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  /* ---------- tiny helpers ---------- */
  const $ = (s, c) => (c || document).querySelector(s);
  const $$ = (s, c) => Array.from((c || document).querySelectorAll(s));
  const fmtINR = (n) => '₹' + Number(n).toLocaleString('en-IN');

  function toast(message, type) {
    let wrap = $('.toast-wrap');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toast-wrap'; document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.innerHTML = `<span class="t-dot"></span><span></span>`;
    t.lastElementChild.textContent = message;
    wrap.appendChild(t);
    setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 320); }, 3400);
  }

  /* ---------- nav ---------- */
  const nav = $('#siteNav');
  const toggle = $('#navToggle');
  const menu = $('#mobileMenu');
  if (toggle && menu) {
    toggle.addEventListener('click', () => {
      const open = menu.classList.toggle('open');
      toggle.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
      menu.setAttribute('aria-hidden', String(!open));
      document.body.style.overflow = open ? 'hidden' : '';
    });
    $$('a', menu).forEach((a) => a.addEventListener('click', () => {
      menu.classList.remove('open');
      toggle.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }));
  }
  window.addEventListener('scroll', () => {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);
  }, { passive: true });

  /* active nav state */
  const page = document.body.getAttribute('data-page');
  $$('[data-nav]').forEach((a) => {
    if (a.getAttribute('data-nav') === page) a.classList.add('active');
  });

  /* ---------- reveal on scroll ---------- */
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    $$('.reveal').forEach((el) => io.observe(el));
  } else {
    $$('.reveal').forEach((el) => el.classList.add('in'));
  }

  /* ---------- FAQ accordion ---------- */
  $$('.faq-item').forEach((item) => {
    const q = $('.faq-q', item);
    if (!q) return;
    q.addEventListener('click', () => {
      const open = item.classList.contains('open');
      $$('.faq-item.open').forEach((o) => o.classList.remove('open'));
      if (!open) item.classList.add('open');
    });
  });

  /* ---------- gallery filter ---------- */
  const filterRow = $('.filter-row');
  if (filterRow) {
    $$('.filter-pill', filterRow).forEach((p) => p.addEventListener('click', () => {
      $$('.filter-pill', filterRow).forEach((x) => x.classList.remove('active'));
      p.classList.add('active');
      const cat = p.getAttribute('data-cat');
      $$('.gallery-item').forEach((gi) => {
        gi.classList.toggle('is-hidden', cat !== 'all' && gi.getAttribute('data-cat') !== cat);
      });
    }));
  }

  /* ---------- inject settings into placeholders ---------- */
  function fmtHour(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    return (h % 12 === 0 ? 12 : h % 12) + (m ? ':' + String(m).padStart(2, '0') : '') + ' ' + ap;
  }
  function hoursSummary(hours) {
    if (!hours || !hours.length) return '';
    const byKey = {};
    hours.forEach((h) => {
      if (h.is_closed) return;
      const k = (h.open_time || '') + '–' + (h.close_time || '');
      (byKey[k] = byKey[k] || []).push(h.day_of_week);
    });
    const parts = [];
    Object.keys(byKey).forEach((k) => {
      const days = byKey[k];
      const ranges = [];
      let s = days[0], prev = days[0];
      for (let i = 1; i <= days.length; i++) {
        if (days[i] === prev + 1) { prev = days[i]; continue; }
        ranges.push(s === prev ? DAYS[s].slice(0, 3) : DAYS[s].slice(0, 3) + '–' + DAYS[prev].slice(0, 3));
        s = days[i]; prev = days[i];
      }
      const [o, c] = k.split('–');
      parts.push(ranges.join(', ') + ' · ' + fmtHour(o) + ' – ' + fmtHour(c));
    });
    return parts.join('  ·  ');
  }

  $$('.js-settings').forEach((el) => {
    const key = el.getAttribute('data-key');
    const val = SETTINGS[key];
    if (val) el.textContent = val;
    else el.textContent = el.getAttribute('data-empty') || '';
  });

  const footHours = $('.js-footer-hours');
  if (footHours) {
    const s = hoursSummary(SETTINGS.opening_hours);
    footHours.textContent = s ? ('Open ' + s) : 'Opening hours — see Contact';
  }

  // social links
  const ig = $('.js-social-instagram');
  if (ig) {
    if (SETTINGS.instagram) { ig.href = SETTINGS.instagram; ig.target = '_blank'; ig.rel = 'noopener'; }
    else { ig.href = '#'; ig.title = 'Instagram — coming soon'; }
  }
  const wa = $('.js-social-whatsapp');
  if (wa) {
    if (SETTINGS.whatsapp) { wa.href = 'https://wa.me/' + SETTINGS.whatsapp.replace(/\D/g, ''); wa.target = '_blank'; wa.rel = 'noopener'; }
    else { wa.href = '#'; wa.title = 'WhatsApp — coming soon'; }
  }

  // generic WhatsApp + directions CTAs across pages
  $$('[data-wa]').forEach((a) => {
    const num = SETTINGS.whatsapp || a.getAttribute('data-wa');
    const msg = a.getAttribute('data-wa-msg') || 'Hi! I’d like to know more about The Pause Studio.';
    a.href = 'https://wa.me/' + String(num).replace(/\D/g, '') + '?text=' + encodeURIComponent(msg);
    a.target = '_blank'; a.rel = 'noopener';
    if (!SETTINGS.whatsapp) a.classList.add('is-muted');
  });
  $$('[data-maps]').forEach((a) => {
    if (SETTINGS.maps_url) a.href = SETTINGS.maps_url;
    else a.href = '#'; a.target = '_blank'; a.rel = 'noopener';
    if (!SETTINGS.maps_url) a.classList.add('is-muted');
  });
  // map embed (only when configured)
  const mapBox = $('.map-box[data-embed]');
  if (mapBox && SETTINGS.maps_url) {
    const iframe = document.createElement('iframe');
    iframe.src = SETTINGS.maps_url;
    iframe.title = 'Map to The Pause Studio';
    iframe.style.cssText = 'width:100%;height:320px;border:0;display:block;';
    iframe.loading = 'lazy';
    mapBox.innerHTML = '';
    mapBox.appendChild(iframe);
  }

  /* ---------- LocalBusiness structured data (never invents an address) ---------- */
  const ld = $('#ld-json');
  if (ld) {
    const spec = (SETTINGS.opening_hours || []).filter((h) => !h.is_closed && h.open_time && h.close_time).map((h) => ({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: DAYS[h.day_of_week],
      opens: h.open_time,
      closes: h.close_time,
    }));
    const data = {
      '@context': 'https://schema.org',
      '@type': 'LocalBusiness',
      name: SETTINGS.studio_name || 'MindSpace Studio',
      slogan: SETTINGS.tagline || 'Create space for your mind. No experience. Just create.',
      priceRange: '₹',
      ...(spec.length ? { openingHoursSpecification: spec } : {}),
      ...(SETTINGS.address_line1 ? { address: { '@type': 'PostalAddress', streetAddress: SETTINGS.address_line1 + (SETTINGS.address_line2 ? ', ' + SETTINGS.address_line2 : ''), addressLocality: SETTINGS.city || '' } } : {}),
    };
    ld.textContent = JSON.stringify(data);
  }

  /* ---------- expose ---------- */
  window.TPS = { settings: SETTINGS, toast, fmtINR, fmtHour, DAYS, $, $$ };
})();
