'use strict';
/* Payments — Razorpay-first, with an honest test/mock mode when no credentials exist.
 * A booking is only CONFIRMED after a verified payment. Mock mode never fakes
 * a successful charge against real money — it simulates the gateway locally. */

const crypto = require('crypto');

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function razorpayEnabled() { return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET); }

/** Create a payment order (Razorpay order if configured, else a mock intent). */
async function createOrder(booking) {
  if (razorpayEnabled()) {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64'),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: booking.total_amount * 100, // paise
        currency: 'INR',
        receipt: booking.booking_reference,
        notes: { booking: booking.booking_reference },
      }),
    });
    if (!res.ok) throw new Error('Could not create payment order (' + res.status + ')');
    const order = await res.json();
    return {
      mode: 'razorpay',
      key: RAZORPAY_KEY_ID,
      order_id: order.id,
      amount: booking.total_amount,
    };
  }
  // Test/mock mode — clearly flagged to the customer.
  return { mode: 'mock', amount: booking.total_amount };
}

/** Verify a Razorpay payment via signature. Returns true if valid. */
function verifyRazorpaySignature(orderId, paymentId, signature) {
  const body = orderId + '|' + paymentId;
  const expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(signature), 'hex'));
}

/** Payment options shown in the checkout (test mode mirrors Razorpay's methods). */
const PAYMENT_METHODS = [
  { id: 'upi', label: 'UPI', hint: 'GPay, PhonePe, Paytm & more' },
  { id: 'card', label: 'Card', hint: 'Credit / Debit cards' },
  { id: 'netbanking', label: 'Net Banking', hint: 'All major banks' },
  { id: 'wallet', label: 'Wallet', hint: 'Paytm, Amazon Pay & more' },
];

module.exports = { createOrder, verifyRazorpaySignature, razorpayEnabled, PAYMENT_METHODS };
