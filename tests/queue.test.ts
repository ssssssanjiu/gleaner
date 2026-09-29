import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runPool } from '../src/core/queue';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('并发数从不超过上限', async () => {
  let inFlight = 0;
  let peak = 0;
  await runPool(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await sleep(10);
    inFlight--;
  });
  assert.ok(peak <= 3, `峰值并发 ${peak} 超过上限 3`);
  assert.ok(peak >= 2, `峰值并发 ${peak}，并发池疑似退化成串行`);
});

test('结果顺序与输入一致，且全部完成', async () => {
  const results = await runPool([30, 5, 20, 1], 4, async (ms) => {
    await sleep(ms);
    return ms * 2;
  });
  assert.deepEqual(
    results.map((r) => (r.status === 'fulfilled' ? r.value : 'ERR')),
    [60, 10, 40, 2],
  );
});

test('单个任务抛错不影响其他任务', async () => {
  const seen: boolean[] = [];
  const results = await runPool([1, 2, 3, 4, 5], 2, async (n) => {
    if (n === 3) throw new Error('boom');
    return n;
  }, (ok) => seen.push(ok));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.equal((results[2] as PromiseRejectedResult).reason.message, 'boom');
  assert.equal(seen.filter((x) => !x).length, 1);
});

test('空列表直接返回', async () => {
  const results = await runPool([], 4, async () => 1);
  assert.deepEqual(results, []);
});

test('并发数大于任务数不会出错', async () => {
  const results = await runPool([1, 2], 16, async (n) => n);
  assert.equal(results.length, 2);
});
