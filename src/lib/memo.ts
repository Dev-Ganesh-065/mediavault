import type { JSX } from 'react';

/**
 * A tiny per-asset memo wrapper around a component.
 *
 * `React.memo` would also memoise each card, but only while that card is
 * *mounted*: it compares props on update, and a card that unmounts and later
 * comes back re-renders from scratch. Virtualisation recycles cards constantly
 * (scroll a row out, scroll it back), so this caches the rendered element by
 * key instead — a remount with the same `Asset` object and the same props
 * returns the element built last time.
 *
 * Each distinct `key` (for cards: the Asset object identity) caches the last
 * rendered element together with the props that produced it. Props are
 * compared by identity, not deep equality — which is exact for our usage:
 * card props are primitives, the same Asset object, or stable callbacks held
 * by refs/useCallback, so flipping one card's selection changes exactly that
 * card's props and every other card returns its cached element.
 *
 * A fresh Asset object (e.g. after a bulk status update replaces the row)
 * naturally misses the WeakMap and re-renders just that card.
 */
export function memoByKey<P extends object, K extends object>(
  keyOf: (props: P) => K,
  render: (props: P) => JSX.Element,
) {
  const cache = new WeakMap<K, { props: P; element: JSX.Element }>();
  return function memoized(props: P): JSX.Element {
    const key = keyOf(props);
    const prev = cache.get(key);
    if (prev) {
      const a = prev.props;
      let same = true;
      for (const k of Object.keys(a)) {
        if ((a as Record<string, unknown>)[k] !== (props as Record<string, unknown>)[k]) {
          same = false;
          break;
        }
      }
      if (same) {
        for (const k of Object.keys(props)) {
          if (!(k in a)) {
            same = false;
            break;
          }
        }
      }
      if (same) return prev.element;
    }
    const element = render(props);
    cache.set(key, { props, element });
    return element;
  };
}