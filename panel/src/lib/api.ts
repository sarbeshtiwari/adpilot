const BASE = import.meta.env.VITE_API_URL ?? '/api';

/**
 * The session lives in an httpOnly cookie, so nothing here ever touches it —
 * or localStorage. What the client does hold is the CSRF token, which is
 * deliberately readable and echoed back in a header on every write.
 */
export function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)adpilot_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
  get isPermissionDenied() { return this.code === 'permission_denied'; }
  get isMfaSetupRequired() { return this.code === 'mfa_setup_required'; }
}

type Options = { method?: string; body?: unknown; signal?: AbortSignal };

/** Where to send someone whose session just died, based on where they are. */
function loginPathForCurrentArea(): string {
  const p = location.pathname;
  if (p.startsWith('/admin')) return '/login/admin';
  if (p.startsWith('/vendor')) return '/login/vendor';
  if (p.startsWith('/app')) return '/login/user';
  return '/login';
}

export async function api<T = unknown>(path: string, opts: Options = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const res = await fetch(`${BASE}${path}`, {
    method,
    // Sends and accepts the session cookie. Without this the API sees an
    // anonymous request no matter what is stored in the browser.
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(method === 'GET' ? {} : { 'x-csrf-token': csrfToken() }),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: opts.signal,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = new ApiError(res.status, (data?.error as string) ?? `Request failed (${res.status})`, data?.code, data?.details);
    // An expired session bounces to the right portal; a missing second factor
    // goes to enrolment rather than throwing the user out.
    if (res.status === 401 && !path.startsWith('/auth/')) {
      const target = loginPathForCurrentArea();
      if (location.pathname !== target) location.href = target;
    }
    if (err.isMfaSetupRequired && location.pathname !== '/security/two-step') {
      location.href = '/security/two-step';
    }
    throw err;
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>(p);
export const post = <T>(p: string, body?: unknown) => api<T>(p, { method: 'POST', body });
export const patch = <T>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body });
export const put = <T>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body });
export const del = <T>(p: string) => api<T>(p, { method: 'DELETE' });

export function qs(params: Record<string, string | number | undefined | null>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  }
  const out = s.toString();
  return out ? `?${out}` : '';
}

// ─────────────────────────────────────────────── Google Identity Services

let gisPromise: Promise<void> | null = null;

/** Loads Google's script once, on demand — never when Google is not configured. */
export function loadGoogleScript(): Promise<void> {
  if (gisPromise) return gisPromise;
  gisPromise = new Promise((resolve, reject) => {
    if (document.getElementById('google-gsi')) return resolve();
    const el = document.createElement('script');
    el.id = 'google-gsi';
    el.src = 'https://accounts.google.com/gsi/client';
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error('Could not reach Google sign-in'));
    document.head.appendChild(el);
  });
  return gisPromise;
}
