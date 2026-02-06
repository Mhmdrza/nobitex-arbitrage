/**
 * Arbitrage Analyzer — reads the timeline JSONL produced by the scanner
 * and prints patterns: best hours, day-of-week trends, recurring assets,
 * volatility windows, and sleeping-hour signals.
 *
 * Usage:
 *   npx tsx scripts/analyze.ts [options]
 *
 * Options:
 *   --file <path>     Path to timeline.jsonl (default: docs/data/timeline.jsonl)
 *   --min-net <pct>   Only count opps with net% >= this (default: 0)
 *   --json            Output raw JSON instead of formatted text
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ═══════════════════════════════════════════════════════════════════ *
 *  CLI                                                               *
 * ═══════════════════════════════════════════════════════════════════ */

const args = process.argv.slice(2);

function opt(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return fallback;
  const val = args[i + 1];
  args.splice(i, 2);
  return val;
}
function flag(name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const FILE_PATH = path.resolve(PROJECT_ROOT, opt('file', 'docs/data/timeline.jsonl'));
const MIN_NET = Number(opt('min-net', '0'));
const AS_JSON = flag('json');

/* ═══════════════════════════════════════════════════════════════════ *
 *  Types                                                             *
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

interface TimelineEntry {
  ts: string;
  tehranTime: string;
  base: string;
  feePct: number;
  pairCount: number;
  totalOpps: number;
  triangleCount: number;
  crossCount: number;
  profitableCount: number;
  bestNet: number | null;
  bestAsset: string | null;
  bestType: string | null;
  avgNet: number;
  totalEstProfit: number;
  top: CompactOpp[];
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Parse                                                             *
 * ═══════════════════════════════════════════════════════════════════ */

function loadTimeline(): TimelineEntry[] {
  if (!fs.existsSync(FILE_PATH)) {
    console.error(`File not found: ${FILE_PATH}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(FILE_PATH, 'utf8').trim().split('\n');
  return lines
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TimelineEntry);
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Analysis helpers                                                  *
 * ═══════════════════════════════════════════════════════════════════ */

function tehranHour(entry: TimelineEntry): number {
  return Number(entry.tehranTime.split(' ')[1].split(':')[0]);
}

function tehranDate(entry: TimelineEntry): string {
  return entry.tehranTime.split(' ')[0];
}

function dayOfWeek(entry: TimelineEntry): string {
  const d = new Date(entry.ts);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
}

interface BucketStats {
  scans: number;
  avgBestNet: number;
  maxBestNet: number;
  avgProfitableCount: number;
  maxProfitableCount: number;
  avgTotalEstProfit: number;
  totalEstProfit: number;
  topAssets: [string, number][];
}

function bucketize(
  entries: TimelineEntry[],
  keyFn: (e: TimelineEntry) => string,
): Map<string, BucketStats> {
  const buckets = new Map<string, TimelineEntry[]>();
  for (const e of entries) {
    const k = keyFn(e);
    const arr = buckets.get(k) ?? [];
    arr.push(e);
    buckets.set(k, arr);
  }

  const result = new Map<string, BucketStats>();
  for (const [key, items] of buckets) {
    const bestNets = items.map((e) => e.bestNet ?? 0);
    const profCounts = items.map((e) => e.profitableCount);
    const profSums = items.map((e) => e.totalEstProfit);

    const assetCount = new Map<string, number>();
    for (const e of items) {
      const qualified = e.top.filter((o) => o.net >= MIN_NET);
      for (const o of qualified) {
        for (const a of o.assets) {
          assetCount.set(a, (assetCount.get(a) ?? 0) + 1);
        }
      }
    }
    const topAssets = [...assetCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    result.set(key, {
      scans: items.length,
      avgBestNet: bestNets.reduce((s, v) => s + v, 0) / items.length,
      maxBestNet: Math.max(...bestNets),
      avgProfitableCount: profCounts.reduce((s, v) => s + v, 0) / items.length,
      maxProfitableCount: Math.max(...profCounts),
      avgTotalEstProfit: profSums.reduce((s, v) => s + v, 0) / items.length,
      totalEstProfit: profSums.reduce((s, v) => s + v, 0),
      topAssets,
    });
  }
  return result;
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Report                                                            *
 * ═══════════════════════════════════════════════════════════════════ */

function printBar(value: number, maxValue: number, width = 30): string {
  if (maxValue <= 0) return '';
  const filled = Math.round((value / maxValue) * width);
  return '█'.repeat(Math.max(filled, 0)) + '░'.repeat(Math.max(width - filled, 0));
}

function fmtIRT(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(1) + 'T';
  if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(1)  + 'B';
  if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(1)  + 'M';
  if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(1)  + 'K';
  return sign + abs.toFixed(0);
}

function printReport(entries: TimelineEntry[]) {
  const totalScans = entries.length;
  const firstScan = entries[0]?.tehranTime ?? '?';
  const lastScan = entries[entries.length - 1]?.tehranTime ?? '?';
  const durationH =
    totalScans > 1
      ? ((new Date(entries[entries.length - 1].ts).getTime() - new Date(entries[0].ts).getTime()) / 3.6e6).toFixed(1)
      : '0';

  console.log(`\n╔════════════════════════════════════════════════════════════╗`);
  console.log(`║  Arbitrage Pattern Analysis                                ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`║  Scans:      ${String(totalScans).padEnd(44)}║`);
  console.log(`║  Period:     ${firstScan} → ${lastScan}${' '.repeat(Math.max(0, 44 - firstScan.length - lastScan.length - 4))}║`);
  console.log(`║  Duration:   ${(durationH + ' hours').padEnd(44)}║`);
  console.log(`║  Min net%:   ${(MIN_NET + '%').padEnd(44)}║`);
  console.log(`╚════════════════════════════════════════════════════════════╝`);

  const byHour = bucketize(entries, (e) => String(tehranHour(e)).padStart(2, '0'));
  const maxAvgProfit = Math.max(...[...byHour.values()].map((s) => s.avgBestNet));

  console.log(`\n── By Hour (Tehran Time) ${'─'.repeat(40)}`);
  console.log(`  When are the best opportunities? (sleep time: ~00:00–06:00)\n`);
  const hourKeys = [...byHour.keys()].sort();
  console.log(`  Hour │ Scans │ Avg Best Net%  │ Avg #Profitable │ Chart`);
  console.log(`  ─────┼───────┼────────────────┼─────────────────┼${'─'.repeat(32)}`);
  for (const h of hourKeys) {
    const s = byHour.get(h)!;
    const isSleep = Number(h) >= 0 && Number(h) < 6;
    const marker = isSleep ? ' 💤' : '';
    console.log(
      `  ${h}:00│ ${String(s.scans).padStart(5)} │ ${s.avgBestNet >= 0 ? '+' : ''}${s.avgBestNet.toFixed(3).padStart(13)}% │ ${s.avgProfitableCount.toFixed(1).padStart(15)} │ ${printBar(s.avgBestNet, maxAvgProfit)}${marker}`,
    );
  }

  console.log(`\n── By Day of Week ${'─'.repeat(46)}\n`);
  const byDay = bucketize(entries, dayOfWeek);
  const dayOrder = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  console.log(`  Day  │ Scans │ Avg Best Net%  │ Avg #Profitable │ Total Est Profit`);
  console.log(`  ─────┼───────┼────────────────┼─────────────────┼${'─'.repeat(18)}`);
  for (const d of dayOrder) {
    const s = byDay.get(d);
    if (!s) continue;
    console.log(
      `  ${d}  │ ${String(s.scans).padStart(5)} │ ${s.avgBestNet >= 0 ? '+' : ''}${s.avgBestNet.toFixed(3).padStart(13)}% │ ${s.avgProfitableCount.toFixed(1).padStart(15)} │ ${fmtIRT(s.totalEstProfit)} IRT`,
    );
  }

  console.log(`\n── Sleep (00–06) vs Awake (06–24) ${'─'.repeat(30)}\n`);
  const sleepEntries = entries.filter((e) => tehranHour(e) >= 0 && tehranHour(e) < 6);
  const awakeEntries = entries.filter((e) => tehranHour(e) >= 6);
  const sleepBests = sleepEntries.map((e) => e.bestNet ?? 0);
  const awakeBests = awakeEntries.map((e) => e.bestNet ?? 0);
  const avgSleep = sleepBests.length > 0 ? sleepBests.reduce((s, v) => s + v, 0) / sleepBests.length : 0;
  const avgAwake = awakeBests.length > 0 ? awakeBests.reduce((s, v) => s + v, 0) / awakeBests.length : 0;
  const profSleep = sleepEntries.reduce((s, e) => s + e.profitableCount, 0);
  const profAwake = awakeEntries.reduce((s, e) => s + e.profitableCount, 0);

  console.log(`  Period   │ Scans │ Avg Best Net%  │ Total Profitable`);
  console.log(`  ─────────┼───────┼────────────────┼─────────────────`);
  console.log(`  Sleep 💤 │ ${String(sleepEntries.length).padStart(5)} │ ${avgSleep >= 0 ? '+' : ''}${avgSleep.toFixed(3).padStart(13)}% │ ${String(profSleep).padStart(16)}`);
  console.log(`  Awake ☀️  │ ${String(awakeEntries.length).padStart(5)} │ ${avgAwake >= 0 ? '+' : ''}${avgAwake.toFixed(3).padStart(13)}% │ ${String(profAwake).padStart(16)}`);
  if (sleepBests.length > 0 && awakeBests.length > 0) {
    const diff = avgSleep - avgAwake;
    console.log(`\n  → Sleep hours are ${diff > 0 ? 'BETTER' : 'WORSE'} by ${Math.abs(diff).toFixed(3)}% on average`);
  }

  console.log(`\n── Top Single Opportunities Ever Seen ${'─'.repeat(27)}\n`);
  const allTopOpps: (CompactOpp & { time: string })[] = [];
  for (const e of entries) {
    for (const o of e.top) {
      if (o.net >= MIN_NET) allTopOpps.push({ ...o, time: e.tehranTime });
    }
  }
  allTopOpps.sort((a, b) => b.net - a.net);
  const best20 = allTopOpps.slice(0, 20);
  console.log(`  #  │ Time             │ Type  │ Assets          │ Net%     │ Est Profit`);
  console.log(`  ───┼──────────────────┼───────┼─────────────────┼──────────┼───────────`);
  for (let i = 0; i < best20.length; i++) {
    const o = best20[i];
    console.log(
      `  ${String(i + 1).padStart(2)} │ ${o.time.padEnd(16)} │ ${o.type.padEnd(5)} │ ${o.assets.join('+').padEnd(15)} │ ${o.net >= 0 ? '+' : ''}${o.net.toFixed(3).padStart(7)}% │ ${fmtIRT(o.profit)} IRT`,
    );
  }

  console.log(`\n${'═'.repeat(62)}\n`);
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Main                                                              *
 * ═══════════════════════════════════════════════════════════════════ */

function main() {
  const entries = loadTimeline();
  if (entries.length === 0) {
    console.log('No data in timeline. Run the scanner first.');
    process.exit(0);
  }

  if (AS_JSON) {
    const byHour = bucketize(entries, (e) => String(tehranHour(e)).padStart(2, '0'));
    const byDay = bucketize(entries, dayOfWeek);
    const byDate = bucketize(entries, tehranDate);
    console.log(JSON.stringify({
      meta: { scans: entries.length, first: entries[0].ts, last: entries[entries.length - 1].ts },
      byHour: Object.fromEntries(byHour),
      byDay: Object.fromEntries(byDay),
      byDate: Object.fromEntries(byDate),
    }, null, 2));
  } else {
    printReport(entries);
  }
}

main();
