/**
 * Scenario definitions.
 *
 * Each scenario is a deterministic function of its seed: same seed, same
 * commands, same events, down to the millisecond. Freezing the generator's
 * output into the log is the entire point — the log can then be replayed,
 * verified, branched and audited without ever running this file again.
 *
 * Scenarios also annotate **interest points**: the moments worth forking at,
 * with a prepared edit. They are the difference between a log viewer and an
 * investigation tool.
 */

import { formatPrice, formatQty } from "../engine/describe.ts";
import type { ParticipantConfig, SessionConfig } from "../engine/types.ts";
import { Session } from "../timeline/session.ts";
import { Simulator, type InterestPoint, type OrderRef } from "./simulator.ts";

export interface ScenarioDefinition {
  id: string;
  label: string;
  tagline: string;
  description: string;
  seed: number;
  /** Virtual milliseconds since midnight for the opening bell. */
  startVt: number;
  participants: ParticipantConfig[];
  referencePrice: number;
  run(sim: Simulator): void;
}

export interface BuiltScenario {
  session: Session;
  interest: InterestPoint[];
  config: SessionConfig;
}

const OPEN_BELL = 34_200_000; // 09:30:00 as milliseconds since midnight

const DESK: ParticipantConfig[] = [
  { owner: "MM1", initialCash: 80_000_000, initialShares: 40_000, role: "market maker" },
  { owner: "MM2", initialCash: 60_000_000, initialShares: 32_000, role: "market maker" },
  { owner: "ALGO", initialCash: 40_000_000, initialShares: 48_000, role: "execution algo" },
  { owner: "FUND_A", initialCash: 200_000_000, initialShares: 250_000, role: "institutional buyer" },
  { owner: "FUND_B", initialCash: 200_000_000, initialShares: 400_000, role: "institutional seller" },
  { owner: "RETAIL", initialCash: 30_000_000, initialShares: 6_000, role: "retail" },
];

/* --------------------------------------------------------------- utilities */

/** Mean-reverting random walk in cents. Floats live here and only here. */
class PricePath {
  #value: number;
  #reference: number;
  #rng: { normal(): number };

  constructor(rng: { normal(): number }, reference: number) {
    this.#rng = rng;
    this.#value = reference;
    this.#reference = reference;
  }

  /**
   * The walk is a float; the market is not. Every consumer gets an integer
   * number of cents, which is also why a price can never leak a fraction into
   * an order and get refused as off-tick.
   */
  get value(): number {
    return Math.round(this.#value);
  }

  step(volatility: number, pull = 0.002): number {
    this.#value += this.#rng.normal() * volatility - (this.#value - this.#reference) * pull;
    this.#value = Math.min(this.#reference * 1.4, Math.max(this.#reference * 0.7, this.#value));
    return Math.round(this.#value);
  }
}

export interface SweepResult {
  refs: OrderRef[];
  firstSeq: number | null;
  lastSeq: number | null;
  qty: number;
}

/**
 * Work an order through the book the way an execution algo does: several
 * marketable slices, each priced off the *live touch* rather than a stale
 * reference, so the slices actually trade.
 */
function work(
  sim: Simulator,
  owner: string,
  side: "BUY" | "SELL",
  totalQty: number,
  slices: number,
  tag: string,
  limitOffset = 4,
): SweepResult {
  const per = Math.max(10, Math.floor(totalQty / slices / 10) * 10);
  const refs: OrderRef[] = [];
  for (let i = 0; i < slices; i++) {
    const qty = i === slices - 1 ? totalQty - per * (slices - 1) : per;
    if (qty <= 0) continue;
    const touch = side === "BUY" ? (sim.bestAsk() ?? sim.mid() + limitOffset) : (sim.bestBid() ?? sim.mid() - limitOffset);
    const limit = side === "BUY" ? touch + limitOffset : Math.max(1, touch - limitOffset);
    const ref = sim.place(owner, side, limit, qty, "IOC", { clientRef: `${owner}-${tag}-${i + 1}` });
    if (ref) refs.push(ref);
    sim.advance(sim.rng.int(120, 600));
  }
  return {
    refs,
    firstSeq: refs[0]?.placedSeq ?? null,
    lastSeq: refs[refs.length - 1]?.placedSeq ?? null,
    qty: totalQty,
  };
}

/**
 * Replace an owner's quotes with a fresh ladder: `levels` orders per side at
 * one-tick spacing. A ladder (rather than a single touch quote) is what gives
 * the book depth for a later cascade to eat through.
 */
function quoteLadder(
  sim: Simulator,
  owner: string,
  target: number,
  options: {
    levels?: number;
    spread: number;
    spacing?: number;
    qty: number;
    ttlMs?: number | null;
    keepOutOfTouch?: boolean;
  },
): { bids: OrderRef[]; asks: OrderRef[] } {
  for (const orderId of sim.openOrderIds(owner)) sim.cancel(owner, orderId);

  const levels = options.levels ?? 3;
  const spacing = options.spacing ?? 1;
  const touchBid = sim.bestBid();
  const touchAsk = sim.bestAsk();
  const bids: OrderRef[] = [];
  const asks: OrderRef[] = [];

  for (let i = 0; i < levels; i++) {
    let bidPrice = target - options.spread - i * spacing;
    let askPrice = target + options.spread + i * spacing;
    if (options.keepOutOfTouch !== false) {
      if (touchAsk !== null && bidPrice >= touchAsk) bidPrice = touchAsk - 1 - i;
      if (touchBid !== null && askPrice <= touchBid) askPrice = touchBid + 1 + i;
    }
    const size = sim.lot(
      options.qty + sim.rng.int(-Math.floor(options.qty / 5), Math.floor(options.qty / 5)),
    );
    if (bidPrice > 0) {
      bids.push(
        sim.place(owner, "BUY", bidPrice, size, "GTC", { ttlMs: options.ttlMs ?? null, clientRef: `${owner}-bid-${i}` }) as OrderRef,
      );
    }
    asks.push(
      sim.place(owner, "SELL", askPrice, size, "GTC", { ttlMs: options.ttlMs ?? null, clientRef: `${owner}-ask-${i}` }) as OrderRef,
    );
  }
  sim.advance(sim.rng.int(80, 420));
  return { bids: bids.filter(Boolean), asks: asks.filter(Boolean) };
}

/** Cancel only the quotes sitting at the touch, leaving the deeper ladder. */
/** Cancel only the quotes sitting at the touch, leaving the deeper ladder. */
function pullTouchQuotes(
  sim: Simulator,
  owner: string,
): Array<{ orderId: string; seq: number; side: "BUY" | "SELL"; price: number }> {
  const state = sim.state();
  const bestBid = state.bids[0]?.price ?? null;
  const bestAsk = state.asks[0]?.price ?? null;
  const cancelled: Array<{ orderId: string; seq: number; side: "BUY" | "SELL"; price: number }> = [];

  for (const order of Object.values(state.orders)) {
    if (order.owner !== owner || order.status !== "OPEN") continue;
    const atTouch = (order.side === "BUY" && order.price === bestBid) || (order.side === "SELL" && order.price === bestAsk);
    if (!atTouch) continue;
    for (const event of sim.cancel(owner, order.id)) {
      if (event.kind !== "ORDER_CANCELLED") continue;
      if ((event.data as { orderId: string }).orderId !== order.id) continue;
      cancelled.push({ orderId: order.id, seq: event.seq, side: order.side, price: order.price });
    }
  }
  return cancelled;
}

/**
 * Leave the session with a real book on screen.
 *
 * Simulation time only moves when something happens, so a session that ends
 * with a burst of TTL expiries has an empty ladder at its tip — accurate, but a
 * poor thing to open a log viewer on. These are plain GTC orders (no TTL) that
 * survive to the close, plus a couple of prints to keep the tape alive.
 */
function closingLadder(sim: Simulator, target: number): void {
  quoteLadder(sim, "MM1", target, { spread: 1, qty: 300, levels: 3, spacing: 2 });
  sim.advance(sim.rng.int(300, 900));
  quoteLadder(sim, "MM2", target, { spread: 2, qty: 220, levels: 3, spacing: 2 });
  sim.advance(sim.rng.int(300, 900));
  work(sim, "RETAIL", sim.rng.chance(0.5) ? "BUY" : "SELL", 60, 2, "closing-ticket", 3);
  sim.place("ALGO", "BUY", (sim.bestBid() ?? target) - 4, 250, "GTC", { clientRef: "algo-closing-bid" });
  sim.place("ALGO", "SELL", (sim.bestAsk() ?? target) + 4, 250, "GTC", { clientRef: "algo-closing-ask" });
  sim.advance(sim.rng.int(400, 900));
}

/** Idle market background: retail tickets and algo accumulation. */
function background(sim: Simulator, target: number, intensity: number): void {
  if (sim.rng.chance(0.3 * intensity)) {
    const side = sim.rng.chance(0.5) ? "BUY" : "SELL";
    sim.place("RETAIL", side, side === "BUY" ? target + 5 : target - 5, sim.rng.int(1, 3) * 10, "DAY", {
      clientRef: "retail-ticket",
    });
  }
  if (sim.rng.chance(0.25 * intensity)) {
    sim.place("ALGO", sim.rng.chance(0.5) ? "BUY" : "SELL", target + (sim.rng.chance(0.5) ? 7 : -7), sim.rng.int(3, 12) * 10, "GTC", {
      ttlMs: sim.rng.int(8, 30) * 1_000,
      clientRef: "algo-passive",
    });
  }
}

/* ------------------------------------------------------------- scenario: 1 */

const calmOpen: ScenarioDefinition = {
  id: "calm-open",
  label: "Calm open",
  tagline: "An orderly first quarter hour: two makers laddering a drifting market.",
  description:
    "The control case. Two market makers keep three levels a side around a slowly drifting fair value, an execution algo works a client order through the touch, retail sends small day tickets, and a few of them get refused. Every invariant holds at every event — the baseline every counterfactual is measured against.",
  seed: 20_260_101,
  startVt: OPEN_BELL,
  participants: DESK,
  referencePrice: 2400,
  run(sim) {
    sim.fundAll();
    const path = new PricePath(sim.rng, 2400);
    // One wave is kept, so a single slice of it can be rewritten afterwards.
    let markedWave: SweepResult | null = null;

    for (let step = 0; step < 700; step++) {
      const target = path.step(0.9);
      sim.advance(sim.rng.int(120, 380));

      if (step % 5 === 0) quoteLadder(sim, "MM1", target, { spread: sim.rng.int(1, 2), qty: 260, ttlMs: 25_000 });
      if (step % 8 === 3) quoteLadder(sim, "MM2", target, { spread: sim.rng.int(2, 3), qty: 180, ttlMs: 20_000 });

      background(sim, target, 1);
      if (step === 420) markedWave = work(sim, "FUND_A", "BUY", 600, 3, "calm-wave");
      else if (step % 11 === 5) work(sim, sim.rng.chance(0.55) ? "FUND_A" : "FUND_B", sim.rng.chance(0.55) ? "BUY" : "SELL", sim.rng.int(2, 7) * 100, 3, "work");
    }

    const openingSlice = markedWave?.refs[0];
    if (openingSlice) {
      // A price edit rather than a quantity one, deliberately. A slice that
      // filled completely can absorb a bigger ticket and one that left an IOC
      // remainder cannot (its cancel names the exact quantity it releases), so
      // "one more tick on the limit" is the edit that is always applicable —
      // which is what makes it a clean demonstration of a *legal* divergence.
      sim.mark({
        seq: openingSlice.placedSeq,
        label: "The wave's opening slice is a cent more generous",
        why: "One tick on the first slice's limit. The tape does not change at all — the same prints at the same prices — and yet the buyer's cash and the maker's end up different, because price improvement is refunded against whatever the order reserved.",
        mode: "counterfactual",
        edit: { patch: { price: openingSlice.price + 1 } },
      });
    }

    sim.advance(1_200);
    const lateRetail = sim.place("RETAIL", "BUY", sim.bestBid() ?? 2390, 10, "DAY", { clientRef: "retail-late" });
    if (lateRetail) {
      sim.mark({
        seq: lateRetail.placedSeq,
        label: "The last retail ticket is never sent",
        why: "Ten shares resting on the bid into the close. Removing it barely moves the market — which is exactly why it is worth checking rather than assuming: a counterfactual is only interesting once you know which ones change nothing.",
        mode: "counterfactual",
        edit: { drop: true },
      });
    }
    // A wildly over-sized ticket against a thin wallet: refused on the spot,
    // which is a good example of a rejection that costs the venue nothing.
    sim.place("RETAIL", "BUY", sim.bestAsk() ?? 2400, 5_000, "IOC", { clientRef: "retail-underfunded" });
    sim.advance(600);
    closingLadder(sim, path.value);
    sim.closeSession("regular close");
  },
};

/* ------------------------------------------------------------- scenario: 2 */

const volatileSession: ScenarioDefinition = {
  id: "volatile-session",
  label: "Volatile session",
  tagline: "Wider spreads, thinner books, makers requoting almost continuously.",
  description:
    "Four times the volatility of the calm open with TTLs that expire mid-flight and IOC remainders cancelled constantly. Nearly every order ends up partially consumed, which makes it the best stress test in the set for reservation accounting: if a single cent or share is mis-escrowed anywhere, the conservation invariants catch it here.",
  seed: 771_144,
  startVt: OPEN_BELL,
  participants: DESK,
  referencePrice: 2400,
  run(sim) {
    sim.fundAll();
    const path = new PricePath(sim.rng, 2400);
    // A wave, a stop-out and an impatient retail ticket are kept for forking.
    let markedWave: SweepResult | null = null;
    let markedRetail: OrderRef | null = null;

    for (let step = 0; step < 900; step++) {
      const target = path.step(3.2);
      sim.advance(sim.rng.int(60, 220));

      if (step % 3 === 0) quoteLadder(sim, "MM1", target, { spread: sim.rng.int(3, 6), qty: 220, ttlMs: 9_000, spacing: sim.rng.int(1, 3) });
      if (step % 4 === 1) quoteLadder(sim, "MM2", target, { spread: sim.rng.int(3, 7), qty: 160, ttlMs: 7_000, spacing: sim.rng.int(1, 3) });

      background(sim, target, 1.2);
      if (step === 600) {
        markedWave = work(sim, "FUND_A", "BUY", 1_200, 3, "volatile-wave");
      } else if (step % 6 === 2) {
        const side = sim.rng.chance(0.55) ? "SELL" : "BUY";
        work(sim, side === "SELL" ? "FUND_B" : "FUND_A", side, sim.rng.int(4, 14) * 100, 3, "wave");
      } else if (step === 777) {
        markedRetail = sim.place("RETAIL", "SELL", target - 1, 10, "IOC", {
          clientRef: "retail-capitulation",
        });
      }
      if (sim.rng.chance(0.08)) {
        sim.place("RETAIL", sim.rng.chance(0.5) ? "BUY" : "SELL", target + sim.rng.int(1, 3), 10, "IOC", {
          clientRef: "retail-impatient",
        });
      }
      if (sim.rng.chance(0.03)) {
        // A deliberately malformed ticket: one share short of a whole lot. The
        // venue refuses it before it can touch the book, and the refusal is a
        // first-class event like everything else.
        const side = sim.rng.chance(0.5) ? "BUY" : "SELL";
        sim.place("RETAIL", side, sim.tick(target + (side === "BUY" ? 3 : -3)), 15, "IOC", {
          clientRef: "retail-odd-lot",
        });
      }
    }

    const waveSlice = markedWave?.refs[0];
    if (waveSlice) {
      sim.mark({
        seq: waveSlice.placedSeq,
        label: "The wave is a cent tighter",
        why: "The same 1,200 share buy, worked in the same three slices, with the first slice's limit one tick lower. Every print in the session is unchanged — what moves is the cash, and this is the experiment that shows how far a one-tick edit propagates through a thin, fast-moving book.",
        mode: "counterfactual",
        edit: { patch: { price: waveSlice.price - 1 } },
      });
    }

    if (markedRetail) {
      sim.mark({
        seq: markedRetail.placedSeq,
        label: "The capitulation seller never arrives",
        why: "A ten-share market sell into a book that has already sold off. Branch here, drop the ticket and drive the rest of the afternoon yourself: this is the mode where the future is unwritten, so nothing about it can be impossible.",
        mode: "branch",
        edit: { drop: true },
      });
    }

    closingLadder(sim, path.value);
    sim.closeSession("closing auction");
  },
};

/* ------------------------------------------------------------- scenario: 3 */

const liquidityVacuum: ScenarioDefinition = {
  id: "liquidity-vacuum",
  label: "Liquidity vacuum",
  tagline: "Both makers pull their touch; a seller cascades through the ladder behind it.",
  description:
    "The headline case. A large seller works into a normal market, both makers withdraw the quotes at the touch inside the same second, and the next slice walks down through the deeper ladder that is still resting behind them — printing a range of prices that has nothing to do with where the market was trading a second earlier. The fork points put a single quote back and show what the tape would have looked like.",
  seed: 421_2026,
  startVt: OPEN_BELL,
  participants: DESK,
  referencePrice: 2400,
  run(sim) {
    sim.fundAll();
    const path = new PricePath(sim.rng, 2400);
    let target = 2400;

    /* phase 1 — a normal market with a real ladder behind the touch */
    for (let step = 0; step < 220; step++) {
      target = path.step(1.1);
      sim.advance(sim.rng.int(150, 420));
      if (step % 4 === 0) quoteLadder(sim, "MM1", target, { spread: 1, qty: 300, ttlMs: 30_000 });
      if (step % 6 === 3) quoteLadder(sim, "MM2", target, { spread: 2, qty: 220, ttlMs: 25_000 });
      background(sim, target, 0.8);
      if (step % 9 === 2) work(sim, "ALGO", "BUY", sim.rng.int(2, 6) * 100, 2, "accumulate");
    }

    /* phase 2 — a large seller starts working the bids */
    const openingSlice = work(sim, "FUND_B", "SELL", 1_400, 3, "cascade");

    /* phase 3 — the vacuum. Both makers have just refreshed their ladders (so
       the touch is populated) and now withdraw only the quotes at the touch. */
    const fresh = quoteLadder(sim, "MM1", sim.mid(), { spread: 1, qty: 300, ttlMs: 20_000 });
    quoteLadder(sim, "MM2", sim.mid(), { spread: 2, qty: 220, ttlMs: 20_000 });
    sim.advance(sim.rng.int(250, 700));
    const pulled = [...pullTouchQuotes(sim, "MM1"), ...pullTouchQuotes(sim, "MM2")];
    const vacuumStartedAt = sim.now();

    // The quote this experiment targets: the bid MM1 just placed, and whatever
    // became of it. Either the pull that removed it, or its own placement —
    // both are valid things to undo, and both produce a fork worth looking at.
    const anchorBid = fresh.bids[0] ?? null;
    const anchor = anchorBid
      ? pulled.find((entry) => entry.orderId === anchorBid.orderId) ?? {
          orderId: anchorBid.orderId,
          seq: anchorBid.placedSeq,
        }
      : pulled[0] ?? null;

    if (anchor) {
      sim.mark({
        seq: anchor.seq,
        label: "That quote survives the vacuum",
        why: "One maker leaves one quote in the book through the vacuum. The rest of the morning happened the way it happened, so this asks the narrow question: did that liquidity change anything at all?",
        mode: "counterfactual",
        edit: { drop: true },
      });

      // The same cancel, but returning the wrong amount of escrow. This is the
      // incident class the invariant monitor exists for: the alternative
      // history is perfectly representable — the reducer applies every event —
      // yet the venue is no longer solvent in the sense that matters, because
      // an account's reservation no longer matches the orders behind it.
      if (anchorBid && anchor.orderId === anchorBid.orderId) {
        sim.mark({
          seq: anchor.seq,
          label: "The cancel forgets to release the escrow",
          why: "A one-line bug in the cancel path: the order leaves the book but its escrowed cash never comes back. Replaying the rest of the morning on top of it is completely legal event-by-event, which is exactly why a runtime invariant is the only thing that catches it.",
          mode: "counterfactual",
          edit: { patch: { releasedCash: 0 } },
        });
      }
    }

    sim.advance(3_800);

    /* phase 4 — the cascade into the ladder behind the touch */
    const cascade = work(sim, "FUND_B", "SELL", 2_400, 4, "cascade-2", 2);

    if (openingSlice.firstSeq !== null) {
      sim.mark({
        seq: openingSlice.firstSeq,
        label: "The first slice is half the size",
        why: "One number changed on one ticket. Watch the low: the later slices then print against the maker quotes that survived the vacuum instead of walking straight through them.",
        mode: "counterfactual",
        edit: { patch: { qty: Math.max(10, Math.round((openingSlice.refs[0]?.qty ?? 400) / 2)) } },
      });
    }
    void cascade;
    void vacuumStartedAt;

    /* phase 5 — makers return lower, the market finds a floor */
    for (let step = 0; step < 120; step++) {
      sim.advance(sim.rng.int(200, 600));
      const where = sim.mid();
      if (step % 2 === 0) quoteLadder(sim, "MM1", where, { spread: sim.rng.int(4, 9), qty: 320, ttlMs: 15_000, levels: 2 });
      if (step % 3 === 0) quoteLadder(sim, "MM2", where, { spread: sim.rng.int(5, 11), qty: 240, ttlMs: 15_000, levels: 2 });
      if (step % 4 === 0) work(sim, "FUND_A", "BUY", sim.rng.int(6, 18) * 100, 3, "recover");
      background(sim, where, 0.6);
    }

    const recovery = sim.place("FUND_A", "BUY", (sim.bestAsk() ?? target) + 2, 1_200, "IOC", {
      clientRef: "FUND_A-recovery",
    });

    if (recovery) {
      sim.mark({
        seq: recovery.placedSeq,
        label: "The recovery buyer stays out",
        why: "Remove the large buy that ended the drawdown. Nothing after it changes, so this is a clean branch you can drive yourself: place your own order and see whether the floor holds without it.",
        mode: "branch",
        edit: { drop: true },
      });
    }

    closingLadder(sim, sim.mid());
    sim.closeSession("halted and closed");
  },
};

/* ------------------------------------------------------------- scenario: 4 */

const fatFinger: ScenarioDefinition = {
  id: "fat-finger",
  label: "Fat finger",
  tagline: "A sell ticket an order of magnitude off, resting in the book all morning.",
  description:
    "A mistyped price puts a 200-lot sell at $12.00 instead of $24.00. It sweeps every bid on the way down, prints a low that should never have existed and leaves the remainder resting a thousand ticks below the market for anyone to pick off. The counterfactuals here are the two every trading desk actually runs after an incident: what if it had been priced right, and what if the order had been refused.",
  seed: 90_210,
  startVt: OPEN_BELL,
  participants: DESK,
  referencePrice: 2400,
  run(sim) {
    sim.fundAll();
    const path = new PricePath(sim.rng, 2400);
    let target = 2400;

    for (let step = 0; step < 200; step++) {
      target = path.step(0.9);
      sim.advance(sim.rng.int(140, 400));
      if (step % 4 === 0) quoteLadder(sim, "MM1", target, { spread: 1, qty: 280, ttlMs: 25_000 });
      if (step % 5 === 2) quoteLadder(sim, "MM2", target, { spread: 2, qty: 200, ttlMs: 25_000 });
      background(sim, target, 0.9);
      if (step % 8 === 1) work(sim, "ALGO", "BUY", sim.rng.int(2, 6) * 100, 2, "accumulate");
    }

    /* the fat finger */
    const typo = sim.place("FUND_B", "SELL", 1_200, 2_000, "GTC", { clientRef: "FUND_B-typo-1200" });
    sim.advance(400);

    if (typo) {
      sim.mark({
        seq: typo.placedSeq,
        label: "The ticket had been priced at $24.00",
        why: "One digit. Change 1200 to 2400 and the order joins the asks instead of eating the bids; replay the rest of the morning on top of that and see how far the alternative tape survives.",
        mode: "counterfactual",
        edit: { patch: { price: 2400 } },
      });
      sim.mark({
        seq: typo.placedSeq,
        label: "Risk checks refused the ticket",
        why: "What the desk would have preferred: the order never reaches the book at all. Branch here and the morning continues as a normal, boring, uncrossed market — a reminder of how much of the end state one refused order protects.",
        mode: "branch",
        edit: { drop: true },
      });
    }

    /* the market carries on, unaware */
    for (let step = 0; step < 140; step++) {
      sim.advance(sim.rng.int(150, 450));
      target = path.step(0.8);
      if (step % 3 === 0) quoteLadder(sim, "MM1", target, { spread: 1, qty: 280, ttlMs: 20_000 });
      if (step % 4 === 1) quoteLadder(sim, "MM2", target, { spread: 2, qty: 200, ttlMs: 20_000 });
      background(sim, target, 0.9);
      if (step % 7 === 3) work(sim, "FUND_A", "BUY", sim.rng.int(3, 9) * 100, 2, "buy");
    }

    /* somebody finally picks off the resting mistake */
    const cheap = Object.values(sim.state().orders).find(
      (order) => order.status === "OPEN" && order.price <= 1_300 && order.side === "SELL",
    );
    if (cheap) {
      const pickoff = sim.place("ALGO", "BUY", cheap.price, Math.min(cheap.remaining, 400), "IOC", {
        clientRef: "ALGO-pickoff",
      });
      if (pickoff) {
        sim.mark({
          seq: pickoff.placedSeq,
          label: "Nobody picks off the resting mistake",
          why: "The mispriced remainder sat in the book for twenty minutes. Remove the only order that ever touched it and both the low print and the last trade of the morning disappear entirely.",
          mode: "branch",
          edit: { drop: true },
        });
      }
    }

    closingLadder(sim, target);
    sim.closeSession("close after incident review");
  },
};

export const SCENARIOS: readonly ScenarioDefinition[] = [
  calmOpen,
  volatileSession,
  liquidityVacuum,
  fatFinger,
];

export function scenarioById(id: string): ScenarioDefinition | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

export function sessionConfigFor(scenario: ScenarioDefinition): SessionConfig {
  return {
    id: scenario.id,
    label: scenario.label,
    description: scenario.description,
    startVt: scenario.startVt,
    instrument: {
      symbol: "CFX",
      tickSize: 1,
      lotSize: 10,
      stp: "CANCEL_RESTING",
      referencePrice: scenario.referencePrice,
    },
    participants: scenario.participants,
  };
}

/** Generate a session from a scenario definition. Pure function of the seed. */
export function buildScenario(scenario: ScenarioDefinition): BuiltScenario {
  const config = sessionConfigFor(scenario);
  const session = Session.create(config);
  const simulator = new Simulator(session, session.root.id, scenario.seed);
  scenario.run(simulator);
  return { session, interest: simulator.interest, config };
}

/** Human summary used by the CLI and the API's session list. */
export function describeScenario(scenario: ScenarioDefinition): string {
  const desk = scenario.participants
    .map(
      (participant) =>
        `${participant.owner} (${formatQty(participant.initialShares)} sh, ${formatPrice(participant.initialCash)})`,
    )
    .join(", ");
  return `${scenario.label} — ${scenario.tagline}\n  desk: ${desk}`;
}

export type { InterestPoint };
