/**
 * One-line human descriptions of events, plus money/qty formatting.
 *
 * Kept out of the UI so the CLI, the tests and the browser all describe the
 * same event the same way. Nothing here is load-bearing for correctness.
 */

import type { EventCore } from "./types.ts";

export function formatPrice(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "-";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(cents: number | null | undefined): string {
  return formatPrice(cents);
}

export function formatQty(qty: number | null | undefined): string {
  if (qty === null || qty === undefined) return "-";
  return qty.toLocaleString("en-US");
}

/** Virtual time is milliseconds since midnight; render it as a session clock. */
export function formatClock(vt: number): string {
  const ms = ((vt % 86_400_000) + 86_400_000) % 86_400_000;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

export function formatCompact(value: number): string {
  if (Math.abs(value) < 1000) return String(value);
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}m`;
}

/** A short, stable label for an event — used in event streams and reports. */
export function describeEvent(event: EventCore): string {
  const data = event.data as unknown as Record<string, unknown>;
  switch (event.kind) {
    case "SESSION_OPENED":
      return `session ${String(data.sessionIndex)} opened`;
    case "DEPOSIT":
      return `${String(data.owner)} deposited ${formatMoney(data.amount as number)}`;
    case "GRANT":
      return `${String(data.owner)} received ${formatQty(data.shares as number)} shares`;
    case "ORDER_PLACED":
      return `${String(data.owner)} ${side(data.side)} ${formatQty(data.qty as number)} @ ${formatPrice(
        data.price as number,
      )} ${String(data.tif)}`;
    case "ORDER_RESTED":
      return `${String(data.orderId)} rests with ${formatQty(data.qty as number)} @ ${formatPrice(
        data.price as number,
      )}`;
    case "TRADE":
      return `TRADE ${formatQty(data.qty as number)} @ ${formatPrice(
        data.price as number,
      )} ${String(data.buyer)} <- ${String(data.seller)}`;
    case "ORDER_CANCELLED":
      return `${String(data.orderId)} cancelled (${String(data.reason)}) ${
        (data.releasedQty as number) > 0 ? `${formatQty(data.releasedQty as number)} released` : ""
      }`.trim();
    case "ORDER_REJECTED":
      return `${String(data.owner)} order refused: ${String(data.reason)}`;
    case "CANCEL_REJECTED":
      return `cancel of ${String(data.orderId)} refused: ${String(data.reason)}`;
    case "SESSION_CLOSED":
      return `session closed (${String(data.dayExpired)} DAY expired, ${String(
        data.gtcCarried,
      )} GTC carried)`;
    case "NOOP":
      return `counterfactual: ${String(data.note ?? "nothing happened here")}`;
    default:
      return event.kind;
  }
}

/** Short verb used by charts and tapes. */
export function eventTone(event: EventCore): "buy" | "sell" | "neutral" | "bad" | "edit" {
  switch (event.kind) {
    case "TRADE": {
      // The aggressor is whichever leg is not resting. Comparing ids here keeps
      // the event payload minimal — the side is derivable, so it is not stored.
      const data = event.data as { aggressorOrderId: string; buyOrderId: string };
      return data.aggressorOrderId === data.buyOrderId ? "buy" : "sell";
    }
    case "ORDER_PLACED": {
      const data = event.data as { side?: string };
      return data.side === "SELL" ? "sell" : "buy";
    }
    case "ORDER_REJECTED":
    case "CANCEL_REJECTED":
      return "bad";
    case "NOOP":
      return "edit";
    default:
      return "neutral";
  }
}

function side(value: unknown): string {
  return value === "SELL" ? "SELL" : "BUY";
}
