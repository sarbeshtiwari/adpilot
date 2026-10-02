/** 1 USD == 1_000_000 micros. All money crosses the wire as a micro string. */
export const MICROS_PER_USD = 1_000_000n;

export function usdToMicros(usd: number | string): bigint {
  const n = typeof usd === 'string' ? Number(usd) : usd;
  if (!Number.isFinite(n)) throw new Error(`Invalid USD amount: ${usd}`);
  return BigInt(Math.round(n * 1_000_000));
}

export function microsToUsd(micros: bigint | number | string): number {
  return Number(BigInt(micros)) / 1_000_000;
}

export function formatUsd(micros: bigint | number | string): string {
  return `$${microsToUsd(micros).toFixed(4)}`;
}

/** Split `gross` by basis points, giving the remainder to the platform. */
export function splitRevenue(gross: bigint, publisherShareBps: number) {
  const publisher = (gross * BigInt(publisherShareBps)) / 10_000n;
  return { publisherMicros: publisher, platformMicros: gross - publisher };
}

export const sum = (xs: (bigint | null | undefined)[]) =>
  xs.reduce<bigint>((a, b) => a + (b ?? 0n), 0n);
