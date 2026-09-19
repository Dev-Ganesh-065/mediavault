import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssetKind, AssetSort, AssetStatus } from '@/lib/types';

/**
 * Query state (q, status, kind, sort) lives in the URL so reloading or
 * sharing a URL restores the same view.
 *
 * Discrete filter changes push a history entry (so Back does something
 * sensible); search-typed characters use replaceState so a six-character
 * query does not stack six history entries.
 */
export interface UrlQuery {
  q: string;
  status: AssetStatus[];
  kind: AssetKind[];
  sort: AssetSort;
}

const VALID_SORTS: AssetSort[] = [
  'updatedAt:desc',
  'updatedAt:asc',
  'name:asc',
  'name:desc',
  'sizeBytes:desc',
  'createdAt:desc',
];

function parse(): UrlQuery {
  const p = new URLSearchParams(window.location.search);
  const sortRaw = p.get('sort');
  return {
    q: p.get('q') ?? '',
    status: (p.get('status') ?? '').split(',').filter(Boolean) as AssetStatus[],
    kind: (p.get('kind') ?? '').split(',').filter(Boolean) as AssetKind[],
    sort: VALID_SORTS.includes(sortRaw as AssetSort) ? (sortRaw as AssetSort) : 'updatedAt:desc',
  };
}

function writeUrl(query: UrlQuery, push: boolean) {
  const p = new URLSearchParams();
  if (query.q) p.set('q', query.q);
  if (query.status.length) p.set('status', query.status.join(','));
  if (query.kind.length) p.set('kind', query.kind.join(','));
  if (query.sort !== 'updatedAt:desc') p.set('sort', query.sort);
  const qs = p.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
  if (push) window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

export function useUrlQuery() {
  const [query, setQuery] = useState<UrlQuery>(parse);
  const queryRef = useRef(query);
  queryRef.current = query;

  useEffect(() => {
    const onPop = () => {
      const next = parse();
      queryRef.current = next;
      setQuery(next);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const apply = useCallback((patch: Partial<UrlQuery>, push: boolean) => {
    const next: UrlQuery = { ...queryRef.current, ...patch };
    // Normalise: keep the empty-string q out of URLs entirely and clamp sorts.
    queryRef.current = next;
    setQuery(next);
    writeUrl(next, push);
  }, []);

  // Stable identities (useCallback + refs) so callers can use these in
  // useEffect deps without re-firing on every render.
  const setFilter = useCallback((patch: Partial<UrlQuery>) => apply(patch, true), [apply]);
  const setSearchTerm = useCallback((q: string) => apply({ q }, false), [apply]);

  return {
    query,
    /** Discrete change: status, kind, sort, clearing everything. */
    setFilter,
    /** Typed search term: replaceState, no history spam. */
    setSearchTerm,
  };
}