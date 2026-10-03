#!/usr/bin/env node
/**
 * Chronofork CLI.
 *
 *   seed           generate every scenario and write its hash-chained log
 *   verify         chain + replay + invariants for one or all sessions
 *   bench          measure replay throughput, checkpoint reuse and fork cost
 *   replay         print the market at a given position of a session
 *   counterfactual run a prepared or ad-hoc fork and print the report
 *   sessions       list what is on disk
 *
 * Zero dependencies, so it is safe to run anywhere Node 22.6+ exists.
 */

import { buildScenario, SCENARIOS, scenarioById } from "./sim/scenarios.ts";
import type { Simulator } from "./sim/simulator.ts";
import { saveInterest, loadInterest } from "./sim/interest.ts";
import { Session } from "./timeline/session.ts";
import { runCounterfactual } from "./timeline/report.ts";
import {
  describeEvent,
  formatClock,
  formatMoney,
  formatQty,
  formatPrice,
} from "./engine/describe.ts";
import { reduceAll } from "./engine/reducer.ts";
import { createInitialState, digests } from "./engine/state.ts";
import { listSessionIds } from "./log/paths.ts";
import type { EventCore } from "./engine/types.ts";

interface Args {
  command: string;
  positional: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: readonly string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      // Split on the FIRST '=' only: `--patch=price=2400` must keep `price=2400`
      // intact as the value, or the patch silently becomes empty.
      const rest = arg.slice(2);
      const eq = rest.indexOf("=");
      const key = eq === -1 ? rest : rest.slice(0, eq);
      const value = eq === -1 ? undefined : rest.slice(eq + 1);
      if (key.length > 0) flags.set(key, value ?? true);
    } else {
      positional.push(arg);
    }
  }
  return { command: positional.shift() ?? "help", positional, flags };
}

function flagString(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function flagNumber(args: Args, name: string): number | undefined {
  const value = flagString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const rule = (label = ""): string =>
  label.length > 0
    ? `\n\u001b[1m── ${label} ${"─".repeat(Math.max(0, 58 - label.length))}\u001b[0m`
    : `─`.repeat(62);

interface RefusalTally {
  total: number;
  byReason: Array<[string, number]>;
}

/** How many orders the venue refused, broken down by reason. */
function countRefusals(events: readonly EventCore[]): RefusalTally {
  const counts = new Map<string, number>();
  let total = 0;
  for (const event of events) {
    if (event.kind !== "ORDER_REJECTED" && event.kind !== "CANCEL_REJECTED") continue;
    const reason = String((event.data as { reason?: string }).reason ?? "UNKNOWN");
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    total += 1;
  }
  return { total, byReason: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
}

/* ------------------------------------------------------------------- seed */

function commandSeed(args: Args): number {
  const only = args.positional[0];
  const scenarios = only ? SCENARIOS.filter((s) => s.id === only) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`no scenario '${only}'. Available: ${SCENARIOS.map((s) => s.id).join(", ")}`);
    return 1;
  }

  for (const scenario of scenarios) {
    const started = performance.now();
    const built = buildScenario(scenario);
    const generated = performance.now();
    const persisted = built.session.persist();
    const finished = performance.now();
    saveInterest(scenario.id, built.interest);

    const tip = built.session.root.state();
    const refusals = countRefusals(built.session.root.resolved());
    console.log(rule(scenario.id));
    console.log(`  ${scenario.tagline}`);
    console.log(
      `  events      ${persisted.events} (${built.session.root.overrideMap.size} overrides, ${built.interest.length} fork points)`,
    );
    console.log(
      `  refusals    ${refusals.total}  ${
        refusals.byReason.length > 0
          ? refusals.byReason.map(([reason, count]) => `${reason}×${count}`).join(", ")
          : "none"
      }`,
    );
    console.log(
      `  prints      ${tip.state.stats.tradeCount} trades, ${formatQty(tip.state.stats.volume)} shares, last ${formatPrice(tip.state.stats.lastPrice)}`,
    );
    console.log(`  book        ${tip.state.bids.length} bid levels / ${tip.state.asks.length} ask levels`);
    console.log(`  head        ${persisted.headHash.slice(0, 24)}…`);
    console.log(`  log         ${persisted.path}`);
    console.log(
      `  time        generated in ${(generated - started).toFixed(0)}ms, persisted in ${(finished - generated).toFixed(0)}ms`,
    );
    const verification = built.session.verify();
    console.log(
      `  verified    chain ${verification.chain.ok ? "\u001b[32mok\u001b[0m" : "\u001b[31mFAIL\u001b[0m"}, replay ${
        verification.replay ? "\u001b[31mFAIL\u001b[0m" : "\u001b[32mok\u001b[0m"
      }, invariants ${verification.invariants.ok ? "\u001b[32mok\u001b[0m" : "\u001b[31mFAIL\u001b[0m"} over ${verification.invariants.eventsChecked} events`,
    );
    console.log(`  forks       ${built.interest.map((point) => `${point.mode}:${point.label}`).join(" | ")}`);
  }
  console.log(rule());
  return 0;
}

/* ----------------------------------------------------------------- verify */

function commandVerify(args: Args): number {
  const ids = args.positional.length > 0 ? args.positional : listSessionIds();
  if (ids.length === 0) {
    console.error("nothing seeded yet — run `npm run seed` first");
    return 1;
  }
  let failures = 0;
  for (const id of ids) {
    const session = Session.load(id);
    const full = session.verify();
    const ok = full.ok;
    if (!ok) failures += 1;
    console.log(
      `${ok ? "\u001b[32mPASS\u001b[0m" : "\u001b[31mFAIL\u001b[0m"}  ${id.padEnd(18)} ${String(full.chain.events).padStart(5)} events  head ${full.chain.headHash.slice(0, 16)}…`,
    );
    for (const check of full.chain.checks) {
      if (!check.ok) console.log(`        \u001b[31m✗\u001b[0m ${check.name}: ${check.detail}`);
    }
    if (full.replay) {
      console.log(`        \u001b[31m✗\u001b[0m replay broke at #${full.replay.seq} (${full.replay.kind}): ${full.replay.message}`);
    }
    for (const violation of full.invariants.violations.slice(0, 6)) {
      console.log(
        `        \u001b[31m✗\u001b[0m ${violation.invariant} at #${violation.atSeq} ${violation.subject}: ${violation.detail}`,
      );
    }
    if (ok) {
      const verdicts = full.invariants.verdicts.length;
      console.log(`        ${verdicts} invariants held at every one of ${full.invariants.eventsChecked} events`);
    }
  }
  console.log(
    `\n${ids.length - failures}/${ids.length} sessions verified${failures > 0 ? " \u001b[31m(some failed)\u001b[0m" : ""}`,
  );
  return failures === 0 ? 0 : 1;
}

/* ------------------------------------------------------------------ bench */

function commandBench(args: Args): number {
  const steps = flagNumber(args, "steps") ?? 400;
  const scenario = scenarioById(flagString(args, "scenario") ?? "volatile-session");
  if (!scenario) {
    console.error("unknown scenario");
    return 1;
  }

  const big = { ...scenario, id: `bench-${scenario.id}`, seed: scenario.seed ^ 0x5f5f, label: "bench" };
  console.log(rule("generate"));
  const started = performance.now();
  const built = buildScenario({ ...big, run: stressRun(steps) });
  const generatedMs = performance.now() - started;
  const events = built.session.root.resolved();
  const stateBytes = JSON.stringify(built.session.root.state().state).length;
  console.log(`  ${events.length} events generated in ${generatedMs.toFixed(0)}ms`);
  console.log(`  state at tip: ${(stateBytes / 1024).toFixed(0)} KB, digest ${digests(built.session.root.state().state).state.slice(0, 16)}…`);

  console.log(rule("replay from genesis"));
  const initialState = createInitialState(built.config);
  const replayStart = performance.now();
  const replayed = reduceAll(initialState, events);
  const replayMs = performance.now() - replayStart;
  console.log(
    `  ${events.length} events in ${replayMs.toFixed(1)}ms = ${(events.length / (replayMs / 1000)).toFixed(0)} events/sec`,
  );
  console.log(`  state digest after replay: ${digests(replayed).state.slice(0, 16)}…`);
  if (digests(replayed).state !== digests(built.session.root.state().state).state) {
    console.log("  \u001b[31mREPLAY DIVERGED\u001b[0m");
    return 1;
  }

  console.log(rule("materialize a mid-history point"));
  const target = Math.floor(events.length * 0.75);
  const first = built.session.root.stateAt(target);
  console.log(
    `  #${target}: replayed ${first.eventsReplayed} events (checkpoint #${first.fromCheckpoint}), seeding from checkpoint ${built.session.root.checkpointKeys().length} available`,
  );
  const second = built.session.root.stateAt(target + 1);
  console.log(`  next position: replayed ${second.eventsReplayed} events — sequential scrub is O(1)`);
  const cacheAfter = built.session.root.stats;
  console.log(
    `  cache: ${cacheAfter.checkpointHits} hits / ${cacheAfter.checkpointMisses} misses, ${cacheAfter.eventsReplayed} events replayed in total`,
  );

  console.log(rule("fork cost"));
  const forkStart = performance.now();
  const fork = built.session.fork("root", Math.floor(events.length / 2), "bench fork");
  const forkCreatedMs = performance.now() - forkStart;
  const materializeStart = performance.now();
  const forkState = fork.state();
  const forkMaterializeMs = performance.now() - materializeStart;
  console.log(`  fork object created in ${(forkCreatedMs * 1000).toFixed(0)}µs (no event copying)`);
  console.log(
    `  state at fork tip materialized in ${forkMaterializeMs.toFixed(1)}ms, replaying ${forkState.eventsReplayed} events`,
  );
  console.log(`  fork shares ${fork.checkpointKeys().length} checkpoints with its parent`);
  console.log(`  recipe size on disk: ${JSON.stringify(fork.recipe()).length} bytes`);
  console.log(rule());
  return 0;
}

function stressRun(steps: number): (sim: Simulator) => void {
  return (sim) => {
    sim.fundAll();
    for (let i = 0; i < steps; i++) {
      sim.advance(sim.rng.int(50, 250));
      if (i % 3 === 0) {
        const target = 2400 + sim.rng.int(-40, 40);
        for (const owner of ["MM1", "MM2"]) {
          for (const orderId of sim.openOrderIds(owner)) sim.cancel(owner, orderId);
          sim.place(owner, "BUY", target - sim.rng.int(1, 4), sim.rng.int(2, 10) * 10, "GTC", { ttlMs: 20_000 });
          sim.place(owner, "SELL", target + sim.rng.int(1, 4), sim.rng.int(2, 10) * 10, "GTC", { ttlMs: 20_000 });
        }
      }
      if (i % 5 === 1) {
        const side = sim.rng.chance(0.5) ? "BUY" : "SELL";
        sim.place("ALGO", side, sim.mid() + (side === "BUY" ? 9 : -9), sim.rng.int(1, 8) * 10, "IOC");
      }
      if (i % 11 === 3) sim.place("RETAIL", "BUY", sim.mid() - 12, 10, "IOC");
    }
    sim.closeSession("bench close");
  };
}

/* ----------------------------------------------------------------- replay */

function commandReplay(args: Args): number {
  const sessionId = args.positional[0];
  if (!sessionId) {
    console.error("usage: replay <sessionId> [--at=N]");
    return 1;
  }
  const session = Session.load(sessionId);
  const at = flagNumber(args, "at") ?? session.root.length();
  const materialized = session.root.stateAt(at);
  const state = materialized.state;

  console.log(rule(`${sessionId} @ #${at}`));
  console.log(`  virtual clock   ${formatClock(state.vt)}  (session ${state.sessionIndex}, ${state.session})`);
  console.log(`  digest          ${materialized.digests.state}`);
  console.log(`  book            best bid ${formatPrice(state.bids[0]?.price)} x ${formatQty(state.bids[0]?.totalQty)}, best ask ${formatPrice(state.asks[0]?.price)} x ${formatQty(state.asks[0]?.totalQty)}`);
  console.log(`  prints          ${state.stats.tradeCount}, volume ${formatQty(state.stats.volume)}, last ${formatPrice(state.stats.lastPrice)}`);
  for (const account of Object.values(state.accounts)) {
    console.log(
      `  ${account.owner.padEnd(8)} cash ${formatMoney(account.cash).padStart(12)} (+${formatMoney(account.reservedCash)} reserved)  pos ${formatQty(account.positions).padStart(7)} (+${formatQty(account.reservedShares)} reserved)`,
    );
  }
  const events = session.root.resolved();
  const from = Math.max(0, at - 8);
  console.log(rule("last events"));
  for (const event of events.slice(from, at)) {
    console.log(`  #${String(event.seq).padStart(5)} ${event.kind.padEnd(16)} ${describeEvent(event)}`);
  }
  return 0;
}

/* --------------------------------------------------------- counterfactual */

const VERDICT_COLOUR: Record<string, string> = {
  "no-effect": "\u001b[90m",
  "legal-divergence": "\u001b[32m",
  "impossible-history": "\u001b[33m",
  "invariant-violation": "\u001b[31m",
};

function printReport(report: ReturnType<typeof runCounterfactual>): void {
  const colour = VERDICT_COLOUR[report.verdict] ?? "";
  console.log(rule(report.label));
  console.log(`  position     #${report.index}  ${report.original.kind}`);
  console.log(`  original     ${report.originalSummary}`);
  console.log(`  replacement  ${report.replacementSummary}`);
  console.log(`  mode         ${report.mode}  (${report.legalLength} of ${report.totalPositions} positions applied)`);
  console.log(`  verdict      ${colour}${report.verdict}\u001b[0m`);
  console.log(`\n  ${report.headline}`);

  if (report.invariants) {
    const broken = report.invariants.verdicts.filter((verdict) => verdict.firstViolationSeq !== null);
    console.log(
      `\n  invariants   ${report.invariants.verdicts.length - broken.length}/${report.invariants.verdicts.length} held${
        broken.length > 0 ? `  \u001b[31mbroken: ${broken.map((v) => `${v.id} ${v.name} @ #${v.firstViolationSeq}`).join(", ")}\u001b[0m` : ` across ${report.invariants.eventsChecked} events`
      }`,
    );
  }

  console.log(rule("what changed"));
  for (const line of report.diff.narration) console.log(`  • ${line}`);
  console.log(
    `  digests      book ${report.diff.digests.bookEqual ? "same" : "different"}, accounts ${
      report.diff.digests.accountsEqual ? "same" : "different"
    }, orders ${report.diff.digests.ordersEqual ? "same" : "different"}`,
  );
  if (report.diff.accounts.length > 0) {
    console.log(rule("accounts"));
    for (const account of report.diff.accounts.slice(0, 6)) {
      console.log(
        `  ${account.owner.padEnd(8)} cash ${(account.cashDelta >= 0 ? "+" : "") + formatMoney(account.cashDelta)}   shares ${
          account.positionsDelta >= 0 ? "+" : ""
        }${formatQty(account.positionsDelta)}`,
      );
    }
  }
  console.log(`  \u001b[90mcomputed in ${report.elapsedMs.toFixed(0)}ms\u001b[0m`);
}

function parsePatch(patchArg: string | undefined): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const pair of (patchArg ?? "").split(",").filter((part) => part.length > 0)) {
    const [key, raw] = pair.split("=");
    if (key === undefined || raw === undefined) continue;
    patch[key] = Number.isFinite(Number(raw)) ? Number(raw) : raw;
  }
  return patch;
}

function commandCounterfactual(args: Args): number {
  const sessionId = args.positional[0];
  const seq = flagNumber(args, "seq");
  if (!sessionId || seq === undefined) {
    console.error(
      "usage: counterfactual <sessionId> --seq=N [--drop] [--patch=field=value,...] [--mode=branch|counterfactual]",
    );
    return 1;
  }
  const mode = (flagString(args, "mode") ?? "counterfactual") as "branch" | "counterfactual";
  const drop = args.flags.get("drop") === true;
  const patch = parsePatch(flagString(args, "patch"));

  const session = Session.load(sessionId);
  const original = session.root.eventAt(seq);
  if (!original) {
    console.error(`no event at #${seq}`);
    return 1;
  }

  const edit: EventCore | null = drop
    ? null
    : {
        seq: original.seq,
        vt: original.vt,
        kind: original.kind,
        data: { ...(original.data as unknown as Record<string, unknown>), ...patch } as unknown as EventCore["data"],
      };

  const report = runCounterfactual(session, {
    index: seq,
    mode,
    label: `ad-hoc experiment at #${seq}`,
    note: flagString(args, "note") ?? `manual counterfactual at #${seq}`,
    edit,
  });
  printReport(report);
  return report.verdict === "invariant-violation" || report.verdict === "impossible-history" ? 0 : 0;
}

/** Run every prepared experiment — the batch version of the command above. */
function commandExperiments(args: Args): number {
  const ids = args.positional.length > 0 ? args.positional : listSessionIds();
  let divergent = 0;
  for (const id of ids) {
    const points = loadInterest(id);
    if (points.length === 0) continue;
    const session = Session.load(id);
    console.log(rule(`${id} — ${points.length} prepared experiments`));
    for (const point of points) {
      const original = session.root.eventAt(point.seq);
      if (!original) {
        console.log(`  \u001b[31m✗ #${point.seq} missing from the log\u001b[0m`);
        continue;
      }
      const edit = point.edit.drop
        ? null
        : {
            seq: original.seq,
            vt: original.vt,
            kind: original.kind,
            data: {
              ...(original.data as unknown as Record<string, unknown>),
              ...(point.edit.patch ?? {}),
            } as unknown as EventCore["data"],
          };
      const report = runCounterfactual(session, {
        index: point.seq,
        mode: point.mode,
        label: point.label,
        note: point.why,
        edit,
      });
      const colour = VERDICT_COLOUR[report.verdict] ?? "";
      if (report.verdict === "legal-divergence") divergent += 1;
      console.log(
        `  ${colour}${report.verdict.padEnd(20)}\u001b[0m #${String(point.seq).padStart(5)}  ${point.label}`,
      );
      console.log(`                        ${report.headline.slice(0, 150)}`);
    }
  }
  console.log(rule());
  console.log(`${divergent} of the prepared experiments produce a legal, different history.`);
  return 0;
}

/* --------------------------------------------------------------- sessions */

function commandSessions(): number {
  const ids = listSessionIds();
  if (ids.length === 0) {
    console.log("no sessions yet — run `npm run seed`");
    return 0;
  }
  for (const id of ids) {
    const session = Session.load(id);
    const interest = loadInterest(id);
    console.log(
      `${id.padEnd(20)} ${String(session.root.length()).padStart(6)} events  ${String(interest.length).padStart(2)} fork points  ${session.config.label}`,
    );
  }
  return 0;
}

/* ------------------------------------------------------------------ entry */

function help(): void {
  console.log(`chronofork — deterministic exchange with counterfactual replay

  npm run seed                     generate every scenario and write its log
  npm run verify                   chain + replay + invariants for every session
  npm run bench                    replay throughput, checkpoint reuse, fork cost
  npm run replay -- <session>      print the market at a position (--at=N)
  npm run counterfactual -- <session> --seq=N [--drop] [--patch=price=2400] [--mode=branch]

  node src/cli.ts sessions         list what is on disk
  node src/cli.ts experiments      run every prepared counterfactual and grade it
`);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  let code = 0;
  switch (args.command) {
    case "seed":
      code = commandSeed(args);
      break;
    case "verify":
      code = commandVerify(args);
      break;
    case "bench":
      code = commandBench(args);
      break;
    case "replay":
      code = commandReplay(args);
      break;
    case "counterfactual":
      code = commandCounterfactual(args);
      break;
    case "experiments":
      code = commandExperiments(args);
      break;
    case "sessions":
      code = commandSessions();
      break;
    case "help":
    default:
      help();
      break;
  }
  process.exitCode = code;
}

main();
