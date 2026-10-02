import { prisma } from './prisma.js';

export async function audit(input: {
  actorId?: string | null;
  actorRole?: string;
  action: string;
  entity?: string;
  entityId?: string;
  meta?: unknown;
  ip?: string;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        actorRole: input.actorRole ?? 'SYSTEM',
        action: input.action,
        entity: input.entity ?? '',
        entityId: input.entityId ?? '',
        meta: input.meta ? JSON.stringify(input.meta) : '',
        ip: input.ip ?? '',
      },
    });
  } catch {
    // Auditing must never break the request it is recording.
  }
}
