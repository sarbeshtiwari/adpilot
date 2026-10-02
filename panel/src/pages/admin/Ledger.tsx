import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { qs } from '../../lib/api';
import { Badge, Card, ErrorNote, Loading, PageHeader, Pagination, Select, StatTile, Table, Td } from '../../components/ui';
import { dateTime, num, usd } from '../../lib/format';
import type { LedgerEntry, Paged } from '../../lib/types';

type LedgerPage = Paged<LedgerEntry> & { byType: { type: string; _sum: { amountMicros: string }; _count: { _all: number } }[] };

const TONE: Record<string, 'good' | 'bad' | 'neutral' | 'brand'> = {
  VENDOR_TOPUP: 'good', VENDOR_SPEND: 'neutral', PUBLISHER_EARN: 'brand',
  PUBLISHER_PAYOUT: 'bad', PLATFORM_REVENUE: 'good', ADJUSTMENT: 'neutral', REFUND: 'neutral',
};

export default function AdminLedger() {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [account, setAccount] = useState('');
  const { data, isLoading, error, refetch } = useApi<LedgerPage>(`/admin/ledger${qs({ page, type, account, limit: 50 })}`);

  const byType = Object.fromEntries((data?.byType ?? []).map((t) => [t.type, t]));
  const platform = byType.PLATFORM_REVENUE?._sum.amountMicros ?? '0';
  const topups = byType.VENDOR_TOPUP?._sum.amountMicros ?? '0';
  const earned = byType.PUBLISHER_EARN?._sum.amountMicros ?? '0';
  const paid = byType.PUBLISHER_PAYOUT?._sum.amountMicros ?? '0';

  return (
    <>
      <PageHeader title="Ledger" subtitle="Append-only journal — every movement of money on the platform" />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Platform revenue" value={usd(platform)} tone="good" sub="all time margin" />
        <StatTile label="Vendor deposits" value={usd(topups)} sub="all time" />
        <StatTile label="End-user earnings" value={usd(earned)} sub="all time" />
        <StatTile label="Withdrawals settled" value={usd(String(Math.abs(Number(paid))))} sub="paid out" />
      </div>

      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} className="w-52">
            <option value="">All entry types</option>
            {['VENDOR_TOPUP', 'VENDOR_SPEND', 'PUBLISHER_EARN', 'PUBLISHER_PAYOUT', 'PLATFORM_REVENUE', 'ADJUSTMENT'].map((t) => (
              <option key={t} value={t}>{t.replace(/_/g, ' ').toLowerCase()}</option>
            ))}
          </Select>
          <Select value={account} onChange={(e) => { setAccount(e.target.value); setPage(1); }} className="w-40">
            <option value="">All accounts</option>
            <option value="VENDOR">Vendor</option>
            <option value="PUBLISHER">End user</option>
            <option value="PLATFORM">Platform</option>
          </Select>
          <span className="ml-auto text-xs text-ink-mute">{num(data?.total ?? 0)} entries</span>
        </div>

        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['When', 'Type', 'Account', 'Party', 'Amount', 'Balance after', 'Note']} empty={!data?.data.length}>
              {data?.data.map((l) => (
                <tr key={l.id} className="hover:bg-surface/60">
                  <Td className="whitespace-nowrap text-xs">{dateTime(l.createdAt)}</Td>
                  <Td><Badge tone={TONE[l.type] ?? 'neutral'}>{l.type.replace(/_/g, ' ').toLowerCase()}</Badge></Td>
                  <Td className="text-xs">{l.account.toLowerCase()}</Td>
                  <Td className="text-xs text-ink">{l.vendor?.companyName ?? l.publisher?.displayName ?? '—'}</Td>
                  <Td className={`tnum font-medium ${Number(l.amountMicros) < 0 ? 'text-bad' : 'text-good'}`}>
                    {Number(l.amountMicros) > 0 ? '+' : ''}{usd(l.amountMicros, { precise: true })}
                  </Td>
                  <Td className="tnum text-xs">{l.balanceAfter ? usd(l.balanceAfter) : '—'}</Td>
                  <Td className="max-w-[18rem] truncate text-xs" title={l.note}>{l.note}</Td>
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
