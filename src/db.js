'use strict';
/* SQLite schema for The Pause Studio (relational, with FK + indexes). */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const isVercel = !!process.env.VERCEL;
const DATA_DIR = isVercel ? '/tmp' : (process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) {}
}
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'pause-studio.db');

const db = new Database(DB_PATH);
try {
  if (!isVercel) db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (e) {}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT,
  email         TEXT UNIQUE,
  phone         TEXT,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'customer',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  tagline       TEXT,
  description   TEXT,
  image         TEXT,
  max_capacity  INTEGER NOT NULL DEFAULT 8,
  active        INTEGER NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS activity_durations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  minutes     INTEGER NOT NULL,
  price       INTEGER NOT NULL,
  UNIQUE(activity_id, minutes)
);

CREATE TABLE IF NOT EXISTS studio_settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS opening_hours (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day_of_week INTEGER NOT NULL UNIQUE,  -- 0 = Sunday … 6 = Saturday
  open_time   TEXT,
  close_time  TEXT,
  is_closed   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS time_slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time   TEXT NOT NULL,
  capacity   INTEGER NOT NULL DEFAULT 8,
  UNIQUE(date, start_time)
);

CREATE TABLE IF NOT EXISTS blocked_dates (
  date   TEXT PRIMARY KEY,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS blocked_slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id INTEGER REFERENCES activities(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  start_time  TEXT NOT NULL,
  end_time    TEXT NOT NULL,
  reason      TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_reference TEXT UNIQUE NOT NULL,
  view_token        TEXT NOT NULL,
  customer_id       INTEGER REFERENCES users(id),
  customer_name     TEXT NOT NULL,
  customer_email    TEXT NOT NULL,
  customer_phone    TEXT NOT NULL,
  activity_id       INTEGER NOT NULL REFERENCES activities(id),
  duration          INTEGER NOT NULL,
  date              TEXT NOT NULL,
  start_time        TEXT NOT NULL,
  end_time          TEXT NOT NULL,
  number_of_guests  INTEGER NOT NULL DEFAULT 1,
  total_amount      INTEGER NOT NULL,
  payment_status    TEXT NOT NULL DEFAULT 'unpaid',
  booking_status    TEXT NOT NULL DEFAULT 'pending',
  note              TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at        TEXT
);

CREATE TABLE IF NOT EXISTS booking_participants (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  name       TEXT,
  email      TEXT,
  phone      TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id    INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  membership_id INTEGER REFERENCES memberships(id) ON DELETE SET NULL,
  provider      TEXT NOT NULL DEFAULT 'mock',
  provider_ref  TEXT,
  amount        INTEGER NOT NULL,
  status        TEXT NOT NULL DEFAULT 'success',
  method        TEXT,
  meta          TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS membership_plans (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  slug              TEXT UNIQUE NOT NULL,
  name              TEXT NOT NULL,
  tagline           TEXT,
  price             INTEGER NOT NULL,
  interval_days     INTEGER NOT NULL DEFAULT 30,
  sessions_included INTEGER,
  benefits          TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS memberships (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  membership_reference TEXT UNIQUE NOT NULL,
  view_token           TEXT NOT NULL,
  customer_id          INTEGER REFERENCES users(id),
  plan_id              INTEGER NOT NULL REFERENCES membership_plans(id),
  customer_name        TEXT NOT NULL,
  customer_email       TEXT NOT NULL,
  customer_phone       TEXT NOT NULL,
  start_date           TEXT NOT NULL,
  end_date             TEXT NOT NULL,
  sessions_total       INTEGER,
  sessions_used        INTEGER NOT NULL DEFAULT 0,
  price_paid           INTEGER NOT NULL,
  status               TEXT NOT NULL DEFAULT 'active',
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT,
  subject    TEXT,
  message    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  channel    TEXT NOT NULL,
  recipient  TEXT,
  subject    TEXT,
  payload    TEXT,
  sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS chat_conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT UNIQUE NOT NULL,
  user_identifier TEXT,
  customer_name   TEXT,
  customer_phone  TEXT,
  customer_email  TEXT,
  meta            TEXT,
  metadata        TEXT,
  started_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_message_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL,
  content         TEXT NOT NULL,
  tool_calls      TEXT,
  tool_results    TEXT,
  actions         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS chat_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER REFERENCES chat_conversations(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  payload         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
`);

/* Run migrations for existing columns if needed */
try { db.exec('ALTER TABLE chat_conversations ADD COLUMN meta TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE chat_conversations ADD COLUMN created_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE chat_conversations ADD COLUMN updated_at TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE chat_messages ADD COLUMN tool_results TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE chat_messages ADD COLUMN actions TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE payments ADD COLUMN provider TEXT DEFAULT "mock"'); } catch (_) {}
try { db.exec('ALTER TABLE payments ADD COLUMN provider_ref TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE payments ADD COLUMN method TEXT'); } catch (_) {}
try { db.exec('ALTER TABLE payments ADD COLUMN meta TEXT'); } catch (_) {}

/* ----------------------------- indexes ----------------------------- */

db.exec(`
CREATE INDEX IF NOT EXISTS idx_bookings_date     ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_slot     ON bookings(date, start_time);
CREATE INDEX IF NOT EXISTS idx_bookings_status   ON bookings(booking_status);
CREATE INDEX IF NOT EXISTS idx_bookings_phone    ON bookings(customer_phone);
CREATE INDEX IF NOT EXISTS idx_bookings_activity ON bookings(activity_id);
CREATE INDEX IF NOT EXISTS idx_payments_booking  ON payments(booking_id);
CREATE INDEX IF NOT EXISTS idx_memberships_plan  ON memberships(plan_id);
CREATE INDEX IF NOT EXISTS idx_slots_date        ON time_slots(date);
CREATE INDEX IF NOT EXISTS idx_chat_conv_session ON chat_conversations(session_id);
CREATE INDEX IF NOT EXISTS idx_chat_msg_conv     ON chat_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_chat_events_type  ON chat_events(event_type);
`);

/* ----------------------------- auto-seed if empty ----------------------------- */
function autoSeed(database) {
  const count = database.prepare('SELECT COUNT(*) AS n FROM activities').get().n;
  if (count > 0) return;

  const u = require('./util');

  const defaults = {
    studio_name: 'MindSpace Studio',
    tagline: 'Create space for your mind. No experience. Just create.',
    phone: '',
    whatsapp: '',
    email: '',
    address_line1: '',
    address_line2: '',
    city: '',
    maps_url: '',
    instagram: '',
    slot_interval: 30,
    slot_capacity: 8,
    min_advance_hours: 1,
    max_lead_days: 30,
    cancellation_policy:
      'You can cancel or reschedule up to 2 hours before your session for a full refund. Cancellations after that are not refundable.',
    children_policy:
      'Children are welcome when accompanied by an adult. Sessions are designed for all ages.',
    private_sessions: 'Not currently offered.',
    chatbot_enabled: 1,
    chatbot_name: 'MindSpace Assistant',
    chatbot_welcome: 'Hey! 👋 Welcome to MindSpace Studio.\n\nLooking for something relaxing to do, checking a booking, or ready to find some calm headspace?',
    chatbot_model: 'openai/gpt-oss-20b',
    chatbot_provider: 'groq',
    chatbot_api_key: process.env.GROQ_API_KEY || '',
  };
  for (const [k, v] of Object.entries(defaults)) u.setSetting(database, k, v);

  const hoursSeed = [
    { day: 0, open: '10:00', close: '18:00' },
    { day: 1, open: '10:00', close: '20:00' },
    { day: 2, open: '10:00', close: '20:00' },
    { day: 3, open: '10:00', close: '20:00' },
    { day: 4, open: '10:00', close: '20:00' },
    { day: 5, open: '10:00', close: '20:00' },
    { day: 6, open: '10:00', close: '20:00' },
  ];
  const insHour = database.prepare('INSERT OR IGNORE INTO opening_hours (day_of_week, open_time, close_time, is_closed) VALUES (?, ?, ?, 0)');
  for (const h of hoursSeed) insHour.run(h.day, h.open, h.close);

  const activities = [
    {
      slug: 'painting', name: 'Painting', tagline: 'Pick your colors, put on some music and let the brush take over.',
      description: 'Grab a brush, pick a few colors you like and let the brush take over. A blank canvas is just a place to start — no reference, no rules.',
      image: '/img/activity-painting.jpg', durations: [[30, 80], [60, 150]], sort: 1,
    },
    {
      slug: 'clay', name: 'Clay Modelling', tagline: 'Shape something with your hands and give your mind something simple to focus on.',
      description: 'Squeeze, roll and shape soft air-dry clay. It is wonderfully forgiving — make a bowl, a blob, or just enjoy the feeling of it.',
      image: '/img/activity-clay.jpg', durations: [[30, 100], [60, 180]], sort: 2,
    },
    {
      slug: 'mandala', name: 'Mandala Making', tagline: 'Slow patterns, quiet focus and a little time away from the noise.',
      description: 'Dot by dot, line by line. Repeating patterns have a way of quieting a busy mind. No symmetry police here.',
      image: '/img/activity-mandala.jpg', durations: [[30, 80], [60, 150]], sort: 3,
    },
    {
      slug: 'crafting', name: 'Crafting', tagline: 'Cut, fold, build, decorate. There is no right way to make something.',
      description: 'Paper, glue, yarn, tape and whatever else catches your eye. Build something small and a little imperfect.',
      image: '/img/activity-crafting.jpg', durations: [[30, 80], [60, 140]], sort: 4,
    },
    {
      slug: 'music', name: 'Music Sessions', tagline: 'Put everything else on pause and spend some time simply listening.',
      description: 'A quiet corner, good headphones and a record player. Sit back, close your eyes, and let the music do the work.',
      image: '/img/activity-music.jpg', durations: [[30, 100], [60, 160]], sort: 5,
    },
  ];

  const insAct = database.prepare('INSERT OR IGNORE INTO activities (slug, name, tagline, description, image, max_capacity, active, sort_order) VALUES (@slug, @name, @tagline, @description, @image, 8, 1, @sort)');
  const insDur = database.prepare('INSERT OR IGNORE INTO activity_durations (activity_id, minutes, price) VALUES (?, ?, ?)');
  for (const a of activities) {
    const r = insAct.run(a);
    if (r.lastInsertRowid) {
      for (const [mins, price] of a.durations) insDur.run(r.lastInsertRowid, mins, price);
    }
  }

  const insPlan = database.prepare('INSERT OR IGNORE INTO membership_plans (slug, name, tagline, price, interval_days, sessions_included, benefits, active, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)');
  insPlan.run('monthly', 'Monthly', 'Make creative space part of your routine.', 699, 30, 4, JSON.stringify(['4 sessions every month', 'Member pricing on all sessions', 'Priority booking', 'Unused sessions roll over']), 1);
  insPlan.run('unlimited', 'Unlimited', 'Come as often as your week allows.', 1499, 30, null, JSON.stringify(['Unlimited eligible sessions', 'Priority booking', 'Member perks & discounts', 'Bring a friend once a month']), 2);
}

function ensureAdminUser(database) {
  const u = require('./util');
  const existing = database.prepare("SELECT * FROM users WHERE role = 'admin'").all();
  if (existing.length === 0) {
    database.prepare("INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'admin')")
      .run('Studio Admin', 'admin@mindspacestudio.in', '', u.hashPassword('pause1234'));
  } else {
    for (const admin of existing) {
      if (admin.email === 'admin@thepausestudio.in' || admin.email === 'admin@mindspacestudio.in') {
        database.prepare("UPDATE users SET email = 'admin@mindspacestudio.in', password_hash = ? WHERE id = ?")
          .run(u.hashPassword('pause1234'), admin.id);
      }
    }
  }
}

try { autoSeed(db); } catch (e) { console.warn('Auto-seed check:', e.message); }
try { ensureAdminUser(db); } catch (e) { console.warn('Ensure admin check:', e.message); }

module.exports = db;
