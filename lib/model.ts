// Token launch radar model: one sealed DefiLlama snapshot in, one ranked board out.
//
// The board ranks protocols that record no token yet by an implied value derived only from the
// snapshot's own figures. Nothing is hardcoded per protocol: the same functions score every row.
//
//   implied_value_usd = tvl_usd
//     x category multiple   median market-cap/TVL of the token-bearing protocols in the same
//                           DefiLlama category (each ratio clamped to [0.005, 10] first), shrunk
//                           toward the global median with a pseudo-count of 4, so a category with
//                           one wild comparable cannot dominate the board
//     x momentum factor     1 + clamp(change_7d, -50, +100)/100 x 0.6; unreported change is neutral
//     x maturity factor     0.75 + 0.5 x min(age_days, 1825)/1825; unknown listing day is neutral
//     x multichain factor   1 + 0.015 x min(chains - 1, 8)
//
// Eligibility mirrors the snapshot's own watchlist rule: a protocol records no token (gecko_id and
// symbol both null) and is not a wrapped, staked or bridged product of a token that already trades
// (excluded categories, a version marker at the end of the name, a whole word wrapped/staked/staking,
// or an exchange's name at the start). Every watchlist slug is boarded unconditionally: the list is
// the floor, never the ceiling, so eligible protocols below the $50M floor are boarded too.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated in the dashboard so a reader can re-derive every value. */
export interface ModelConstants {
  ratio_floor: number;
  ratio_cap: number;
  shrink_weight: number;
  momentum_weight: number;
  momentum_floor: number;
  momentum_cap: number;
  maturity_base: number;
  maturity_span: number;
  maturity_days: number;
  multichain_step: number;
  multichain_max_extra: number;
}

export const MODEL: ModelConstants = {
  ratio_floor: 0.005,
  ratio_cap: 10,
  shrink_weight: 4,
  momentum_weight: 0.6,
  momentum_floor: -50,
  momentum_cap: 100,
  maturity_base: 0.75,
  maturity_span: 0.5,
  maturity_days: 1825,
  multichain_step: 0.015,
  multichain_max_extra: 8,
};

/** The model's version label, named in the dashboard header. */
export const MODEL_VERSION = 'argon-radar-2';

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when the listing day is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const s = [...values].sort((x, y) => x - y);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** One category's comparable set: how many token-bearing protocols, and their median ratio. */
export interface CategoryMultiple {
  sample: number;
  median: number;
  /** The multiple the model actually applies, after shrinkage toward the global median. */
  applied: number;
}

/** The category multiples of a snapshot: per-category medians of clamped mcap/TVL, shrunk to global. */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; byCategory: Map<string, CategoryMultiple> } {
  const ratios = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const ratio = clamp(p.mcap_usd / p.tvl_usd, model.ratio_floor, model.ratio_cap);
    all.push(ratio);
    const key = p.category ?? '';
    const list = ratios.get(key);
    if (list === undefined) ratios.set(key, [ratio]);
    else list.push(ratio);
  }
  const global = all.length > 0 ? median(all) : 1;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [key, list] of ratios) {
    const med = median(list);
    byCategory.set(key, {
      sample: list.length,
      median: med,
      applied: (list.length * med + model.shrink_weight * global) / (list.length + model.shrink_weight),
    });
  }
  return { global, byCategory };
}

/** Whether a protocol records no token: DefiLlama carries neither a CoinGecko id nor a symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED_NAME = /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(?:wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(?:Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a protocol passes the product filter: not a wrapped, staked or bridged product of a token
 * that already trades, by the same tests the snapshot's watchlist rule states.
 */
export function passesProductFilter(p: SnapshotProtocol): boolean {
  if (EXCLUDED_CATEGORIES.has(p.category ?? '')) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** Whether a protocol may be ranked: it records no token and passes the product filter. */
export function isEligible(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && passesProductFilter(p);
}

/** The factor breakdown of one protocol's implied value. */
export interface ValueBreakdown {
  implied: number;
  multiple: number;
  multipleSample: number;
  momentum: number;
  maturity: number;
  multichain: number;
  age: number | null;
}

/** One protocol's implied value and the four factors that produced it. */
export function impliedValue(
  p: SnapshotProtocol,
  asOf: string,
  multiples: { global: number; byCategory: Map<string, CategoryMultiple> },
  model: ModelConstants = MODEL,
): ValueBreakdown {
  const cat = multiples.byCategory.get(p.category ?? '');
  const multiple = cat === undefined ? multiples.global : cat.applied;
  const momentum = p.change_7d === null ? 1 : 1 + (clamp(p.change_7d, model.momentum_floor, model.momentum_cap) / 100) * model.momentum_weight;
  const age = ageDays(asOf, p.listed_at);
  const maturity = age === null ? 1 : model.maturity_base + model.maturity_span * (Math.min(age, model.maturity_days) / model.maturity_days);
  const multichain = 1 + model.multichain_step * Math.min(Math.max(p.chains.length - 1, 0), model.multichain_max_extra);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * maturity * multichain));
  return { implied, multiple, multipleSample: cat === undefined ? 0 : cat.sample, momentum, maturity, multichain, age };
}

// ------------------------------------------------------------------ farm plans

/** FNV-1a over the slug: a stable per-protocol variation seed, identical on every run. */
export function slugHash(slug: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

type ChainClass = 'mainnet' | 'layer2' | 'lowcost';

const LAYER2_CHAINS = new Set([
  'Arbitrum', 'Base', 'Optimism', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Taiko',
  'Starknet', 'Polygon zkEVM', 'Manta', 'Fraxtal', 'Zora', 'Boba', 'Metis', 'Immutable zkEVM', 'X Layer',
]);

/** The fee class of a chain, which sets the plan's gas estimates. */
function chainClass(chain: string): ChainClass {
  if (chain === 'Ethereum') return 'mainnet';
  if (LAYER2_CHAINS.has(chain)) return 'layer2';
  return 'lowcost';
}

const GAS_TEXT: Record<ChainClass, string> = {
  mainnet: '$8-30 of ETH gas across the setup transactions at typical mainnet fees',
  layer2: '$0.20-1.50 of gas across the setup transactions at typical layer-2 fees',
  lowcost: 'under $0.25 of gas across the setup transactions at typical fees on this chain',
};

const WEEKLY_GAS: Record<ChainClass, string> = {
  mainnet: 'about $6-12 of ETH gas a week',
  layer2: 'about $0.30 of gas a week',
  lowcost: 'a few cents of gas a week',
};

/** The main chain a protocol names, or a neutral phrase when it names none. */
function mainChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** A sensible starter position for a farm, scaled to the protocol's own TVL with a per-slug jitter. */
function positionSize(p: SnapshotProtocol, hash: number): number {
  const base = p.tvl_usd >= 1_000_000_000 ? 250 : p.tvl_usd >= 250_000_000 ? 200 : p.tvl_usd >= 50_000_000 ? 150 : p.tvl_usd >= 15_000_000 ? 100 : 60;
  return base + (hash % 5) * 10;
}

/** How many weeks of steady activity a plan runs, longer for younger protocols. */
function planWeeks(age: number | null, hash: number): number {
  const base = age === null ? 8 : age < 180 ? 12 : age < 365 ? 10 : age < 730 ? 8 : 6;
  return base + (hash % 3);
}

/** The category's primary and secondary farm actions, in words a farmer can follow. */
function categoryActions(p: SnapshotProtocol, size: number, chain: string): { primary: string; secondary: string } {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('collateral')) {
    return {
      primary: `Supply $${size} of USDC to ${n} on ${chain} as collateral, then borrow a small stablecoin amount against it and keep the health factor above 2.0`,
      secondary: `Repay and re-borrow once a week in small amounts so the account shows real borrowing activity, not a single parked deposit`,
    };
  }
  if (c.includes('cdp')) {
    return {
      primary: `Open a collateral vault on ${n} on ${chain}: deposit $${size} of the accepted collateral and mint a conservative amount of its stablecoin against it`,
      secondary: `Hold the minted stablecoin in the protocol's own stability or savings module so both sides of the position stay inside ${n}`,
    };
  }
  if (c.includes('dex') || c.includes('liquidity manager')) {
    return {
      primary: `Add $${size} of liquidity to ${n}'s deepest stable or blue-chip pool on ${chain} and keep the LP position open`,
      secondary: `Route a few swaps a week through ${n} itself, sized $20-50 each, so the wallet also counts as a trading user`,
    };
  }
  if (c.includes('derivative') || c.includes('perpetual') || c.includes('options') || c.includes('interest rate')) {
    return {
      primary: `Deposit $${size} of USDC as margin on ${n} on ${chain} and open one small hedged position (long spot against a short perp, or the reverse)`,
      secondary: `Roll the hedge once a week and keep the margin ratio comfortably above the liquidation line while the position seasons`,
    };
  }
  if (c.includes('bridge')) {
    return {
      primary: `Bridge $${size} of USDC from Ethereum to ${chain} through ${n}, then put the bridged funds to work in a destination-chain app the same day`,
      secondary: `Bridge a smaller amount back the following week so the wallet shows round-trip usage rather than a one-way transfer`,
    };
  }
  if (c.includes('restak') || c.includes('staking pool') || c.includes('anchor') || c.includes('decentralized btc')) {
    return {
      primary: `Stake $${size} of the chain's staking asset through ${n} on ${chain} and keep the staking receipt token in the same wallet`,
      secondary: `Restake or re-delegate a small second tranche after two weeks so the position grows the way a real staker's would`,
    };
  }
  if (c.includes('prediction')) {
    return {
      primary: `Fund $${size} on ${n} and take positions in three liquid markets, sized $10-25 each, holding at least one to settlement`,
      secondary: `Provide a small quote on one active market each week so the account shows both trading and liquidity activity`,
    };
  }
  if (c.includes('rwa') || c.includes('stablecoin') || c.includes('algo-stable') || c.includes('reserve')) {
    return {
      primary: `Mint or deposit $${size} of the yield-bearing asset ${n} issues on ${chain} and hold it in the farming wallet`,
      secondary: `Use the issued asset as collateral or liquidity inside one partner app ${n} lists, so the position touches two protocols`,
    };
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('yield') || c.includes('farm') || c.includes('leveraged')) {
    return {
      primary: `Deposit $${size} into a ${n} vault on ${chain} and keep the vault shares untouched while the strategy compounds`,
      secondary: `Split a second, smaller deposit into a different ${n} vault after two weeks so the wallet is not a single-vault account`,
    };
  }
  if (c.includes('basis') || c.includes('cedefi')) {
    return {
      primary: `Deposit $${size} of USDC into ${n}'s basis or delta-neutral strategy on ${chain} and leave the position to accrue`,
      secondary: `Add a small top-up once a month rather than churning withdrawals, which keeps the account in the strategy's active set`,
    };
  }
  if (c.includes('insurance')) {
    return {
      primary: `Buy $${size} of cover from ${n} on ${chain} against a position you actually hold, and keep the policy to expiry`,
      secondary: `Stake a small amount into ${n}'s capital pool as well, so the wallet appears on both sides of the market`,
    };
  }
  if (c.includes('index')) {
    return {
      primary: `Mint $${size} of ${n}'s main index token on ${chain} and hold it rather than trading in and out`,
      secondary: `Rebalance alongside the index once a quarter, or add a small monthly mint, so the wallet shows a holder's cadence`,
    };
  }
  if (c.includes('chain')) {
    return {
      primary: `Bridge $${size} to ${n} and use two of its native apps in the first week: one swap venue and one lending or staking app`,
      secondary: `Keep a small native-gas balance and make one transaction a week on ${n} so the wallet ages as a real chain user`,
    };
  }
  if (c.includes('payment') || c.includes('card')) {
    return {
      primary: `Fund $${size} on ${n} and route everyday payments or card spend through it for a month, keeping the balance topped up`,
      secondary: `Hold part of the balance in ${n}'s yield or cashback tier if it offers one, so idle funds also register activity`,
    };
  }
  if (c.includes('marketplace') || c.includes('otc')) {
    return {
      primary: `Complete $${size} of genuine trades on ${n} on ${chain}, spread over several days rather than in one session`,
      secondary: `Leave one standing order or listing open between trades so the account shows a maker's footprint too`,
    };
  }
  if (c.includes('governance')) {
    return {
      primary: `Acquire and hold $${size} of the governance or revenue-share asset ${n} tracks on ${chain}, and vote in every proposal that opens`,
      secondary: `Delegate or stake the position inside ${n} where it offers that option, and keep the vote history unbroken`,
    };
  }
  if (c.includes('privacy') || c.includes('synthetic') || c.includes('token locker')) {
    return {
      primary: `Use ${n}'s core function on ${chain} with $${size}: one real transaction a week, sized like an ordinary user's, for the plan's duration`,
      secondary: `Keep the resulting position or receipt in the farming wallet and repeat the action monthly so usage is a pattern, not an event`,
    };
  }
  return {
    primary: `Deposit $${size} of USDC into ${n} on ${chain} through its main app and keep the position open`,
    secondary: `Make one further deposit or interaction every two weeks so the wallet's activity reads as ongoing use of ${n}`,
  };
}

/**
 * A protocol's farm plan: 4 to 6 concrete steps, each naming the protocol, its main chain, an action
 * of its category, a gas estimate for the chain's fee class and a time budget. The step count and
 * small variations come from the slug's hash, so plans differ between protocols but never between runs.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const hash = slugHash(p.slug);
  const chain = mainChain(p);
  const cls = chainClass(chain);
  const size = positionSize(p, hash);
  const weeks = planWeeks(age, hash);
  const actions = categoryActions(p, size, chain);
  const steps: string[] = [
    `Set up a fresh wallet for ${p.name} and fund it on ${chain} with the position capital plus gas money. Cost: ${GAS_TEXT[cls]}. Time: about 10 minutes, once.`,
    `${actions.primary}. Cost: $${size} of position capital plus gas at ${chain} rates. Time: about 15 minutes to set up, then it runs unattended.`,
  ];
  if (p.chains.length > 1) {
    const second = p.chains[1 + (hash % (p.chains.length - 1))]!;
    steps.push(
      `Repeat a smaller version of the position on ${second}, ${p.name}'s second-largest chain by activity, at about half the size. Cost: roughly $${Math.round(size / 2)} plus ${WEEKLY_GAS[chainClass(second)]} if repeated weekly. Time: about 10 minutes.`,
    );
  } else {
    steps.push(`${actions.secondary}. Cost: ${WEEKLY_GAS[cls]}. Time: about 10 minutes a week.`);
  }
  steps.push(
    `Stay active for ${weeks} weeks: ${actions.secondary.charAt(0).toLowerCase()}${actions.secondary.slice(1)}, and never let a calendar month pass with no transaction. Cost: ${WEEKLY_GAS[cls]}. Time: about 10 minutes a week for ${weeks} weeks.`,
  );
  if (hash % 3 !== 0) {
    steps.push(
      `Check ${p.name}'s own points, rewards or governance page every two weeks and claim only through links the protocol itself publishes. Cost: nothing to check, and never pay a fee to claim. Time: 5 minutes a fortnight.`,
    );
  }
  if (hash % 3 === 1) {
    steps.push(
      `Keep a farm log for ${p.name}: wallet address, dates, amounts and transaction hashes, so the position can be proved, repeated or unwound later. Cost: nothing. Time: 5 minutes a week.`,
    );
  }
  return steps;
}

// ------------------------------------------------------------------ the board

/** One row of board.json: the ranked board's row, with the model breakdown the dashboard shows. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    category_sample: number;
    momentum_factor: number;
    maturity_factor: number;
    multichain_factor: number;
  };
  farm_steps: string[];
}

/** A token-bearing protocol, shown apart from the board as the market's own comparable. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
}

/** Everything the dashboard renders, written to data.js by main.ts. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  model: ModelConstants & { global_multiple: number };
  stats: {
    protocols: number;
    board_rows: number;
    watchlist_rows: number;
    board_tvl_usd: number;
    median_multiple: number;
    categories: string[];
    chains: string[];
  };
  rows: BoardRow[];
  live: LiveRow[];
}

/** How many token-bearing comparables the dashboard's reference strip carries. */
export const LIVE_ROWS = 24;

/**
 * The board: every watchlist slug, plus every eligible protocol the product filter admits, scored by
 * the model and ranked by implied value (ties broken by slug, so the order is total and stable).
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = categoryMultiples(snapshot, model);
  const watch = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const p of snapshot.protocols) if (isEligible(p)) chosen.set(p.slug, p);
  for (const slug of snapshot.watchlist) {
    const p = snapshot.protocols.find((q) => q.slug === slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const scored = [...chosen.values()].map((p) => ({ p, v: impliedValue(p, snapshot.as_of, multiples, model) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.v.age,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.v.implied,
    model: {
      category_multiple: round4(s.v.multiple),
      category_sample: s.v.multipleSample,
      momentum_factor: round4(s.v.momentum),
      maturity_factor: round4(s.v.maturity),
      multichain_factor: round4(s.v.multichain),
    },
    farm_steps: farmSteps(s.p, s.v.age),
  }));
}

/** The token-bearing protocols by market cap: the comparables the multiples are drawn from. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: Math.round((p.mcap_usd! / p.tvl_usd) * 1000) / 1000,
    }));
}

/** The board plus everything the dashboard needs, in one object. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const multiples = categoryMultiples(snapshot, model);
  const categories = [...new Set(board.map((r) => r.category ?? 'Uncategorised'))].sort();
  const chains = [...new Set(board.flatMap((r) => r.chains))].sort();
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    model: { ...model, global_multiple: round4(multiples.global) },
    stats: {
      protocols: snapshot.protocols.length,
      board_rows: board.length,
      watchlist_rows: board.filter((r) => r.watchlist).length,
      board_tvl_usd: board.reduce((n, r) => n + r.tvl_usd, 0),
      median_multiple: round4(median(board.map((r) => r.model.category_multiple))),
      categories,
      chains,
    },
    rows: board,
    live: liveRows(snapshot),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, values, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board repeats a slug';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `the board invents the slug ${r.slug}`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return `rank ${i + 1} is ${board[i]!.rank}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
