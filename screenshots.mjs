// Screenshot tooling for the token radar entry (not part of the graded program; main.ts never copies
// this file). It runs main.ts into out/, renders out/dashboard/index.html in the headless Chromium
// shell the workspace keeps under ~/workspace/ubh/tools, captures the three views the gate hands the
// judge (board, detail, filtered) into screenshots/, then runs main.ts again so the final dossier
// carries the real screenshots.
//
//   node screenshots.mjs [snapshot.json]
//
// Playwright is resolved from ~/workspace/ubh/tools/pw and its browsers from
// ~/workspace/ubh/tools/pw-browsers; the entry itself stays standard-library only.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const home = process.env.HOME ?? '';
const node = process.execPath;
const snapshot = process.argv[2] ?? join(here, '..', 'token-radar-01-kit', 'input', 'snapshot.json');
const outDir = join(here, 'out');
const shotsDir = join(here, 'screenshots');

process.env.PLAYWRIGHT_BROWSERS_PATH = join(home, 'workspace/ubh/tools/pw-browsers');
const require = createRequire(join(home, 'workspace/ubh/tools/pw', 'noop.js'));
const { chromium } = require('playwright');

/** The chromium headless-shell executable under the workspace browsers directory. */
function headlessShell() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  for (const dir of readdirSync(base)) {
    const exe = join(base, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
    if (dir.startsWith('chromium_headless_shell') && existsSync(exe)) return exe;
  }
  return undefined;
}

/** Run main.ts into out/; the pre-screenshot run may stop at the screenshot guard, which is fine. */
function runMain(expectOk) {
  const res = spawnSync(node, ['main.ts', '--input', snapshot], {
    cwd: here,
    env: { ...process.env, MAKEFUN_OUTPUT_DIR: outDir },
    encoding: 'utf8',
  });
  if (expectOk && res.status !== 0) {
    process.stderr.write(`screenshots: final main.ts run failed:\n${res.stdout}\n${res.stderr}\n`);
    process.exit(1);
  }
  return res;
}

runMain(false);

const browser = await chromium.launch({ executablePath: headlessShell() });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // nosemgrep: javascript.playwright.security.audit.playwright-goto-injection.playwright-goto-injection -- the URL is a file:// path built from this script's own directory and a fixed out/dashboard/index.html suffix; no external input reaches it.
  await page.goto(`file://${join(outDir, 'dashboard', 'index.html')}`);
  await page.waitForSelector('#tbody tr');
  await page.waitForTimeout(150);

  // 1: the board as it opens, rank 1 selected in the detail pane.
  await page.screenshot({ path: join(shotsDir, '1-board.png') });

  // 2: the detail view of the rank 4 protocol (a different category from rank 1), scrolled so its
  // value breakdown and farm plan fill the pane.
  const detailRow = page.locator('#tbody tr').nth(3);
  const detailSlug = await detailRow.getAttribute('data-slug');
  await detailRow.click();
  await page.waitForFunction(
    (slug) => document.querySelector('#detail .dsub')?.textContent?.includes(slug),
    detailSlug,
  );
  await page.evaluate(() => window.scrollTo(0, 430));
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(shotsDir, '2-detail.png') });
  await page.evaluate(() => window.scrollTo(0, 0));

  // 3: a filtered view: the category holding the most watchlist rows, watchlist-only on, and the
  // first visible row opened so the detail pane agrees with the filtered board.
  const category = await page.evaluate(() => {
    const counts = new Map();
    for (const r of window.RADAR.rows) {
      if (!r.watchlist) continue;
      const c = r.category ?? 'Uncategorised';
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  });
  await page.selectOption('#cat', category);
  await page.check('#wlonly');
  await page.waitForTimeout(100);
  await page.locator('#tbody tr').first().click();
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(shotsDir, '3-filtered.png') });
  process.stdout.write(`screenshots: filtered view used category "${category}" with watchlist-only on\n`);
} finally {
  await browser.close();
}

for (const name of readdirSync(shotsDir).sort()) {
  process.stdout.write(`screenshots: ${name} ${statSync(join(shotsDir, name)).size} bytes\n`);
}

// The final run rebuilds every output with the real screenshots in place.
const final = runMain(true);
process.stdout.write(final.stdout);
execFileSync('true', []);
