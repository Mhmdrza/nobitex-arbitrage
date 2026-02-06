/**
 * Arbitrage Scanner — fetches Nobitex orderbook on an interval, detects
 * opportunities, and writes timestamped data to disk for pattern analysis.
 *
 * Usage:
 *   npx tsx scripts/scanner.ts [options]
 *
 * Options:
 *   --interval <seconds>   Scan interval (default: 60)
 *   --base <currency>      Base currency (default: USDT)
 *   --fee <percent>        Fee per trade in % (default: 0.35)
 *   --out <dir>            Output directory (default: docs/data)
 *   --top <n>              How many top opps to keep in timeline (default: 20)
 *   --once                 Run once and exit
 *   --quiet                Minimal console output
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAllPairs,
  findAllOpportunities,
  formatPct,
  formatIRT,
  type Opportunity,
} from '../src/triangles.ts';

/* ═══════════════════════════════════════════════════════════════════ *
 *  CLI argument parsing                                              *
 * ═══════════════════════════════════════════════════════════════════ */

const args = process.argv.slice(2);

function flag(name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function opt(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return fallback;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}

const INTERVAL_S  = Number(opt('interval', '60'));
const BASE        = opt('base', 'USDT');
const FEE_PCT     = Number(opt('fee', '0.35'));
const TOP_N       = Number(opt('top', '20'));
const ONCE        = flag('once');
const QUIET       = flag('quiet');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(PROJECT_ROOT, opt('out', 'docs/data'));

const API_URL = 'https://apiv2.nobitex.ir/v3/orderbook/all';

/* ═══════════════════════════════════════════════════════════════════ *
 *  File system helpers                                               *
 * ═══════════════════════════════════════════════════════════════════ */

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** Tehran time string (Asia/Tehran = UTC+3:30) */
function tehranTime(d: Date): { date: string; time: string; hhmm: string } {
  const tehranStr = d.toLocaleString('en-GB', { timeZone: 'Asia/Tehran', hour12: false });
  const [datePart, timePart] = tehranStr.split(', ');
  const [dd, mm, yyyy] = datePart.split('/');
  return {
    date: `${yyyy}-${mm}-${dd}`,
    time: timePart.replace(/:/g, ''),
    hhmm: timePart.slice(0, 5),
  };
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Compact opportunity for timeline                                  *
 * ═══════════════════════════════════════════════════════════════════ */

interface CompactOpp {
  type: 'tri' | 'cross';
  dir: string;
  assets: string[];
  net: number;
  gross: number;
  vol: number;
  profit: number;
}

function compact(o: Opportunity): CompactOpp {
  return {
    type: o.type === 'triangle' ? 'tri' : 'cross',
    dir: o.direction,
    assets: o.assets,
    net: Math.round(o.netPct * 1000) / 1000,
    gross: Math.round(o.grossPct * 1000) / 1000,
    vol: Math.round(o.maxVolumeIRT),
    profit: Math.round(o.expectedProfitIRT),
  };
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Scan                                                              *
 * ═══════════════════════════════════════════════════════════════════ */

interface ScanResult {
  ok: boolean;
  error?: string;
}

let scanCount = 0;

async function scan(): Promise<ScanResult> {
  const now = new Date();
  const { date, time, hhmm } = tehranTime(now);
  scanCount++;

  /* — fetch ——————————————————————————————————————————————————————— */
  let rawData: Record<string, unknown>;
  try {
    const resp = await fetch(API_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    rawData = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!QUIET) console.error(`  ✗ fetch failed: ${msg}`);
    return { ok: false, error: msg };
  }

  /* — detect —————————————————————————————————————————————————————— */
  const pairs = parseAllPairs(rawData);
  const allOpps = findAllOpportunities(pairs, BASE, FEE_PCT);

  const profitable = allOpps.filter((o) => o.netPct > 0);
  const triangles  = allOpps.filter((o) => o.type === 'triangle');
  const crosses    = allOpps.filter((o) => o.type === 'cross');

  const best = allOpps[0] ?? null;
  const avgNet =
    allOpps.length > 0
      ? allOpps.reduce((s, o) => s + o.netPct, 0) / allOpps.length
      : 0;

  /* — timeline JSONL (compact, one line per scan) ————————————————— */
  ensureDir(OUT_DIR);
  const timelinePath = path.join(OUT_DIR, 'timeline.jsonl');
  const timelineEntry = {
    ts: now.toISOString(),
    tehranTime: `${date} ${hhmm}`,
    base: BASE,
    feePct: FEE_PCT,
    pairCount: pairs.length,
    totalOpps: allOpps.length,
    triangleCount: triangles.length,
    crossCount: crosses.length,
    profitableCount: profitable.length,
    bestNet: best ? Math.round(best.netPct * 1000) / 1000 : null,
    bestAsset: best ? best.assets.join('+') : null,
    bestType: best?.type ?? null,
    avgNet: Math.round(avgNet * 1000) / 1000,
    totalEstProfit: Math.round(profitable.reduce((s, o) => s + o.expectedProfitIRT, 0)),
    top: allOpps.slice(0, TOP_N).map(compact),
  };
  fs.appendFileSync(timelinePath, JSON.stringify(timelineEntry) + '\n');

  /* — detailed snapshot (one JSON file per scan) —————————————————— */
  const snapshotDir = path.join(OUT_DIR, 'snapshots', date);
  ensureDir(snapshotDir);
  const snapshotPath = path.join(snapshotDir, `${time}.json`);
  const snapshot = {
    timestamp: now.toISOString(),
    tehranTime: `${date} ${hhmm}`,
    config: { base: BASE, feePct: FEE_PCT },
    summary: {
      pairCount: pairs.length,
      totalOpps: allOpps.length,
      triangleCount: triangles.length,
      crossCount: crosses.length,
      profitableCount: profitable.length,
      avgNetPct: Math.round(avgNet * 1000) / 1000,
      totalEstProfitIRT: Math.round(profitable.reduce((s, o) => s + o.expectedProfitIRT, 0)),
    },
    opportunities: [
      ...profitable,
      ...allOpps.filter((o) => o.netPct <= 0).slice(0, 50),
    ],
  };
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));

  /* — console ————————————————————————————————————————————————————— */
  if (!QUIET) {
    const profitStr = profitable.length > 0
      ? `\x1b[32m${profitable.length} profitable\x1b[0m`
      : `\x1b[90m0 profitable\x1b[0m`;
    const bestStr = best
      ? `best: ${formatPct(best.netPct)} (${best.assets.join('+')})`
      : 'no opps';
    console.log(
      `[${hhmm}] #${scanCount}  ${pairs.length} pairs · ${allOpps.length} opps · ${profitStr} · ${bestStr} · est profit ${formatIRT(profitable.reduce((s, o) => s + o.expectedProfitIRT, 0))} IRT`,
    );
  }

  return { ok: true };
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Main                                                              *
 * ═══════════════════════════════════════════════════════════════════ */

async function main() {
  console.log(`\n╔═══════════════════════════════════════════════╗`);
  console.log(`║  Arbitrage Scanner                            ║`);
  console.log(`╠═══════════════════════════════════════════════╣`);
  console.log(`║  Base:     ${BASE.padEnd(35)}║`);
  console.log(`║  Fee:      ${(FEE_PCT + '%/trade').padEnd(35)}║`);
  console.log(`║  Interval: ${(INTERVAL_S + 's').padEnd(35)}║`);
  console.log(`║  Output:   ${OUT_DIR.slice(-35).padEnd(35)}║`);
  console.log(`║  Mode:     ${ONCE ? 'single run'.padEnd(35) : 'continuous (Ctrl+C to stop)'.padEnd(35)}║`);
  console.log(`╚═══════════════════════════════════════════════╝\n`);

  await scan();

  if (ONCE) {
    console.log('\nDone (--once).');
    return;
  }

  const timer = setInterval(async () => {
    try {
      await scan();
    } catch (err) {
      console.error('Unexpected error:', err);
    }
  }, INTERVAL_S * 1000);

  const shutdown = () => {
    console.log(`\n\nStopping after ${scanCount} scans. Data in: ${OUT_DIR}`);
    clearInterval(timer);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
