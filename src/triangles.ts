/**
 * Arbitrage detection for Nobitex.
 *
 * Strategy 1 — Triangle (3 legs):
 *   CW:  IRT → buy X   → sell X for BASE → sell BASE for IRT
 *   CCW: IRT → buy BASE → buy X with BASE → sell X for IRT
 *
 * Strategy 2 — Cross-pair (4 legs):
 *   IRT → buy X → sell X for BASE → buy Y with BASE → sell Y for IRT
 *   Exploits price discrepancies between two assets via the BASE bridge,
 *   without touching the BASE/IRT pair directly.
 *
 * BASE is configurable (default USDT).
 */

/* ═══════════════════════════════════════════════════════════════════ *
 *  Types                                                             *
 * ═══════════════════════════════════════════════════════════════════ */

export interface MarketPair {
  symbol: string;
  asset: string;
  quote: string;
  bestBid: number;
  bestBidQty: number;
  bestAsk: number;
  bestAskQty: number;
}

export interface Leg {
  pair: string;
  side: 'buy' | 'sell';
  price: number;
  availableQty: number;
  qtyUnit: string;
}

export type StrategyType = 'triangle' | 'cross';
export type Direction = 'cw' | 'ccw' | 'cross';

export interface Opportunity {
  type: StrategyType;
  assets: string[];           // [X] for triangle, [X, Y] for cross-pair
  base: string;
  direction: Direction;
  legs: Leg[];                // 3 for triangle, 4 for cross-pair
  rate: number;
  grossPct: number;
  feePct: number;
  netPct: number;
  maxVolumeIRT: number;
  expectedProfitIRT: number;
  bottleneckLeg: number;
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Parsing                                                           *
 * ═══════════════════════════════════════════════════════════════════ */

export function parseSymbol(
  symbol: string,
): { asset: string; quote: string } | null {
  if (symbol.length > 4 && symbol.endsWith('USDT'))
    return { asset: symbol.slice(0, -4), quote: 'USDT' };
  if (symbol.length > 3 && symbol.endsWith('IRT'))
    return { asset: symbol.slice(0, -3), quote: 'IRT' };
  return null;
}

export function parseAllPairs(
  data: Record<string, unknown>,
): MarketPair[] {
  const pairs: MarketPair[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'status' || value == null || typeof value !== 'object') continue;
    const parsed = parseSymbol(key);
    if (!parsed) continue;
    const m = value as Record<string, unknown>;
    const bids = m.bids as string[][] | undefined;
    const asks = m.asks as string[][] | undefined;
    if (!bids?.length || !asks?.length) continue;
    const bestBid = Number(bids[0][0]);
    const bestBidQty = Number(bids[0][1]);
    const bestAsk = Number(asks[0][0]);
    const bestAskQty = Number(asks[0][1]);
    if (!(bestBid > 0) || !(bestAsk > 0)) continue;
    if (!isFinite(bestBid) || !isFinite(bestAsk)) continue;
    pairs.push({
      symbol: key,
      asset: parsed.asset,
      quote: parsed.quote,
      bestBid,
      bestBidQty: isFinite(bestBidQty) && bestBidQty > 0 ? bestBidQty : 0,
      bestAsk,
      bestAskQty: isFinite(bestAskQty) && bestAskQty > 0 ? bestAskQty : 0,
    });
  }
  return pairs;
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Base currency detection                                           *
 * ═══════════════════════════════════════════════════════════════════ */

export function getAvailableBases(pairs: MarketPair[]): string[] {
  const idx = new Map<string, MarketPair>();
  const quotes = new Set<string>();
  for (const p of pairs) {
    idx.set(`${p.asset}:${p.quote}`, p);
    quotes.add(p.quote);
  }
  quotes.delete('IRT');
  const bases: string[] = [];
  for (const q of quotes) {
    if (!idx.has(`${q}:IRT`)) continue;
    let ok = false;
    for (const p of pairs) {
      if (p.quote === 'IRT' && p.asset !== q && idx.has(`${p.asset}:${q}`)) {
        ok = true;
        break;
      }
    }
    if (ok) bases.push(q);
  }
  return bases.sort();
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Internal: per-asset precomputed info                              *
 * ═══════════════════════════════════════════════════════════════════ */

interface AssetEntry {
  asset: string;
  irt: MarketPair;   // X+IRT
  base: MarketPair;  // X+BASE
}

function buildAssetEntries(
  pairs: MarketPair[],
  baseCurrency: string,
): AssetEntry[] {
  const idx = new Map<string, MarketPair>();
  for (const p of pairs) idx.set(`${p.asset}:${p.quote}`, p);

  const entries: AssetEntry[] = [];
  for (const p of pairs) {
    if (p.quote !== 'IRT' || p.asset === baseCurrency) continue;
    const bp = idx.get(`${p.asset}:${baseCurrency}`);
    if (!bp) continue;
    entries.push({ asset: p.asset, irt: p, base: bp });
  }
  return entries;
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Strategy 1 — Triangle (3 legs)                                    *
 * ═══════════════════════════════════════════════════════════════════ */

export function findTriangles(
  pairs: MarketPair[],
  baseCurrency: string,
  feeRatePct: number,
): Opportunity[] {
  const idx = new Map<string, MarketPair>();
  for (const p of pairs) idx.set(`${p.asset}:${p.quote}`, p);

  const bridge = idx.get(`${baseCurrency}:IRT`);
  if (!bridge) return [];

  const entries = buildAssetEntries(pairs, baseCurrency);
  const totalFee = 3 * feeRatePct;
  const results: Opportunity[] = [];

  for (const { asset, irt: xIrt, base: xBase } of entries) {
    /* CW: IRT → X → BASE → IRT */
    {
      const rate = (xBase.bestBid * bridge.bestBid) / xIrt.bestAsk;
      const grossPct = (rate - 1) * 100;
      const netPct = grossPct - totalFee;
      const l1 = xIrt.bestAskQty;
      const l2 = xBase.bestBidQty;
      const l3 = xBase.bestBid > 0 ? bridge.bestBidQty / xBase.bestBid : 0;
      const maxX = Math.min(l1, l2, l3);
      const vol = maxX * xIrt.bestAsk;
      const profit = (netPct / 100) * vol;
      const bn = maxX === l1 ? 0 : maxX === l2 ? 1 : 2;
      if (isFinite(rate) && vol > 0) {
        results.push({
          type: 'triangle', assets: [asset], base: baseCurrency, direction: 'cw',
          legs: [
            { pair: xIrt.symbol,   side: 'buy',  price: xIrt.bestAsk,   availableQty: xIrt.bestAskQty,   qtyUnit: asset },
            { pair: xBase.symbol,  side: 'sell', price: xBase.bestBid,  availableQty: xBase.bestBidQty,  qtyUnit: asset },
            { pair: bridge.symbol, side: 'sell', price: bridge.bestBid, availableQty: bridge.bestBidQty, qtyUnit: baseCurrency },
          ],
          rate, grossPct, feePct: totalFee, netPct,
          maxVolumeIRT: vol, expectedProfitIRT: profit, bottleneckLeg: bn,
        });
      }
    }

    /* CCW: IRT → BASE → X → IRT */
    {
      const rate = xIrt.bestBid / (xBase.bestAsk * bridge.bestAsk);
      const grossPct = (rate - 1) * 100;
      const netPct = grossPct - totalFee;
      const l1 = xBase.bestAsk > 0 ? bridge.bestAskQty / xBase.bestAsk : 0;
      const l2 = xBase.bestAskQty;
      const l3 = xIrt.bestBidQty;
      const maxX = Math.min(l1, l2, l3);
      const vol = maxX * xBase.bestAsk * bridge.bestAsk;
      const profit = (netPct / 100) * vol;
      const bn = maxX === l1 ? 0 : maxX === l2 ? 1 : 2;
      if (isFinite(rate) && vol > 0) {
        results.push({
          type: 'triangle', assets: [asset], base: baseCurrency, direction: 'ccw',
          legs: [
            { pair: bridge.symbol, side: 'buy',  price: bridge.bestAsk, availableQty: bridge.bestAskQty, qtyUnit: baseCurrency },
            { pair: xBase.symbol,  side: 'buy',  price: xBase.bestAsk,  availableQty: xBase.bestAskQty,  qtyUnit: asset },
            { pair: xIrt.symbol,   side: 'sell', price: xIrt.bestBid,   availableQty: xIrt.bestBidQty,   qtyUnit: asset },
          ],
          rate, grossPct, feePct: totalFee, netPct,
          maxVolumeIRT: vol, expectedProfitIRT: profit, bottleneckLeg: bn,
        });
      }
    }
  }

  return results;
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Strategy 2 — Cross-pair (4 legs)                                  *
 *  IRT → buy X → sell X for BASE → buy Y with BASE → sell Y for IRT *
 *  rate = (X_BASE_bid × Y_IRT_bid) / (X_IRT_ask × Y_BASE_ask)      *
 * ═══════════════════════════════════════════════════════════════════ */

export function findCrossPairs(
  pairs: MarketPair[],
  baseCurrency: string,
  feeRatePct: number,
  maxResults = 200,
): Opportunity[] {
  const entries = buildAssetEntries(pairs, baseCurrency);
  const totalFee = 4 * feeRatePct;
  const results: Opportunity[] = [];

  const withRatios = entries.map((e) => ({
    ...e,
    sellRatio: e.base.bestBid / e.irt.bestAsk,
    buyRatio:  e.irt.bestBid / e.base.bestAsk,
  }));

  const K = Math.min(withRatios.length, 60);
  const bySell = [...withRatios].sort((a, b) => b.sellRatio - a.sellRatio).slice(0, K);
  const byBuy  = [...withRatios].sort((a, b) => b.buyRatio  - a.buyRatio).slice(0, K);

  for (const seller of bySell) {
    for (const buyer of byBuy) {
      if (seller.asset === buyer.asset) continue;

      const rate = seller.sellRatio * buyer.buyRatio;
      const grossPct = (rate - 1) * 100;
      const netPct = grossPct - totalFee;

      if (netPct < -5) continue;

      const l1 = seller.irt.bestAskQty;
      const l2 = seller.base.bestBidQty;
      const l3 = seller.base.bestBid > 0
        ? (buyer.base.bestAskQty * buyer.base.bestAsk) / seller.base.bestBid : 0;
      const l4 = seller.base.bestBid > 0
        ? (buyer.irt.bestBidQty * buyer.base.bestAsk) / seller.base.bestBid : 0;

      const maxX = Math.min(l1, l2, l3, l4);
      const vol = maxX * seller.irt.bestAsk;
      const profit = (netPct / 100) * vol;

      if (!isFinite(rate) || vol <= 0) continue;

      const bn = maxX === l1 ? 0 : maxX === l2 ? 1 : maxX === l3 ? 2 : 3;

      results.push({
        type: 'cross',
        assets: [seller.asset, buyer.asset],
        base: baseCurrency,
        direction: 'cross',
        legs: [
          { pair: seller.irt.symbol,  side: 'buy',  price: seller.irt.bestAsk,  availableQty: seller.irt.bestAskQty,  qtyUnit: seller.asset },
          { pair: seller.base.symbol, side: 'sell', price: seller.base.bestBid, availableQty: seller.base.bestBidQty, qtyUnit: seller.asset },
          { pair: buyer.base.symbol,  side: 'buy',  price: buyer.base.bestAsk,  availableQty: buyer.base.bestAskQty,  qtyUnit: buyer.asset },
          { pair: buyer.irt.symbol,   side: 'sell', price: buyer.irt.bestBid,   availableQty: buyer.irt.bestBidQty,   qtyUnit: buyer.asset },
        ],
        rate, grossPct, feePct: totalFee, netPct,
        maxVolumeIRT: vol, expectedProfitIRT: profit, bottleneckLeg: bn,
      });
    }
  }

  results.sort((a, b) => b.netPct - a.netPct);
  return results.slice(0, maxResults);
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Combined finder                                                   *
 * ═══════════════════════════════════════════════════════════════════ */

export function findAllOpportunities(
  pairs: MarketPair[],
  baseCurrency: string,
  feeRatePct: number,
): Opportunity[] {
  const triangles = findTriangles(pairs, baseCurrency, feeRatePct);
  const crosses   = findCrossPairs(pairs, baseCurrency, feeRatePct);
  const all = [...triangles, ...crosses];
  all.sort((a, b) => b.netPct - a.netPct);
  return all;
}

/* ═══════════════════════════════════════════════════════════════════ *
 *  Formatters                                                        *
 * ═══════════════════════════════════════════════════════════════════ */

export function formatIRT(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(1) + 'T';
  if (abs >= 1e9)  return sign + (abs / 1e9).toFixed(1)  + 'B';
  if (abs >= 1e6)  return sign + (abs / 1e6).toFixed(1)  + 'M';
  if (abs >= 1e3)  return sign + (abs / 1e3).toFixed(1)  + 'K';
  return sign + abs.toFixed(0);
}

export function formatPct(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(3) + '%';
}

const priceFmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 8 });
export function formatPrice(n: number): string {
  return priceFmt.format(n);
}

const amountFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
export function formatAmount(n: number): string {
  if (Math.abs(n) >= 1e9) return formatIRT(n);
  return amountFmt.format(n);
}
