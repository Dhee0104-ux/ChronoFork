/** Scratch harness: exercised while building. Replaced by the test suite. */

import { Session } from "../src/timeline/session.ts";
import { Timeline } from "../src/timeline/timeline.ts";
import { diffStates } from "../src/timeline/diff.ts";
import { describeEvent } from "../src/engine/describe.ts";
import type { EventCore, SessionConfig } from "../src/engine/types.ts";

const config: SessionConfig = {
  id: "smoke",
  label: "smoke",
  description: "smoke test",
  startVt: 0,
  instrument: { symbol: "CFX", tickSize: 1, lotSize: 10, stp: "CANCEL_RESTING", referencePrice: 2400 },
  participants: [
    { owner: "MM1", initialCash: 500_000, initialShares: 2_000, role: "market maker" },
    { owner: "FUND_A", initialCash: 500_000, initialShares: 2_000, role: "fund" },
    { owner: "RETAIL", initialCash: 20_000, initialShares: 100, role: "retail" },
  ],
};

const session = Session.create(config);
const root = session.root;

root.submit({ kind: "OPEN_SESSION", symbol: "CFX", sessionIndex: 1 });
for (const participant of config.participants) {
  root.submit({ kind: "DEPOSIT", owner: participant.owner, amount: participant.initialCash });
  root.submit({ kind: "GRANT_SHARES", owner: participant.owner, shares: participant.initialShares });
}

root.submit({ kind: "PLACE_ORDER", owner: "MM1", side: "SELL", price: 2402, qty: 100, tif: "GTC" }, 1000);
root.submit({ kind: "PLACE_ORDER", owner: "MM1", side: "SELL", price: 2401, qty: 100, tif: "GTC" }, 1100);
root.submit({ kind: "PLACE_ORDER", owner: "MM1", side: "BUY", price: 2398, qty: 100, tif: "GTC" }, 1200);
root.submit({ kind: "PLACE_ORDER", owner: "FUND_A", side: "BUY", price: 2402, qty: 150, tif: "IOC" }, 1300);
root.submit({ kind: "PLACE_ORDER", owner: "RETAIL", side: "BUY", price: 2398, qty: 500, tif: "GTC" }, 1400);
root.submit({ kind: "PLACE_ORDER", owner: "MM1", side: "SELL", price: 2399, qty: 50, tif: "GTC", ttlMs: 5000 }, 1500);
root.advanceTo(9000);

const events = root.resolved();
console.log(`root: ${events.length} events`);
for (const event of events) {
  console.log(`  #${String(event.seq).padStart(3)} vt=${String(event.vt).padStart(5)} ${event.kind.padEnd(16)} ${describeEvent(event)}`);
}

const tip = root.state();
console.log("\nbook:", JSON.stringify({ bids: tip.state.bids.map((l) => [l.price, l.totalQty]), asks: tip.state.asks.map((l) => [l.price, l.totalQty]) }));
console.log("stats:", tip.state.stats);
console.log("accounts:", JSON.stringify(tip.state.accounts));
console.log("digests:", tip.digests.state.slice(0, 12), tip.digests.book.slice(0, 12));

/* ---------------------------------------------------------------- fork #1 */

// "What if MM1 had quoted that first ask two ticks higher?"
const target = events.findIndex(
  (e) => e.kind === "ORDER_PLACED" && (e.data as { owner: string; price: number }).owner === "MM1" && (e.data as { price: number }).price === 2402,
);
const original = events[target] as EventCore;
console.log(`\noverriding #${target}: ${describeEvent(original)}`);

const fork = session.fork("root", target + 1, "MM1 quotes 2405");
fork.setOverride(target, {
  event: { ...original, data: { ...(original.data as object), price: 2405 } as EventCore["data"] },
  note: "quote two ticks wider",
  createdAt: "2026-01-01T00:00:00.000Z",
});

// The prefix must still be byte-identical to the parent's.
const prefixEqual = fork.digestsAt(target).state === root.digestsAt(target).state;
console.log("shared prefix identical:", prefixEqual);
console.log("fork length:", fork.length(), "replay:", fork.replayCheck() ?? "ok");

const forkState = fork.state();
const diff = diffStates(tip.state, forkState.state);
console.log("\nidentical:", diff.identical);
console.log("digests equal:", JSON.stringify(diff.digests));
for (const line of diff.narration) console.log(" -", line);
console.log("best ask:", diff.book.bestAskA, "->", diff.book.bestAskB);
console.log("trades:", diff.market.tradesA, "->", diff.market.tradesB);
for (const account of diff.accounts) console.log(`  ${account.owner}: cash ${account.cashDelta >= 0 ? "+" : ""}${account.cashDelta}, shares ${account.positionsDelta >= 0 ? "+" : ""}${account.positionsDelta}`);

/* ---------------------------------------------------------------- fork #2 */

// "What if RETAIL's rejected order had never been sent at all?"
const rejected = events.findIndex((e) => e.kind === "ORDER_REJECTED");
const fork2 = session.fork("root", rejected + 1, "RETAIL stays out");
fork2.dropAt(rejected, "RETAIL never sent the order");
const diff2 = diffStates(tip.state, fork2.state().state);
console.log("\nfork2 narration:", diff2.narration);
console.log("fork2 digests equal:", JSON.stringify(diff2.digests));
console.log("first event divergence:", Timeline.firstEventDivergence(fork, fork2));
console.log("first state divergence:", Timeline.firstStateDivergence(fork, fork2));

const persisted = session.persist();
console.log("\npersisted:", persisted.events, "events ->", persisted.path);
const verification = session.verify();
console.log("verify:", verification.ok, verification.chain.checks.map((c) => `${c.ok ? "ok" : "FAIL"} ${c.name}`).join(" | "));
console.log("invariants:", verification.invariants.ok, verification.invariants.eventsChecked, "events checked");
console.log("timeline stats:", JSON.stringify(root.stats), JSON.stringify(fork.stats));
