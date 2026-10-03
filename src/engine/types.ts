/**
 * Domain vocabulary for the Chronofork exchange.
 *
 * Two rules hold everywhere below and are what make counterfactual replay
 * possible at all:
 *
 *   1. NO FLOATING POINT. Prices are integer cents, quantities are integer
 *      shares, cash is integer cents. Two runs on two machines cannot disagree.
 *   2. NO AMBIENT INPUT. Nothing in a transition function reads the wall clock,
 *      the RNG, the filesystem or the network. Time arrives as data (`vt`).
 */

export type Side = "BUY" | "SELL";

/**
 * Only limit orders exist. A "market order" is modelled as a marketable IOC
 * limit order with a protective cap, which is what most real venues do
 * internally — and it keeps the money math bounded (an unbounded price would
 * make the cash reservation meaningless).
 */
export type TimeInForce = "IOC" | "GTC" | "DAY";

export type OrderStatus = "OPEN" | "FILLED" | "CANCELLED";

export type CancelReason =
  | "USER"
  | "IOC_REMAINDER"
  | "TTL_EXPIRED"
  | "DAY_EXPIRED"
  | "SESSION_CLOSE"
  | "SELF_TRADE_PREVENTION";

export type RejectReason =
  | "SESSION_CLOSED"
  | "INVALID_QUANTITY"
  | "INVALID_PRICE"
  | "INSUFFICIENT_CASH"
  | "INSUFFICIENT_SHARES"
  | "UNKNOWN_ORDER"
  | "NOT_ORDER_OWNER"
  | "ORDER_NOT_OPEN";

/* ------------------------------------------------------------------ events */

/**
 * The core of an event: everything the reducer is allowed to see. `seq` and
 * `vt` are part of the payload on purpose — the log position and the virtual
 * clock are facts of history, not metadata.
 */
export interface EventCore {
  /** 0-based position in the *logical* stream this event was applied at. */
  seq: number;
  /** Virtual time in milliseconds. Non-decreasing along the log. */
  vt: number;
  kind: EventKind;
  data: EventData;
}

export type EventKind =
  | "SESSION_OPENED"
  | "DEPOSIT"
  | "GRANT"
  | "ORDER_PLACED"
  | "ORDER_RESTED"
  | "TRADE"
  | "ORDER_CANCELLED"
  | "ORDER_REJECTED"
  | "CANCEL_REJECTED"
  | "SESSION_CLOSED"
  | "NOOP";

/**
 * A deliberate no-op that still occupies a log position.
 *
 * This is how "what if this event had never happened?" is expressed without
 * renumbering history. Log positions are immutable here — an order id encodes
 * the position it was created at (see `ids.ts` and invariant I9), so deleting an
 * event would silently renumber everything after it. Instead a counterfactual
 * *replaces* a position with a NOOP, and the position keeps its slot.
 */
export interface NoopData {
  note: string;
  /** The kind of event that was suppressed here, for traceability. */
  replacedKind: EventKind | null;
}

export interface SessionOpenedData {
  symbol: string;
  sessionIndex: number;
}

export interface DepositData {
  owner: string;
  amount: number;
  note: string;
}

export interface GrantData {
  owner: string;
  shares: number;
  note: string;
}

export interface OrderPlacedData {
  orderId: string;
  owner: string;
  side: Side;
  price: number;
  qty: number;
  tif: TimeInForce;
  /** Virtual ms after which an unfilled remainder is auto-cancelled, or null. */
  ttlMs: number | null;
  expiresAt: number | null;
  /** Caller-supplied label, echoed for traceability. Never used as identity. */
  clientRef: string | null;
}

export interface OrderRestedData {
  orderId: string;
  price: number;
  qty: number;
}

export interface TradeData {
  tradeId: string;
  price: number;
  qty: number;
  aggressorOrderId: string;
  buyOrderId: string;
  sellOrderId: string;
  buyer: string;
  seller: string;
  /** Remaining quantity on each order AFTER this fill. */
  buyRemaining: number;
  sellRemaining: number;
}

export interface OrderCancelledData {
  orderId: string;
  owner: string;
  reason: CancelReason;
  /** Quantity that was still open and is now released. */
  releasedQty: number;
  /** Cash moved out of the reservation back to spendable cash. */
  releasedCash: number;
  /** Shares moved out of the reservation back to the position. */
  releasedShares: number;
}

export interface OrderRejectedData {
  owner: string;
  side: Side;
  price: number;
  qty: number;
  reason: RejectReason;
  detail: string;
  clientRef: string | null;
}

export interface CancelRejectedData {
  owner: string;
  orderId: string;
  reason: RejectReason;
  detail: string;
}

export interface SessionClosedData {
  reason: string;
  dayExpired: number;
  gtcCarried: number;
}

export type EventData =
  | SessionOpenedData
  | DepositData
  | GrantData
  | OrderPlacedData
  | OrderRestedData
  | TradeData
  | OrderCancelledData
  | OrderRejectedData
  | CancelRejectedData
  | SessionClosedData
  | NoopData;

/* ---------------------------------------------------------------- commands */

/**
 * Commands are NOT persisted — only the events they produce are. Replay never
 * needs the command stream, which is what lets a fork inject a different
 * command at a past point and diverge cleanly.
 */
export type Command =
  | { kind: "OPEN_SESSION"; symbol: string; sessionIndex: number }
  | { kind: "DEPOSIT"; owner: string; amount: number; note?: string }
  | { kind: "GRANT_SHARES"; owner: string; shares: number; note?: string }
  | {
      kind: "PLACE_ORDER";
      owner: string;
      side: Side;
      price: number;
      qty: number;
      tif: TimeInForce;
      ttlMs?: number | null;
      clientRef?: string | null;
    }
  | { kind: "CANCEL_ORDER"; owner: string; orderId: string; clientRef?: string | null }
  | { kind: "CLOSE_SESSION"; reason?: string };

/* ------------------------------------------------------------------- state */

export interface AccountState {
  owner: string;
  /** Spendable cash. */
  cash: number;
  /** Cash earmarked against resting BUY orders, still owned by the account. */
  reservedCash: number;
  /** Settled share position. */
  positions: number;
  /** Shares earmarked against resting SELL orders, still owned. */
  reservedShares: number;
}

export interface OrderState {
  id: string;
  owner: string;
  side: Side;
  price: number;
  /** Original quantity. */
  qty: number;
  remaining: number;
  tif: TimeInForce;
  status: OrderStatus;
  placedSeq: number;
  placedVt: number;
  expiresAt: number | null;
  clientRef: string | null;
  cancelReason: CancelReason | null;
  /** Cumulative filled quantity, useful for the UI tape. */
  filled: number;
}

export interface PriceLevel {
  price: number;
  /** Order ids in strict FIFO arrival order. */
  orders: string[];
  /** Cached sum of remaining quantities; maintained by book.ts. */
  totalQty: number;
}

export interface TradeRecord {
  id: string;
  seq: number;
  vt: number;
  price: number;
  qty: number;
  buyer: string;
  seller: string;
  aggressorSide: Side;
  buyOrderId: string;
  sellOrderId: string;
}

export interface MarketStats {
  lastPrice: number | null;
  openPrice: number | null;
  high: number | null;
  low: number | null;
  /** VWAP as an exact ratio: numerator is cents*shares, denominator shares. */
  vwapNumerator: number;
  vwapDenominator: number;
  tradeCount: number;
  volume: number;
  rejectedOrders: number;
  cancelledOrders: number;
}

/**
 * Cumulative totals of everything ever injected into the venue.
 *
 * These two numbers are what make the conservation invariants exact: cash and
 * shares may move between accounts, but the sums across the venue must equal
 * what was deposited or granted, always. Nothing in the exchange can create or
 * destroy either, and `invariants.ts` checks it at every single event.
 */
export interface Ledger {
  depositedCash: number;
  grantedShares: number;
}

export interface EngineState {
  /** Events applied so far. Also the sequence number of the next event. */
  seq: number;
  vt: number;
  session: "OPEN" | "CLOSED";
  sessionIndex: number;
  symbol: string;
  accounts: Record<string, AccountState>;
  orders: Record<string, OrderState>;
  bids: PriceLevel[];
  asks: PriceLevel[];
  trades: TradeRecord[];
  stats: MarketStats;
  ledger: Ledger;
}

/* ------------------------------------------------------------------ config */

export interface InstrumentConfig {
  symbol: string;
  /** Price granularity in cents. All prices must be multiples of this. */
  tickSize: number;
  /** Minimum tradable quantity. All quantities must be multiples of this. */
  lotSize: number;
  /** Self-trade prevention mode. CANCEL_RESTING mirrors most equity venues. */
  stp: "CANCEL_RESTING" | "ALLOW";
  /** Where the ticker starts on a fresh book. */
  referencePrice: number;
}

export interface ParticipantConfig {
  owner: string;
  initialCash: number;
  initialShares: number;
  role: string;
}

export interface SessionConfig {
  id: string;
  label: string;
  instrument: InstrumentConfig;
  participants: ParticipantConfig[];
  /** Session start in virtual milliseconds. */
  startVt: number;
  description: string;
}
