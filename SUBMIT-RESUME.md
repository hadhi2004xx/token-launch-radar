# Token Launch Radar — submit resume

Competition: token-radar-01 ("Build the best token launch radar", program/v1). Entry is ready to
submit; this file records what was built and how it was verified. Nothing here was submitted or
pushed by the build session.

## The model (lib/model.ts, version argon-radar-2)

Eligibility mirrors the snapshot's own watchlist rule: a protocol records no token (gecko_id and
symbol both null) and is not a wrapped, staked or bridged product of a token that already trades —
excluded categories (Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC, CEX),
a version marker at the end of the name, a whole word wrapped/staked/staking, or an exchange's name
at the start. All 40 watchlist slugs are boarded unconditionally.

implied_value_usd = TVL x category multiple x momentum x maturity x multichain, rounded to whole
dollars:

- Category multiple: median market-cap/TVL of the token-bearing protocols in the same DefiLlama
  category (144 comparables; each ratio clamped to [0.005, 10]), shrunk toward the global median
  (0.1689) with a pseudo-count of 4, so a one-sample category cannot dominate.
- Momentum: 1 + clamp(change_7d, -50, +100)/100 x 0.6; unreported change is neutral.
- Maturity: 0.75 + 0.5 x min(age_days, 1825)/1825 from listed_at to the snapshot's as_of; unknown
  listing day is neutral.
- Multichain: 1 + 0.015 x min(chains - 1, 8).

Farm steps: 4-6 per row, generated from the protocol's category, main chain and TVL tier — a
category action (supply/borrow, LP, bridge, stake, trade, vault deposit, ...), a gas estimate by
chain fee class (Ethereum mainnet / layer-2 / low-cost), a position size, a weekly cadence and a
time budget per step. Variation between protocols is seeded by an FNV-1a hash of the slug, so plans
differ per protocol but are identical on every run.

## Board statistics

- Rows: 198 (100-4000 required), of which 40 are watchlist rows — coverage 40/40.
- 198 distinct implied values; board TVL covered $20.71B; board.json 304,100 bytes.
- Top 5 by implied value:
  1. Steakhouse Financial (Risk Curators) — $1,997,239,917 (watchlist)
  2. Sentora Curator (Risk Curators) — $1,838,174,418
  3. Gauntlet (Risk Curators) — $1,198,696,597 (watchlist)
  4. Polymarket International (Prediction Market) — $849,015,446
  5. Nonce Capital (Risk Curators) — $273,275,519 (watchlist)

## Dashboard

dashboard/index.html + app.css + app.js = 21,461 bytes total (fits the dossier text whole).
Precision Technical / Swiss Grid: obsidian #090A0D, 1px hairlines, tabular numerals, one accent
(#10B981). Sortable columns (rank, name, TVL, 7d %, implied value, multiple, age), text search,
category and chain dropdowns, watchlist-only toggle, minimum-TVL slider, click-a-row detail view
with full statistics, the four-factor value breakdown and the farm plan, plus a comparables strip
of 24 already-trading protocols the multiples are drawn from. Renders with no network from
../data.js; verified headless with 0 console errors.

## Screenshots (Playwright, chromium headless shell, 1440x900)

- 1-board.png — 189,199 bytes: the board as it opens, rank 1 in the detail pane.
- 2-detail.png — 227,205 bytes: detail view of rank 4 (Polymarket International), breakdown and
  farm plan visible.
- 3-filtered.png — 188,558 bytes: category Risk Curators + watchlist-only, 12 of 198 rows.

## Verification (pass 4)

- Determinism: two full runs of main.ts into separate directories are byte-identical (diff -r
  clean), including dossier.json.
- Independent validator (validate.mjs, shares no code with the model): all 7 gate checks PASS —
  dashboard_files (3 files, 21,461 bytes, no network address), board_file (198 rows), sorted_by_value
  (ranks 1..N, value never rises), coverage (40/40), farm_steps (4-6 steps per row, 165-311 chars
  each), screenshots (3 PNG at 1440x900, each under 512 KiB), dossier_matches (byte-identical to a
  fresh buildDossier, 829,566 bytes, under the 1.5 MiB cap).
- semgrep --config auto over the entry's code: 0 findings. gitleaks (tree and history): no leaks.

## Suggested entry title

Token Launch Radar: 198 pre-token protocols ranked by category-multiple implied value, each with a farm plan
