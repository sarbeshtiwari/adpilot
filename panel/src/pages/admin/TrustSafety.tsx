import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { del, post, qs } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Loading, PageHeader, Pagination, Select, StatTile, Table, Tabs, Td, useToast } from '../../components/ui';
import { dateTime, num } from '../../lib/format';

type RiskEvent = {
  id: string; type: string; score: number; detail: string; createdAt: string;
  publisher: { id: string; displayName: string } | null;
};
type RiskData = {
  page: number; pages: number; total: number; data: RiskEvent[];
  byType: { type: string; _count: { _all: number }; _sum: { score: number | null } }[];
  blockedDevices: number; flaggedImpressions: number;
};
type BlockEntry = { id: string; pattern: string; reason: string; createdAt: string };

const TYPE_LABEL: Record<string, string> = {
  CLICK_VELOCITY: 'Click velocity',
  SHORT_DWELL: 'Views too short to count',
  DUPLICATE_IP: 'Many devices on one IP',
  IMPOSSIBLE_TIMING: 'Clicked faster than a human can',
  UA_MISMATCH: 'Device key moved browsers',
};

export default function TrustSafety() {
  const [tab, setTab] = useState('signals');
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const { data, isLoading, error, refetch } = useApi<RiskData>(`/admin/risk${qs({ page, type, limit: 50 })}`);
  const { data: blocklist } = useApi<BlockEntry[]>('/admin/blocklist');
  const invalidate = useInvalidate();
  const toast = useToast();

  const rescan = useMutation({
    mutationFn: () => post<{ scanned: number; blocked: number }>('/admin/creatives/rescan'),
    onSuccess: (r) => { invalidate('/admin/'); toast.push(`Rescanned ${r.scanned} creatives, pulled ${r.blocked}`); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  return (
    <>
      <PageHeader title="Trust &amp; safety" subtitle="Invalid traffic signals, blocked devices and creative destinations"
        action={<Button loading={rescan.isPending} onClick={() => rescan.mutate()}>Re-scan creatives</Button>} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Risk signals" value={num(data.total)} sub="all time" />
        <StatTile label="Flagged impressions" value={num(data.flaggedImpressions)} sub="held, not billed" tone={data.flaggedImpressions ? 'warn' : undefined} />
        <StatTile label="Blocked devices" value={num(data.blockedDevices)} tone={data.blockedDevices ? 'bad' : undefined} />
        <StatTile label="Blocklist entries" value={num(blocklist?.length ?? 0)} sub="destination patterns" />
      </div>

      <Tabs active={tab} onChange={setTab}
        tabs={[{ id: 'signals', label: 'Signals' }, { id: 'breakdown', label: 'By type' }, { id: 'blocklist', label: 'URL blocklist' }]} />

      {tab === 'signals' && (
        <Card pad={false}>
          <div className="flex flex-wrap items-center gap-2 px-5 py-4">
            <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-64">
              <option value="">All signal types</option>
              {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <span className="ml-auto text-xs text-ink-mute">{num(data.total)} signals</span>
          </div>
          <Table head={['When', 'Signal', 'Earner', 'Score', 'Detail']} empty={!data.data.length}>
            {data.data.map((e) => (
              <tr key={e.id} className="hover:bg-surface/60">
                <Td className="whitespace-nowrap text-xs">{dateTime(e.createdAt)}</Td>
                <Td><Badge tone={e.score >= 40 ? 'bad' : e.score >= 20 ? 'warn' : 'neutral'}>{TYPE_LABEL[e.type] ?? e.type}</Badge></Td>
                <Td className="text-xs">
                  {e.publisher
                    ? <Link to={`/admin/end-users/${e.publisher.id}`} className="text-ink hover:text-brand hover:underline">{e.publisher.displayName}</Link>
                    : '—'}
                </Td>
                <Td className="tnum font-medium text-ink">{e.score}</Td>
                <Td className="max-w-[22rem] truncate text-xs" title={e.detail}>{e.detail}</Td>
              </tr>
            ))}
          </Table>
          <Pagination page={data.page} pages={data.pages} onPage={setPage} />
        </Card>
      )}

      {tab === 'breakdown' && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card pad={false}>
            <div className="p-5 pb-0"><CardHeader title="Signals by type" subtitle="What is actually being detected" /></div>
            <Table head={['Signal', 'Count', 'Total score']} empty={!data.byType.length}>
              {data.byType.map((t) => (
                <tr key={t.type}>
                  <Td className="font-medium text-ink">{TYPE_LABEL[t.type] ?? t.type}</Td>
                  <Td className="tnum">{num(t._count._all)}</Td>
                  <Td className="tnum">{num(t._sum.score ?? 0)}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card>
            <CardHeader title="How scoring works" />
            <ul className="space-y-2 text-xs text-ink-soft">
              <li>• Each signal adds to a rolling score on the device and the earner.</li>
              <li>• Past the flag threshold an event is <span className="font-medium text-ink">held unbilled</span> — the vendor is not charged and the earner is not paid.</li>
              <li>• Past the block threshold the device stops being served entirely.</li>
              <li>• Scores decay hourly, so one bad afternoon is not a permanent ban.</li>
              <li>• Thresholds live in Platform → Settings.</li>
            </ul>
          </Card>
        </div>
      )}

      {tab === 'blocklist' && <Blocklist entries={blocklist ?? []} />}
    </>
  );
}

function Blocklist({ entries }: { entries: BlockEntry[] }) {
  const [pattern, setPattern] = useState('');
  const [reason, setReason] = useState('');
  const invalidate = useInvalidate();
  const toast = useToast();

  const add = useMutation({
    mutationFn: () => post('/admin/blocklist', { pattern, reason }),
    onSuccess: () => { invalidate('/admin/'); setPattern(''); setReason(''); toast.push('Pattern added'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/admin/blocklist/${id}`),
    onSuccess: () => { invalidate('/admin/'); toast.push('Pattern removed'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader title="Block a destination" subtitle="Matched as a regular expression against the full URL" />
        <div className="space-y-4">
          <Field label="Pattern" hint="e.g. (^|\\.)sketchy\\.example">
            <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="phishing-site\\.com" />
          </Field>
          <Field label="Reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reported phishing" /></Field>
          <Button variant="primary" loading={add.isPending} disabled={pattern.length < 3 || reason.length < 3} onClick={() => add.mutate()}>
            Add to blocklist
          </Button>
        </div>
      </Card>

      <Card pad={false} className="lg:col-span-2">
        <div className="p-5 pb-0"><CardHeader title="Blocked patterns" subtitle="Checked whenever a creative is saved or re-scanned" /></div>
        {entries.length === 0 ? (
          <div className="p-5"><Empty title="Nothing blocked" hint="Structural checks still apply to every destination." /></div>
        ) : (
          <Table head={['Pattern', 'Reason', 'Added', '']}>
            {entries.map((e) => (
              <tr key={e.id}>
                <Td className="font-mono text-xs text-ink">{e.pattern}</Td>
                <Td className="text-xs">{e.reason}</Td>
                <Td className="text-xs">{dateTime(e.createdAt)}</Td>
                <Td><div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => remove.mutate(e.id)}>Remove</Button></div></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}
