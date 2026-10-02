/**
 * Seeds a complete, believable platform: one super admin, four vendors with
 * live geo-targeted campaigns, six end users with paired devices, and ~30 days
 * of impressions/clicks with a fully consistent money ledger.
 *
 *   npm run seed        (wipes and re-creates everything)
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../src/lib/prisma.js';
import { sha256 } from '../src/lib/crypto.js';
import { usdToMicros, splitRevenue } from '../src/lib/money.js';
import { SETTING_DEFAULTS } from '../src/services/settings.js';
import { allGrants } from '../src/lib/permissions.js';

const SHARE_BPS = 6000; // end user keeps 60%
const DAYS = 30;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];
const chance = (p: number) => Math.random() < p;

const LOCATIONS = [
  { country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Koramangala' },
  { country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Indiranagar' },
  { country: 'IN', state: 'Maharashtra', city: 'Mumbai', area: 'Andheri' },
  { country: 'IN', state: 'Delhi', city: 'New Delhi', area: 'Connaught Place' },
  { country: 'IN', state: 'Telangana', city: 'Hyderabad', area: 'Gachibowli' },
  { country: 'US', state: 'California', city: 'San Francisco', area: 'SoMa' },
  { country: 'US', state: 'California', city: 'Mountain View', area: 'Downtown' },
  { country: 'US', state: 'New York', city: 'New York', area: 'Manhattan' },
  { country: 'GB', state: 'England', city: 'London', area: 'Camden' },
];

const HOSTS = ['chatgpt.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai', 'localhost:11434'];
const MODELS = ['gpt-5', 'claude-opus-5', 'gemini-3-pro', 'llama-4-70b', 'deepseek-r1'];

async function wipe() {
  // Order matters: children before parents.
  await prisma.session.deleteMany();
  await prisma.recoveryCode.deleteMany();
  await prisma.teamMember.deleteMany();
  await prisma.click.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.impression.deleteMany();
  await prisma.geoRule.deleteMany();
  await prisma.ad.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.payout.deleteMany();
  await prisma.recharge.deleteMany();
  await prisma.device.deleteMany();
  await prisma.publisher.deleteMany();
  await prisma.vendor.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
  await prisma.systemSetting.deleteMany();
}

async function main() {
  console.log('▸ wiping database…');
  await wipe();

  const hash = await bcrypt.hash('Passw0rd!23', 10);

  console.log('▸ settings…');
  await prisma.systemSetting.createMany({
    data: Object.entries(SETTING_DEFAULTS).map(([key, value]) => ({ key, value })),
  });

  console.log('▸ console users…');
  // No TOTP secret on purpose: two-step verification is mandatory for the
  // console, so the first sign-in walks the owner through enrolment.
  const owner = await prisma.user.create({
    data: { email: 'admin@adpilot.io', name: 'Platform Owner', role: 'SUPER_ADMIN', passwordHash: hash },
  });
  await prisma.teamMember.create({
    data: { userId: owner.id, scope: 'PLATFORM', role: 'OWNER', permissions: JSON.stringify(allGrants('PLATFORM')) },
  });

  // A finance-only console user, to show permissions actually biting.
  const finance = await prisma.user.create({
    data: { email: 'finance@adpilot.io', name: 'Farah Khan', role: 'SUPER_ADMIN', passwordHash: hash },
  });
  await prisma.teamMember.create({
    data: {
      userId: finance.id, scope: 'PLATFORM', role: 'MEMBER', invitedById: owner.id,
      permissions: JSON.stringify([
        'dashboard:read', 'ledger:read', 'recharges:read', 'recharges:update',
        'payouts:read', 'payouts:update', 'vendors:read',
      ]),
    },
  });

  // ------------------------------------------------------------- vendors
  console.log('▸ vendors + campaigns…');
  const vendorSpecs = [
    {
      email: 'ads@vectordb.io', person: 'Priya Nair', company: 'VectorDB Cloud',
      website: 'https://vectordb.io', country: 'IN', topUp: 2500,
      campaigns: [
        {
          name: 'India devs — vector search', category: 'developer-tools', pricing: 'CPM_CPC',
          cpm: 3.2, cpc: 0.45, budget: 900, daily: 60, priority: 8,
          geo: [{ country: 'IN', state: 'Karnataka', city: '*', area: '*' }, { country: 'IN', state: 'Telangana', city: 'Hyderabad', area: '*' }],
          ads: [
            { headline: 'Ship RAG in an afternoon', body: 'Managed vector search with sub-10ms p99. Free tier, no card.', cta: 'Start free', url: 'https://vectordb.io/start', accent: '#4f46e5' },
            { headline: 'Your embeddings deserve better', body: 'Drop-in pgvector replacement. Migrate in one command.', cta: 'See the docs', url: 'https://vectordb.io/migrate', accent: '#0ea5e9' },
          ],
        },
        {
          name: 'US enterprise retargeting', category: 'saas', pricing: 'CPC',
          cpm: 0, cpc: 1.1, budget: 1200, daily: 80, priority: 6,
          geo: [{ country: 'US', state: '*', city: '*', area: '*' }],
          ads: [
            { headline: 'SOC 2 vector infra', body: 'Private VPC deployment, BYOK encryption, 99.99% SLA.', cta: 'Book a demo', url: 'https://vectordb.io/enterprise', accent: '#7c3aed' },
          ],
        },
      ],
    },
    {
      email: 'growth@brewbeans.in', person: 'Rahul Menon', company: 'BrewBeans Coffee',
      website: 'https://brewbeans.in', country: 'IN', topUp: 700,
      campaigns: [
        {
          name: 'Koramangala café footfall', category: 'ecommerce', pricing: 'CPM',
          cpm: 2.4, cpc: 0, budget: 300, daily: 25, priority: 7,
          geo: [{ country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Koramangala' }, { country: 'IN', state: 'Karnataka', city: 'Bengaluru', area: 'Indiranagar' }],
          ads: [
            { headline: 'Coffee while it thinks', body: 'Single-origin pour-over, 300m from you. Show this for 20% off.', cta: 'Get directions', url: 'https://brewbeans.in/koramangala', accent: '#b45309' },
            { headline: 'Your 4pm slump called', body: 'Cold brew on tap. Brewed this morning in Bengaluru.', cta: 'Order now', url: 'https://brewbeans.in/order', accent: '#92400e' },
          ],
        },
      ],
    },
    {
      email: 'marketing@finlypay.com', person: 'Sarah Chen', company: 'FinlyPay',
      website: 'https://finlypay.com', country: 'US', topUp: 4000,
      campaigns: [
        {
          name: 'Global fintech awareness', category: 'finance', pricing: 'CPM_CPC',
          cpm: 4.5, cpc: 0.9, budget: 2000, daily: 120, priority: 9,
          geo: [{ country: '*', state: '*', city: '*', area: '*' }],
          ads: [
            { headline: 'Payouts to 180 countries', body: 'One API. Same-day settlement. Pricing that fits a startup.', cta: 'Read the API docs', url: 'https://finlypay.com/docs', accent: '#059669' },
            { headline: 'Stop losing 4% to FX', body: 'Mid-market rates on every cross-border transfer.', cta: 'Compare rates', url: 'https://finlypay.com/fx', accent: '#047857' },
            { headline: 'Built for marketplaces', body: 'Split payments, escrow and KYC out of the box.', cta: 'Start building', url: 'https://finlypay.com/marketplaces', accent: '#0d9488' },
          ],
        },
      ],
    },
    {
      email: 'hello@skillforge.dev', person: 'Tom Alvarez', company: 'SkillForge Academy',
      website: 'https://skillforge.dev', country: 'GB', topUp: 900,
      campaigns: [
        {
          name: 'London + NYC learners', category: 'education', pricing: 'CPC',
          cpm: 0, cpc: 0.6, budget: 500, daily: 40, priority: 5,
          geo: [{ country: 'GB', state: 'England', city: 'London', area: '*' }, { country: 'US', state: 'New York', city: 'New York', area: '*' }],
          ads: [
            { headline: 'Learn systems design properly', body: '12 weeks, live cohorts, ex-FAANG reviewers. Next intake Monday.', cta: 'See syllabus', url: 'https://skillforge.dev/systems-design', accent: '#db2777' },
            { headline: 'From senior to staff', body: 'The gap is not code. It is scope. We teach the scope.', cta: 'Apply now', url: 'https://skillforge.dev/staff', accent: '#be185d' },
          ],
        },
      ],
    },
  ];

  const createdCampaigns: Array<{
    id: string; vendorId: string; cpm: bigint; cpc: bigint; pricing: string;
    geo: { country: string; state: string; city: string; area: string }[];
    adIds: string[];
  }> = [];

  const now = new Date();
  for (const spec of vendorSpecs) {
    const user = await prisma.user.create({
      data: {
        email: spec.email, name: spec.person, role: 'VENDOR', passwordHash: hash,
        vendor: {
          create: {
            companyName: spec.company, website: spec.website, country: spec.country, status: 'ACTIVE',
            balanceMicros: usdToMicros(spec.topUp), lifetimeTopUpMicros: usdToMicros(spec.topUp),
            legalName: `${spec.company} Pvt Ltd`,
            taxId: `TAX${spec.company.replace(/\W/g, '').slice(0, 6).toUpperCase()}01`,
            billingEmail: spec.email,
            industry: spec.campaigns[0].category,
            addressLine1: '1 Commerce Street',
            city: spec.country === 'IN' ? 'Bengaluru' : spec.country === 'US' ? 'San Francisco' : 'London',
            state: spec.country === 'IN' ? 'Karnataka' : spec.country === 'US' ? 'California' : 'England',
            postalCode: '560095',
            onboardedAt: new Date(now.getTime() - 40 * 86_400_000),
          },
        },
      },
      include: { vendor: true },
    });
    const vendor = user.vendor!;

    await prisma.teamMember.create({
      data: { userId: user.id, scope: 'VENDOR', vendorId: vendor.id, role: 'OWNER', permissions: JSON.stringify(allGrants('VENDOR')) },
    });

    await prisma.recharge.create({
      data: {
        vendorId: vendor.id, amountMicros: usdToMicros(spec.topUp), method: 'BANK',
        reference: `SEED-${vendor.id.slice(0, 8)}`, status: 'COMPLETED', settledAt: new Date(now.getTime() - 31 * 86_400_000),
      },
    });
    await prisma.ledgerEntry.create({
      data: {
        type: 'VENDOR_TOPUP', account: 'VENDOR', amountMicros: usdToMicros(spec.topUp),
        vendorId: vendor.id, balanceAfter: usdToMicros(spec.topUp), note: 'initial funding',
        createdAt: new Date(now.getTime() - 31 * 86_400_000),
      },
    });

    for (const c of spec.campaigns) {
      const campaign = await prisma.campaign.create({
        data: {
          vendorId: vendor.id, name: c.name, category: c.category, pricingModel: c.pricing,
          cpmMicros: usdToMicros(c.cpm), cpcMicros: usdToMicros(c.cpc),
          totalBudgetMicros: usdToMicros(c.budget), dailyBudgetMicros: usdToMicros(c.daily),
          startAt: new Date(now.getTime() - DAYS * 86_400_000),
          endAt: new Date(now.getTime() + 60 * 86_400_000),
          priority: c.priority, status: 'ACTIVE', frequencyCapPerDay: 6,
          geoRules: { create: c.geo.map((g) => ({ mode: 'INCLUDE', ...g })) },
          ads: {
            create: c.ads.map((a) => ({
              headline: a.headline, body: a.body, ctaText: a.cta, clickUrl: a.url, accent: a.accent, status: 'ACTIVE',
              urlVerdict: 'SAFE', urlCheckedAt: new Date(),
            })),
          },
        },
        include: { ads: true },
      });
      createdCampaigns.push({
        id: campaign.id, vendorId: vendor.id, cpm: campaign.cpmMicros, cpc: campaign.cpcMicros,
        pricing: c.pricing, geo: c.geo, adIds: campaign.ads.map((a) => a.id),
      });
    }
  }

  // A vendor-side colleague who can run campaigns but never touch the wallet.
  const vectorDb = await prisma.vendor.findFirst({ where: { companyName: 'VectorDB Cloud' }, include: { user: true } });
  if (vectorDb) {
    const analyst = await prisma.user.create({
      data: { email: 'analyst@vectordb.io', name: 'Dev Analyst', role: 'VENDOR', passwordHash: hash },
    });
    await prisma.teamMember.create({
      data: {
        userId: analyst.id, scope: 'VENDOR', vendorId: vectorDb.id, role: 'MEMBER', invitedById: vectorDb.userId,
        permissions: JSON.stringify([
          'dashboard:read', 'campaigns:read', 'campaigns:create', 'campaigns:update',
          'creatives:read', 'creatives:create', 'creatives:update', 'reports:read',
        ]),
      },
    });
  }

  // A campaign waiting in the moderation queue, so the admin panel has work to do.
  const firstVendor = await prisma.vendor.findFirst({ where: { companyName: 'BrewBeans Coffee' } });
  await prisma.campaign.create({
    data: {
      vendorId: firstVendor!.id, name: 'Mumbai expansion (pending review)', category: 'ecommerce',
      pricingModel: 'CPM', cpmMicros: usdToMicros(2.1), totalBudgetMicros: usdToMicros(400),
      dailyBudgetMicros: usdToMicros(30), startAt: now, endAt: new Date(now.getTime() + 45 * 86_400_000),
      status: 'PENDING_REVIEW', priority: 5,
      geoRules: { create: [{ mode: 'INCLUDE', country: 'IN', state: 'Maharashtra', city: 'Mumbai', area: '*' }] },
      ads: { create: [{ headline: 'BrewBeans lands in Andheri', body: 'Opening week: every second cup is on us.', ctaText: 'Find us', clickUrl: 'https://brewbeans.in/mumbai', accent: '#b45309' }] },
    },
  });

  // ------------------------------------------------------------- end users
  console.log('▸ end users + devices…');
  const publisherSpecs = [
    { email: 'aarav@example.com', name: 'Aarav Sharma', loc: LOCATIONS[0], weight: 1.4 },
    { email: 'diya@example.com', name: 'Diya Patel', loc: LOCATIONS[1], weight: 1.1 },
    { email: 'kabir@example.com', name: 'Kabir Rao', loc: LOCATIONS[2], weight: 0.9 },
    { email: 'meera@example.com', name: 'Meera Iyer', loc: LOCATIONS[4], weight: 1.0 },
    { email: 'jordan@example.com', name: 'Jordan Blake', loc: LOCATIONS[5], weight: 1.3 },
    { email: 'lucy@example.com', name: 'Lucy Hart', loc: LOCATIONS[8], weight: 0.8 },
  ];

  const publishers: Array<{ id: string; deviceId: string; loc: (typeof LOCATIONS)[number]; weight: number }> = [];
  const DEMO_KEY = 'apk_demo_device_key_for_local_testing';

  for (const [i, p] of publisherSpecs.entries()) {
    const user = await prisma.user.create({
      data: {
        email: p.email, name: p.name, role: 'END_USER', passwordHash: hash,
        publisher: {
          create: {
            displayName: p.name, country: p.loc.country, state: p.loc.state, city: p.loc.city, area: p.loc.area,
            payoutMethod: p.loc.country === 'IN' ? 'UPI' : 'PAYPAL',
            payoutDetails: JSON.stringify(p.loc.country === 'IN' ? { upiId: `${p.name.split(' ')[0].toLowerCase()}@okbank` } : { paypalEmail: p.email }),
          },
        },
      },
      include: { publisher: true },
    });
    // The first end user gets a fixed key so the extension can be tested at once.
    const key = i === 0 ? DEMO_KEY : `apk_seed_${user.id}`;
    const device = await prisma.device.create({
      data: {
        publisherId: user.publisher!.id, keyHash: sha256(key), label: `${p.name.split(' ')[0]}'s laptop`,
        platform: pick(['macOS', 'Windows', 'Linux']), browser: 'Chrome', extVersion: '0.1.0', lastSeenAt: new Date(),
      },
    });
    publishers.push({ id: user.publisher!.id, deviceId: device.id, loc: p.loc, weight: p.weight });
  }

  // ------------------------------------------------------------- traffic
  console.log('▸ simulating 30 days of delivery…');

  const geoAllows = (rules: { country: string; state: string; city: string; area: string }[], loc: (typeof LOCATIONS)[number]) =>
    rules.some((r) =>
      (r.country === '*' || r.country === loc.country) &&
      (r.state === '*' || r.state === loc.state) &&
      (r.city === '*' || r.city === loc.city) &&
      (r.area === '*' || r.area === loc.area));

  type Row = Record<string, unknown>;
  const impressionRows: Row[] = [];
  const clickRows: Row[] = [];
  const ledgerRows: Row[] = [];
  const vendorSpend = new Map<string, bigint>();
  const campaignSpend = new Map<string, bigint>();
  const publisherEarn = new Map<string, bigint>();
  const adCounts = new Map<string, { imp: number; clk: number }>();

  let id = 0;
  const uid = (p: string) => `${p}-seed-${(id++).toString().padStart(6, '0')}`;

  for (let d = DAYS; d >= 0; d--) {
    const dayStart = new Date(now.getTime() - d * 86_400_000);
    // Weekday traffic runs higher, and volume grows slightly over the month.
    const weekday = dayStart.getDay();
    const dayFactor = (weekday === 0 || weekday === 6 ? 0.55 : 1) * (1 + (DAYS - d) * 0.012);

    for (const pub of publishers) {
      const eligible = createdCampaigns.filter((c) => geoAllows(c.geo, pub.loc));
      if (eligible.length === 0) continue;

      const count = Math.round(rand(4, 14) * pub.weight * dayFactor);
      for (let n = 0; n < count; n++) {
        const campaign = pick(eligible);
        const adId = pick(campaign.adIds);
        const servedAt = new Date(dayStart.getTime() + rand(8, 23) * 3600_000 + rand(0, 3600) * 1000);
        if (servedAt > now) continue;

        const impressionId = uid('imp');
        const clicked = chance(0.035);

        // Price exactly as the live server would.
        const impGross = campaign.pricing !== 'CPC' ? campaign.cpm / 1000n : 0n;
        const impSplit = splitRevenue(impGross, SHARE_BPS);
        const clickGross = clicked && campaign.pricing !== 'CPM' ? campaign.cpc : 0n;
        const clickSplit = splitRevenue(clickGross, SHARE_BPS);

        impressionRows.push({
          id: impressionId, adId, campaignId: campaign.id, vendorId: campaign.vendorId,
          publisherId: pub.id, deviceId: pub.deviceId,
          status: clicked ? 'CLICKED' : 'VIEWED', servedAt, confirmedAt: servedAt,
          dwellMs: Math.round(rand(1500, 9000)),
          country: pub.loc.country, state: pub.loc.state, city: pub.loc.city, area: pub.loc.area,
          ipHash: sha256(`${pub.id}:${d}`).slice(0, 32),
          hostApp: pick(HOSTS), modelHint: pick(MODELS),
          costMicros: impGross, payoutMicros: impSplit.publisherMicros, platformMicros: impSplit.platformMicros,
        });

        const counts = adCounts.get(adId) ?? { imp: 0, clk: 0 };
        counts.imp += 1;

        if (impGross > 0n) {
          vendorSpend.set(campaign.vendorId, (vendorSpend.get(campaign.vendorId) ?? 0n) + impGross);
          campaignSpend.set(campaign.id, (campaignSpend.get(campaign.id) ?? 0n) + impGross);
          publisherEarn.set(pub.id, (publisherEarn.get(pub.id) ?? 0n) + impSplit.publisherMicros);
          ledgerRows.push(
            { id: uid('led'), createdAt: servedAt, type: 'VENDOR_SPEND', account: 'VENDOR', amountMicros: -impGross, vendorId: campaign.vendorId, impressionId, note: 'impression' },
            { id: uid('led'), createdAt: servedAt, type: 'PUBLISHER_EARN', account: 'PUBLISHER', amountMicros: impSplit.publisherMicros, publisherId: pub.id, impressionId, note: 'impression' },
            { id: uid('led'), createdAt: servedAt, type: 'PLATFORM_REVENUE', account: 'PLATFORM', amountMicros: impSplit.platformMicros, vendorId: campaign.vendorId, impressionId, note: 'impression margin' },
          );
        }

        if (clicked) {
          counts.clk += 1;
          const clickedAt = new Date(servedAt.getTime() + rand(1200, 20000));
          clickRows.push({
            id: uid('clk'), impressionId, clickedAt,
            costMicros: clickGross, payoutMicros: clickSplit.publisherMicros, platformMicros: clickSplit.platformMicros,
            ipHash: sha256(`${pub.id}:${d}`).slice(0, 32), userAgent: 'Mozilla/5.0 (seed)',
          });
          if (clickGross > 0n) {
            vendorSpend.set(campaign.vendorId, (vendorSpend.get(campaign.vendorId) ?? 0n) + clickGross);
            campaignSpend.set(campaign.id, (campaignSpend.get(campaign.id) ?? 0n) + clickGross);
            publisherEarn.set(pub.id, (publisherEarn.get(pub.id) ?? 0n) + clickSplit.publisherMicros);
            ledgerRows.push(
              { id: uid('led'), createdAt: clickedAt, type: 'VENDOR_SPEND', account: 'VENDOR', amountMicros: -clickGross, vendorId: campaign.vendorId, impressionId, note: 'click' },
              { id: uid('led'), createdAt: clickedAt, type: 'PUBLISHER_EARN', account: 'PUBLISHER', amountMicros: clickSplit.publisherMicros, publisherId: pub.id, impressionId, note: 'click' },
              { id: uid('led'), createdAt: clickedAt, type: 'PLATFORM_REVENUE', account: 'PLATFORM', amountMicros: clickSplit.platformMicros, vendorId: campaign.vendorId, impressionId, note: 'click margin' },
            );
          }
        }
        adCounts.set(adId, counts);
      }
    }
  }

  // SQLite has a bind-variable ceiling — insert in chunks.
  const chunk = async <T>(rows: T[], fn: (batch: T[]) => Promise<unknown>, size = 400) => {
    for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
  };
  await chunk(impressionRows, (b) => prisma.impression.createMany({ data: b as never }));
  await chunk(clickRows, (b) => prisma.click.createMany({ data: b as never }));
  await chunk(ledgerRows, (b) => prisma.ledgerEntry.createMany({ data: b as never }));

  console.log('▸ reconciling balances…');
  for (const [vendorId, spend] of vendorSpend) {
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { balanceMicros: { decrement: spend }, lifetimeSpendMicros: { increment: spend } },
    });
  }
  for (const [campaignId, spend] of campaignSpend) {
    await prisma.campaign.update({ where: { id: campaignId }, data: { spentMicros: { increment: spend } } });
  }
  for (const [publisherId, earned] of publisherEarn) {
    await prisma.publisher.update({
      where: { id: publisherId },
      data: { balanceMicros: { increment: earned }, lifetimeEarnedMicros: { increment: earned } },
    });
  }
  for (const [adId, c] of adCounts) {
    await prisma.ad.update({ where: { id: adId }, data: { impressionCount: c.imp, clickCount: c.clk } });
  }

  // A payout waiting in the admin queue.
  const topEarner = await prisma.publisher.findFirst({ orderBy: { balanceMicros: 'desc' } });
  if (topEarner && topEarner.balanceMicros > usdToMicros(5)) {
    await prisma.payout.create({
      data: {
        publisherId: topEarner.id, amountMicros: usdToMicros(5), method: topEarner.payoutMethod ?? 'PAYPAL',
        details: topEarner.payoutDetails ?? '', status: 'REQUESTED',
      },
    });
  }
  // A pending top-up waiting for settlement.
  const brew = await prisma.vendor.findFirst({ where: { companyName: 'BrewBeans Coffee' } });
  if (brew) {
    await prisma.recharge.create({
      data: { vendorId: brew.id, amountMicros: usdToMicros(250), method: 'UPI', reference: 'UPI-PENDING-9981', status: 'PENDING' },
    });
  }

  const [impCount, clkCount] = await Promise.all([prisma.impression.count(), prisma.click.count()]);
  console.log(`\n  ✓ seeded ${impCount} impressions, ${clkCount} clicks\n`);
  console.log('  Password for every seeded account: Passw0rd!23\n');
  console.log('  Console   http://localhost:5173/login/admin');
  console.log('    admin@adpilot.io      owner, every permission');
  console.log('    finance@adpilot.io    finance only — no vendors, campaigns or settings');
  console.log('    ↳ both must enrol an authenticator app on first sign-in (mandatory)\n');
  console.log('  Vendors   http://localhost:5173/login/vendor');
  console.log('    ads@vectordb.io       owner (VectorDB Cloud)');
  console.log('    analyst@vectordb.io   campaigns only — cannot see the wallet');
  console.log('    growth@brewbeans.in · marketing@finlypay.com · hello@skillforge.dev\n');
  console.log('  Earners   http://localhost:5173/login/user');
  console.log('    aarav@example.com · diya@example.com · kabir@example.com …');
  console.log('    ↳ Google-only in production; password works while DEV_ALLOW_PASSWORD_LOGIN=true\n');
  console.log(`  Extension test key for aarav@example.com:\n    ${DEMO_KEY}\n`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
