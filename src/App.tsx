import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, bulkSetStatus, runChunked } from '@/api/client';
import { AssetDetail } from '@/features/assets/AssetDetail';
import { BulkBar } from '@/features/assets/BulkBar';
import { VirtualGrid } from '@/features/assets/VirtualGrid';
import { useAssetList } from '@/features/assets/useAssetList';
import { useOffline } from '@/hooks/useOffline';
import { useUrlQuery } from '@/hooks/useUrlQuery';
import { statusLabel } from '@/lib/format';
import type { Asset, AssetKind, AssetSort, AssetStatus, BulkOutcome } from '@/lib/types';

const STATUSES: AssetStatus[] = ['draft', 'in_review', 'approved', 'archived'];
const KINDS: AssetKind[] = ['image', 'video', 'document'];
const SORTS: Array<{ value: AssetSort; label: string }> = [
  { value: 'updatedAt:desc', label: 'Recently updated' },
  { value: 'updatedAt:asc', label: 'Oldest first' },
  { value: 'name:asc', label: 'Name A–Z' },
  { value: 'name:desc', label: 'Name Z–A' },
  { value: 'sizeBytes:desc', label: 'Largest first' },
  { value: 'createdAt:desc', label: 'Newest' },
];

/**
 * 250 ms. Ordinary typing arrives faster than that (peaks of ~10 keystrokes
 * or more per burst), and everything after the burst is a duplicate of the
 * last keystroke's query — the API answers "name contains X", not "was this
 * the 4th or 5th character". 250 ms keeps search feeling instant and bounds
 * typing to ≤ ~4 reads/sec, well inside the 80/10s budget so pagination and
 * retries keep a reserve.
 */
const SEARCH_DEBOUNCE_MS = 250;
const CONCURRENCY = 3;
const BULK_CHUNK = 50;

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

/** Rewrite an API error into something a producer/reviewer can act on. */
function humanError(e: unknown): string {
  if (e instanceof TypeError) return 'You look offline — reconnect and we will carry on where we left off.';
  if (e instanceof ApiError) {
    switch (e.code) {
      case 'rate_limited':
        return 'The library is busy right now. Wait a few seconds, then retry.';
      case 'upstream_unavailable':
        return 'The search service is warming up — give it a second and try again.';
      case 'stale_cursor':
      case 'bad_cursor':
        return 'The results changed underneath you. Reloading the list.';
      case 'not_found':
        return 'That asset no longer exists.';
      case 'version_conflict':
        return 'Someone else changed this asset while you were looking at it.';
      case 'legal_hold':
        return 'This asset is on legal hold and cannot be archived.';
      default:
        return e.message || 'Something went wrong. Please try again.';
    }
  }
  return e instanceof Error ? e.message : 'Something went wrong. Please try again.';
}

interface BulkRun {
  phase: 'idle' | 'working' | 'done';
  outcome: BulkOutcome | null;
  target: AssetStatus | null;
  /** id -> status before the last bulk run, so rollback/undo can restore it. */
  prev: Record<string, AssetStatus>;
}
export function App() {
  const { query, setFilter, setSearchTerm } = useUrlQuery();
  const online = useOffline();

  // Search box: local input mirrors the URL; the URL only changes on the
  // debounce boundary, so every keystroke does not stack a history entry.
  const [qInput, setQInput] = useState(query.q);
  const debouncedQ = useDebounced(qInput, SEARCH_DEBOUNCE_MS);
  useEffect(() => setSearchTerm(debouncedQ), [debouncedQ, setSearchTerm]);
  useEffect(() => setQInput(query.q), [query.q]);

  const list = useAssetList(
    { q: debouncedQ, status: query.status, kind: query.kind, sort: query.sort },
    online,
  );
  const { applyItems } = list;

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [bulk, setBulk] = useState<BulkRun>({ phase: 'idle', outcome: null, target: null, prev: {} });

  // ---- announcements (live region, debounced so typing never spams) -----
  const [announced, setAnnounced] = useState('');
  const announceTimer = useRef<number | null>(null);
  const say = useCallback((msg: string) => {
    if (announceTimer.current !== null) window.clearTimeout(announceTimer.current);
    announceTimer.current = window.setTimeout(() => setAnnounced(msg), 350);
  }, []);

  // ---- selection ---------------------------------------------------------
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onSelectRange = useCallback((anchor: number, focus: number) => {
    const lo = Math.min(anchor, focus);
    const hi = Math.max(anchor, focus);
    const ids: string[] = [];
    for (let i = lo; i <= hi; i += 1) {
      const a = list.items[i];
      if (a) ids.push(a.id);
    }
    setSelectedIds(new Set(ids));
  }, [list.items]);

  const onSelectAll = useCallback(() => {
    setSelectedIds(new Set(list.items.map((a) => a.id)));
    say(`${list.items.length.toLocaleString()} assets selected.`);
  }, [list.items, say]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ---- single-asset edits (detail panel) --------------------------------
  const gridRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const openDetail = useCallback((id: string) => {
    const card = gridRef.current?.querySelector(`[data-id="${CSS.escape(id)}"]`);
    returnFocusRef.current = (card as HTMLElement | null) ?? gridRef.current;
    setActiveId(id);
  }, []);

  const closeDetail = useCallback(() => {
    setActiveId(null);
    // Return focus to the card that was open (still mounted — the panel
    // opening did not disturb the list).
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  const onOptimistic = useCallback((id: string, status: AssetStatus) => {
    applyItems((prev) => prev.map((a) => (a.id === id ? { ...a, status } : a)));
  }, [applyItems]);

  // ---- bulk actions ------------------------------------------------------
  const runBulk = useCallback(async (ids: string[], target: AssetStatus, prev: Record<string, AssetStatus>) => {
    if (ids.length === 0) return;

    // Optimistic first: the grid shows the target state before the server
    // confirms anything.
    applyItems((rows) => rows.map((a) => (ids.includes(a.id) ? { ...a, status: target } : a)));
    setBulk({ phase: 'working', outcome: null, target, prev });

    const okAssets = new Map<string, Asset>();
    const okIds: string[] = [];
    const failed: BulkOutcome['failed'] = [];

    try {
      // Chunks respect the 50-id cap; at most 3 run in parallel so a 500-row
      // selection never fires 10 parallel requests into a rate limiter.
      await runChunked(ids, BULK_CHUNK, CONCURRENCY, async (chunk) => {
        const res = await bulkSetStatus(chunk, target);
        let rows = res.results;
        const conflicts = rows.filter((r) => !r.ok && r.code === 'conflict').map((r) => r.id);
        if (conflicts.length > 0) {
          // ~7% random conflicts are retryable business failures; legal_hold
          // and not_found are not, so only this subset is ever repeated.
          const retry = await bulkSetStatus(conflicts, target);
          rows = rows.map((r) => {
            if (r.ok || r.code !== 'conflict') return r;
            const rr = retry.results.find((x) => x.id === r.id);
            return rr ?? r;
          });
        }
        for (const r of rows) {
          if (r.ok) {
            okIds.push(r.id);
            okAssets.set(r.id, r.asset);
          } else {
            failed.push({ id: r.id, code: r.code, message: r.message ?? undefined });
          }
        }
      });
    } catch (err) {
      // Whole pass failed (server unreachable / rate-limited out): rollback.
      for (const id of ids) {
        failed.push({ id, code: 'bad_request', message: humanError(err) });
      }
    }

    // Keep successes (server-confirmed rows, fresh versions), roll back only
    // the failures. Selection keeps the failures for a targeted retry.
    applyItems((rows) =>
      rows.map((a) => {
        const fresh = okAssets.get(a.id);
        if (fresh) return fresh;
        if (ids.includes(a.id)) return { ...a, status: prev[a.id] ?? a.status };
        return a;
      }),
    );

    const outcome: BulkOutcome = { okIds, failed };
    setBulk({ phase: 'done', outcome, target, prev });
    setSelectedIds(new Set(failed.map((f) => f.id)));
    if (failed.length === 0) {
      say(`${okIds.length.toLocaleString()} assets are now ${statusLabel(target)}.`);
    } else {
      say(
        `${okIds.length} updated, ${failed.length} could not change` +
        ` (${[...new Set(failed.map((f) => f.code))].join(', ')}).`,
      );
    }
  }, [applyItems, list.items, say]);

  const applyBulkStatus = useCallback((next: AssetStatus) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const prev: Record<string, AssetStatus> = {};
    for (const id of ids) {
      const a = list.items.find((x) => x.id === id);
      if (a) prev[id] = a.status;
    }
    void runBulk(ids, next, prev);
  }, [selectedIds, list.items, runBulk]);

  const retryFailed = useCallback(() => {
    const outcome = bulk.outcome;
    if (!outcome || !bulk.target) return;
    const retryIds = outcome.failed.filter((f) => f.code === 'conflict').map((f) => f.id);
    if (retryIds.length === 0) {
      say('Nothing retryable is left — legal-held assets never succeed on retry.');
      return;
    }
    const prev: Record<string, AssetStatus> = {};
    for (const id of retryIds) {
      const a = list.items.find((x) => x.id === id);
      if (a) prev[id] = a.status;
    }
    void runBulk(retryIds, bulk.target, prev);
  }, [bulk, list.items, runBulk, say]);

  const undo = useCallback(async () => {
    const prev = bulk.prev;
    if (Object.keys(prev).length === 0) return;
    const entries = Object.entries(prev);
    for (const st of STATUSES) {
      const ids = entries.filter(([, s]) => s === st).map(([id]) => id);
      if (ids.length === 0) continue;
      const current: Record<string, AssetStatus> = {};
      for (const id of ids) {
        const a = list.items.find((x) => x.id === id);
        if (a) current[id] = a.status;
      }
      await runBulk(ids, st, current);
    }
    say('Undid the change — assets are back to their previous statuses.');
  }, [bulk, list.items, runBulk, say]);

  const canRetry = bulk.outcome?.failed.some((f) => f.code === 'conflict') ?? false;
  const filtersKey = `${debouncedQ}|${query.status.join(',')}|${query.kind.join(',')}|${query.sort}`;

  // Reset scroll to the top when the query changes.
  useEffect(() => {
    gridRef.current?.scrollTo({ top: 0 });
  }, [filtersKey]);

  // Announce result counts once per query (not per keystroke — the debounce
  // plus the 350 ms live-region merge see to that).
  useEffect(() => {
    if (list.phase === 'ready') say(`${list.total.toLocaleString()} results.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.phase, list.total]);

  const onRevert = useCallback((id: string, snapshot: Asset) => {
    applyItems((prev) => prev.map((a) => (a.id === id ? snapshot : a)));
  }, [applyItems]);

  const onSaved = useCallback((updated: Asset) => {
    applyItems((prev) => prev.map((a) => (a.id === updated.id ? updated : a)));
  }, [applyItems]);
const loadingInitial = list.phase === 'loading' && list.items.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden="true">◈</span>
          <h1>MediaVault</h1>
        </div>
        <input
          className="search"
          type="search"
          placeholder="Search name or tag"
          aria-label="Search assets"
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
        />
        <label className="visually-hidden" htmlFor="sort">Sort results</label>
        <select
          id="sort"
          className="sort"
          value={query.sort}
          aria-label="Sort results"
          onChange={(e) => setFilter({ sort: e.target.value as AssetSort })}
        >
          {SORTS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </header>

      {!online && (
        <div className="banner banner--offline" role="status">
          You&rsquo;re offline. Browsing is paused here; as soon as you reconnect, we&rsquo;ll
          pick up where you left off.
        </div>
      )}

      <div className="filters" aria-label="Filters">
        <fieldset className="filters__group">
          <legend>Status</legend>
          {STATUSES.map((s) => (
            <label key={s} className="check">
              <input
                type="checkbox"
                checked={query.status.includes(s)}
                onChange={(e) =>
                  setFilter({
                    status: e.target.checked
                      ? [...query.status, s]
                      : query.status.filter((x) => x !== s),
                  })
                }
              />
              {statusLabel(s)}
            </label>
          ))}
        </fieldset>

        <fieldset className="filters__group">
          <legend>Kind</legend>
          {KINDS.map((k) => (
            <label key={k} className="check">
              <input
                type="checkbox"
                checked={query.kind.includes(k)}
                onChange={(e) =>
                  setFilter({
                    kind: e.target.checked
                      ? [...query.kind, k]
                      : query.kind.filter((x) => x !== k),
                  })
                }
              />
              {k}
            </label>
          ))}
        </fieldset>

        <span className="filters__count" role="status">
          {list.phase === 'loading'
            ? 'Loading…'
            : `${list.items.length.toLocaleString()} of ${list.total.toLocaleString()}`}
        </span>

        {(query.q || query.status.length > 0 || query.kind.length > 0) && (
          <button className="btn btn--ghost" onClick={() => setFilter({ q: '', status: [], kind: [] })}>
            Clear filters
          </button>
        )}
      </div>

      <BulkBar
        selectedCount={selectedIds.size}
        loadedCount={list.items.length}
        working={bulk.phase === 'working'}
        outcome={bulk.outcome}
        target={bulk.target}
        canRetry={canRetry}
        onApplyStatus={applyBulkStatus}
        onRetryFailed={retryFailed}
        onUndo={undo}
        onSelectAllLoaded={onSelectAll}
        onClear={clearSelection}
      />

<main className="content">
        <section className="gridwrap">
          {list.phase === 'error' && (
            <div className="state state--error" role="alert">
              <h2>We couldn&rsquo;t load the library</h2>
              <p>{humanError(list.error)}</p>
              <button className="btn btn--primary" onClick={list.retry}>Try again</button>
            </div>
          )}

          {list.phase === 'offline' && list.items.length === 0 && (
            <div className="state state--offline" role="status">
              <h2>You&rsquo;re offline</h2>
              <p>Reconnect to keep browsing the library.</p>
            </div>
          )}

          {loadingInitial && (
            <div className="grid grid--skeleton" aria-hidden="true">
              {Array.from({ length: 12 }, (_, i) => (
                <div className="card card--skeleton" key={i}>
                  <span className="card__thumb" />
                  <span className="sk" style={{ width: '60%' }} />
                  <span className="sk" style={{ width: '90%' }} />
                </div>
              ))}
            </div>
          )}

          {list.phase === 'ready' && list.items.length === 0 && (
            <div className="state state--empty">
              <h2>No assets match these filters</h2>
              <p>Try a different search term, or clear the status and kind filters.</p>
              {(query.q || query.status.length > 0 || query.kind.length > 0) && (
                <button className="btn" onClick={() => setFilter({ q: '', status: [], kind: [] })}>
                  Clear filters
                </button>
              )}
            </div>
          )}

          {list.items.length > 0 && (
            <>
              {list.error && list.phase === 'ready' && (
                <div className="banner banner--error" role="alert">
                  <span>{humanError(list.error)}</span>
                  <button className="btn" onClick={list.retry}>Retry</button>
                </div>
              )}
              <VirtualGrid
                key={filtersKey}
                items={list.items}
                total={list.total}
                selectedIds={selectedIds}
                activeId={activeId}
                hasMore={list.hasMore}
                loadingMore={list.loadingMore}
                onToggleSelect={toggleSelect}
                onSelectRange={onSelectRange}
                onSelectAll={onSelectAll}
                onOpen={openDetail}
                onLoadMore={list.loadMore}
                containerRefOut={gridRef}
              />
            </>
          )}
        </section>

        {activeId && (
          <AssetDetail
            id={activeId}
            onSaved={onSaved}
            onOptimistic={onOptimistic}
            onRevert={onRevert}
            onClose={closeDetail}
          />
        )}
      </main>

      <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {announced}
      </div>
    </div>
  );
}