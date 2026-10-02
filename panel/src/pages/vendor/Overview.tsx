import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { BarList, CategoryBars, RevenueSplitChart, TrendChart } from '../../components/charts';
import { Badge, Card, CardHeader, Empty, ErrorNote, Loading, PageHeader, RangePicker, StatTile, StatusBadge, Table, Td } from '../../components/ui';
import { compact, num, pct, usd, usdCompact } from '../../lib/format';
import type { CampaignRow, GeoRow, HostRow, SeriesPoint, Totals, Vendor } from '../../lib/types';

type Overview = {
  vendor: Vendor; totals: Totals; series: SeriesPoint[]; topCampaigns: CampaignRow[];
  geo: GeoRow[]; hosts: HostRow[]; campaignCounts: Record<string, number>;
  projectedDaysLeft: number | null;
};

/** Reads better than "~5,876 days" when the wallet dwarfs the burn rate. */
function runway(days: number | null) {
  if (!days || !Number.isFinite(days)) return 'no spend yet';
  if (days > 365) return 'over a year at current burn';
  if (days < 2) return 'under 2 days at current burn';
  return `~${Math.round(days)} days at current burn`;
}

export default function VendorOverview() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useApi<Overview>(`/vendor/overview?days=${days}`);

  if (isLoading) return <Loading label="Loading your campaigns" />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const { vendor, totals } = data;
  const lowBalance = Number(vendor.balanceMicros) < 5_000_000;

  return (
    <>
      <PageHeader title="Dashboard" subtitle={`${vendor.companyName} · delivery while people wait on their AI`}
        action={<RangePicker days={days} onChange={setDays} />} />

      {vendor.status !== 'ACTIVE' && (
        <div className="mb-6 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
          Your vendor account is <strong>{vendor.status.toLowerCase()}</strong>. Campaigns cannot deliver until the platform team approves it.
        </div>
      )}
      {lowBalance && vendor.status === 'ACTIVE' && (
        <div className="mb-6 flex flex-wrap items-center gap-2 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
          Wallet is down to <span className="tnum font-semibold">{usd(vendor.balanceMicros)}</span>. Delivery stops at zero.
          <Link to="/vendor/wallet" className="rounded-md border border-warn/40 bg-panel px-2 py-1 text-xs font-medium text-ink hover:bg-surface">Top up</Link>
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Wallet balance" value={usdCompact(vendor.balanceMicros)} sub={runway(data.projectedDaysLeft)} />
        <StatTile label="Spend in range" value={usdCompact(totals.spendMicros)} sub={`${days}-day window`} />
        <StatTile label="Impressions" value={compact(totals.impressions)} sub={`${num(totals.clicks)} clicks · ${pct(totals.ctr)} CTR`} />
        <StatTile label="Effective CPC" value={usd(totals.ecpcMicros, { precise: true })} sub={`eCPM ${usd(totals.ecpmMicros, { precise: true })}`} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RevenueSplitChart data={data.series} title="Your spend, by destination" />
        </div>
        <BarList title="Where your ads landed" subtitle="Aggregated by city — no personal data"
          rows={data.geo.map((g) => ({ key: g.key, label: g.key, value: g.impressions, secondary: `· ${g.clicks} clicks` }))} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <TrendChart data={data.series} title="Impressions" metric="impressions" slot={0} />
        <TrendChart data={data.series} title="Clicks" metric="clicks" slot={1} />
      </div>

      <div className="mb-6">
        <CategoryBars title="Which AI surface your ads appeared on" subtitle="Ads render while the model is thinking"
          rows={data.hosts.map((h) => ({ key: h.hostApp, label: h.hostApp, value: h.impressions }))} />
      </div>

      <Card pad={false}>
        <div className="p-5 pb-0">
          <CardHeader title="Top campaigns" subtitle={Object.entries(data.campaignCounts).map(([k, v]) => `${v} ${k.toLowerCase().replace('_', ' ')}`).join(' · ') || 'no campaigns yet'}
            action={<Link to="/vendor/campaigns" className="text-xs font-medium text-brand hover:underline">Manage campaigns</Link>} />
        </div>
        {data.topCampaigns.length === 0 ? (
          <div className="p-5">
            <Empty title="No delivery yet" hint="Create a campaign, add a creative and submit it for review."
              action={<Link to="/vendor/campaigns" className="text-xs font-medium text-brand hover:underline">Create a campaign →</Link>} />
          </div>
        ) : (
          <Table head={['Campaign', 'Status', 'Impressions', 'Clicks', 'CTR', 'Spend']}>
            {data.topCampaigns.map((c) => (
              <tr key={c.campaignId} className="hover:bg-surface/60">
                <Td className="font-medium text-ink">
                  <Link to={`/vendor/campaigns/${c.campaignId}`} className="hover:text-brand hover:underline">{c.name}</Link>
                </Td>
                <Td><StatusBadge status={c.status} /></Td>
                <Td className="tnum">{num(c.impressions)}</Td>
                <Td className="tnum">{num(c.clicks)}</Td>
                <Td className="tnum">{pct(c.ctr)}</Td>
                <Td className="tnum font-medium text-ink">{usd(c.spendMicros)}</Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="mt-6 text-2xs text-ink-mute">
        <Badge>privacy</Badge> You see aggregated geography and engagement only. AdPilot never shares who saw your ad.
      </p>
    </>
  );
}
