/**
 * Seeded, allocation-free PRNG (mulberry32).
 *
 * Determinism rule for this codebase: the core engine may never call
 * `Math.random()`. Any randomness is produced by the simulator out here, and the
 * *result* of that randomness is captured as an event in the log, so replaying
 * the log never needs the generator again.
 */

export interface Rng {
  /** Uniform integer in [0, 2^32). */
  u32(): number;
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** Uniform pick. Deterministic given the generator state. */
  pick<T>(items: readonly T[]): T;
  /** Standard normal via Box-Muller (deterministic sequence). */
  normal(): number;
}

export function createRng(seed: number | string): Rng {
  let state = typeof seed === "number" ? seed >>> 0 : fnv1a(seed);
  if (state === 0) state = 0x9e3779b9;

  const u32 = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };

  const next = (): number => u32() / 4294967296;

  const rng: Rng = {
    u32,
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    chance: (p) => next() < p,
    pick: (items) => {
      if (items.length === 0) throw new Error("rng.pick: empty list");
      return items[Math.floor(next() * items.length)] as (typeof items)[number];
    },
    normal: () => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };

  return rng;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
