/**
 * Thin wrappers around the `p-map` library for bounded parallel execution.
 * Keeps the internal API stable (`pMap` / `pMapSettled`) while delegating
 * scheduling and AbortSignal handling to `p-map@7`.
 */

import pMapLib from 'p-map';

/**
 * Run `mapper` over `items` with at most `concurrency` in flight.
 * Rejects with the first error the mapper throws — matches the prior
 * hand-rolled semantics. Results preserve input order.
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number = 6,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  return pMapLib(items, mapper, { concurrency: limit, signal });
}

/**
 * Like `pMap` but never rejects — mapper errors surface as
 * `{ status: 'rejected', reason }` entries. Useful when one per-item
 * failure must not cancel the others (e.g. per-URL scraping).
 */
export async function pMapSettled<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number = 6,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  return pMapLib(
    items,
    async (item, index): Promise<PromiseSettledResult<R>> => {
      try {
        const value = await mapper(item, index);
        return { status: 'fulfilled', value };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    },
    { concurrency: limit, signal, stopOnError: false },
  );
}
