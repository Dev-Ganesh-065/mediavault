# Switchon — Senior Frontend Assessment

**MediaVault**, an internal media asset library.

You have a small React app that lists media assets from an API. It works when the
network is fast and the dataset is small. It is neither.

Your job is to make it hold up: correct under concurrency, fast at scale, usable
from a keyboard, honest when the backend misbehaves, and good enough looking that
someone would want to work in it all day.

---

## At a glance

| | |
| --- | --- |
| **Effort** | 10–14 focused hours, spread over up to 7 days |
| **You send back** | A public Git repo link + deployed link + a 5 minute video |
| **Also fill in** | `SUBMISSION.md` in the repo root — it is scored |
| **Doubts/Bugs** | Any questions can be asked via email to **karan@switchon.io** Asking is fine and costs you nothing |

**You are not expected to finish everything.** We would rather see four tasks done
to a standard you would defend in code review than seven done roughly. If you run
out of time, say what you cut and why — that is a scored answer, not an admission.

---

## What we are actually assessing

Worth reading before you start, because it explains why the tasks are shaped the
way they are.

1. **Can you reason about asynchrony?** Races, cancellation, de-duplication,
   retries. Most of this brief is a network problem wearing a UI costume.
2. **Do you measure, or do you guess?** Several tasks ask for numbers. We want
   before-and-after evidence, not adjectives.
3. **Do you handle the unhappy path as a first-class case?** Partial failures,
   conflicts, offline. The happy path is the easy half.
4. **Is it usable without a mouse?** One of the people in the brief is not
   optional.
5. **Can you make deliberate interface decisions and execute them?** Not
   decoration — judgement.
6. **Can you explain your own code?** You will do exactly that, live, in the next
   round.

What we are **not** assessing: how many features you can add, how fashionable
your stack is, or how much of the brief you can cover shallowly.

---

## Setup

```bash
node --version   # must be 20.11 or newer
npm install
npm run dev
```

That starts two things:

- **App** — http://localhost:5173
- **Mock API** — http://localhost:8787/api/health

**Check it works.** Open the health endpoint; you should see:

```json
{ "ok": true, "assets": 12400, "chaos": true, "latency": true }
```

No network access is needed after `npm install`. The API is a zero-dependency
Node server in `server/` seeded with 12,400 assets. The dataset is deterministic,
so your machine and ours show the same rows — if you mention `a_04136` in your
video, we can go and look at it.

### The API is deliberately hostile

This is the point of the exercise, not an accident. By default it adds latency,
fails intermittently, and rate limits you.

| Behaviour | Detail | Why it is there |
| --- | --- | --- |
| **Latency** | 90–350ms baseline; broad queries and short `q` prefixes are **slower** than narrow ones | Makes responses arrive out of order, so search races are reproducible rather than theoretical |
| **Flaky reads** | ~6% of `GET /api/assets` return `503` with `Retry-After: 2` | You need retries |
| **Flaky writes** | ~12% of single-asset `PATCH` return `500` | You need retries that know which failures are safe to repeat |
| **Rate limit** | 80 requests per rolling 10s window → `429` with `Retry-After: 3`. **Retries count towards it** | A retry storm makes things worse, which is the point |
| **Hard caps** | Bulk update ≤ 50 ids, batch fetch ≤ 25 ids | You have to chunk |
| **Conflicts** | `PATCH` requires the current `version`, returns `409` if stale | Someone else edited the row |
| **Partial success** | Bulk returns `207` with a per-id result array | "Did it work" is not a yes/no |
| **Missing thumbnails** | ~4% of assets have no rendered thumbnail and return `404` | Images fail; layouts should not |

While building, you may quieten it:

```bash
CHAOS=0 npm run dev:api     # no failures, no rate limit
LATENCY=0 npm run dev:api   # no artificial delay
```

> **Your submission must work with the defaults on.** We will run it that way.

**`API.md` is the full contract. Read it before you start.** Several tasks depend
on details that are only in there — the cursor rules and the per-item bulk
failure codes especially.

---

## The product brief

MediaVault is the internal library a brand team uses to find, review and approve
photo and video assets. The people using it are not patient:

- **A producer** searches for a shot by name or tag, scrolling for a long time
  before finding it. Losing scroll position or seeing results flicker between
  queries costs them real time.
- **A reviewer** sweeps through hundreds of assets, selecting many and moving them
  to **In review** or **Approved** in one action. They need to know instantly
  whether it worked, and exactly which ones did not.
- **One reviewer works entirely from the keyboard, with a screen reader.**
- **Everyone** is on office wifi that drops for 20 seconds at a time.

Each of those maps onto a task below. When a requirement seems fussy, it is
usually because one of these four people would notice.

---

## What is in the repo

```
server/            mock API — a fixed backend, do not modify
src/api/           naive fetch client
src/features/      naive list, grid and detail panel
src/lib/           types and formatters
API.md             the API contract — read this
SUBMISSION.md      fill this in — it is scored
```

**You own everything in `src/`,** markup and CSS included. Rewrite, restructure,
rename, delete. The file layout and the stylesheet are starting points, not
constraints. "I replaced this hook entirely" and "I threw out the CSS" are both
perfectly good answers — the inherited styling is deliberately plain and
unfinished, and the interface is in scope.

**Do not change `server/` or the API contract.** If you think an endpoint is
missing or badly designed, say so in `SUBMISSION.md` — that critique is worth
marks. Work around it in the client.

---

## How to approach this

Read `API.md`, then Task 0, then pick your order. If you run out of time, this is
the order we would protect — the earlier tasks carry more signal:

1. **Task 0** — the defect inventory. Cheap, and it shapes everything after it.
2. **Task 1** — search correctness. The densest task in the brief.
3. **Task 2** — scale.
4. **Task 3** — bulk actions and partial failure.
5. **Task 4** — resilience.
6. **Task 5** — keyboard and screen reader.
7. **Task 6** — interface and craft.

This is guidance, not a rule. A candidate who nails Tasks 0–3 and writes honestly
about skipping 4–6 does better than one who touches all seven lightly. Depth in
whichever tasks you choose beats coverage.

---

## Task 0 — Read the baseline critically

The code in `src/` contains **at least eight defects** spanning correctness,
performance and accessibility. Some are obvious, some only show up under latency
or at scale.

**Calibration example, free of charge:** `applyBulkStatus` in `App.tsx` sends
every selected id in one request, so it fails outright past 50 selections.

**Deliverable:** in `SUBMISSION.md`, list the defects you found and mark each as
**fixed**, **knowingly left**, or **out of scope**. We care more about the
inventory being sharp than long — a precise list of twelve beats a vague list of
thirty.

---

## Task 1 — Search and filtering that cannot show the wrong answer

Filtering, searching and sorting all hit the API. Make the pipeline correct.

**Required**

- Typing in the search box must never leave stale results on screen. **A slow
  response from an earlier query must not overwrite a newer one.**
- In-flight requests that no longer matter are **cancelled**, not just ignored.
- Requests are throttled or debounced so ordinary typing does not trip the rate
  limit. **State your chosen interval and why.**
- Query state (`q`, status, kind, tag, sort) lives in **the URL**. Reloading or
  sharing the URL restores the same view. Filter changes should not stack up as
  one history entry per keystroke.
- Identical concurrent requests are **de-duplicated** rather than sent twice.

**Also handle**

- Changing a filter while paginated must reset pagination. The API rejects a
  cursor issued for a different query with `400 stale_cursor` — **a user must
  never see that error.**
- Loading, empty and error states are distinguishable from each other. "No results
  for this filter" and "the request failed" must not look the same. The baseline
  gets this wrong; go and look at why.

**How to reproduce the race:** type `tra` and then quickly finish the phrase. The
API is much slower for short prefixes, so the `tra` response lands last. Watch the
baseline show you the wrong rows.

---

## Task 2 — A list that scales to the whole library

**Required**

- Infinite scrolling through the full filtered result set using **cursor
  pagination**.
- With 12,400 assets in view, memory and DOM size stay flat: **rendered node count
  is bounded by the viewport, not by how far the user has scrolled.** Hand-rolled
  or library-based virtualization are both fine.
- **Scroll position survives** opening and closing the detail panel, and survives
  a selection change.
- Thumbnails load lazily, and a missing one (`404`) renders a stable placeholder
  rather than a broken image or a layout shift. (`hasThumbnail` is on every asset.)
- **No layout shift as pages load.** Reserve space.

**Performance budget — measure, do not estimate**

| What | Target |
| --- | --- |
| Toggling selection on one card | Must not re-render the other cards. Show this with React DevTools Profiler or your own instrumentation |
| Sustained scroll with 5,000+ rows loaded | Stays smooth; no long tasks over 50ms |
| Production bundle, gzipped | Baseline is **48 kB**. No hard ceiling, but be ready to justify a large jump |

Record the numbers, **how you measured them**, and what you changed to get there.
Before-and-after evidence beats a claim. If a number is one you could not measure
reliably, say so — that is a better answer than a figure you cannot defend.

---

## Task 3 — Bulk actions with optimistic updates

A reviewer selects a large set and applies a status.

**Required**

- **Range selection:** click, shift-click to extend, and a way to select
  everything currently loaded. Selecting 500 assets must not make the UI stutter.
- The status change applies **optimistically** — the grid updates before the
  server confirms.
- Requests are **chunked** to respect the 50-id cap, with **bounded concurrency**.
  Do not fire 40 parallel requests.
- The endpoint returns **partial success**: `207` with a per-id result array.
  Assets tagged `legal-hold` always fail; a further ~7% fail randomly.
  **Roll back only the failures, keep the successes, and tell the user precisely
  which assets did not change and why.**
- Failures are **recoverable**: offer a retry for the failed subset, or an undo.
  Note that the two failure reasons want different treatment — one of them will
  never succeed on retry.
- Single-asset edits in the detail panel handle **`409 version_conflict`** — the
  row was changed underneath you. Decide what the right behaviour is and **justify
  it**. There is more than one defensible answer here; we care about the
  reasoning.

---

## Task 4 — Resilience

**Required**

- **Retry transient failures** (`503`, `429`, network error) with exponential
  backoff **and jitter**, honouring `Retry-After` when present. **Cap the
  attempts.**
- **Never retry what should not be retried:** `400`, `409`, `422`. Your client
  should make that distinction **structurally, not with string matching on error
  messages.**
- **Handle going offline:** detect it, stop hammering, tell the user, and recover
  when the connection returns. Queueing writes made while offline is a bonus, not
  a requirement — if you skip it, say so.
- An **error boundary** keeps a component-level failure from blanking the page,
  and offers a way back.
- **Errors reaching the user are actionable.** `429: Too many requests in the last
  10 seconds.` is a leaked implementation detail, not a message.

---

## Task 5 — Keyboard and screen reader support

**Required**

- The grid is fully operable by keyboard: **arrow keys** move between cards,
  **Enter** opens, **Space** toggles selection, **Shift+arrows** extend a range.
  Use a **roving tabindex** — 12,400 tab stops is not an answer.
- Opening the detail panel **moves focus into it**; closing **returns focus to the
  card that was open**. **Escape** closes it. No focus traps, and focus is never
  lost to a detached node when a row is removed by filtering.
- Result counts, bulk outcomes and errors are announced via a **live region**,
  without spamming a screen reader on every keystroke.
- **Semantics are real:** the grid has an appropriate role, selection state is
  exposed to assistive tech, checkboxes have accessible names, decorative
  thumbnails are not announced.
- **Visible focus everywhere.** Respect `prefers-reduced-motion` if you add motion.

Tell us in `SUBMISSION.md` how you tested this, including whether you actually ran
a screen reader. "I did not run one" is an acceptable answer; claiming a pass you
did not observe is not.

---

## Task 6 — Interface design and craft

The app currently looks like a wireframe. Make it something a reviewer would spend
a full day inside without irritation. We are not asking for a rebrand or a
portfolio piece — we are asking whether you can make deliberate interface
decisions and execute them cleanly.

**Required**

- **A coherent visual system** rather than a pile of one-off values: a small set
  of colour, spacing and type decisions applied consistently. If you use tokens or
  variables, we should be able to read your intent from them.
- **Clear hierarchy in the grid.** Status, name and selection state should be
  distinguishable at a glance while scanning hundreds of cards — including for
  someone who cannot separate red from green, so **colour must not be the only
  carrier of status**.
- **States designed, not defaulted:** loading, empty, error, offline, partial
  failure, and the bulk action bar. Each should be recognisable at a glance and
  tell the user what to do next. The four states of an asset (`draft`,
  `in review`, `approved`, `archived`) should **read as a progression**, not as
  four random colours.
- **Text contrast meets WCAG AA. Check it, don't estimate it.**
- Works down to a **narrow window** without breaking. Full mobile optimisation is
  not required; not collapsing into unusable overlap is.
- **Copy is part of the design.** `429: Too many requests` is not a message to a
  human. Rewrite what the user reads.

**Explicitly not required:** an illustration set, animation flourishes, a logo, a
dark mode, or a design tool file. **Restraint scores better here than decoration.**

**Deliverable:** three or four sentences in `SUBMISSION.md` on the interface
decisions you made and what you were optimising for. A screenshot or two in the
repo helps.

---

## Optional, if you have time left

Pick at most one or two. **Doing none of these costs you nothing.**

- **Live updates.** `GET /api/events` is a server-sent event stream emitting
  `asset.updated`. Reconcile it with your cache without clobbering local edits or
  jumping the user's scroll position.
- **Tests.** If you write any, target the concurrency and rollback logic rather
  than snapshotting markup. A handful of sharp tests helps you; broad shallow
  coverage does not.
- **A `/api/stats` header.** It takes over a second. Make it not block anything.

---

## Rules

### Libraries

**Allowed, and using a well-chosen one is a positive signal** — we want to see
what you reach for and why:

- Data fetching or caching — TanStack Query, SWR, RTK Query
- State — Zustand, Jotai, Redux, XState
- Virtualization — TanStack Virtual, react-window, react-virtuoso
- A router, testing tools, and any styling approach you are fast in: plain CSS,
  CSS modules, Tailwind, vanilla-extract

**Not allowed**, because they solve exactly what we are assessing:

- A prebuilt data grid or table component (AG Grid, MUI DataGrid, Ant Table,
  TanStack Table's UI) for the asset list
- Prebuilt dialog or panel components for the detail view

Headless primitives for focus management are fine **if you say so** in
`SUBMISSION.md`.

Writing something yourself instead of reaching for a library is equally valid —
just tell us why.

### AI assistants

**Allowed. We assume you use them.** But you will walk us through this code and extend it live, 
so **do not ship anything you cannot
explain, defend, or debug.** Unexplained code is the fastest way to fail this
stage.

### Scope discipline is part of the test

Do not add features nobody asked for, and do not migrate to a different framework.
Design effort belongs on the screens the tasks already cover — not on a landing
page, a settings screen, or a dark mode nobody asked for.

---

## What to submit

1. **A public Git repo link** (GitHub, GitLab, whatever) with **real commit
   history**. Please do not squash everything into one commit — we read the
   history. A **deployed link** will be appreciated. 
2. **`SUBMISSION.md` filled in**, in the repo root. The template is already there.
3. **A 5 minute video walkthrough** — Loom, or any screen recording with a
   shareable link. Put the link at the top of `SUBMISSION.md` as well as in your
   reply, so it does not get lost.
4. **Confirm `npm install && npm run dev` works from a clean clone with chaos on.**
   Please actually clone it somewhere fresh and check.

### The video

Talk us through your work with the app and the code on screen. Keep it to ten
minutes — we will stop watching at twelve, and a tight eight beats a rambling
fifteen.

- **Demo it (2 min).** Drive the app **with chaos on**. Show the search race
  handled, a bulk action with a partial failure, and the keyboard path through the
  grid. Show us the thing you are proudest of working.
- **Walk the code (2 min).** Two or three decisions, **not a file tour**. Where
  does a keystroke go, and what stops a stale response landing? Where does
  optimistic state live, and how does a rollback find it? Why that library, or why
  not one?
- **Close it out (1–2 min).** What you cut, what you would do next, and anything
  you are unsure about.

No production values needed. Unedited, one take, a stumble or two — completely
fine. We are listening for how you reason about your own decisions, and it is a
faster read for us than guessing from a diff. It also means the live session
starts from where you left off rather than from scratch.

---

## Before you send it

- [ ] `npm install && npm run dev` works from a **fresh clone**, with chaos on
- [ ] The app does not crash or show a raw error string during normal use
- [ ] `SUBMISSION.md` is filled in, including the defect inventory and real
      measured numbers
- [ ] Commit history is readable and not squashed into one commit
- [ ] Video recorded, link in `SUBMISSION.md` **and** in your reply
- [ ] Anything you cut is written down, with the reason
- [ ] You can explain every file in `src/`

---

## FAQ

**Do I have to complete all seven tasks?**
No, and most people will not. Depth beats coverage. Say what you skipped.

**Can I delete or rewrite the code you gave me?**
All of `src/`, yes — including the stylesheet. `server/` and `API.md`, no.

**Something in the brief is ambiguous. What do I do?**
Make a reasonable call, note the assumption in `SUBMISSION.md`, and keep moving.
You will not be penalised for a defensible interpretation. Asking us is also fine.

**I disagree with one of the requirements.**
Say so in `SUBMISSION.md` and explain why. A well-argued disagreement is a good
signal, not a bad one. Do the work anyway or explain why you did not.

**Do I need to write tests?**
No. They are optional and only help if they are sharp.

**Do I need design mockups or a Figma file?**
No. We assess the running interface, not artefacts about it.

**Is the video really required?**
Yes. It is the fastest way for us to understand your reasoning, and it means the
live session starts where you left off.

**How much does the visual design matter relative to the engineering?**
Both are assessed. Task 6 is real, but restraint executed well beats ambition
executed badly — and it is last in the suggested order for a reason.

**Can I spend more than 14 hours on it?**
Please do not. If the work is taking much longer, cut scope and tell us what you
cut. Knowing what to leave out is part of what we are looking at.

---

Send the submission email with your **repo link**, **deployed link** and **video link** when you are
done to **karan@switchon.io** and cc the following: **abhijeet@switchon.io, ayush@switchon.io, tom@switchon.io, muskan@switchon.io**

 Good luck — and if you get stuck on something that turns out to be our bug
rather than yours, we would genuinely like to know.
