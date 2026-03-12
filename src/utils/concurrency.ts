/**
 * Concurrency utilities for bounded parallel execution
 * Prevents CPU spikes and API rate limiting from unbounded Promise.all
 */

/**
 * Execute async tasks with a concurrency limit (like p-map).
 * Processes items from the input array through the mapper function,
 * running at most `concurrency` tasks simultaneously.
 *
 * @param items - Array of items to process
 * @param mapper - Async function to apply to each item
 * @param concurrency - Maximum number of concurrent tasks (default: 6)
 * @param signal - Optional AbortSignal to cancel remaining work
 * @returns Array of results in the same order as input items
 */
export async function pMap<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number = 6,
  signal?: AbortSignal,
): Promise<R[]> {
  if (items.length === 0) return [];

  // Clamp concurrency to reasonable bounds
  const limit = Math.max(1, Math.min(concurrency, items.length));

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const internalAbort = new AbortController();

  async function worker(): Promise<void> {
    while (true) {
      if (signal?.aborted || internalAbort.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      const index = nextIndex++;
      if (index >= items.length) break;
      try {
        results[index] = await mapper(items[index]!, index);
      } catch (err) {
        internalAbort.abort(); // Signal other workers to stop picking up new work
        throw err;
      }
    }
  }

  // Spawn `limit` workers that pull from the shared index
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Like pMap but uses Promise.allSettled semantics — never rejects,
 * returns PromiseSettledResult for each item.
 *
 * @param items - Array of items to process
 * @param mapper - Async function to apply to each item
 * @param concurrency - Maximum number of concurrent tasks (default: 6)
 * @param signal - Optional AbortSignal to cancel remaining work
 * @returns Array of PromiseSettledResult in the same order as input items
 */
export async function pMapSettled<T, R>(
  items: readonly T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number = 6,
  signal?: AbortSignal,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));

  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      if (signal?.aborted) break;
      const index = nextIndex++;
      try {
        const value = await mapper(items[index]!, index);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  // Fill any unprocessed items after abort
  for (let i = 0; i < items.length; i++) {
    if (results[i] === undefined) {
      results[i] = { status: 'rejected', reason: new DOMException('Aborted', 'AbortError') };
    }
  }

  return results;
}
