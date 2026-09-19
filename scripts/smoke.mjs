/* Dev-only smoke test using the system Edge via playwright-core. */
import { chromium } from 'playwright-core';

const BASE = process.env.BASE ?? 'http://localhost:5173';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch() {
  return chromium.launch({ channel: 'msedge', headless: true });
}

async function main() {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`);
  });

  const SAFETY = setTimeout(() => {
    console.error('SMOKE TIMEOUT', errors);
    process.exit(2);
  }, 180000);

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  try {
    // Wait for a real card, not a skeleton: `.card--skeleton` shares the
    // `.card` class, so waiting on `.grid .card` can pass during the loading
    // state and make the "initial grid renders" assertion meaningless.
    await page.waitForSelector('.grid__cell [role="gridcell"]', { timeout: 20000 });
  } catch {
    const body = await page.evaluate(() => {
      var root = document.getElementById('root');
      return (root ? root.innerHTML : 'NO ROOT').slice(0, 1500);
    });
    console.error('CARDS NOT FOUND. Root innerHTML:', body);
    console.error('Errors so far:', errors);
    throw new Error('cards not rendered');
  }

  // 1) Initial grid renders.
  const cardCount = await page.locator('[role="gridcell"]').count();
  const skeletons = await page.locator('.card--skeleton').count();
  const cells = await page.locator('.grid__cell').count();
  console.log(
    `initial cells rendered: ${cells} | gridcells: ${cardCount} | skeletons: ${skeletons}`,
  );

  // 2) Scroll until plenty of rows are loaded. Each tick alternates between the
  //    bottom and slightly above it: assigning the *same* scrollTop fires no
  //    scroll event, so a harness that only ever pushes +Npx goes dead the
  //    moment it is pinned at the bottom. Pages arrive slowly here (latency,
  //    plus 503 retries honouring Retry-After), so this is time-boxed.
  const SCROLL_BUDGET_MS = 40000;
  const deadline = Date.now() + SCROLL_BUDGET_MS;
  let flip = false;
  while (Date.now() < deadline) {
    await page.evaluate((atBottom) => {
      const el = document.querySelector('.grid');
      if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = atBottom ? Math.max(0, max - 500) : max;
    }, flip);
    flip = !flip;
    await sleep(140);
    const loaded = await page.evaluate(() => {
      const t = document.querySelector('.filters__count')?.textContent ?? '';
      return Number((t.match(/([\d,]+) of /)?.[1] ?? '0').replace(/,/g, ''));
    });
    if (loaded >= 400) break;
  }
  await sleep(1500);

  // 3) Windowing: DOM size must be bounded by the viewport, never by how many
  //    rows are loaded. `rendered` counts cards actually mounted.
  const tally = await page.evaluate(() => {
    const el = document.querySelector('.grid');
    const totalText = document.querySelector('.filters__count')?.textContent ?? '';
    const match = totalText.match(/([\d,]+) of ([\d,]+)/) || [];
    return {
      scrollHeight: el ? el.scrollHeight : 0,
      shown: Number((match[1] ?? '0').replace(/,/g, '')),
      of: match[2] ?? '?',
      rendered: document.querySelectorAll('.grid__cell').length,
      domNodes: document.querySelectorAll('*').length,
    };
  });
  console.log('after deep scroll:', JSON.stringify(tally));
  console.log(
    `WINDOWING: ${tally.shown} rows loaded | ${tally.rendered} cards mounted | ${tally.domNodes} DOM nodes`,
  );
  if (tally.shown <= 72) {
    console.log('WINDOWING: warning — too few rows loaded to prove bounding');
  } else if (tally.rendered > 150) {
    throw new Error(`DOM not bounded: ${tally.rendered} cards mounted for ${tally.shown} rows`);
  }

  // 3b) Lane geometry must reproduce a clean row-major grid — one width, one
  //     height, an exact row pitch, no overlaps, contiguous indices. This is
  //     what the arrow-key arithmetic assumes.
  const geometry = await page.evaluate(() => {
    const boxes = Array.from(document.querySelectorAll('.grid__cell'))
      .map((cell) => {
        const card = cell.querySelector('.card');
        const r = cell.getBoundingClientRect();
        return {
          index: Number(card?.getAttribute('data-index') ?? -1),
          top: Math.round(r.top),
          left: Math.round(r.left),
          width: Math.round(r.width),
        };
      })
      .sort((a, b) => a.index - b.index);

    const byTop = new Map();
    for (const b of boxes) {
      if (!byTop.has(b.top)) byTop.set(b.top, []);
      byTop.get(b.top).push(b);
    }
    const tops = [...byTop.keys()].sort((a, b) => a - b);
    const rows = tops.map((t) => byTop.get(t).sort((a, b) => a.left - b.left));
    let rowMajor = true;
    let overlaps = 0;
    for (let r = 0; r < rows.length; r += 1) {
      const row = rows[r];
      for (let i = 1; i < row.length; i += 1) {
        if (row[i].index !== row[i - 1].index + 1) rowMajor = false;
        if (row[i - 1].left + row[i - 1].width > row[i].left) overlaps += 1;
      }
      const next = rows[r + 1];
      const last = row[row.length - 1];
      if (next && next[0] && last && next[0].index !== last.index + 1) rowMajor = false;
    }
    return {
      cells: boxes.length,
      widths: [...new Set(boxes.map((b) => b.width))],
      pitches: [...new Set(tops.slice(1).map((t, i) => t - tops[i]))],
      rowMajor,
      overlaps,
    };
  });
  console.log('grid geometry:', JSON.stringify(geometry));
  if (!geometry.rowMajor || geometry.overlaps > 0 || geometry.widths.length !== 1) {
    throw new Error('lane layout is not a clean row-major grid');
  }

  // 4) Search race: type a short prefix then the full phrase fast.
  const readsBefore = await page.evaluate(() => window.__mvStats?.reads ?? -1);
  const search = page.locator('input[type="search"]');
  await search.fill('st');
  await search.type('udio', { delay: 40 });
  await sleep(2500);
  const readsAfter = await page.evaluate(() => window.__mvStats?.reads ?? -1);
  console.log('reads delta while typing 6 chars:', readsAfter - readsBefore);

  // 4b) Caching: an identical query already in the cache must not re-hit the
  //     network. This is the TanStack Query cache doing its job.
  await search.fill('');
  await sleep(2000);
  const readsBeforeRepeat = await page.evaluate(() => window.__mvStats?.reads ?? -1);
  await search.fill('studio');
  await sleep(2500);
  const readsAfterRepeat = await page.evaluate(() => window.__mvStats?.reads ?? -1);
  console.log('reads delta repeating an identical search:', readsAfterRepeat - readsBeforeRepeat);

  // Wait for results (rate-limit/503 storms retry on their own; give it room).
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const hasCard = await page.locator('.grid .card').count();
    if (hasCard > 0) break;
    await sleep(1500);
  }
  const firstNames = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="gridcell"] .card__name')).map((n) => n.textContent).slice(0, 6),
  );
  console.log('first results after typing "studio":', JSON.stringify(firstNames));

  // 5) Keyboard: arrow keys + space toggle + enter opens detail.
  await page.locator('.grid').focus();
  await page.keyboard.press('ArrowRight');
  await sleep(80);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-index') ?? 'none');
  console.log('focused card after ArrowRight:', focused);
  await page.keyboard.press('Space');
  const selCount = await page.evaluate(() => document.querySelectorAll('.card--selected').length);
  console.log('selected after Space:', selCount);
  await page.keyboard.press('Enter');
  await sleep(1200);
  const panelOpen = await page.locator('.panel').count();
  console.log('detail panel open:', panelOpen);
  const focusInPanel = await page.evaluate(() => document.activeElement?.closest('.panel') !== null);
  console.log('focus inside panel:', focusInPanel);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape'); // ensure closed
  await sleep(300);
  const panelClosed = await page.locator('.panel').count();
  console.log('panel closed via Escape:', panelClosed === 0);
  const focusBackToGrid = await page.evaluate(() => document.activeElement?.closest('.grid') !== null);
  console.log('focus returned to grid:', focusBackToGrid);

  // 6) Bulk: select all loaded (Ctrl+A), move to Approved, read the outcome.
  await page.locator('.grid').focus();
  await page.keyboard.press('Control+a');
  await sleep(400);
  const selected = await page.evaluate(() => document.querySelectorAll('.card--selected').length);
  console.log('selected via Ctrl+A:', selected);
  const moveBtn = page.locator('.bulkbar button', { hasText: 'Move to Approved' });
  if ((await moveBtn.count()) > 0) {
    await moveBtn.first().click();
    await sleep(4000);
    const outcome = await page.evaluate(() => document.querySelector('.bulkbar')?.textContent ?? '');
    console.log('bulk outcome:', outcome.replace(/\s+/g, ' ').slice(0, 200));
    const undoBtn = page.locator('.bulkbar button', { hasText: 'Undo' });
    if ((await undoBtn.count()) > 0) {
      await undoBtn.first().click();
      await sleep(1500);
      console.log('bulk: Undo clicked');
    }
  } else {
    console.log('bulk: no Move button (selection may be empty)');
  }

  console.log('PAGE ERRORS:', errors.length ? errors.slice(0, 6) : 'none');
  await browser.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAILED:', e);
  process.exit(1);
});