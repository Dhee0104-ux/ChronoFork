# Chronofork

A deterministic, event-sourced limit-order exchange with **counterfactual replay**: a tamper-evident audit log where you can fork market history at any event, rewrite it, and see exactly how the tape, the book, and every account balance would have diverged — all provably.

> **No existing project does this.** Matching engines exist (Rust, C++, Go). Event-sourcing libraries exist. Replay frameworks exist. None of them combine a **hash-chained audit log + a 100% deterministic engine + a per-event invariant monitor + counterfactual forks graded by a semantic verdict** in one self-contained artifact. Chronofork does.

---

## Why it matters

Financial systems are audited by reconstructing the past. But reconstruction only tells you what *did* happen. When a trade goes wrong — a fat finger, a vanished quote, a lost cancel — the question on every desk is *what if*: what if that order had been priced right, what if that quote had stayed in the book, what if the venue had refused the ticket?

Chronofork makes that question computable and auditable. Its log is append-only and SHA-256 chained (a forged file is detectable). But unlike a plain hash chain, **a forged history that passes the hash check still has to survive the reducer and the invariant monitor** — the market it describes has to actually be possible. The tool distinguishes four verdicts:

| Verdict | Meaning |
|---|---|
| **`no-effect`** | Legal, invariant-clean, identical destination. The edit changed the path, not the end state. |
| **`legal-divergence`** | Legal, clean, but it ends somewhere else. The interesting case. |
| **`impossible-history`** | The original future can't be applied on top of the edit — a later event assumed something this edit removed. |
| **`invariant-violation`** | Representable but not a legal market: a crossed book, broken reservation, or fabricated fill. |

---

## How it works

Everything rests on two rules enforced by the type system and the invariants:

1. **No floating point.** Prices are integer cents, quantities are integer shares, cash is integer cents. Two machines cannot disagree.
2. **No ambient input.** Time arrives as data (`vt`). The virtual clock, the PRNG, the filesystem — none of them leak into a transition. Every command is a pure function of `(state, command) → events`, and the reducer is a pure fold.

The pipeline:

```
┌──────────┐     (pure)     ┌──────────┐     (fold)     ┌──────────┐
│  command │ ──────────────► │  events  │ ──────────────► │   state  │
│  submit  │                  │(deterministic)│             │ (deterministic)│
└──────────┘                  └──────────┘                └──────────┘
                                     │                         │
                                     ▼                         ▼
                              hash-chained log          invariant monitor
                              (src/log/store.ts)       (src/engine/invariants.ts)
```

**`Timeline`** (`src/timeline/`) is the layer that makes replay meaningful:
- A **fork** is a parent pointer + a position + a small set of overrides — no event array is ever copied. A branch of a 5,000-event session is a few hundred bytes on disk.
- Checkpoints are **inherited** by children: a fork starting at event 4,000 reuses its parent's snapshot and skips the rewind.
- Resolution is **lazy**: `resolved()` walks parents only until it hits the first override or cached array, then shadows.
- State materialization resumes from the nearest valid checkpoint (`stateAt(k)`), with the cursor memoized for sequential scrubbing.

The **log store** (`src/log/store.ts`) is one JSON object per line: a `meta` header, hashed `event` records, and an optional `anchor` manifest. `verifyLog` recomputes the chain from disk and checks contiguity, monotonic time, canonical key order, and the anchor. The tamper tool (`src/log/tamper.ts`) writes two copies — one with stale hashes, one with a recomputed chain — so you can see which layer catches which forgery.

The invariant monitor (`src/engine/invariants.ts`) checks **11 properties after every single event**, scoped to just what that event touched — cash/share conservation, reservation matching, order accounting, book structure, trade integrity, tick alignment, position-derived identities, and session gating. It runs at O(1)-ish per event by tracking the in-flight order and scoping each check; a full verification of 5,000+ events takes well under a second.

The **simulator** (`src/sim/`) generates four deterministic scenarios with prepared interest points — fork anchors that ship ready to run:

| Scenario | What it shows |
|---|---|
| `calm-open` | An orderly market. A one-tick price edit on a worked order leaves the tape identical but shifts cash and reservations via price improvement. |
| `volatile-session` | Thin books with constant churn. Stress test for reservation accounting. Includes a deliberately malformed ticket (off-lot quantity) that gets refused. |
| `liquidity-vacuum` | Makers pull their touch quotes; a large seller cascades through the deeper ladder. One quote left behind changes whether the cascade prints a range. |
| `fat-finger` | A 2,000-share sell at $12.00 instead of $24.00 sweeps the book. Two experiments: priced right, and refused entirely. |

---

## Quick start

```bash
# Node 22.6+ (TypeScript runs natively via --experimental-strip-types)
git clone … && cd chronofork
npm install -D          # only dev tooling: typescript + @types/node

npm run seed            # generate every scenario's hash-chained log
npm run verify          # chain integrity + full replay + invariants for all sessions
npm run bench           # replay throughput, checkpoint reuse, fork cost

npm start               # run the HTTP server (serves the UI + API on :4173)
open http://localhost:4173   # → browse, scrub the timeline, run experiments
```

---

## CLI reference

| Command | What it does |
|---|---|
| `npm run seed [scenario]` | Generate and persist all scenario logs. Optional arg restricts to one. |
| `npm run verify [session]` | Three-layer verification: hash chain, deterministic replay, per-event invariants. |
| `npm run bench` | Throughput of replay, checkpoint hit/miss ratio, and fork creation cost. |
| `npm run replay <session> --at=N` | Print the market state at position N of a session. |
| `npm run counterfactual <session> --seq=N [--drop] [--patch=price=2400] [--mode=branch\|counterfactual]` | Run an ad-hoc fork and print the full report. |
| `node src/cli.ts sessions` | List what is on disk. |
| `node src/cli.ts experiments [session]` | Run every prepared experiment and grade its verdict. |

**Example — the headline counterfactual:**

```bash
npm run counterfactual liquidity-vacuum --seq=312 --drop
```

This drops the event at position 312 (the cancel that removed a maker's touch quote) and replays the original morning on top of it — the "counterfactual" mode that keeps the original future and reports where it becomes impossible.

---

## HTTP API

`GET /api/sessions` — list all seeded sessions with summary stats.

`GET /api/sessions/:id` — session config, tree of timelines, checkpoint set, integrity report.

`GET /api/sessions/:id/state?at=N&timeline=T` — full view model at position N on timeline T (book ladder, open orders, tape, trade series, account balances, digests, and the checkpoint it seeded from).

`GET /api/sessions/:id/events?from=A&to=B&timeline=T` — paged event tape with provenance and override markers.

`GET /api/sessions/:id/verify` — the three-layer verification verdict.

`GET /api/sessions/:id/experiments` — all prepared counterfactuals for the session, each with its verdict and narrative diff.

`GET /api/sessions/:id/tamper?seq=N&field=qty&value=500` — forge a copy of the log with one number rewritten (naive + rehashed), and show which checks catch it.

`GET /api/sessions/:id/preview?seq=N` — introspection: which fields of the event are editable numbers.

`POST /api/sessions/:id/experiment` — run an ad-hoc counterfactual (`{ index, mode, edit, drop, patch }`).

`POST /api/sessions/:id/command` — drive a branch forward by hand (`{ timeline, command, vt }`).

The API serves the static UI from `public/` and caches sessions, experiments, and verifications in memory.

---

## Web UI

A single-page app in [public/index.html](public/index.html) + [public/app.js](public/app.js), no framework:

- **Timeline scrubber** — drag across positions, see the book ladder, tape, and account balances evolve in lockstep. The cursor is memoized, so scrubbing forward/backward is O(1) after the first seek.
- **Book ladder** — live best bid/ask, spread, depth, and per-level order counts.
- **Price chart** — trade prints as a series, with the alternative history overlaid when you run an experiment.
- **Fork dialog** — pick a position, choose *branch* (future is unwritten) or *counterfactual* (keep the original future), drop the event or patch a field.
- **Diff panel** — the counterfactual's narrative report: whose cash and shares moved, how the book shape changed, and where the two histories part company.

---

## Project layout

```
src/
  core/          canonical JSON, SHA-256 hashing, seeded PRNG
  engine/        types, ids, order book, reducer, matching semantics,
                 state construction, the 11 invariant checks, event formatting
  log/           hash-chained append-only store, tamper tooling, path helpers
  timeline/      Timeline (forks, overrides, checkpoints, lazy resolution),
                 Session (persistence + recipes), diff, report
  sim/           deterministic market simulator, 4 scenarios, interest points
  server/        zero-dependency HTTP API + static host
  cli.ts         seed · verify · bench · replay · counterfactual · experiments
test/            engine + timeline test suites (32 tests, node:test)
public/          the web UI (index.html, styles.css, app.js)
scripts/         smoke test + debug helpers
data/            generated logs (gitignored)
```

---

## Testing

```bash
npm test            # 32 tests: engine fuzz, determinism, forks, checkpoints,
                    #   log tamper detection, invariant coverage, equivalence
                    #   of the incremental monitor vs a full scan
npm run typecheck   # tsc --noEmit, strict
```

Highlights:
- **Determinism** — 400 fuzzed commands produce byte-identical state across runs.
- **Fork identity** — a fork with no override has the exact same digest as its parent.
- **Checkpoint integrity** — every checkpoint's stored state sequence equals its position key.
- **Tamper detection** — a naive edit fails the hash chain; a rehashed forgery fails the semantic layer.
- **Monitor equivalence** — the scoped per-event monitor agrees with a full exhaustive scan.

---

## Key design decisions

**Log positions are immutable.** An order id encodes the position it was created at (`ids.ts`, invariant I9). Splicing an event out would silently renumber everything after it, so a counterfactual *replaces* a position with a `NOOP` event that occupies its original slot and keeps the clock moving.

**Two counterfactual modes.** *Branch* diverges — the fork inherits history up to the edit and its future is unwritten. *Counterfactual* keeps the original future folded on top and reports the first position where the edit makes it impossible — "your hypothetical stops being real at #418 because a trade references an order that no longer exists."

**Invariants scale.** The original monitor re-checked all 11 properties over the entire state after every event — O(n²), 19 s on a 5,000-event session. The current version scopes each check to the event's subjects (one order, one trade at most) and skips invariants that have already broken, reducing it to ~135 ms.

**Cash is integer cents from day one.** Even the price random walk (which is a float) rounds to cents before emitting an order. A single float leak would refuse a quote as off-tick and silently corrupt the conservation invariants.

---

## Dependencies

**Zero runtime dependencies.** Node 22.6+'s native TypeScript execution (strip-only mode) is all the build tool you need. The only dev dependencies are `typescript` and `@types/node` for `tsc --noEmit` typechecking.

---

## License

MIT. See [LICENSE](LICENSE).
