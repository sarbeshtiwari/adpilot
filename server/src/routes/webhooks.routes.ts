/**
 * Gateway webhooks. Unauthenticated by design — trust comes from the HMAC
 * signature over the raw request body, not from a session.
 */
import { Router, raw } from 'express';
import { prisma } from '../lib/prisma.js';
import { wrap } from '../lib/http.js';
import { minorUnitsToUsdMicros, verifyWebhookSignature } from '../services/razorpay.js';
import { creditVendor } from '../services/billing.js';
import { issueInvoiceForRecharge } from '../services/invoicing.js';
import { audit } from '../lib/audit.js';

export const webhookRouter = Router();

/**
 * Razorpay retries until it gets a 2xx, so this has to be idempotent: the
 * wallet is only credited while the recharge row is still PENDING.
 */
webhookRouter.post(
  '/razorpay',
  raw({ type: 'application/json', limit: '256kb' }),
  wrap(async (req, res) => {
    const signature = req.get('x-razorpay-signature') ?? '';
    const rawBody = req.body as Buffer;

    if (!verifyWebhookSignature(rawBody, signature)) {
      await audit({ actorRole: 'SYSTEM', action: 'webhook.razorpay.bad_signature', entity: 'Recharge' });
      return res.status(400).json({ error: 'Invalid signature' });
    }

    const event = JSON.parse(rawBody.toString()) as {
      event: string;
      payload?: {
        payment?: { entity?: { id: string; order_id: string; amount: number; currency: string; method?: string; error_description?: string } };
        dispute?: { entity?: { id: string; payment_id: string; amount: number; reason_code?: string; status?: string } };
      };
    };

    // Chargebacks: record them for a human. Clawing back automatically would be
    // wrong — the budget may already be spent on delivery that really happened.
    const dispute = event.payload?.dispute?.entity;
    if (dispute?.payment_id) {
      const recharge = await prisma.recharge.findFirst({ where: { gatewayPaymentId: dispute.payment_id } });
      if (recharge) {
        await prisma.dispute.upsert({
          where: { gatewayDisputeId: dispute.id },
          create: {
            rechargeId: recharge.id, gatewayDisputeId: dispute.id,
            amountMicros: minorUnitsToUsdMicros(dispute.amount),
            reason: dispute.reason_code ?? '', status: 'OPEN',
          },
          update: { reason: dispute.reason_code ?? '' },
        });
        await audit({ actorRole: 'SYSTEM', action: 'dispute.opened', entity: 'Recharge', entityId: recharge.id, meta: { disputeId: dispute.id } });
      }
      return res.json({ ok: true });
    }

    const payment = event.payload?.payment?.entity;
    if (!payment?.order_id) return res.json({ ok: true, ignored: true });

    const recharge = await prisma.recharge.findUnique({ where: { gatewayOrderId: payment.order_id } });
    if (!recharge) return res.json({ ok: true, unknownOrder: true });

    if (event.event === 'payment.captured') {
      if (recharge.status === 'PENDING') {
        // Credit what the gateway actually captured, not what was requested.
        const credited = minorUnitsToUsdMicros(payment.amount);
        await creditVendor(recharge.vendorId, credited, `Razorpay ${payment.id}`);
        await prisma.recharge.update({
          where: { id: recharge.id },
          data: {
            status: 'COMPLETED',
            settledAt: new Date(),
            amountMicros: credited,
            gatewayPaymentId: payment.id,
            gatewayAmount: payment.amount,
            gatewayCurrency: payment.currency,
            reference: payment.id,
            note: 'settled automatically by webhook',
          },
        });
        await issueInvoiceForRecharge(recharge.id);
        await audit({ actorRole: 'SYSTEM', action: 'recharge.auto_settled', entity: 'Recharge', entityId: recharge.id, meta: { paymentId: payment.id, amount: payment.amount } });
      }
      return res.json({ ok: true });
    }

    if (event.event === 'payment.failed' && recharge.status === 'PENDING') {
      await prisma.recharge.update({
        where: { id: recharge.id },
        data: { status: 'FAILED', settledAt: new Date(), gatewayPaymentId: payment.id, failureReason: payment.error_description ?? 'payment failed' },
      });
      await audit({ actorRole: 'SYSTEM', action: 'recharge.failed', entity: 'Recharge', entityId: recharge.id });
    }

    res.json({ ok: true });
  }),
);
