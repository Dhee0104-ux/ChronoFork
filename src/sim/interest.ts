/**
 * Interest points on disk.
 *
 * A few hundred bytes per session that record *why* someone would want to fork
 * it and *what* the edit should be. Keeping them next to the log (rather than
 * generating them on request) means the UI can offer prepared experiments
 * without running the simulator again.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { canonicalJson } from "../core/canonical.ts";
import { ensureDir, SESSIONS_DIR, sessionInterestPath } from "../log/paths.ts";
import type { InterestPoint } from "./simulator.ts";

export interface InterestFile {
  sessionId: string;
  generatedAt: string;
  points: InterestPoint[];
}

export function saveInterest(sessionId: string, points: readonly InterestPoint[]): string {
  ensureDir(SESSIONS_DIR);
  const path = sessionInterestPath(sessionId);
  const file: InterestFile = {
    sessionId,
    generatedAt: new Date().toISOString(),
    points: [...points],
  };
  writeFileSync(path, canonicalJson(file) + "\n", "utf8");
  return path;
}

export function loadInterest(sessionId: string): InterestPoint[] {
  const path = sessionInterestPath(sessionId);
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as InterestFile;
    return parsed.points ?? [];
  } catch {
    return [];
  }
}
