import { useApi } from '../../lib/useApi';
import { Badge, Card, CardHeader, ErrorNote, Loading, PageHeader, StatTile } from '../../components/ui';
import { dateTime, duration, num, pct, relative } from '../../lib/format';

type Health = {
  status: string; dbLatencyMs: number; uptimeSec: number;
  memoryMb: { rss: number; heapUsed: number }; nodeVersion: string;
  lastHour: { served: number; confirmed: number; clicked: number; voided: number; confirmRate: number; ctr: number };
  lastImpressionAt: string | null;
  warnings: string[];
};

export default function AdminHealth() {
  const { data, isLoading, error, refetch } = useApi<Health>('/admin/health', { refetchMs: 10_000 });

  if (isLoading) return <Loading label="Checking the platform" />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const h = data.lastHour;
  return (
    <>
      <PageHeader title="System health" subtitle="Live service status, refreshed every 10 seconds"
        action={<Badge tone={data.status === 'healthy' ? 'good' : 'warn'}>{data.status}</Badge>} />

      {data.warnings.length > 0 && (
        <div className="mb-6 space-y-1.5 rounded-xl border border-warn/30 bg-warn/5 p-4">
          <p className="text-xs font-semibold text-warn">Warnings</p>
          {data.warnings.map((w) => <p key={w} className="text-xs text-ink-soft">• {w}</p>)}
        </div>
      )}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="API uptime" value={duration(data.uptimeSec)} sub={`Node ${data.nodeVersion}`} />
        <StatTile label="Database latency" value={`${data.dbLatencyMs}ms`} tone={data.dbLatencyMs < 100 ? 'good' : 'bad'} sub="SELECT 1 round trip" />
        <StatTile label="Memory (RSS)" value={`${data.memoryMb.rss} MB`} sub={`${data.memoryMb.heapUsed} MB heap`} />
        <StatTile label="Last impression" value={relative(data.lastImpressionAt)} sub={dateTime(data.lastImpressionAt)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Delivery funnel — last hour" subtitle="Served → confirmed on screen → clicked" />
          <div className="space-y-3">
            {[
              { label: 'Served', value: h.served, of: h.served },
              { label: 'Confirmed on screen', value: h.confirmed, of: h.served },
              { label: 'Clicked', value: h.clicked, of: h.served },
              { label: 'Voided (too short)', value: h.voided, of: h.served },
            ].map((r) => (
              <div key={r.label}>
                <div className="mb-1 flex items-baseline justify-between">
                  <span className="text-xs font-medium text-ink">{r.label}</span>
                  <span className="tnum text-xs text-ink-soft">{num(r.value)}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${r.of ? Math.max((r.value / r.of) * 100, 1) : 0}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-6 border-t border-hairline pt-3">
            <div><p className="text-2xs uppercase tracking-wide text-ink-mute">Confirm rate</p><p className="tnum text-lg font-semibold text-ink">{pct(h.confirmRate, 1)}</p></div>
            <div><p className="text-2xs uppercase tracking-wide text-ink-mute">CTR</p><p className="tnum text-lg font-semibold text-ink">{pct(h.ctr, 2)}</p></div>
          </div>
        </Card>

        <Card>
          <CardHeader title="What these numbers mean" />
          <dl className="space-y-3 text-xs">
            {[
              ['Confirm rate', 'Share of served ads the extension confirmed as genuinely on screen for more than 1.2 seconds. Only confirmed views are billed — a low rate points to a detection bug, not lost revenue.'],
              ['Voided', 'Ads dismissed before the minimum view time. These cost the vendor nothing and pay the end user nothing.'],
              ['Database latency', 'A single round trip. Above 500ms the service reports as degraded.'],
              ['Stale devices', 'Extensions not seen in seven days. Usually an uninstall or a machine that is switched off.'],
            ].map(([k, v]) => (
              <div key={k}><dt className="font-semibold text-ink">{k}</dt><dd className="mt-0.5 text-ink-mute">{v}</dd></div>
            ))}
          </dl>
        </Card>
      </div>
    </>
  );
}
