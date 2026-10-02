import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { BarList, CategoryBars, RevenueSplitChart, TrendChart } from '../../components/charts';
import { Card, CardHeader, ErrorNote, Loading, PageHeader, RangePicker, Select, StatTile, StatusBadge, Table, Td } from '../../components/ui';
import { compact, num, pct, usd, usdCompact } from '../../lib/format';
import type { CampaignRow, GeoRow, HostRow, SeriesPoint, Totals } from '../../lib/types';

type Reports = { totals: Totals; series: SeriesPoint[]; geo: GeoRow[]; hosts: HostRow[]; campaigns: CampaignRow[] };
type Level = 'country' | 'state' | 'city' | 'area';

export default function AdminReports() {
  const [days, setDays] = useState(30);
  const [level, setLevel] = useState<Level>('city');
  const { data, isLoading, error, refetch } = useApi<Reports>(`/admin/reports?days=${days}&level=${level}`);

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Reports" subtitle="Platform-wide delivery, geography and revenue"
        action={
          <div className="flex items-center gap-2">
            <Select value={level} onChange={(e) => setLevel(e.target.value as Level)} className="w-36">
              <option value="country">By country</option>
              <option value="state">By state</option>
              <option value="city">By city</option>
              <option value="area">By area</option>
            </Select>
            <RangePicker days={days} onChange={setDays} />
          </div>
        } />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Impressions" value={compact(data.totals.impressions)} />
        <StatTile label="Clicks" value={num(data.totals.clicks)} sub={`${pct(data.totals.ctr)} CTR`} />
        <StatTile label="Gross spend" value={usdCompact(data.totals.spendMicros)} />
        <StatTile label="Platform margin" value={usdCompact(data.totals.platformMicros)} tone="good" />
      </div>

      <div className="mb-6"><RevenueSplitChart data={data.series} /></div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <TrendChart data={data.series} title="Impressions" metric="impressions" slot={0} />
        <TrendChart data={data.series} title="Clicks" metric="clicks" slot={1} />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <BarList title={`Delivery by ${level}`} rows={data.geo.map((g) => ({ key: g.key, label: g.key, value: g.impressions, secondary: `· ${g.clicks} clicks` }))} take={10} />
        <CategoryBars title="Delivery by AI surface" rows={data.hosts.map((h) => ({ key: h.hostApp, label: h.hostApp, value: h.impressions }))} />
      </div>

      <Card pad={false} className="mb-6">
        <div className="p-5 pb-0"><CardHeader title={`Geography detail — by ${level}`} subtitle="Aggregated; no end-user identity is attached" /></div>
        <Table head={['Location', 'Impressions', 'Clicks', 'CTR', 'Spend']} empty={!data.geo.length}>
          {data.geo.slice(0, 50).map((g) => (
            <tr key={g.key} className="hover:bg-surface/60">
              <Td className="font-medium text-ink">{g.key}</Td>
              <Td className="tnum">{num(g.impressions)}</Td>
              <Td className="tnum">{num(g.clicks)}</Td>
              <Td className="tnum">{pct(g.impressions ? g.clicks / g.impressions : 0)}</Td>
              <Td className="tnum">{usd(g.spendMicros)}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card pad={false}>
        <div className="p-5 pb-0"><CardHeader title="Campaign performance" subtitle="Ranked by spend in the window" /></div>
        <Table head={['Campaign', 'Vendor', 'Status', 'Impressions', 'Clicks', 'CTR', 'Spend']} empty={!data.campaigns.length}>
          {data.campaigns.map((c) => (
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
    </>
  );
}
