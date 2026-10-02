import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { env, googleEnabled, mailEnabled, razorpayEnabled, razorpayXEnabled, redisEnabled } from './env.js';
import { prisma } from './lib/prisma.js';
import { errorHandler, notFound } from './middleware/error.js';
import { csrfGuard } from './middleware/csrf.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { authRouter } from './routes/auth.routes.js';
import { sdkRouter } from './routes/sdk.routes.js';
import { vendorRouter } from './routes/vendor.routes.js';
import { publisherRouter } from './routes/publisher.routes.js';
import { adminRouter } from './routes/admin.routes.js';
import { teamRouter } from './routes/team.routes.js';
import { webhookRouter } from './routes/webhooks.routes.js';
import { privacyRouter } from './routes/privacy.routes.js';
import { observability } from './middleware/observability.js';
import { renderMetrics } from './lib/metrics.js';
import { captureError } from './lib/logger.js';
import { redisHealthy } from './lib/redis.js';

/**
 * Builds the Express app. Separated from process startup so tests can drive it
 * in-process without opening a port or starting the background schedulers.
 */
export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(observability);

  app.use(
    cors({
      origin(origin, cb) {
        // The extension sends a chrome-extension:// origin (or none, from the
        // service worker). Panel origins are pinned, and credentials are only
        // ever accepted from those.
        if (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('moz-extension://')) return cb(null, true);
        if (env.corsOrigins.includes(origin)) return cb(null, true);
        cb(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'x-csrf-token', 'x-adpilot-key'],
    }),
  );

  // Webhooks mount BEFORE the JSON parser: the signature covers the exact raw
  // bytes, so the body must not be reinterpreted before it is verified.
  app.use('/api/webhooks', webhookRouter);

  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  app.use('/api', globalLimiter);
  app.use(csrfGuard);

  app.use('/api/auth', authRouter);
  app.use('/api/sdk', sdkRouter);
  app.use('/api/vendor', vendorRouter);
  app.use('/api/me', publisherRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/team', teamRouter);
  app.use('/api/privacy', privacyRouter);

  app.get('/api/health', async (_req, res) => {
    try {
      const t0 = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      res.json({
        status: 'ok',
        service: 'adpilot-api',
        time: new Date().toISOString(),
        dbLatencyMs: Date.now() - t0,
        redis: redisEnabled ? (redisHealthy() ? 'connected' : 'degraded') : 'disabled',
        integrations: { google: googleEnabled, razorpay: razorpayEnabled, razorpayX: razorpayXEnabled, mail: mailEnabled },
      });
    } catch (err) {
      captureError(err, { route: '/api/health' });
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  /** Prometheus scrape target. Unauthenticated on purpose — bind it internally. */
  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.send(renderMetrics());
  });

  app.use(notFound);
  app.use(errorHandler);


  return app;
}
