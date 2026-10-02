/**
 * Transactional email.
 *
 * With no SMTP host configured, mail is written to the log and the EmailLog
 * table instead of being sent — so local development exercises the same code
 * path and you can still read the reset link. Production requires SMTP.
 */
import nodemailer, { type Transporter } from 'nodemailer';
import { prisma } from '../lib/prisma.js';
import { env, mailEnabled } from '../env.js';
import { logger } from '../lib/logger.js';

let transporter: Transporter | null = null;

function transport(): Transporter | null {
  if (!mailEnabled) return null;
  transporter ??= nodemailer.createTransport({
    host: env.mail.host,
    port: env.mail.port,
    secure: env.mail.secure,
    auth: env.mail.user ? { user: env.mail.user, pass: env.mail.password } : undefined,
  });
  return transporter;
}

const shell = (title: string, body: string, cta?: { label: string; url: string }) => `
<!doctype html><html><body style="margin:0;background:#fafaf9;font:400 15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#18181b">
  <div style="max-width:520px;margin:0 auto;padding:32px 20px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:24px">
      <span style="display:inline-grid;place-items:center;width:28px;height:28px;border-radius:8px;background:#2a78d6;color:#fff;font-weight:700">A</span>
      <strong style="font-size:15px">AdPilot</strong>
    </div>
    <div style="background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:24px">
      <h1 style="margin:0 0 12px;font-size:18px;font-weight:600">${title}</h1>
      ${body}
      ${cta ? `<p style="margin:24px 0 0"><a href="${cta.url}" style="display:inline-block;background:#2a78d6;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:8px">${cta.label}</a></p>
      <p style="margin:16px 0 0;font-size:12px;color:#82807c;word-break:break-all">Or paste this into your browser:<br>${cta.url}</p>` : ''}
    </div>
    <p style="margin:20px 0 0;font-size:12px;color:#a8a29e">You are receiving this because of activity on your AdPilot account.</p>
  </div>
</body></html>`;

const p = (text: string) => `<p style="margin:0 0 10px;color:#52514e">${text}</p>`;

export const templates = {
  passwordReset: (name: string, url: string) => ({
    subject: 'Reset your AdPilot password',
    html: shell('Reset your password',
      p(`Hi ${name}, we received a request to reset your AdPilot password.`) +
      p('This link works once and expires in 60 minutes. If you did not ask for it, you can ignore this email — nothing has changed.'),
      { label: 'Choose a new password', url }),
  }),
  emailVerify: (name: string, url: string) => ({
    subject: 'Confirm your email address',
    html: shell('Confirm your email',
      p(`Hi ${name}, confirm this address so we can reach you about billing and delivery.`),
      { label: 'Confirm email', url }),
  }),
  teamInvite: (name: string, inviter: string, org: string, url: string) => ({
    subject: `${inviter} added you to ${org} on AdPilot`,
    html: shell('You have panel access',
      p(`${inviter} has given you access to the ${org} panel on AdPilot.`) +
      p('Set a password to sign in. Console accounts also need an authenticator app, which you will be walked through.'),
      { label: 'Set your password', url }),
  }),
  vendorApproved: (company: string, url: string) => ({
    subject: 'Your AdPilot advertiser account is approved',
    html: shell('You are approved',
      p(`${company} has been reviewed and approved. You can top up your wallet and take campaigns live.`),
      { label: 'Open your panel', url }),
  }),
  vendorRejected: (company: string, reason: string) => ({
    subject: 'About your AdPilot application',
    html: shell('We could not approve this application',
      p(`We reviewed the application for ${company} and were not able to approve it.`) +
      p(reason || 'Reply to this email if you would like more detail or want to reapply.')),
  }),
  payoutPaid: (name: string, amount: string, reference: string) => ({
    subject: `Your AdPilot payout of ${amount} is on its way`,
    html: shell('Payout sent',
      p(`Hi ${name}, ${amount} has been released to your saved payout method.`) +
      p(`Reference: ${reference || 'not provided'}. Bank timings mean it can take a couple of working days to land.`)),
  }),
  lowBalance: (company: string, balance: string, url: string) => ({
    subject: 'Your AdPilot wallet is running low',
    html: shell('Wallet running low',
      p(`${company}'s wallet is down to ${balance}. Campaigns stop delivering when it reaches zero.`),
      { label: 'Top up', url }),
  }),
};

export async function sendMail(to: string, template: string, message: { subject: string; html: string }, meta: Record<string, unknown> = {}) {
  const t = transport();
  try {
    if (t) {
      await t.sendMail({ from: env.mail.from, to, subject: message.subject, html: message.html });
    } else {
      // No SMTP: make the content findable rather than silently dropping it.
      logger.info({ to, template, subject: message.subject, ...meta }, 'email (not sent — SMTP not configured)');
    }
    await prisma.emailLog.create({
      data: { to, template, subject: message.subject, status: t ? 'SENT' : 'SUPPRESSED', meta: JSON.stringify(meta) },
    });
    return true;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error({ to, template, error }, 'email failed');
    await prisma.emailLog.create({
      data: { to, template, subject: message.subject, status: 'FAILED', error: error.slice(0, 400), meta: JSON.stringify(meta) },
    });
    return false;
  }
}
