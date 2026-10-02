/**
 * Prometheus-format metrics. Deliberately dependency-free: a handful of
 * counters and gauges is all an ad server needs to page on.
 */
const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();

const labelKey = (name: string, labels: Record<string, string> = {}) => {
  const parts = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}="${v}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
};

export const metrics = {
  inc(name: string, labels: Record<string, string> = {}, by = 1) {
    const key = labelKey(name, labels);
    counters.set(key, (counters.get(key) ?? 0) + by);
  },
  observe(name: string, ms: number, labels: Record<string, string> = {}) {
    const key = labelKey(name, labels);
    const arr = histograms.get(key) ?? [];
    arr.push(ms);
    // Bounded so a busy process cannot grow this without limit.
    if (arr.length > 2000) arr.splice(0, arr.length - 2000);
    histograms.set(key, arr);
  },
};

const quantile = (sorted: number[], q: number) =>
  sorted.length ? sorted[Math.min(Math.floor(sorted.length * q), sorted.length - 1)] : 0;

export function renderMetrics(): string {
  const lines: string[] = [];
  for (const [key, value] of counters) lines.push(`adpilot_${key} ${value}`);
  for (const [key, values] of histograms) {
    const sorted = [...values].sort((a, b) => a - b);
    const name = key.includes('{') ? key.slice(0, key.indexOf('{')) : key;
    const labels = key.includes('{') ? key.slice(key.indexOf('{') + 1, -1) : '';
    const withQ = (q: string) => (labels ? `{${labels},quantile="${q}"}` : `{quantile="${q}"}`);
    lines.push(`adpilot_${name}${withQ('0.5')} ${quantile(sorted, 0.5).toFixed(1)}`);
    lines.push(`adpilot_${name}${withQ('0.95')} ${quantile(sorted, 0.95).toFixed(1)}`);
    lines.push(`adpilot_${name}${withQ('0.99')} ${quantile(sorted, 0.99).toFixed(1)}`);
    lines.push(`adpilot_${name}_count${labels ? `{${labels}}` : ''} ${values.length}`);
  }
  const mem = process.memoryUsage();
  lines.push(`adpilot_process_resident_bytes ${mem.rss}`);
  lines.push(`adpilot_process_heap_used_bytes ${mem.heapUsed}`);
  lines.push(`adpilot_process_uptime_seconds ${Math.floor(process.uptime())}`);
  return lines.join('\n') + '\n';
}
