/**
 * Tamper tooling: what a dishonest log looks like, and which checks notice.
 *
 * This exists because a hash chain is easy to *claim* and hard to demonstrate.
 * The tool rewrites one number in one event and writes two copies of the file:
 *
 *   - NAIVE — the payload is edited and the hashes are left alone. The chain
 *     check fails at exactly that position.
 *
 *   - FORGED — the payload is edited and every subsequent hash is recomputed,
 *     so the file is internally consistent and the chain check passes. What it
 *     cannot survive is the *anchor* line (which still names the original head)
 *     or the semantic layer: the reducer and the invariant monitor do not care
 *     how consistent the hashes are, only whether a market could have printed
 *     that tape.
 *
 * Nothing here touches the real log: the copies land in `data/tamper/`.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson } from "../core/canonical.ts";
import { applyEvent } from "../engine/reducer.ts";
import { monitorInvariants, type InvariantReport } from "../engine/invariants.ts";
import { createInitialState } from "../engine/state.ts";
import type { EventCore, SessionConfig } from "../engine/types.ts";
import { ensureDir, sessionLogPath, TAMPER_DIR } from "./paths.ts";
import {
  computeRecordHash,
  GENESIS_HASH,
  verifyLog,
  type LogEventRecord,
  type LogLine,
  type VerifyResult,
} from "./store.ts";
import { Timeline, type ReplayFailure } from "../timeline/timeline.ts";

export interface TamperReport {
  sessionId: string;
  seq: number;
  kind: string;
  field: string;
  before: unknown;
  after: unknown;
  /** What the naive edit looks like to the chain checker. */
  naive: { path: string; verify: VerifyResult };
  /** What a consistently rehashed forgery looks like to the same checker. */
  forged: { path: string; verify: VerifyResult };
  /** What both look like to the reducer and the invariant monitor. */
  semantic: {
    failure: ReplayFailure | null;
    legalLength: number;
    events: number;
    invariants: InvariantReport;
  } | null;
}

function readLines(filePath: string): LogLine[] {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as LogLine);
}

function writeLines(filePath: string, lines: readonly LogLine[]): void {
  writeFileSync(filePath, lines.map((line) => canonicalJson(line)).join("\n") + "\n", "utf8");
}

/**
 * Rewrite one numeric field of one event in a *copy* of the log, twice over.
 * `field` is a key of the event payload (`price`, `qty`, `releasedCash`, ...).
 */
export function tamperSession(
  sessionId: string,
  seq: number,
  field: string,
  after: unknown,
): TamperReport {
  const source = sessionLogPath(sessionId);
  const lines = readLines(source);
  const index = lines.findIndex((line) => line.type === "event" && line.seq === seq);
  if (index < 0) throw new Error(`no event #${seq} in ${source}`);

  const target = lines[index] as LogEventRecord;
  const before = (target.data as unknown as Record<string, unknown>)[field];
  (target.data as unknown as Record<string, unknown>)[field] = after;

  ensureDir(TAMPER_DIR);

  const naivePath = path.join(TAMPER_DIR, `${sessionId}.naive.jsonl`);
  writeLines(naivePath, lines);

  // The forgery: rebuild the chain from the edited record onwards, so every
  // hash in the file is genuine and the tail still verifies against the head.
  const forgedPath = path.join(TAMPER_DIR, `${sessionId}.forged.jsonl`);
  const forged: LogLine[] = lines.map((line) => ({ ...line }));
  let head = index > 0 ? ((lines[index - 1] as LogEventRecord).hash ?? GENESIS_HASH) : GENESIS_HASH;
  for (let i = index; i < forged.length; i++) {
    const line = forged[i] as LogEventRecord;
    if (line.type !== "event") continue;
    line.prevHash = head;
    line.hash = computeRecordHash(line);
    head = line.hash;
  }
  writeLines(forgedPath, forged);

  const naive = verifyLog(naivePath);
  const forgedVerify = verifyLog(forgedPath);

  // The semantic layer runs on the forgery, which is the harder case.
  const meta = lines.find((line) => line.type === "meta");
  const config = meta?.type === "meta" ? meta.session : null;
  const semantic = config ? semanticCheck(config, forgedVerify.records) : null;

  return {
    sessionId,
    seq,
    kind: target.kind,
    field,
    before,
    after,
    naive: { path: naivePath, verify: naive },
    forged: { path: forgedPath, verify: forgedVerify },
    semantic,
  };
}

/**
 * Replay a forged tape and ask the two questions the hash chain cannot:
 * does the reducer accept it, and was it ever a legal market?
 */
function semanticCheck(
  config: SessionConfig,
  events: readonly EventCore[],
): TamperReport["semantic"] {
  if (events.length === 0) return null;
  const timeline = new Timeline("tampered", "tampered copy", config, { own: [...events] });
  const evaluation = timeline.evaluate();
  const invariants = monitorInvariants(
    createInitialState(config),
    events.slice(0, evaluation.legalLength),
    { instrument: config.instrument },
    applyEvent,
  );
  return {
    failure: evaluation.failure,
    legalLength: evaluation.legalLength,
    events: events.length,
    invariants,
  };
}
