import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Timeline } from "../src/timeline/timeline.ts";
import { runCounterfactual } from "../src/timeline/report.ts";
import { diffStates } from "../src/timeline/diff.ts";
import type { Command, EventCore } from "../src/engine/types.ts";
import { newSession, TEST_CONFIG } from "./helpers.ts";

function scenario(commands = 60): { session: ReturnType<typeof newSession> } {
  const session = newSession();
  const root = session.root;
  root.submit({ kind: "OPEN_SESSION", symbol: "TST", sessionIndex: 1 });
  for (const participant of TEST_CONFIG.participants) {
    root.submit({ kind: "DEPOSIT", owner: participant.owner, amount: participant.initialCash });
    root.submit({ kind: "GRANT_SHARES", owner: participant.owner, shares: participant.initialShares });
  }
  let clock = 0;
  for (let i = 0; i < commands; i++) {
    clock += 100;
    const aggressive = i % 5 === 0;
    const side: "BUY" | "SELL" = i % 2 === 0 ? "BUY" : "SELL";
    const price = side === "BUY" ? 1_000 + (aggressive ? 6 : -1) : 1_000 - (aggressive ? 6 : -1);
    const command: Command = {
      kind: "PLACE_ORDER",
      owner: i % 3 === 0 ? "MM" : "FUND",
      side,
      price,
      qty: 10 * (1 + (i % 4)),
      tif: aggressive ? "IOC" : "GTC",
    };
    root.submit(command, clock);
  }
  return { session };
}

describe("forking", () => {
  it("shares every event before the fork point instead of copying it", () => {
    const { session } = scenario();
    const root = session.root;
    const events = root.resolved();
    const fork = session.fork(root.id, 20, "branch");

    assert.equal(fork.baseSeq, 20);
    assert.equal(fork.ownEvents.length, 0, "a fork starts with no events of its own");
    assert.equal(fork.length(), 20);

    const prefix = fork.resolved();
    assert.deepEqual(prefix, events.slice(0, 20));
    assert.equal(fork.digestsAt(20).state, root.digestsAt(20).state, "shared prefix, shared state");
  });

  it("leaves the parent untouched when the branch is driven forward", () => {
    const { session } = scenario();
    const root = session.root;
    const rootLengthBefore = root.length();
    const before = root.state().digests;
    const fork = session.fork(root.id, 20, "branch");

    fork.submit(
      { kind: "PLACE_ORDER", owner: "FUND", side: "BUY", price: 1_050, qty: 100, tif: "IOC" },
      99_000,
    );

    assert.equal(root.length(), rootLengthBefore, "the parent log did not grow");
    assert.equal(root.state().digests.state, before.state, "the parent state is unchanged");
    // One command can emit several events (accept, place, print, rest), so the
    // exact growth is the command's event count, not one per command.
    assert.ok(fork.ownEvents.length > 0, "the branch recorded events of its own");
    assert.equal(fork.length(), 20 + fork.ownEvents.length, "the branch grew by its own events only");
  });

  it("materializes a fork from a shared checkpoint rather than from genesis", () => {
    const { session } = scenario(400);
    const root = session.root;
    const forkPoint = Math.floor(root.length() / 2);
    // Warm the parent's checkpoints first, then branch.
    root.stateAt(root.length() - 1);

    const fork = session.fork(root.id, forkPoint, "checkpoint reuse");
    const materialized = fork.state();

    assert.ok(fork.checkpointKeys().length > 0, "the fork inherited checkpoints");
    assert.ok(
      materialized.fromCheckpoint > 0,
      `expected a checkpoint start, replayed ${materialized.eventsReplayed}`,
    );
    assert.equal(materialized.digests.state, root.digestsAt(forkPoint).state);
  });
});

describe("overrides", () => {
  it("changes what happened at a position without renumbering it", () => {
    const { session } = scenario();
    const root = session.root;
    const original = root.eventAt(30) as EventCore;
    const fork = session.fork(root.id, 31, "edit");

    fork.setOverride(30, {
      event: {
        seq: 30,
        vt: original.vt,
        kind: "ORDER_PLACED",
        data: { ...(original.data as object), qty: 990 } as EventCore["data"],
      },
      note: "bigger ticket",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const resolved = fork.eventAt(30) as EventCore;
    assert.equal(resolved.seq, 30, "the position is preserved");
    assert.equal((resolved.data as { qty: number }).qty, 990);
    assert.equal(fork.length(), 31);
    assert.equal(root.eventAt(30), original, "the parent still holds the original");
  });

  it("expresses 'this never happened' as a NOOP that keeps the slot", () => {
    const { session } = scenario();
    const root = session.root;
    // Guarantee a refusal exists: the small account sells shares it does not hold.
    root.submit({ kind: "PLACE_ORDER", owner: "TINY", side: "SELL", price: 1_020, qty: 1_000, tif: "GTC" }, 9_000);
    const target = root.resolved().findIndex((event) => event.kind === "ORDER_REJECTED");
    assert.ok(target >= 0, "the rejected ticket is in the log");

    const fork = session.fork(root.id, target + 1, "drop");
    fork.dropAt(target, "the ticket was never sent");

    const dropped = fork.eventAt(target) as EventCore;
    assert.equal(dropped.kind, "NOOP");
    assert.equal(dropped.seq, target);
    assert.equal((dropped.data as { replacedKind: string }).replacedKind, root.eventAt(target)?.kind);

    // Dropping a rejection changes nothing but the refusal counter.
    const diff = diffStates(root.state().state, fork.state().state);
    assert.equal(diff.digests.bookEqual, true);
    assert.equal(diff.digests.accountsEqual, true);
    assert.equal(diff.digests.stateEqual, false, "the refusal counter did move");
    assert.equal(diff.lifecycle.rejectedB, diff.lifecycle.rejectedA - 1);
  });

  it("rejects an override that tries to move an event to a different position", () => {
    const { session } = scenario();
    const fork = session.fork(session.root.id, 30, "bad edit");
    assert.throws(
      () =>
        fork.setOverride(10, {
          event: { seq: 11, vt: 0, kind: "NOOP", data: { note: "wrong slot", replacedKind: null } },
          note: "wrong slot",
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      /positions are immutable/,
    );
  });

  it("invalidates a stale checkpoint when an ancestor edits shared history", () => {
    const { session } = scenario(400);
    const root = session.root;
    const fork = session.fork(root.id, 300, "child");
    const before = fork.state();
    assert.equal(before.digests.state, root.digestsAt(300).state);
    assert.ok(
      fork.checkpointKeys().some((key) => key > 100),
      "the child cached checkpoints past the edit point",
    );

    // Rewrite a print inside the range the child inherits. Changing the price
    // keeps the history applicable, so the only thing that moves is state.
    const target = root.resolved().findIndex((event) => event.kind === "TRADE" && event.seq < 300);
    assert.ok(target > 0, "the scenario prints inside the inherited range");
    const original = root.eventAt(target) as EventCore;
    fork.setOverride(target, {
      event: {
        seq: target,
        vt: original.vt,
        kind: "TRADE",
        data: { ...(original.data as object), price: (original.data as { price: number }).price + 1 } as EventCore["data"],
      },
      note: "printed a tick higher",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    // Checkpoints at or before the edit are still valid; everything after it is
    // a statement about a history that no longer exists.
    assert.equal(fork.checkpointKeys().every((key) => key <= target), true, "later checkpoints dropped");

    const after = fork.state();
    assert.notEqual(after.digests.state, before.digests.state);
    assert.notEqual(after.digests.accounts, before.digests.accounts, "the money moved");
    assert.notEqual(after.fromCheckpoint, 300, "the edit point is replayed, not skipped");
  });
});

describe("counterfactual reports", () => {
  it("reports an impossible history instead of throwing", () => {
    const { session } = scenario();
    const root = session.root;
    // Suppress an order's placement while the events that depend on it stay in
    // the log: a perfectly ordinary edit, and a history that could not happen.
    const placed = root.resolved().find((event) => event.kind === "ORDER_PLACED") as EventCore;
    assert.ok(placed, "the scenario places orders");

    const report = runCounterfactual(session, {
      index: placed.seq,
      mode: "counterfactual",
      label: "the ticket was never placed",
      note: "suppress a placement",
      edit: {
        seq: placed.seq,
        vt: placed.vt,
        kind: "NOOP",
        data: { note: "suppressed", replacedKind: placed.kind },
      },
    });

    assert.equal(report.verdict, "impossible-history");
    assert.ok(report.failure, "the report carries the refusal");
    assert.match(report.failure.message, /unknown order/);
    assert.equal(report.legalLength, report.failure.seq, "every event before the refusal applied");
    assert.ok(report.legalLength < report.totalPositions, "the original future was not fully applicable");
    assert.match(report.headline, /stops being possible/);
  });

  it("flags a representable edit that silently corrupts the book", () => {
    const { session } = scenario();
    const root = session.root;
    // Shrinking a print is applicable — every event still applies, the cash and
    // share totals still balance — yet the resting order now says it sold more
    // than the print did. Only the invariant layer catches this.
    const trade = root.resolved().find((event) => event.kind === "TRADE") as EventCore;
    const report = runCounterfactual(session, {
      index: trade.seq,
      mode: "counterfactual",
      label: "the print was smaller",
      note: "shrink a print",
      edit: {
        seq: trade.seq,
        vt: trade.vt,
        kind: "TRADE",
        data: { ...(trade.data as object), qty: 10 } as EventCore["data"],
      },
    });

    assert.equal(report.verdict, "invariant-violation");
    assert.equal(report.failure, null, "the history itself is applicable");
    assert.equal(report.invariants?.ok, false);
    const broken = new Set(report.invariants?.violations.map((violation) => violation.invariant));
    assert.ok(broken.has("I7"), `expected the cached depth check to fire, got ${[...broken].join(", ")}`);
    assert.match(report.headline, /not a legal market/);
  });

  it("reports an invariant violation that is still a representable history", () => {
    const { session } = scenario();
    const root = session.root;
    // A cancel that forgets to give the escrow back: perfectly applicable.
    const cancel = root
      .resolved()
      .find((event) => event.kind === "ORDER_CANCELLED" && (event.data as { releasedCash: number }).releasedCash > 0);
    assert.ok(cancel, "the scenario should cancel a buy");

    const report = runCounterfactual(session, {
      index: cancel.seq,
      mode: "counterfactual",
      label: "escrow leak",
      note: "the cancel loses the money",
      edit: {
        seq: cancel.seq,
        vt: cancel.vt,
        kind: "ORDER_CANCELLED",
        data: { ...(cancel.data as object), releasedCash: 0 } as EventCore["data"],
      },
    });

    assert.equal(report.verdict, "invariant-violation");
    assert.equal(report.invariants?.ok, false);
    assert.equal(report.invariants?.violations[0]?.invariant, "I5");
    assert.match(report.headline, /I5/);
  });

  it("detects an edit that changes the path but not the destination", () => {
    const { session } = scenario();
    const root = session.root;
    const rejection = root.resolved().find((event) => event.kind === "ORDER_REJECTED");
    const target = rejection ?? (root.eventAt(root.length() - 1) as EventCore);

    const report = runCounterfactual(session, {
      index: target.seq,
      mode: "counterfactual",
      label: "no effect",
      note: "no effect",
      edit: {
        seq: target.seq,
        vt: target.vt,
        kind: "NOOP",
        data: { note: "dropped", replacedKind: target.kind },
      },
    });

    assert.ok(["no-effect", "legal-divergence"].includes(report.verdict));
    assert.ok(report.legalLength <= report.totalPositions);
  });
});

describe("divergence", () => {
  it("finds the first position where two timelines apply different events", () => {
    const { session } = scenario();
    const root = session.root;
    const fork = session.fork(root.id, 30, "branch");
    const original = root.eventAt(20) as EventCore;
    fork.setOverride(20, {
      event: { seq: 20, vt: original.vt, kind: "NOOP", data: { note: "gone", replacedKind: original.kind } },
      note: "gone",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    assert.equal(Timeline.firstEventDivergence(root, fork), 20);
    assert.equal(Timeline.firstStateDivergence(root, fork), 20);
    assert.equal(fork.provenanceOf(20), "fork-1-test-venue:20 (edited)");
    assert.equal(fork.provenanceOf(19), "root:19");
  });

  it("round-trips a fork recipe without touching the parent log", () => {
    const { session } = scenario();
    const root = session.root;
    const fork = session.fork(root.id, 25, "recipe test");
    fork.submit({ kind: "PLACE_ORDER", owner: "FUND", side: "BUY", price: 1_040, qty: 100, tif: "IOC" }, 5_000);
    fork.dropAt(10, "removed from history");

    const recipe = fork.recipe();
    const restored = Timeline.fromRecipe(recipe, session.config, root);
    assert.equal(restored.length(), fork.length());
    assert.equal(restored.state().digests.state, fork.state().digests.state);
    assert.equal(restored.overrideMap.size, 1);
  });
});

describe("reducer strictness", () => {
  it("refuses a log whose events do not follow from each other", () => {
    const { session } = scenario();
    const root = session.root;
    // Remove an order's placement but keep the events that depend on it: the
    // reducer must refuse rather than invent an order out of nowhere.
    const placed = root.resolved().find((event) => event.kind === "ORDER_PLACED");
    assert.ok(placed, "the scenario places orders");

    const fork = session.fork(root.id, root.length(), "corrupted branch");
    fork.setOverride(placed.seq, {
      event: { seq: placed.seq, vt: placed.vt, kind: "NOOP", data: { note: "lost", replacedKind: placed.kind } },
      note: "lost placement",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const failure = fork.replayCheck();
    assert.ok(failure, "replay should refuse the corrupted history");
    assert.match(failure.message, /unknown order/);

    // And evaluate() hands back the last legal position instead of exploding.
    const evaluation = fork.evaluate();
    assert.equal(evaluation.truncated, true);
    assert.equal(evaluation.failure?.seq, failure.seq);
    // `legalLength` is a count: the refusing event is not applied.
    assert.equal(evaluation.legalLength, failure.seq);
    assert.equal(failure.seq, placed.seq + 1, "the dependent event is the one that breaks");
  });

  it("keeps a healthy log replayable end to end", () => {
    const { session } = scenario();
    assert.equal(session.root.replayCheck(), null);
    assert.equal(session.root.evaluate().truncated, false);
  });
});
