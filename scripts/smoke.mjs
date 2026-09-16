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
  }, 90000);

  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  try {
    await page.waitForSelector('.grid .card', { timeout: 15000 });
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
  const cardCount = await page.locator('.card').count();
  const gridCells = await page.locator('[role="gridcell"]').count();
  console.log('initial cards rendered:', cardCount, '| gridcells:', gridCells);

  // 2) Scroll far in steps to force many pages (infinite scroll).
  for (let i = 0; i < 40; i += 1) {
    await page.evaluate(() => {
      const el = document.querySelector('.grid');
      if (el) el.scrollTop += 2200;
    });
    await sleep(120);
  }
  await sleep(2500);
  const tally = await page.evaluate(() => {
    const el = document.querySelector('.grid');
    const totalText = document.querySelector('.filters__count')?.textContent ?? '';
    const match = (totalText.match(/([\d,]+) of ([\d,]+)/) || []);
    return {
      scrollHeight: el ? el.scrollHeight : 0,
      shown: match[1] ?? '?',
      of: match[2] ?? '?',
      domNodes: document.querySelectorAll('*').length,
    };
  });
  console.log('after deep scroll:', JSON.stringify(tally));

  // 3) DOM node count while thousands of rows are loaded.
  const domNodes = await page.evaluate(() => document.querySelectorAll('*').length);
  console.log('DOM nodes after deep scroll:', domNodes);

  // 4) Search race: type a short prefix then the full phrase fast.
  const readsBefore = await page.evaluate(() => window.__mvStats?.reads ?? -1);
  const search = page.locator('input[type="search"]');
  await search.fill('st');
  await search.type('udio', { delay: 40 });
  await sleep(2500);
  const readsAfter = await page.evaluate(() => window.__mvStats?.reads ?? -1);
  console.log('reads delta while typing 6 chars:', readsAfter - readsBefore);

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