import { useState } from 'react';
import { useApi } from '../../lib/useApi';
import { qs } from '../../lib/api';
import { Card, ErrorNote, Input, Loading, PageHeader, Pagination, Select, StatusBadge, Table, Td } from '../../components/ui';
import { dateTime, num, usd } from '../../lib/format';
import type { Impression, Paged } from '../../lib/types';

export default function AdminImpressions() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [country, setCountry] = useState('');
  const { data, isLoading, error, refetch } = useApi<Paged<Impression>>(
    `/admin/impressions${qs({ page, status, country, limit: 50 })}`,
    { refetchMs: 15_000 },
  );

  return (
    <>
      <PageHeader title="Delivery log" subtitle="Every ad served, who saw it, what it cost and what it paid" />
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-2 px-5 py-4">
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
            <option value="">All outcomes</option>
            {['SERVED', 'VIEWED', 'CLICKED', 'EXPIRED', 'VOID'].map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
          </Select>
          <Input placeholder="Country code (IN, US…)" value={country} maxLength={2}
            onChange={(e) => { setCountry(e.target.value.toUpperCase()); setPage(1); }} className="w-44" />
          <span className="ml-auto text-xs text-ink-mute">{num(data?.total ?? 0)} impressions · live</span>
        </div>

        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div> : (
          <>
            <Table head={['Served', 'Creative', 'Vendor', 'End user', 'Surface', 'Location', 'Dwell', 'Outcome', 'Cost', 'Paid']} empty={!data?.data.length}>
              {data?.data.map((i) => (
                <tr key={i.id} className="hover:bg-surface/60">
                  <Td className="whitespace-nowrap text-xs">{dateTime(i.servedAt)}</Td>
                  <Td className="max-w-[14rem] truncate font-medium text-ink" title={i.ad.headline}>{i.ad.headline}</Td>
                  <Td className="text-xs">{i.vendor?.companyName}<span className="block text-2xs text-ink-mute">{i.campaign.name}</span></Td>
                  <Td className="text-xs">{i.publisher?.displayName ?? '—'}<span className="block text-2xs text-ink-mute">{i.publisher?.user.email}</span></Td>
                  <Td className="text-xs">{i.hostApp}<span className="block text-2xs text-ink-mute">{i.modelHint}</span></Td>
                  <Td className="text-xs">{[i.city, i.state, i.country].filter(Boolean).join(', ')}<span className="block text-2xs text-ink-mute">{i.area}</span></Td>
                  <Td className="tnum text-xs">{(i.dwellMs / 1000).toFixed(1)}s</Td>
                  <Td><StatusBadge status={i.status} /></Td>
                  <Td className="tnum text-xs">{usd(i.costMicros, { precise: true })}</Td>
                  <Td className="tnum text-xs text-good">{usd(i.payoutMicros, { precise: true })}</Td>
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
