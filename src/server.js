'use strict';
/* The Pause Studio — web + booking platform server. */

process.env.TZ = process.env.TZ || 'Asia/Kolkata'; // studio operates on IST
const path = require('path');
const fs = require('fs');

// Load .env if present
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();
      if (k && !process.env[k]) process.env[k] = v;
    }
  }
}

const { execFileSync } = require('child_process');
const express = require('express');

const db = require('./db');
const u = require('./util');
const booking = require('./booking');
const publicRoutes = require('./routes/public');
const adminRoutes = require('./routes/admin');
const chatRoutes = require('./routes/chat');

const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, '..');
const VIEWS = path.join(ROOT, 'views');

/* Tiny cookie parser (avoids an extra dependency). */
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* ignore */ }
  }
  return out;
}

/* ----------------------------- page rendering ----------------------------- */

const LAYOUT = fs.readFileSync(path.join(VIEWS, 'layouts', 'base.html'), 'utf8');
const pageCache = {};
function loadPage(name) {
  if (!pageCache[name]) pageCache[name] = fs.readFileSync(path.join(VIEWS, 'pages', name + '.html'), 'utf8');
  return pageCache[name];
}

const META = {
  home: { title: 'MindSpace Studio | Creative Space to Unwind & Create', desc: 'Create space for your mind. Paint, make clay, create mandalas, craft and unwind at MindSpace Studio. Beginner-friendly sessions from ₹80.', page: 'home' },
  sessions: { title: 'Sessions & Activities | MindSpace Studio', desc: 'Painting, clay, mandala, crafting and music — find your creative space. Beginner-friendly sessions from ₹80.', page: 'sessions' },
  'how-it-works': { title: 'How It Works | MindSpace Studio', desc: 'Choose an activity, pick a time, book online and unwind. Creating space for your mind is easy.', page: 'how-it-works' },
  memberships: { title: 'Memberships | MindSpace Studio', desc: 'Come once, or make creative pauses part of your routine. Flexible memberships for regular visitors.', page: 'memberships' },
  'our-space': { title: 'Our Space | MindSpace Studio', desc: 'A table waiting to be messy, a corner for quiet, soothing music in the background. Come see our space.', page: 'our-space' },
  gallery: { title: 'Gallery | MindSpace Studio', desc: 'A peek inside MindSpace Studio — the tables, the materials, the little creations.', page: 'gallery' },
  about: { title: 'About | MindSpace Studio', desc: 'We made a space for your mind. Why MindSpace Studio exists and who it is for.', page: 'about' },
  faq: { title: 'FAQ | MindSpace Studio', desc: 'Everything you might want to know before your first visit — materials, beginners, friends, cancellations and more.', page: 'faq' },
  contact: { title: 'Contact | MindSpace Studio', desc: 'Let’s talk. Reach MindSpace Studio by phone, WhatsApp or email.', page: 'contact' },
  book: { title: 'Book a Session | MindSpace Studio', desc: 'Book your creative session in a few easy steps — choose an activity, pick a time, pay securely.', page: 'book' },
  confirmation: { title: 'You’re Booked! | MindSpace Studio', desc: 'Your creative session is officially on the calendar.', page: 'confirmation' },
  'my-booking': { title: 'My Booking | MindSpace Studio', desc: 'View, manage or cancel your booking.', page: 'my-booking' },
  privacy: { title: 'Privacy Policy | MindSpace Studio', desc: 'How MindSpace Studio handles your information.', page: 'privacy' },
  terms: { title: 'Terms | MindSpace Studio', desc: 'Terms of use for MindSpace Studio.', page: 'terms' },
  cancellation: { title: 'Cancellation Policy | MindSpace Studio', desc: 'Our cancellation and rescheduling policy.', page: 'cancellation' },
};

function render(res, name, extra = {}) {
  const meta = META[name] || META.home;
  const content = name === '404' ? loadPage('404') : loadPage(name);
  const settings = u.getSettings(db);
  const hours = db.prepare('SELECT * FROM opening_hours ORDER BY day_of_week').all();
  const publicSettings = {
    studio_name: settings.studio_name, tagline: settings.tagline,
    phone: settings.phone || '', whatsapp: settings.whatsapp || '', email: settings.email || '',
    address_line1: settings.address_line1 || '', address_line2: settings.address_line2 || '',
    city: settings.city || '', maps_url: settings.maps_url || '', instagram: settings.instagram || '',
    cancellation_policy: settings.cancellation_policy || '', children_policy: settings.children_policy || '',
    private_sessions: settings.private_sessions || '', opening_hours: hours,
  };
  let html = LAYOUT
    .replaceAll('{{TITLE}}', extra.title || meta.title)
    .replaceAll('{{DESC}}', extra.desc || meta.desc)
    .replaceAll('{{PAGE}}', name)
    .replaceAll('{{CONTENT}}', content)
    .replaceAll('{{SETTINGS_JSON}}', JSON.stringify(publicSettings).replace(/</g, '\\u003c'))
    .replaceAll('{{EXTRA_HEAD}}', extra.extraHead || '');
  res.send(html);
}

/* ----------------------------- app ----------------------------- */

const app = express();

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'MindSpace API'
  });
});

app.disable('x-powered-by');

// Enable CORS for Vercel frontend connection
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use((req, res, next) => { req.cookies = parseCookies(req); req.db = db; next(); });
app.use(express.json({ limit: '1mb' }));

// static assets (fonts & images cached; css/js lightly cached)
app.use('/fonts', express.static(path.join(ROOT, 'public', 'fonts'), { maxAge: '30d', immutable: true }));
app.use('/img', express.static(path.join(ROOT, 'public', 'img'), { maxAge: '7d' }));
app.use(express.static(path.join(ROOT, 'public'), { maxAge: 0 }));

/* routes */
app.use(publicRoutes(db));
app.use(chatRoutes(db));
app.use('/api/admin', adminRoutes(db));

/* pages */
const PAGE_ROUTES = ['sessions', 'how-it-works', 'memberships', 'our-space', 'gallery', 'about', 'faq', 'contact',
  'confirmation', 'my-booking', 'privacy', 'terms', 'cancellation'];
app.get('/', (req, res) => render(res, 'home'));
app.get('/book', (req, res) => render(res, 'book'));
for (const p of PAGE_ROUTES) app.get('/' + p, (req, res) => render(res, p));

/* admin app */
app.get('/admin', (req, res) => {
  const html = fs.readFileSync(path.join(VIEWS, 'admin', 'app.html'), 'utf8');
  res.send(html.replaceAll('{{PAGE}}', 'admin'));
});

/* 404 */
app.use((req, res) => { res.status(404); render(res, '404'); });

/* error handler */
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (res.headersSent) return next(err);
  u.fail(res, 500, 'SERVER_ERROR', 'Something went wrong on our side. Please try again.');
});

/* housekeeping: release expired payment holds every minute (only when running as standalone server) */
if (!process.env.VERCEL) {
  setInterval(() => {
    const n = booking.releaseExpiredHolds(db);
    if (n) console.log(`⏱  Released ${n} expired pending booking(s).`);
  }, 60 * 1000).unref();

  app.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │   MINDSPACE STUDIO  ·  booking platform      │');
    console.log(`  │   http://localhost:${PORT}                     │`);
    console.log(`  │   Admin → http://localhost:${PORT}/admin       │`);
    console.log('  │   admin@mindspacestudio.in · pause1234       │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log('');
  });
}

module.exports = app;
