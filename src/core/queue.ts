/** 极简并发池：始终保持最多 concurrency 个任务在跑 */
export async function runPool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  onSettled?: (ok: boolean, index: number) => void,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let cursor = 0;

  const lane = async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = { status: 'fulfilled', value: await worker(items[i], i) };
        onSettled?.(true, i);
      } catch (e) {
        results[i] = { status: 'rejected', reason: e };
        onSettled?.(false, i);
      }
    }
  };

  const lanes = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}
