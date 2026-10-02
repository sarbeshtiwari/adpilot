/**
 * DEVELOPMENT ONLY — a local stand-in for Razorpay.
 *
 * It speaks the same protocol as the real gateway: the same Orders and Payments
 * shapes, the same `order_id|payment_id` checkout HMAC, and the same raw-body
 * webhook HMAC. That means the application code under test is byte-for-byte the
 * code that will run against production Razorpay — only the host changes.
 *
 * It cannot be reached in production: env.ts refuses to boot unless
 * RAZORPAY_API_BASE points at api.razorpay.com.
 *
 *   npm run mock:razorpay
 */
import express from 'express';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_RAZORPAY_PORT ?? 4100);
const KEY_ID = process.env.RAZORPAY_KEY_ID ?? 'rzp_test_localmock';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET ?? 'localmocksecret';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET ?? 'localmockwebhooksecret';
const API_TARGET = process.env.ADPILOT_API ?? 'http://localhost:4000';

type Order = { id: string; amount: number; currency: string; status: string; receipt?: string; notes: Record<string, string> };
type Payment = { id: string; order_id: string; amount: number; currency: string; status: string; method: string; error_description?: string };

const orders = new Map<string, Order>();
const payments = new Map<string, Payment>();

const rid = (prefix: string) => `${prefix}_${crypto.randomBytes(9).toString('hex')}`;

const app = express();
app.use(express.json());

/** Razorpay authenticates with HTTP Basic (key id : key secret). */
app.use((req, res, next) => {
  if (req.path.startsWith('/_test')) return next();
  const header = req.get('authorization') ?? '';
  const decoded = Buffer.from(header.replace(/^Basic\s+/i, ''), 'base64').toString();
  const [id, secret] = decoded.split(':');
  if (id !== KEY_ID || secret !== KEY_SECRET) {
    return res.status(401).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'Authentication failed' } });
  }
  next();
});

// ───────────────────────────────────────────────────────── Orders API

app.post('/v1/orders', (req, res) => {
  const { amount, currency, receipt, notes } = req.body ?? {};
  if (!amount || amount < 100) {
    return res.status(400).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'amount must be at least 100' } });
  }
  const order: Order = { id: rid('order'), amount, currency: currency ?? 'INR', status: 'created', receipt, notes: notes ?? {} };
  orders.set(order.id, order);
  console.log(`[mock] order created ${order.id} for ${order.amount} ${order.currency}`);
  res.json(order);
});

app.get('/v1/payments/:id', (req, res) => {
  const payment = payments.get(req.params.id);
  if (!payment) return res.status(400).json({ error: { code: 'BAD_REQUEST_ERROR', description: 'payment not found' } });
  res.json(payment);
});

// ─────────────────────────────────────────── test hooks (not part of Razorpay)

/**
 * Stands in for the payer completing Checkout. Returns exactly what Razorpay's
 * browser handler passes back, including the signature the server will verify.
 */
app.post('/_test/pay', (req, res) => {
  const { orderId, outcome = 'captured', method = 'card' } = req.body ?? {};
  const order = orders.get(orderId);
  if (!order) return res.status(404).json({ error: 'unknown order' });

  const payment: Payment = {
    id: rid('pay'),
    order_id: order.id,
    amount: order.amount,
    currency: order.currency,
    status: outcome,
    method,
    ...(outcome === 'failed' ? { error_description: 'Your card was declined by the issuing bank' } : {}),
  };
  payments.set(payment.id, payment);
  order.status = outcome === 'captured' ? 'paid' : 'attempted';

  const signature = crypto.createHmac('sha256', KEY_SECRET).update(`${order.id}|${payment.id}`).digest('hex');
  console.log(`[mock] payment ${payment.id} ${outcome} for ${order.id}`);
  res.json({
    razorpay_order_id: order.id,
    razorpay_payment_id: payment.id,
    razorpay_signature: signature,
  });
});

/** Fires the same signed webhook Razorpay would send, at the AdPilot API. */
app.post('/_test/webhook', async (req, res) => {
  const { paymentId, event } = req.body ?? {};
  const payment = payments.get(paymentId);
  if (!payment) return res.status(404).json({ error: 'unknown payment' });

  const body = JSON.stringify({
    entity: 'event',
    event: event ?? (payment.status === 'captured' ? 'payment.captured' : 'payment.failed'),
    payload: { payment: { entity: payment } },
  });
  const signature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

  const delivered = await fetch(`${API_TARGET}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
    body,
  });
  const text = await delivered.text();
  console.log(`[mock] webhook -> ${delivered.status} ${text}`);
  res.json({ status: delivered.status, response: text });
});

/** Same delivery, deliberately mis-signed, to prove the guard works. */
app.post('/_test/webhook-forged', async (req, res) => {
  const { paymentId } = req.body ?? {};
  const payment = payments.get(paymentId);
  if (!payment) return res.status(404).json({ error: 'unknown payment' });

  const body = JSON.stringify({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: payment } } });
  const delivered = await fetch(`${API_TARGET}/api/webhooks/razorpay`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'deadbeef'.repeat(8) },
    body,
  });
  res.json({ status: delivered.status, response: await delivered.text() });
});

app.listen(PORT, () => {
  console.log(`\n  mock Razorpay  →  http://localhost:${PORT}/v1`);
  console.log(`  key ${KEY_ID} · webhooks delivered to ${API_TARGET}\n`);
});
