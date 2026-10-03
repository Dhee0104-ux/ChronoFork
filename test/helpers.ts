/**
 * Shared test scaffolding: a small venue, a deterministic command fuzzer, and
 * the "quiet point" assertion that is stronger than the runtime invariant.
 */

import { createRng } from "../src/core/prng.ts";
import { Engine } from "../src/engine/engine.ts";
import { checkInvariants, invariantName } from "../src/engine/invariants.ts";
import type { Command, EventCore, SessionConfig } from "../src/engine/types.ts";
import { Session } from "../src/timeline/session.ts";

export const TEST_CONFIG: SessionConfig = {
  id: "test-venue",
  label: "test venue",
  description: "unit test venue",
  startVt: 0,
  instrument: { symbol: "TST", tickSize: 1, lotSize: 10, stp: "CANCEL_RESTING", referencePrice: 1000 },
  participants: [
    { owner: "MM", initialCash: 1_000_000, initialShares: 5_000, role: "market maker" },
    { owner: "FUND", initialCash: 1_000_000, initialShares: 5_000, role: "fund" },
    { owner: "TINY", initialCash: 5_000, initialShares: 100, role: "small account" },
  ],
};

export function newSession(config: SessionConfig = TEST_CONFIG): Session {
  return Session.create(config);
}

export function fundedEngine(config: SessionConfig = TEST_CONFIG): Engine {
  const engine = new Engine(config);
  engine.submit({ kind: "OPEN_SESSION", symbol: config.instrument.symbol, sessionIndex: 1 });
  for (const participant of config.participants) {
    engine.submit({ kind: "DEPOSIT", owner: participant.owner, amount: participant.initialCash });
    engine.submit({ kind: "GRANT_SHARES", owner: participant.owner, shares: participant.initialShares });
  }
  return engine;
}

/**
 * The strong completeness claim, checked where it is exactly true: after a
 * command has finished, an order that is open must be sitting in the book.
 * (Mid-command the newest order is legitimately "in flight" — see invariants.ts.)
 */
export function assertBookComplete(engine: Engine, label = ""): void {
  const state = engine.state;
  const inBook = new Set<string>();
  for (const level of [...state.bids, ...state.asks]) {
    for (const id of level.orders) inBook.add(id);
  }
  for (const order of Object.values(state.orders)) {
    if (order.status !== "OPEN") continue;
    if (!inBook.has(order.id)) {
      throw new Error(
        `${label}: order ${order.id} is OPEN with ${order.remaining} left but is not in the book`,
      );
    }
  }
  for (const id of inBook) {
    const order = state.orders[id];
    if (!order) throw new Error(`${label}: book references unknown order ${id}`);
    if (order.status !== "OPEN") throw new Error(`${label}: book holds ${order.status} order ${id}`);
  }
}

export function assertInvariants(engine: Engine, label = ""): void {
  const violations = checkInvariants(engine.state, { instrument: engine.config.instrument });
  if (violations.length > 0) {
    const first = violations[0]!;
    throw new Error(
      `${label}: invariant ${first.invariant} ${invariantName(first.invariant)} violated (${first.subject}): ${first.detail}`,
    );
  }
}

/** Assert every invariant plus book completeness at a command boundary. */
export function assertHealthy(engine: Engine, label = ""): void {
  assertBookComplete(engine, label);
  assertInvariants(engine, label);
}

export interface FuzzOptions {
  commands?: number;
  seed?: number | string;
  /** Fraction of commands that are cancels. */
  cancelShare?: number;
}

/**
 * Drive a venue with random but well-formed commands.
 *
 * Every command is issued against the live book, so the mix is realistic:
 * makers quote around the touch, takers cross it, and orders get cancelled and
 * left to expire. The point is the assertion after every single command.
 */
export function fuzz(engine: Engine, options: FuzzOptions = {}): { commands: number; events: EventCore[] } {
  const rng = createRng(options.seed ?? 1234);
  const total = options.commands ?? 400;
  const cancelShare = options.cancelShare ?? 0.2;
  const owners = engine.config.participants.map((participant) => participant.owner);
  /** The tape, so callers can replay or corrupt exactly what was produced. */
  const events: EventCore[] = [];

  events.push(
    ...engine.submit({ kind: "OPEN_SESSION", symbol: engine.config.instrument.symbol, sessionIndex: 1 }),
  );
  for (const participant of engine.config.participants) {
    events.push(
      ...engine.submit({ kind: "DEPOSIT", owner: participant.owner, amount: participant.initialCash }),
    );
    events.push(
      ...engine.submit({ kind: "GRANT_SHARES", owner: participant.owner, shares: participant.initialShares }),
    );
  }

  let issued = 0;
  let clock = 0;
  while (issued < total) {
    issued += 1;
    clock += rng.int(10, 900);

    if (rng.chance(cancelShare)) {
      const open = Object.values(engine.state.orders).filter((order) => order.status === "OPEN");
      const victim = rng.pick(open.length > 0 ? open : [{ id: "O000000", owner: "nobody" } as never]);
      events.push(
        ...engine.submit({ kind: "CANCEL_ORDER", owner: victim.owner, orderId: victim.id }, clock),
      );
      assertHealthy(engine, `after cancel #${issued}`);
      continue;
    }

    const owner = rng.pick(owners);
    const side = rng.chance(0.5) ? "BUY" : "SELL";
    const touch = side === "BUY" ? (engine.state.asks[0]?.price ?? 1000) : (engine.state.bids[0]?.price ?? 1000);
    const aggressive = rng.chance(0.45);
    const offset = aggressive ? rng.int(0, 3) : rng.int(1, 12);
    const price = side === "BUY" ? touch + offset : Math.max(1, touch - offset);
    const qty = rng.int(1, 20) * engine.config.instrument.lotSize;
    const tif = aggressive && rng.chance(0.7) ? "IOC" : rng.chance(0.5) ? "GTC" : "DAY";
    const command: Command = {
      kind: "PLACE_ORDER",
      owner,
      side,
      price,
      qty,
      tif,
      ttlMs: tif === "IOC" ? null : rng.chance(0.3) ? rng.int(1, 20) * 1_000 : null,
    };
    events.push(...engine.submit(command, clock));
    assertHealthy(engine, `after place #${issued}`);

    if (rng.chance(0.1)) {
      events.push(...engine.advanceTo(clock + rng.int(500, 30_000)));
      assertHealthy(engine, `after timers #${issued}`);
    }
  }

  events.push(...engine.submit({ kind: "CLOSE_SESSION", reason: "fuzz end" }, clock + 1_000));
  assertHealthy(engine, "after close");
  return { commands: issued, events };
}
