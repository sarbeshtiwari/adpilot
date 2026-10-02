import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { CategoryBars, RevenueSplitChart, TrendChart } from '../../components/charts';
import { Badge, Card, CardHeader, Empty, ErrorNote, Loading, PageHeader, RangePicker, StatTile, StatusBadge, Table, Td } from '../../components/ui';
import { compact, dateTime, num, pct, relative, usd, usdCompact } from '../../lib/format';
import type { Device, HostRow, Publisher, SeriesPoint, Totals } from '../../lib/types';

type Overview = {
  publisher: Publisher; totals: Totals; series: SeriesPoint[]; hosts: HostRow[];
  devices: (Device & { pending: boolean })[];
  recent: { id: string; servedAt: string; status: string; payoutMicros: string; hostApp: string; ad: { headline: string }; campaign: { category: string } }[];
  minPayoutMicros: string; revenueSharePct: number;
};

export default function UserOverview() {
  const [days, setDays] = useState(30);
  const { data, isLoading, error, refetch } = useApi<Overview>(`/me/overview?days=${days}`);

  if (isLoading) return <Loading label="Loading your earnings" />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const p = data.publisher;
  const activeDevices = data.devices.filter((d) => !d.pending);
  const canWithdraw = Number(p.balanceMicros) >= Number(data.minPayoutMicros);
  const perAd = data.totals.impressions ? Number(data.totals.payoutMicros) / data.totals.impressions : 0;

  return (
    <>
      <PageHeader title={`Hi, ${p.displayName.split(' ')[0]}`}
        subtitle={`You keep ${data.revenueSharePct}% of what advertisers pay for every ad you see`}
        action={<RangePicker days={days} onChange={setDays} />} />

      {activeDevices.length === 0 && (
        <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-brand/30 bg-brand-soft px-4 py-3">
          <div className="flex-1">
            <p className="text-sm font-medium text-ink">Install the extension to start earning</p>
            <p className="text-xs text-ink-soft">Ads appear only while your AI model is thinking — and every view pays you.</p>
          </div>
          <Link to="/app/devices" className="rounded-lg bg-brand px-3 py-1.5 text-xs font-medium text-white hover:brightness-110">Pair a device</Link>
        </div>
      )}
      {!p.adsEnabled && (
        <div className="mb-6 rounded-xl border border-warn/30 bg-warn/5 px-4 py-3 text-sm text-warn">
          Ad delivery is paused, so you are not earning. Turn it back on in <Link to="/app/settings" className="font-medium underline">ad preferences</Link>.
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Available to withdraw" value={usdCompact(p.balanceMicros)} tone="good"
          sub={canWithdraw ? 'ready to cash out' : `${usd(data.minPayoutMicros)} minimum`} />
        <StatTile label="Lifetime earned" value={usdCompact(p.lifetimeEarnedMicros)} sub={`${usd(p.paidOutMicros)} paid out`} />
        <StatTile label="Ads seen" value={compact(data.totals.impressions)}
          sub={`${num(data.totals.clicks)} clicked · ${pct(data.totals.ctr)}`} />
        <StatTile label="Average per ad" value={usd(perAd, { precise: true })} sub="clicks pay much more" />
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RevenueSplitChart data={data.series} title="Your earnings over time" showPlatform={false} />
        </div>
        <Card>
          <CardHeader title="How you earn" />
          <ol className="space-y-3 text-xs text-ink-soft">
            {[
              ['Your model starts thinking', 'The extension notices the pause and asks AdPilot for an ad.'],
              ['An ad appears', 'Only if it matches your location and your preferences. It disappears when the answer arrives.'],
              ['You get paid', `Every confirmed view credits your wallet with ${data.revenueSharePct}% of what the advertiser paid.`],
              ['Clicking pays more', 'If the ad is genuinely useful, a click is worth many times a view.'],
            ].map(([t, d], i) => (
              <li key={t} className="flex gap-2.5">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-brand-soft text-2xs font-semibold text-brand">{i + 1}</span>
                <span><span className="font-medium text-ink">{t}.</span> {d}</span>
              </li>
            ))}
          </ol>
          <Link to="/app/payouts"
            className="mt-4 block rounded-lg bg-brand px-3 py-2 text-center text-xs font-medium text-white hover:brightness-110">
            Withdraw earnings
          </Link>
        </Card>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <TrendChart data={data.series} title="Ads seen per day" metric="impressions" slot={0} />
        <CategoryBars title="Where you see ads" subtitle="Which AI you were using at the time"
          rows={data.hosts.map((h) => ({ key: h.hostApp, label: h.hostApp, value: h.impressions }))} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card pad={false}>
          <div className="p-5 pb-0">
            <CardHeader title="Recent ads" subtitle="The last few you were shown"
              action={<Link to="/app/earnings" className="text-xs font-medium text-brand hover:underline">Full history</Link>} />
          </div>
          {data.recent.length === 0 ? (
            <div className="p-5"><Empty title="No ads yet" hint="Pair a device and keep using your AI tools as normal." /></div>
          ) : (
            <Table head={['When', 'Ad', 'Where', 'Outcome', 'Earned']}>
              {data.recent.map((r) => (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap text-xs">{relative(r.servedAt)}</Td>
                  <Td className="max-w-[14rem] truncate font-medium text-ink" title={r.ad.headline}>{r.ad.headline}</Td>
                  <Td className="text-xs">{r.hostApp}</Td>
                  <Td><StatusBadge status={r.status} /></Td>
                  <Td className="tnum text-good">{usd(r.payoutMicros, { precise: true })}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>

        <Card pad={false}>
          <div className="p-5 pb-0">
            <CardHeader title="Your devices" subtitle={`${activeDevices.length} paired`}
              action={<Link to="/app/devices" className="text-xs font-medium text-brand hover:underline">Manage</Link>} />
          </div>
          <Table head={['Device', 'Platform', 'Version', 'Last seen']} empty={!data.devices.length}>
            {data.devices.map((d) => (
              <tr key={d.id}>
                <Td className="font-medium text-ink">{d.label}{d.pending && <Badge tone="warn">awaiting pairing</Badge>}</Td>
                <Td className="text-xs">{d.platform ?? '—'}</Td>
                <Td className="text-xs">{d.extVersion ?? '—'}</Td>
                <Td className="text-xs">{relative(d.lastSeenAt)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <p className="mt-6 text-2xs text-ink-mute">
        <Badge>privacy</Badge> Advertisers see aggregated city-level counts only. Your name, email and browsing stay private.
        Last location used for targeting: {[p.city, p.state, p.country].filter(Boolean).join(', ') || 'unknown'} · {dateTime(p.updatedAt ?? p.createdAt)}
      </p>
    </>
  );
}
