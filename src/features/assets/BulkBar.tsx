import { statusLabel } from '@/lib/format';
import type { AssetStatus, BulkOutcome } from '@/lib/types';

/**
 * The bulk bar. Presentational only: the optimistic update, chunking,
 * bounded concurrency, rollback and retry live in App (they need the list).
 */
export interface BulkBarProps {
  selectedCount: number;
  loadedCount: number;
  working: boolean;
  outcome: BulkOutcome | null;
  target: AssetStatus | null;
  canRetry: boolean;
  onApplyStatus: (status: AssetStatus) => void;
  onRetryFailed: () => void;
  onUndo: () => void;
  onSelectAllLoaded: () => void;
  onClear: () => void;
}

const STATUSES: AssetStatus[] = ['draft', 'in_review', 'approved', 'archived'];

export function BulkBar({
  selectedCount, loadedCount, working, outcome, target, canRetry,
  onApplyStatus, onRetryFailed, onUndo, onSelectAllLoaded, onClear,
}: BulkBarProps) {
  if (selectedCount === 0) return null;

  const failedLegal = outcome?.failed.filter((f) => f.code === 'legal_hold').length ?? 0;
  const failedRetryable = outcome?.failed.filter((f) => f.code === 'conflict').length ?? 0;

  return (
    <section className="bulkbar" aria-label="Bulk actions">
      <span className="bulkbar__count" role="status">
        <strong>{selectedCount.toLocaleString()}</strong> selected
        {outcome?.okIds.length ? (
          <>
            {' '}· <strong>{outcome.okIds.length}</strong> moved to {target ? statusLabel(target) : ''}
          </>
        ) : null}
      </span>

      <span className="bulkbar__actions">
        {STATUSES.map((s) => (
          <button
            key={s}
            className="btn"
            disabled={working}
            onClick={() => onApplyStatus(s)}
          >
            Move to {statusLabel(s)}
          </button>
        ))}
      </span>

      {canRetry && (
        <button className="btn btn--primary" onClick={onRetryFailed}>
          Retry {outcome?.failed.length} failed
        </button>
      )}
      {outcome?.okIds.length ? (
        <button className="btn" onClick={onUndo}>
          Undo
        </button>
      ) : null}

      <span className="bulkbar__meta">
        <button className="btn btn--ghost" onClick={onSelectAllLoaded} disabled={working}>
          Select all loaded ({loadedCount.toLocaleString()})
        </button>
        <button className="btn btn--ghost" onClick={onClear} disabled={working}>
          Clear
        </button>
      </span>

      {outcome && outcome.failed.length > 0 && (
        <p className="bulkbar__failures" role="status">
          {outcome.failed.length} couldn&apos;t be moved:
          {failedLegal > 0 && ` ${failedLegal} on legal hold`}
          {failedRetryable > 0 && ` ${failedRetryable} hit a conflict (retryable)`}
          {outcome.failed.some((f) => f.code === 'not_found') && ' some were deleted'}
          .
        </p>
      )}
    </section>
  );
}