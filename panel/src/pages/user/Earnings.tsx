import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { qs } from '../../lib/api';
import { Badge, Card, ErrorNote, Loading, PageHeader, Pagination, StatusBadge, Table, Td } from '../../components/ui';
import { dateTime, num, usd } from '../../lib/format';
import type { LedgerEntry, Paged } from '../../lib/types';

export default function UserEarnings() {
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useApi<Paged<LedgerEntry>>(`/me/earnings${qs({ page, limit: 50 })}`);

  return (
    <>
      <PageHeader title="Earnings history" subtitle="Every credit to your wallet, down to the fraction of a cent" />
      <Card pad={false}>
        <div className="flex items-center justify-between px-5 py-4">
          <p className="text-xs text-ink-mute">{num(data?.total ?? 0)} entries</p>
          <Badge>amounts shown to 4 decimals</Badge>
        </div>
        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['When', 'Source', 'Ad', 'Where', 'Type', 'Amount']} empty={!data?.data.length}>
              {data?.data.map((l) => (
                <tr key={l.id} className="hover:bg-surface/60">
                  <Td className="whitespace-nowrap text-xs">{dateTime(l.createdAt)}</Td>
                  <Td>
                    <Badge tone={l.type === 'PUBLISHER_PAYOUT' ? 'bad' : l.type === 'ADJUSTMENT' ? 'neutral' : 'good'}>
                      {l.type === 'PUBLISHER_EARN' ? 'ad revenue' : l.type === 'PUBLISHER_PAYOUT' ? 'withdrawal' : l.type.toLowerCase()}
                    </Badge>
                  </Td>
                  <Td className="max-w-[16rem] truncate text-xs text-ink" title={l.impression?.ad.headline}>
                    {l.impression?.ad.headline ?? l.note}
                  </Td>
                  <Td className="text-xs">
                    {l.impression ? l.impression.hostApp : '—'}
                    {l.impression && <span className="block text-2xs text-ink-mute">{[l.impression.city, l.impression.country].filter(Boolean).join(', ')}</span>}
                  </Td>
                  <Td>{l.impression ? <StatusBadge status={l.impression.status} /> : <span className="text-xs text-ink-mute">—</span>}</Td>
                  <Td className={`tnum font-medium ${Number(l.amountMicros) < 0 ? 'text-bad' : 'text-good'}`}>
                    {Number(l.amountMicros) > 0 ? '+' : ''}{usd(l.amountMicros, { precise: true })}
                  </Td>
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
