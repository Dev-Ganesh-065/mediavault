import http from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  assets, COLLECTIONS, ALL_TAGS, ALL_OWNERS, ASSET_STATUSES, ASSET_KINDS, thumbColors,
} from './data.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const CHAOS = process.env.CHAOS !== '0';
const LATENCY = process.env.LATENCY !== '0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chance = (p) => CHAOS && Math.random() < p;

/* ------------------------------------------------------------------ *
 * Latency model
 * Broad queries are slower than narrow ones, which is realistic and
 * also means responses can arrive out of the order they were sent.
 * ------------------------------------------------------------------ */
function latencyFor(pathname, query) {
  if (!LATENCY) return 0;
  let ms = 90 + Math.random() * 260;
  if (pathname === '/api/assets') {
    const q = (query.get('q') ?? '').trim();
    if (q.length === 0) ms += 180;
    else if (q.length <= 2) ms += 700; // short prefix => slow
    else if (q.length <= 4) ms += 320;
    if (query.get('cursor')) ms *= 0.7;
  }
  if (pathname === '/api/stats') ms += 1100;
  if (pathname.startsWith('/api/thumb/')) ms = 40 + Math.random() * 220;
  return Math.round(ms);
}

/* ------------------------------------------------------------------ *
 * Rate limiting: 80 requests per 10s window, thumbnails exempt.
 * ------------------------------------------------------------------ */
const WINDOW_MS = 10_000;
const MAX_IN_WINDOW = 80;
const hits = new Map();

function rateLimited(ip) {
  if (!CHAOS) return false;
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  hits.set(ip, list);
  return list.length > MAX_IN_WINDOW;
}

/* ------------------------------------------------------------------ *
 * Cursors are opaque and bound to the query they were issued for.
 * Reusing a cursor after changing filters or sort is a 400.
 * ------------------------------------------------------------------ */
function fingerprint(query) {
  const parts = ['q', 'status', 'kind', 'tag', 'collectionId', 'owner', 'sort']
    .map((k) => `${k}=${(query.get(k) ?? '').trim().toLowerCase()}`);
  return Buffer.from(parts.join('&')).toString('base64url');
}
const encodeCursor = (offset, fp) =>
  Buffer.from(JSON.stringify({ o: offset, f: fp })).toString('base64url');
function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed.o !== 'number' || typeof parsed.f !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Query
 * ------------------------------------------------------------------ */
const csv = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function queryAssets(query) {
  const q = (query.get('q') ?? '').trim().toLowerCase();
  const statuses = csv(query.get('status'));
  const kinds = csv(query.get('kind'));
  const tags = csv(query.get('tag'));
  const collectionId = query.get('collectionId') ?? '';
  const owner = query.get('owner') ?? '';

  let rows = [...assets.values()];
  if (q) {
    rows = rows.filter(
      (a) => a.name.toLowerCase().includes(q) || a.tags.some((t) => t.includes(q)),
    );
  }
  if (statuses.length) rows = rows.filter((a) => statuses.includes(a.status));
  if (kinds.length) rows = rows.filter((a) => kinds.includes(a.kind));
  if (tags.length) rows = rows.filter((a) => tags.every((t) => a.tags.includes(t)));
  if (collectionId) rows = rows.filter((a) => a.collectionId === collectionId);
  if (owner) rows = rows.filter((a) => a.owner.id === owner);

  const sort = query.get('sort') ?? 'updatedAt:desc';
  const [field, dir] = sort.split(':');
  const sign = dir === 'asc' ? 1 : -1;
  const allowed = { updatedAt: 1, createdAt: 1, name: 1, sizeBytes: 1 };
  if (!allowed[field]) return { error: `Unsupported sort: ${sort}` };

  rows.sort((a, b) => {
    const x = a[field];
    const y = b[field];
    if (x === y) return a.id < b.id ? -1 : 1; // stable tiebreak
    return (x > y ? 1 : -1) * sign;
  });

  return { rows };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */
function send(res, status, body, headers = {}) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-request-id',
    'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS',
    'access-control-expose-headers': 'x-request-id,retry-after',
    'x-request-id': randomUUID(),
    ...headers,
  });
  res.end(payload);
}

const fail = (res, status, code, message, headers) =>
  send(res, status, { error: { code, message } }, headers);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) reject(new Error('Body too large'));
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

const VALID_STATUS = new Set(ASSET_STATUSES);
const touch = (asset) => {
  asset.version += 1;
  asset.updatedAt = new Date().toISOString();
};

/* ------------------------------------------------------------------ *
 * Server-sent events
 * ------------------------------------------------------------------ */
const sseClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

setInterval(() => {
  if (sseClients.size === 0) return;
  const ids = [...assets.keys()];
  const asset = assets.get(ids[Math.floor(Math.random() * ids.length)]);
  asset.status = ASSET_STATUSES[Math.floor(Math.random() * ASSET_STATUSES.length)];
  touch(asset);
  broadcast('asset.updated', asset);
}, 6000).unref();

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;
  const query = url.searchParams;
  const ip = req.socket.remoteAddress ?? 'local';

  if (req.method === 'OPTIONS') return send(res, 204, null);

  if (pathname === '/api/health') {
    return send(res, 200, { ok: true, assets: assets.size, chaos: CHAOS, latency: LATENCY });
  }

  // Long-lived stream: set up before any latency or rate-limit handling.
  if (pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
    });
    res.write('retry: 3000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (!pathname.startsWith('/api/thumb/') && rateLimited(ip)) {
    return fail(res, 429, 'rate_limited', 'Too many requests in the last 10 seconds.', {
      'retry-after': '3',
    });
  }

  await sleep(latencyFor(pathname, query));

  /* --- thumbnails ------------------------------------------------- */
  const thumbMatch = pathname.match(/^\/api\/thumb\/(a_\d{5})\.svg$/);
  if (thumbMatch && req.method === 'GET') {
    const asset = assets.get(thumbMatch[1]);
    if (!asset) return fail(res, 404, 'not_found', 'No such asset.');
    if (!asset.hasThumbnail) {
      return fail(res, 404, 'thumbnail_missing', 'This asset has no rendered thumbnail.');
    }
    const { a, b } = thumbColors(asset.id);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200" role="img" aria-label="${asset.kind}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="320" height="200" fill="url(#g)"/>
<text x="16" y="184" font-family="ui-monospace,monospace" font-size="13" fill="rgba(255,255,255,.82)">${asset.id}</text>
</svg>`;
    res.writeHead(200, {
      'content-type': 'image/svg+xml',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    });
    return res.end(svg);
  }

  /* --- reference data --------------------------------------------- */
  if (pathname === '/api/collections' && req.method === 'GET') {
    return send(res, 200, { items: COLLECTIONS });
  }
  if (pathname === '/api/facets' && req.method === 'GET') {
    return send(res, 200, {
      tags: ALL_TAGS,
      owners: ALL_OWNERS,
      statuses: ASSET_STATUSES,
      kinds: ASSET_KINDS,
    });
  }
  if (pathname === '/api/stats' && req.method === 'GET') {
    const byStatus = {};
    const byKind = {};
    let bytes = 0;
    for (const a of assets.values()) {
      byStatus[a.status] = (byStatus[a.status] ?? 0) + 1;
      byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
      bytes += a.sizeBytes;
    }
    return send(res, 200, { total: assets.size, byStatus, byKind, totalBytes: bytes });
  }

  /* --- batch fetch ------------------------------------------------ */
  if (pathname === '/api/assets/batch' && req.method === 'GET') {
    const ids = csv(query.get('ids'));
    if (ids.length === 0) return fail(res, 400, 'bad_request', 'ids is required.');
    if (ids.length > 25) {
      return fail(res, 400, 'too_many_ids', 'Request at most 25 ids per call.');
    }
    const items = ids.map((id) => assets.get(id)).filter(Boolean);
    const missing = ids.filter((id) => !assets.has(id));
    return send(res, 200, { items, missing });
  }

  /* --- list ------------------------------------------------------- */
  if (pathname === '/api/assets' && req.method === 'GET') {
    if (chance(0.06)) {
      return fail(res, 503, 'upstream_unavailable', 'Search index is warming up.', {
        'retry-after': '2',
      });
    }

    const limit = Math.min(Number(query.get('limit') ?? 24) || 24, 50);
    const fp = fingerprint(query);
    let offset = 0;
    const cursor = query.get('cursor');
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) return fail(res, 400, 'bad_cursor', 'Cursor could not be decoded.');
      if (decoded.f !== fp) {
        return fail(
          res, 400, 'stale_cursor',
          'This cursor was issued for a different query. Start again without a cursor.',
        );
      }
      offset = decoded.o;
    }

    const { rows, error } = queryAssets(query);
    if (error) return fail(res, 400, 'bad_request', error);

    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return send(res, 200, {
      items: page,
      total: rows.length,
      nextCursor: nextOffset < rows.length ? encodeCursor(nextOffset, fp) : null,
    });
  }

  /* --- bulk status ------------------------------------------------ */
  if (pathname === '/api/assets/bulk-status' && req.method === 'POST') {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return fail(res, 400, 'bad_request', e.message);
    }
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const status = body.status;
    if (!VALID_STATUS.has(status)) {
      return fail(res, 422, 'invalid_status', `status must be one of ${ASSET_STATUSES.join(', ')}.`);
    }
    if (ids.length === 0) return fail(res, 400, 'bad_request', 'ids must not be empty.');
    if (ids.length > 50) {
      return fail(res, 400, 'too_many_ids', 'Update at most 50 assets per call.');
    }

    const results = ids.map((id) => {
      const asset = assets.get(id);
      if (!asset) return { id, ok: false, code: 'not_found' };
      if (asset.tags.includes('legal-hold')) {
        return { id, ok: false, code: 'legal_hold', message: 'Asset is on legal hold.' };
      }
      if (chance(0.07)) return { id, ok: false, code: 'conflict', message: 'Write conflict.' };
      asset.status = status;
      touch(asset);
      broadcast('asset.updated', asset);
      return { id, ok: true, asset };
    });

    const failed = results.filter((r) => !r.ok).length;
    return send(res, failed === 0 ? 200 : 207, {
      results,
      applied: results.length - failed,
      failed,
    });
  }

  /* --- single asset ----------------------------------------------- */
  const idMatch = pathname.match(/^\/api\/assets\/(a_\d{5})$/);
  if (idMatch) {
    const asset = assets.get(idMatch[1]);
    if (!asset) return fail(res, 404, 'not_found', 'No such asset.');

    if (req.method === 'GET') return send(res, 200, asset);

    if (req.method === 'PATCH') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        return fail(res, 400, 'bad_request', e.message);
      }
      if (typeof body.version !== 'number') {
        return fail(res, 400, 'bad_request', 'version is required.');
      }
      if (body.version !== asset.version) {
        return fail(res, 409, 'version_conflict', 'Asset changed since you loaded it.', {});
      }
      if (chance(0.12)) {
        return fail(res, 500, 'write_failed', 'Write failed. Safe to retry.');
      }

      const patch = body.patch ?? {};
      if (patch.name !== undefined) {
        if (typeof patch.name !== 'string' || patch.name.trim().length < 3) {
          return fail(res, 422, 'invalid_name', 'name must be at least 3 characters.');
        }
        asset.name = patch.name.trim();
      }
      if (patch.status !== undefined) {
        if (!VALID_STATUS.has(patch.status)) {
          return fail(res, 422, 'invalid_status', 'Unknown status.');
        }
        if (asset.tags.includes('legal-hold') && patch.status === 'archived') {
          return fail(res, 422, 'legal_hold', 'Assets on legal hold cannot be archived.');
        }
        asset.status = patch.status;
      }
      if (patch.tags !== undefined) {
        if (!Array.isArray(patch.tags) || patch.tags.some((t) => typeof t !== 'string')) {
          return fail(res, 422, 'invalid_tags', 'tags must be an array of strings.');
        }
        asset.tags = [...new Set(patch.tags.map((t) => t.trim()).filter(Boolean))];
      }

      touch(asset);
      broadcast('asset.updated', asset);
      return send(res, 200, asset);
    }
  }

  return fail(res, 404, 'not_found', `No route for ${req.method} ${pathname}`);
});

server.listen(PORT, () => {
  console.log(`mock api  →  http://localhost:${PORT}/api/health`);
  console.log(`chaos: ${CHAOS ? 'on' : 'off'}   latency: ${LATENCY ? 'on' : 'off'}`);
});
