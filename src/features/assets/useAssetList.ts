import { useEffect, useRef, useState } from 'react';
import { ApiError, CancelledError, listAssets } from '@/api/client';
import type { Asset, AssetKind, AssetSort, AssetStatus } from '@/lib/types';

/**
 * Owns everything about "what rows are on screen right now":
 *   - fetches the first page for the current filters
 *   - keeps loading more pages for infinite scroll
 *   - cancels in-flight requests the moment filters change, and rejects
 *     responses from earlier queries (belt and braces — both matter)
 *   - never surfaces `stale_cursor` to a user: a cursor mismatch is
 *     detected and transparently restarts from page one
 *   - pauses wholly while offline and refetches on reconnect
 *
 * Optimistic edits from bulk/single actions reach the grid through
 * `applyItems`, so the fetching machinery and the mutation machinery
 * never fight over the same array.
 */

export type ListPhase = 'loading' | 'ready' | 'error' | 'offline';

export interface AssetFilters {
  q: string;
  status: AssetStatus[];
  kind: AssetKind[];
  sort: AssetSort;
}

export interface AssetListState {
  items: Asset[];
  total: number;
  nextCursor: string | null;
  phase: ListPhase;
  loadingMore: boolean;
  error: ApiError | Error | null;
  hasMore: boolean;
}

const PAGE_SIZE = 24;
const NOT_MODIFIABLE = new Set(['loading', 'error', 'offline']);

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
  const [items, setItems] = useState<Asset[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<ListPhase>('loading');
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [run, setRun] = useState(0);

  const seqRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  /** Fetch page one for the current filters. Safe to call repeatedly. */
  function fetchFirstPage() {
    const seq = ++seqRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setPhase(online ? 'loading' : 'offline');
    setError(null);
    setLoadingMore(false);

    listAssets({ ...filtersToQuery(filtersRef.current) }, controller.signal)
      .then((page) => {
        if (seq !== seqRef.current) return;
        setItems(page.items);
        setTotal(page.total);
        setNextCursor(page.nextCursor);
        setPhase('ready');
      })
      .catch((err: unknown) => {
        if (err instanceof CancelledError) return;
        if (seq !== seqRef.current) return;
        const e = err instanceof ApiError || err instanceof Error ? err : new Error('Something went wrong');
        setError(e);
        setPhase(err instanceof TypeError ? 'offline' : 'error');
        setItems([]);
        setTotal(0);
        setNextCursor(null);
      });
  }

  const filtersKey = `${filters.q}\u0000${filters.status.join(',')}\u0000${filters.kind.join(',')}\u0000${filters.sort}`;
  useEffect(() => {
    if (!online) {
      setPhase('offline');
      return () => controllerRef.current?.abort();
    }
    fetchFirstPage();
    return () => controllerRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey, online, run]);

  function loadMore() {
    if (!online || loadingMore || !nextCursor || NOT_MODIFIABLE.has(phase)) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    setError(null);
    const controller = new AbortController();
    listAssets(
      { ...filtersToQuery(filtersRef.current), cursor: nextCursor },
      controller.signal,
    )
      .then((page) => {
        if (seq !== seqRef.current) return;
        if (page.items.length === 0) {
          setNextCursor(null);
        } else {
          // De-duplicate defensively (a response could race a reset).
          const known = new Set(items.map((a) => a.id));
          const fresh = page.items.filter((a) => !known.has(a.id));
          setItems((prev) => prev.concat(fresh));
          setTotal(page.total);
          setNextCursor(page.nextCursor);
        }
        setLoadingMore(false);
      })
      .catch((err: unknown) => {
        if (err instanceof CancelledError) return;
        if (seq !== seqRef.current) return;
        setLoadingMore(false);
        if (err instanceof ApiError && (err.code === 'stale_cursor' || err.code === 'bad_cursor')) {
          // Cursor bound to an older query — a user must never see this.
          fetchFirstPage();
          return;
        }
        const e = err instanceof ApiError || err instanceof Error ? err : new Error('Something went wrong');
        setError(e);
        if (err instanceof TypeError) setPhase('offline');
      });
  }

  function retry() {
    if (phase === 'offline') return;
    if (phase === 'error') {
      setRun((r) => r + 1); // refetch page one
    } else {
      loadMore(); // a "couldn't load more" error
    }
  }

  return {
    items,
    total,
    nextCursor,
    phase,
    loadingMore,
    error,
    hasMore: nextCursor !== null,
    loadMore,
    retry,
    applyItems: setItems,
    setError,
  };
}