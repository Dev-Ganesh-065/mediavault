import { useCallback, useMemo, useRef } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { InfiniteData } from '@tanstack/react-query';
import { ApiError, CancelledError, listAssets } from '@/api/client';
import type { Asset, AssetKind, AssetPage, AssetSort, AssetStatus } from '@/lib/types';

/**
 * Owns everything about "what rows are on screen right now".
 *
 * The fetching, caching and cancellation mechanics are TanStack Query's
 * (`useInfiniteQuery`, the idiomatic shape for cursor pagination):
 *
 *   - the cache key *is* the filter set, so changing a filter starts a new
 *     entry, and returning to a previous filter renders straight from cache
 *     while a fresh copy is fetched in the background;
 *   - a response can only land in the entry it was requested for, so a slow
 *     reply for an abandoned query cannot overwrite newer results — the race
 *     is structurally impossible, not merely guarded against;
 *   - `signal` from the query context cancels the in-flight request when the
 *     key changes or the observer unmounts;
 *   - identical concurrent reads collapse into a single request;
 *   - `hasNextPage` / `fetchNextPage` replace the hand-rolled cursor state,
 *     and `refetchOnReconnect` replaces the manual reconnect refetch.
 *
 * What remains here is the app's own policy: translating filters into an API
 * query, deciding what phase the UI is in, swallowing `stale_cursor` so a user
 * never sees it, and exposing `applyItems` so optimistic edits from bulk and
 * single actions can patch the cache without the fetching machinery and the
 * mutation machinery fighting over the same array.
 */

export type ListPhase = 'loading' | 'ready' | 'error' | 'offline';

export interface AssetFilters {
  q: string;
  status: AssetStatus[];
  kind: AssetKind[];
  sort: AssetSort;
}

const PAGE_SIZE = 24;

/** A page cursor; `null` is "the first page". */
type Cursor = string | null;
type ListKey = readonly ['assets', AssetFilters];
type ListData = InfiniteData<AssetPage, Cursor>;

/** Stable identity, so a cache miss does not hand out a new array each render. */
const NO_ITEMS: Asset[] = [];

function filtersToQuery(f: AssetFilters) {
  return {
    q: f.q,
    status: f.status.length ? f.status : undefined,
    kind: f.kind.length ? f.kind : undefined,
    sort: f.sort,
    limit: PAGE_SIZE,
  };
}

export function useAssetList(filters: AssetFilters, online: boolean) {
  const queryClient = useQueryClient();
  const queryKey: ListKey = ['assets', filters];

  // Naming the current key in a ref keeps `applyItems` identity-stable (it is
  // passed down to memoised cards and into useCallback deps) while still
  // always writing to the query the user is actually looking at.
  const keyRef = useRef<ListKey>(queryKey);
  keyRef.current = queryKey;

  const query = useInfiniteQuery({
    queryKey,
    // Offline is a pause, not an error: no request is issued here, and
    // enabling the query again on reconnect starts it for real.
    enabled: online,
    initialPageParam: null as Cursor,
    // Read the filters back out of the key, so a request can only ever be for
    // the same thing its response will be cached under.
    queryFn: ({ queryKey: key, pageParam, signal }) => {
      const [, active] = key as unknown as ListKey;
      return listAssets({ ...filtersToQuery(active), cursor: pageParam ?? undefined }, signal);
    },
    // A `null` cursor from the API means "there are no more pages".
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const pages = query.data?.pages;

  const items = useMemo(() => {
    if (!pages || pages.length === 0) return NO_ITEMS;
    if (pages.length === 1) return pages[0]?.items ?? NO_ITEMS;
    // Defensive de-duplication across pages: a cursor race must never put the
    // same asset in the list twice (duplicate React keys, double-counted
    // selection, a bulk action hitting one id twice).
    const seen = new Set<string>();
    const out: Asset[] = [];
    for (const page of pages) {
      for (const asset of page.items) {
        if (seen.has(asset.id)) continue;
        seen.add(asset.id);
        out.push(asset);
      }
    }
    return out;
  }, [pages]);

  // Data present but an incremental page failed => still "ready" (the banner
  // offers a retry). No data at all and an error => the first page failed.
  const phase: ListPhase = !online
    ? 'offline'
    : query.data
      ? 'ready'
      : query.status === 'pending'
        ? 'loading'
        : query.error instanceof TypeError
          ? 'offline'
          : 'error';

  const loadMore = useCallback(() => {
    if (!online || query.isFetching || !query.hasNextPage) return;
    const requestedKey = keyRef.current;
    void query.fetchNextPage({ throwOnError: true, cancelRefetch: false }).catch((err: unknown) => {
      if (err instanceof CancelledError) return;
      if (err instanceof ApiError && (err.code === 'stale_cursor' || err.code === 'bad_cursor')) {
        // The cursor was bound to a query that has since changed. That is our
        // bookkeeping problem, never the user's: drop the accumulated pages
        // and start again from page one.
        void queryClient.resetQueries({ queryKey: requestedKey, exact: true });
      }
      // Any other failure stays on the query as `error`, so the banner shows it
      // and `retry()` can ask for that page again.
    });
  }, [online, query, queryClient]);

  const retry = useCallback(() => {
    if (!online) return;
    if (query.data && query.hasNextPage) {
      loadMore(); // a "couldn't load more" failure
      return;
    }
    // Page one never arrived, or the cache was reset: start over.
    void queryClient.resetQueries({ queryKey: keyRef.current });
  }, [online, query.data, query.hasNextPage, loadMore, queryClient]);

  /**
   * Patch the cached rows in place — the one door optimistic updates come
   * through. Every caller maps or filters rows without changing their count,
   * so the rows go back into the same page shapes they came from.
   */
  const applyItems = useCallback(
    (updater: (rows: Asset[]) => Asset[]) => {
      queryClient.setQueryData<ListData>(keyRef.current, (prev) => {
        if (!prev) return prev;
        const rows = updater(prev.pages.flatMap((page) => page.items));
        let offset = 0;
        const nextPages = prev.pages.map((page) => {
          const slice = rows.slice(offset, offset + page.items.length);
          offset += page.items.length;
          return { ...page, items: slice };
        });
        return { ...prev, pages: nextPages };
      });
    },
    [queryClient],
  );

  return {
    items,
    total: pages?.[0]?.total ?? 0,
    phase,
    loadingMore: query.isFetchingNextPage,
    error: query.error,
    hasMore: query.hasNextPage,
    loadMore,
    retry,
    applyItems,
  };
}