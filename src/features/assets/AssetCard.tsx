import { thumbnailUrl } from '@/api/client';
import { formatBytes, formatDate } from '@/lib/format';
import { memoByKey } from '@/lib/memo';
import type { Asset } from '@/lib/types';
import { StatusPill } from './StatusPill';

export interface CardProps {
  asset: Asset;
  index: number;
  selected: boolean;
  active: boolean;
  tabIndex: number;
  onOpen: (id: string) => void;
  onToggle: (id: string) => void;
  onAnchor: (index: number) => void;
  onExtendRange: (index: number) => void;
}

/**
 * One card. Wrapped in `memo` so toggling a single card (selection, status
 * pill, detail open/close) cannot re-render the rest of the grid — the props
 * that change are primitives or stable callbacks, so identity comparison is
 * exact for our usage.
 */
export const AssetCard = memoByKey(
  (p: CardProps) => p.asset,
  function AssetCard({
    asset, index, selected, active, tabIndex, onOpen, onToggle, onAnchor, onExtendRange,
  }: CardProps) {
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      aria-label={`${asset.name}, ${asset.status.replace('_', ' ')}`}
      data-id={asset.id}
      data-index={index}
      tabIndex={tabIndex}
      className={`card${selected ? ' card--selected' : ''}${active ? ' card--active' : ''}`}
      onClick={(e) => {
        if (e.shiftKey) {
          onExtendRange(index);
          return;
        }
        // Any click that reaches the card opens it — on the thumbnail, the
        // name, the meta row, the status pill or the bare padding. The
        // selection checkbox stops propagation for its own clicks, so it is
        // the one child that must not bubble here; everything else should.
        // (A previous `e.target === e.currentTarget` check swallowed every
        // click that landed on a child element, leaving Enter as the only
        // way to open a card.)
        onAnchor(index);
        onOpen(asset.id);
      }}
    >
      <Thumb asset={asset} />
      <div className="card__body">
        <p className="card__name" title={asset.name}>
          {asset.name}
        </p>
        <p className="card__meta">
          {asset.kind} · {formatBytes(asset.sizeBytes)} · {formatDate(asset.updatedAt)}
        </p>
        <StatusPill status={asset.status} />
      </div>
      <span
        className={`card__check${selected ? ' card__check--on' : ''}`}
        role="checkbox"
        aria-checked={selected}
        aria-label={`Select ${asset.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(asset.id);
        }}
      >
        {selected ? '✓' : ''}
      </span>
    </div>
  );
});

function Thumb({ asset }: { asset: Asset }) {
  if (!asset.hasThumbnail) {
    return (
      <span
        className="card__thumb card__thumb--placeholder"
        aria-hidden="true"
      >
        <span className="card__thumb__badge" aria-hidden="true">
          {asset.kind === 'video' ? '▶' : asset.kind === 'document' ? '▤' : '▧'}
        </span>
      </span>
    );
  }
  return (
    <img
      className="card__thumb"
      src={thumbnailUrl(asset.id)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={(e) => {
        // A 404 thumbnail (or any image failure) degrades to a stable
        // placeholder instead of a broken image or a layout shift.
        (e.currentTarget as HTMLImageElement).style.display = 'none';
      }}
    />
  );
}