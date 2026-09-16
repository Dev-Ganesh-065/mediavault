# API contract

Base URL `http://localhost:8787`, proxied to `/api` by Vite in dev.

All errors share one shape:

```json
{ "error": { "code": "stale_cursor", "message": "Human readable." } }
```

Branch on `code`, not on `message`. Every response carries `x-request-id`, which
is useful to log.

---

## `GET /api/assets`

| Param | Notes |
| --- | --- |
| `q` | Substring match on name and tags, case-insensitive |
| `status` | Comma-separated. `draft,in_review,approved,archived`. OR-ed |
| `kind` | Comma-separated. `image,video,document`. OR-ed |
| `tag` | Comma-separated. **AND**-ed — an asset must have all of them |
| `collectionId` | Single value |
| `owner` | Owner id, e.g. `u_03` |
| `sort` | `updatedAt`, `createdAt`, `name`, `sizeBytes` + `:asc` or `:desc`. Default `updatedAt:desc`. Unknown field → `400` |
| `limit` | Default 24, silently capped at 50 |
| `cursor` | Opaque, from `nextCursor` |

```json
{
  "items": [ /* Asset */ ],
  "total": 945,
  "nextCursor": "eyJvIjoyNCwiZiI6..." | null
}
```

`total` is the count for the current filters, not the whole library.

**Cursors are bound to the query that produced them.** Reuse one after changing
any filter or the sort and you get `400 stale_cursor`. Drop the cursor whenever
the query changes.

Failure modes: `503 upstream_unavailable` on roughly 6% of calls, with
`Retry-After: 2`. Latency rises for broad queries and short `q` prefixes, so
responses can and do arrive out of order.

---

## `GET /api/assets/:id`

Returns one `Asset`, or `404 not_found`.

## `GET /api/assets/batch?ids=a_00001,a_00002`

```json
{ "items": [ /* Asset */ ], "missing": ["a_88888"] }
```

More than 25 ids → `400 too_many_ids`. Order of `items` is not guaranteed.

---

## `PATCH /api/assets/:id`

```json
{ "version": 3, "patch": { "status": "approved", "tags": ["hero"], "name": "New name" } }
```

`version` is required and must match the server's current value. All `patch`
fields are optional. Returns the updated `Asset` with an incremented `version`.

| Status | Code | Retry? |
| --- | --- | --- |
| 400 | `bad_request` | No |
| 409 | `version_conflict` | No — refetch first |
| 422 | `invalid_name` (< 3 chars), `invalid_status`, `invalid_tags`, `legal_hold` | No |
| 500 | `write_failed` | Yes, safe to retry |

Assets tagged `legal-hold` cannot be moved to `archived`.

---

## `POST /api/assets/bulk-status`

```json
{ "ids": ["a_00003", "a_00004"], "status": "in_review" }
```

Max 50 ids → otherwise `400 too_many_ids`. Does **not** take `version`.

Returns `200` when everything succeeded, `207` when some failed:

```json
{
  "applied": 1,
  "failed": 1,
  "results": [
    { "id": "a_00003", "ok": true, "asset": { /* Asset */ } },
    { "id": "a_00004", "ok": false, "code": "legal_hold", "message": "Asset is on legal hold." }
  ]
}
```

Per-item failure codes: `not_found`, `legal_hold` (deterministic — anything tagged
`legal-hold`), `conflict` (random, ~7%, retryable).

---

## `GET /api/thumb/:id.svg`

An SVG thumbnail, cacheable for an hour. Returns `404 thumbnail_missing` for the
~4% of assets where `hasThumbnail` is `false`. That flag is on every `Asset`, so
you can avoid the request — but a 404 should still degrade gracefully.

## `GET /api/facets`

`{ tags, owners, statuses, kinds }` — stable reference data, safe to cache hard.

## `GET /api/collections`

`{ items: [{ id, name }] }`

## `GET /api/stats`

Library-wide counts. Deliberately slow, over a second.

## `GET /api/events`

Server-sent events. Emits `asset.updated` roughly every 6 seconds while at least
one client is connected, with the full `Asset` as the payload. Bulk and single
writes also broadcast.

## `GET /api/health`

`{ ok, assets, chaos, latency }` — never rate limited or delayed.

---

## Asset

```ts
interface Asset {
  id: string;              // "a_00001"
  name: string;
  kind: 'image' | 'video' | 'document';
  status: 'draft' | 'in_review' | 'approved' | 'archived';
  tags: string[];
  collectionId: string;
  owner: { id: string; name: string };
  sizeBytes: number;
  width: number | null;     // null for documents
  height: number | null;
  durationSec: number | null; // videos only
  createdAt: string;        // ISO
  updatedAt: string;        // ISO
  version: number;
  hasThumbnail: boolean;
}
```

---

## Rate limiting

80 requests per rolling 10 second window, per client. Exceeding it returns `429`
with `Retry-After: 3`. Thumbnail requests are exempt. Everything else counts,
including retries — so a retry storm makes things worse, which is the point.

## Turning the chaos off

`CHAOS=0` disables failures and rate limiting. `LATENCY=0` disables delays. Useful
while building. Your submission must behave correctly with both on, which is how
we will run it.
