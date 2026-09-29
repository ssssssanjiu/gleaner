import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { installFetchHook } from '../src/core/page-hooks';

function fakeResponse(contentType: string) {
  return { headers: { get: (k: string) => (k === 'content-type' ? contentType : null) } };
}

test('成功请求会被上报，且返回的是原始 promise 对象', async () => {
  const seen: Array<[string, string | undefined]> = [];
  const original = Promise.resolve(fakeResponse('video/mp4'));
  const target = { fetch: (() => original) as any };
  installFetchHook(target, (u, c) => seen.push([u, c]));

  const returned = target.fetch('https://c/a.mp4');
  assert.equal(returned, original, '必须原样返回，不能返回派生 promise');
  await returned;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [['https://c/a.mp4', 'video/mp4']]);
});

test('页面请求失败时不产生未处理拒绝（用户截图里的报错）', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const target = {
      fetch: (() => Promise.reject(new TypeError('Failed to fetch'))) as any,
    };
    installFetchHook(target, () => {});
    // 页面自己处理了拒绝
    await target.fetch('https://c/dead.m4s').catch(() => {});
    // 给 unhandledRejection 一个触发机会
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(unhandled.length, 0, `钩子制造了 ${unhandled.length} 个未处理拒绝`);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('上报函数抛异常不影响页面拿到结果', async () => {
  const target = { fetch: (() => Promise.resolve(fakeResponse('video/mp4'))) as any };
  installFetchHook(target, () => {
    throw new Error('上报炸了');
  });
  const res = await target.fetch('https://c/a.mp4');
  assert.ok(res, '页面仍应正常拿到响应');
});

test('Request 对象作为入参时能取到 url', async () => {
  const seen: string[] = [];
  const target = { fetch: (() => Promise.resolve(fakeResponse('audio/mp4'))) as any };
  installFetchHook(target, (u) => seen.push(u));
  await target.fetch({ url: 'https://c/b.m4a' } as any);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, ['https://c/b.m4a']);
});

test('响应观察者：拿到响应对象，但页面仍拿到原始 promise；观察者抛错不影响页面', async () => {
  const res = fakeResponse('application/json');
  const original = Promise.resolve(res);
  const target = { fetch: (() => original) as any };
  const inspected: Array<[string, unknown]> = [];
  installFetchHook(target, () => {}, (u, r) => {
    inspected.push([u, r]);
    throw new Error('观察者自己炸了');
  });
  const returned = target.fetch('https://api.bilibili.com/x/player/wbi/playurl?bvid=1');
  assert.equal(returned, original);
  assert.equal(await returned, res);
  await new Promise((r) => setImmediate(r));
  assert.equal(inspected.length, 1);
  assert.equal(inspected[0][1], res);
});
