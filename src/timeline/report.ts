/**
 * The counterfactual report.
 *
 * One function that answers the question this whole project exists to ask:
 * *"what if that one thing had been different?"* — and answers it in four
 * layers, from cheapest to most expensive:
 *
 *   1. LEGALITY  — can the alternative history be applied at all? A rewrite
 *                  usually invalidates the original future a few events later,
 *                  and the reducer says exactly where and why.
 *   2. INVARIANTS — if it can be applied, was it a *legal market* at every step?
 *                  This is where a change that is representable but
 *                  economically impossible (a crossed book, broken reservation)
 *                  gets caught, with the position that broke it.
 *   3. DIVERGENCE — the structured state diff, so the answer is not just "it
 *                  differs" but whose money and how much.
 *   4. NARRATION  — the diff in sentences, because that is what a human reads.
 */

import { applyEvent } from "../engine/reducer.ts";
import { createInitialState, type StateDigests } from "../engine/state.ts";
import { describeEvent } from "../engine/describe.ts";
import { invariantName, monitorInvariants, type InvariantReport } from "../engine/invariants.ts";
import type { EventCore } from "../engine/types.ts";
import { diffStates, type StateDiff } from "./diff.ts";
import type { Session } from "./session.ts";
import type { ReplayFailure } from "./timeline.ts";

export type CounterfactualMode = "branch" | "counterfactual";

export type Verdict =
  /** The alternative history is legal and ends in exactly the same state. */
  | "no-effect"
  /** Legal, invariant-clean, and it ends somewhere else. The interesting case. */
  | "legal-divergence"
  /** The original future cannot be applied on top of the edit. */
  | "impossible-history"
  /** Applicable, but some invariant breaks — a market that could not exist. */
  | "invariant-violation";

export interface CounterfactualReport {
  sessionId: string;
  timelineId: string;
  label: string;
  note: string;
  mode: CounterfactualMode;
  index: number;
  original: EventCore;
  originalSummary: string;
  replacement: EventCore | null;
  replacementSummary: string;
  verdict: Verdict;
  headline: string;
  /** Positions that could be applied under the edit. */
  legalLength: number;
  totalPositions: number;
  failure: ReplayFailure | null;
  invariants: InvariantReport | null;
  diff: StateDiff;
  digests: { baseline: StateDigests; alternative: StateDigests };
  baselineAt: number;
  alternativeAt: number;
  elapsedMs: number;
}

export interface CounterfactualSpec {
  index: number;
  mode: CounterfactualMode;
  label: string;
  note: string;
  /** Replacement payload fields, or null to mean "this event never happened". */
  edit: EventCore | null;
}

export function runCounterfactual(session: Session, spec: CounterfactualSpec): CounterfactualReport {
  const started = performance.now();
  const original = session.root.eventAt(spec.index);
  if (!original) throw new Error(`no event at position ${spec.index}`);

  const fork =
    spec.mode === "counterfactual"
      ? session.counterfactual(session.root.id, spec.index, spec.label, spec.edit, spec.note)
      : session.branchAt(session.root.id, spec.index + 1, spec.label, {
          index: spec.index,
          event: spec.edit,
          note: spec.note,
        });

  const evaluation = fork.evaluate();
  const events = fork.resolved();

  // Layer 2. Only fold the part of the alternative that is representable at all
  // — asking whether an impossible history upheld its invariants is meaningless.
  const monitor = monitorInvariants(
    createInitialState(session.config),
    events.slice(0, evaluation.legalLength),
    { instrument: session.config.instrument },
    applyEvent,
  );

  const baseline = session.root.state();
  const diff = diffStates(baseline.state, evaluation.state);
  const verdict = decideVerdict(evaluation.failure, monitor, diff);
  const headline = headlineFor(verdict, evaluation, monitor, diff, spec);

  return {
    sessionId: session.config.id,
    timelineId: fork.id,
    label: spec.label,
    note: spec.note,
    mode: spec.mode,
    index: spec.index,
    original,
    originalSummary: describeEvent(original),
    replacement: spec.edit,
    replacementSummary: spec.edit ? describeEvent(spec.edit) : "NOOP — this never happened",
    verdict,
    headline,
    legalLength: evaluation.legalLength,
    totalPositions: fork.length(),
    failure: evaluation.failure,
    invariants: monitor,
    diff,
    digests: { baseline: baseline.digests, alternative: evaluation.digests },
    baselineAt: baseline.k,
    alternativeAt: evaluation.legalLength,
    elapsedMs: performance.now() - started,
  };
}

function decideVerdict(
  failure: ReplayFailure | null,
  monitor: InvariantReport,
  diff: StateDiff,
): Verdict {
  if (failure) return "impossible-history";
  if (!monitor.ok) return "invariant-violation";
  return diff.identical ? "no-effect" : "legal-divergence";
}

function headlineFor(
  verdict: Verdict,
  evaluation: { legalLength: number; failure: ReplayFailure | null },
  monitor: InvariantReport,
  diff: StateDiff,
  spec: CounterfactualSpec,
): string {
  switch (verdict) {
    case "impossible-history": {
      const failure = evaluation.failure as ReplayFailure;
      return `The alternative history stops being possible at #${failure.seq} (${failure.kind}): ${failure.message}. Everything after that assumed something this edit removed.`;
    }
    case "invariant-violation": {
      const first = monitor.violations[0];
      const count = monitor.violations.length;
      return first
        ? `The alternative history survives to #${evaluation.legalLength}, but it is not a legal market: ${first.invariant} ${invariantName(
            first.invariant,
          )} breaks at #${first.atSeq} (${first.subject}) — ${first.detail}${
            count > 1 ? `, plus ${count - 1} more` : ""
          }.`
        : `The alternative history breaks ${count} invariants.`;
    }
    case "no-effect":
      return "Applying the edit changes nothing at all: different path, identical destination.";
    case "legal-divergence": {
      const narration = diff.narration[0] ?? "The two histories end in different states.";
      return `${spec.mode === "branch" ? "Branch" : "Replay"} stays legal and diverges: ${narration}`;
    }
    default:
      return "";
  }
}

/* ------------------------------------------------------- prepared experiments */

export interface ExperimentResult {
  spec: CounterfactualSpec;
  report: CounterfactualReport;
}

/**
 * Run every prepared experiment for a session. Used by the CLI's `experiments`
 * command and by the UI's experiment list, so both tell the same story.
 */
export function runExperiments(
  session: Session,
  specs: readonly CounterfactualSpec[],
): ExperimentResult[] {
  return specs.map((spec) => ({ spec, report: runCounterfactual(session, spec) }));
}
