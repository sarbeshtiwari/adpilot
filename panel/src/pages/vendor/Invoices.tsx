import { useApi } from '../../lib/useApi';
import { Badge, Card, CardHeader, ErrorNote, Empty, Loading, PageHeader, StatTile, Table, Td } from '../../components/ui';
import { dateTime, usd, usdCompact } from '../../lib/format';

type Invoice = {
  id: string; number: string; amountMicros: string; taxMicros: string; totalMicros: string;
  taxRateBps: number; taxLabel: string; currency: string; issuedAt: string;
  recharge: { method: string; reference: string; settledAt: string | null } | null;
};

export default function VendorInvoices() {
  const { data, isLoading, error, refetch } = useApi<{
    invoices: Invoice[];
    issuer: { name: string; taxId: string; address: string; taxLabel: string };
  }>('/vendor/invoices');

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const totals = data.invoices.reduce(
    (a, i) => ({ net: a.net + Number(i.amountMicros), tax: a.tax + Number(i.taxMicros), gross: a.gross + Number(i.totalMicros) }),
    { net: 0, tax: 0, gross: 0 },
  );

  return (
    <>
      <PageHeader title="Invoices" subtitle="A tax invoice is issued for every settled top-up" />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatTile label="Invoices" value={String(data.invoices.length)} />
        <StatTile label="Net of tax" value={usdCompact(totals.net)} />
        <StatTile label={data.issuer.taxLabel} value={usdCompact(totals.tax)} />
        <StatTile label="Total billed" value={usdCompact(totals.gross)} />
      </div>

      <Card pad={false}>
        <div className="p-5 pb-0">
          <CardHeader title="Issued invoices"
            subtitle={`From ${data.issuer.name}${data.issuer.taxId ? ` · ${data.issuer.taxId}` : ''}`} />
        </div>
        {data.invoices.length === 0 ? (
          <div className="p-5">
            <Empty title="No invoices yet" hint="One is issued automatically each time a top-up settles." />
          </div>
        ) : (
          <Table head={['Number', 'Issued', 'Method', 'Net', data.issuer.taxLabel, 'Total', '']}>
            {data.invoices.map((i) => (
              <tr key={i.id} className="hover:bg-surface/60">
                <Td className="font-mono text-xs font-medium text-ink">{i.number}</Td>
                <Td className="text-xs">{dateTime(i.issuedAt)}</Td>
                <Td className="text-xs">
                  {i.recharge?.method ?? '—'}
                  <span className="block max-w-[10rem] truncate text-2xs text-ink-mute">{i.recharge?.reference}</span>
                </Td>
                <Td className="tnum">{usd(i.amountMicros)}</Td>
                <Td className="tnum text-xs">
                  {usd(i.taxMicros)}
                  <span className="block text-2xs text-ink-mute">{(i.taxRateBps / 100).toFixed(1)}%</span>
                </Td>
                <Td className="tnum font-semibold text-ink">{usd(i.totalMicros)}</Td>
                <Td>
                  <div className="flex justify-end">
                    <a href={`/api/vendor/invoices/${i.id}`} target="_blank" rel="noreferrer"
                      className="rounded-md border border-hairline px-2 py-1 text-2xs text-ink-soft hover:bg-surface hover:text-ink">
                      View
                    </a>
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <p className="mt-4 text-2xs text-ink-mute">
        <Badge>note</Badge> Top-ups are treated as tax-inclusive: you pay the amount you chose, and the
        {' '}{data.issuer.taxLabel.toLowerCase()} component is shown separately for your records.
      </p>
    </>
  );
}
