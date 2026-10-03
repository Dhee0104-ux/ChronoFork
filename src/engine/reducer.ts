/**
 * The reducer: `(state, event) -> state`.
 *
 * This is the only place where history becomes state. It is deterministic by
 * construction — it reads nothing but its two arguments — and it is *total and
 * defensive*: an event that contradicts the current state throws instead of
 * quietly producing garbage. That strictness is what makes `verify` meaningful:
 * a log can be rejected not just for a broken hash chain but for describing
 * history that could not have happened.
 *
 * For speed the state object is mutated in place (the engine owns the instance)
 * and returned. Callers that need an immutable copy take one explicitly with
 * `cloneState`, which is what snapshots and forks do.
 */

import {
  insertResting,
  levelsForSide,
  reduceLevelQty,
  removeResting,
  unlinkResting,
} from "./book.ts";
import { accountOrCreate, requireOrder, StateError } from "./state.ts";
import type {
  AccountState,
  CancelReason,
  EngineState,
  EventCore,
  OrderPlacedData,
  OrderState,
  TradeData,
  TradeRecord,
} from "./types.ts";

export class ReducerError extends Error {
  readonly seq: number;
  readonly kind: string;

  constructor(message: string, seq: number, kind: string) {
    super(`event #${seq} (${kind}): ${message}`);
    this.name = "ReducerError";
    this.seq = seq;
    this.kind = kind;
  }
}

function fail(event: EventCore, message: string): never {
  throw new ReducerError(message, event.seq, event.kind);
}

export function applyEvent(state: EngineState, event: EventCore): EngineState {
  if (event.seq !== state.seq) {
    fail(event, `expected seq ${state.seq}`);
  }
  if (event.vt < state.vt) {
    fail(event, `virtual time went backwards (${event.vt} < ${state.vt})`);
  }
  state.seq = event.seq + 1;

  switch (event.kind) {
    case "SESSION_OPENED": {
      const data = event.data as { symbol: string; sessionIndex: number };
      state.session = "OPEN";
      state.symbol = data.symbol;
      if (data.sessionIndex > state.sessionIndex + 1) {
        fail(event, `session index jumped to ${data.sessionIndex}`);
      }
      state.sessionIndex = data.sessionIndex;
      break;
    }

    case "DEPOSIT": {
      const data = event.data as { owner: string; amount: number };
      if (!Number.isInteger(data.amount) || data.amount <= 0) {
        fail(event, "deposit must be a positive integer");
      }
      accountOrCreate(state, data.owner).cash += data.amount;
      state.ledger.depositedCash += data.amount;
      break;
    }

    case "GRANT": {
      const data = event.data as { owner: string; shares: number };
      if (!Number.isInteger(data.shares) || data.shares <= 0) {
        fail(event, "grant must be a positive integer");
      }
      accountOrCreate(state, data.owner).positions += data.shares;
      state.ledger.grantedShares += data.shares;
      break;
    }

    case "ORDER_PLACED": {
      const data = event.data as OrderPlacedData;
      if (state.orders[data.orderId]) fail(event, `duplicate order id ${data.orderId}`);
      const account = accountOrCreate(state, data.owner);
      const notional = data.price * data.qty;

      // The reservation is part of the fact: applying ORDER_PLACED is what
      // earmarks the money or the shares. A rejected order simply never gets a
      // PLACED event, so no rollback path is needed anywhere.
      if (data.side === "BUY") {
        account.cash -= notional;
        account.reservedCash += notional;
      } else {
        account.positions -= data.qty;
        account.reservedShares += data.qty;
      }

      const order: OrderState = {
        id: data.orderId,
        owner: data.owner,
        side: data.side,
        price: data.price,
        qty: data.qty,
        remaining: data.qty,
        tif: data.tif,
        status: "OPEN",
        placedSeq: event.seq,
        placedVt: event.vt,
        expiresAt: data.expiresAt,
        clientRef: data.clientRef,
        cancelReason: null,
        filled: 0,
      };
      state.orders[data.orderId] = order;
      break;
    }

    case "ORDER_RESTED": {
      const data = event.data as { orderId: string; price: number; qty: number };
      const order = requireOrder(state, data.orderId);
      if (order.status !== "OPEN") fail(event, "resting a non-open order");
      if (order.remaining !== data.qty) fail(event, "rest quantity mismatch");
      insertResting(levelsForSide(state, order.side), order.side, order.id, order.price, data.qty);
      break;
    }

    case "TRADE": {
      const data = event.data as TradeData;
      applyTrade(state, event, data);
      break;
    }

    case "ORDER_CANCELLED": {
      const data = event.data as {
        orderId: string;
        owner: string;
        reason: CancelReason;
        releasedQty: number;
        releasedCash: number;
        releasedShares: number;
      };
      const order = requireOrder(state, data.orderId);
      if (order.status !== "OPEN") fail(event, `cancel of ${order.status} order`);
      if (order.remaining !== data.releasedQty) {
        fail(event, `released ${data.releasedQty} but order has ${order.remaining} open`);
      }
      const account = accountOrCreate(state, order.owner);

      if (order.side === "BUY") {
        account.reservedCash -= data.releasedCash;
        account.cash += data.releasedCash;
      } else {
        account.reservedShares -= data.releasedShares;
        account.positions += data.releasedShares;
      }

      // An IOC remainder was never in the book, so this is a no-op for it; a
      // resting order is always found and its quantity released here.
      removeResting(levelsForSide(state, order.side), order.price, order.id, order.remaining);

      order.status = "CANCELLED";
      order.cancelReason = data.reason;
      state.stats.cancelledOrders += 1;
      break;
    }

    case "ORDER_REJECTED": {
      state.stats.rejectedOrders += 1;
      break;
    }

    case "CANCEL_REJECTED": {
      break;
    }

    case "SESSION_CLOSED": {
      state.session = "CLOSED";
      break;
    }

    case "NOOP": {
      // A counterfactual marker: the position exists, nothing happened at it.
      // Advancing `vt` is intentional — the clock still moved past this instant.
      break;
    }

    default: {
      const unknown = event.kind as string;
      throw new ReducerError(`unknown event kind '${unknown}'`, event.seq, unknown);
    }
  }

  state.vt = event.vt;
  return state;
}

function applyTrade(state: EngineState, event: EventCore, data: TradeData): void {
  if (data.qty <= 0) fail(event, "non-positive trade quantity");
  if (data.price <= 0) fail(event, "non-positive trade price");
  if (data.buyOrderId === data.sellOrderId) fail(event, "self-trade reached the reducer");

  const buy = requireOrder(state, data.buyOrderId);
  const sell = requireOrder(state, data.sellOrderId);
  const buyer = accountOrCreate(state, data.buyer);
  const seller = accountOrCreate(state, data.seller);

  if (buy.side !== "BUY" || sell.side !== "SELL") fail(event, "trade legs on the wrong sides");
  if (buy.owner !== data.buyer) fail(event, "buyer does not own the buy order");
  if (sell.owner !== data.seller) fail(event, "seller does not own the sell order");
  if (data.qty > buy.remaining || data.qty > sell.remaining) {
    fail(event, "trade larger than an order's remaining quantity");
  }

  // Buyer: release the earmark for the filled portion, pay the trade price, and
  // take delivery. Marketable buys get price improvement back (limit - print).
  releaseBuyFill(buyer, buy, data.price, data.qty);
  buyer.positions += data.qty;
  buy.filled += data.qty;
  buy.remaining = data.buyRemaining;

  // Seller: deliver the shares out of the reservation, collect the cash.
  seller.reservedShares -= data.qty;
  seller.cash += data.price * data.qty;
  sell.filled += data.qty;
  sell.remaining = data.sellRemaining;

  if (buy.remaining === 0) buy.status = "FILLED";
  if (sell.remaining === 0) sell.status = "FILLED";

  // The counterparty of the aggressor is the one that was resting, so it is the
  // one that owns a slot in the book.
  const restingId = data.aggressorOrderId === data.buyOrderId ? data.sellOrderId : data.buyOrderId;
  const resting = restingId === data.buyOrderId ? buy : sell;
  const restingLevels = levelsForSide(state, resting.side);

  // Every print shrinks the level it consumed, whether or not it emptied the
  // order sitting at the head of it. Then, and only then, a fully filled order
  // is unlinked from the FIFO queue (which may delete the level entirely).
  reduceLevelQty(restingLevels, resting.price, data.qty);
  if (resting.remaining === 0) {
    unlinkResting(restingLevels, resting.price, resting.id);
  }

  const record: TradeRecord = {
    id: data.tradeId,
    seq: event.seq,
    vt: event.vt,
    price: data.price,
    qty: data.qty,
    buyer: data.buyer,
    seller: data.seller,
    aggressorSide: data.aggressorOrderId === data.buyOrderId ? "BUY" : "SELL",
    buyOrderId: data.buyOrderId,
    sellOrderId: data.sellOrderId,
  };
  state.trades.push(record);

  const stats = state.stats;
  stats.tradeCount += 1;
  stats.volume += data.qty;
  stats.vwapNumerator += data.price * data.qty;
  stats.vwapDenominator += data.qty;
  stats.lastPrice = data.price;
  stats.openPrice ??= data.price;
  stats.high = stats.high === null ? data.price : Math.max(stats.high, data.price);
  stats.low = stats.low === null ? data.price : Math.min(stats.low, data.price);
}

function releaseBuyFill(
  buyer: AccountState,
  buy: OrderState,
  tradePrice: number,
  qty: number,
): void {
  const earmarked = buy.price * qty;
  buyer.reservedCash -= earmarked;
  buyer.cash += earmarked - tradePrice * qty;
}

/** Replay a list of events from a starting state. Used by tests and the CLI. */
export function reduceAll(state: EngineState, events: readonly EventCore[]): EngineState {
  let out = state;
  for (const event of events) out = applyEvent(out, event);
  return out;
}

export function requireOpen(state: EngineState): void {
  if (state.session !== "OPEN") throw new StateError("session is closed");
}
