import { PrismaClient } from '@prisma/client';

// BigInt does not survive JSON.stringify by default; money leaves the API as a
// decimal string and the panel re-parses it. Patched once, globally.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
});
