import { useEffect, useRef, useState } from 'react';
import type { Asset } from '@/lib/types';
import { AssetCard } from './AssetCard';

/**
 * A windowed, keyboard-operable grid.
 *
 * Rendering is bounded by the viewport, never by how far the user has
 * scrolled: we lay out a fixed-height spacer inside a scroll container,
 * then absolute-position only the rows that intersect the viewport (plus a
 * small overscan). 5,000 loaded rows produce the same DOM size as 50.
 *
 * Keyboard model (roving tabindex -> one tab stop, not 12,400):
 *   arrows        move focus
 *   shift+arrows  extend the selection range from an anchor
 *   Space         toggle the focused card
 *   Enter         open the detail panel
 *   Home/End      first / last loaded card
 *   Ctrl/Cmd+A    select everything loaded so far
 */

const CARD_MIN_W = 224;
const CARD_GAP = 14;
const PAD = 16;
const CARD_H = 238;
const ROW_PITCH = CARD_H + CARD_GAP;
const OVERSCAN_ROWS = 4;

export interface VirtualGridProps {
  items: Asset[];
  total: number;
  selectedIds: ReadonlySet<string>;
  activeId: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onToggleSelect: (id: string) => void;
  onSelectRange: (anchor: number, focus: number) => void;
  onSelectAll: () => void;
  onOpen: (id: string) => void;
  onLoadMore: () => void;
  containerRefOut?: { current: HTMLDivElement | null };
}

export function VirtualGrid({
  items, total, selectedIds, activeId, hasMore, loadingMore,
  onToggleSelect, onSelectRange, onSelectAll, onOpen, onLoadMore, containerRefOut,
}: VirtualGridProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [focusIndex, setFocusIndex] = useState(0);
  const anchorRef = useRef(0);
  const focusRef = useRef(focusIndex);
  focusRef.current = focusIndex;

  // Identity-stable callbacks so the card memo stays effective.
  const onToggleRef = useRef(onToggleSelect); onToggleRef.current = onToggleSelect;
  const onSelectRangeRef = useRef(onSelectRange); onSelectRangeRef.current = onSelectRange;
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  const onLoadMoreRef = useRef(onLoadMore); onLoadMoreRef.current = onLoadMore;

  const stableAnchor = useRef((index: number) => void (anchorRef.current = index)).current;
  const stableExtend = useRef(
    (to: number) => onSelectRangeRef.current(anchorRef.current, to),
  ).current;

  if (containerRefOut) containerRefOut.current = containerRef.current;

  const cols = Math.max(1, Math.floor((viewport.width - PAD * 2 + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const visibleRows = Math.max(1, Math.floor((viewport.height - PAD * 2 + CARD_GAP) / ROW_PITCH));
  const topRow = Math.max(0, Math.floor((scrollTop - PAD) / ROW_PITCH) - OVERSCAN_ROWS);
  const bottomRow = Math.min(rows - 1, Math.ceil((scrollTop + viewport.height - PAD) / ROW_PITCH) + OVERSCAN_ROWS);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setViewport({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const obs = new ResizeObserver(measure);
    obs.observe(el);
    return () => obs.disconnect();
  }, []);
// Clamp focus when the result set shrinks (filter reset, rollback…).
  useEffect(() => {
    if (focusRef.current > items.length - 1) {
      const next = Math.max(0, items.length - 1);
      focusRef.current = next;
      setFocusIndex(next);
    }
  }, [items.length]);

  // Roving tabindex: when the grid container itself receives focus (Tab in),
  // hand focus to the focused card; arrow keys are handled on the container.
  function onFocusIn(e: React.FocusEvent<HTMLDivElement>) {
    if (e.target !== containerRef.current) return;
    const el = containerRef.current;
    const card = el?.querySelector(`[data-index="${focusRef.current}"]`) as HTMLElement | null;
    card?.focus();
  }

  function moveTo(next: number, shift: boolean) {
    const bound = Math.max(0, Math.min(items.length - 1, next));
    if (!shift) anchorRef.current = bound;
    focusRef.current = bound;
    setFocusIndex(bound);
    // Transfer DOM focus onto the new card and keep it in view.
    requestAnimationFrame(() => {
      const el = containerRef.current?.querySelector(`[data-index="${bound}"]`) as HTMLElement | null;
      el?.focus();
      el?.scrollIntoView({ block: 'nearest' });
      // Keyboard navigation at the tail should pull the next page the same
      // way scrolling does.
      if (bound === items.length - 1) onLoadMoreRef.current();
    });
  }

  function onGridKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const count = items.length;
    if (count === 0) return;
    const key = e.key;
    const handled = new Set([
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'PageUp', 'PageDown', ' ', 'Enter',
    ]);
    if (!handled.has(key) && !((e.ctrlKey || e.metaKey) && (key === 'a' || key === 'A'))) return;
    e.preventDefault();

    if ((e.ctrlKey || e.metaKey) && (key === 'a' || key === 'A')) {
      onSelectAll();
      return;
    }

    const focus = focusRef.current;
    const col = focus % cols;
    let next = focus;

    switch (key) {
      case 'ArrowRight': next = col < cols - 1 ? focus + 1 : Math.min(count - 1, focus); break;
      case 'ArrowLeft': next = col > 0 ? focus - 1 : Math.max(0, focus); break;
      case 'ArrowDown': next = Math.min(count - 1, focus + cols); break;
      case 'ArrowUp': next = Math.max(0, focus - cols); break;
      case 'Home': next = 0; break;
      case 'End': next = count - 1; break;
      case 'PageDown': next = Math.min(count - 1, focus + visibleRows * cols); break;
      case 'PageUp': next = Math.max(0, focus - visibleRows * cols); break;
      case 'Enter':
        onOpenRef.current(items[focus]?.id ?? '');
        return;
      case ' ':
        onToggleRef.current(items[focus]?.id ?? '');
        return;
      default:
        return;
    }
    if (next !== focus) moveTo(next, e.shiftKey);
  }

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (hasMore && !loadingMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 700) {
      onLoadMoreRef.current();
    }
  }

  const rowNodes: React.JSX.Element[] = [];
  for (let r = topRow; r <= bottomRow; r += 1) {
    const from = r * cols;
    const to = Math.min(items.length, from + cols);
    const cards: React.JSX.Element[] = [];
    for (let i = from; i < to; i += 1) {
      const asset = items[i];
      if (!asset) continue;
      cards.push(
        <AssetCard
          key={asset.id}
          asset={asset}
          index={i}
          selected={selectedIds.has(asset.id)}
          active={activeId === asset.id}
          tabIndex={i === focusIndex ? 0 : -1}
          onOpen={onOpenRef.current}
          onToggle={onToggleRef.current}
          onAnchor={stableAnchor}
          onExtendRange={stableExtend}
        />,
      );
    }
    rowNodes.push(
      <div className="grid__row" key={`row-${r}`} style={{ top: PAD + r * ROW_PITCH, height: CARD_H }}>
        {cards}
      </div>,
    );
  }

  return (
    <div
      ref={containerRef}
      className="grid"
      role="grid"
      aria-label="Asset library"
      aria-rowcount={rows}
      aria-colcount={cols}
      tabIndex={0}
      data-total={total}
      onKeyDown={onGridKeyDown}
      onScroll={onScroll}
      onFocus={onFocusIn}
    >
      <div className="grid__spacer" style={{ height: rows * ROW_PITCH + PAD * 2 - CARD_GAP }}>
        {rowNodes}
        {loadingMore && (
          <div className="grid__loading" role="status">
            Loading more…
          </div>
        )}
      </div>
    </div>
  );
}