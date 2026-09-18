import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, CancelledError, getAsset, thumbnailUrl, updateAsset } from '@/api/client';
import { formatBytes, formatDate, formatDuration, statusLabel } from '@/lib/format';
import type { Asset, AssetStatus } from '@/lib/types';
import { StatusPill } from './StatusPill';

const STATUSES: AssetStatus[] = ['draft', 'in_review', 'approved', 'archived'];

export interface AssetDetailProps {
  id: string;
  /** Keep the grid row in sync after the server confirms a change. */
  onSaved: (asset: Asset) => void;
  /** Apply an optimistic status to the grid row while saving. */
  onOptimistic: (id: string, status: AssetStatus) => void;
  /** Roll a grid row back to a known snapshot (conflict / failure). */
  onRevert: (id: string, snapshot: Asset) => void;
  onClose: () => void;
}

/**
 * Detail panel.
 *
 * Focus: opening moves focus into the panel, Escape closes, closing returns
 * focus to the card that was open (App handles the return).
 *
 * Saves are optimistic in the grid; the panel keeps its own copy until the
 * server confirms. A 409 version_conflict rolls the row back, refetches the
 * current version and explains — we deliberately do not silently overwrite
 * someone else's edit, and we do not ask the user to re-type anything: one
 * click re-applies the same status against the fresh version.
 */
export function AssetDetail({ id, onSaved, onOptimistic, onRevert, onClose }: AssetDetailProps) {
  const queryClient = useQueryClient();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /**
   * The panel reads from the cache rather than keeping a copy of its own: one
   * cache entry per asset, so re-opening a panel you just looked at renders
   * instantly, and the row the grid shows and the row the panel shows cannot
   * disagree.
   */
  const assetQuery = useQuery({
    queryKey: ['asset', id],
    queryFn: ({ signal }) => getAsset(id, signal),
  });

  const asset = assetQuery.data ?? null;
  const loadError = assetQuery.error
    ? assetQuery.error instanceof Error
      ? assetQuery.error.message
      : 'Could not load this asset.'
    : null;

  /**
   * Saving is a *mutation*: it never runs on mount, caches no response of its
   * own, and exists to produce a server-confirmed asset which we then write
   * into the cache — the grid row first, then the list is invalidated so that
   * a row which no longer matches the active filter disappears in the
   * background.
   *
   * `mutateAsync` rather than `mutate`, because a 409 has to be told apart
   * from every other failure and handled on the spot; `mutate`'s callbacks
   * only fire for the last call.
   */
  const saveMutation = useMutation({
    mutationFn: (patch: { id: string; version: number; status: AssetStatus }) =>
      updateAsset(patch.id, patch.version, { status: patch.status }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['asset', updated.id], updated);
      onSaved(updated);
      void queryClient.invalidateQueries({ queryKey: ['assets'] });
    },
  });

  const saving = saveMutation.isPending;

  // Focus moves into the panel when it opens.
  useEffect(() => {
    const t = window.setTimeout(() => closeRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  // The panel is kept mounted while the active asset changes (clicking another
  // card with the drawer open swaps `id` in place), so its per-asset UI state
  // must not carry over: a save error or conflict banner raised for the
  // previous asset would otherwise stay stuck over the new one.
  useEffect(() => {
    setSaveError(null);
    setConflict(false);
  }, [id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  async function setStatus(next: AssetStatus) {
    const current = assetQuery.data;
    if (!current || saving) return;
    // `current` from this render is the snapshot to roll back to: the cache
    // still holds it, and the grid row can be restored from it verbatim.
    const snapshot = current;
    setSaveError(null);
    setConflict(false);
    // Optimistic: the grid shows the target state before the server confirms.
    onOptimistic(current.id, next);

    try {
      await saveMutation.mutateAsync({ id: current.id, version: current.version, status: next });
    } catch (err) {
      if (err instanceof CancelledError) return;
      if (err instanceof ApiError && err.status === 409) {
        // Someone else changed the row. Roll back our optimistic edit and
        // show the current truth instead of papering over it.
        onRevert(current.id, snapshot);
        setConflict(true);
        setSaveError('Someone else changed this asset while you were editing it.');
        void assetQuery.refetch(); // pull the version they saved
        return;
      }
      onRevert(current.id, snapshot);
      setSaveError(err instanceof Error ? err.message : 'The change did not save. Try again.');
    }
  }

  return (
    <aside
      ref={panelRef}
      className="panel"
      aria-label={`Details for ${asset?.name ?? 'asset'}`}
      role="complementary"
    >
      <div className="panel__head">
        <h2>Asset detail</h2>
        <button
          ref={closeRef}
          className="btn btn--ghost"
          onClick={onClose}
          aria-label="Close details and return to the grid"
        >
          Close ✕
        </button>
      </div>

      {loadError && (
        <div className="alert alert--error" role="alert">
          <p>{loadError}</p>
          <button className="btn" onClick={() => void assetQuery.refetch()}>
            Try again
          </button>
        </div>
      )}

      {conflict && (
        <div className="alert alert--warn" role="alert">
          <p>
            <strong>Heads up:</strong> this asset was edited by someone else while you were
            working. We&apos;ve reverted your change and loaded the latest version.
          </p>
        </div>
      )}

      {saveError && !conflict && (
        <div className="alert alert--error" role="alert">
          <p>{saveError}</p>
        </div>
      )}

      {!asset && !loadError && (
        <div className="panel__loading" role="status">
          <span className="spinner" aria-hidden="true" /> Loading…
        </div>
      )}

      {asset && (
        <div className="panel__body">
          <img className="panel__thumb" src={thumbnailUrl(asset.id)} alt="" loading="lazy" />
          <div className="panel__headline">
            <h3>{asset.name}</h3>
            <StatusPill status={asset.status} />
          </div>

          <dl className="facts">
            <dt>Id</dt><dd>{asset.id}</dd>
            <dt>Kind</dt><dd>{asset.kind}</dd>
            <dt>Size</dt><dd>{formatBytes(asset.sizeBytes)}</dd>
            {asset.width ? (
              <>
                <dt>Dimensions</dt><dd>{asset.width}×{asset.height}</dd>
              </>
            ) : null}
            {asset.durationSec ? (
              <>
                <dt>Duration</dt><dd>{formatDuration(asset.durationSec)}</dd>
              </>
            ) : null}
            <dt>Owner</dt><dd>{asset.owner.name}</dd>
            <dt>Updated</dt><dd>{formatDate(asset.updatedAt)}</dd>
            <dt>Version</dt><dd>{asset.version}</dd>
          </dl>

          {asset.tags.length > 0 && (
            <ul className="tags" aria-label="Tags">
              {asset.tags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>
          )}

          <fieldset className="statuspicker" disabled={saving}>
            <legend>Move to status</legend>
            <div className="row" role="radiogroup" aria-label="Asset status">
              {STATUSES.map((status) => {
                const chosen = status === asset.status;
                return (
                  <button
                    key={status}
                    className={`btn statusoption${chosen ? ' statusoption--active' : ''}`}
                    aria-pressed={chosen}
                    disabled={saving || chosen}
                    onClick={() => void setStatus(status)}
                  >
                    {statusLabel(status)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          {saving && (
            <p className="muted" role="status">
              Saving…
            </p>
          )}
        </div>
      )}
    </aside>
  );
}