/**
 * Append-only, hash-chained event log.
 *
 * Layout (one JSON object per line):
 *
 *     {"type":"meta",   session: {...}, format: "chronofork/1", createdAt: "..."}
 *     {"type":"event",  seq, vt, kind, data, prevHash, hash}
 *     {"type":"event",  ...}
 *     {"type":"anchor", events: N, headHash: "...", at: "..."}    (optional)
 *
 * `hash = sha256(canonicalJson({ seq, vt, kind, data, prevHash }))`, so any edit
 * to any field of any event breaks that line and every line after it. The
 * optional anchor line records the expected head, which catches the *other*
 * classic tamper — truncating the tail off a log. Nothing here is a blockchain:
 * there is no consensus, just a chain and a manifest.
 *
 * What this can and cannot do, stated plainly: an attacker who can rewrite the
 * whole file (including the anchor) can forge a consistent chain. That is why
 * every fork and every verification also runs a *semantic* replay through the
 * reducer and the invariant checker — a forged history still has to describe a
 * market that could actually have existed.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { canonicalJson } from "../core/canonical.ts";
import { sha256Hex } from "../core/hash.ts";
import type { EventCore, EventData, EventKind, SessionConfig } from "../engine/types.ts";

export const LOG_FORMAT = "chronofork/1";

export interface LogMeta {
  type: "meta";
  format: string;
  createdAt: string;
  session: SessionConfig;
}

export interface LogEventRecord {
  type: "event";
  seq: number;
  vt: number;
  kind: EventKind;
  data: EventData;
  prevHash: string;
  hash: string;
}

export interface LogAnchorRecord {
  type: "anchor";
  events: number;
  headHash: string;
  at: string;
}

export type LogLine = LogMeta | LogEventRecord | LogAnchorRecord;

export interface ChainCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  sessionId: string | null;
  events: number;
  headHash: string;
  checks: ChainCheck[];
  failedSeq: number | null;
  records: EventCore[];
}

/** Genesis value for the chain. Every log starts from the same well-known head. */
export const GENESIS_HASH = sha256Hex("chronofork/genesis");

export function computeRecordHash(record: {
  seq: number;
  vt: number;
  kind: EventKind;
  data: EventData;
  prevHash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      seq: record.seq,
      vt: record.vt,
      kind: record.kind,
      data: record.data,
      prevHash: record.prevHash,
    }),
  );
}

export class EventLogStore {
  readonly path: string;
  readonly session: SessionConfig;
  #head: string = GENESIS_HASH;
  #count = 0;
  #anchored = false;

  constructor(session: SessionConfig, filePath: string) {
    this.session = session;
    this.path = filePath;
  }

  get headHash(): string {
    return this.#head;
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Continue an existing chain instead of a fresh one. Used when a server
   * reloads a session and keeps appending to it: the next event's `prevHash`
   * must be the hash already on disk, or the log would verify as tampered.
   */
  adoptHead(headHash: string, count: number): void {
    this.#head = headHash;
    this.#count = count;
    this.#anchored = false;
  }

  /** Create (or truncate) the log with its meta line. */
  create(nowIso: string): void {
    const meta: LogMeta = {
      type: "meta",
      format: LOG_FORMAT,
      createdAt: nowIso,
      session: this.session,
    };
    writeFileSync(this.path, canonicalJson(meta) + "\n", "utf8");
    this.#head = GENESIS_HASH;
    this.#count = 0;
    this.#anchored = false;
  }

  append(events: readonly EventCore[]): LogEventRecord[] {
    if (events.length === 0) return [];
    if (events[0]!.seq !== this.#count) {
      throw new Error(
        `refusing to append event #${events[0]!.seq} after ${this.#count} events: the chain would have a hole`,
      );
    }
    const lines: string[] = [];
    const records: LogEventRecord[] = [];
    for (const event of events) {
      const record: LogEventRecord = {
        type: "event",
        seq: event.seq,
        vt: event.vt,
        kind: event.kind,
        data: event.data,
        prevHash: this.#head,
        hash: "",
      };
      record.hash = computeRecordHash(record);
      this.#head = record.hash;
      this.#count += 1;
      lines.push(canonicalJson(record));
      records.push(record);
    }
    appendFileSync(this.path, lines.join("\n") + "\n", "utf8");
    this.#anchored = false;
    return records;
  }

  /**
   * Write the manifest line. Callers do this when a session is sealed; the UI
   * also exposes it as a "seal session" action.
   */
  anchor(nowIso: string): LogAnchorRecord {
    const anchor: LogAnchorRecord = {
      type: "anchor",
      events: this.#count,
      headHash: this.#head,
      at: nowIso,
    };
    appendFileSync(this.path, canonicalJson(anchor) + "\n", "utf8");
    this.#anchored = true;
    return anchor;
  }

  get anchored(): boolean {
    return this.#anchored;
  }
}

/* --------------------------------------------------------------- reading */

export interface LoadedLog {
  meta: LogMeta | null;
  events: EventCore[];
  anchor: LogAnchorRecord | null;
  lines: string[];
  truncated: boolean;
}

export function loadLog(filePath: string): LoadedLog {
  if (!existsSync(filePath)) {
    return { meta: null, events: [], anchor: null, lines: [], truncated: false };
  }
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim().length > 0);

  let meta: LogMeta | null = null;
  let anchor: LogAnchorRecord | null = null;
  const events: EventCore[] = [];
  let truncated = false;

  for (const line of lines) {
    let parsed: LogLine;
    try {
      parsed = JSON.parse(line) as LogLine;
    } catch {
      // A half-written final line is the signature of a crash mid-append.
      truncated = true;
      continue;
    }
    if (parsed.type === "meta") meta = parsed;
    else if (parsed.type === "anchor") anchor = parsed;
    else if (parsed.type === "event") {
      events.push({ seq: parsed.seq, vt: parsed.vt, kind: parsed.kind, data: parsed.data });
    }
  }

  return { meta, events, anchor, lines, truncated };
}

/**
 * Verify a log without replaying it: chain, contiguity, monotonic time, anchor.
 * `verifySession` in the CLI layers a semantic replay on top of this.
 */
export function verifyLog(filePath: string): VerifyResult {
  const checks: ChainCheck[] = [];
  const loaded = loadLog(filePath);
  const events = loaded.events;
  let failedSeq: number | null = null;

  checks.push({
    name: "meta present",
    ok: loaded.meta !== null,
    detail: loaded.meta ? `session '${loaded.meta.session.id}' written ${loaded.meta.createdAt}` : "no meta line",
  });
  checks.push({
    name: "no truncated tail",
    ok: !loaded.truncated,
    detail: loaded.truncated ? "final line is not valid JSON (partial write?)" : "every line parsed",
  });

  // Recompute the chain straight from the raw records.
  const rawRecords: LogEventRecord[] = [];
  for (const line of loaded.lines) {
    try {
      const parsed = JSON.parse(line) as LogLine;
      if (parsed.type === "event") rawRecords.push(parsed);
    } catch {
      // already reported as a truncated tail
    }
  }

  let head = GENESIS_HASH;
  let chainOk = true;
  let contiguous = true;
  let monotonic = true;
  let canonical = true;

  rawRecords.forEach((record, index) => {
    if (record.seq !== index) {
      contiguous = false;
      failedSeq ??= record.seq;
    }
    if (index > 0 && record.vt < (rawRecords[index - 1]?.vt ?? 0)) {
      monotonic = false;
      failedSeq ??= record.seq;
    }
    if (record.prevHash !== head) {
      chainOk = false;
      failedSeq ??= record.seq;
    }
    const recomputed = computeRecordHash(record);
    if (recomputed !== record.hash) {
      chainOk = false;
      failedSeq ??= record.seq;
    }
    if (canonicalJson(record) !== JSON.stringify(record)) {
      canonical = false;
    }
    head = record.hash;
  });

  checks.push({
    name: "sequence is contiguous",
    ok: contiguous,
    detail: contiguous ? `${rawRecords.length} events, 0..${rawRecords.length - 1}` : "a seq is missing, duplicated or reordered",
  });
  checks.push({
    name: "virtual time is monotonic",
    ok: monotonic,
    detail: monotonic ? "vt never decreases" : "vt went backwards",
  });
  checks.push({
    name: "sha256 chain intact",
    ok: chainOk,
    detail: chainOk ? `head ${head.slice(0, 16)}…` : "recomputed hash does not match the recorded one",
  });
  checks.push({
    name: "records are canonical",
    ok: canonical,
    detail: canonical ? "every line is in canonical form" : "key order or spacing changed on disk",
  });

  if (loaded.anchor) {
    const anchorOk = loaded.anchor.headHash === head && loaded.anchor.events === rawRecords.length;
    checks.push({
      name: "anchor manifest matches",
      ok: anchorOk,
      detail: anchorOk
        ? `sealed at ${loaded.anchor.events} events`
        : `anchor says ${loaded.anchor.events}/${loaded.anchor.headHash.slice(0, 12)}…, file has ${rawRecords.length}/${head.slice(0, 12)}…`,
    });
  } else {
    checks.push({
      name: "anchor manifest matches",
      ok: true,
      detail: "not sealed (no anchor line) — expected head is whatever the file ends with",
    });
  }

  const ok = checks.every((check) => check.ok);
  return {
    ok,
    sessionId: loaded.meta?.session.id ?? null,
    events: rawRecords.length,
    headHash: head,
    checks,
    failedSeq: ok ? null : failedSeq,
    records: events,
  };
}
