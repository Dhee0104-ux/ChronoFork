/**
 * Identity.
 *
 * Order and trade ids are derived from *log position*, never from a counter, a
 * timestamp or a random source. This is the cheap trick that makes replay
 * deterministic: an order placed at logical position 812 is always `O000812`,
 * in the original timeline and in every fork of it.
 */

export const ORDER_ID_PREFIX = "O";
export const TRADE_ID_PREFIX = "T";
const PAD = 6;

export function makeOrderId(seq: number): string {
  return ORDER_ID_PREFIX + String(seq).padStart(PAD, "0");
}

export function makeTradeId(seq: number): string {
  return TRADE_ID_PREFIX + String(seq).padStart(PAD, "0");
}

/** Short human label for a virtual timestamp (session-relative clock). */
export function formatVt(vt: number, startVt = 0): string {
  const ms = vt - startVt;
  const sign = ms < 0 ? "-" : "";
  const abs = Math.abs(ms);
  const minutes = Math.floor(abs / 60000);
  const seconds = Math.floor((abs % 60000) / 1000);
  const millis = abs % 1000;
  return `${sign}${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(
    millis,
  ).padStart(3, "0")}`;
}
