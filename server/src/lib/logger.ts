/**
 * Structured logging. JSON in production so it can be shipped and queried;
 * human-readable in development. Secrets are redacted centrally rather than
 * relying on every call site to remember.
 */
import pino from 'pino';
import { env } from '../env.js';

export const logger = pino({
  level: env.logLevel,
  redact: {
    paths: [
      'req.headers.cookie', 'req.headers.authorization', 'req.headers["x-adpilot-key"]',
      'password', 'passwordHash', 'token', 'credential', 'secret',
      '*.password', '*.token', '*.secret', '*.totpSecret', '*.payoutDetails',
    ],
    censor: '[redacted]',
  },
  base: { service: 'adpilot-api', env: env.nodeEnv },
  ...(env.isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname,service,env' } } }),
});

/**
 * Hook for an error reporter (Sentry and friends all accept this shape).
 * Left as a seam so adding one is a single file change.
 */
export function captureError(err: unknown, context: Record<string, unknown> = {}) {
  const e = err instanceof Error ? err : new Error(String(err));
  logger.error({ err: e, ...context }, e.message);
  if (env.errorDsn) {
    // Wire your reporter here; the DSN being set is the switch.
    // e.g. Sentry.captureException(e, { extra: context })
  }
}

export const childLogger = (bindings: Record<string, unknown>) => logger.child(bindings);
