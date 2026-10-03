/**
 * State construction, accessors and fingerprints.
 *
 * `EngineState` is ordinary JSON-shaped data. That is deliberate: it can be
 * cloned with `structuredClone`, snapshotted, hashed and diffed without any
 * serializer hooks, and a fork can hold a stale copy of history without the
 * original timeline noticing.
 */

import { canonicalJson } from "../core/canonical.ts";
import { sha256Hex } from "../core/hash.ts";
import type {
  AccountState,
  EngineState,
  Ledger,
  MarketStats,
  OrderState,
  PriceLevel,
  SessionConfig,
} from "./types.ts";

export class StateError extends Error {}

/** Narrow `T | undefined` to `T`, with a message that names the invariant. */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) {
    throw new StateError(`missing ${what}`);
  }
  return value;
}

export function emptyStats(): MarketStats {
  return {
    lastPrice: null,
    openPrice: null,
    high: null,
    low: null,
    vwapNumerator: 0,
    vwapDenominator: 0,
    tradeCount: 0,
    volume: 0,
    rejectedOrders: 0,
    cancelledOrders: 0,
  };
}

export function createInitialState(config: SessionConfig): EngineState {
  const accounts: Record<string, AccountState> = {};
  for (const participant of config.participants) {
    accounts[participant.owner] = {
      owner: participant.owner,
      cash: 0,
      reservedCash: 0,
      positions: 0,
      reservedShares: 0,
    };
  }
  return {
    seq: 0,
    vt: config.startVt,
    session: "CLOSED",
    sessionIndex: 0,
    symbol: config.instrument.symbol,
    accounts,
    orders: {},
    bids: [],
    asks: [],
    trades: [],
    stats: emptyStats(),
    ledger: { depositedCash: 0, grantedShares: 0 },
  };
}

export function cloneState(state: EngineState): EngineState {
  return structuredClone(state);
}

export function requireAccount(state: EngineState, owner: string): AccountState {
  const account = state.accounts[owner];
  if (!account) throw new StateError(`unknown account '${owner}'`);
  return account;
}

export function accountOrCreate(state: EngineState, owner: string): AccountState {
  let account = state.accounts[owner];
  if (!account) {
    account = { owner, cash: 0, reservedCash: 0, positions: 0, reservedShares: 0 };
    state.accounts[owner] = account;
  }
  return account;
}

export function requireOrder(state: EngineState, orderId: string): OrderState {
  const order = state.orders[orderId];
  if (!order) throw new StateError(`unknown order '${orderId}'`);
  return order;
}

/* ------------------------------------------------------------ fingerprints */

export interface StateDigests {
  /** Whole state. Any divergence anywhere changes this. */
  state: string;
  /** Just the two book sides — "did the market change shape?". */
  book: string;
  /** Just balances and positions — "did the accounting change?". */
  accounts: string;
  /** Just the order lifecycle map. */
  orders: string;
}

/**
 * Four independent fingerprints instead of one.
 *
 * The UI (and the counterfactual report) uses them to say *what* diverged, not
 * merely *that* something diverged: a fork can leave the book identical while
 * silently changing balances, and that is exactly the class of bug this project
 * exists to surface.
 */
export function digests(state: EngineState): StateDigests {
  return {
    state: sha256Hex(canonicalJson(state)),
    book: sha256Hex(canonicalJson({ bids: state.bids, asks: state.asks })),
    accounts: sha256Hex(canonicalJson(state.accounts)),
    orders: sha256Hex(canonicalJson(state.orders)),
  };
}

export function stateHash(state: EngineState): string {
  return sha256Hex(canonicalJson(state));
}

/* ---------------------------------------------------------------- accessors */

export function spendableCash(state: EngineState, owner: string): number {
  const account = requireAccount(state, owner);
  return account.cash;
}

export function availableShares(state: EngineState, owner: string): number {
  const account = requireAccount(state, owner);
  return account.positions - account.reservedShares;
}

export function openOrdersOf(state: EngineState, owner: string): OrderState[] {
  const out: OrderState[] = [];
  for (const order of Object.values(state.orders)) {
    if (order.owner === owner && order.status === "OPEN") out.push(order);
  }
  out.sort((a, b) => a.placedSeq - b.placedSeq);
  return out;
}

/** Total cash + reserved cash across every account. Invariant: constant. */
export function totalCash(state: EngineState): number {
  let total = 0;
  for (const account of Object.values(state.accounts)) {
    total += account.cash + account.reservedCash;
  }
  return total;
}

/** Settled + reserved shares across every account. Invariant: constant. */
export function totalShares(state: EngineState): number {
  let total = 0;
  for (const account of Object.values(state.accounts)) {
    total += account.positions + account.reservedShares;
  }
  return total;
}

export function bestBid(state: EngineState): number | null {
  return state.bids[0]?.price ?? null;
}

export function bestAsk(state: EngineState): number | null {
  return state.asks[0]?.price ?? null;
}

/** Midpoint including half-ticks: doubled so it stays an integer. */
export function midPriceX2(state: EngineState): number | null {
  const bid = bestBid(state);
  const ask = bestAsk(state);
  if (bid === null && ask === null) return null;
  if (bid === null) return (ask as number) * 2;
  if (ask === null) return bid * 2;
  return bid + ask;
}

export function vwap(state: EngineState): number | null {
  if (state.stats.vwapDenominator === 0) return null;
  return state.stats.vwapNumerator / state.stats.vwapDenominator;
}

export function ledger(state: EngineState): Ledger {
  return state.ledger;
}

/* ------------------------------------------------------------ presentation */

export interface BookViewRow {
  price: number;
  qty: number;
  orders: number;
  depthPct: number;
}

export interface BookView {
  symbol: string;
  bids: BookViewRow[];
  asks: BookViewRow[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midX2: number | null;
}

/**
 * Top-of-book ladder for the UI. Presentation only — the percentages are the
 * one place a float is allowed, because nothing depends on them.
 */
export function bookView(state: EngineState, depth = 12): BookView {
  const toRows = (levels: readonly PriceLevel[]): BookViewRow[] =>
    levels.slice(0, depth).map((level) => ({
      price: level.price,
      qty: level.totalQty,
      orders: level.orders.length,
      depthPct: 0,
    }));

  const bids = toRows(state.bids);
  const asks = toRows(state.asks);
  const peak = Math.max(1, ...bids.map((r) => r.qty), ...asks.map((r) => r.qty));
  for (const row of [...bids, ...asks]) row.depthPct = row.qty / peak;

  const bid = bids[0]?.price ?? null;
  const ask = asks[0]?.price ?? null;
  return {
    symbol: state.symbol,
    bids,
    asks,
    bestBid: bid,
    bestAsk: ask,
    spread: bid !== null && ask !== null ? ask - bid : null,
    midX2: midPriceX2(state),
  };
}
