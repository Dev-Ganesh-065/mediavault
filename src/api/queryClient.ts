import { QueryClient } from '@tanstack/react-query';

/**
 * The one cache for the app.
 *
 * Only *reads* live here (`useQuery` / `useInfiniteQuery`): each query key gets
 * one cache entry, identical concurrent reads collapse into a single request,
 * and a repeat of a key you have already seen renders from cache while a fresh
 * copy is fetched in the background. Writes go through `useMutation` and then
 * either patch this cache directly (the server-confirmed row, optimistic
 * edits) or invalidate it, which is what prompts the background refetch.
 *
 * Retry is deliberately **off** at this layer. `src/api/client.ts` already
 * retries with exponential backoff and full jitter, and it is the layer that
 * understands `Retry-After` and which failures the API contract marks as safe
 * to repeat. Letting TanStack Query retry as well would multiply the request
 * count against an API that allows 80 requests per rolling 10s — and retries
 * count towards that budget, so a second retry loop makes things worse.
 *
 * `refetchOnWindowFocus` is off for the same reason (this is a browsing
 * session, not a dashboard); `refetchOnReconnect` stays on, because coming
 * back from offline is exactly when what is on screen is most likely stale.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: 0,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
});
