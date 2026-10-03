/* Marginal cost of each invariant: whole-loop timings, no per-call timing noise. */
import { Session } from "../src/timeline/session.ts";
import { createInitialState } from "../src/engine/state.ts";
import { applyEvent } from "../src/engine/reducer.ts";
import { INVARIANTS, scopeForEvent } from "../src/engine/invariants.ts";

const session = Session.load("calm-open");
const config = session.config;
const events = session.root.resolved();
const ctx = { instrument: config.instrument };

function run(skip: Set<string>): number {
  const state = createInitialState(config);
  let inFlight: string | undefined;
  const t = performance.now();
  for (const event of events) {
    if (event.kind === "ORDER_PLACED") inFlight = (event.data as { orderId?: string }).orderId;
    applyEvent(state, event);
    const scope = scopeForEvent(event, inFlight);
    for (const invariant of INVARIANTS) {
      if (skip.has(invariant.id)) continue;
      invariant.check(state, ctx, scope);
    }
  }
  return performance.now() - t;
}

console.log(`all             ${run(new Set()).toFixed(0)}ms`);
console.log(`without I5      ${run(new Set(["I5"])).toFixed(0)}ms`);
console.log(`without I5,I8   ${run(new Set(["I5", "I8"])).toFixed(0)}ms`);
console.log(`without I5,I8,I9${run(new Set(["I5", "I8", "I9"])).toFixed(0)}ms`);
console.log(`none            ${run(new Set(INVARIANTS.map((i) => i.id))).toFixed(0)}ms`);
