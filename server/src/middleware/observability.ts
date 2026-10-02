import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { logger } from '../lib/logger.js';
import { metrics } from '../lib/metrics.js';

/**
 * One structured line per request, plus latency and status counters. The
 * request id is echoed back so a user-reported error can be found in the logs.
 */
export function observability(req: Request, res: Response, next: NextFunction) {
  const started = process.hrtime.bigint();
  const requestId = req.get('x-request-id') ?? crypto.randomUUID();
  res.setHeader('x-request-id', requestId);
  (req as Request & { id: string }).id = requestId;

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // Group by route pattern, not by URL — otherwise every id is its own metric.
    const route = `${req.baseUrl}${req.route?.path ?? ''}` || req.path.replace(/\/[0-9a-f-]{8,}/gi, '/:id');
    const labels = { method: req.method, route, status: String(res.statusCode) };

    metrics.inc('http_requests_total', labels);
    metrics.observe('http_request_duration_ms', ms, { method: req.method, route });
    if (res.statusCode >= 500) metrics.inc('http_errors_total', { route });

    const line = {
      requestId, method: req.method, path: req.path, status: res.statusCode,
      ms: Number(ms.toFixed(1)), userId: req.user?.id, role: req.user?.role,
    };
    if (res.statusCode >= 500) logger.error(line, 'request failed');
    else if (res.statusCode >= 400) logger.warn(line, 'request rejected');
    else logger.debug(line, 'request');
  });

  next();
}
