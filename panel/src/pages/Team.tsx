import { useMemo, useState } from 'react';
import { useApi, useInvalidate, useMutation } from '../lib/useApi';
import { del, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Loading,
  Modal, PageHeader, StatusBadge, Table, Td, cx, useToast,
} from '../components/ui';
import { dateTime, relative } from '../lib/format';

type Action = 'read' | 'create' | 'update' | 'delete';
type Section = { key: string; label: string; description: string; actions: Action[] };

type Member = {
  id: string; role: 'OWNER' | 'ADMIN' | 'MEMBER'; status: string; createdAt: string;
  permissions: string[];
  invitedBy: { name: string; email: string } | null;
  user: { id: string; email: string; name: string; status: string; lastLoginAt: string | null; totpEnabled: boolean; signInMethods: string[] };
};

type TeamData = {
  scope: 'PLATFORM' | 'VENDOR';
  members: Member[];
  sections: Section[];
  presets: { full: string[]; readOnly: string[] };
  you: { isOwner: boolean; userId: string };
};

const ACTION_LABEL: Record<Action, string> = { read: 'View', create: 'Create', update: 'Edit', delete: 'Delete' };

/** The grid every permission decision is made in. */
function PermissionGrid({ sections, value, onChange, disabled, limitTo }: {
  sections: Section[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** When set, grants outside this list cannot be given — you cannot pass on what you lack. */
  limitTo?: Set<string> | null;
}) {
  const has = (g: string) => value.includes(g);
  const toggle = (g: string) => onChange(has(g) ? value.filter((x) => x !== g) : [...value, g]);

  const toggleRow = (s: Section) => {
    const grants = s.actions.map((a) => `${s.key}:${a}`).filter((g) => !limitTo || limitTo.has(g));
    const allOn = grants.every(has);
    onChange(allOn ? value.filter((g) => !grants.includes(g)) : [...new Set([...value, ...grants])]);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-hairline">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-hairline bg-surface/60 text-left">
            <th className="px-3 py-2 text-2xs font-semibold uppercase tracking-wide text-ink-mute">Section</th>
            {(['read', 'create', 'update', 'delete'] as Action[]).map((a) => (
              <th key={a} className="w-20 px-2 py-2 text-center text-2xs font-semibold uppercase tracking-wide text-ink-mute">{ACTION_LABEL[a]}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline">
          {sections.map((s) => (
            <tr key={s.key} className="hover:bg-surface/40">
              <td className="px-3 py-2">
                <button type="button" onClick={() => !disabled && toggleRow(s)} disabled={disabled}
                  className="text-left disabled:cursor-not-allowed">
                  <span className="block text-xs font-medium text-ink">{s.label}</span>
                  <span className="block text-2xs text-ink-mute">{s.description}</span>
                </button>
              </td>
              {(['read', 'create', 'update', 'delete'] as Action[]).map((a) => {
                const grant = `${s.key}:${a}`;
                const supported = s.actions.includes(a);
                const blocked = Boolean(limitTo && !limitTo.has(grant));
                return (
                  <td key={a} className="px-2 py-2 text-center">
                    {supported ? (
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[rgb(var(--brand))] disabled:opacity-30"
                        checked={has(grant)}
                        disabled={disabled || blocked}
                        title={blocked ? 'You do not have this permission yourself' : undefined}
                        onChange={() => toggle(grant)}
                        aria-label={`${ACTION_LABEL[a]} ${s.label}`}
                      />
                    ) : (
                      <span className="text-ink-mute" aria-hidden>—</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function TeamPage() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useApi<TeamData>('/team');
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState<Member | null>(null);
  const invalidate = useInvalidate();
  const toast = useToast();

  const remove = useMutation({
    mutationFn: (id: string) => del(`/team/${id}`),
    onSuccess: () => { invalidate('/team'); toast.push('Member removed'); },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const myGrants = useMemo(
    () => (data?.you.isOwner ? null : new Set(user?.membership?.permissions ?? [])),
    [data, user],
  );

  if (isLoading) return <Loading label="Loading your team" />;
  if (error) return <ErrorNote error={error} retry={() => void refetch()} />;
  if (!data) return null;

  const isPlatform = data.scope === 'PLATFORM';

  return (
    <>
      <PageHeader
        title="Team"
        subtitle={isPlatform
          ? 'Who can open the console, and exactly what they can touch'
          : 'Give colleagues their own login instead of sharing yours'}
        action={<Button variant="primary" onClick={() => setInviting(true)}>Add member</Button>}
      />

      <Card pad={false} className="mb-6">
        <Table head={['Member', 'Access', 'Permissions', 'Sign-in', 'Last seen', '']} empty={!data.members.length}>
          {data.members.map((m) => {
            const isYou = m.user.id === data.you.userId;
            return (
              <tr key={m.id} className="hover:bg-surface/60">
                <Td className="font-medium text-ink">
                  {m.user.name}{isYou && <span className="ml-1.5 text-2xs font-normal text-ink-mute">(you)</span>}
                  <span className="block text-2xs text-ink-mute">{m.user.email}</span>
                </Td>
                <Td>
                  <Badge tone={m.role === 'OWNER' ? 'brand' : m.role === 'ADMIN' ? 'good' : 'neutral'}>{m.role.toLowerCase()}</Badge>
                  {m.status !== 'ACTIVE' && <StatusBadge status={m.status} />}
                </Td>
                <Td className="text-xs">
                  {m.role === 'OWNER' ? 'Everything' : `${m.permissions.length} of ${data.presets.full.length} grants`}
                  <span className="mt-0.5 block max-w-[18rem] truncate text-2xs text-ink-mute" title={m.permissions.join(', ')}>
                    {m.role === 'OWNER' ? 'cannot be limited' : m.permissions.map((p) => p.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ')}
                  </span>
                </Td>
                <Td className="text-xs">
                  {m.user.signInMethods.join(' + ') || '—'}
                  {m.user.totpEnabled
                    ? <Badge tone="good">2FA on</Badge>
                    : isPlatform ? <Badge tone="warn">2FA pending</Badge> : null}
                </Td>
                <Td className="text-xs">{relative(m.user.lastLoginAt)}</Td>
                <Td>
                  <div className="flex justify-end gap-1">
                    {m.role !== 'OWNER' && !isYou && (
                      <>
                        <Button size="sm" onClick={() => setEditing(m)}>Edit</Button>
                        <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.id)}>Remove</Button>
                      </>
                    )}
                  </div>
                </Td>
              </tr>
            );
          })}
        </Table>
      </Card>

      {isPlatform && (
        <Card>
          <CardHeader title="Console accounts" subtitle="Rules that apply to everyone here" />
          <ul className="space-y-1.5 text-xs text-ink-soft">
            <li>• Console users can only be created from inside the console — there is no public signup.</li>
            <li>• Every console account must enrol an authenticator app before the panel opens to them.</li>
            <li>• A member can never grant a permission they do not hold themselves.</li>
            <li>• Suspending or removing someone cuts their live sessions immediately.</li>
          </ul>
        </Card>
      )}

      <MemberModal
        open={inviting} onClose={() => setInviting(false)} data={data} limitTo={myGrants}
        title="Add a team member"
      />
      {editing && (
        <MemberModal
          open onClose={() => setEditing(null)} data={data} limitTo={myGrants} member={editing}
          title={`Edit access — ${editing.user.name}`}
        />
      )}
    </>
  );
}

function MemberModal({ open, onClose, data, member, title, limitTo }: {
  open: boolean; onClose: () => void; data: TeamData; member?: Member; title: string; limitTo: Set<string> | null;
}) {
  const editing = Boolean(member);
  const [form, setForm] = useState({
    name: member?.user.name ?? '',
    email: member?.user.email ?? '',
    password: '',
    usePassword: true,
    role: (member?.role === 'ADMIN' ? 'ADMIN' : 'MEMBER') as 'ADMIN' | 'MEMBER',
  });
  const [grants, setGrants] = useState<string[]>(member?.permissions ?? data.presets.readOnly);
  const invalidate = useInvalidate();
  const toast = useToast();

  const save = useMutation({
    mutationFn: () =>
      editing
        ? patch(`/team/${member!.id}`, { role: form.role, permissions: grants })
        : post('/team', {
            name: form.name,
            email: form.email,
            password: form.usePassword && form.password ? form.password : undefined,
            role: form.role,
            permissions: grants,
          }),
    onSuccess: () => {
      invalidate('/team');
      toast.push(editing ? 'Access updated' : 'Member added');
      onClose();
    },
    onError: (e: Error) => toast.push(e.message, 'bad'),
  });

  const adminRole = form.role === 'ADMIN';
  const effective = adminRole ? data.presets.full : grants;
  const canSubmit = editing || (form.name.length >= 2 && /\S+@\S+\.\S+/.test(form.email) && (!form.usePassword || form.password.length >= 8));

  return (
    <Modal open={open} onClose={onClose} wide title={title}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={save.isPending} disabled={!canSubmit || effective.length === 0} onClick={() => save.mutate()}>
          {editing ? 'Save access' : 'Add member'}
        </Button>
      </>}>
      <div className="space-y-5">
        {!editing && (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Jane Doe" /></Field>
              <Field label="Work email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            </div>
            <div className="rounded-lg border border-hairline p-3">
              <div className="mb-2 flex gap-2">
                {[
                  { id: true, label: 'Set a password', hint: 'They can change it after signing in' },
                  { id: false, label: 'Google only', hint: 'They sign in with their work Google account' },
                ].map((o) => (
                  <button key={String(o.id)} type="button" onClick={() => setForm({ ...form, usePassword: o.id })}
                    className={cx('flex-1 rounded-lg border p-2.5 text-left transition',
                      form.usePassword === o.id ? 'border-brand bg-brand-soft' : 'border-hairline hover:bg-surface')}>
                    <span className={cx('block text-xs font-medium', form.usePassword === o.id ? 'text-brand' : 'text-ink')}>{o.label}</span>
                    <span className="block text-2xs text-ink-mute">{o.hint}</span>
                  </button>
                ))}
              </div>
              {form.usePassword && (
                <Field label="Temporary password" hint="At least 8 characters">
                  <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
                </Field>
              )}
            </div>
          </>
        )}

        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-mute">Access level</p>
          <div className="flex gap-2">
            {[
              { id: 'ADMIN' as const, label: 'Administrator', hint: 'Everything in this panel' },
              { id: 'MEMBER' as const, label: 'Custom', hint: 'Pick exactly what they can do' },
            ].map((o) => (
              <button key={o.id} type="button" onClick={() => setForm({ ...form, role: o.id })}
                className={cx('flex-1 rounded-lg border p-2.5 text-left transition',
                  form.role === o.id ? 'border-brand bg-brand-soft' : 'border-hairline hover:bg-surface')}>
                <span className={cx('block text-xs font-medium', form.role === o.id ? 'text-brand' : 'text-ink')}>{o.label}</span>
                <span className="block text-2xs text-ink-mute">{o.hint}</span>
              </button>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-mute">Permissions</p>
            {!adminRole && (
              <div className="flex gap-2 text-2xs">
                <button type="button" className="text-brand hover:underline"
                  onClick={() => setGrants(limitTo ? data.presets.readOnly.filter((g) => limitTo.has(g)) : data.presets.readOnly)}>
                  View-only preset
                </button>
                <button type="button" className="text-ink-mute hover:text-ink" onClick={() => setGrants([])}>Clear</button>
              </div>
            )}
          </div>
          <PermissionGrid sections={data.sections} value={effective} onChange={setGrants} disabled={adminRole} limitTo={adminRole ? null : limitTo} />
          {adminRole && <p className="mt-2 text-2xs text-ink-mute">Administrators hold every permission; switch to Custom to narrow it.</p>}
          {limitTo && <p className="mt-2 text-2xs text-ink-mute">Greyed-out boxes are permissions you do not hold yourself, so you cannot pass them on.</p>}
        </div>

        {member && (
          <p className="text-2xs text-ink-mute">
            Added {dateTime(member.createdAt)}{member.invitedBy ? ` by ${member.invitedBy.name}` : ''}.
            Changing access ends their current sessions where it removes rights.
          </p>
        )}
        {!editing && data.scope === 'PLATFORM' && (
          <p className="rounded-lg bg-surface px-3 py-2 text-xs text-ink-mute">
            They will be asked to set up an authenticator app the first time they sign in — the console will not open until they do.
          </p>
        )}
      </div>
    </Modal>
  );
}
