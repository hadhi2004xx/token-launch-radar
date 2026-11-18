// Independent gate validator for the token radar entry (tooling only; main.ts never copies it).
// Re-checks the seven gate rows of token-radar-01 against a finished output directory, reading only
// the output files and the sealed snapshot — it shares no code with lib/model.ts.
//
//   node validate.mjs [outDir] [snapshot.json]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = process.argv[2] ?? join(here, 'out');
const snapshotFile = process.argv[3] ?? join(here, '..', 'token-radar-01-kit', 'input', 'snapshot.json');
const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
}

/** Every regular file under a directory, as paths relative to it. */
function walk(dir, prefix = '') {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
    if (e.isDirectory()) files.push(...walk(join(dir, e.name), rel));
    else if (e.isFile()) files.push(rel);
  }
  return files;
}

// 1. dashboard_files
{
  const dir = join(out, 'dashboard');
  const files = walk(dir);
  const bytes = files.reduce((n, f) => n + statSync(join(dir, f)).size, 0);
  let problem = null;
  if (!files.includes('index.html')) problem = 'no index.html';
  if (!files.some((f) => f.endsWith('.css'))) problem = 'no .css file';
  if (!files.some((f) => f.endsWith('.js'))) problem = 'no .js file';
  if (files.length > 400) problem = `${files.length} files over 400`;
  if (bytes > 4_194_304) problem = `${bytes} bytes over 4 MiB`;
  for (const f of files) {
    const base = f.split('/').pop();
    if (!PLAIN.test(base)) problem = `bad file name ${f}`;
    const text = readFileSync(join(dir, f), 'utf8');
    if (f.endsWith('.css') && /https?:\/\//.test(text)) problem = `${f}: network address in CSS`;
    if (f.endsWith('.js') && /(?:import|export)[^'"]*from\s*['"]https?:|require\(\s*['"]https?:|import\(\s*['"]https?:/.test(text)) problem = `${f}: network import`;
    if (f.endsWith('.html')) {
      if (/(?:href|src|action|poster)\s*=\s*["']https?:/i.test(text)) problem = `${f}: network address in an attribute`;
      for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) if (/https?:\/\//.test(m[1])) problem = `${f}: network address in a style body`;
      if (/<script[^>]*\btype\s*=\s*["']module["'][^>]*>[\s\S]*?(?:import|export)[^'"]*from\s*['"]https?:/.test(text)) problem = `${f}: network import in inline script`;
    }
  }
  check('dashboard_files', problem === null, problem ?? `${files.length} files, ${bytes} bytes, no network address`);
}

// 2-5. board_file, sorted_by_value, coverage, farm_steps
let rows = [];
{
  const raw = readFileSync(join(out, 'board.json'));
  let problem = null;
  if (raw.length > 8 * 1024 * 1024) problem = 'board.json over 8 MiB';
  const parsed = JSON.parse(raw.toString('utf8'));
  rows = Array.isArray(parsed) ? parsed : parsed.rows;
  if (!Array.isArray(rows)) problem = 'rows is not an array';
  else if (rows.length < 100 || rows.length > 4000) problem = `${rows.length} rows outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  if (problem === null) {
    for (const r of rows) {
      if (!known.has(r.slug)) { problem = `invented slug ${r.slug}`; break; }
      if (typeof r.name !== 'string' || r.name.length === 0) { problem = `${r.slug}: empty name`; break; }
      if (!Number.isSafeInteger(r.rank) || r.rank <= 0) { problem = `${r.slug}: bad rank`; break; }
      if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) { problem = `${r.slug}: bad implied value`; break; }
      if (!Array.isArray(r.farm_steps)) { problem = `${r.slug}: farm_steps not an array`; break; }
    }
  }
  if (problem === null && rows.length >= 2 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd)) problem = 'all rows share one implied value';
  check('board_file', problem === null, problem ?? `${rows.length} rows, ${raw.length} bytes`);

  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  let sorted = byRank.every((r, i) => r.rank === i + 1);
  for (let i = 1; i < byRank.length; i++) if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) sorted = false;
  check('sorted_by_value', sorted, sorted ? 'ranks 1..N once each, value never rises with rank' : 'rank or order defect');

  const have = new Set(rows.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !have.has(s));
  check('coverage', missing.length === 0, missing.length === 0 ? `${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist slugs boarded` : `missing ${missing.join(', ')}`);

  let stepProblem = null;
  for (const r of rows) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) { stepProblem = `${r.slug}: ${r.farm_steps.length} steps`; break; }
    for (const s of r.farm_steps) {
      const t = typeof s === 'string' ? s.trim().length : 0;
      if (t < 20 || t > 600) { stepProblem = `${r.slug}: a step of ${t} characters`; break; }
    }
    if (stepProblem) break;
  }
  check('farm_steps', stepProblem === null, stepProblem ?? 'every row holds 3..12 steps of 20..600 characters');
}

// 6. screenshots
function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return null; // 'IHDR'
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}
function jpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xc0 || marker === 0xc2) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}
{
  const dir = join(out, 'screenshots');
  const names = readdirSync(dir).filter((n) => !n.startsWith('.'));
  let problem = null;
  const details = [];
  if (names.length < 3 || names.length > 4) problem = `${names.length} screenshots outside 3..4`;
  for (const name of names) {
    if (!PLAIN.test(name)) { problem = `bad name ${name}`; break; }
    const buf = readFileSync(join(dir, name));
    if (buf.length > 524_288) { problem = `${name}: ${buf.length} bytes over 512 KiB`; break; }
    const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50;
    const isJpg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    if (!isPng && !isJpg) { problem = `${name}: not a whole PNG or JPEG`; break; }
    const size = isPng ? pngSize(buf) : jpegSize(buf);
    if (size === null) { problem = `${name}: dimensions unreadable`; break; }
    const long = Math.max(size.w, size.h), short = Math.min(size.w, size.h);
    details.push(`${name} ${size.w}x${size.h} ${buf.length}B`);
    if (long > 1440 || short < 800) { problem = `${name}: ${size.w}x${size.h} outside the side limits`; break; }
  }
  check('screenshots', problem === null, problem ?? details.join('; '));
}

// 7. dossier_matches
{
  const actual = readFileSync(join(out, 'dossier.json'));
  let problem = null;
  try {
    const rebuilt = buildDossier(out, { text_max_bytes: 65_536, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
    if (!Buffer.from(rebuilt).equals(actual)) problem = 'dossier.json differs from a fresh buildDossier of the same output';
  } catch (err) {
    problem = `buildDossier refused: ${err.message}`;
  }
  if (problem === null && actual.length > 1.5 * 1024 * 1024) problem = `dossier ${actual.length} bytes over 1.5 MiB`;
  check('dossier_matches', problem === null, problem ?? `byte-identical to buildDossier output, ${actual.length} bytes`);
}

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}: ${r.detail}\n`);
}
process.stdout.write(failed === 0 ? 'VALID: all 7 gate checks pass\n' : `INVALID: ${failed} check(s) failed\n`);
process.exit(failed === 0 ? 0 : 1);
