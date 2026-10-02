import { useEffect, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { post } from '../../lib/api';
import { HOME_FOR, useAuth } from '../../lib/auth';
import { Button, Field, Input, Loading, Spinner } from '../../components/ui';
import { LoginLayout } from './LoginLayout';

type Setup = { secret: string; otpauthUri: string; qrDataUrl: string };

/**
 * Enrolment. Console accounts land here automatically on first sign-in and
 * cannot reach the panel until it is finished.
 */
export default function TwoStepSetup() {
  const { user, loading, mfaSetupRequired, refresh } = useAuth();
  const nav = useNavigate();
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const mandatory = user?.role === 'SUPER_ADMIN';

  useEffect(() => {
    if (!user || setup || codes) return;
    post<Setup>('/auth/mfa/setup')
      .then(setSetup)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not start setup'));
  }, [user, setup, codes]);

  if (loading) return <Loading label="Checking your account" />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.totpEnabled && !codes && !mfaSetupRequired) return <Navigate to={HOME_FOR[user.role]} replace />;

  async function enable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await post<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code: code.trim() });
      setCodes(res.recoveryCodes);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  // ── step 2: the codes, shown exactly once ────────────────────────────────
  if (codes) {
    return (
      <LoginLayout badge="Two-step verification" title="Save your recovery codes"
        subtitle="This is the only time they are shown. Each one works once."
        tone={mandatory ? 'admin' : 'brand'}>
        <ul className="tnum mb-4 grid grid-cols-2 gap-2 rounded-lg border border-hairline bg-surface p-3 font-mono text-sm">
          {codes.map((c) => <li key={c} className="text-center text-ink">{c}</li>)}
        </ul>
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => { void navigator.clipboard.writeText(codes.join('\n')); setCopied(true); }}>
            {copied ? 'Copied' : 'Copy codes'}
          </Button>
          <Button variant="primary" className="flex-1" onClick={() => nav(HOME_FOR[user.role], { replace: true })}>
            I have saved them
          </Button>
        </div>
        <p className="mt-3 text-2xs text-ink-mute">
          Store them somewhere other than the device running your authenticator app.
        </p>
      </LoginLayout>
    );
  }

  // ── step 1: scan and confirm ─────────────────────────────────────────────
  return (
    <LoginLayout
      badge="Two-step verification"
      title={mandatory ? 'Set up required' : 'Add two-step verification'}
      subtitle={mandatory
        ? 'Console accounts need an authenticator app before the panel opens.'
        : 'An extra step that keeps your account yours.'}
      tone={mandatory ? 'admin' : 'brand'}
    >
      {!setup ? (
        <div className="flex items-center justify-center gap-2 py-10 text-sm text-ink-mute"><Spinner /> Preparing…</div>
      ) : (
        <>
          <ol className="mb-4 space-y-1.5 text-xs text-ink-soft">
            <li><span className="font-medium text-ink">1.</span> Open Google Authenticator, 1Password, Authy or Bitwarden.</li>
            <li><span className="font-medium text-ink">2.</span> Scan this code.</li>
            <li><span className="font-medium text-ink">3.</span> Type the 6 digits it shows.</li>
          </ol>

          <div className="mb-4 flex justify-center">
            <img src={setup.qrDataUrl} alt="Two-step verification QR code" width={192} height={192}
              className="rounded-lg border border-hairline bg-white p-2" />
          </div>

          <details className="mb-4">
            <summary className="cursor-pointer text-2xs text-ink-mute hover:text-ink">Can’t scan? Enter the key manually</summary>
            <code className="mt-2 block select-all break-all rounded-lg bg-surface px-3 py-2 font-mono text-xs text-ink">{setup.secret}</code>
          </details>

          <form onSubmit={enable} className="space-y-4">
            <Field label="Code from your app">
              <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="000000" inputMode="numeric" autoComplete="one-time-code" autoFocus
                className="tnum text-center text-lg tracking-[0.35em]" />
            </Field>
            {error && <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
            <Button type="submit" variant="primary" loading={busy} disabled={code.length !== 6} className="w-full">
              Turn on two-step verification
            </Button>
          </form>
        </>
      )}
    </LoginLayout>
  );
}
