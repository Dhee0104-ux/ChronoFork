/**
 * The simulator: a deterministic market participant driver.
 *
 * This is the *only* place in the project allowed to be creative. It owns the
 * seed, the randomness and the wall clock — and it converts all three into
 * ordinary commands, which the engine turns into ordinary events. Once a
 * session has been generated, replaying it needs none of this file.
 *
 * It also records **interest points**: positions in the generated session that
 * are worth forking at, each with a prepared edit. Those are what turn the UI
 * from "here is a log" into "here are five experiments you can run".
 */

import { createRng, type Rng } from "../core/prng.ts";
import { describeEvent } from "../engine/describe.ts";
import type { EngineState, EventCore, SessionConfig, TimeInForce } from "../engine/types.ts";
import type { Session } from "../timeline/session.ts";

export interface OrderRef {
  orderId: string;
  placedSeq: number;
  restedSeq: number | null;
  owner: string;
  side: "BUY" | "SELL";
  price: number;
  qty: number;
}

/**
 * A prepared experiment. `mode` picks the semantics:
 *   - "branch"        — stop at the edit; the future is unwritten
 *   - "counterfactual" — keep the original future and report where it breaks
 */
export interface InterestPoint {
  seq: number;
  label: string;
  why: string;
  mode: "branch" | "counterfactual";
  event: string;
  /** Replacement payload fields, or a drop. */
  edit: { patch?: Record<string, unknown>; drop?: true };
}

export class Simulator {
  readonly session: Session;
  readonly timelineId: string;
  readonly rng: Rng;
  readonly interest: InterestPoint[] = [];
  #clock: number;
  #commands = 0;
  #events = 0;

  constructor(session: Session, timelineId: string, seed: number | string) {
    this.session = session;
    this.timelineId = timelineId;
    this.rng = createRng(seed);
    this.#clock = session.config.startVt;
  }

  get clock(): number {
    return this.#clock;
  }

  get commands(): number {
    return this.#commands;
  }

  get events(): number {
    return this.#events;
  }

  /** Current virtual time. */
  now(): number {
    return this.#clock;
  }

  /** Live state at the tip. Borrowed, not a copy: read it, never mutate it. */
  state(): EngineState {
    return this.session.get(this.timelineId).peek();
  }

  submit(command: Parameters<Session["submit"]>[1]): EventCore[] {
    this.#commands += 1;
    const events = this.session.submit(this.timelineId, command, this.#clock);
    this.#events += events.length;
    return events;
  }

  /** Move the clock forward, firing whatever TTLs fell due on the way. */
  advance(ms: number): EventCore[] {
    this.#clock += ms;
    const events = this.session.advanceTo(this.timelineId, this.#clock);
    this.#events += events.length;
    return events;
  }

  /** Advance to an absolute virtual time (used to line up scenario phases). */
  advanceTo(vt: number): EventCore[] {
    if (vt <= this.#clock) return [];
    return this.advance(vt - this.#clock);
  }

  /* ---------------------------------------------------------- convenience */

  openSession(): void {
    this.submit({
      kind: "OPEN_SESSION",
      symbol: this.session.config.instrument.symbol,
      sessionIndex: this.state().sessionIndex + 1,
    });
  }

  fund(owner: string): void {
    const participant = this.session.config.participants.find((p) => p.owner === owner);
    if (!participant) throw new Error(`simulator: no participant '${owner}'`);
    this.submit({ kind: "DEPOSIT", owner, amount: participant.initialCash, note: "opening balance" });
    this.submit({ kind: "GRANT_SHARES", owner, shares: participant.initialShares, note: "opening allocation" });
  }

  fundAll(): void {
    this.submit({
      kind: "OPEN_SESSION",
      symbol: this.session.config.instrument.symbol,
      sessionIndex: 1,
    });
    for (const participant of this.session.config.participants) this.fund(participant.owner);
  }

  /**
   * Place an order and return a handle to it. A rejected order returns null —
   * which is itself a legitimate outcome a scenario can inspect.
   */
  place(
    owner: string,
    side: "BUY" | "SELL",
    price: number,
    qty: number,
    tif: TimeInForce = "GTC",
    options: { ttlMs?: number | null; clientRef?: string | null } = {},
  ): OrderRef | null {
    const events = this.submit({
      kind: "PLACE_ORDER",
      owner,
      side,
      price,
      qty,
      tif,
      ttlMs: options.ttlMs ?? null,
      clientRef: options.clientRef ?? null,
    });
    const placed = events.find((event) => event.kind === "ORDER_PLACED");
    if (!placed) return null;
    const data = placed.data as { orderId: string };
    const rested = events.find((event) => event.kind === "ORDER_RESTED");
    return {
      orderId: data.orderId,
      placedSeq: placed.seq,
      restedSeq: rested ? rested.seq : null,
      owner,
      side,
      price,
      qty,
    };
  }

  cancel(owner: string, orderId: string): EventCore[] {
    return this.submit({ kind: "CANCEL_ORDER", owner, orderId });
  }

  closeSession(reason: string): void {
    this.submit({ kind: "CLOSE_SESSION", reason });
  }

  /* -------------------------------------------------------------- helpers */

  /**
   * Round a quantity onto the instrument's lot grid.
   *
   * The venue rejects quantity that is not a whole number of lots, so a
   * simulator that jitters sizes freely would spend most of its time getting
   * its own orders refused. Every randomly sized order goes through here.
   */
  lot(qty: number): number {
    const lot = this.session.config.instrument.lotSize;
    return Math.max(lot, Math.round(qty / lot) * lot);
  }

  /** Round a price onto the tick grid. */
  tick(price: number): number {
    const tick = this.session.config.instrument.tickSize;
    return Math.max(tick, Math.round(price / tick) * tick);
  }

  bestBid(): number | null {
    return this.state().bids[0]?.price ?? null;
  }

  bestAsk(): number | null {
    return this.state().asks[0]?.price ?? null;
  }

  mid(): number {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid !== null && ask !== null) return Math.round((bid + ask) / 2);
    if (bid !== null) return bid;
    if (ask !== null) return ask;
    return this.session.config.instrument.referencePrice;
  }

  /** Cancel everything an owner still has open. */
  cancelAll(owner: string): number {
    const open = Object.values(this.state().orders).filter(
      (order) => order.owner === owner && order.status === "OPEN",
    );
    for (const order of open) this.cancel(owner, order.id);
    return open.length;
  }

  openOrderIds(owner: string): string[] {
    return Object.values(this.state().orders)
      .filter((order) => order.owner === owner && order.status === "OPEN")
      .map((order) => order.id);
  }

  /**
   * Record a prepared experiment. Called by scenarios immediately after the
   * event they want to make forkable has been produced.
   */
  mark(point: Omit<InterestPoint, "event"> & { event?: string }): void {
    const event = point.event ?? this.describeAt(point.seq);
    this.interest.push({ ...point, event });
  }

  describeAt(seq: number): string {
    const event = this.session.get(this.timelineId).eventAt(seq);
    return event ? describeEvent(event) : "unknown";
  }
}
