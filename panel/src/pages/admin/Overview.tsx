import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { BarList, CategoryBars, RevenueSplitChart, TrendChart } from '../../components/charts';
import { Badge, Card, CardHeader, Empty, ErrorNote, Loading, PageHeader, RangePicker, StatTile, StatusBadge, Table, Td } from '../../components/ui';
import { compact, duration, num, pct, usd, usdCompact } from '../../lib/format';
import type { CampaignRow, GeoRow, HostRow, SeriesPoint, Totals } from '../../lib/types';

type Overview = {
  totals: Totals;
  series: SeriesPoint[];
  topCampaigns: CampaignRow[];
  geo: GeoRow[];
  hosts: HostRow[];
  counts: { vendors: number; activeVendors: number; publishers: number; activeDevices: number; activeCampaigns: number; activeAds: number };
  money: {
    vendorFloatMicros: string; lifetimeSpendMicros: string; lifetimeTopUpMicros: string;
    publisherOwedMicros: string; publisherEarnedMicros: string; publisherPaidMicros: string;
  };
  queue: { pendingCampaigns: number; pendingVendors: number; pendingPayouts: number; pendingRecharges: number };
  uptimeSec: number;
};

const QUEUE_LINKS = [
  { key: 'pendingCampaigns', label: 'campaigns awaiting review', to: '/admin/campaigns?status=PENDING_REVIEW' },
  { key: 'pendingVendors', label: 'vendors awaiting approval', to: '/admin/vendors?status=PENDING' },
  { key: 'pendingPayouts', label: 'payouts to process', to: '/admin/payouts' },
  { key: 'pendingRecharges', label: 'top-ups to settle', to: '/admin/recharges' },
] as const;

export default function AdminOverview() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useApi<Overview>(`/admin/overview?days=${days}`);

  if (isLoading) return <Loading label="Loading the platform" />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const { totals, money, counts, queue } = data;
  const openWork = QUEUE_LINKS.filter((q) => queue[q.key] > 0);

  return (
    <>
      <PageHeader
        title="Platform dashboard"
        subtitle={`Every vendor, every end user, every dollar · up ${duration(data.uptimeSec)}`}
        action={<RangePicker days={days} onChange={setDays} />}
      />

      {openWork.length > 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3">
          <span className="text-xs font-semibold text-warn">Needs attention</span>
          {openWork.map((q) => (
            <Link key={q.key} to={q.to}
              className="rounded-md border border-warn/30 bg-panel px-2 py-1 text-xs text-ink hover:bg-surface">
              <span className="tnum font-semibold">{queue[q.key]}</span> {q.label}
            </Link>
          ))}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Gross ad spend" value={usdCompact(totals.spendMicros)} sub={`${days}-day window`} />
        <StatTile label="Platform revenue" value={usdCompact(totals.platformMicros)} tone="good"
          sub={`${pct(Number(totals.spendMicros) ? Number(totals.platformMicros) / Number(totals.spendMicros) : 0, 0)} take rate`} />
        <StatTile label="Paid to end users" value={usdCompact(totals.payoutMicros)} sub={`${num(counts.publishers)} earners`} />
        <StatTile label="Impressions" value={compact(totals.impressions)} sub={`${num(totals.clicks)} clicks · ${pct(totals.ctr)} CTR`} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RevenueSplitChart data={data.series} />
        </div>
        <Card>
          <CardHeader title="Money on the books" subtitle="Live balances across the platform" />
          <dl className="space-y-3 text-sm">
            {[
              { label: 'Vendor float held', value: money.vendorFloatMicros, hint: 'prepaid, not yet spent' },
              { label: 'Owed to end users', value: money.publisherOwedMicros, hint: 'earned, not withdrawn' },
              { label: 'Lifetime top-ups', value: money.lifetimeTopUpMicros, hint: 'all vendor deposits' },
              { label: 'Lifetime ad spend', value: money.lifetimeSpendMicros, hint: 'all time' },
              { label: 'Paid out to date', value: money.publisherPaidMicros, hint: 'settled withdrawals' },
            ].map((r) => (
              <div key={r.label} className="flex items-baseline justify-between gap-3 border-b border-hairline pb-2 last:border-0">
                <div>
                  <dt className="text-xs font-medium text-ink">{r.label}</dt>
                  <dd className="text-2xs text-ink-mute">{r.hint}</dd>
                </div>
                <span className="tnum shrink-0 text-sm font-semibold text-ink">{usd(r.value)}</span>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      {/* Two scales, two charts — never a shared axis. */}
      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <TrendChart data={data.series} title="Impressions" metric="impressions" slot={0} />
        <TrendChart data={data.series} title="Clicks" metric="clicks" slot={1} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <BarList title="Top locations" subtitle="Where ads were delivered"
          rows={data.geo.map((g) => ({ key: g.key, label: g.key, value: g.impressions, secondary: `· ${g.clicks} clicks` }))} />
        <div className="lg:col-span-2">
          <CategoryBars title="Delivery by AI surface" subtitle="Which model UI the ad appeared on"
            rows={data.hosts.map((h) => ({ key: h.hostApp, label: h.hostApp, value: h.impressions }))} />
        </div>
      </div>

      <Card pad={false}>
        <div className="p-5 pb-0">
          <CardHeader title="Top campaigns by spend"
            subtitle={`${num(counts.activeCampaigns)} live campaigns · ${num(counts.activeAds)} active creatives`}
            action={<Link to="/admin/campaigns" className="text-xs font-medium text-brand hover:underline">View all</Link>} />
        </div>
        <Table head={['Campaign', 'Vendor', 'Status', 'Impressions', 'Clicks', 'CTR', 'Spend']} empty={data.topCampaigns.length === 0}>
          {data.topCampaigns.map((c) => (
            <tr key={c.campaignId} className="hover:bg-surface/60">
              <Td className="font-medium text-ink">{c.name}</Td>
              <Td>{c.vendor}</Td>
              <Td><StatusBadge status={c.status} /></Td>
              <Td className="tnum">{num(c.impressions)}</Td>
              <Td className="tnum">{num(c.clicks)}</Td>
              <Td className="tnum">{pct(c.ctr)}</Td>
              <Td className="tnum font-medium text-ink">{usd(c.spendMicros)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Vendors" value={num(counts.vendors)} sub={`${counts.activeVendors} active`} />
        <StatTile label="End users" value={num(counts.publishers)} sub={`${counts.activeDevices} paired devices`} />
        <StatTile label="Effective CPM" value={usd(totals.ecpmMicros, { precise: true })} sub="revenue per 1k impressions" />
        <StatTile label="Effective CPC" value={usd(totals.ecpcMicros, { precise: true })} sub="revenue per click" />
      </div>

      {totals.impressions === 0 && (
        <div className="mt-6">
          <Empty title="No delivery in this window"
            hint="Run the seed script or pair the browser extension to start recording impressions." />
        </div>
      )}
      <p className="mt-6 text-2xs text-ink-mute">
        <Badge>note</Badge> Vendors never see end-user identities; this console is the only place the two sides meet.
      </p>
    </>
  );
}
