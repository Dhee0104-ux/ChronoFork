/**
 * Invariants: the properties that must hold after *every single event*.
 *
 * These are not unit tests. They are a runtime verifier that can be pointed at
 * any log — including a log someone edited by hand — and will report the exact
 * event index at which reality stopped making sense. The counterfactual engine
 * leans on them: a fork is only interesting if you can still tell whether the
 * alternative history was *legal*.
 *
 * Every check is total: it must work on any state, including states produced by
 * a corrupted log, so none of them may throw on malformed input.
 */

import { makeOrderId, makeTradeId } from "./ids.ts";
import { totalCash, totalShares } from "./state.ts";
import type {
  AccountState,
  CancelReason,
  EngineState,
  EventCore,
  InstrumentConfig,
  OrderState,
  PriceLevel,
  TradeRecord,
} from "./types.ts";

export interface Violation {
  invariant: string;
  subject: string;
  detail: string;
}

export interface InvariantContext {
  instrument: InstrumentConfig;
}

/**
 * Which subjects an invariant has to look at this time round.
 *
 * Some invariants are statements about *history*: "every print joined two orders
 * that existed" is checked over all 590 prints, and re-checking all of them after
 * each of 5,374 events is quadratic — 19 seconds on a session this size, versus
 * microseconds for the delta. The monitor folds a log one event at a time, which
 * means it already knows the answer held a moment ago, and an event can only
 * create one order and one print. So checking just what the event touched is not
 * an approximation: it is the same answer, computed once.
 *
 * The two shapes are deliberately different:
 *
 *   - `undefined`  → this invariant must scan everything (a full verification).
 *   - an empty set → nothing was touched, so there is nothing new to assert.
 *
 * The monitor passes a scope; `checkInvariants(state, ctx)` does not, which keeps
 * the standalone call a full, exhaustive check.
 */
export interface InvariantScope {
  /** Order ids created or modified by the event being applied. */
  orders?: ReadonlySet<string>;
  /** Trade ids appended by the event being applied. */
  trades?: ReadonlySet<string>;
  /**
   * The order the stream is currently in the middle of placing, if any.
   *
   * A placement is several events long: the order exists and holds its
   * reservation from ORDER_PLACED, but only reaches the book at ORDER_RESTED, so
   * in between it is legitimately absent from the book. The newest order is the
   * only one that can be in that state — nothing else can be mid-placement when
   * a later order has already been placed.
   */
  inFlight?: string;
}

export interface Invariant {
  id: string;
  name: string;
  summary: string;
  check(state: EngineState, ctx: InvariantContext, scope: InvariantScope): Violation[];
}

/* ------------------------------------------------------------------ helpers */

interface Bag {
  violations: Violation[];
  add(invariant: string, subject: string, detail: string): void;
}

function bag(invariant: string): Bag {
  const violations: Violation[] = [];
  return {
    violations,
    add: (id, subject, detail) => violations.push({ invariant: id, subject, detail }),
  };
}

function eachLevel(
  state: EngineState,
  side: "BUY" | "SELL",
  visit: (level: PriceLevel, index: number) => void,
): void {
  const levels = side === "BUY" ? state.bids : state.asks;
  levels.forEach((level, index) => visit(level, index));
}

/** Visit the orders this check is responsible for. */
function eachOrder(
  state: EngineState,
  scope: InvariantScope,
  visit: (order: OrderState) => void,
): void {
  if (!scope.orders) {
    for (const order of Object.values(state.orders)) visit(order);
    return;
  }
  for (const id of scope.orders) {
    const order = state.orders[id];
    if (order) visit(order);
  }
}

/** Visit the prints this check is responsible for. */
function eachTrade(
  state: EngineState,
  scope: InvariantScope,
  visit: (trade: TradeRecord) => void,
): void {
  if (!scope.trades) {
    for (const trade of state.trades) visit(trade);
    return;
  }
  for (const id of scope.trades) {
    const index = state.trades.findIndex((trade) => trade.id === id);
    const trade = index >= 0 ? state.trades[index] : undefined;
    if (trade) visit(trade);
  }
}

/* --------------------------------------------------------------- invariants */

const NO_CROSSED_BOOK: Invariant = {
  id: "I1",
  name: "NO_CROSSED_BOOK",
  summary: "The best bid is always strictly below the best ask.",
  check(state) {
    const violations = bag(this.id);
    const bid = state.bids[0];
    const ask = state.asks[0];
    if (bid && ask && bid.price >= ask.price) {
      violations.add(this.id, `bid@${bid.price}/ask@${ask.price}`, "book is crossed");
    }
    return violations.violations;
  },
};

const CASH_CONSERVATION: Invariant = {
  id: "I2",
  name: "CASH_CONSERVATION",
  summary: "Sum of cash and reserved cash equals total deposits, exactly.",
  check(state) {
    const violations = bag(this.id);
    const actual = totalCash(state);
    if (actual !== state.ledger.depositedCash) {
      violations.add(
        this.id,
        "venue-wide",
        `cash ${actual} != deposited ${state.ledger.depositedCash} (delta ${
          actual - state.ledger.depositedCash
        })`,
      );
    }
    return violations.violations;
  },
};

const SHARE_CONSERVATION: Invariant = {
  id: "I3",
  name: "SHARE_CONSERVATION",
  summary: "Sum of settled and reserved shares equals total granted shares.",
  check(state) {
    const violations = bag(this.id);
    const actual = totalShares(state);
    if (actual !== state.ledger.grantedShares) {
      violations.add(
        this.id,
        "venue-wide",
        `shares ${actual} != granted ${state.ledger.grantedShares}`,
      );
    }
    for (const account of Object.values(state.accounts)) {
      if (account.positions < 0) {
        violations.add(this.id, account.owner, `negative settled position ${account.positions}`);
      }
    }
    return violations.violations;
  },
};

const NON_NEGATIVE_BALANCES: Invariant = {
  id: "I4",
  name: "NON_NEGATIVE_BALANCES",
  summary: "No account can ever hold negative cash, reservation or exposure.",
  check(state) {
    const violations = bag(this.id);
    for (const account of Object.values(state.accounts)) {
      if (account.cash < 0) violations.add(this.id, account.owner, `cash ${account.cash}`);
      if (account.reservedCash < 0) {
        violations.add(this.id, account.owner, `reservedCash ${account.reservedCash}`);
      }
      if (account.reservedShares < 0) {
        violations.add(this.id, account.owner, `reservedShares ${account.reservedShares}`);
      }
    }
    return violations.violations;
  },
};

const RESERVATION_MATCHES_ORDERS: Invariant = {
  id: "I5",
  name: "RESERVATION_MATCHES_ORDERS",
  summary:
    "Each account's reservation equals the exact requirement of its own resting orders — no leaks, no double-counting.",
  check(state, _ctx, scope) {
    const violations = bag(this.id);
    // Only placing, printing and cancelling move a reservation, so when the
    // event touched no order at all there is nothing new to assert.
    if (scope.orders && scope.orders.size === 0) return violations.violations;

    // Two flat accumulators keyed by owner, rather than a Map of objects built
    // per resting order. The requirement sums are read off the *book* under a
    // scope — a handful of entries — because the order map holds every order
    // ever placed (thousands), and walking all of it after every single event
    // was, by a factor of ten, the most expensive thing in this file.
    //
    // That is exact rather than approximate: an open order is either resting in
    // the book or is the one mid-placement, which the scope names explicitly
    // and which is added below. A full check (no scope) reads the order map
    // instead, so it does not lean on I7 for completeness.
    const wantCash: Record<string, number> = Object.create(null);
    const wantShares: Record<string, number> = Object.create(null);
    const add = (order: OrderState): void => {
      const owner = order.owner;
      if (order.side === "BUY") wantCash[owner] = (wantCash[owner] ?? 0) + order.price * order.remaining;
      else wantShares[owner] = (wantShares[owner] ?? 0) + order.remaining;
    };

    if (scope.orders) {
      const skip = scope.inFlight;
      for (const level of [...state.bids, ...state.asks]) {
        for (const orderId of level.orders) {
          if (orderId === skip) continue;
          const order = state.orders[orderId];
          // A dangling book entry is I7's business, not this check's.
          if (order) add(order);
        }
      }
      const inFlight = skip ? state.orders[skip] : undefined;
      if (inFlight && inFlight.status === "OPEN") add(inFlight);
    } else {
      for (const id in state.orders) {
        const order = state.orders[id] as OrderState;
        if (order.status === "OPEN") add(order);
      }
    }

    for (const owner in state.accounts) {
      const account = state.accounts[owner] as AccountState;
      const cash = wantCash[owner] ?? 0;
      const shares = wantShares[owner] ?? 0;
      if (account.reservedCash !== cash) {
        violations.add(
          this.id,
          account.owner,
          `reservedCash ${account.reservedCash} but open buy orders need ${cash}`,
        );
      }
      if (account.reservedShares !== shares) {
        violations.add(
          this.id,
          account.owner,
          `reservedShares ${account.reservedShares} but open sell orders need ${shares}`,
        );
      }
    }
    return violations.violations;
  },
};

const ORDER_ACCOUNTING: Invariant = {
  id: "I6",
  name: "ORDER_ACCOUNTING",
  summary: "Quantity always equals filled plus open; status agrees with the numbers.",
  check(state, _ctx, scope) {
    const violations = bag(this.id);
    eachOrder(state, scope, (order) => {
      if (order.qty !== order.filled + order.remaining) {
        violations.add(
          this.id,
          order.id,
          `qty ${order.qty} != filled ${order.filled} + open ${order.remaining}`,
        );
      }
      if (order.remaining < 0 || order.filled < 0) {
        violations.add(this.id, order.id, "negative quantity bookkeeping");
      }
      if (order.status === "OPEN" && order.remaining <= 0) {
        violations.add(this.id, order.id, "open order with nothing left");
      }
      if (order.status === "FILLED" && order.remaining !== 0) {
        violations.add(this.id, order.id, `filled order still shows ${order.remaining} open`);
      }
      if (order.status === "CANCELLED" && order.cancelReason === null) {
        violations.add(this.id, order.id, "cancelled order without a reason");
      }
    });
    return violations.violations;
  },
};

const BOOK_STRUCTURE: Invariant = {
  id: "I7",
  name: "BOOK_STRUCTURE",
  summary:
    "Levels are ordered, distinct and non-empty; FIFO queues reference live orders; cached depth equals the real depth.",
  check(state, _ctx, scope) {
    const violations = bag(this.id);
    const seen = new Set<string>();

    for (const side of ["BUY", "SELL"] as const) {
      let previous: number | null = null;
      eachLevel(state, side, (level) => {
        if (level.orders.length === 0) {
          violations.add(this.id, `${side}@${level.price}`, "empty level left in the book");
        }
        if (previous !== null) {
          const ordered = side === "BUY" ? level.price < previous : level.price > previous;
          if (!ordered) {
            violations.add(
              this.id,
              `${side}@${level.price}`,
              `levels out of order (previous ${previous})`,
            );
          }
        }
        previous = level.price;

        let depth = 0;
        for (const orderId of level.orders) {
          if (seen.has(orderId)) {
            violations.add(this.id, orderId, "listed more than once in the book");
          }
          seen.add(orderId);
          const order = state.orders[orderId];
          if (!order) {
            violations.add(this.id, orderId, "book references an unknown order");
            continue;
          }
          if (order.status !== "OPEN") {
            violations.add(this.id, orderId, `book holds a ${order.status} order`);
          }
          if (order.side !== side) {
            violations.add(this.id, orderId, `order on the wrong side (${order.side})`);
          }
          if (order.price !== level.price) {
            violations.add(this.id, orderId, `order priced ${order.price} at level ${level.price}`);
          }
          depth += order.remaining;
        }
        if (depth !== level.totalQty) {
          violations.add(
            this.id,
            `${side}@${level.price}`,
            `cached depth ${level.totalQty} but real depth is ${depth}`,
          );
        }
      });
    }

    // An accepted order is momentarily "in flight": it exists, it is OPEN and
    // it holds its reservation, but it only reaches the book once its placement
    // finishes matching. At most one order can be in that state at a time, and
    // it is always the newest one — any *other* open order that is missing from
    // the book is a genuine leak. (`test/engine.test.ts` asserts the stronger
    // claim at command boundaries, where completeness is exact.)
    //
    // Only a touched order can have entered or left the book, so under a scope
    // the scan covers those; unscoped it covers every order, which is the right
    // thing to do once, at a boundary, but far too much to do per event.
    const inFlight = scope.inFlight;
    let newestPlacedSeq = -1;
    if (inFlight === undefined) {
      for (const id in state.orders) {
        const placedSeq = (state.orders[id] as OrderState).placedSeq;
        if (placedSeq > newestPlacedSeq) newestPlacedSeq = placedSeq;
      }
    }
    eachOrder(state, scope, (order) => {
      if (order.status !== "OPEN" || seen.has(order.id)) return;
      if (inFlight !== undefined ? order.id === inFlight : order.placedSeq === newestPlacedSeq) return;
      violations.add(this.id, order.id, "open order missing from the book");
    });
    return violations.violations;
  },
};

const TRADE_INTEGRITY: Invariant = {
  id: "I8",
  name: "TRADE_INTEGRITY",
  summary:
    "Every print joins a buy order and a sell order that both exist, belong to the named accounts and had the quantity to fill.",
  check(state, _ctx, scope) {
    const violations = bag(this.id);
    eachTrade(state, scope, (trade) => {
      if (trade.qty <= 0 || trade.price <= 0) {
        violations.add(this.id, trade.id, "non-positive price or quantity");
      }
      if (trade.buyOrderId === trade.sellOrderId) {
        violations.add(this.id, trade.id, "both legs are the same order");
      }
      const buy = state.orders[trade.buyOrderId];
      const sell = state.orders[trade.sellOrderId];
      if (!buy || !sell) {
        violations.add(this.id, trade.id, "trade references an unknown order");
        return;
      }
      if (buy.side !== "BUY" || sell.side !== "SELL") {
        violations.add(this.id, trade.id, "legs are on the wrong sides");
      }
      if (buy.owner !== trade.buyer || sell.owner !== trade.seller) {
        violations.add(this.id, trade.id, "buyer/seller do not match order owners");
      }
      if (buy.filled < trade.qty || sell.filled < trade.qty) {
        violations.add(this.id, trade.id, "a leg filled less than this print");
      }
      if (trade.buyer === trade.seller) {
        violations.add(this.id, trade.id, "self-trade survived");
      }
    });
    return violations.violations;
  },
};

const IDENTITY_FROM_POSITION: Invariant = {
  id: "I9",
  name: "IDENTITY_FROM_POSITION",
  summary:
    "Order and trade ids must encode their own log position. A hand-edited log breaks this immediately.",
  check(state, _ctx, scope) {
    const violations = bag(this.id);
    eachOrder(state, scope, (order) => {
      const expected = makeOrderId(order.placedSeq);
      if (order.id !== expected) {
        violations.add(this.id, order.id, `expected id ${expected} for seq ${order.placedSeq}`);
      }
    });
    eachTrade(state, scope, (trade) => {
      const expected = makeTradeId(trade.seq);
      if (trade.id !== expected) {
        violations.add(this.id, trade.id, `expected id ${expected} for seq ${trade.seq}`);
      }
    });
    return violations.violations;
  },
};

const TICK_ALIGNMENT: Invariant = {
  id: "I10",
  name: "TICK_ALIGNMENT",
  summary: "Every price is a positive multiple of the tick and every quantity a multiple of the lot.",
  check(state, ctx, scope) {
    const violations = bag(this.id);
    const { tickSize, lotSize } = ctx.instrument;
    eachOrder(state, scope, (order) => {
      if (!Number.isInteger(order.price) || order.price <= 0 || order.price % tickSize !== 0) {
        violations.add(this.id, order.id, `price ${order.price} off tick grid`);
      }
      if (!Number.isInteger(order.qty) || order.qty % lotSize !== 0) {
        violations.add(this.id, order.id, `quantity ${order.qty} off lot grid`);
      }
    });
    eachTrade(state, scope, (trade) => {
      if (trade.price % tickSize !== 0 || trade.qty % lotSize !== 0) {
        violations.add(this.id, trade.id, "print off grid");
      }
    });
    return violations.violations;
  },
};

const SESSION_GATING: Invariant = {
  id: "I11",
  name: "SESSION_GATING",
  summary: "Orders may only rest while the session is open; DAY orders cannot outlive their day.",
  check(state) {
    const violations = bag(this.id);
    if (state.session === "CLOSED") {
      for (const order of Object.values(state.orders)) {
        if (order.status !== "OPEN" || order.tif !== "DAY") continue;
        const reason: CancelReason | null = order.cancelReason;
        violations.add(this.id, order.id, `DAY order survived a close (${String(reason)})`);
      }
    }
    return violations.violations;
  },
};

export const INVARIANTS: readonly Invariant[] = [
  NO_CROSSED_BOOK,
  CASH_CONSERVATION,
  SHARE_CONSERVATION,
  NON_NEGATIVE_BALANCES,
  RESERVATION_MATCHES_ORDERS,
  ORDER_ACCOUNTING,
  BOOK_STRUCTURE,
  TRADE_INTEGRITY,
  IDENTITY_FROM_POSITION,
  TICK_ALIGNMENT,
  SESSION_GATING,
];

export function invariantName(id: string): string {
  return INVARIANTS.find((invariant) => invariant.id === id)?.name ?? id;
}

export function invariantSummary(id: string): string {
  return INVARIANTS.find((invariant) => invariant.id === id)?.summary ?? "";
}

export function checkInvariants(
  state: EngineState,
  ctx: InvariantContext,
  scope: InvariantScope = {},
): Violation[] {
  const out: Violation[] = [];
  for (const invariant of INVARIANTS) out.push(...invariant.check(state, ctx, scope));
  return out;
}

/**
 * What an event could possibly have changed.
 *
 * `undefined` (a full scan) is never used here: every event arrives with an
 * explicit, possibly empty, set of subjects.
 */
export function scopeForEvent(event: EventCore, inFlight?: string): InvariantScope {
  // Every branch spells out both sets. Omitting one is not "no trades": it is
  // "scan all of history", which is the opposite of what is meant here.
  const noTrades = new Set<string>();
  switch (event.kind) {
    case "ORDER_PLACED":
    case "ORDER_RESTED":
    case "ORDER_CANCELLED": {
      const data = event.data as { orderId?: string };
      return { orders: new Set(data.orderId ? [data.orderId] : []), trades: noTrades, inFlight };
    }
    case "TRADE": {
      const data = event.data as { tradeId?: string; buyOrderId?: string; sellOrderId?: string };
      return {
        orders: new Set(
          [data.buyOrderId, data.sellOrderId].filter((id): id is string => typeof id === "string"),
        ),
        trades: new Set(data.tradeId ? [data.tradeId] : []),
        inFlight,
      };
    }
    default:
      return { orders: new Set(), trades: noTrades, inFlight };
  }
}

/* -------------------------------------------------------------- monitoring */

export interface InvariantReport {
  ok: boolean;
  eventsChecked: number;
  violations: Array<Violation & { atSeq: number; context: EventCore["kind"] }>;
  /** Per-invariant verdict, for the UI checklist. */
  verdicts: Array<{ id: string; name: string; summary: string; firstViolationSeq: number | null }>;
}

/**
 * Fold a log through the checker, recording the *first* seq at which each
 * invariant broke. After the first break the state may be nonsense, so later
 * violations of the same invariant are ignored — this keeps the report
 * actionable: one root cause, not a cascade. A broken invariant is also not
 * re-checked at all, which is what stops a single early error from making the
 * whole run quadratic.
 *
 * Each event is checked against the delta it produced (`scopeForEvent`), which is
 * an exact answer rather than a sampled one: the monitor has already established
 * that every earlier event was clean, so the only thing left to verify is what
 * this event touched. On a 5,374 event session that is the difference between
 * ~19s and ~0.2s.
 */
export function monitorInvariants(
  initialState: EngineState,
  events: readonly EventCore[],
  ctx: InvariantContext,
  apply: (state: EngineState, event: EventCore) => EngineState,
): InvariantReport {
  if (initialState.seq !== 0) {
    throw new Error("monitorInvariants: pass a fresh state (seq 0); it is consumed by the fold");
  }
  const state = initialState;
  const firstSeen = new Map<string, number>();
  const violations: InvariantReport["violations"] = [];

  // Check the pristine state before any event: a broken starting point is worth
  // knowing about separately.
  for (const violation of checkInvariants(state, ctx)) {
    firstSeen.set(violation.invariant, 0);
    violations.push({ ...violation, atSeq: 0, context: "SESSION_OPENED" });
  }

  let checked = 0;
  let inFlight: string | undefined;
  for (const event of events) {
    // Track the most recent placement: it, and only it, may still be in flight.
    if (event.kind === "ORDER_PLACED") {
      inFlight = (event.data as { orderId?: string }).orderId;
    }
    apply(state, event);
    checked += 1;
    const scope = scopeForEvent(event, inFlight);
    for (const invariant of INVARIANTS) {
      if (firstSeen.has(invariant.id)) continue;
      for (const violation of invariant.check(state, ctx, scope)) {
        if (firstSeen.has(violation.invariant)) continue;
        firstSeen.set(violation.invariant, event.seq);
        violations.push({ ...violation, atSeq: event.seq, context: event.kind });
      }
    }
  }

  return {
    ok: violations.length === 0,
    eventsChecked: checked,
    violations,
    verdicts: INVARIANTS.map((invariant) => ({
      id: invariant.id,
      name: invariant.name,
      summary: invariant.summary,
      firstViolationSeq: firstSeen.get(invariant.id) ?? null,
    })),
  };
}

/* ------------------------------------------------- tiny helpers for tests */

export function allReservationsClear(account: AccountState): boolean {
  return account.reservedCash === 0 && account.reservedShares === 0;
}

export function openOrderCount(state: EngineState): number {
  return Object.values(state.orders).filter((order: OrderState) => order.status === "OPEN")
    .length;
}
