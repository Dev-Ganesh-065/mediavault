import type { Asset, AssetPage, AssetQuery, BulkResult } from '@/lib/types';

/* ------------------------------------------------------------------ *
 * HTTP client.
 *
 * Everything that is *transport* policy lives here, once, so every caller gets
 * the same behaviour:
 *   - retry with exponential backoff + full jitter, honouring Retry-After
 *   - never retry what must not be retried (400/409/422) — decided
 *     structurally from status + error code, never string matching
 *   - callers cancel in-flight and *queued* work via AbortSignal
 *
 * Everything that is *cache* policy — de-duplicating identical in-flight
 * reads, which response belongs to which query, refetching when data goes
 * stale or the network comes back — lives in TanStack Query instead (see
 * `queryClient.ts` and `useAssetList.ts`). Keeping the two apart is also what
 * keeps retries counted once: this client owns backoff, and the QueryClient
 * is configured with `retry: 0`.
 * ------------------------------------------------------------------ */

export type ApiErrorCode =
  | 'not_found'
  | 'stale_cursor'
  | 'bad_cursor'
  | 'bad_request'
  | 'too_many_ids'
  | 'version_conflict'
  | 'invalid_name'
  | 'invalid_status'
  | 'invalid_tags'
  | 'legal_hold'
  | 'write_failed'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'thumbnail_missing';

/** An error carrying enough structure for callers to act on. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly retryAfterMs: number | null;

  constructor(status: number, code: ApiErrorCode, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }

  /** Structural decision: is this failure safe to repeat? */
  get retryable(): boolean {
    if (this.status === 429 || this.status === 503) return true; // rate limit / upstream hiccup
    if (this.status === 500 && this.code === 'write_failed') return true; // API promises safe-to-retry
    return false; // 400, 409, 422, 404… never retry
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Request cancelled');
    this.name = 'CancelledError';
  }
}

function isAbortError(err: unknown): boolean {
  if (err instanceof CancelledError) return true;
  if (typeof DOMException !== 'undefined' && err instanceof DOMException) return err.name === 'AbortError';
  return false;
}

function retryAfterSeconds(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  return Number.isFinite(secs) ? Math.max(0, secs) : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new CancelledError());
    }, { once: true });
  });
}

const withJitter = (baseMs: number) => baseMs + Math.random() * baseMs;

const DEFAULT_RETRIES: Record<'read' | 'write', number> = { read: 3, write: 2 };

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  signal?: AbortSignal;
  /** Total attempts including the first (3 = initial + 2 retries). */
  attempts?: number;
}

async function baseFetch(path: string, opts: RequestOptions): Promise<Response> {
  const init: RequestInit = {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json' },
    signal: opts.signal,
  };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);

  // In production, use the VITE_API_URL env var set in Vercel.
  // Vite inlines this at build time, so it must be set in Vercel's env vars.
  const baseUrl = import.meta.env.VITE_API_URL;
  const url = baseUrl ? `${baseUrl}${path}` : path;

  const res = await fetch(url, init).catch((err: unknown) => {
    // fetch rejects with a DOMException AbortError when the caller's signal
    // fires mid-flight. Normalise it so every layer speaks one language.
    if (isAbortError(err)) throw new CancelledError();
    throw err;
  });
  if (res.ok) return res;

  let code: ApiErrorCode = 'bad_request';
  let message = await res.text().catch(() => '');
  try {
    const body = JSON.parse(message) as { error?: { code?: ApiErrorCode; message?: string } };
    if (body?.error?.code) code = body.error.code;
    if (body?.error?.message) message = body.error.message;
  } catch {
    /* non-JSON body — keep raw text */
  }
  throw new ApiError(res.status, code, message || `Request failed (${res.status})`, retryAfterSeconds(res));
}

async function requestWithRetry<T>(path: string, opts: RequestOptions): Promise<T> {
  const isWrite = opts.method !== undefined && opts.method !== 'GET';
  const attempts = opts.attempts ?? DEFAULT_RETRIES[isWrite ? 'write' : 'read'];
  let delayMs = 250;
  let lastErr: unknown = new Error('Unknown error');

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await baseFetch(path, opts);
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof CancelledError) throw err;
      if (err instanceof ApiError) {
        if (!err.retryable || attempt >= attempts) throw err;
        lastErr = err;
        const wait = err.retryAfterMs !== null ? err.retryAfterMs * 1000 : withJitter(delayMs);
        await sleep(wait, opts.signal);
      } else if (err instanceof TypeError) {
        // Network failure (DNS, connection refused, offline) — retry if we have attempts left.
        if (attempt >= attempts) throw err;
        lastErr = err;
        await sleep(withJitter(delayMs), opts.signal);
      } else {
        throw err;
      }
      delayMs *= 2;
    }
  }
  throw lastErr;
}

/**
 * One JSON request, with the retry policy above applied.
 *
 * De-duplication is *not* done here any more. Identical in-flight reads are
 * collapsed by the TanStack Query cache, which keys them by query key and
 * serves concurrent subscribers from a single request — and, unlike a
 * path-keyed map here, it also decides how long a result stays reusable.
 */
function httpJson<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return requestWithRetry<T>(path, opts);
}
/* Dev instrumentation: count real requests instead of guessing. */
export const __mvStats = { reads: 0, writes: 0, at: Date.now() };
try {
  (window as unknown as Record<string, unknown>).__mvStats = __mvStats;
} catch {
  /* non-browser */
}

function track<T>(p: Promise<T>, isWrite: boolean): Promise<T> {
  if (isWrite) __mvStats.writes += 1;
  else __mvStats.reads += 1;
  return p;
}

function toSearchParams(query: AssetQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.status?.length) params.set('status', query.status.join(','));
  if (query.kind?.length) params.set('kind', query.kind.join(','));
  if (query.tag?.length) params.set('tag', query.tag.join(','));
  if (query.collectionId) params.set('collectionId', query.collectionId);
  if (query.owner) params.set('owner', query.owner);
  if (query.sort) params.set('sort', query.sort);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  return params.toString();
}

export function listAssets(query: AssetQuery, signal?: AbortSignal): Promise<AssetPage> {
  return track(httpJson<AssetPage>(`/api/assets?${toSearchParams(query)}`, { signal }), false);
}

export function getAsset(id: string, signal?: AbortSignal): Promise<Asset> {
  return track(httpJson<Asset>(`/api/assets/${encodeURIComponent(id)}`, { signal }), false);
}

/** Fetch assets by id, honouring the 25-id cap by chunking. */
export async function getAssetsByIds(
  ids: string[],
  signal?: AbortSignal,
): Promise<{ items: Asset[]; missing: string[] }> {
  const out = { items: [] as Asset[], missing: [] as string[] };
  for (let i = 0; i < ids.length; i += 25) {
    const chunk = ids.slice(i, i + 25);
    const res = await track(
      httpJson<{ items: Asset[]; missing: string[] }>(`/api/assets/batch?ids=${chunk.join(',')}`, { signal }),
      false,
    );
    out.items.push(...res.items);
    out.missing.push(...res.missing);
  }
  return out;
}

export function updateAsset(
  id: string,
  version: number,
  patch: Partial<Pick<Asset, 'name' | 'status' | 'tags'>>,
  signal?: AbortSignal,
): Promise<Asset> {
  return track(
    httpJson<Asset>(`/api/assets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { version, patch },
      signal,
    }),
    true,
  );
}

export function bulkSetStatus(
  ids: string[],
  status: Asset['status'],
  signal?: AbortSignal,
): Promise<BulkResult> {
  return track(
    httpJson<BulkResult>('/api/assets/bulk-status', {
      method: 'POST',
      body: { ids, status },
      signal,
    }),
    true,
  );
}

/** Run `work` over chunks of `size`, at most `concurrency` chunks in flight. */
export async function runChunked<T, R>(
  items: T[],
  size: number,
  concurrency: number,
  work: (chunk: T[], index: number) => Promise<R>,
): Promise<R[]> {
  const chunkCount = Math.max(1, Math.ceil(items.length / size));
  const results: R[] = new Array<R>(chunkCount);
  let next = 0;
  const workerCount = Math.min(concurrency, chunkCount);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < chunkCount) {
      const index = next;
      next += 1;
      const chunk = items.slice(index * size, (index + 1) * size);
      results[index] = await work(chunk, index);
    }
  });
  await Promise.all(workers);
  return results;
}

export const thumbnailUrl = (id: string) => `/api/thumb/${id}.svg`;