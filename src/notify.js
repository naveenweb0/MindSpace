'use strict';
/* Notification pipeline: email / WhatsApp / system.
 * Always writes to the `notifications` table + console (audit trail).
 * Email & WhatsApp transports activate when credentials are supplied via env vars,
 * otherwise the message is queued and the UI falls back to a WhatsApp deep-link.
 */

const u = require('./util');

function queue(db, { type, channel, recipient, subject, payload }) {
  db.prepare(
    `INSERT INTO notifications (type, channel, recipient, subject, payload, status)
     VALUES (?, ?, ?, ?, ?, 'queued')`
  ).run(type, channel, recipient || '', subject || '', JSON.stringify(payload || {}));
}

function consoleLine(type, recipient, subject) {
  const line = `[notify:${type}] → ${recipient || '(no recipient)'} · ${subject || ''}`;
  console.log('\x1b[35m%s\x1b[0m', line);
}

async function sendEmail(db, { to, subject, text }) {
  queue(db, { type: 'email', channel: 'email', recipient: to, subject, payload: { text } });
  consoleLine('email', to, subject);
  // Real SMTP: implement with any SMTP client using SMTP_* env vars. Left as a pluggable stub.
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    // NOTE: requires an SMTP client dependency. Stub by design — see README.
    console.log('   (SMTP configured — wire your preferred SMTP client here)');
  }
}

async function sendWhatsApp(db, { phone, text }) {
  queue(db, { type: 'whatsapp', channel: 'whatsapp', recipient: phone, payload: { text } });
  consoleLine('whatsapp', phone, text);
  // WhatsApp Business Cloud API — activates when credentials are present.
  if (process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID) {
    try {
      const url = `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_ID}/messages`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: String(phone).replace(/\D/g, ''),
          type: 'text',
          text: { body: text },
        }),
      });
      const body = await res.json().catch(() => ({}));
      db.prepare("UPDATE notifications SET status = ? WHERE id = (SELECT MAX(id) FROM notifications WHERE channel='whatsapp')")
        .run(res.ok ? 'sent' : 'failed');
      if (!res.ok) console.log('   WhatsApp API error:', body);
    } catch (e) {
      console.log('   WhatsApp send failed:', e.message);
    }
  } else {
    console.log('   (No WhatsApp API token — confirmation shown in-app with a wa.me link instead)');
  }
}

function whatsappLink(phone, text) {
  const p = String(phone || '').replace(/\D/g, '');
  return `https://wa.me/91${p.length === 10 ? p : p}?text=${encodeURIComponent(text)}`;
}

/** Send full booking confirmation across channels. */
async function sendBookingConfirmation(db, booking, settings) {
  const a = db.prepare('SELECT name FROM activities WHERE id = ?').get(booking.activity_id);
  const activityName = a ? a.name : 'Session';
  const text =
    `Hi ${booking.customer_name}! 🎨 Your MindSpace Studio booking is confirmed.\n\n` +
    `Booking ID: ${booking.booking_reference}\n` +
    `Activity: ${activityName}\nDuration: ${booking.duration} minutes\n` +
    `Date: ${u.fmtDate(booking.date)}\nTime: ${u.fmtTime(booking.start_time)}\n` +
    `Guests: ${booking.number_of_guests}\nAmount paid: ${u.fmtINR(booking.total_amount)}\n\n` +
    `Studio: ${settings.address_line1 || 'MindSpace Studio'}${settings.address_line2 ? ', ' + settings.address_line2 : ''}\n` +
    `Cancellation: ${settings.cancellation_policy || '—'}\n\n` +
    `Create space for your mind. No experience. Just create.`;
  const subject = `Your booking is confirmed — ${booking.booking_reference} 🎨`;
  if (booking.customer_email) await sendEmail(db, { to: booking.customer_email, subject, text });
  if (booking.customer_phone) await sendWhatsApp(db, { phone: booking.customer_phone, text });
  queue(db, { type: 'booking_confirmed', channel: 'system', recipient: booking.customer_phone, subject, payload: { ref: booking.booking_reference } });
}

async function sendMembershipConfirmation(db, membership, plan, settings) {
  const text =
    `Hi ${membership.customer_name}! 🌿 Your ${plan.name} membership is active.\n\n` +
    `Membership ID: ${membership.membership_reference}\n` +
    `Valid until: ${u.fmtDate(membership.end_date)}\n` +
    (membership.sessions_total ? `Sessions included: ${membership.sessions_total}\n` : 'Sessions: Unlimited\n') +
    `Amount paid: ${u.fmtINR(membership.price_paid)}\n\n` +
    `Create space for your mind. No experience. Just create.`;
  const subject = `Welcome to ${plan.name} — MindSpace Studio 🌿`;
  if (membership.customer_email) await sendEmail(db, { to: membership.customer_email, subject, text });
  if (membership.customer_phone) await sendWhatsApp(db, { phone: membership.customer_phone, text });
  queue(db, { type: 'membership_active', channel: 'system', recipient: membership.customer_phone, subject, payload: { ref: membership.membership_reference } });
}

module.exports = { queue, sendEmail, sendWhatsApp, whatsappLink, sendBookingConfirmation, sendMembershipConfirmation };
