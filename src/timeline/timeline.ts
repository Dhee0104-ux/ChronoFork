/**
 * Timelines: branching, counterfactual history.
 *
 * A `Timeline` is a *view* over a parent's event stream plus its own suffix.
 * Nothing is ever copied when you branch. A fork of a 50,000 event session costs
 * one object, and its recipe on disk is a few hundred bytes.
 *
 * Three rules make the whole thing work:
 *
 *   1. LOG POSITIONS ARE IMMUTABLE. You may change *what happened at* position
 *      `i`, never delete position `i`. That is why a counterfactual "removal"
 *      writes a NOOP into the slot instead of splicing the array: ids are
 *      derived from positions (see `ids.ts`), so renumbering would silently
 *      rewrite every order id after the edit.
 *
 *   2. RESOLUTION IS LAZY AND INHERITED. `resolved()` walks parents until it
 *      finds the first timeline with an override or a cached array. Overrides
 *      shadow the parent; a child's override always wins over its ancestor's.
 *
 *   3. STATE IS MATERIALIZED FROM THE NEAREST VALID CHECKPOINT. Checkpoints are
 *      ordinary cloned states. A child may only reuse a checkpoint that sits at
 *      or before its earliest override — past that point its history is no
 *      longer the parent's, and a borrowed snapshot would be a lie.
 */

import { Engine } from "../engine/engine.ts";
import { applyEvent } from "../engine/reducer.ts";
import {
  cloneState,
  createInitialState,
  digests,
  type StateDigests,
} from "../engine/state.ts";
import type { Command, EngineState, EventCore, SessionConfig } from "../engine/types.ts";

export interface Override {
  /** Replacement event. A NOOP means "nothing happened at this position". */
  event: EventCore;
  note: string;
  createdAt: string;
}

/**
 * A materialized state at a known position. Checkpoint states are treated as
 * immutable once stored — they are only ever cloned out of, never mutated —
 * which is what lets a fork share its parent's checkpoints by reference instead
 * of duplicating tens of megabytes of history.
 */
export interface Snapshot {
  k: number;
  state: EngineState;
  digests: StateDigests | null;
}

export interface MaterializedState {
  k: number;
  state: EngineState;
  digests: StateDigests;
  /** Which checkpoint the replay started from (0 = from genesis). */
  fromCheckpoint: number;
  eventsReplayed: number;
}

export interface TimelineStats {
  seeks: number;
  checkpointHits: number;
  checkpointMisses: number;
  eventsReplayed: number;
  checkpoints: number;
}

export interface TimelineRecipe {
  id: string;
  label: string;
  parentId: string | null;
  baseSeq: number;
  note: string;
  createdAt: string;
  overrides: Array<{ index: number; event: EventCore; note: string; createdAt: string }>;
  own: EventCore[];
}

export interface ReplayFailure {
  seq: number;
  kind: string;
  message: string;
}

/**
 * Result of folding a fork's stream as far as it can legally go.
 *
 * A counterfactual that *keeps* the original future (rather than branching away
 * from it) will usually stop being possible somewhere: the events that follow
 * assumed an order that the edit removed, or a price that no longer exists.
 * Rather than exploding, the fold stops at the last legal event and hands back
 * the reason. "Your hypothetical becomes impossible at #418, because a trade
 * references an order that no longer exists" is a genuinely useful answer.
 */
export interface Evaluation {
  /**
   * How many events could be applied: the count, i.e. the position of the first
   * event the reducer refused. When the refusal lands at #418 this is 418 — the
   * state sitting in `state` is the world after events 0..417.
   */
  legalLength: number;
  failure: ReplayFailure | null;
  truncated: boolean;
  state: EngineState;
  digests: StateDigests;
  fromCheckpoint: number;
}

export class TimelineError extends Error {}

/**
 * The event that means "nothing happened at this position".
 *
 * Note the `vt`: the clock still moves past the instant, which keeps every later
 * timestamp comparable across the two histories.
 */
export function makeNoop(original: EventCore, note: string): EventCore {
  return {
    seq: original.seq,
    vt: original.vt,
    kind: "NOOP",
    data: { note, replacedKind: original.kind },
  };
}

/** Copy an event with fields of its payload replaced. Position is never changed. */
export function patchEvent(original: EventCore, patch: Record<string, unknown>): EventCore {
  return {
    seq: original.seq,
    vt: original.vt,
    kind: original.kind,
    data: { ...(original.data as unknown as Record<string, unknown>), ...patch } as unknown as EventCore["data"],
  };
}

export interface TimelineOptions {
  parent?: Timeline | null;
  baseSeq?: number;
  own?: readonly EventCore[];
  overrides?: Iterable<[number, Override]>;
  note?: string;
  createdAt?: string;
  /** Take a state checkpoint every N applied events. */
  checkpointEvery?: number;
  /** Upper bound on retained checkpoints (oldest are dropped first). */
  maxCheckpoints?: number;
}

export class Timeline {
  readonly id: string;
  readonly label: string;
  readonly parent: Timeline | null;
  readonly baseSeq: number;
  readonly createdAt: string;
  note: string;

  #config: SessionConfig;
  #own: EventCore[];
  #overrides: Map<number, Override>;
  #children = new Set<Timeline>();
  #resolved: EventCore[] | null = null;
  #checkpoints = new Map<number, Snapshot>();
  #cursor: { k: number; engine: Engine } | null = null;
  #evaluation: Evaluation | null = null;
  #checkpointEvery: number;
  #maxCheckpoints: number;
  #stats: TimelineStats = {
    seeks: 0,
    checkpointHits: 0,
    checkpointMisses: 0,
    eventsReplayed: 0,
    checkpoints: 0,
  };

  constructor(id: string, label: string, config: SessionConfig, options: TimelineOptions = {}) {
    this.id = id;
    this.label = label;
    this.#config = config;
    this.parent = options.parent ?? null;
    this.baseSeq = options.baseSeq ?? (this.parent ? this.parent.length() : 0);
    this.note = options.note ?? "";
    this.createdAt = options.createdAt ?? new Date().toISOString();
    this.#checkpointEvery = options.checkpointEvery ?? 128;
    this.#maxCheckpoints = options.maxCheckpoints ?? 24;
    this.#own = [...(options.own ?? [])];
    this.#overrides = new Map(options.overrides ?? []);
    if (this.parent) this.parent.#children.add(this);

    if (this.parent && (this.baseSeq < 0 || this.baseSeq > this.parent.length())) {
      throw new TimelineError(
        `fork point ${this.baseSeq} is outside parent '${this.parent.id}' (0..${this.parent.length()})`,
      );
    }

    // Inherit the parent's checkpoints inside the range we still share. This is
    // the payoff of determinism: a fork starting at event 40,000 does not have
    // to replay 40,000 events, because a state that was materialized once is a
    // valid state for any history that shares that prefix.
    if (this.parent) {
      for (const [k, snapshot] of this.parent.#checkpoints) {
        if (k <= this.baseSeq) this.#checkpoints.set(k, snapshot);
      }
    }
  }

  /* ----------------------------------------------------------- identity */

  get config(): SessionConfig {
    return this.#config;
  }

  get ownEvents(): readonly EventCore[] {
    return this.#own;
  }

  get overrideMap(): ReadonlyMap<number, Override> {
    return this.#overrides;
  }

  /** Number of applied events in this timeline. */
  length(): number {
    return this.baseSeq + this.#own.length;
  }

  /** Position of the newest event — the "tip". */
  get tip(): number {
    return this.length();
  }

  get stats(): TimelineStats {
    return { ...this.#stats, checkpoints: this.#checkpoints.size };
  }

  children(): Timeline[] {
    return [...this.#children];
  }

  /** `stateAt(length)`, i.e. the present. */
  state(): MaterializedState {
    return this.stateAt(this.length());
  }

  /* -------------------------------------------------------- resolution */

  /**
   * The full applied event stream, with ancestors resolved and overrides
   * applied. Memoized; invalidated by this timeline's or an ancestor's edit.
   */
  resolved(): EventCore[] {
    if (this.#resolved) return this.#resolved;

    const parentEvents = this.parent ? this.parent.resolved() : [];
    const out: EventCore[] = new Array(this.baseSeq + this.#own.length);

    for (let i = 0; i < this.baseSeq; i++) {
      const inherited = parentEvents[i];
      const override = this.#overrides.get(i);
      if (override) out[i] = override.event;
      else if (inherited) out[i] = inherited;
      else {
        throw new TimelineError(
          `timeline '${this.id}' inherits position ${i} but parent '${this.parent?.id}' has only ${parentEvents.length} events`,
        );
      }
    }
    for (let j = 0; j < this.#own.length; j++) {
      const i = this.baseSeq + j;
      const override = this.#overrides.get(i);
      const own = this.#own[j];
      if (!own) throw new TimelineError(`timeline '${this.id}' lost its own event at ${i}`);
      out[i] = override ? override.event : own;
    }

    this.#resolved = out;
    return out;
  }

  eventAt(k: number): EventCore | undefined {
    return this.resolved()[k];
  }

  /** Where an applied event actually came from. Used by the UI's provenance column. */
  originOf(k: number): { timelineId: string; seq: number; overridden: boolean } | null {
    const override = this.#overrides.get(k);
    if (override) return { timelineId: this.id, seq: k, overridden: true };
    if (k >= this.baseSeq) return { timelineId: this.id, seq: k, overridden: false };
    return this.parent?.originOf(k) ?? { timelineId: this.id, seq: k, overridden: false };
  }

  /* --------------------------------------------------------- overrides */

  /**
   * Replace what happened at position `k`. The replacement must be a complete
   * event — its `seq` must equal `k`, because a position is not negotiable.
   */
  setOverride(k: number, override: Override | null): void {
    if (!Number.isInteger(k) || k < 0) {
      throw new TimelineError(`override index must be a non-negative integer (got ${k})`);
    }
    if (k >= this.length()) {
      throw new TimelineError(
        `cannot override position ${k}: timeline '${this.id}' has ${this.length()} events`,
      );
    }
    if (override && override.event.seq !== k) {
      throw new TimelineError(
        `replacement for position ${k} claims seq ${override.event.seq}; positions are immutable`,
      );
    }

    if (override) this.#overrides.set(k, override);
    else this.#overrides.delete(k);

    this.invalidateFrom(k);
  }

  /** Counterfactual removal: an explicit no-op in the slot, never a splice. */
  dropAt(k: number, note: string, at = new Date().toISOString()): void {
    const original = this.eventAt(k);
    if (!original) throw new TimelineError(`no event at position ${k} to drop`);
    this.setOverride(k, { event: makeNoop(original, note), note, createdAt: at });
  }

  overrideAt(k: number): Override | undefined {
    return this.#overrides.get(k);
  }

  /* ------------------------------------------------------- invalidation */

  /**
   * History changed at `k`: drop the memo, every checkpoint after `k`, the
   * cursor if it sits after `k`, and tell every descendant to do the same.
   */
  invalidateFrom(k: number): void {
    this.#resolved = null;
    this.#evaluation = null;
    for (const key of [...this.#checkpoints.keys()]) {
      if (key > k) this.#checkpoints.delete(key);
    }
    if (this.#cursor && this.#cursor.k > k) this.#cursor = null;
    for (const child of this.#children) {
      // A descendant only cares if the edit landed inside the range it inherits.
      if (k < child.baseSeq) child.invalidateFrom(k);
    }
  }

  /* ------------------------------------------------------ materialization */

  /**
   * Bring the state to position `k` and return a *clone*, so callers can hold
   * a view of the past without freezing the cursor.
   */
  stateAt(k: number): MaterializedState {
    if (!Number.isInteger(k) || k < 0 || k > this.length()) {
      throw new TimelineError(
        `position ${k} is outside timeline '${this.id}' (0..${this.length()})`,
      );
    }
    this.#stats.seeks += 1;
    const { engine, fromCheckpoint, replayed } = this.#seek(k);
    const snapshot = cloneState(engine.state);
    return {
      k,
      state: snapshot,
      digests: digests(snapshot),
      fromCheckpoint,
      eventsReplayed: replayed,
    };
  }

  /**
   * The live state at the tip, *borrowed*. Read it, never mutate it — this
   * exists so hot loops (the simulator, the API's projections) can read the
   * present without cloning hundreds of kilobytes per call.
   */
  peek(): EngineState {
    return this.#seek(this.length()).engine.state;
  }

  /** Fingerprints only — cheaper by a constant factor, same replay work. */
  digestsAt(k: number): StateDigests {
    const checkpoint = this.#checkpoints.get(k);
    if (checkpoint) {
      this.#stats.seeks += 1;
      this.#stats.checkpointHits += 1;
      checkpoint.digests ??= digests(checkpoint.state);
      return checkpoint.digests;
    }
    return this.stateAt(k).digests;
  }

  #seek(k: number): { engine: Engine; fromCheckpoint: number; replayed: number } {
    if (this.#cursor && this.#cursor.k === k) {
      return { engine: this.#cursor.engine, fromCheckpoint: k, replayed: 0 };
    }

    const events = this.resolved();

    // Fast path: continue forward from where we already are.
    if (this.#cursor && this.#cursor.k < k) {
      const engine = this.#cursor.engine;
      const start = this.#cursor.k;
      for (let i = start; i < k; i++) {
        applyEvent(engine.state, events[i] as EventCore);
        this.#maybeCheckpoint(i + 1, engine.state);
      }
      engine.clock = engine.state.vt;
      this.#cursor = { k, engine };
      this.#stats.eventsReplayed += k - start;
      return { engine, fromCheckpoint: start, replayed: k - start };
    }

    const checkpoint = this.#bestCheckpoint(k);
    const engine = checkpoint
      ? new Engine(this.#config, cloneState(checkpoint.state), checkpoint.state.vt)
      : new Engine(this.#config, createInitialState(this.#config));
    const start = checkpoint ? checkpoint.k : 0;
    if (checkpoint) this.#stats.checkpointHits += 1;
    else this.#stats.checkpointMisses += 1;

    for (let i = start; i < k; i++) {
      applyEvent(engine.state, events[i] as EventCore);
      this.#maybeCheckpoint(i + 1, engine.state);
    }
    engine.clock = engine.state.vt;
    this.#cursor = { k, engine };
    this.#stats.eventsReplayed += k - start;
    return { engine, fromCheckpoint: start, replayed: k - start };
  }

  #bestCheckpoint(k: number): Snapshot | null {
    let best: Snapshot | null = null;
    for (const [key, snapshot] of this.#checkpoints) {
      if (key > k) continue;
      if (!best || key > best.k) best = snapshot;
    }
    return best;
  }

  /**
   * Store a checkpoint, if `k` is on the checkpoint grid.
   *
   * The guard that matters is `state.seq === k`. A checkpoint's whole value is
   * that it means "the state after exactly `k` events" — storing a state that
   * is a few events ahead of its key produces a branch that materializes into
   * the wrong world, and it fails much later, somewhere else entirely. (This is
   * not hypothetical: an earlier version of `submit()` stamped the state at the
   * end of a multi-event command under every position that command spanned.)
   */
  #maybeCheckpoint(k: number, state: EngineState): void {
    if (state.seq !== k) return;
    if (this.#checkpoints.has(k)) return;
    // Sparse by *distance*, not by modulo. A command emits several events at
    // once, so exact multiples of the interval often land inside a command and
    // would be skipped, leaving long stretches with no checkpoint at all. Any
    // command boundary is a valid place to record one.
    const previous = this.#highestCheckpointAtOrBelow(k);
    if (previous !== null && k - previous < this.#checkpointEvery) return;
    this.#checkpoints.set(k, { k, state: cloneState(state), digests: null });
    this.#pruneCheckpoints();
  }

  #highestCheckpointAtOrBelow(k: number): number | null {
    let highest: number | null = null;
    for (const key of this.#checkpoints.keys()) {
      if (key > k) continue;
      if (highest === null || key > highest) highest = key;
    }
    return highest;
  }

  /** Every checkpoint must describe exactly the position it claims. */
  checkpointIntegrity(): Array<{ k: number; seq: number; ok: boolean }> {
    return [...this.#checkpoints.values()]
      .sort((a, b) => a.k - b.k)
      .map((snapshot) => ({ k: snapshot.k, seq: snapshot.state.seq, ok: snapshot.k === snapshot.state.seq }));
  }

  #pruneCheckpoints(): void {
    if (this.#checkpoints.size <= this.#maxCheckpoints) return;

    // Never drop the checkpoint at the fork point (it is the one a fresh branch
    // wants) nor the one that still sits inside shared history ahead of the
    // earliest override.
    const protectedKeys = new Set<number>([this.baseSeq]);
    if (this.#overrides.size > 0) {
      protectedKeys.add(Math.min(...this.#overrides.keys()));
    }

    const keys = [...this.#checkpoints.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      if (this.#checkpoints.size <= this.#maxCheckpoints) break;
      if (protectedKeys.has(key)) continue;
      if (this.#cursor && this.#cursor.k === key) continue;
      this.#checkpoints.delete(key);
    }
  }

  /** Checkpoints kept, for the UI's cache panel and the tests. */
  checkpointKeys(): number[] {
    return [...this.#checkpoints.keys()].sort((a, b) => a - b);
  }

  /* ---------------------------------------------------------- advancing */

  /** Apply a command at the tip. Returns the events that were appended. */
  submit(command: Command, vt?: number): EventCore[] {
    const { engine } = this.#seek(this.length());
    const events = engine.submit(command, vt);
    if (events.length === 0) return events;

    this.#own.push(...events);
    if (this.#resolved) this.#resolved.push(...events);
    this.#evaluation = null;
    // One command can emit several events, and the engine only surfaces the
    // state at the end of it — so the *only* position that can be checkpointed
    // here is the tip. Intermediate positions get one on the next replay.
    this.#maybeCheckpoint(this.length(), engine.state);
    this.#cursor = { k: this.length(), engine };
    return events;
  }

  /** Move the virtual clock at the tip, firing any TTLs that came due. */
  advanceTo(vt: number): EventCore[] {
    const { engine } = this.#seek(this.length());
    const events = engine.advanceTo(vt);
    if (events.length > 0) {
      this.#own.push(...events);
      if (this.#resolved) this.#resolved.push(...events);
      this.#evaluation = null;
      this.#maybeCheckpoint(this.length(), engine.state);
    }
    this.#cursor = { k: this.length(), engine };
    return events;
  }

  /* ------------------------------------------------------------- forking */

  fork(id: string, label: string, atSeq = this.length(), options: Partial<TimelineOptions> = {}): Timeline {
    return new Timeline(id, label, this.#config, {
      ...options,
      parent: this,
      baseSeq: atSeq,
      checkpointEvery: this.#checkpointEvery,
      maxCheckpoints: this.#maxCheckpoints,
    });
  }

  /* ------------------------------------------------------------ replay */

  /**
   * Fold the whole stream from genesis, reporting the first event the reducer
   * refuses. A fork whose override produces an impossible history fails here —
   * "this counterfactual never existed" is a legitimate, useful answer.
   */
  replayCheck(): ReplayFailure | null {
    const engine = new Engine(this.#config);
    const events = this.resolved();
    for (const event of events) {
      try {
        applyEvent(engine.state, event);
      } catch (error) {
        return {
          seq: event.seq,
          kind: event.kind,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return null;
  }

  /**
   * Fold as far as the stream stays legal, caching the answer.
   *
   * On the root (and on clean branches) `legalLength` equals the tip and the
   * result is exactly what `state()` would return. On a counterfactual that
   * inherited its parent's future, this is where the alternative world stops
   * making sense — which the UI shows instead of an error.
   */
  evaluate(): Evaluation {
    if (this.#evaluation) return this.#evaluation;
    const events = this.resolved();
    const checkpoint = this.#bestCheckpoint(events.length);
    const engine = checkpoint
      ? new Engine(this.#config, cloneState(checkpoint.state), checkpoint.state.vt)
      : new Engine(this.#config);
    const start = checkpoint ? checkpoint.k : 0;

    let legalLength = start;
    let failure: ReplayFailure | null = null;
    for (let i = start; i < events.length; i++) {
      const event = events[i] as EventCore;
      try {
        applyEvent(engine.state, event);
        legalLength = i + 1;
      } catch (error) {
        failure = {
          seq: event.seq,
          kind: event.kind,
          message: error instanceof Error ? error.message : String(error),
        };
        break;
      }
    }
    engine.clock = engine.state.vt;

    const evaluation: Evaluation = {
      legalLength,
      failure,
      truncated: legalLength < events.length,
      state: engine.state,
      digests: digests(engine.state),
      fromCheckpoint: start,
    };
    this.#evaluation = evaluation;
    // The engine now sits exactly at the last legal event; reuse it.
    this.#cursor = { k: legalLength, engine };
    return evaluation;
  }

  /* ------------------------------------------------------------- recipe */

  recipe(): TimelineRecipe {
    return {
      id: this.id,
      label: this.label,
      parentId: this.parent?.id ?? null,
      baseSeq: this.baseSeq,
      note: this.note,
      createdAt: this.createdAt,
      overrides: [...this.#overrides.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([index, override]) => ({
          index,
          event: override.event,
          note: override.note,
          createdAt: override.createdAt,
        })),
      own: [...this.#own],
    };
  }

  static fromRecipe(
    recipe: TimelineRecipe,
    config: SessionConfig,
    parent: Timeline | null,
  ): Timeline {
    return new Timeline(recipe.id, recipe.label, config, {
      parent,
      baseSeq: recipe.baseSeq,
      own: recipe.own,
      note: recipe.note,
      createdAt: recipe.createdAt,
      overrides: recipe.overrides.map((entry) => [
        entry.index,
        { event: entry.event, note: entry.note, createdAt: entry.createdAt },
      ]),
    });
  }

  /* ---------------------------------------------- divergence between two */

  /**
   * First position at which two timelines applied a different event, or null
   * when one is a prefix of the other. This is the *event* divergence; state
   * divergence can happen later (or not at all) and is computed separately.
   */
  static firstEventDivergence(a: Timeline, b: Timeline): number | null {
    const left = a.resolved();
    const right = b.resolved();
    const limit = Math.min(left.length, right.length);
    for (let i = 0; i < limit; i++) {
      const x = left[i] as EventCore;
      const y = right[i] as EventCore;
      if (x.kind !== y.kind || JSON.stringify(x.data) !== JSON.stringify(y.data) || x.vt !== y.vt) {
        return i;
      }
    }
    return null;
  }

  /**
   * First position whose *effect* differs, or null if none was found inside the
   * budget.
   *
   * The convention matches `firstEventDivergence`: positions are event indices,
   * and the state compared at index `i` is the state *after* event `i`. Mind the
   * one-off against `digestsAt(i)`, which describes the state *before* event `i` —
   * an edit at position 20 is therefore invisible in `digestsAt(20)` (identical in
   * both histories) and shows up at `digestsAt(21)`. Returning 20 here means "the
   * first place the two runs part company is how #20 landed".
   *
   * This is a deliberately bounded scan. Fingerprinting a state means hashing
   * everything an account or the book could have touched, so an exhaustive scan
   * over a long session would cost far more than the answer is worth. Callers
   * get the exact answer near a point of interest (the fork) and an honest
   * "beyond budget" beyond that; `digestsAt` compares any two specific points
   * exactly.
   *
   * Note the asymmetry with `firstEventDivergence`: two different event streams
   * *can* produce identical state (a NOOP where a rejection used to be, say),
   * and only an actual state comparison can tell you that.
   */
  static firstStateDivergence(a: Timeline, b: Timeline, budget = 256): number | null {
    const limit = Math.min(a.length(), b.length());
    for (let i = 0; i <= budget && i < limit; i++) {
      if (a.digestsAt(i + 1).state !== b.digestsAt(i + 1).state) return i;
    }
    return null;
  }

  /** Human-readable traceability: "fork-a:12 ← root:12". */
  provenanceOf(k: number): string {
    const origin = this.originOf(k);
    if (!origin) return "-";
    const base = `${origin.timelineId}:${origin.seq}`;
    return origin.overridden ? `${base} (edited)` : base;
  }
}
