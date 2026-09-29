/**
 * 页面世界的媒体嗅探钩子。抽出来是为了能在 Node 里单测 ——
 * 钩子必须对页面「完全透明」，这一点靠肉眼看代码保证不了。
 */

export type MediaReporter = (url: string, contentType?: string) => void;
/** 需要看响应体的观察者（B站 playurl 接口）。只能读 res.clone()，不能动原响应 */
export type ResponseInspector = (url: string, res: Response) => void;

interface FetchLike {
  fetch: typeof fetch;
}

/**
 * 包装 fetch 做被动观察。两条硬性约束：
 * 1. 必须返回**原始 promise**，不能返回派生的 —— 否则页面拿到的是另一个对象，
 *    行为可能改变（时序、身份判断都会受影响）。
 * 2. 观察链必须自带拒绝处理 —— 页面正常的失败请求（切清晰度时中止分片是常态）
 *    会顺着我们的链冒出 `Uncaught (in promise) Failed to fetch`，
 *    在扩展错误页里显示成我们的锅。
 */
export function installFetchHook(
  target: FetchLike,
  report: MediaReporter,
  inspect?: ResponseInspector,
): () => void {
  const orig = target.fetch;
  if (typeof orig !== 'function') return () => {};

  target.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const input = args[0];
    const url =
      typeof input === 'string'
        ? input
        : typeof (input as Request)?.url === 'string'
          ? (input as Request).url
          : String(input);
    const promise = orig.apply(this as never, args);
    promise.then(
      (res) => {
        try {
          report(url, res?.headers?.get?.('content-type') ?? undefined);
        } catch {
          /* 观察失败绝不能影响页面 */
        }
        try {
          // 这个回调在页面自己的 .then 之前挂上，body 还没被读，clone 安全
          inspect?.(url, res);
        } catch {
          /* 同上 */
        }
      },
      () => {
        /* 页面自己的请求失败与我们无关 */
      },
    );
    return promise;
  } as typeof fetch;

  return () => {
    target.fetch = orig;
  };
}
