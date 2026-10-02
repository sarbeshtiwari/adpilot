import { useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../../lib/useApi';
import { del, post } from '../../lib/api';
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Loading, Modal, PageHeader, Table, Td, useToast } from '../../components/ui';
import { dateTime, num, relative } from '../../lib/format';
import type { Device } from '../../lib/types';

type DeviceRow = Device & { pending: boolean };

export default function UserDevices() {
  const { data, isLoading, error, refetch } = useApi<DeviceRow[]>('/me/devices');
  const [pairing, setPairing] = useState(false);
  const invalidate = useInvalidate();
  const toast = useToast();

  const revoke = useMutation({
    mutationFn: (id: string) => del(`/me/devices/${id}`),
    onSuccess: () => { invalidate('/me/'); toast.push('Device revoked'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  return (
    <>
      <PageHeader title="Devices" subtitle="Each computer running the AdPilot extension"
        action={<Button variant="primary" onClick={() => setPairing(true)}>Pair a device</Button>} />

      <Card className="mb-6">
        <CardHeader title="Installing the extension" subtitle="Two minutes, once per computer" />
        <ol className="grid gap-3 text-xs text-ink-soft sm:grid-cols-4">
          {[
            ['Open Chrome extensions', 'Go to chrome://extensions and switch on Developer mode.'],
            ['Load the folder', 'Click "Load unpacked" and pick the adpilot/extension folder.'],
            ['Generate a code', 'Press "Pair a device" here to get an 8-character code.'],
            ['Enter the code', 'Click the AdPilot icon in Chrome and paste the code. Done.'],
          ].map(([t, d], i) => (
            <li key={t} className="rounded-lg border border-hairline p-3">
              <span className="mb-1.5 grid h-5 w-5 place-items-center rounded-full bg-brand-soft text-2xs font-semibold text-brand">{i + 1}</span>
              <p className="font-medium text-ink">{t}</p>
              <p className="mt-0.5">{d}</p>
            </li>
          ))}
        </ol>
      </Card>

      <Card pad={false}>
        {isLoading ? <Loading /> : error ? <div className="p-5"><ErrorNote error={error} retry={() => void refetch()} /></div>
          : !data?.length ? (
            <div className="p-5"><Empty title="No devices yet" hint="Pair your first computer to start earning."
              action={<Button variant="primary" onClick={() => setPairing(true)}>Pair a device</Button>} /></div>
          ) : (
            <Table head={['Device', 'Platform', 'Browser', 'Version', 'Ads served', 'Last seen', '']}>
              {data.map((d) => (
                <tr key={d.id} className={d.revokedAt ? 'opacity-50' : 'hover:bg-surface/60'}>
                  <Td className="font-medium text-ink">
                    {d.label}
                    {d.pending && <Badge tone="warn">waiting for code</Badge>}
                    {d.revokedAt && <Badge tone="bad">revoked</Badge>}
                    <span className="block text-2xs text-ink-mute">added {dateTime(d.createdAt)}</span>
                  </Td>
                  <Td className="text-xs">{d.platform ?? '—'}</Td>
                  <Td className="text-xs">{d.browser ?? '—'}</Td>
                  <Td className="text-xs">{d.extVersion ?? '—'}</Td>
                  <Td className="tnum">{num(d._count?.impressions ?? 0)}</Td>
                  <Td className="text-xs">{relative(d.lastSeenAt)}</Td>
                  <Td>
                    <div className="flex justify-end">
                      {!d.revokedAt && <Button size="sm" variant="ghost" onClick={() => revoke.mutate(d.id)}>Revoke</Button>}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
          )}
      </Card>

      <PairModal open={pairing} onClose={() => setPairing(false)} />
    </>
  );
}

function PairModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [label, setLabel] = useState('My computer');
  const [code, setCode] = useState<string | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();

  const mut = useMutation({
    mutationFn: () => post<{ code: string }>('/me/devices/pair-code', { label }),
    onSuccess: (r) => { setCode(r.code); invalidate('/me/'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  function close() { setCode(null); onClose(); }

  return (
    <Modal open={open} onClose={close} title="Pair a device"
      footer={<Button variant={code ? 'primary' : 'secondary'} onClick={close}>{code ? 'Done' : 'Cancel'}</Button>}>
      {code ? (
        <div className="text-center">
          <p className="text-xs text-ink-mute">Enter this code in the AdPilot extension</p>
          <p className="tnum my-4 select-all font-mono text-3xl font-bold tracking-[0.3em] text-ink">{code}</p>
          <button onClick={() => { void navigator.clipboard.writeText(code); toast.push('Code copied'); }}
            className="text-xs font-medium text-brand hover:underline">Copy code</button>
          <p className="mt-4 rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
            The code expires in 15 minutes and can only be used once.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <Field label="Device name" hint="So you can tell your devices apart later">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Work laptop" />
          </Field>
          <Button variant="primary" className="w-full" loading={mut.isPending} onClick={() => mut.mutate()}>
            Generate pairing code
          </Button>
        </div>
      )}
    </Modal>
  );
}
