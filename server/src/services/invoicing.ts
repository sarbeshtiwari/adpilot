/**
 * Tax invoices for vendor top-ups, and annual earnings statements for earners.
 *
 * Invoice numbers are sequential per year and unique, because a tax authority
 * expects an unbroken series.
 */
import { prisma } from '../lib/prisma.js';
import { env } from '../env.js';
import { logger } from '../lib/logger.js';

export function taxBreakdown(grossMicros: bigint, rateBps = env.billing.taxRateBps) {
  // The top-up amount is treated as tax-inclusive: the vendor pays what they
  // asked to pay, and the tax component is derived from it.
  const net = (grossMicros * 10_000n) / BigInt(10_000 + rateBps);
  return { netMicros: net, taxMicros: grossMicros - net, totalMicros: grossMicros, rateBps };
}

async function nextInvoiceNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${env.billing.invoicePrefix}-${year}-`;
  const last = await prisma.invoice.findFirst({
    where: { number: { startsWith: prefix } },
    orderBy: { number: 'desc' },
    select: { number: true },
  });
  const seq = last ? Number(last.number.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(seq).padStart(5, '0')}`;
}

/** Issued when a top-up settles. Idempotent — one invoice per recharge. */
export async function issueInvoiceForRecharge(rechargeId: string) {
  const existing = await prisma.invoice.findUnique({ where: { rechargeId } });
  if (existing) return existing;

  const recharge = await prisma.recharge.findUnique({ where: { id: rechargeId }, include: { vendor: true } });
  if (!recharge || recharge.status !== 'COMPLETED') return null;

  const { netMicros, taxMicros, totalMicros, rateBps } = taxBreakdown(recharge.amountMicros);

  try {
    return await prisma.invoice.create({
      data: {
        number: await nextInvoiceNumber(),
        vendorId: recharge.vendorId,
        rechargeId: recharge.id,
        amountMicros: netMicros,
        taxMicros,
        totalMicros,
        taxRateBps: rateBps,
        taxLabel: env.billing.taxLabel,
        meta: JSON.stringify({
          method: recharge.method,
          reference: recharge.reference,
          billTo: {
            name: recharge.vendor.legalName ?? recharge.vendor.companyName,
            taxId: recharge.vendor.taxId,
            address: [recharge.vendor.addressLine1, recharge.vendor.addressLine2, recharge.vendor.city, recharge.vendor.state, recharge.vendor.postalCode, recharge.vendor.country].filter(Boolean).join(', '),
          },
          from: { name: env.billing.legalName, taxId: env.billing.taxId, address: env.billing.address },
        }),
      },
    });
  } catch (err) {
    // A concurrent settle raced us to the number; the unique index caught it.
    logger.warn({ err, rechargeId }, 'invoice already issued for this top-up');
    return prisma.invoice.findUnique({ where: { rechargeId } });
  }
}

/** Withholding applied at payout time, per the earner's tax profile. */
export function withholdingFor(amountMicros: bigint, withholdingBps: number) {
  if (withholdingBps <= 0) return { withheldMicros: 0n, netMicros: amountMicros };
  const withheld = (amountMicros * BigInt(withholdingBps)) / 10_000n;
  return { withheldMicros: withheld, netMicros: amountMicros - withheld };
}

/** Annual statement an earner can hand to their accountant. */
export async function buildTaxDocument(publisherId: string, year: number) {
  const from = new Date(Date.UTC(year, 0, 1));
  const to = new Date(Date.UTC(year + 1, 0, 1));

  const earned = await prisma.ledgerEntry.aggregate({
    _sum: { amountMicros: true },
    where: { publisherId, type: 'PUBLISHER_EARN', createdAt: { gte: from, lt: to } },
  });
  const paid = await prisma.payout.findMany({
    where: { publisherId, status: 'PAID', processedAt: { gte: from, lt: to } },
    select: { amountMicros: true },
  });

  const gross = earned._sum.amountMicros ?? 0n;
  const publisher = await prisma.publisher.findUniqueOrThrow({ where: { id: publisherId } });
  const { withheldMicros } = withholdingFor(
    paid.reduce((a, p) => a + p.amountMicros, 0n),
    publisher.withholdingBps,
  );

  return prisma.taxDocument.upsert({
    where: { publisherId_year: { publisherId, year } },
    create: { publisherId, year, grossMicros: gross, withheldMicros, netMicros: gross - withheldMicros, country: publisher.taxCountry },
    update: { grossMicros: gross, withheldMicros, netMicros: gross - withheldMicros, country: publisher.taxCountry },
  });
}
