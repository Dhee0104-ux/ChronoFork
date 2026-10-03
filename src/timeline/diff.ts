/**
 * Semantic diff between two points in history.
 *
 * A byte-level diff of two states is useless here ("line 214 changed"). What a
 * person actually asks is: *whose* money moved, *how much*, and did the market
 * itself change shape? So the diff is domain-shaped — accounts, book levels,
 * market statistics, order lifecycle counts — and each section is summarized
 * into a sentence.
 */

import { digests, type StateDigests } from "../engine/state.ts";
import type {
  AccountState,
  EngineState,
  OrderState,
  PriceLevel,
  Side,
  TradeRecord,
} from "../engine/types.ts";

export interface AccountDelta {
  owner: string;
  cash: number;
  cashDelta: number;
  reservedCash: number;
  reservedCashDelta: number;
  positions: number;
  positionsDelta: number;
  totalDelta: number;
  /** Value at the other state's last price, so the two are comparable. */
  netWorthDelta: number;
}

export interface LevelDelta {
  price: number;
  qtyA: number;
  qtyB: number;
  delta: number;
}

export interface MarketDelta {
  tradesA: number;
  tradesB: number;
  volumeA: number;
  volumeB: number;
  lastPriceA: number | null;
  lastPriceB: number | null;
  highA: number | null;
  highB: number | null;
  lowA: number | null;
  lowB: number | null;
  vwapA: number | null;
  vwapB: number | null;
}

export interface LifecycleDelta {
  placedA: number;
  placedB: number;
  filledA: number;
  filledB: number;
  cancelledA: number;
  cancelledB: number;
  rejectedA: number;
  rejectedB: number;
  openA: number;
  openB: number;
}

export interface OrderDelta {
  id: string;
  owner: string;
  /** Which fields disagree, in a stable order. */
  fields: string[];
  a: OrderState;
  b: OrderState;
}

export interface StateDiff {
  identical: boolean;
  digests: { a: StateDigests; b: StateDigests; stateEqual: boolean; bookEqual: boolean; accountsEqual: boolean; ordersEqual: boolean };
  accounts: AccountDelta[];
  /** Ticket-level differences: the same order, stored differently. */
  orders: { changed: OrderDelta[]; changedA: number; changedB: number; truncated: boolean };
  book: {
    bestBidA: number | null;
    bestBidB: number | null;
    bestAskA: number | null;
    bestAskB: number | null;
    spreadA: number | null;
    spreadB: number | null;
    depthBidA: number;
    depthBidB: number;
    depthAskA: number;
    depthAskB: number;
    levels: LevelDelta[];
  };
  market: MarketDelta;
  lifecycle: LifecycleDelta;
  narration: string[];
}

export function diffStates(a: EngineState, b: EngineState): StateDiff {
  const digestsA = digests(a);
  const digestsB = digests(b);

  const accounts = accountDeltas(a, b);
  const book = bookDelta(a, b);
  const market = marketDelta(a, b);
  const lifecycle = lifecycleDelta(a, b);
  const orders = orderDeltas(a, b);

  const diff: StateDiff = {
    identical: digestsA.state === digestsB.state,
    digests: {
      a: digestsA,
      b: digestsB,
      stateEqual: digestsA.state === digestsB.state,
      bookEqual: digestsA.book === digestsB.book,
      accountsEqual: digestsA.accounts === digestsB.accounts,
      ordersEqual: digestsA.orders === digestsB.orders,
    },
    accounts,
    orders,
    book,
    market,
    lifecycle,
    narration: [],
  };

  diff.narration = narrate(diff);
  return diff;
}

/* --------------------------------------------------------------- accounts */

function accountDeltas(a: EngineState, b: EngineState): AccountDelta[] {
  const owners = new Set([...Object.keys(a.accounts), ...Object.keys(b.accounts)]);
  const referenceA = a.stats.lastPrice;
  const referenceB = b.stats.lastPrice;
  const out: AccountDelta[] = [];

  for (const owner of owners) {
    const left = a.accounts[owner] ?? emptyAccount(owner);
    const right = b.accounts[owner] ?? emptyAccount(owner);
    const totalDelta = total(left) - total(right);
    if (totalDelta === 0 && left.positions === right.positions) continue;
    out.push({
      owner,
      cash: right.cash,
      cashDelta: right.cash - left.cash,
      reservedCash: right.reservedCash,
      reservedCashDelta: right.reservedCash - left.reservedCash,
      positions: right.positions,
      positionsDelta: right.positions - left.positions,
      totalDelta,
      netWorthDelta: netWorth(right, referenceB) - netWorth(left, referenceA),
    });
  }
  out.sort((x, y) => Math.abs(y.totalDelta) - Math.abs(x.totalDelta));
  return out;
}

function emptyAccount(owner: string): AccountState {
  return { owner, cash: 0, reservedCash: 0, positions: 0, reservedShares: 0 };
}

function total(account: AccountState): number {
  return account.cash + account.reservedCash;
}

function netWorth(account: AccountState, referencePrice: number | null): number {
  const shares = account.positions + account.reservedShares;
  return total(account) + shares * (referencePrice ?? 0);
}

/* ----------------------------------------------------------------- orders */

const ORDER_FIELDS = ["owner", "side", "price", "qty", "remaining", "filled", "status", "tif", "clientRef", "placedVt", "expiresAt", "cancelReason"] as const;

/**
 * Ticket-level diff. Deliberately capped: this is a UI section, and a
 * counterfactual that rewrites half the order map should still render.
 */
function orderDeltas(a: EngineState, b: EngineState, limit = 40): StateDiff["orders"] {
  const changed: OrderDelta[] = [];
  let changedA = 0;
  let changedB = 0;
  let truncated = false;

  for (const id of Object.keys(a.orders)) {
    const left = a.orders[id] as OrderState;
    const right = b.orders[id];
    if (!right) {
      changedA += 1;
      continue;
    }
    const fields = ORDER_FIELDS.filter((field) => left[field] !== right[field]);
    if (fields.length === 0) continue;
    if (changed.length < limit) changed.push({ id, owner: right.owner, fields: [...fields], a: left, b: right });
    else truncated = true;
  }
  for (const id of Object.keys(b.orders)) {
    if (!a.orders[id]) changedB += 1;
  }

  changed.sort((x, y) => (x.a.placedSeq as number) - (y.a.placedSeq as number));
  return { changed, changedA, changedB, truncated };
}

/* ------------------------------------------------------------------- book */

function bookDelta(a: EngineState, b: EngineState): StateDiff["book"] {
  const levels = new Map<number, LevelDelta>();
  const merge = (side: readonly PriceLevel[], key: "qtyA" | "qtyB"): void => {
    for (const level of side) {
      const row = levels.get(level.price) ?? { price: level.price, qtyA: 0, qtyB: 0, delta: 0 };
      row[key] += level.totalQty;
      levels.set(level.price, row);
    }
  };
  merge(a.bids, "qtyA");
  merge(a.asks, "qtyA");
  merge(b.bids, "qtyB");
  merge(b.asks, "qtyB");

  const rows = [...levels.values()]
    .map((row) => ({ ...row, delta: row.qtyB - row.qtyA }))
    .filter((row) => row.delta !== 0)
    .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

  const bestBidA = a.bids[0]?.price ?? null;
  const bestBidB = b.bids[0]?.price ?? null;
  const bestAskA = a.asks[0]?.price ?? null;
  const bestAskB = b.asks[0]?.price ?? null;

  return {
    bestBidA,
    bestBidB,
    bestAskA,
    bestAskB,
    spreadA: bestBidA !== null && bestAskA !== null ? bestAskA - bestBidA : null,
    spreadB: bestBidB !== null && bestAskB !== null ? bestAskB - bestBidB : null,
    depthBidA: depth(a.bids),
    depthBidB: depth(b.bids),
    depthAskA: depth(a.asks),
    depthAskB: depth(b.asks),
    levels: rows.slice(0, 24),
  };
}

function depth(levels: readonly PriceLevel[]): number {
  let total = 0;
  for (const level of levels) total += level.totalQty;
  return total;
}

/* ----------------------------------------------------------------- market */

function marketDelta(a: EngineState, b: EngineState): MarketDelta {
  return {
    tradesA: a.stats.tradeCount,
    tradesB: b.stats.tradeCount,
    volumeA: a.stats.volume,
    volumeB: b.stats.volume,
    lastPriceA: a.stats.lastPrice,
    lastPriceB: b.stats.lastPrice,
    highA: a.stats.high,
    highB: b.stats.high,
    lowA: a.stats.low,
    lowB: b.stats.low,
    vwapA: ratio(a.stats.vwapNumerator, a.stats.vwapDenominator),
    vwapB: ratio(b.stats.vwapNumerator, b.stats.vwapDenominator),
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function lifecycleDelta(a: EngineState, b: EngineState): LifecycleDelta {
  const count = (state: EngineState, status: OrderState["status"] | "REJECTED"): number => {
    if (status === "REJECTED") return state.stats.rejectedOrders;
    let n = 0;
    for (const order of Object.values(state.orders)) if (order.status === status) n += 1;
    return n;
  };
  return {
    placedA: Object.keys(a.orders).length,
    placedB: Object.keys(b.orders).length,
    filledA: count(a, "FILLED"),
    filledB: count(b, "FILLED"),
    cancelledA: count(a, "CANCELLED"),
    cancelledB: count(b, "CANCELLED"),
    rejectedA: count(a, "REJECTED"),
    rejectedB: count(b, "REJECTED"),
    openA: count(a, "OPEN"),
    openB: count(b, "OPEN"),
  };
}

/* -------------------------------------------------------------- narration */

/**
 * Turn the diff into sentences. This is the part a human reads, so it leads with
 * the biggest economic consequence and stays quiet about noise.
 */
export function narrate(diff: StateDiff): string[] {
  const lines: string[] = [];

  if (diff.identical) {
    return ["Both histories end in exactly the same state — the edit changed the path, not the destination."];
  }

  const tradeDelta = diff.market.tradesB - diff.market.tradesA;
  if (tradeDelta !== 0) {
    lines.push(
      `${Math.abs(tradeDelta)} ${tradeDelta > 0 ? "more" : "fewer"} print${Math.abs(tradeDelta) === 1 ? "" : "s"}` +
        ` (${diff.market.volumeB - diff.market.volumeA > 0 ? "+" : ""}${diff.market.volumeB - diff.market.volumeA} shares).`,
    );
  }

  if (diff.market.lastPriceA !== diff.market.lastPriceB) {
    lines.push(
      `Last price ends at ${cents(diff.market.lastPriceA)} vs ${cents(diff.market.lastPriceB)}.`,
    );
  }

  if (diff.book.bestAskA !== diff.book.bestAskB && diff.book.bestAskB !== null) {
    lines.push(
      `Best ask moved from ${cents(diff.book.bestAskA)} to ${cents(diff.book.bestAskB)}.`,
    );
  }
  if (diff.book.bestBidA !== diff.book.bestBidB && diff.book.bestBidB !== null) {
    lines.push(
      `Best bid moved from ${cents(diff.book.bestBidA)} to ${cents(diff.book.bestBidB)}.`,
    );
  }

  for (const account of diff.accounts.slice(0, 3)) {
    const parts: string[] = [];
    if (account.cashDelta !== 0) {
      parts.push(`${account.cashDelta > 0 ? "+" : ""}${cents(account.cashDelta)} cash`);
    }
    if (account.positionsDelta !== 0) {
      parts.push(`${account.positionsDelta > 0 ? "+" : ""}${account.positionsDelta} shares`);
    }
    if (parts.length === 0) continue;
    lines.push(`${account.owner}: ${parts.join(", ")}.`);
  }

  const openDelta = diff.lifecycle.openB - diff.lifecycle.openA;
  if (openDelta !== 0) {
    lines.push(
      `${Math.abs(openDelta)} ${openDelta > 0 ? "more" : "fewer"} order${
        Math.abs(openDelta) === 1 ? "" : "s"
      } left open at the end.`,
    );
  }

  // Depth changes are the difference a headline metric misses entirely: the
  // touch can be identical while a level ten ticks down has entirely changed
  // hands. Lead with the biggest single level so it is not buried.
  if (!diff.digests.bookEqual && diff.book.levels.length > 0) {
    const biggest = diff.book.levels[0] as LevelDelta;
    if (biggest !== undefined) {
      lines.push(
        `Deepest change: the ${cents(biggest.price)} level goes from ${biggest.qtyA} to ${biggest.qtyB} shares ` +
          `(${diff.book.levels.length} level${diff.book.levels.length === 1 ? "" : "s"} touched).`,
      );
    }
  }

  // The subtlest case of all: the book ends the same shape, every balance is
  // identical, and yet the two runs are not the same market — because the
  // *tickets* differ. A one-tick edit to a limit price lands here: nothing about
  // the destination changes, everything about how it was reached does. Say so
  // rather than reporting "no change".
  if (lines.length === 0 && !diff.digests.ordersEqual) {
    const changed = changedOrderCount(diff);
    lines.push(
      changed > 0
        ? `Same book, same balances: what differs is ${changed} order record${changed === 1 ? "" : "s"} — a different price or size on the same tickets.`
        : "Same book, same balances: only the order records behind them differ.",
    );
  }

  if (lines.length === 0) {
    lines.push("State differs, but no headline metric moved.");
  }
  return lines;
}

/** Orders whose stored fields differ between the two states. */
function changedOrderCount(diff: StateDiff): number {
  const changed = diff.orders.changed.length;
  return changed > 0 ? changed : diff.orders.changedA + diff.orders.changedB;
}

function cents(value: number | null): string {
  if (value === null) return "n/a";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}$${Math.floor(abs / 100)}.${String(Math.round(abs % 100)).padStart(2, "0")}`;
}

/* ---------------------------------------------------------- price series */

export interface SeriesPoint {
  k: number;
  price: number;
  qty: number;
  aggressorSide: Side;
}

/** Trade prints as a series, for the divergence chart. */
export function tradeSeries(state: EngineState, limit = 400): SeriesPoint[] {
  const trades: readonly TradeRecord[] = state.trades;
  const start = Math.max(0, trades.length - limit);
  const out: SeriesPoint[] = [];
  for (let i = start; i < trades.length; i++) {
    const trade = trades[i] as TradeRecord;
    out.push({
      k: trade.seq,
      price: trade.price,
      qty: trade.qty,
      aggressorSide: trade.aggressorSide,
    });
  }
  return out;
}

/**
 * Compare two trade tapes: which prints are shared, which belong to only one
 * history. Used by the UI to draw the moment the two runs part company.
 */
export function tapeDivergence(a: readonly SeriesPoint[], b: readonly SeriesPoint[]): {
  sharedPrefix: number;
  onlyA: SeriesPoint[];
  onlyB: SeriesPoint[];
} {
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit) {
    const left = a[shared] as SeriesPoint;
    const right = b[shared] as SeriesPoint;
    if (left.price !== right.price || left.qty !== right.qty || left.aggressorSide !== right.aggressorSide) {
      break;
    }
    shared += 1;
  }
  return { sharedPrefix: shared, onlyA: a.slice(shared), onlyB: b.slice(shared) };
}
