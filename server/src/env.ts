import 'dotenv/config';

function req(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var ${key}`);
  return v;
}
const bool = (key: string, fallback = 'false') => req(key, fallback) === 'true';

const nodeEnv = req('NODE_ENV', 'development');
const isProd = nodeEnv === 'production';

export const env = {
  nodeEnv,
  isProd,
  port: Number(req('PORT', '4000')),

  sessionSecret: req('SESSION_SECRET', 'dev-session-secret-change-me'),
  impressionSecret: req('IMPRESSION_SECRET', 'dev-impression-secret-change-me'),
  sessionTtlHours: Number(req('SESSION_TTL_HOURS', '12')),
  cookieDomain: req('COOKIE_DOMAIN', '') || undefined,

  corsOrigins: req('CORS_ORIGINS', 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean),

  googleClientId: req('GOOGLE_CLIENT_ID', ''),
  googleHostedDomain: req('GOOGLE_HOSTED_DOMAIN', '') || undefined,
  devAllowPasswordLogin: bool('DEV_ALLOW_PASSWORD_LOGIN', 'false'),
  /// Test-only: lets a suite make many sign-in attempts without tripping the
  /// limiter. Refused in production, and the limiter is tested directly instead.
  rateLimitDisabled: bool('RATE_LIMIT_DISABLED', 'false'),

  razorpay: {
    apiBase: req('RAZORPAY_API_BASE', 'https://api.razorpay.com/v1'),
    keyId: req('RAZORPAY_KEY_ID', ''),
    keySecret: req('RAZORPAY_KEY_SECRET', ''),
    webhookSecret: req('RAZORPAY_WEBHOOK_SECRET', ''),
    currency: req('RAZORPAY_CURRENCY', 'INR'),
    usdRate: Number(req('USD_TO_CURRENCY_RATE', '88.5')),
  },
  razorpayX: {
    accountNumber: req('RAZORPAYX_ACCOUNT_NUMBER', ''),
    keyId: req('RAZORPAYX_KEY_ID', ''),
    keySecret: req('RAZORPAYX_KEY_SECRET', ''),
  },

  redisUrl: req('REDIS_URL', '') || undefined,
  logLevel: req('LOG_LEVEL', 'info'),
  errorDsn: req('ERROR_DSN', '') || undefined,
  panelUrl: req('PANEL_URL', 'http://localhost:5173'),
  platformTimezone: req('PLATFORM_TIMEZONE', 'UTC'),
  privacyPolicyVersion: req('PRIVACY_POLICY_VERSION', '1'),
  safeBrowsingKey: req('SAFE_BROWSING_API_KEY', '') || undefined,

  mail: {
    host: req('SMTP_HOST', ''),
    port: Number(req('SMTP_PORT', '587')),
    user: req('SMTP_USER', ''),
    password: req('SMTP_PASSWORD', ''),
    secure: req('SMTP_SECURE', 'false') === 'true',
    from: req('MAIL_FROM', 'AdPilot <no-reply@adpilot.io>'),
  },

  billing: {
    invoicePrefix: req('INVOICE_PREFIX', 'ADP'),
    taxLabel: req('TAX_LABEL', 'Tax'),
    taxRateBps: Number(req('TAX_RATE_BPS', '0')),
    legalName: req('PLATFORM_LEGAL_NAME', 'AdPilot'),
    taxId: req('PLATFORM_TAX_ID', ''),
    address: req('PLATFORM_ADDRESS', ''),
  },

  defaultRevShareBps: Number(req('DEFAULT_REV_SHARE_BPS', '6000')),
  geoProvider: req('GEO_PROVIDER', 'local'),
  geoApiUrl: req('GEO_API_URL', ''),
};

export const googleEnabled = Boolean(env.googleClientId);
export const razorpayEnabled = Boolean(env.razorpay.keyId && env.razorpay.keySecret);
export const redisEnabled = Boolean(process.env.REDIS_URL);
export const mailEnabled = Boolean(process.env.SMTP_HOST);
export const razorpayXEnabled = Boolean(env.razorpayX.keyId && env.razorpayX.keySecret && env.razorpayX.accountNumber);

if (isProd) {
  const weak = Object.entries({
    SESSION_SECRET: env.sessionSecret,
    IMPRESSION_SECRET: env.impressionSecret,
  }).filter(([, v]) => v.startsWith('dev-'));
  if (weak.length) throw new Error(`${weak.map(([k]) => k).join(', ')} still hold development defaults — set real secrets.`);

  // The password escape hatch exists so the stack is demoable without Google
  // credentials. It must never survive into production.
  if (env.devAllowPasswordLogin) {
    throw new Error('DEV_ALLOW_PASSWORD_LOGIN must be false in production — end users sign in with Google only.');
  }
  if (!googleEnabled) throw new Error('GOOGLE_CLIENT_ID is required in production.');

  // A mock gateway must never be able to credit a real wallet.
  if (!env.razorpay.apiBase.startsWith('https://api.razorpay.com')) {
    throw new Error(`RAZORPAY_API_BASE must point at the real gateway in production (got ${env.razorpay.apiBase}).`);
  }
  // Without shared state, rate limits multiply per instance and scheduled jobs
  // race each other — both of which cost real money here.
  if (!env.redisUrl) throw new Error('REDIS_URL is required in production so limits and scheduled jobs are shared across instances.');
  if (!env.mail.host) throw new Error('SMTP_HOST is required in production — password resets and invites depend on it.');
  if (env.rateLimitDisabled) throw new Error('RATE_LIMIT_DISABLED must never be set in production.');
}
