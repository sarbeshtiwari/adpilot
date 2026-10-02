import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { qs } from '../../lib/api';
import { Badge, Card, ErrorNote, Input, Loading, PageHeader, Pagination, Table, Td } from '../../components/ui';
import { dateTime, num } from '../../lib/format';
import type { AuditRow, Paged } from '../../lib/types';

export default function AdminAudit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data, isLoading, error, refetch } = useApi<Paged<AuditRow>>(`/admin/audit${qs({ page, action, limit: 50 })}`);

  return (
    <>
      <PageHeader title="Audit log" subtitle="Who did what, when — every privileged action on the platform" />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Input placeholder="Filter by action (campaign., payout., vendor.…)" value={action}
            onChange={(e) => { setAction(e.target.value); setPage(1); }} className="max-w-sm" />
          <span className="ml-auto text-xs text-ink-mute">{num(data?.total ?? 0)} events</span>
        </div>

        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['When', 'Actor', 'Role', 'Action', 'Entity', 'Detail']} empty={!data?.data.length}>
              {data?.data.map((a) => (
                <tr key={a.id} className="hover:bg-surface/60">
                  <Td className="whitespace-nowrap text-xs">{dateTime(a.createdAt)}</Td>
                  <Td className="text-xs text-ink">{a.actor?.name ?? 'system'}<span className="block text-2xs text-ink-mute">{a.actor?.email}</span></Td>
                  <Td><Badge tone={a.actorRole === 'SUPER_ADMIN' ? 'brand' : 'neutral'}>{a.actorRole.replace(/_/g, ' ').toLowerCase()}</Badge></Td>
                  <Td className="font-mono text-xs text-ink">{a.action}</Td>
                  <Td className="text-xs">{a.entity}<span className="block max-w-[10rem] truncate text-2xs text-ink-mute">{a.entityId}</span></Td>
                  <Td className="max-w-[20rem] truncate font-mono text-2xs text-ink-mute" title={a.meta}>{a.meta}</Td>
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
