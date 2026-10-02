import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../../lib/useApi';
import { qs } from '../../lib/api';
import { Badge, Card, ErrorNote, Input, Loading, PageHeader, Pagination, StatusBadge, Table, Td } from '../../components/ui';
import { num, relative, usd } from '../../lib/format';
import type { Paged, Publisher } from '../../lib/types';

export default function AdminEndUsers() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const { data, isLoading, error, refetch } = useApi<Paged<Publisher>>(`/admin/publishers${qs({ page, q, limit: 20 })}`);

  return (
    <>
      <PageHeader title="End users" subtitle="People running the extension and earning from ad views" />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Input placeholder="Search name, email or city…" value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-xs" />
          <span className="ml-auto text-xs text-ink-mute">{num(data?.total ?? 0)} earners</span>
        </div>

        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['User', 'Location', 'Devices', 'Impressions', 'Lifetime earned', 'Balance', 'Ads', 'Last seen']} empty={!data?.data.length}>
              {data?.data.map((p) => (
                <tr key={p.id} className="hover:bg-surface/60">
                  <Td className="font-medium text-ink">
                    <Link to={`/admin/end-users/${p.id}`} className="hover:text-brand hover:underline">{p.displayName}</Link>
                    <span className="block text-2xs text-ink-mute">{p.user?.email}</span>
                  </Td>
                  <Td className="text-xs">{[p.city, p.state, p.country].filter(Boolean).join(', ') || '—'}</Td>
                  <Td className="tnum">{p._count?.devices ?? 0}</Td>
                  <Td className="tnum">{num(p._count?.impressions ?? 0)}</Td>
                  <Td className="tnum">{usd(p.lifetimeEarnedMicros)}</Td>
                  <Td className="tnum font-medium text-ink">{usd(p.balanceMicros)}</Td>
                  <Td>{p.adsEnabled ? <Badge tone="good">on</Badge> : <Badge tone="warn">paused</Badge>}</Td>
                  <Td className="text-xs">{relative(p.user?.lastLoginAt)}</Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data?.page ?? 1} pages={data?.pages ?? 1} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
