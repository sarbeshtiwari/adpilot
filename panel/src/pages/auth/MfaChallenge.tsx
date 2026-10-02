import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HOME_FOR, useAuth, type Portal } from '../../lib/auth';
import { Button, Field, Input } from '../../components/ui';
import { LoginLayout } from './LoginLayout';

/** Second step: the password or Google check already passed. */
export function MfaChallenge({ portal, challengeToken, onCancel }: {
  portal: Portal; challengeToken: string; onCancel: () => void;
}) {
  const { submitMfa } = useAuth();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const user = await submitMfa(challengeToken, code.trim());
      nav(HOME_FOR[user.role], { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code was not accepted');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginLayout
      badge="Two-step verification"
      title="Enter your code"
      subtitle={useRecovery ? 'Use one of the recovery codes you saved.' : 'Open your authenticator app and type the 6-digit code.'}
      tone={portal === 'ADMIN' ? 'admin' : 'brand'}
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label={useRecovery ? 'Recovery code' : 'Authentication code'}>
          <Input
            value={code}
            onChange={(e) => setCode(useRecovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, '').slice(0, 6))}
            placeholder={useRecovery ? 'ABCD-1234' : '000000'}
            inputMode={useRecovery ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            className="tnum text-center text-lg tracking-[0.35em]"
          />
        </Field>
        {error && <p className="rounded-lg border border-bad/30 bg-bad/5 px-3 py-2 text-xs text-bad">{error}</p>}
        <Button type="submit" variant="primary" loading={busy} disabled={code.length < 6} className="w-full">Verify</Button>
      </form>

      <div className="mt-4 flex items-center justify-between text-xs">
        <button onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(''); }}
          className="font-medium text-brand hover:underline">
          {useRecovery ? 'Use authenticator app' : 'Lost your device?'}
        </button>
        <button onClick={onCancel} className="text-ink-mute hover:text-ink">Start over</button>
      </div>
    </LoginLayout>
  );
}
