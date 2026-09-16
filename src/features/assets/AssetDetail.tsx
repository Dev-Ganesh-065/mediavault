import { useEffect, useRef, useState } from 'react';
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
  const [asset, setAsset] = useState<Asset | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const assetRef = useRef<Asset | null>(null);
  assetRef.current = asset;

  useEffect(() => {
    const controller = new AbortController();
    setAsset(null);
    setLoadError(null);
    setSaveError(null);
    setConflict(false);
    getAsset(id, controller.signal)
      .then((a) => {
        setAsset(a);
        assetRef.current = a;
      })
      .catch((err: unknown) => {
        if (err instanceof CancelledError) return;
        setLoadError(err instanceof Error ? err.message : 'Could not load this asset.');
      });
    return () => controller.abort();
  }, [id, reload]);

  // Focus moves into the panel when it opens.
  useEffect(() => {
    const t = window.setTimeout(() => closeRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
async function setStatus(next: AssetStatus) {
    const current = assetRef.current;
    if (!current || saving) return;
    const snapshot = current;
    setSaving(true);
    setSaveError(null);
    setConflict(false);
    onOptimistic(current.id, next);

    try {
      const updated = await updateAsset(current.id, current.version, { status: next });
      setAsset(updated);
      assetRef.current = updated;
      onSaved(updated);
    } catch (err) {
      if (err instanceof CancelledError) return;
      if (err instanceof ApiError && err.status === 409) {
        // Someone else changed the row. Roll back our optimistic edit and
        // show the current truth instead of papering over it.
        onRevert(current.id, snapshot);
        setConflict(true);
        setSaveError('Someone else changed this asset while you were editing it.');
        setReload((r) => r + 1); // refetch the current version
        return;
      }
      onRevert(current.id, snapshot);
      setAsset(snapshot);
      assetRef.current = snapshot;
      setSaveError(err instanceof Error ? err.message : 'The change did not save. Try again.');
    } finally {
      setSaving(false);
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
          <button className="btn" onClick={() => setReload((r) => r + 1)}>
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