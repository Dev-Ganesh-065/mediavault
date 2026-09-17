import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useElementSize } from '@/hooks/useElementSize';
import type { Asset } from '@/lib/types';
import { AssetCard } from './AssetCard';

/**
 * A windowed, keyboard-operable grid, virtualised with @tanstack/react-virtual.
 *
 * The library owns the hard part: which item indices exist at the current
 * scroll offset, where each one sits, and how tall the scroll surface is.
 * Nothing here re-implements windowing — there is no spacer arithmetic, no
 * hand-maintained scrollTop, no scrollHeight delta.
 *
 * What stays local is *layout and interaction*, which a headless virtualiser
 * deliberately leaves to its consumer:
 *
 *   - how many columns fit (`cols`). That is a responsive-layout question, not
 *     a windowing one, and the virtualizer's own re-render trigger is the
 *     visible index range — so a width change that leaves the range intact is
 *     measured here (`useElementSize`) rather than inferred from the library.
 *   - the keyboard model (roving tabindex -> one tab stop, not 12,400):
 *       arrows        move focus
 *       shift+arrows  extend the selection range from an anchor
 *       Space         toggle the focused card
 *       Enter         open the detail panel
 *       Home/End      first / last loaded card
 *       PageUp/Down   move by a viewport of rows
 *       Ctrl/Cmd+A    select everything loaded so far
 *   - infinite scroll, driven by the virtualizer's own distance-to-the-end.
 *
 * Layout is expressed as `lanes`: one lane per column, one virtual item per
 * card, and the cross-axis position comes from `item.lane`. With a fixed
 * `estimateSize` and equal card heights, lane assignment is strictly
 * row-major, so card `index + 1` really is the card to the right and the
 * arrow-key arithmetic below stays exact. Variable heights would let the
 * library pack lanes masonry-style, which is why card height is a fixed design
 * token (CARD_H) and why this grid deliberately does not attach
 * `measureElement`.
 */

const CARD_MIN_W = 224;
const CARD_GAP = 14;
const PAD = 16;
const CARD_H = 238;
const ROW_PITCH = CARD_H + CARD_GAP;
/** Extra rows rendered above and below the viewport (rows, not items). */
const OVERSCAN_ROWS = 4;
/** Ask for the next page once we are this close to the bottom. */
const LOAD_MORE_PX = 700;

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
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const { width: viewportWidth, height: viewportHeight } = useElementSize(scrollRef);
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

  // App holds a ref to the scroll container (scroll to top on a new query,
  // and finding the originating card when the detail panel closes). Publish it
  // *after* mount: refs are attached during the commit, so assigning during
  // render would hand App a null on the very render it needs it.
  useLayoutEffect(() => {
    if (containerRefOut) containerRefOut.current = scrollRef.current;
  });

  // `window.innerWidth` is only the pre-measurement guess, so the first paint
  // is never a one-column strip; useElementSize corrects it before paint.
  const containerWidth = viewportWidth || window.innerWidth;
  const available = Math.max(CARD_MIN_W, containerWidth - PAD * 2);
  const cols = Math.max(1, Math.floor((available + CARD_GAP) / (CARD_MIN_W + CARD_GAP)));
  const laneWidth = (available - (cols - 1) * CARD_GAP) / cols;
  const rows = Math.max(1, Math.ceil(items.length / cols));
  const visibleRows = Math.max(1, Math.floor((viewportHeight + CARD_GAP) / ROW_PITCH));

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    lanes: cols,
    estimateSize: () => CARD_H,
    gap: CARD_GAP,
    paddingStart: PAD,
    paddingEnd: PAD,
    overscan: cols * OVERSCAN_ROWS,
  });

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
    if (e.target !== scrollRef.current) return;
    const card = scrollRef.current?.querySelector(
      `[data-index="${focusRef.current}"]`,
    ) as HTMLElement | null;
    card?.focus();
  }

  /**
   * Move DOM focus onto a card. The node may not be mounted yet — a long jump
   * (End, PageDown) makes the virtualizer mount new indices on a later frame —
   * so give it a couple of frames before giving up.
   */
  function focusCard(index: number) {
    const attempt = (retries: number) => {
      const el = scrollRef.current?.querySelector(`[data-index="${index}"]`) as HTMLElement | null;
      if (el) {
        el.focus();
        el.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (retries > 0) requestAnimationFrame(() => attempt(retries - 1));
    };
    attempt(2);
  }

  function moveTo(next: number, shift: boolean) {
    const bound = Math.max(0, Math.min(items.length - 1, next));
    if (!shift) anchorRef.current = bound;
    focusRef.current = bound;
    setFocusIndex(bound);

    // Only ask the virtualizer to scroll for a target outside the rendered
    // window; inside it, `scrollIntoView({ block: 'nearest' })` is the minimal
    // movement and does not jerk an already-visible row to an edge.
    const range = virtualizer.range;
    const mounted = range ? bound >= range.startIndex && bound <= range.endIndex : false;
    if (!mounted) virtualizer.scrollToIndex(bound, { align: 'auto' });

    requestAnimationFrame(() => focusCard(bound));

    // Keyboard navigation at the tail should pull the next page the same way
    // scrolling does.
    if (bound === items.length - 1) onLoadMoreRef.current();
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
    if (!hasMore || loadingMore) return;
    // The virtualizer already knows how far the end is; no scrollHeight maths.
    if (virtualizer.getDistanceFromEnd() <= LOAD_MORE_PX) onLoadMoreRef.current();
  }

  return (
    <div
      ref={scrollRef}
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
      <div className="grid__canvas" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const asset = items[item.index];
          if (!asset) return null;
          return (
            <div
              key={item.key}
              className="grid__cell"
              style={{
                top: item.start,
                left: PAD + item.lane * (laneWidth + CARD_GAP),
                width: laneWidth,
                height: item.size,
              }}
            >
              <AssetCard
                asset={asset}
                index={item.index}
                selected={selectedIds.has(asset.id)}
                active={activeId === asset.id}
                tabIndex={item.index === focusIndex ? 0 : -1}
                onOpen={onOpenRef.current}
                onToggle={onToggleRef.current}
                onAnchor={stableAnchor}
                onExtendRange={stableExtend}
              />
            </div>
          );
        })}
      </div>

      {loadingMore && (
        <div className="grid__loading" role="status">
          Loading more…
        </div>
      )}
    </div>
  );
}