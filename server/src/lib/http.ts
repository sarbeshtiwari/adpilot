import type { NextFunction, Request, Response } from 'express';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code = 'error', public details?: unknown) {
    super(message);
  }
  static badRequest(m: string, d?: unknown) { return new ApiError(400, m, 'bad_request', d); }
  static unauthorized(m = 'Not authenticated') { return new ApiError(401, m, 'unauthorized'); }
  static forbidden(m = 'Not allowed') { return new ApiError(403, m, 'forbidden'); }
  static notFound(m = 'Not found') { return new ApiError(404, m, 'not_found'); }
  static conflict(m: string) { return new ApiError(409, m, 'conflict'); }
  static payment(m: string) { return new ApiError(402, m, 'payment_required'); }
}

type Handler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;
export const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) =>
  fn(req, res, next).catch(next);

/** Pagination helper shared by every list endpoint. */
export function paging(req: Request, defaultTake = 25) {
  const take = Math.min(Number(req.query.limit ?? defaultTake) || defaultTake, 200);
  const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
  return { take, skip: (page - 1) * take, page };
}
