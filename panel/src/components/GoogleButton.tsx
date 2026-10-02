import { useEffect, useRef, useState } from 'react';
import { loadGoogleScript } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Spinner } from './ui';

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (cfg: { client_id: string; callback: (r: { credential: string }) => void; ux_mode?: string }) => void;
          renderButton: (el: HTMLElement, opts: Record<string, unknown>) => void;
        };
      };
    };
  }
}

/**
 * Renders Google's own button — required by their branding rules, and it keeps
 * the credential flow inside Google's iframe rather than our page.
 */
export function GoogleButton({ onCredential, text = 'signin_with' }: {
  onCredential: (credential: string) => void;
  text?: 'signin_with' | 'signup_with' | 'continue_with';
}) {
  const { config } = useAuth();
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const cb = useRef(onCredential);
  cb.current = onCredential;

  const clientId = config?.google.clientId ?? null;

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    loadGoogleScript()
      .then(() => {
        if (cancelled || !ref.current || !window.google) return;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: (r) => cb.current(r.credential),
        });
        window.google.accounts.id.renderButton(ref.current, {
          theme: document.documentElement.classList.contains('dark') ? 'filled_black' : 'outline',
          size: 'large',
          width: 320,
          text,
          shape: 'rectangular',
          logo_alignment: 'center',
        });
        setState('ready');
      })
      .catch(() => !cancelled && setState('error'));
    return () => { cancelled = true; };
  }, [clientId, text]);

  if (!config) return null;

  if (!clientId) {
    return (
      <p className="rounded-lg border border-dashed border-hairline px-3 py-2.5 text-center text-xs text-ink-mute">
        Google sign-in is not configured on this server.
        <span className="mt-0.5 block">Set <code className="rounded bg-surface px-1">GOOGLE_CLIENT_ID</code> in the API environment.</span>
      </p>
    );
  }

  return (
    <div className="flex min-h-[44px] justify-center">
      {state === 'loading' && <span className="flex items-center gap-2 text-xs text-ink-mute"><Spinner className="h-3.5 w-3.5" /> Loading Google…</span>}
      {state === 'error' && <span className="text-xs text-bad">Could not reach Google sign-in</span>}
      <div ref={ref} className={state === 'ready' ? '' : 'hidden'} />
    </div>
  );
}
