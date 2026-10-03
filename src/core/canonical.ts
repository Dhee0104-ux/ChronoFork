/**
 * Canonical serialization.
 *
 * Every byte that enters the audit log, and every value that is hashed, goes
 * through `canonicalJson`. Two structurally identical values must produce the
 * *same string* no matter how their keys were inserted, which is what makes the
 * hash chain and state fingerprints meaningful.
 *
 * Rules:
 *   - object keys are sorted by code unit
 *   - no insignificant whitespace
 *   - numbers must be finite; integers stay integers (no `1.0` vs `1` drift)
 *   - `undefined` properties are dropped, `null` is preserved
 *   - `Map`/`Set` are rejected on purpose: the domain model is plain JSON only
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export class CanonicalError extends Error {}

export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  write(value, out, 0);
  return out.join("");
}

function write(value: unknown, out: string[], depth: number): void {
  if (depth > 64) throw new CanonicalError("canonicalJson: nesting too deep (cycle?)");

  if (value === null) {
    out.push("null");
    return;
  }

  switch (typeof value) {
    case "string":
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new CanonicalError(`canonicalJson: non-finite number (${String(value)})`);
      }
      if (Object.is(value, -0)) {
        out.push("0");
        return;
      }
      out.push(String(value));
      return;
    case "bigint":
      out.push(String(value));
      return;
    case "undefined":
      // Only reachable for array holes / explicit undefined in arrays.
      out.push("null");
      return;
    case "object":
      break;
    default:
      throw new CanonicalError(`canonicalJson: unsupported type ${typeof value}`);
  }

  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      write(value[i], out, depth + 1);
    }
    out.push("]");
    return;
  }

  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto !== Object.prototype && proto !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "unknown";
    throw new CanonicalError(`canonicalJson: expected a plain object, received ${name}`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();

  out.push("{");
  let first = true;
  for (const key of keys) {
    if (!first) out.push(",");
    first = false;
    out.push(JSON.stringify(key), ":");
    write(record[key], out, depth + 1);
  }
  out.push("}");
  return;
}

/** Deep structural clone that also *canonicalizes* key order. */
export function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

/** Structural equality via canonical form. */
export function canonicalEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}
