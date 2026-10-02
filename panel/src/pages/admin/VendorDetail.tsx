import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { BarList, RevenueSplitChart, TrendChart } from '../../components/charts';
import { Badge, Card, CardHeader, ErrorNote, Loading, PageHeader, RangePicker, StatTile, StatusBadge, Table, Td } from '../../components/ui';
import { compact, dateTime, num, pct, usd, usdCompact } from '../../lib/format';
import type { Campaign, GeoRow, LedgerEntry, Recharge, SeriesPoint, Totals, Vendor } from '../../lib/types';

type Detail = {
  vendor: Vendor & { campaigns: Campaign[]; recharges: Recharge[] };
  totals: Totals; series: SeriesPoint[]; geo: GeoRow[]; ledger: LedgerEntry[];
};

export default function AdminVendorDetail() {
  const { id } = useParams();
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useApi<Detail>(`/admin/vendors/${id}?days=${days}`);

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;
  const v = data.vendor;

  return (
    <>
      <Link to="/admin/vendors" className="mb-3 inline-block text-xs text-ink-mute hover:text-ink">← All vendors</Link>
      <PageHeader title={v.companyName}
        subtitle={`${v.user?.email} · joined ${dateTime(v.createdAt)}`}
        action={<div className="flex items-center gap-3"><StatusBadge status={v.status} /><RangePicker days={days} onChange={setDays} /></div>} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Wallet balance" value={usdCompact(v.balanceMicros)} sub="available to spend" />
        <StatTile label="Spend in range" value={usdCompact(data.totals.spendMicros)} />
        <StatTile label="Impressions" value={compact(data.totals.impressions)} sub={`${pct(data.totals.ctr)} CTR`} />
        <StatTile label="Lifetime top-ups" value={usdCompact(v.lifetimeTopUpMicros)} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2"><RevenueSplitChart data={data.series} title="Spend breakdown" /></div>
        <BarList title="Delivery by location" rows={data.geo.slice(0, 8).map((g) => ({ key: g.key, label: g.key, value: g.impressions }))} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <TrendChart data={data.series} title="Impressions" metric="impressions" slot={0} />
        <TrendChart data={data.series} title="Clicks" metric="clicks" slot={1} />
      </div>

      <Card pad={false} className="mb-6">
        <div className="p-5 pb-0"><CardHeader title="Campaigns" subtitle={`${v.campaigns.length} total`} /></div>
        <Table head={['Name', 'Status', 'Pricing', 'Budget used', 'Targeting', 'Window']} empty={!v.campaigns.length}>
          {v.campaigns.map((c) => (
            <tr key={c.id} className="hover:bg-surface/60">
              <Td className="font-medium text-ink">{c.name}<span className="block text-2xs text-ink-mute">{c.category}</span></Td>
              <Td><StatusBadge status={c.status} /></Td>
              <Td className="text-xs">
                {c.pricingModel !== 'CPC' && <span className="tnum block">CPM {usd(c.cpmMicros)}</span>}
                {c.pricingModel !== 'CPM' && <span className="tnum block">CPC {usd(c.cpcMicros)}</span>}
              </Td>
              <Td className="tnum">{usd(c.spentMicros)} <span className="text-ink-mute">/ {usd(c.totalBudgetMicros)}</span></Td>
              <Td className="text-xs">{c.geoRules.length ? c.geoRules.map((g) => [g.city, g.state, g.country].filter((x) => x && x !== '*').join(', ') || 'Worldwide').join(' · ') : 'Worldwide'}</Td>
              <Td className="text-xs">{dateTime(c.startAt)} → {dateTime(c.endAt)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card pad={false}>
          <div className="p-5 pb-0"><CardHeader title="Recent ledger" subtitle="Every wallet movement" /></div>
          <Table head={['When', 'Type', 'Amount', 'Balance after']} empty={!data.ledger.length}>
            {data.ledger.slice(0, 12).map((l) => (
              <tr key={l.id}>
                <Td className="text-xs">{dateTime(l.createdAt)}</Td>
                <Td><Badge tone={l.type === 'VENDOR_TOPUP' ? 'good' : 'neutral'}>{l.type.replace('VENDOR_', '').toLowerCase()}</Badge></Td>
                <Td className={`tnum font-medium ${Number(l.amountMicros) < 0 ? 'text-ink' : 'text-good'}`}>{usd(l.amountMicros, { precise: true })}</Td>
                <Td className="tnum">{l.balanceAfter ? usd(l.balanceAfter) : '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card pad={false}>
          <div className="p-5 pb-0"><CardHeader title="Top-ups" subtitle="Prepaid funding history" /></div>
          <Table head={['When', 'Method', 'Amount', 'Status']} empty={!v.recharges.length}>
            {v.recharges.map((r) => (
              <tr key={r.id}>
                <Td className="text-xs">{dateTime(r.createdAt)}</Td>
                <Td>{r.method}<span className="block text-2xs text-ink-mute">{r.reference}</span></Td>
                <Td className="tnum font-medium text-ink">{usd(r.amountMicros)}</Td>
                <Td><StatusBadge status={r.status} /></Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
