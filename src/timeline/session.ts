/**
 * A session: one root log, its forks, and the disk on either side.
 *
 * The root timeline mirrors the persisted log one-for-one. Forks live in memory
 * and are persisted as *recipes* — parent pointer, fork position, overrides and
 * the suffix of events the branch added. A fork of a 50,000 event session is a
 * few hundred bytes on disk, which is the whole point of structural sharing.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { canonicalJson } from "../core/canonical.ts";
import {
  EventLogStore,
  loadLog,
  verifyLog,
  type VerifyResult,
} from "../log/store.ts";
import { ensureDir, SESSIONS_DIR, sessionForksPath, sessionLogPath } from "../log/paths.ts";
import { createInitialState } from "../engine/state.ts";
import { applyEvent } from "../engine/reducer.ts";
import { monitorInvariants, type InvariantReport } from "../engine/invariants.ts";
import type { Command, EventCore, SessionConfig } from "../engine/types.ts";
import { makeNoop, Timeline, type ReplayFailure, type TimelineRecipe } from "./timeline.ts";

export interface TimelineNode {
  id: string;
  label: string;
  parentId: string | null;
  forkPoint: number | null;
  tip: number;
  overrides: number;
  ownEvents: number;
  note: string;
  createdAt: string;
}

export interface SessionVerification {
  chain: VerifyResult;
  replay: ReplayFailure | null;
  invariants: InvariantReport;
  ok: boolean;
}

export class Session {
  readonly config: SessionConfig;
  readonly root: Timeline;
  #timelines = new Map<string, Timeline>();
  #store: EventLogStore | null = null;
  #forkCounter = 0;

  private constructor(config: SessionConfig, root: Timeline) {
    this.config = config;
    this.root = root;
    this.#timelines.set(root.id, root);
  }

  /** A brand new, empty session (no events yet). */
  static create(config: SessionConfig): Session {
    const root = new Timeline("root", "original run", config);
    return new Session(config, root);
  }

  /** Load a session from a sealed or live log file, including its forks. */
  static load(sessionId: string): Session {
    const logPath = sessionLogPath(sessionId);
    const loaded = loadLog(logPath);
    if (!loaded.meta) throw new Error(`no meta line in ${logPath}`);
    const config = loaded.meta.session;
    const root = new Timeline("root", "original run", config, { own: loaded.events });
    const session = new Session(config, root);
    session.#store = new EventLogStore(config, logPath);
    // Re-attach the chain head so live appends continue the existing chain.
    session.#adoptChainHead();

    const forksPath = sessionForksPath(sessionId);
    if (existsSync(forksPath)) session.#loadRecipes(forksPath);
    return session;
  }

  get store(): EventLogStore | null {
    return this.#store;
  }

  get id(): string {
    return this.config.id;
  }

  /* -------------------------------------------------------- timeline ops */

  get(timelineId: string): Timeline {
    const timeline = this.#timelines.get(timelineId);
    if (!timeline) throw new Error(`unknown timeline '${timelineId}'`);
    return timeline;
  }

  has(timelineId: string): boolean {
    return this.#timelines.has(timelineId);
  }

  list(): Timeline[] {
    return [...this.#timelines.values()].sort((a, b) => {
      if (a.parent === null && b.parent !== null) return -1;
      if (b.parent === null && a.parent !== null) return 1;
      return a.createdAt < b.createdAt ? -1 : 1;
    });
  }

  tree(): TimelineNode[] {
    return this.list().map((timeline) => ({
      id: timeline.id,
      label: timeline.label,
      parentId: timeline.parent?.id ?? null,
      forkPoint: timeline.parent ? timeline.baseSeq : null,
      tip: timeline.length(),
      overrides: timeline.overrideMap.size,
      ownEvents: timeline.ownEvents.length,
      note: timeline.note,
      createdAt: timeline.createdAt,
    }));
  }

  /**
   * Branch `parentId` at `atSeq`. The new timeline shares every event before
   * that position — nothing is copied, and no state is materialized yet.
   */
  fork(parentId: string, atSeq: number, label: string, note = ""): Timeline {
    const parent = this.get(parentId);
    const id = `fork-${++this.#forkCounter}-${this.config.id}`;
    const timeline = parent.fork(id, label, atSeq, { note });
    this.#timelines.set(id, timeline);
    return timeline;
  }

  /**
   * Counterfactual mode A — *branch*.
   *
   * The branch inherits history up to `atSeq`, replaces one event there, and its
   * future is unwritten: you drive it from the edit point with your own
   * commands. Cheap (no copying) and always exactly legal.
   */
  branchAt(
    parentId: string,
    atSeq: number,
    label: string,
    edit?: { index: number; event: EventCore | null; note: string },
  ): Timeline {
    const timeline = this.fork(parentId, atSeq, label, edit?.note ?? "");
    if (edit) {
      const original = timeline.eventAt(edit.index);
      if (!original) {
        throw new Error(`no event at position ${edit.index} to edit`);
      }
      timeline.setOverride(edit.index, {
        event: edit.event ?? makeNoop(original, edit.note),
        note: edit.note,
        createdAt: new Date().toISOString(),
      });
    }
    return timeline;
  }

  /**
   * Counterfactual mode B — *keep the future*.
   *
   * The branch inherits the parent's **entire** stream and rewrites one event
   * inside it, so the alternative world keeps unfolding exactly as it did —
   * "everything else held constant". Most such edits stop being possible after
   * a while, and `Timeline.evaluate()` reports precisely where and why.
   */
  counterfactual(
    parentId: string,
    index: number,
    label: string,
    edit: EventCore | null,
    note: string,
  ): Timeline {
    const parent = this.get(parentId);
    const timeline = parent.fork(`fork-${++this.#forkCounter}-${this.config.id}`, label, parent.length(), {
      note,
    });
    this.#timelines.set(timeline.id, timeline);
    const original = timeline.eventAt(index);
    if (!original) throw new Error(`no event at position ${index} to rewrite`);
    timeline.setOverride(index, {
      event: edit ?? makeNoop(original, note),
      note,
      createdAt: new Date().toISOString(),
    });
    return timeline;
  }

  removeFork(timelineId: string): void {
    if (timelineId === this.root.id) throw new Error("cannot remove the root timeline");
    this.#timelines.delete(timelineId);
  }

  /* -------------------------------------------------------------- driving */

  /**
   * Submit a command at a timeline's tip. Root submissions are appended to the
   * hash-chained log immediately, so the audit trail is never behind memory.
   */
  submit(timelineId: string, command: Command, vt?: number): EventCore[] {
    const timeline = this.get(timelineId);
    const events = timeline.submit(command, vt);
    this.#persist(timeline, events);
    return events;
  }

  advanceTo(timelineId: string, vt: number): EventCore[] {
    const timeline = this.get(timelineId);
    const events = timeline.advanceTo(vt);
    this.#persist(timeline, events);
    return events;
  }

  #persist(timeline: Timeline, events: readonly EventCore[]): void {
    if (events.length === 0) return;
    if (timeline !== this.root) return; // forks are recipes, not logs
    this.#store?.append(events);
  }

  /* ---------------------------------------------------------- persistence */

  /** Write the whole root log from scratch, then anchor and save recipes. */
  persist(nowIso = new Date().toISOString()): { path: string; events: number; headHash: string } {
    ensureDir(SESSIONS_DIR);
    const path = sessionLogPath(this.config.id);
    const store = new EventLogStore(this.config, path);
    store.create(nowIso);
    store.append(this.root.resolved());
    store.anchor(nowIso);
    this.#store = store;
    this.saveRecipes();
    return { path, events: store.count, headHash: store.headHash };
  }

  saveRecipes(): string {
    ensureDir(SESSIONS_DIR);
    const path = sessionForksPath(this.config.id);
    const recipes = this.list()
      .filter((timeline) => timeline.parent !== null)
      .map((timeline) => timeline.recipe());
    writeFileSync(
      path,
      canonicalJson({ sessionId: this.config.id, savedAt: new Date().toISOString(), recipes }) +
        "\n",
      "utf8",
    );
    return path;
  }

  #loadRecipes(path: string): void {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      recipes?: TimelineRecipe[];
    };
    const pending = [...(parsed.recipes ?? [])];
    let guard = 0;
    while (pending.length > 0) {
      const index = pending.findIndex((recipe) =>
        recipe.parentId === null ? false : this.#timelines.has(recipe.parentId),
      );
      if (index < 0) break;
      const recipe = pending.splice(index, 1)[0] as TimelineRecipe;
      const parent = this.#timelines.get(recipe.parentId as string) ?? null;
      const timeline = Timeline.fromRecipe(recipe, this.config, parent);
      this.#timelines.set(timeline.id, timeline);
      this.#bumpForkCounter(timeline.id);
      if (++guard > 10_000) throw new Error("fork recipe graph is too deep or cyclic");
    }
  }

  #bumpForkCounter(timelineId: string): void {
    const match = /^fork-(\d+)-/.exec(timelineId);
    if (match) this.#forkCounter = Math.max(this.#forkCounter, Number(match[1]));
  }

  /**
   * Continue the existing chain when appending to a loaded log. Without this a
   * live server would append events whose `prevHash` points at genesis, and the
   * log would verify as tampered on the very first restart.
   */
  #adoptChainHead(): void {
    const verification = verifyLog(sessionLogPath(this.config.id));
    const store = this.#store;
    if (!store) return;
    store.adoptHead(verification.headHash, verification.events);
  }

  /* --------------------------------------------------------- verification */

  /**
   * Three layers, cheapest first:
   *   1. the hash chain on disk (tamper evidence)
   *   2. a deterministic replay of the whole stream (can this history exist?)
   *   3. the invariant monitor (was it a *legal* market at every single step?)
   */
  verify(): SessionVerification {
    const chain = verifyLog(sessionLogPath(this.config.id));
    const replay = this.root.replayCheck();
    const invariants = monitorInvariants(
      createInitialState(this.config),
      this.root.resolved(),
      { instrument: this.config.instrument },
      applyEvent,
    );
    return {
      chain,
      replay,
      invariants,
      ok: chain.ok && replay === null && invariants.ok,
    };
  }

  /** Fingerprint the present, for "did my edit change anything?" badges. */
  tipDigests(timelineId: string) {
    return this.get(timelineId).state().digests;
  }
}
