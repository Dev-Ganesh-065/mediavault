# SUBMISSION.md

**Repo:** this repository
**Deployed:** https://mediavault-assessment.vercel.app *(static build; the mock API runs alongside it)*
**Video:** *(recorded walkthrough — link also included in the submission email)*

---

## Task 0 — Defect inventory

Found in the baseline `src/` code. Each marked **fixed**, **knowingly left**, or **out of scope**.

| # | Defect | Where | Status |
|---|---|---|---|
| 1 | `applyBulkStatus` sends all selected ids in one request — fails outright past 50 | `App.tsx` | **fixed** — chunked to 50 with bounded concurrency (3) |
| 2 | Search race: slower responses from earlier queries overwrite newer results | `useAssets.ts` | **fixed** — the query cache key is the filter set, so a response can only land in the entry it was fetched for |
| 3 | No request de-duplication — identical concurrent GETs hit the API twice | `client.ts` | **fixed** — TanStack Query collapses identical in-flight queries; the ad-hoc in-flight map was removed in its favour |
| 4 | No retry on 503/429/network; no backoff, no `Retry-After` handling | `client.ts` | **fixed** — exponential backoff with full jitter, capped attempts, structural `retryable` check |
| 5 | 400/409/422 were retried in some paths — unsafe writes could double-apply | `client.ts` | **fixed** — `ApiError.retryable` decided from status + code, never message matching |
| 6 | No URL state — reload/share lost the view; every keystroke could push history | `App.tsx` | **fixed** — `useUrlQuery` mirrors query state into the URL; history only advances on the debounce boundary |
| 7 | `stale_cursor` surfaced as a raw error string to the user | `App.tsx`/list | **fixed** — detected in `useAssetList` and transparently restarts from page one |
| 8 | All 12,400 rows rendered into the DOM | `AssetGrid.tsx` | **fixed** — `VirtualGrid` virtualises with `@tanstack/react-virtual` (`lanes` = columns); DOM bounded by the viewport |
| 9 | Selection toggles re-rendered every card | `AssetGrid.tsx` | **fixed** — a per-asset memo wrapper (`lib/memo.ts`), stable callbacks, `Set`-based selection |
| 10 | No error boundary — one component error blanked the page | app root | **fixed** — `ErrorBoundary` with a recovery action |
| 11 | Grid unusable from keyboard; 12,400 tab stops | `AssetGrid.tsx` | **fixed** — roving tabindex, arrows/space/enter/shift-arrows/Home/End/PageUp/PageDown/Ctrl+A |
| 12 | No focus management for the detail panel | `AssetDetail.tsx` | **fixed** — focus moves in on open, returns to the card on close, Escape closes |
| 13 | Thumbnail 404s showed a broken image; no reserved space (layout shift) | `AssetCard.tsx` | **fixed** — `hasThumbnail` checked, sized placeholder, no CLS |
| 14 | Status communicated by colour alone | CSS | **fixed** — pill shows icon shape + text, so it is distinguishable without colour |
| 15 | `429: Too many requests in the last 10 seconds` shown verbatim | error UI | **fixed** — `humanError()` maps every API code to an actionable sentence |
| 16 | Offline went undetected; app kept hammering a dead network | app | **fixed** — `useOffline` hook, the list query is disabled while offline, banner shown, `refetchOnReconnect` refreshes on return |
| 17 | Loading, empty and error states all looked like "no results" | `App.tsx` | **fixed** — distinct skeleton / empty / error / offline states with different copy and affordances |
| 18 | Filter changes while paginated kept a cursor bound to the old query | list | **fixed** — pagination resets on every filter change; stale cursors handled defensively |
| 19 | Optimistic rollback replaced the whole page (losing successes) | bulk | **fixed** — per-id rollback; only failed ids revert, successes kept |
| 20 | Live announcements on every keystroke would spam screen readers | — | **fixed** — single polite live region fed by curated announcements |
| 21 | Sorting UI existed but was not wired to the API's `sort` values correctly | — | **fixed** — all six `sort` values wired through |

A second QA pass over the upgraded build surfaced four more defects, each reproduced with a headless-browser script before fixing and re-run after:

| # | Defect | Where | Status |
|---|---|---|---|
| 22 | React 18 StrictMode's dev-only double-mount aborted the first in-flight fetch — every initial API request failed (`net::ERR_ABORTED`) and succeeded only when the remount immediately re-issued it | `main.tsx` | **fixed** — StrictMode removed; the initial fetch runs exactly once, and cancellation for real key changes still works via the query signal |
| 23 | Clicking a card opened the detail only from its bare padding: an `e.target === e.currentTarget` guard swallowed every click that landed on a child (thumbnail, name, meta, status pill), leaving Enter as the only reliable way in | `AssetCard.tsx` | **fixed** — any click that reaches the card opens it; the selection checkbox keeps its own `stopPropagation` so it still only toggles selection |
| 24 | With the detail panel open, switching to another asset carried the previous asset's save-error/conflict banners onto the new one | `AssetDetail.tsx` | **fixed** — per-asset UI state resets when the active id changes; the panel itself re-queries through the `['asset', id]` cache key, so the body, facts and status picker always reflect the open asset |
| 25 | The first arrow-key move after clicking a card jumped a row up or down: the roving tabindex ignored focus landing on cards (mouse clicks, focus-return when the panel closes) and the next key moved relative to a stale index | `VirtualGrid.tsx` | **fixed** — `onFocusIn` syncs the roving index with real DOM focus, so arrows always move relative to the card the user is actually on; the shift-range anchor is deliberately untouched |

**Knowingly left / out of scope:**

- **Offline write queueing** (bonus): skipped. Detection, pausing and recovery are done; queueing writes offline was judged lower value than polish elsewhere for the time budget.
- **SSE `/api/events` live updates** (optional): not done.
- **`/api/stats` header** (optional): not done.
- **Tests**: the brief makes them optional; instead I built a reproducible smoke script (`scripts/smoke.mjs`, playwright-core against system Edge) that exercises race handling, deep scroll, keyboard path, and bulk partial failure against the real chaotic API. It asserts the things that regress silently: that the DOM stays bounded while hundreds of rows are loaded, that lanes produce a clean row-major grid (one width, one row pitch, zero overlaps), and that an identical repeat search costs **zero** network reads.

## Task 1 — Search correctness

- **Stale responses are structurally impossible, not merely guarded against.** The cache key *is* the filter set, so a response can only ever land in the entry it was requested for; a slow reply for an abandoned query cannot reach the current view whenever it arrives. The earlier version approximated this with a monotonic sequence counter plus an `AbortController` — both are gone, because the mechanism that replaced them cannot be ordered wrong or forgotten in a new code path.
- **Cancellation:** TanStack Query hands each request its own `AbortSignal` and fires it when the key changes or the observer unmounts; the client also aborts *queued* retry sleeps, so an abandoned query stops consuming attempts against the rate limiter.
- **Debounce: 400 ms** (raised from 250 ms). Ordinary typing arrives faster than that, and everything after the burst is a duplicate of the final keystroke's query — the API answers "name contains X", not "was this the 4th or 5th character". At 250 ms a single six-character word could still fire two or three reads; at 400 ms a whole burst collapses into one, which leaves more of the 80/10s budget for pagination and retries. **Measured:** typing "studio" (6 chars) at ~45 ms/key produces **1** network read.
- **URL state:** `q`, `status`, `kind`, `sort` live in the URL. Filter changes replace the entry; the search term only advances history on the debounce boundary.
- **De-duplication and caching:** identical in-flight queries collapse into a single request, and a search already in the cache renders instantly. **Measured:** repeating an identical search costs **0** network reads.
- **`stale_cursor` is never shown:** a cursor bound to a superseded query is our bookkeeping problem, never the user's — the accumulated pages are dropped and the list restarts from page one.
- **Loading / empty / error are distinct:** skeleton cards while the first page loads; a "no assets match" state with a clear-filters action; an error state with a retry button; a separate offline state. A failure loading *more* keeps the rows already on screen and offers a retry banner instead of blanking the list.

## Task 2 — Scale

`VirtualGrid.tsx` is a windowed grid built on **`@tanstack/react-virtual`** (`useVirtualizer`). The library owns which indices exist at the current scroll offset, where each one sits, and how tall the scroll surface is; the grid keeps only what a headless virtualiser deliberately leaves to its consumer.

- **Layout is `lanes`.** One lane per column, one virtual item per card, cross-axis position from `item.lane`. Card height is a fixed design token and `estimateSize` returns it, so lane assignment stays strictly row-major — card `index + 1` really is the card to the right, which is exactly what the arrow-key arithmetic assumes. (`measureElement` is deliberately not attached: variable heights would let the library pack lanes masonry-style and quietly break that assumption.)
- **Column count is measured, not inferred.** The virtualizer re-renders when the visible *index range* changes, so a width change that leaves that range intact (5 columns becoming 4 while scrolled to the top) would otherwise leave a stale column count on screen. `useElementSize` measures the container for that one value; the layout effect means it lands before paint.
- **Infinite scroll** uses the virtualizer's own `getDistanceFromEnd()` — no hand-rolled `scrollHeight - clientHeight` arithmetic.
- **Focus restore** asks the virtualizer to scroll (`scrollToIndex`) only when the target is outside the rendered window; inside it, `scrollIntoView({ block: 'nearest' })` is the minimal movement and does not jerk an already-visible row to an edge.

**Measured (playwright-core, headless Edge, chaos on):**

| Metric | Baseline | Now |
|---|---|---|
| DOM after scrolling through **408** loaded rows | grew with scroll | **684 nodes, 70 cards mounted** (flat) |
| Lane geometry at 408 rows | — | one width (267 px), one row pitch (252 px), **0 overlaps**, `rowMajor: true` |
| Reads while typing "studio" (6 chars) | ~6+ | **1** |
| Reads repeating an identical search | n/a — no cache existed | **0** |
| Production bundle, gzipped | 48 kB | **75.4 kB JS + 2.8 kB CSS** (React is ~40 kB of the JS; the two TanStack libraries add ~20 kB) |

The scroll surface can no longer drift: `getTotalSize()`, item offsets and the scrollbar all come from the same source.

Card toggles: cards are memoised per asset (`lib/memo.ts`). `React.memo` compares props only while a card stays mounted, and virtualisation recycles cards constantly — scroll a row out, scroll it back — so the wrapper caches the rendered element by asset identity and returns it on remount. Selection lives in a single `Set` and each card receives primitives plus stable callbacks, so toggling one card re-renders exactly one card.

Scroll position survives opening/closing the detail panel because the grid container is not remounted (the `key` only changes when the filter identity changes), and detail open/close touches neither the array identity nor the scroll container.

Thumbnails are lazy (`loading="lazy"`, `draggable={false}`), guarded by `hasThumbnail`, with a fixed-size placeholder that prevents both broken-image glyphs and layout shift.

## Data layer — why TanStack Query, and where the line sits

Three separate concerns had been living in one place, and separating them is most of what changed:

| Concern | Owner | Why there |
|---|---|---|
| Transport: retry, backoff, `Retry-After`, abort | `src/api/client.ts` | It is the layer that can see HTTP status, the API's error-code enum, and response headers |
| Cache: de-duplication, staleness, cancellation, refetch-on-reconnect | `src/api/queryClient.ts` + TanStack Query | Cache invalidation is genuinely hard to get right by hand, and every attempt ends up re-implementing it badly |
| Rows on screen: filters, pagination, phase, optimistic patches | `src/features/assets/useAssetList.ts` | Genuinely app-specific policy |

**Reads** are `useQuery` / `useInfiniteQuery`; **writes** are `useMutation`, which is used exactly as intended: never on mount, no response cached, and the cache is reconciled by patching it with the server-confirmed rows and *then* invalidating, so the background refetch fixes what a patch cannot express (a row that no longer matches the active filter).

**`retry: 0` on the QueryClient is deliberate, not an oversight.** The client already retries with jitter and understands `Retry-After`; a second retry loop on top would multiply request counts against an 80-per-10s budget where *retries count too* — so stacking them makes the rate limiter worse, not better. One retry policy, in the layer that has the information to apply it.

I chose these libraries over more hand-rolled code because both replace code I would otherwise have to keep correct forever: windowing maths and cache invalidation. What I did *not* hand over is anything the libraries cannot see — the keyboard model, the ARIA grid semantics, the column count, and the app's own notion of what a "phase" is.

## Task 3 — Bulk actions

- **One mutation per user action.** The whole chunked pass is a single `useMutation` call, so completion (and cache invalidation) happens *once* — not once per 50-id chunk, which during a 500-row bulk would refetch every loaded page ten times over and exhaust the rate limit on its own.
- **Range selection:** click, Shift+click/Shift+arrows extend from an anchor, Ctrl+A selects everything loaded. Selection is a `Set` + index math, so selecting 500 is O(1) per card — no stutter.
- **Optimistic:** the grid updates immediately; `prev` records each id's prior status.
- **Chunked:** 50 ids per request (the cap), **3 chunks in flight** — never 40 parallel.
- **Partial success (207):** per-id results are applied individually. Failures roll back only the failed ids; successes stay. The bulk bar reports exactly which ids failed and why, and separates the two failure kinds: **legal-hold failures get no retry** (it can never succeed — the retry button is hidden for that subset), random failures get **"Retry failed"**.
- **Undo:** one click restores every id's prior status via the same chunked path.
- **409 in the detail panel:** the server's current version is fetched and shown, and the user is told someone else changed the asset; they can then re-apply their edit on top of the fresh version. I chose "show the conflict and let the user merge" over silent overwrite or blind retry, because a reviewer's status change is a judgement call — silently clobbering a colleague's edit is worse than a moment of friction.

## Task 4 — Resilience

- **Retries:** exponential backoff with full jitter, honouring `Retry-After` when present, capped (reads 3 attempts, writes 2 — writes are capped lower so a flaky write cannot double-apply without the user noticing).
- **Structural, not string-matched:** `ApiError.retryable` derives from HTTP status + the API's error code enum. 400/409/422/404 are never retried; 503/429 and the API's explicitly-safe `write_failed` 500 are.
- **Offline:** `useOffline` (online/offline events, with a probe on reconnect). While offline the list query is `enabled: false`, so no request is issued and no retry loop spins; a distinct banner explains the state. On reconnect the query is re-enabled and TanStack Query's `refetchOnReconnect` refreshes what is on screen — which is precisely the moment it is most likely to be stale.
- **Error boundary** at the app root with a recovery action; a component crash no longer blanks the page.
- **Every user-facing error is rewritten** by `humanError()` — e.g. rate limiting reads *"The library is busy right now. Wait a few seconds, then retry."*

## Task 5 — Keyboard and screen reader

- **Roving tabindex:** exactly one tab stop; arrows/shift-arrows/Space/Enter/Home/End/PageUp/PageDown/Ctrl+A all handled; focus is clamped when the result set shrinks so it never lands on a detached node. Because the grid is virtualised, a long jump (End, PageDown) first asks the virtualizer to scroll the target into range and then waits up to two frames for that card to mount before focusing it — keyboard focus never lands on nothing.
- **Pointer/keyboard parity:** a card opens from a click anywhere on it (the selection checkbox keeps its own `stopPropagation`), and the roving tabindex follows real DOM focus — so the first arrow key after a click moves from the card that was clicked, not from a stale index (defect #25).
- **Detail panel:** focus moves into it on open, Escape closes, focus returns to the originating card.
- **Live region:** one polite, atomic `role="status"` region; announcements are curated (result counts, bulk outcomes, errors) — not one per keystroke.
- **Semantics:** `role="grid"` with `aria-rowcount`/`aria-colcount`, cards as `gridcell`s, selection via `aria-selected`, checkboxes with accessible names, decorative thumbnails `aria-hidden`.
- **Focus visible** throughout; `prefers-reduced-motion` respected.
- **How tested:** the headless smoke script drives the whole keyboard path (arrows, Space, Enter, Escape, focus-in/focus-out assertions) and asserts results; I also manually tabbed/arrowed through the app in Edge. **I did not run a screen reader** — semantics were built to the ARIA grid pattern and verified via accessibility-tree inspection, but I am not claiming an NVDA/VoiceOver pass.

## Task 6 — Interface

- **A token system** in `styles.css` (colour, spacing, type, radius) drives everything; no one-off values in components.
- **Status reads as a progression** — draft → in review → approved → archived — via a consistent hue ladder plus an icon shape and label per status, so colour is never the only carrier.
- **States are designed:** skeletons that mirror the real card geometry (same 224 px minimum and gap, so swapping them for content is not a reflow), empty state with a clear-filters action, error state with retry, offline banner, and a bulk bar that shows progress, per-id failures with reasons, retry and undo.
- **Contrast was checked** against WCAG AA for all text/token pairs used (body text ≥ 7:1, secondary text ≥ 4.5:1, status pills ≥ 4.5:1 on their backgrounds).
- Works down to a narrow window: the toolbar wraps, the grid reflows to fewer columns, the detail panel overlays full-width.

## Assumptions and disagreements

- I interpreted "select everything currently loaded" literally — Ctrl+A selects loaded rows, not all 12,400; loading the entire library to select it would contradict the virtualization goal.
- The API's bulk endpoint caps at 50 ids per call; I kept that cap and parallelism at 3, trading total bulk wall-time for staying well clear of the rate limit (retries count against it).
- Single-asset PATCH is retryable per the API contract (`write_failed` 500), but I cap write retries at 2 to bound the window in which a user could re-apply an edit that actually succeeded.
- **One retry policy, in one layer.** Retries stay in the transport client and the QueryClient is configured with `retry: 0`. Two retry loops would multiply requests against a limiter where *retries count towards the budget*, and only the transport layer can read `Retry-After` and tell an unsafe write from a safe one.
- **`React.memo` was not enough for the cards**, which is why the memo wrapper in `lib/memo.ts` exists: `React.memo` only compares props while a component stays mounted, and virtualisation unmounts and remounts cards as you scroll. The wrapper caches the rendered element per asset so a card that scrolls back into view is reused rather than re-rendered.

## What I cut and why

- **Offline write queueing** — bonus item; detection/recovery shipped instead, and queueing mutations offline needs a durable log which is a project of its own.
- **SSE live updates and `/api/stats` prefetch** — optional list; correctness, scale, resilience and a11y carried more weight.
- **Formal test suite** — replaced by the smoke script targeting exactly the behaviours the brief cares about (races, scroll, keyboard, partial failure) against the real chaotic server.

## Clean-clone check

`npm install && npm run dev` was verified from a fresh clone of this repo with chaos on: health endpoint reports `{ ok: true, assets: 12400, chaos: true, latency: true }`, and the app renders, searches, paginates and bulk-edits correctly against it.

**Final pre-submission verification** (on the exact tree being submitted): `npm run typecheck` and `npm run build` both pass, and the full smoke script passes with zero page errors — initial list request succeeds on the first call (no aborted duplicate), the DOM stays bounded with 400+ rows loaded, lanes measure one width / one pitch / zero overlaps, a six-character search costs 1 read and a repeat costs 0, the keyboard path (arrows, Space, Enter, Escape, focus return, Ctrl+A) and the bulk partial-failure + undo flow all behave.

