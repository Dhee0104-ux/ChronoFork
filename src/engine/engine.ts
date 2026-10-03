/**
 * The engine: a mutable cursor over one point in history.
 *
 * An `Engine` owns exactly one live `EngineState` and can move it forward:
 *   - `submit(command)`  — fold a command in, producing events
 *   - `advanceTo(vt)`    — move the virtual clock and fire whatever fell due
 *
 * It deliberately does *not* own history. `Timeline` does that, and every fork
 * gets its own engine so branching histories can never scribble on each other.
 *
 * The virtual clock is the second half of the determinism story. The reducer
 * never asks what time it is; the caller says how far time has moved, and any
 * work that time triggers becomes ordinary events in the log.
 */

import { applyEvent } from "./reducer.ts";
import {
  fireDueTimers,
  nextTimerAt,
  processCommand,
  type ProcessOptions,
} from "./semantics.ts";
import { createInitialState } from "./state.ts";
import type { Command, EngineState, EventCore, SessionConfig } from "./types.ts";

export class Engine {
  readonly config: SessionConfig;
  state: EngineState;
  /** Virtual time in ms. Always >= state.vt; the clock can run ahead of events. */
  clock: number;

  constructor(config: SessionConfig, state?: EngineState, clock?: number) {
    this.config = config;
    this.state = state ?? createInitialState(config);
    this.clock = clock ?? this.state.vt;
  }

  /** Events applied so far — also the position of this cursor. */
  get position(): number {
    return this.state.seq;
  }

  /** Fold a command in. The state is consumed; the returned events describe it. */
  submit(command: Command, vt?: number): EventCore[] {
    const options: ProcessOptions = { instrument: this.config.instrument };
    if (vt !== undefined) options.vt = vt;
    else options.vt = this.clock;
    const events = processCommand(this.state, command, options);
    if (events.length > 0) this.clock = Math.max(this.clock, this.state.vt);
    return events;
  }

  /**
   * Move the clock to `vt` and fire every due TTL, earliest deadline first.
   * Firing is idempotent from the log's point of view: the expirations become
   * events, and replaying them reproduces the same cancellations without
   * consulting a clock at all.
   */
  advanceTo(vt: number): EventCore[] {
    const target = Math.max(vt, this.clock);
    this.clock = target;
    const emitted: EventCore[] = [];
    const emit = (kind: EventCore["kind"], data: EventCore["data"]): EventCore => {
      const event: EventCore = { seq: this.state.seq, vt: target, kind, data };
      applyEvent(this.state, event);
      emitted.push(event);
      return event;
    };
    fireDueTimers(this.state, target, emit);
    return emitted;
  }

  /** Earliest scheduled TTL, or null when the book holds none. */
  nextTimerAt(): number | null {
    return nextTimerAt(this.state);
  }

  /** An independent engine positioned exactly where this one is. */
  fork(): Engine {
    return new Engine(this.config, structuredClone(this.state), this.clock);
  }
}
