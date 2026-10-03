/**
 * Filesystem layout, resolved from this module rather than the process CWD, so
 * `npm run seed` and `npm run dev` agree no matter where they are invoked from.
 */

import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.resolve(here, "..", "..");
export const DATA_DIR = path.join(PROJECT_ROOT, "data");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
/** Forged copies of logs made by the tamper tool — never the real ones. */
export const TAMPER_DIR = path.join(DATA_DIR, "tamper");

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sessionLogPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.jsonl`);
}

/** Forks are stored as tiny recipes, never as copies of the parent log. */
export function sessionForksPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.forks.json`);
}

/** Prepared counterfactual experiments for a session. */
export function sessionInterestPath(sessionId: string): string {
  return path.join(SESSIONS_DIR, `${sessionId}.interest.json`);
}

/** Session ids that have a log on disk, newest first. */
export function listSessionIds(): string[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => name.replace(/\.jsonl$/, ""))
    .sort((a, b) => {
      const left = statSync(path.join(SESSIONS_DIR, `${a}.jsonl`)).mtimeMs;
      const right = statSync(path.join(SESSIONS_DIR, `${b}.jsonl`)).mtimeMs;
      return right - left;
    });
}
