/**
 * Command semantics: `(state, command) -> events`.
 *
 * Notice what is *not* here: a second copy of the state transition logic. Every
 * event this module decides to emit is immediately folded back through
 * `applyEvent`, so the reducer stays the single source of truth for how state
 * changes. This driver only decides *what happens next* — never *how state
 * moves*, which is why replay and live submission can never drift apart.
 *
 * Two kinds of failure, kept deliberately distinct:
 *   - malformed input (negative quantity, unknown account)  -> CommandError
 *   - a legitimate order the venue refuses (no cash, closed) -> ORDER_REJECTED
 * Both are deterministic; neither depends on anything outside the arguments.
 */

import { oppositeLevels } from "./book.ts";
import { makeOrderId, makeTradeId } from "./ids.ts";
import { applyEvent } from "./reducer.ts";
import { accountOrCreate, availableShares, requireOrder } from "./state.ts";
import type {
  CancelReason,
  Command,
  EngineState,
  EventCore,
  InstrumentConfig,
  OrderState,
  RejectReason,
  Side,
  TimeInForce,
} from "./types.ts";

export class CommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export interface ProcessOptions {
  /** Virtual time to stamp on emitted events. Clamped up to `state.vt`. */
  vt?: number;
  instrument: InstrumentConfig;
}

export interface ProcessResult {
  events: EventCore[];
}

/**
 * Fold a command into the state, returning the events it produced. The state is
 * advanced as a side effect: the caller must treat `state` as consumed.
 */
export function processCommand(
  state: EngineState,
  command: Command,
  options: ProcessOptions,
): EventCore[] {
  const events: EventCore[] = [];
  const vt = Math.max(options.vt ?? state.vt, state.vt);
  const emit = (kind: EventCore["kind"], data: EventCore["data"]): EventCore => {
    const event: EventCore = { seq: state.seq, vt, kind, data };
    applyEvent(state, event);
    events.push(event);
    return event;
  };

  switch (command.kind) {
    case "OPEN_SESSION": {
      // Idempotent: reopening an open session is a no-op rather than an error,
      // so replaying a scenario that already contains the opening is harmless.
      if (state.session === "OPEN") return events;
      emit("SESSION_OPENED", {
        symbol: command.symbol,
        sessionIndex: state.sessionIndex + 1,
      });
      return events;
    }

    case "DEPOSIT": {
      if (!Number.isInteger(command.amount) || command.amount <= 0) {
        throw new CommandError("INVALID_AMOUNT", "deposit amount must be a positive integer");
      }
      emit("DEPOSIT", {
        owner: command.owner,
        amount: command.amount,
        note: command.note ?? "deposit",
      });
      return events;
    }

    case "GRANT_SHARES": {
      if (!Number.isInteger(command.shares) || command.shares <= 0) {
        throw new CommandError("INVALID_AMOUNT", "grant must be a positive integer");
      }
      emit("GRANT", {
        owner: command.owner,
        shares: command.shares,
        note: command.note ?? "initial allocation",
      });
      return events;
    }

    case "PLACE_ORDER": {
      placeOrder(state, command, options, emit, vt);
      return events;
    }

    case "CANCEL_ORDER": {
      cancelOrder(state, command, emit);
      return events;
    }

    case "CLOSE_SESSION": {
      closeSession(state, command.reason ?? "manual close", emit);
      return events;
    }

    default: {
      const unknown = command as { kind?: string };
      throw new CommandError("UNKNOWN_COMMAND", `unknown command '${String(unknown.kind)}'`);
    }
  }
}

/* --------------------------------------------------------------- placement */

interface OrderIntent {
  owner: string;
  side: Side;
  price: number;
  qty: number;
  reason: RejectReason;
  detail: string;
  clientRef: string | null;
}

type Emit = (kind: EventCore["kind"], data: EventCore["data"]) => EventCore;

function rejectOrder(emit: Emit, intent: OrderIntent): void {
  emit("ORDER_REJECTED", intent);
}

function placeOrder(
  state: EngineState,
  cmd: Extract<Command, { kind: "PLACE_ORDER" }>,
  options: ProcessOptions,
  emit: Emit,
  /** The resolved timestamp every event of this command will carry. */
  vt: number,
): void {
  const { instrument } = options;
  const clientRef = cmd.clientRef ?? null;
  const intent = (reason: RejectReason, detail: string): OrderIntent => ({
    owner: cmd.owner,
    side: cmd.side,
    price: cmd.price,
    qty: cmd.qty,
    reason,
    detail,
    clientRef,
  });

  if (state.session !== "OPEN") {
    rejectOrder(
      emit,
      intent("SESSION_CLOSED", `session ${state.sessionIndex} is not accepting orders`),
    );
    return;
  }
  if (!Number.isInteger(cmd.qty) || cmd.qty <= 0 || cmd.qty % instrument.lotSize !== 0) {
    rejectOrder(
      emit,
      intent("INVALID_QUANTITY", `quantity must be a positive multiple of ${instrument.lotSize}`),
    );
    return;
  }
  if (
    !Number.isInteger(cmd.price) ||
    cmd.price <= 0 ||
    cmd.price % instrument.tickSize !== 0
  ) {
    rejectOrder(
      emit,
      intent("INVALID_PRICE", `price must be a positive multiple of ${instrument.tickSize} cent(s)`),
    );
    return;
  }

  const account = accountOrCreate(state, cmd.owner);
  if (cmd.side === "BUY") {
    const required = cmd.price * cmd.qty;
    if (account.cash < required) {
      rejectOrder(
        emit,
        intent("INSUFFICIENT_CASH", `needs ${required} cents, ${account.cash} spendable`),
      );
      return;
    }
  } else if (availableShares(state, cmd.owner) < cmd.qty) {
    const available = availableShares(state, cmd.owner);
    rejectOrder(
      emit,
      intent("INSUFFICIENT_SHARES", `needs ${cmd.qty} shares, ${available} available`),
    );
    return;
  }

  const tif: TimeInForce = cmd.tif;
  const ttlMs = cmd.ttlMs ?? null;
  if (ttlMs !== null && (!Number.isInteger(ttlMs) || ttlMs <= 0)) {
    throw new CommandError("INVALID_TTL", "ttlMs must be a positive integer or null");
  }
  if (tif === "IOC" && ttlMs !== null) {
    throw new CommandError("INVALID_TTL", "IOC orders cannot carry a TTL");
  }

  const orderId = makeOrderId(state.seq);
  emit("ORDER_PLACED", {
    orderId,
    owner: cmd.owner,
    side: cmd.side,
    price: cmd.price,
    qty: cmd.qty,
    tif,
    ttlMs,
    // Measured from the timestamp this very event carries, not from the last
    // event in the log: a command submitted at vt 1000 with a 5s TTL expires at
    // 6000 regardless of how quiet the venue was beforehand.
    expiresAt: ttlMs === null ? null : vt + ttlMs,
    clientRef,
  });

  matchIncoming(state, orderId, options, emit);

  const order = requireOrder(state, orderId);
  if (order.remaining === 0) return;

  if (tif === "IOC") {
    emit("ORDER_CANCELLED", cancelPayload(order, "IOC_REMAINDER"));
    return;
  }
  emit("ORDER_RESTED", { orderId, price: order.price, qty: order.remaining });
}

/**
 * Continuous price-time matching against the opposite side of the book.
 *
 * Every trade prints at the *resting* order's price, so the aggressor can only
 * ever get price improvement, never slippage beyond its own limit. Arrival
 * order inside a level is preserved because levels are FIFO queues.
 */
function matchIncoming(
  state: EngineState,
  aggressorId: string,
  options: ProcessOptions,
  emit: Emit,
): void {
  for (;;) {
    const aggressor = requireOrder(state, aggressorId);
    if (aggressor.remaining === 0) return;

    const levels = oppositeLevels(state, aggressor.side);
    const level = levels[0];
    if (!level) return;
    if (!crosses(aggressor.side, aggressor.price, level.price)) return;

    const restingId = level.orders[0];
    if (restingId === undefined) return;
    const resting = requireOrder(state, restingId);

    if (resting.owner === aggressor.owner && options.instrument.stp === "CANCEL_RESTING") {
      // Self-trade prevention: the older order is withdrawn, the aggressor
      // keeps hunting for liquidity. This is the mode most equity venues use
      // and it keeps ownership transfers economically meaningful.
      emit("ORDER_CANCELLED", cancelPayload(resting, "SELF_TRADE_PREVENTION"));
      continue;
    }

    const qty = Math.min(aggressor.remaining, resting.remaining);
    const buyOrder = aggressor.side === "BUY" ? aggressor : resting;
    const sellOrder = aggressor.side === "BUY" ? resting : aggressor;

    emit("TRADE", {
      tradeId: makeTradeId(state.seq),
      price: resting.price,
      qty,
      aggressorOrderId: aggressor.id,
      buyOrderId: buyOrder.id,
      sellOrderId: sellOrder.id,
      buyer: buyOrder.owner,
      seller: sellOrder.owner,
      buyRemaining: buyOrder.remaining - qty,
      sellRemaining: sellOrder.remaining - qty,
    });
  }
}

function crosses(side: Side, limitPrice: number, restingPrice: number): boolean {
  return side === "BUY" ? restingPrice <= limitPrice : restingPrice >= limitPrice;
}

/* ------------------------------------------------------------ cancellation */

function cancelOrder(
  state: EngineState,
  cmd: Extract<Command, { kind: "CANCEL_ORDER" }>,
  emit: Emit,
): void {
  const rejectCancel = (reason: RejectReason, detail: string): void => {
    emit("CANCEL_REJECTED", { owner: cmd.owner, orderId: cmd.orderId, reason, detail });
  };

  const order = state.orders[cmd.orderId];
  if (!order) {
    rejectCancel("UNKNOWN_ORDER", `no order ${cmd.orderId}`);
    return;
  }
  if (order.owner !== cmd.owner) {
    rejectCancel("NOT_ORDER_OWNER", `order belongs to ${order.owner}`);
    return;
  }
  if (order.status !== "OPEN") {
    rejectCancel("ORDER_NOT_OPEN", `order is ${order.status}`);
    return;
  }
  emit("ORDER_CANCELLED", cancelPayload(order, "USER"));
}

/** Release payload for an order: the reservation must be given back exactly. */
function cancelPayload(order: OrderState, reason: CancelReason): EventCore["data"] {
  return {
    orderId: order.id,
    owner: order.owner,
    reason,
    releasedQty: order.remaining,
    releasedCash: order.side === "BUY" ? order.price * order.remaining : 0,
    releasedShares: order.side === "SELL" ? order.remaining : 0,
  };
}

/* ------------------------------------------------------------- session end */

function closeSession(state: EngineState, reason: string, emit: Emit): void {
  if (state.session !== "OPEN") return;
  let dayExpired = 0;
  let gtcCarried = 0;

  // Deterministic sweep order: oldest order first, so the same log always
  // produces the same sequence of cancellations.
  const open = Object.values(state.orders)
    .filter((order) => order.status === "OPEN")
    .sort((a, b) => a.placedSeq - b.placedSeq || (a.id < b.id ? -1 : 1));

  for (const order of open) {
    if (order.tif === "DAY") {
      emit("ORDER_CANCELLED", cancelPayload(order, "DAY_EXPIRED"));
      dayExpired += 1;
    } else if (order.tif === "GTC") {
      gtcCarried += 1;
    }
  }

  emit("SESSION_CLOSED", { reason, dayExpired, gtcCarried });
}

/* -------------------------------------------------------------- timers (TTL) */

/**
 * Fire every TTL that has come due at or before `uptoVt`.
 *
 * Earliest-deadline-first, tie-broken by order id, so the timer queue is a
 * *function of the state* rather than a separate mutable structure that could
 * drift from it. Replaying the log through this function reproduces the same
 * expirations, which is the property the "virtual clock" tests pin down.
 */
export function fireDueTimers(
  state: EngineState,
  uptoVt: number,
  emit: Emit,
): void {
  const due: OrderState[] = [];
  for (const order of Object.values(state.orders)) {
    if (order.status !== "OPEN") continue;
    if (order.expiresAt === null) continue;
    if (order.expiresAt > uptoVt) continue;
    due.push(order);
  }
  due.sort((a, b) => (a.expiresAt as number) - (b.expiresAt as number) || (a.id < b.id ? -1 : 1));

  for (const order of due) {
    const live = state.orders[order.id];
    if (!live || live.status !== "OPEN") continue;
    emit("ORDER_CANCELLED", cancelPayload(live, "TTL_EXPIRED"));
  }
}

/** Earliest pending TTL, or null when nothing is scheduled. */
export function nextTimerAt(state: EngineState): number | null {
  let next: number | null = null;
  for (const order of Object.values(state.orders)) {
    if (order.status !== "OPEN" || order.expiresAt === null) continue;
    if (next === null || order.expiresAt < next) next = order.expiresAt;
  }
  return next;
}
