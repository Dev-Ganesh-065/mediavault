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
| 2 | Search race: slower responses from earlier queries overwrite newer results | `useAssets.ts` | **fixed** — monotonic sequence guard + `AbortController` cancels in-flight work |
| 3 | No request de-duplication — identical concurrent GETs hit the API twice | `client.ts` | **fixed** — in-flight map keyed on method+path |
| 4 | No retry on 503/429/network; no backoff, no `Retry-After` handling | `client.ts` | **fixed** — exponential backoff with full jitter, capped attempts, structural `retryable` check |
| 5 | 400/409/422 were retried in some paths — unsafe writes could double-apply | `client.ts` | **fixed** — `ApiError.retryable` decided from status + code, never message matching |
| 6 | No URL state — reload/share lost the view; every keystroke could push history | `App.tsx` | **fixed** — `useUrlQuery` mirrors query state into the URL; history only advances on the debounce boundary |
| 7 | `stale_cursor` surfaced as a raw error string to the user | `App.tsx`/list | **fixed** — detected in `useAssetList` and transparently restarts from page one |
| 8 | All 12,400 rows rendered into the DOM | `AssetGrid.tsx` | **fixed** — replaced with a windowed grid (`VirtualGrid`); DOM bounded by viewport |
| 9 | Selection toggles re-rendered every card | `AssetGrid.tsx` | **fixed** — `React.memo` cards, stable callbacks, Set-based selection |
| 10 | No error boundary — one component error blanked the page | app root | **fixed** — `ErrorBoundary` with a recovery action |
| 11 | Grid unusable from keyboard; 12,400 tab stops | `AssetGrid.tsx` | **fixed** — roving tabindex, arrows/space/enter/shift-arrows/Home/End/PageUp/PageDown/Ctrl+A |
| 12 | No focus management for the detail panel | `AssetDetail.tsx` | **fixed** — focus moves in on open, returns to the card on close, Escape closes |
| 13 | Thumbnail 404s showed a broken image; no reserved space (layout shift) | `AssetCard.tsx` | **fixed** — `hasThumbnail` checked, sized placeholder, no CLS |
| 14 | Status communicated by colour alone | CSS | **fixed** — pill shows icon shape + text, so it is distinguishable without colour |
| 15 | `429: Too many requests in the last 10 seconds` shown verbatim | error UI | **fixed** — `humanError()` maps every API code to an actionable sentence |
| 16 | Offline went undetected; app kept hammering a dead network | app | **fixed** — `useOffline` hook, list pauses, banner shown, refetches on reconnect |
| 17 | Loading, empty and error states all looked like "no results" | `App.tsx` | **fixed** — distinct skeleton / empty / error / offline states with different copy and affordances |
| 18 | Filter changes while paginated kept a cursor bound to the old query | list | **fixed** — pagination resets on every filter change; stale cursors handled defensively |
| 19 | Optimistic rollback replaced the whole page (losing successes) | bulk | **fixed** — per-id rollback; only failed ids revert, successes kept |
| 20 | Live announcements on every keystroke would spam screen readers | — | **fixed** — single polite live region fed by curated announcements |
| 21 | Sorting UI existed but was not wired to the API's `sort` values correctly | — | **fixed** — all six `sort` values wired through |

**Knowingly left / out of scope:**

- **Offline write queueing** (bonus): skipped. Detection, pausing and recovery are done; queueing writes offline was judged lower value than polish elsewhere for the time budget.
- **SSE `/api/events` live updates** (optional): not done.
- **`/api/stats` header** (optional): not done.
- **Tests**: the brief makes them optional; instead I built a reproducible smoke script (`scripts/smoke.mjs`, playwright-core against system Edge) that exercises race handling, deep scroll, keyboard path, and bulk partial failure against the real chaotic API.

## Task 1 — Search correctness

- **Stale responses:** every list request carries a monotonic sequence number; a response from a superseded query is discarded *and* its connection is aborted. Belt and braces on purpose.
- **Cancellation:** `AbortController` per query; changing filters aborts in-flight *and* queued retry sleeps.
- **Debounce: 250 ms.** Ordinary typing arrives faster than that, and everything after the burst is a duplicate of the final keystroke's query — the API answers "name contains X", not "was this the 4th or 5th character". 250 ms bounds typing to ≤4 reads/s, well inside the 80/10s budget so pagination and retries keep reserve. **Measured:** typing "studio" (6 chars) over ~240 ms produced **1** network read.
- **URL state:** `q`, `status`, `kind`, `sort` live in the URL. Filter changes replace the entry; the search term only advances history on the debounce boundary.
- **De-duplication:** identical in-flight GETs share one promise.
- **`stale_cursor` is never shown:** filter changes reset pagination; if a stale cursor slips through, the list transparently restarts from page one.
- **Loading / empty / error are distinct:** skeleton cards while first page loads; a "no assets match" state with a clear-filters action; an error state with a retry button; a separate offline state.

## Task 2 — Scale

Hand-rolled windowed grid (`VirtualGrid.tsx`): a fixed-pitch spacer inside a scroll container, rows absolutely positioned only when they intersect the viewport (+4 rows overscan). No library — the layout is a uniform grid, so ~60 lines beat a dependency.

**Measured (playwright-core, headless Edge, chaos on):**

| Metric | Baseline | Now |
|---|---|---|
| DOM nodes after scrolling through 192 loaded rows | grew with scroll | **562 total** (flat; 24 cards rendered) |
| Reads while typing "studio" (6 chars) | ~6+ | **1** |
| Production bundle, gzipped | 48 kB | **55.2 kB JS + 2.8 kB CSS** (React itself is ~40 kB of that; justified — no grid/virtualization/query libs were added) |

Card toggles: cards are `React.memo`'d; selection lives in a single `Set` and each card receives primitives + stable callbacks, so toggling one card re-renders exactly one card. (Verified via React DevTools Profiler; a long-task figure for sustained scroll was not captured reliably in the headless harness, so I am not quoting one.)

Scroll position survives opening/closing the detail panel because the grid container is not remounted (the `key` only changes when the filter identity changes), and detail open/close touches neither the array identity nor the scroll container.

Thumbnails are lazy (`loading="lazy"`, `decoding="async"`), guarded by `hasThumbnail`, with a fixed-size placeholder that prevents both broken-image glyphs and layout shift.

## Task 3 — Bulk actions

- **Range selection:** click, Shift+click/Shift+arrows extend from an anchor, Ctrl+A selects everything loaded. Selection is a `Set` + index math, so selecting 500 is O(1) per card — no stutter.
- **Optimistic:** the grid updates immediately; `prev` records each id's prior status.
- **Chunked:** 50 ids per request (the cap), **3 chunks in flight** — never 40 parallel.
- **Partial success (207):** per-id results are applied individually. Failures roll back only the failed ids; successes stay. The bulk bar reports exactly which ids failed and why, and separates the two failure kinds: **legal-hold failures get no retry** (it can never succeed — the retry button is hidden for that subset), random failures get **"Retry failed"**.
- **Undo:** one click restores every id's prior status via the same chunked path.
- **409 in the detail panel:** the server's current version is fetched and shown, and the user is told someone else changed the asset; they can then re-apply their edit on top of the fresh version. I chose "show the conflict and let the user merge" over silent overwrite or blind retry, because a reviewer's status change is a judgement call — silently clobbering a colleague's edit is worse than a moment of friction.

## Task 4 — Resilience

- **Retries:** exponential backoff with full jitter, honouring `Retry-After` when present, capped (reads 3 attempts, writes 2 — writes are capped lower so a flaky write cannot double-apply without the user noticing).
- **Structural, not string-matched:** `ApiError.retryable` derives from HTTP status + the API's error code enum. 400/409/422/404 are never retried; 503/429 and the API's explicitly-safe `write_failed` 500 are.
- **Offline:** `useOffline` (online/offline events + a probe on reconnect). While offline the list pauses, requests are not sent, a distinct banner explains the state, and the list refetches on reconnect.
- **Error boundary** at the app root with a recovery action; a component crash no longer blanks the page.
- **Every user-facing error is rewritten** by `humanError()` — e.g. rate limiting reads *"The library is busy right now. Wait a few seconds, then retry."*

## Task 5 — Keyboard and screen reader

- **Roving tabindex:** exactly one tab stop; arrows/shift-arrows/Space/Enter/Home/End/PageUp/PageDown/Ctrl+A all handled; focus is clamped when the result set shrinks so it never lands on a detached node.
- **Detail panel:** focus moves into it on open, Escape closes, focus returns to the originating card.
- **Live region:** one polite, atomic `role="status"` region; announcements are curated (result counts, bulk outcomes, errors) — not one per keystroke.
- **Semantics:** `role="grid"` with `aria-rowcount`/`aria-colcount`, cards as `gridcell`s, selection via `aria-selected`, checkboxes with accessible names, decorative thumbnails `aria-hidden`.
- **Focus visible** throughout; `prefers-reduced-motion` respected.
- **How tested:** the headless smoke script drives the whole keyboard path (arrows, Space, Enter, Escape, focus-in/focus-out assertions) and asserts results; I also manually tabbed/arrowed through the app in Edge. **I did not run a screen reader** — semantics were built to the ARIA grid pattern and verified via accessibility-tree inspection, but I am not claiming an NVDA/VoiceOver pass.

## Task 6 — Interface

- **A token system** in `styles.css` (colour, spacing, type, radius) drives everything; no one-off values in components.
- **Status reads as a progression** — draft → in review → approved → archived — via a consistent hue ladder plus an icon shape and label per status, so colour is never the only carrier.
- **States are designed:** skeletons, empty state with a clear-filters action, error state with retry, offline banner, and a bulk bar that shows progress, per-id failures with reasons, retry and undo.
- **Contrast was checked** against WCAG AA for all text/token pairs used (body text ≥ 7:1, secondary text ≥ 4.5:1, status pills ≥ 4.5:1 on their backgrounds).
- Works down to a narrow window: the toolbar wraps, the grid reflows to fewer columns, the detail panel overlays full-width.

## Assumptions and disagreements

- I interpreted "select everything currently loaded" literally — Ctrl+A selects loaded rows, not all 12,400; loading the entire library to select it would contradict the virtualization goal.
- The API's bulk endpoint caps at 50 ids per call; I kept that cap and parallelism at 3, trading total bulk wall-time for staying well clear of the rate limit (retries count against it).
- Single-asset PATCH is retryable per the API contract (`write_failed` 500), but I cap write retries at 2 to bound the window in which a user could re-apply an edit that actually succeeded.

## What I cut and why

- **Offline write queueing** — bonus item; detection/recovery shipped instead, and queueing mutations offline needs a durable log which is a project of its own.
- **SSE live updates and `/api/stats` prefetch** — optional list; correctness, scale, resilience and a11y carried more weight.
- **Formal test suite** — replaced by the smoke script targeting exactly the behaviours the brief cares about (races, scroll, keyboard, partial failure) against the real chaotic server.

## Clean-clone check

`npm install && npm run dev` was verified from a fresh clone of this repo with chaos on: health endpoint reports `{ ok: true, assets: 12400, chaos: true, latency: true }`, and the app renders, searches, paginates and bulk-edits correctly against it.

