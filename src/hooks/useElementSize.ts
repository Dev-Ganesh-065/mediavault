import { useLayoutEffect, useState } from 'react';
import type { RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * Measures an element's content-box size and keeps it in sync with
 * `ResizeObserver`.
 *
 * This is deliberately *layout* glue, not virtualisation. TanStack Virtual
 * owns which indices exist for the current scroll offset, where each row sits
 * and how tall the scroll surface is. The one thing it cannot report
 * reactively is how many columns fit: its re-render trigger is the visible
 * *index range*, so a pure width change that leaves that range intact (a 5-up
 * grid resizing to 4-up while scrolled to the top) would otherwise keep a
 * stale column count on screen. So we measure the container ourselves and
 * derive `cols` from it.
 *
 * `useLayoutEffect` means the first measurement lands before the browser
 * paints, so the grid never flashes a one-column layout.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>): ElementSize {
  const [size, setSize] = useState<ElementSize>({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const read = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      // Only re-render on a real change — ResizeObserver fires on every frame
      // of a drag-resize.
      setSize((prev) =>
        prev.width === next.width && prev.height === next.height ? prev : next,
      );
    };

    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return size;
}
