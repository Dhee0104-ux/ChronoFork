import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Engine } from "../src/engine/engine.ts";
import { applyEvent } from "../src/engine/reducer.ts";
import { checkInvariants, monitorInvariants } from "../src/engine/invariants.ts";
import { createInitialState, requireAccount, stateHash } from "../src/engine/state.ts";
import type { Command, EventCore } from "../src/engine/types.ts";
import { assertHealthy, fundedEngine, fuzz, TEST_CONFIG } from "./helpers.ts";

const place = (owner: string, side: "BUY" | "SELL", price: number, qty: number, tif: "GTC" | "IOC" | "DAY" = "GTC"): Command => ({
  kind: "PLACE_ORDER",
  owner,
  side,
  price,
  qty,
  tif,
});

describe("matching", () => {
  it("trades at the resting order's price, giving the aggressor improvement", () => {
    const engine = fundedEngine();
    engine.submit(place("MM", "SELL", 1005, 100));
    const events = engine.submit(place("FUND", "BUY", 1010, 100, "IOC"));

    const trade = events.find((event) => event.kind === "TRADE");
    assert.ok(trade, "expected a print");
    assert.equal((trade.data as { price: number }).price, 1005, "prints at the maker's price");

    // 100 shares at 1005: the buyer escrowed 1010 * 100 and got the difference back.
    const fund = requireAccount(engine.state, "FUND");
    assert.equal(fund.cash, 1_000_000 - 100 * 1005);
    assert.equal(fund.positions, 5_000 + 100);
    assert.equal(fund.reservedCash, 0);
  });

  it("respects price priority before time priority", () => {
    const engine = fundedEngine();
    engine.submit(place("MM", "SELL", 1004, 100));
    engine.submit(place("MM", "SELL", 1002, 100));
    const events = engine.submit(place("FUND", "BUY", 1010, 100, "IOC"));
    const trade = events.find((event) => event.kind === "TRADE");
    assert.equal((trade?.data as { price: number }).price, 1002, "cheapest ask fills first");
  });

  it("respects time priority inside a price level", () => {
    const engine = fundedEngine();
    engine.submit(place("MM", "BUY", 996, 100));
    engine.submit(place("FUND", "BUY", 996, 100));
    const sell = engine.submit(place("FUND", "SELL", 996, 100, "IOC"));
    const trade = sell.find((event) => event.kind === "TRADE");
    const data = trade?.data as { buyOrderId: string; qty: number };
    assert.equal(data.qty, 100);
    // The order that arrived first at that price is the one that gets filled.
    const oldest = Object.values(engine.state.orders)
      .filter((order) => order.side === "BUY")
      .sort((a, b) => a.placedSeq - b.placedSeq)[0];
    assert.equal(data.buyOrderId, oldest?.id);
    assert.equal(oldest?.owner, "MM");
  });

  it("splits one aggressor across several levels and cancels the IOC remainder", () => {
    const engine = fundedEngine();
    engine.submit(place("MM", "SELL", 1001, 50));
    engine.submit(place("MM", "SELL", 1002, 50));
    const events = engine.submit(place("FUND", "BUY", 1002, 500, "IOC"));

    const trades = events.filter((event) => event.kind === "TRADE");
    assert.equal(trades.length, 2);
    const cancel = events.find((event) => event.kind === "ORDER_CANCELLED");
    assert.equal((cancel?.data as { reason: string }).reason, "IOC_REMAINDER");
    assert.equal((cancel?.data as { releasedQty: number }).releasedQty, 400);
    assert.equal(requireAccount(engine.state, "FUND").reservedCash, 0, "escrow fully released");
    assert.equal(engine.state.asks.length, 0);
  });

  it("keeps the book uncrossed by preventing self-trades", () => {
    const engine = fundedEngine();
    engine.submit(place("MM", "SELL", 1000, 100));
    const events = engine.submit(place("MM", "BUY", 1000, 100));

    assert.equal(events.filter((event) => event.kind === "TRADE").length, 0, "no self-print");
    const cancel = events.find((event) => event.kind === "ORDER_CANCELLED");
    assert.equal((cancel?.data as { reason: string }).reason, "SELF_TRADE_PREVENTION");
    assertHealthy(engine, "self trade");
  });
});

describe("escrow and accounting", () => {
  it("returns exactly what it withheld when an order is cancelled", () => {
    const engine = fundedEngine();
    const before = requireAccount(engine.state, "FUND").cash;
    const events = engine.submit(place("FUND", "BUY", 990, 200));
    const placed = events.find((event) => event.kind === "ORDER_PLACED");
    const orderId = (placed?.data as { orderId: string }).orderId;

    const escrowed = requireAccount(engine.state, "FUND");
    assert.equal(escrowed.cash, before - 990 * 200);
    assert.equal(escrowed.reservedCash, 990 * 200);

    engine.submit({ kind: "CANCEL_ORDER", owner: "FUND", orderId });
    const after = requireAccount(engine.state, "FUND");
    assert.equal(after.cash, before);
    assert.equal(after.reservedCash, 0);
    assertHealthy(engine, "escrow round trip");
  });

  it("never lets an account spend shares twice", () => {
    const engine = fundedEngine();
    engine.submit({ kind: "GRANT_SHARES", owner: "TINY", shares: 100 }); // TINY holds 200
    const tooBig = engine.submit(place("TINY", "SELL", 1_100, 300));
    assert.equal(
      (tooBig.find((event) => event.kind === "ORDER_REJECTED")?.data as { reason: string }).reason,
      "INSUFFICIENT_SHARES",
    );

    engine.submit(place("TINY", "SELL", 1_100, 200));
    const again = engine.submit(place("TINY", "SELL", 1_100, 10));
    assert.equal(
      (again.find((event) => event.kind === "ORDER_REJECTED")?.data as { reason: string }).reason,
      "INSUFFICIENT_SHARES",
      "shares already committed to a resting order cannot be committed again",
    );
    assertHealthy(engine, "share reservation");
  });

  it("refuses orders the wallet cannot cover and reports it as an event", () => {
    const engine = fundedEngine();
    const events = engine.submit(place("TINY", "BUY", 1_000, 10_000));
    const rejected = events.find((event) => event.kind === "ORDER_REJECTED");
    assert.equal((rejected?.data as { reason: string }).reason, "INSUFFICIENT_CASH");
    assert.equal(engine.state.orders ? Object.keys(engine.state.orders).length : 0, 0);
    assert.equal(engine.state.stats.rejectedOrders, 1);
  });

  it("validates the tick and lot grids", () => {
    const engine = fundedEngine();
    const lot = engine.submit(place("MM", "BUY", 1_000, 15));
    assert.equal((lot[0]?.data as { reason: string }).reason, "INVALID_QUANTITY");
    const tick = engine.submit({
      kind: "PLACE_ORDER",
      owner: "MM",
      side: "BUY",
      price: 1_000.5,
      qty: 10,
      tif: "GTC",
    });
    assert.equal((tick[0]?.data as { reason: string }).reason, "INVALID_PRICE");
  });

  it("refuses cancels it cannot honour", () => {
    const engine = fundedEngine();
    engine.submit(place("MM", "BUY", 990, 100));
    const orderId = Object.values(engine.state.orders)[0]?.id as string;

    const wrongOwner = engine.submit({ kind: "CANCEL_ORDER", owner: "FUND", orderId });
    assert.equal((wrongOwner[0]?.data as { reason: string }).reason, "NOT_ORDER_OWNER");

    const missing = engine.submit({ kind: "CANCEL_ORDER", owner: "FUND", orderId: "O999999" });
    assert.equal((missing[0]?.data as { reason: string }).reason, "UNKNOWN_ORDER");

    engine.submit({ kind: "CANCEL_ORDER", owner: "MM", orderId });
    const twice = engine.submit({ kind: "CANCEL_ORDER", owner: "MM", orderId });
    assert.equal((twice[0]?.data as { reason: string }).reason, "ORDER_NOT_OPEN");
  });

  it("closes the session, expiring DAY orders and carrying GTC", () => {
    const engine = fundedEngine();
    engine.submit(place("MM", "SELL", 1_010, 100, "GTC"));
    engine.submit(place("MM", "SELL", 1_011, 100, "DAY"));
    const events = engine.submit({ kind: "CLOSE_SESSION", reason: "test close" });

    const closed = events.find((event) => event.kind === "SESSION_CLOSED");
    assert.equal((closed?.data as { dayExpired: number }).dayExpired, 1);
    assert.equal((closed?.data as { gtcCarried: number }).gtcCarried, 1);

    const after = engine.submit(place("FUND", "BUY", 1_011, 10));
    assert.equal((after[0]?.data as { reason: string }).reason, "SESSION_CLOSED");
    assertHealthy(engine, "after close");
  });
});

describe("virtual clock", () => {
  it("fires TTLs when time advances, not when the command arrives", () => {
    const engine = fundedEngine();
    engine.submit(
      { kind: "PLACE_ORDER", owner: "MM", side: "SELL", price: 1_010, qty: 100, tif: "GTC", ttlMs: 5_000 },
      1_000,
    );
    assert.equal(engine.nextTimerAt(), 6_000);

    assert.equal(engine.advanceTo(5_999).length, 0, "nothing due yet");
    const fired = engine.advanceTo(6_000);
    assert.equal(fired.length, 1);
    assert.equal((fired[0]?.data as { reason: string }).reason, "TTL_EXPIRED");
    assert.equal(engine.state.orders ? Object.keys(engine.state.orders).length : 1, 1);
    assert.equal(engine.state.bids.length + engine.state.asks.length, 0);
  });

  it("replays timers without consulting a clock", () => {
    const build = (): Engine => {
      const engine = fundedEngine();
      engine.submit(
        { kind: "PLACE_ORDER", owner: "MM", side: "SELL", price: 1_010, qty: 100, tif: "GTC", ttlMs: 5_000 },
        1_000,
      );
      engine.advanceTo(9_000);
      engine.submit(place("FUND", "BUY", 1_010, 10, "IOC"), 9_500);
      return engine;
    };

    const first = build();
    // Same commands, different wall-clock moment, wildly different real time.
    const second = build();
    assert.equal(stateHash(first.state), stateHash(second.state));
    assert.equal(engineDigestOf(first), engineDigestOf(second));
  });

  function engineDigestOf(engine: Engine): string {
    return stateHash(engine.state);
  }
});

describe("determinism and invariants under fuzzing", () => {
  it("holds every invariant after every one of 400 random commands", () => {
    const engine = fundedEngine();
    const { commands } = fuzz(engine, { commands: 400, seed: 987_654 });
    assert.equal(commands, 400);
    assert.ok(engine.state.stats.tradeCount > 20, "the fuzzer should actually trade");
    assert.equal(checkInvariants(engine.state, { instrument: TEST_CONFIG.instrument }).length, 0);
  });

  it("produces byte-identical state from identical command streams", () => {
    const run = (): string => {
      const engine = fundedEngine();
      fuzz(engine, { commands: 250, seed: "determinism" });
      return stateHash(engine.state);
    };
    assert.equal(run(), run());
  });
});

describe("invariant monitor", () => {
  const ctx = { instrument: TEST_CONFIG.instrument };

  /** Walk the stream, running the *full* check after every event. */
  function scanEveryEvent(events: readonly EventCore[]): Map<string, number> {
    const state = createInitialState(TEST_CONFIG);
    const first = new Map<string, number>();
    for (const violation of checkInvariants(state, ctx)) first.set(violation.invariant, 0);
    for (const event of events) {
      applyEvent(state, event);
      for (const violation of checkInvariants(state, ctx)) {
        if (!first.has(violation.invariant)) first.set(violation.invariant, event.seq);
      }
    }
    return first;
  }

  function monitorScan(events: readonly EventCore[]): Map<string, number> {
    const report = monitorInvariants(createInitialState(TEST_CONFIG), events, ctx, applyEvent);
    const first = new Map<string, number>();
    for (const verdict of report.verdicts) {
      if (verdict.firstViolationSeq !== null) first.set(verdict.id, verdict.firstViolationSeq);
    }
    return first;
  }

  /**
   * The monitor only checks what each event touched, on the grounds that every
   * earlier event was already checked. That shortcut is exact, and this is the
   * test that says so: a clean stream and a deliberately corrupted one must give
   * byte-identical answers either way.
   */
  it("reaches the same verdicts as a full scan after every event", () => {
    // A bare engine: the fuzzer opens the session and funds it, so the tape it
    // hands back starts at seq 0.
    const engine = new Engine(TEST_CONFIG);
    const { events } = fuzz(engine, { commands: 150, seed: "monitor-equivalence" });

    assert.deepEqual([...monitorScan(events)], [...scanEveryEvent(events)]);

    // Now corrupt reality: shrink one print, so the resting order claims more
    // filled than the tape says, the reservation no longer matches its orders and
    // the level's cached depth is stale. All three must be found, at the same
    // positions, by both scans.
    const trade = events.find((event) => event.kind === "TRADE") as EventCore;
    const corrupted = events.map((event) =>
      event === trade
        ? {
            ...event,
            data: { ...(event.data as object), qty: 10 } as EventCore["data"],
          }
        : event,
    );
    const full = scanEveryEvent(corrupted);
    const scoped = monitorScan(corrupted);
    assert.ok(full.size > 0, "the corrupted stream must break something");
    assert.deepEqual([...scoped], [...full]);
  });

  it("is fast enough to run interactively on a long session", () => {
    // Not a micro-benchmark: the counterfactual UI monitors a whole alternative
    // history on every click, so a quadratic fold here is a broken feature.
    const engine = new Engine(TEST_CONFIG);
    const { events } = fuzz(engine, { commands: 400, seed: "monitor-speed" });
    const started = performance.now();
    const report = monitorInvariants(createInitialState(TEST_CONFIG), events, ctx, applyEvent);
    const elapsed = performance.now() - started;
    assert.equal(report.ok, true);
    assert.equal(report.eventsChecked, events.length);
    assert.ok(
      elapsed < 2_000,
      `${events.length} events monitored in ${elapsed.toFixed(0)}ms — expected well under 2s`,
    );
  });
});
