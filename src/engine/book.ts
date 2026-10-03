/**
 * Order book primitives.
 *
 * The book is two arrays of price levels; each level holds order ids in strict
 * FIFO order, which is what implements "price-time priority". Everything here
 * is a plain function over serializable data — the book lives inside
 * `EngineState` so it can be snapshotted, hashed and diffed like any other
 * value. No class, no hidden allocation, no closure state.
 */

import type { PriceLevel, Side } from "./types.ts";

/** Levels are sorted: bids descending, asks ascending. */
export function compareLevels(side: Side): (a: PriceLevel, b: PriceLevel) => number {
  return side === "BUY" ? (a, b) => b.price - a.price : (a, b) => a.price - b.price;
}

export function findLevelIndex(levels: readonly PriceLevel[], price: number): number {
  for (let i = 0; i < levels.length; i++) {
    if ((levels[i] as PriceLevel).price === price) return i;
  }
  return -1;
}

export function findLevel(levels: readonly PriceLevel[], price: number): PriceLevel | undefined {
  const index = findLevelIndex(levels, price);
  return index < 0 ? undefined : levels[index];
}

export function bestPrice(levels: readonly PriceLevel[]): number | null {
  const level = levels[0];
  return level ? level.price : null;
}

/**
 * Add a resting order. Callers pass the quantity that is actually resting, so
 * the level's cached `totalQty` stays exact.
 */
export function insertResting(
  levels: PriceLevel[],
  side: Side,
  orderId: string,
  price: number,
  qty: number,
): PriceLevel {
  const index = findLevelIndex(levels, price);
  if (index >= 0) {
    const level = levels[index] as PriceLevel;
    level.orders.push(orderId);
    level.totalQty += qty;
    return level;
  }
  const created: PriceLevel = { price, orders: [orderId], totalQty: qty };
  // Keep the array sorted by price. Books have few distinct levels, so the
  // linear scan is faster in practice than a binary search plus splice.
  // Bids descend from the best price, asks ascend.
  const asc = side === "SELL";
  let at = levels.length;
  for (let i = 0; i < levels.length; i++) {
    const p = (levels[i] as PriceLevel).price;
    if (asc ? p > price : p < price) {
      at = i;
      break;
    }
  }
  levels.splice(at, 0, created);
  return created;
}

/**
 * Unlink an order from its level's FIFO queue, leaving `totalQty` alone.
 * Used when the quantity was already accounted for fill-by-fill (a fully
 * filled order) — the caller must have kept the level cache in sync.
 * Returns true when the order was found.
 */
export function unlinkResting(levels: PriceLevel[], price: number, orderId: string): boolean {
  const index = findLevelIndex(levels, price);
  if (index < 0) return false;
  const level = levels[index] as PriceLevel;
  const at = level.orders.indexOf(orderId);
  if (at < 0) return false;
  level.orders.splice(at, 1);
  if (level.orders.length === 0) levels.splice(index, 1);
  return true;
}

/**
 * Remove a resting order *and* release its quantity from the level cache.
 * Returns the quantity released from the level (0 when the order was not
 * resting, e.g. an IOC remainder that never made it into the book).
 */
export function removeResting(
  levels: PriceLevel[],
  price: number,
  orderId: string,
  restingQty: number,
): number {
  if (!unlinkResting(levels, price, orderId)) return 0;
  reduceLevelQty(levels, price, restingQty);
  return restingQty;
}

/** The levels array an order of this side rests in. */
export function levelsForSide(
  book: { bids: PriceLevel[]; asks: PriceLevel[] },
  side: Side,
): PriceLevel[] {
  return side === "BUY" ? book.bids : book.asks;
}

/** Reduce a level's cached quantity after a partial fill on its head order. */
export function reduceLevelQty(
  levels: readonly PriceLevel[],
  price: number,
  qty: number,
): void {
  const level = findLevel(levels, price);
  if (!level) return;
  level.totalQty -= qty;
}

export function headOrderId(levels: readonly PriceLevel[]): string | null {
  const level = levels[0];
  if (!level) return null;
  return level.orders[0] ?? null;
}

/** A book is crossed when the best bid is at or above the best ask. */
export function isCrossed(bids: readonly PriceLevel[], asks: readonly PriceLevel[]): boolean {
  const bid = bestPrice(bids);
  const ask = bestPrice(asks);
  if (bid === null || ask === null) return false;
  return bid >= ask;
}

export function sideOfAggressor(side: Side): Side {
  return side === "BUY" ? "SELL" : "BUY";
}

/** Levels an incoming order of this side must trade against. */
export function oppositeLevels(
  book: { bids: PriceLevel[]; asks: PriceLevel[] },
  side: Side,
): PriceLevel[] {
  return side === "BUY" ? book.asks : book.bids;
}

/** Total open quantity across a side — used by invariants and the UI. */
export function sideDepth(levels: readonly PriceLevel[]): number {
  let total = 0;
  for (const level of levels) total += level.totalQty;
  return total;
}
