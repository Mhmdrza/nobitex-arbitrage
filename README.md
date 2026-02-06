# Nobitex Arbitrage Scanner

Detects triangular and cross-pair arbitrage opportunities on [Nobitex](https://nobitex.ir) exchange.

**Live report:** [https://mhmdrza.github.io/nobitex-arbitrage/](https://mhmdrza.github.io/nobitex-arbitrage/)

## Strategies

| Strategy | Legs | Path |
|----------|------|------|
| Triangle CW | 3 | IRT → buy X → sell X for USDT → sell USDT for IRT |
| Triangle CCW | 3 | IRT → buy USDT → buy X with USDT → sell X for IRT |
| Cross-pair | 4 | IRT → buy X → sell X for USDT → buy Y with USDT → sell Y for IRT |

## Quick Start

```bash
npm install

# Single scan
npm run scan:once

# Continuous scanning (every 60s)
npm run scan

# Fast mode (every 30s)
npm run scan:fast

# Night mode — run before bed (every 2min, quiet)
npm run scan:night

# Analyze patterns
npm run analyze
```

## CLI Options

### Scanner (`scripts/scanner.ts`)

| Flag | Default | Description |
|------|---------|-------------|
| `--interval <s>` | 60 | Scan interval in seconds |
| `--base <cur>` | USDT | Base currency |
| `--fee <pct>` | 0.35 | Fee per trade (%) |
| `--out <dir>` | docs/data | Output directory |
| `--top <n>` | 20 | Top opps in timeline |
| `--once` | - | Run once and exit |
| `--quiet` | - | Minimal output |

### Analyzer (`scripts/analyze.ts`)

| Flag | Default | Description |
|------|---------|-------------|
| `--file <path>` | docs/data/timeline.jsonl | Input file |
| `--min-net <pct>` | 0 | Min net% filter |
| `--json` | - | Output raw JSON |

## Data Format

**Timeline** (`docs/data/timeline.jsonl`) — one JSON line per scan:
- Timestamp, pair count, opportunity counts
- Best net%, top N opportunities (compact)
- Used by GitHub Pages report

**Snapshots** (`docs/data/snapshots/YYYY-MM-DD/HHmmss.json`) — full detail per scan (gitignored).

## GitHub Action

Runs every 15 minutes, appends to `timeline.jsonl`, commits and pushes.
GitHub Pages at `docs/` serves the interactive report.

## Manual Push

To push local scan data to the report:

```bash
git add docs/data/timeline.jsonl
git commit -m "data: manual push"
git push
```
