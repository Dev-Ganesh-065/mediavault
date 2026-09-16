import { statusLabel } from '@/lib/format';
import type { AssetStatus } from '@/lib/types';

/**
 * A status read as a progression, not four random colours:
 *   draft      hollow circle
 *   in_review  half-filled circle
 *   approved   filled circle
 *   archived   hollow square (dashed border) and dimmed text
 * The shape + label text carry the meaning; colour only reinforces it.
 */
export function StatusPill({ status }: { status: AssetStatus }) {
  return (
    <span className={`pill pill--${status}`} data-status={status}>
      <span className="pill__dot" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
}