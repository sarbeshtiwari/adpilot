import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { get } from './api';

/** The browser's timezone, appended to reporting calls so day buckets match. */
export const viewerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const withTimeZone = (path: string) =>
  /[?&]days=|\/reports|\/overview/.test(path) && !path.includes('tz=')
    ? `${path}${path.includes('?') ? '&' : '?'}tz=${encodeURIComponent(viewerTimeZone)}`
    : path;

/** Thin wrapper so pages read as `const { data } = useApi<T>('/admin/overview')`. */
export function useApi<T>(path: string | null, opts: { refetchMs?: number } = {}) {
  return useQuery<T>({
    queryKey: [path],
    queryFn: () => get<T>(withTimeZone(path!)),
    enabled: path !== null,
    refetchInterval: opts.refetchMs,
  });
}

/** Invalidates every cached path that starts with one of `prefixes`. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...prefixes: string[]) =>
    qc.invalidateQueries({
      predicate: (q) => {
        const key = String(q.queryKey[0] ?? '');
        return prefixes.some((p) => key.startsWith(p));
      },
    });
}

export { useMutation };
