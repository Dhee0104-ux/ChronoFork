/**
 * Hashing primitives.
 *
 * `sha256Hex` is used for the tamper-evident log chain and for state
 * fingerprints. `shortHash` is a display-only helper (never used for integrity).
 */

import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.ts";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Hash of a canonicalized value. Structure determines the digest, not key order. */
export function hashValue(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** First 12 hex chars of the digest — for logs and UI badges only. */
export function shortHash(hex: string): string {
  return hex.slice(0, 12);
}

/** Order-independent XOR-fold of many digests; used for set-shaped fingerprints. */
export function foldHashes(hexes: readonly string[]): string {
  const acc = Buffer.alloc(32);
  for (const hex of hexes) {
    const buf = Buffer.from(hex, "hex");
    for (let i = 0; i < acc.length; i++) acc[i] = (acc[i] ?? 0) ^ (buf[i] ?? 0);
  }
  return acc.toString("hex");
}
