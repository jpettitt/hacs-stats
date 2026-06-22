/**
 * Run `fn` over `items` with at most `concurrency` in flight at once.
 *
 * Per-item failures are caught and surfaced as `{ error }` in the result array
 * so a single bad repo doesn't abort a 3000-item scrape. The caller decides
 * whether to log, retry, or count them.
 *
 * Result order matches input order.
 */
export type Settled<R> = { value: R; error?: undefined } | { value?: undefined; error: Error };

export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Settled<R>[]> {
  if (concurrency < 1) throw new Error(`mapLimit: concurrency must be ≥ 1 (got ${concurrency})`);

  const results: Settled<R>[] = new Array(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      try {
        results[i] = { value: await fn(item, i) };
      } catch (err) {
        results[i] = { error: err instanceof Error ? err : new Error(String(err)) };
      }
    }
  };

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
