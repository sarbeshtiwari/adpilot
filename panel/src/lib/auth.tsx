import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { get, post } from './api';

export type Role = 'SUPER_ADMIN' | 'VENDOR' | 'END_USER';
export type Portal = 'ADMIN' | 'VENDOR' | 'USER';

export type Membership = {
  scope: 'PLATFORM' | 'VENDOR';
  role: 'OWNER' | 'ADMIN' | 'MEMBER';
  isOwner: boolean;
  permissions: string[];
};

export type SessionUser = {
  id: string; email: string; name: string; role: Role; status: string;
  avatarUrl: string | null; createdAt: string;
  totpEnabled: boolean; hasPassword: boolean; googleLinked: boolean;
  membership: Membership | null;
  vendor: { id: string; companyName: string; status: string; balanceMicros: string; onboardedAt: string | null } | null;
  publisher: { id: string; displayName: string; balanceMicros: string } | null;
};

export type PortalConfig = {
  google: { enabled: boolean; clientId: string | null };
  passwordLoginForEndUsers: boolean;
  portals: Record<Portal, { password: boolean; google: boolean; mfaRequired: boolean; selfSignup?: boolean }>;
};

/** Either a finished sign-in, or a stop at the second factor. */
export type LoginOutcome =
  | { kind: 'done'; user: SessionUser; mfaSetupRequired: boolean }
  | { kind: 'mfa'; challengeToken: string };

type AuthValue = {
  user: SessionUser | null;
  loading: boolean;
  mfaSetupRequired: boolean;
  config: PortalConfig | null;
  loginPassword: (email: string, password: string, portal: Portal) => Promise<LoginOutcome>;
  loginGoogle: (credential: string, portal: Portal) => Promise<LoginOutcome>;
  submitMfa: (challengeToken: string, code: string) => Promise<SessionUser>;
  registerVendor: (input: Record<string, unknown>) => Promise<LoginOutcome>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  can: (section: string, action?: 'read' | 'create' | 'update' | 'delete') => boolean;
};

const AuthContext = createContext<AuthValue | null>(null);

export const HOME_FOR: Record<Role, string> = {
  SUPER_ADMIN: '/admin',
  VENDOR: '/vendor',
  END_USER: '/app',
};

export const LOGIN_FOR: Record<Portal, string> = {
  ADMIN: '/login/admin',
  VENDOR: '/login/vendor',
  USER: '/login/user',
};

export const PORTAL_FOR_ROLE: Record<Role, Portal> = {
  SUPER_ADMIN: 'ADMIN',
  VENDOR: 'VENDOR',
  END_USER: 'USER',
};

type MeResponse = { user: SessionUser; mfaSetupRequired: boolean };
type LoginResponse = MeResponse | { mfaRequired: true; challengeToken: string };

const asOutcome = (res: LoginResponse): LoginOutcome =>
  'mfaRequired' in res
    ? { kind: 'mfa', challengeToken: res.challengeToken }
    : { kind: 'done', user: res.user, mfaSetupRequired: res.mfaSetupRequired };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
  const [config, setConfig] = useState<PortalConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await get<MeResponse>('/auth/me');
      setUser(res.user);
      setMfaSetupRequired(res.mfaSetupRequired);
    } catch {
      setUser(null);
      setMfaSetupRequired(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    get<PortalConfig>('/auth/config').then(setConfig).catch(() => setConfig(null));
  }, [refresh]);

  const adopt = (outcome: LoginOutcome) => {
    if (outcome.kind === 'done') {
      setUser(outcome.user);
      setMfaSetupRequired(outcome.mfaSetupRequired);
    }
    return outcome;
  };

  const loginPassword = useCallback(async (email: string, password: string, portal: Portal) =>
    adopt(asOutcome(await post<LoginResponse>('/auth/login', { email, password, portal }))), []);

  const loginGoogle = useCallback(async (credential: string, portal: Portal) =>
    adopt(asOutcome(await post<LoginResponse>('/auth/google', { credential, portal }))), []);

  const registerVendor = useCallback(async (input: Record<string, unknown>) =>
    adopt(asOutcome(await post<LoginResponse>('/auth/register/vendor', input))), []);

  const submitMfa = useCallback(async (challengeToken: string, code: string) => {
    const res = await post<{ user: SessionUser }>('/auth/mfa/challenge', { challengeToken, code });
    setUser(res.user);
    setMfaSetupRequired(false);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try { await post('/auth/logout'); } catch { /* clearing local state matters more */ }
    setUser(null);
    location.href = '/login';
  }, []);

  /**
   * Mirrors the server's rule exactly: owners pass everything, and holding any
   * mutating grant on a section implies being able to read it.
   */
  const can = useCallback((section: string, action: 'read' | 'create' | 'update' | 'delete' = 'read') => {
    const m = user?.membership;
    if (!m) return user?.role === 'END_USER';
    if (m.isOwner) return true;
    if (action === 'read') return m.permissions.some((p) => p.startsWith(`${section}:`));
    return m.permissions.includes(`${section}:${action}`);
  }, [user]);

  const value = useMemo(
    () => ({ user, loading, mfaSetupRequired, config, loginPassword, loginGoogle, submitMfa, registerVendor, logout, refresh, can }),
    [user, loading, mfaSetupRequired, config, loginPassword, loginGoogle, submitMfa, registerVendor, logout, refresh, can],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
