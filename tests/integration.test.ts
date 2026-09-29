/**
 * 扩展外壳集成测试：加载真实的 content / background / offscreen 入口源码，
 * 用一个按 webextension-polyfill 语义实现的 browser mock 把消息链路整个跑一遍。
 *
 * polyfill 语义要点：监听器返回 Promise 即「认领」响应通道。
 * mock 故意把 offscreen 的监听器排在 background 前面投递（最坏顺序）。
 *
 * v0.2 起下载是后台任务：DOWNLOAD 立即返回，进度靠 PROGRESS 广播，
 * 暂停/继续/取消映射到 downloads.pause/resume/cancel。
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

// ---------- 环境 shim（必须在 import 入口之前就位） ----------

type Listener = (msg: unknown, sender: unknown, sendResponse: () => void) => unknown;

const contentListeners: Listener[] = [];
const runtimeListeners: Listener[] = [];

const progressLog: any[] = [];
const downloadCalls: Array<{ url: string; filename: string }> = [];
const dnrRules: any[] = [];
const offscreenEvents: string[] = [];
/** downloads.cancel 被调用的 id（验证「抓取期间被取消」路径会撤掉刚发起的下载） */
const cancelCalls: number[] = [];
/** /held/ 路由挂起的响应；releaseHeld() 一次性放行，模拟 offscreen 里长时间进行中的抓取 */
const heldReleasers: Array<() => void> = [];
const heldSockets: Array<{ destroy: () => void }> = [];
/** /ranged/ 路由收到的 Range 请求头（无则 'none'）与被客户端中止的请求数 */
const rangedLog: string[] = [];
const rangedAborted: string[] = [];
const RANGED_SIZE = 5000;
/** /imgs/ 路由收到的请求（模式:Range） */
const probeLog: string[] = [];
/** /dropmid/ 路由收到的 Range 请求头 */
const dropLog: string[] = [];
/** /trickle/ 路由的分段放行器：每调用一个放出一段，模拟慢网下持续推进的大文件 */
const trickleStages: Array<() => void> = [];
function releaseHeld() {
  heldReleasers.splice(0).forEach((fn) => fn());
}
const badgeLog: string[] = [];
const pausedIds = new Set<number>();
const shownIds: Array<number | 'default'> = [];
const downloadChangedListeners: Array<(d: unknown) => void> = [];
const storageData: Record<string, unknown> = {};
const downloadStates = new Map<number, 'in_progress' | 'complete' | 'interrupted'>();

let failDownloadUrls = new Set<string>();
/** 这些地址的下载会以 SERVER_FORBIDDEN 中断（模拟防盗链 403） */
let forbidDownloadUrls = new Set<string>();
let nextDownloadId = 1;
let offscreenHasDoc = false;
/** true 时新下载停在 in_progress，等待测试手动触发完成 */
let holdDownloads = false;
const heldIds: number[] = [];
/** 设了就让 downloads.download() 调用本身挂住（模拟 await download() 尚未返回 id 的那段时间） */
let gateDownloadCall: Promise<void> | null = null;
/** downloads.search 回包延迟（毫秒）与中断原因 */
let searchDelay = 0;
const downloadErrors = new Map<number, string>();

function fireChanged(id: number, state: 'complete' | 'interrupted') {
  downloadChangedListeners.forEach((fn) => fn({ id, state: { current: state } }));
}

async function deliver(listeners: Listener[], msg: unknown): Promise<unknown> {
  let claimed: Promise<unknown> | null = null;
  for (const fn of listeners) {
    const r = fn(msg, {}, () => {});
    if (claimed === null && r && typeof (r as any).then === 'function') {
      claimed = r as Promise<unknown>;
    }
  }
  return claimed ? await claimed : undefined;
}

/** storage.get 的延迟（毫秒）：真实 storage 读取是异步 IPC，冷启动竞态只在「读取中」这段空档里发生 */
let storageGetDelay = 0;
const mkStorageArea = (prefix: string) => ({
  // 和真实 chrome.storage 一样返回副本（之前直接返回存档对象本身：改了读出来的对象就等于改了存储，会掩盖 bug）
  get: async (k: string) => {
    if (storageGetDelay) await new Promise((r) => setTimeout(r, storageGetDelay));
    const v = storageData[prefix + k];
    return { [k]: v === undefined ? undefined : JSON.parse(JSON.stringify(v)) };
  },
  set: async (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) storageData[prefix + k] = JSON.parse(JSON.stringify(v));
  },
  remove: async (k: string) => { delete storageData[prefix + k]; },
});

const browserMock = {
  runtime: {
    onMessage: {
      addListener: (fn: Listener) => runtimeListeners.push(fn),
      removeListener: () => {},
    },
    sendMessage: async (msg: any) => {
      if (msg?.type === 'PROGRESS') {
        progressLog.push(msg.progress);
        return undefined;
      }
      return deliver(runtimeListeners, msg);
    },
  },
  tabs: {
    sendMessage: async (_t: number, msg: unknown) => deliver(contentListeners, msg),
    onUpdated: { addListener: (fn: any) => { (globalThis as any).__tabUpdated = fn; } },
  },
  action: {
    setBadgeText: async (o: { text: string }) => { badgeLog.push(o.text); },
    setBadgeBackgroundColor: async () => {},
  },
  storage: { local: mkStorageArea('local:'), session: mkStorageArea('session:') },
  downloads: {
    download: async (opts: { url: string; filename: string }) => {
      if (gateDownloadCall) await gateDownloadCall;
      if (failDownloadUrls.has(opts.url)) throw new Error('NETWORK_FAILED');
      downloadCalls.push({ url: opts.url, filename: opts.filename });
      const id = nextDownloadId++;
      downloadStates.set(id, 'in_progress');
      if (forbidDownloadUrls.has(opts.url)) {
        setTimeout(() => {
          downloadStates.set(id, 'interrupted');
          downloadChangedListeners.forEach((fn) =>
            fn({ id, state: { current: 'interrupted' }, error: { current: 'SERVER_FORBIDDEN' } }));
        }, 5);
      } else if (holdDownloads) heldIds.push(id);
      else setTimeout(() => { downloadStates.set(id, 'complete'); fireChanged(id, 'complete'); }, 5);
      return id;
    },
    search: async (q: { id: number }) => {
      const state = downloadStates.get(q.id);
      const error = downloadErrors.get(q.id);
      if (searchDelay) await sleep(searchDelay); // 模拟 search 回包慢于事件
      return state ? [{ id: q.id, state, ...(error ? { error } : {}) }] : [];
    },
    pause: async (id: number) => { pausedIds.add(id); },
    resume: async (id: number) => {
      pausedIds.delete(id);
      setTimeout(() => { downloadStates.set(id, 'complete'); fireChanged(id, 'complete'); }, 5);
    },
    cancel: async (id: number) => {
      cancelCalls.push(id);
      const i = heldIds.indexOf(id);
      if (i >= 0) heldIds.splice(i, 1);
      setTimeout(() => { downloadStates.set(id, 'interrupted'); fireChanged(id, 'interrupted'); }, 5);
    },
    show: async (id: number) => { shownIds.push(id); },
    showDefaultFolder: async () => { shownIds.push('default'); },
    onChanged: {
      addListener: (fn: (d: unknown) => void) => downloadChangedListeners.push(fn),
      removeListener: (fn: (d: unknown) => void) => {
        const i = downloadChangedListeners.indexOf(fn);
        if (i >= 0) downloadChangedListeners.splice(i, 1);
      },
    },
  },
  declarativeNetRequest: {
    // 与真实 API 一致的增量语义：removeRuleIds 删指定、addRules 增
    getSessionRules: async () => [...dnrRules],
    updateSessionRules: async (opts: { removeRuleIds?: number[]; addRules?: any[] }) => {
      const rm = new Set(opts.removeRuleIds ?? []);
      const kept = dnrRules.filter((r) => !rm.has(r.id));
      // 和 Chrome 一致：id 冲突直接报错（并发写规则分到同一 id 的 bug 要能在这里暴露）
      const ids = [...kept, ...(opts.addRules ?? [])].map((r) => r.id);
      const dup = ids.find((id, i) => ids.indexOf(id) !== i);
      if (dup != null) throw new Error(`Rule with id ${dup} does not have a unique ID.`);
      dnrRules.length = 0;
      dnrRules.push(...kept, ...(opts.addRules ?? []));
    },
  },
  scripting: { executeScript: async () => {} },
  webRequest: {
    onResponseStarted: {
      addListener: (fn: any) => { (globalThis as any).__wrFire = fn; },
    },
  },
};

(globalThis as any).browser = browserMock;
(globalThis as any).chrome = {
  offscreen: {
    hasDocument: async () => offscreenHasDoc,
    createDocument: async () => { offscreenHasDoc = true; offscreenEvents.push('create'); },
    closeDocument: async () => { offscreenHasDoc = false; offscreenEvents.push('close'); },
  },
};
(globalThis as any).defineBackground = (fn: () => void) => fn;
(globalThis as any).defineContentScript = (c: { main: () => void }) => c;

// 测试必须与网络隔离：只放行本地测试服务器。之前有用例会让 offscreen 真的去连 B站 CDN /
// 解析 cdn.example 这类域名，结果取决于当时的网络和 DNS，偶发超时（测试本身不可靠）
const realFetch = globalThis.fetch;
(globalThis as any).fetch = (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(url)) {
    const signal: AbortSignal | undefined = init?.signal;
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    return Promise.reject(new TypeError(`Failed to fetch（测试隔离外网：${url}）`));
  }
  return realFetch(input, init);
};

// Node 没有 URL.createObjectURL/revokeObjectURL（浏览器 API）——offscreen 生成 blob 要用
let objUrlSeq = 0;
/** offscreen 生成的每个 blob 的大小（核对续抓后拼出的是完整文件） */
const blobSizes: number[] = [];
(globalThis as any).URL.createObjectURL = (b?: { size?: number }) => {
  blobSizes.push(b?.size ?? -1);
  return `blob:og-test/${++objUrlSeq}`;
};
(globalThis as any).URL.revokeObjectURL = () => {};

// content script 会挂 window.addEventListener 接收页面世界注入脚本的上报
const windowListeners: Array<(e: any) => void> = [];
(globalThis as any).window = {
  scrollY: 0,
  innerHeight: 800,
  scrollTo: () => {},
  addEventListener: (_t: string, fn: (e: any) => void) => { windowListeners.push(fn); },
};
/** 模拟 MAIN world 注入脚本 postMessage 上来一条媒体 */
function postFromPage(url: string, contentType = 'video/mp4') {
  const ev = { source: (globalThis as any).window, data: { tag: '__gleaner_media__', url, contentType } };
  windowListeners.forEach((fn) => fn(ev));
}
/** 页面里唯一的 <video>：放在 <section id="comments" class="comment-list"><h2>评论</h2> 里 */
const fakeSection = {
  tagName: 'SECTION', id: 'comments', className: 'comment-list',
  getAttribute: () => null,
  querySelector: (sel: string) => (/h1|h2|h3/.test(sel) ? { textContent: ' 评论 ' } : null),
  parentElement: null,
};
const fakeVideo = {
  tagName: 'VIDEO', currentSrc: 'https://site.example/v/clip.mp4', src: 'https://site.example/v/clip.mp4',
  videoWidth: 640, videoHeight: 360,
  querySelectorAll: () => [],
  closest: () => null,
  parentElement: fakeSection,
};
(globalThis as any).document = {
  images: [],
  querySelectorAll: (sel: string) => (sel === 'video' ? [fakeVideo] : []),
  querySelector: () => null,
  documentElement: { lang: 'zh' },
  body: {},
  title: '测试页',
};
(globalThis as any).location = { href: 'https://fixture.test/page' };
(globalThis as any).getComputedStyle = () => ({ backgroundImage: 'none' });

// ---------- 本地图片服务器 + 加载入口 ----------

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="teal"/></svg>';
let server: http.Server;
let origin = '';

before(async () => {
  server = http.createServer((req, res) => {
    if (req.url?.endsWith('.svg')) {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end(SVG);
    } else if (req.url?.startsWith('/held/')) {
      // 先发 100 字节、其余挂起等 releaseHeld() —— 让 offscreen 抓取稳定停在「进行中」
      const body = Buffer.alloc(4096, 1);
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
      res.write(body.subarray(0, 100));
      heldSockets.push(res);
      heldReleasers.push(() => res.end(body.subarray(100)));
    } else if (req.url?.startsWith('/ranged/')) {
      // 支持断点续传的 CDN：带 Range 回 206 + 剩余字节；首个完整请求发 1000 字节后挂住（模拟大文件下到一半）
      const body = Buffer.alloc(RANGED_SIZE, 7);
      const range = req.headers.range;
      rangedLog.push(range ?? 'none');
      const m = /bytes=(\d+)-/.exec(range ?? '');
      if (m) {
        const start = Number(m[1]);
        res.writeHead(206, {
          'content-type': 'video/mp4',
          'content-length': String(RANGED_SIZE - start),
          'content-range': `bytes ${start}-${RANGED_SIZE - 1}/${RANGED_SIZE}`,
        });
        res.end(body.subarray(start));
      } else {
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(RANGED_SIZE) });
        res.write(body.subarray(0, 1000));
        req.on('close', () => { if (!res.writableEnded) rangedAborted.push(req.url ?? ''); });
        heldSockets.push(res);
      }
    } else if (req.url?.startsWith('/trickle/')) {
      // 100 字节 → 等放行 → 600KB（越过 512KB 进度阈值）→ 等放行 → 收尾
      const total = 100 + 600 * 1024 + 100;
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(total) });
      res.write(Buffer.alloc(100, 1));
      heldSockets.push(res);
      trickleStages.push(
        () => res.write(Buffer.alloc(600 * 1024, 1)),
        () => res.end(Buffer.alloc(100, 1)),
      );
    } else if (req.url?.startsWith('/html/')) {
      // 复现 captive portal / CDN 灰度错误页：200 但回的是网页，不能被存成 .mp4
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>not a video</body></html>');
    } else if (req.url?.startsWith('/imgs/')) {
      // 真实样图：/imgs/range/<文件> 支持 Range；/imgs/norange/<文件> 不理 Range、整张发
      const [, , mode, name] = (req.url ?? '').split('?')[0].split('/');
      const body = readFileSync(new URL(`./fixtures/images/${name}`, import.meta.url));
      probeLog.push(`${mode}:${req.headers.range ?? 'none'}`);
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
      if (mode === 'range' && m) {
        const end = Math.min(Number(m[2]), body.length - 1);
        res.writeHead(206, {
          'content-type': 'image/jpeg', 'content-length': String(end - Number(m[1]) + 1),
          'content-range': `bytes ${m[1]}-${end}/${body.length}`,
        });
        res.end(body.subarray(Number(m[1]), end + 1));
      } else {
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) });
        res.end(body);
      }
    } else if (req.url?.startsWith('/dropmid/')) {
      // 主 CDN 下到一半断开（大陆网络下常见）：发 1000 字节后直接掐断连接
      dropLog.push(req.headers.range ?? 'none');
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': '5000' });
      res.write(Buffer.alloc(1000, 5));
      setTimeout(() => res.destroy(), 30);
    } else if (req.url?.startsWith('/slowforbid/')) {
      // 晚一点才 403：让同一次合并的另一条轨先抓到一部分字节
      setTimeout(() => {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<html>403</html>');
      }, 200);
    } else if (req.url?.startsWith('/forbid/')) {
      // 复现 B站 签名过期：403 + HTML 错误页
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('<html>403</html>');
    } else if (/\.(m4s|mp4|m4a)/.test(req.url ?? '')) {
      // 供 offscreen 直接抓取用（新的页面通道 byte-flow）
      res.writeHead(200, { 'content-type': 'video/mp4' });
      res.end(Buffer.alloc(4096, 1));
    } else {
      res.writeHead(404);
      res.end('nope');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  await import('../src/entrypoints/offscreen/main'); // 故意先注册（最坏投递顺序）
  const bg = (await import('../src/entrypoints/background')).default as unknown as () => void;
  bg();
  const content = (await import('../src/entrypoints/content')).default as { main: () => void };
  const realAdd = browserMock.runtime.onMessage.addListener;
  browserMock.runtime.onMessage.addListener = (fn: Listener) => contentListeners.push(fn);
  content.main();
  browserMock.runtime.onMessage.addListener = realAdd;
});

after(() => {
  // 仍挂着的 /held/ 连接会让 server.close() 永远等不到，先掐断
  releaseHeld();
  heldSockets.splice(0).forEach((s) => s.destroy());
  server.close();
});

const mk = (url: string) => ({
  id: url, url, originalUrl: url, width: 0, height: 0,
  ext: (url.match(/\.([a-z0-9]{2,5})$/i)?.[1] ?? 'jpg').toLowerCase(),
  source: 'img' as const,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('waitFor 超时');
    await sleep(10);
  }
}
const lastState = () => progressLog.at(-1)?.state;
/** 异步条件版 waitFor（同步版传 async 函数会被 Promise 的真值骗过，立刻通过） */
async function waitForAsync(cond: () => Promise<boolean>, ms = 2000) {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('waitForAsync 超时');
    await sleep(10);
  }
}

function resetLogs() {
  progressLog.length = 0;
  downloadCalls.length = 0;
  badgeLog.length = 0;
  shownIds.length = 0;
  failDownloadUrls = new Set();
  forbidDownloadUrls = new Set();
  holdDownloads = false;
  heldIds.length = 0;
}

// ---------- 场景 ----------

test('SCAN 消息经 content script 往返', async () => {
  const res: any = await browserMock.tabs.sendMessage(1, {
    type: 'SCAN',
    options: { autoScroll: false, minSize: 200, includeBackground: false },
  });
  assert.equal(res?.ok, true);
  assert.deepEqual(res.result.items, []);
  assert.deepEqual(res.result.page, { ogType: undefined, description: undefined, headings: [], lang: 'zh' });
});

test('PAGE_INFO 消息经 content script 往返', async () => {
  const res: any = await browserMock.tabs.sendMessage(1, { type: 'PAGE_INFO' });
  assert.equal(res?.ok, true);
  assert.deepEqual(res.page.headings, []);
  assert.equal(res.page.lang, 'zh');
});

test('MEDIA_SCAN：<video> 带区块面包屑；注入脚本先报过同一 URL 也不能把面包屑弄丢', async () => {
  // 先让页面钩子报一次同一个地址（注入脚本每 3 秒会扫 <video> 上报，和标签扫描必然撞车）
  postFromPage('https://site.example/v/clip.mp4', '');
  const res: any = await browserMock.tabs.sendMessage(1, { type: 'MEDIA_SCAN' });
  assert.equal(res?.ok, true);
  const clip = res.media.filter((m: any) => m.url === 'https://site.example/v/clip.mp4');
  assert.equal(clip.length, 1, '同一 URL 只该有一条');
  assert.equal(clip[0].kind, 'video');
  assert.equal(clip[0].section, '评论区 › 评论');
  assert.equal(clip[0].width, 640);
});

test('DOWNLOAD 立即返回，后台跑完：文件名、DNR、真实计数、角标、记录', async () => {
  resetLogs();
  failDownloadUrls = new Set(['https://bad.example/broken.svg']);
  const items = [
    mk('https://wx3.sinaimg.cn/large/abc.jpg'),
    mk(`${origin}/a.svg`),
    mk('https://bad.example/broken.svg'),
  ];
  const res: any = await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items,
    options: { concurrency: 2, subfolder: '', asZip: false },
    pageTitle: '标题: 测试', pageUrl: 'https://fixture.test/page',
  });
  assert.equal(res?.ok, true); // 立即返回，不等下载完

  await waitFor(() => lastState() === 'done');
  const last = progressLog.at(-1);
  assert.equal(last.done, 2);
  assert.equal(last.failed, 1);
  assert.ok(downloadCalls.every((c) => c.filename.startsWith('Gleaner/标题_ 测试/')));
  assert.ok(downloadCalls.some((c) => c.filename.includes('001_abc.jpg')));
  const weiboRule = dnrRules.find((r) => r.condition.urlFilter.includes('sinaimg.cn'));
  assert.equal(weiboRule?.action.requestHeaders[0].value, 'https://weibo.com/');
  // 角标最终态：有失败 → '!'
  assert.equal(badgeLog.at(-1), '!');
  // 记录已写入
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.history[0].done, 2);
  assert.equal(st.history[0].failed, 1);
  assert.ok(st.history[0].firstDownloadId != null);
});

test('暂停停止派发与在途、继续后补位跑完', async () => {
  resetLogs();
  holdDownloads = true; // 下载挂起不完成，模拟慢速大文件
  const items = [1, 2, 3, 4].map((i) => mk(`${origin}/p${i}.svg`));
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items,
    options: { concurrency: 2, subfolder: '', asZip: false }, pageTitle: 'pause 测试',
  });
  await waitFor(() => downloadCalls.length === 2); // 并发 2，先派 2 个

  const p: any = await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'pause' });
  assert.equal(p.state, 'paused');
  assert.equal(pausedIds.size, 2, '在途下载应被原生 pause');

  // 暂停期间手动完成一个在途项，不应派发新项
  const done1 = heldIds.shift()!;
  downloadStates.set(done1, 'complete');
  fireChanged(done1, 'complete');
  await sleep(30);
  assert.equal(downloadCalls.length, 2, '暂停中不得派发新下载');

  holdDownloads = false;
  const r: any = await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'resume' });
  assert.equal(r.state, 'running');
  // resume 会让被 pause 的在途项完成，随后队列补位跑完
  const remaining = [...heldIds];
  heldIds.length = 0;
  remaining.forEach((id) => { downloadStates.set(id, 'complete'); fireChanged(id, 'complete'); });
  await waitFor(() => lastState() === 'done');
  assert.equal(progressLog.at(-1).done, 4);
  assert.equal(downloadCalls.length, 4);
});

test('取消：在途 cancel、待派项标记取消、任务收尾进记录', async () => {
  resetLogs();
  holdDownloads = true;
  const items = [1, 2, 3, 4].map((i) => mk(`${origin}/c${i}.svg`));
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items,
    options: { concurrency: 2, subfolder: '', asZip: false }, pageTitle: 'cancel 测试',
  });
  await waitFor(() => downloadCalls.length === 2);

  const res: any = await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  assert.equal(res.state, 'cancelled');
  // 记录在最后一个 interrupted 事件收尾时写入（广播 cancelled 状态早于此），等记录出现
  await waitFor(() => progressLog.some((p) => p.message === '已取消'));
  assert.equal(downloadCalls.length, 2, '取消后不得再派发');
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.history[0].title, 'cancel 测试');
  // 防重入：cancel 记录只能有一条
  assert.equal(st.history.filter((h: any) => h.title === 'cancel 测试').length, 1);
});

test('GET_STATE 恢复任务视图（弹窗重开场景）', async () => {
  resetLogs();
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.ok, true);
  assert.equal(st.progress.state, 'cancelled'); // 上一个任务的最终态还能看到
  assert.ok(Array.isArray(st.history));
});

test('REVEAL 定位文件 / 打开下载目录；记录被 Chrome 清掉时退回默认目录并说明', async () => {
  resetLogs();
  downloadStates.set(42, 'complete');
  await browserMock.runtime.sendMessage({ type: 'REVEAL', downloadId: 42 });
  await browserMock.runtime.sendMessage({ type: 'REVEAL' });
  assert.deepEqual(shownIds, [42, 'default']);
  // 用户清空过 Chrome 下载列表：downloads.show 对它是静默无效的，之前点了没任何反应
  const r: any = await browserMock.runtime.sendMessage({ type: 'REVEAL', downloadId: 99999 });
  assert.deepEqual(shownIds, [42, 'default', 'default']);
  assert.match(r.note ?? '', /已被清除.*默认下载目录/);
});

test('ZIP：offscreen 生命周期 + 真实抓取打包 + 真实计数上报', async () => {
  resetLogs();
  const items = [mk(`${origin}/a.svg`), mk(`${origin}/b.svg`), mk(`${origin}/missing.png`)];
  const res: any = await browserMock.runtime.sendMessage({ type: 'ZIP', items, name: '打包测试' });
  assert.equal(res?.ok, true);
  // ZIP 结束后不再 closeDocument：offscreen 是全局单例，关掉会把并发中的 DASH 抓取/合并整个打断
  assert.deepEqual(offscreenEvents, ['create'], 'ZIP 不应关闭 offscreen 文档');
  assert.equal(offscreenHasDoc, true, 'ZIP 后 offscreen 文档应仍然存活');
  assert.equal(downloadCalls.length, 1);
  assert.ok(downloadCalls[0].url.startsWith('blob:'));
  assert.equal(downloadCalls[0].filename, '打包测试.zip');
  const last = progressLog.at(-1);
  assert.equal(last.done, 2);
  assert.equal(last.failed, 1);
});

test('回归：offscreen 存活时 DOWNLOAD 不被抢答', async () => {
  resetLogs();
  offscreenHasDoc = true;
  const res: any = await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/z.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: 'x',
  });
  offscreenHasDoc = false;
  assert.equal(res?.ok, true, 'DOWNLOAD 响应被 offscreen 监听器抢答');
  await waitFor(() => lastState() === 'done');
});

test('丢事件自愈：完成事件丢失后 GET_STATE 对账修正（0/1 卡死回归）', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/lost.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '丢事件测试',
  });
  await waitFor(() => downloadCalls.length === 1);
  // 模拟事件丢失：下载在浏览器里已完成，但 onChanged 从未送达（扩展重载缝隙）
  const id = heldIds.shift()!;
  downloadStates.set(id, 'complete');
  await sleep(20);
  // 弹窗重开 → GET_STATE 对账 → 任务应被修正为完成并写入记录
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.progress.state, 'done', '对账未能救回丢失的完成事件');
  assert.equal(st.progress.done, 1);
  assert.equal(st.items[0].status, 'done');
  assert.equal(st.history[0].title, '丢事件测试');
  assert.equal(st.history[0].state, 'done');
  holdDownloads = false;
});

test('历史开始即写入（Chrome 同款），结束时原地更新不重复', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/h1.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '即时历史',
  });
  await waitFor(() => downloadCalls.length === 1);
  let st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  const running = st.history.find((h: any) => h.title === '即时历史');
  assert.ok(running, '任务开始后历史里应立即可见');
  assert.equal(running.state, 'running');
  assert.ok(Array.isArray(st.items) && st.items.length === 1, '应返回当前任务文件列表');

  const id = heldIds.shift()!;
  downloadStates.set(id, 'complete');
  fireChanged(id, 'complete');
  await waitFor(() => lastState() === 'done');
  st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  const entries = st.history.filter((h: any) => h.title === '即时历史');
  assert.equal(entries.length, 1, '结束时应原地更新而不是再插一条');
  assert.equal(entries[0].state, 'done');
  holdDownloads = false;
});

test('媒体嗅探：捕获视频请求、导航清空、DOWNLOAD_MEDIA 走任务系统', async () => {
  resetLogs();
  const fire = (globalThis as any).__wrFire;
  await fire({ tabId: 7, url: 'https://cdn.example/v/a.mp4', responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '5242880' }] });
  await fire({ tabId: 7, url: 'https://cdn.example/v/a.mp4', responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' }] }); // 重复应去重
  await fire({ tabId: 7, url: 'https://cdn.example/hls/index.m3u8', responseHeaders: [
    { name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }] });
  await fire({ tabId: 7, url: 'https://cdn.example/x.json', responseHeaders: [
    { name: 'Content-Type', value: 'application/json' }] }); // 非媒体不收
  await fire({ tabId: 8, url: 'https://cdn.example/other.mp4', responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' }] }); // 别的标签页

  // 埋点接口带 .ts 后缀但 content-type 不是媒体 —— 必须挡掉（data.bilibili.com 误判）
  await fire({ tabId: 7, url: 'https://data.example.com/log/track.ts', responseHeaders: [
    { name: 'Content-Type', value: 'text/plain' }] });

  // B站式 DASH：同一轨的几百个分片是对同一 URL 的 Range 请求，应归并成 1 条可下载轨
  for (let i = 0; i < 30; i++) {
    await fire({ tabId: 7, url: `https://up.example/v/x-1-30080.m4s?range=${i}00-${i}99`, responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' }] });
    await fire({ tabId: 7, url: `https://up.example/v/x-1-30280.m4s?range=${i}00-${i}99`, responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' }] });
  }

  let st: any = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 7 });
  assert.ok(!st.media.some((m: any) => m.url.includes('track.ts')), '埋点接口不应被当成媒体');

  const tracks = st.media.filter((m: any) => m.streamKind === 'dash-track');
  assert.equal(tracks.length, 2, `同轨分片应归并，实际 ${tracks.length} 条`);
  assert.equal(tracks[0].segments, 30, '应记录分片数');
  assert.ok(tracks[0].url.endsWith('-30080.m4s'), '轨道 URL 应剥掉 range 参数');
  assert.equal(tracks.find((t: any) => t.url.includes('30080'))?.track, 'video');
  assert.equal(tracks.find((t: any) => t.url.includes('30280'))?.track, 'audio');

  const videos = st.media.filter((m: any) => m.kind === 'video');
  assert.equal(videos.length, 1, '真视频 1 条');
  assert.equal(videos[0].size, 5242880);

  // 下载媒体：走任务系统，Referer 用页面来源
  const res: any = await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: 'https://cdn.example/v/a.mp4',
    pageTitle: '视频页', pageUrl: 'https://site.example/watch',
  });
  assert.equal(res.ok, true);
  await waitFor(() => lastState() === 'done');
  assert.ok(downloadCalls.at(-1)?.filename.endsWith('.mp4'));
  // 媒体 Referer 规则用 2900-2999 号段（一次可能有多个域名：画面+声音、混合任务）
  const rule = dnrRules.find((r) => r.id >= 2900 && r.id < 3900);
  assert.equal(rule?.action.requestHeaders[0].value, 'https://site.example/');

  // DASH 音频轨下载：.m4s 走页面通道（offscreen 直接抓 + 生成 blob），
  // 文件名应改成播放器认得的 .m4a。URL 指向本地 server 让真实抓取能成功。
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/v/x-1-30280.m4s`,
    pageTitle: '轨道', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => downloadCalls.some((c) => c.filename.endsWith('.m4a')), 4000);
  assert.ok(
    downloadCalls.some((c) => c.filename.endsWith('.m4a')),
    downloadCalls.map((c) => c.filename).join(', '),
  );

  // 导航发生 → 该标签页记录清空
  (globalThis as any).__tabUpdated(7, { status: 'loading', url: 'https://x/new' });
  st = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 7 });
  assert.equal(st.media.length, 0);
});

test('SW 被回收后嗅探记录不丢（内存清空仍能从 storage 恢复）', async () => {
  resetLogs();
  const fire = (globalThis as any).__wrFire;
  await fire({ tabId: 21, url: 'https://cdn.example/keep/movie.mp4', responseHeaders: [
    { name: 'Content-Type', value: 'video/mp4' }, { name: 'Content-Length', value: '1048576' }] });
  await sleep(600); // 等合并写盘

  // 模拟 MV3 service worker 被回收：内存里的 Map 整个没了，只剩 storage
  const bgMod: any = await import('../src/entrypoints/background');
  void bgMod;
  const saved = storageData['session:og-media'] as any;
  assert.ok(saved && saved['21']?.length === 1, `写盘失败: ${JSON.stringify(saved)}`);

  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 21 });
  assert.equal(st.media.length, 1, 'SW 唤醒后应从 storage 恢复嗅探记录');
  assert.equal(st.media[0].size, 1048576);
});

/**
 * 真冷启动：导入一个全新的 background 模块实例（内存全空，只剩 storage），
 * 让它独占消息 / 嗅探 / 导航监听；用完把原实例的监听还回去。
 * 之前的「SW 回收」测试用的是同一个已缓存的模块实例，内存根本没清空，测了个寂寞（审查实锤）
 */
let coldSeq = 0;
async function withColdBackground(fn: () => Promise<void>) {
  const savedRuntime = runtimeListeners.splice(0);
  const savedWr = (globalThis as any).__wrFire;
  const savedTab = (globalThis as any).__tabUpdated;
  const dlBefore = downloadChangedListeners.length;
  storageGetDelay = 15;
  try {
    const mod = await import(`../src/entrypoints/background.ts?cold=${++coldSeq}`);
    (mod.default as unknown as () => void)();
    await fn();
  } finally {
    storageGetDelay = 0;
    runtimeListeners.splice(0, runtimeListeners.length, ...savedRuntime);
    (globalThis as any).__wrFire = savedWr;
    (globalThis as any).__tabUpdated = savedTab;
    downloadChangedListeners.splice(dlBefore);
  }
}

const hitOf = (url: string) => ({ url, kind: 'stream', streamKind: 'dash-track', track: 'video', via: 'sniffer', segments: 1 });
const frag = (tabId: number, url: string) =>
  (globalThis as any).__wrFire({ tabId, url, responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }] });

test('冷启动（新模块实例）：唤醒后第一个请求就是 GET_MEDIA，也能拿到存档里的记录', async () => {
  storageData['session:og-media'] = { '31': [hitOf('https://cdn.example/c/old-1-30080.m4s')] };
  await withColdBackground(async () => {
    // SW 是被别的标签页的嗅探事件唤醒的，弹窗的 GET_MEDIA 紧跟着到
    const woke = frag(99, 'https://cdn.example/c/other-1-30080.m4s?range=0');
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 31 });
    await woke;
    assert.equal(st.media.length, 1, `唤醒瞬间不应返回空列表：${JSON.stringify(st.media)}`);
  });
});

test('冷启动（新模块实例）：同一标签页紧接着两个嗅探事件，存档里的旧轨不丢', async () => {
  storageData['session:og-media'] = {
    '32': [hitOf('https://cdn.example/c/old-1-30080.m4s'), hitOf('https://cdn.example/c/old-1-30280.m4s')],
  };
  await withColdBackground(async () => {
    await Promise.all([
      frag(32, 'https://cdn.example/c/new-1-30080.m4s?range=0'),
      frag(32, 'https://cdn.example/c/new-1-30280.m4s?range=0'),
    ]);
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 32 });
    const names = st.media.map((m: any) => m.url.split('/').pop().split('?')[0]).sort();
    assert.deepEqual(names, ['new-1-30080.m4s', 'new-1-30280.m4s', 'old-1-30080.m4s', 'old-1-30280.m4s']);
  });
});

test('冷启动（新模块实例）：被别的标签页导航唤醒，不清掉其它标签页的记录', async () => {
  storageData['session:og-media'] = {
    '33': [hitOf('https://cdn.example/c/keep-1-30080.m4s')],
    '34': [hitOf('https://cdn.example/c/gone-1-30080.m4s')],
  };
  await withColdBackground(async () => {
    await (globalThis as any).__tabUpdated(34, { status: 'loading', url: 'https://x/other' });
    const a: any = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 33 });
    const b: any = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 34 });
    assert.equal(a.media.length, 1, '标签页 33 的记录不能被 34 的导航清掉');
    assert.equal(b.media.length, 0, '导航走的 34 应清空');
  });
});

test('博客里嵌的 B站 播放器：下载时 upos 节点的 Referer 用 bilibili.com，不用外层博客的域名', async () => {
  resetLogs();
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: 'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/e/m/emb-1-30032.m4s?upsig=x',
    pageTitle: '博客嵌入', pageUrl: 'https://blog.example/post/1', tabId: 7,
  });
  try {
    const rule = dnrRules.find((r) => r.condition.urlFilter === '||upos-sz-mirrorcosov.bilivideo.com');
    assert.equal(rule?.action.requestHeaders[0].value, 'https://www.bilibili.com/');
  } finally {
    await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
    await sleep(50);
  }
});

test('iframe 里的第三方播放器：嗅探记下发起请求的 frame 来源，下载时拿它当 Referer', async () => {
  resetLogs();
  await (globalThis as any).__wrFire({
    tabId: 41, frameId: 3, initiator: 'https://player.example', url: 'https://cdn.player.example/v/clip.mp4',
    responseHeaders: [{ name: 'Content-Type', value: 'video/mp4' }],
  });
  const got: any = await browserMock.runtime.sendMessage({ type: 'GET_MEDIA', tabId: 41 });
  assert.equal(got.media[0]?.referer, 'https://player.example/');
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: 'https://cdn.player.example/v/clip.mp4', referer: got.media[0].referer,
    pageTitle: '嵌入播放器', pageUrl: 'https://blog.example/post/2', tabId: 41,
  });
  try {
    const rule = dnrRules.find((r) => r.condition.urlFilter === '||cdn.player.example');
    assert.equal(rule?.action.requestHeaders[0].value, 'https://player.example/', '应优先用 iframe 自己的来源');
  } finally {
    await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
    await sleep(50);
  }
});

test('图片被防盗链拒绝（直连和页面通道都 403）：提示「有防盗链」，不说「重新播放一下」', async () => {
  resetLogs();
  const pic = `${origin}/forbid/hotlink.jpg`;
  forbidDownloadUrls = new Set([pic]);
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(pic)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '防盗链图', pageUrl: 'https://gallery.example/',
  });
  let st: any;
  await waitForAsync(async () => {
    st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 4000);
  const it = st.items.find((i: any) => /hotlink/.test(i.name));
  assert.equal(it.status, 'failed');
  assert.match(it.error, /防盗链/);
  assert.ok(!/重新播放/.test(it.error), `图片不该让用户「重新播放」：${it.error}`);
});

test('「下载选中」只选了 m3u8：明确说暂不支持，不下任何东西', async () => {
  resetLogs();
  const res: any = await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MIXED', items: [], media: [{ url: `${origin}/live/index.m3u8` }],
    pageTitle: '只有清单', pageUrl: 'https://live.example/', tabId: 7,
  });
  assert.equal(res.ok, false);
  assert.match(res.error, /暂不支持/);
  assert.equal(downloadCalls.length, 0);
});

test('原图尺寸探测：只拉文件头读出真实宽高（支持/不支持 Range、大 EXIF、网页响应）', async () => {
  probeLog.length = 0;
  const res: any = await browserMock.runtime.sendMessage({
    type: 'PROBE_SIZES',
    items: [
      { id: 'a', url: `${origin}/imgs/range/j1601x1203.jpg` },
      { id: 'b', url: `${origin}/imgs/norange/p1601x1203.png` },
      { id: 'c', url: `${origin}/imgs/range/jbigexif1601x1203.jpg` },
      { id: 'd', url: `${origin}/imgs/range/wvp8_1601x1203.webp` },
      { id: 'e', url: `${origin}/html/notimage.jpg` },
      { id: 'f', url: 'data:image/png;base64,xxx' },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.sizes, { a: [1601, 1203], b: [1601, 1203], c: [1601, 1203], d: [1601, 1203] });
  assert.ok(probeLog.filter((l) => l.startsWith('range:')).every((l) => l === 'range:bytes=0-131071'), probeLog.join(' '));
});

test('页面钩子通道：MSE 分片经 postMessage 上报，归并成轨返回给弹窗', async () => {
  postFromPage('https://cdn.example/p/hook-1-30080.m4s?range=0');
  postFromPage('https://cdn.example/p/hook-1-30080.m4s?range=1');
  postFromPage('https://cdn.example/p/hook-1-30280.m4s?range=0');
  postFromPage('https://cdn.example/p/plain.mp4', 'video/mp4');
  // blob: 假地址即使上报也不该进列表（注入脚本已过滤，这里双保险）
  postFromPage('blob:https://cdn.example/fake');

  const res: any = await browserMock.tabs.sendMessage(1, { type: 'MEDIA_SCAN' });
  assert.equal(res.ok, true);
  const urls = res.media.map((m: any) => m.url);
  assert.ok(!urls.some((u: string) => u.startsWith('blob:')), 'blob: 不应出现');

  const tracks = res.media.filter((m: any) => m.streamKind === 'dash-track');
  assert.equal(tracks.length, 2, `同轨分片应归并，实际 ${tracks.length}`);
  assert.equal(tracks.find((t: any) => t.url.includes('30080'))?.segments, 2, '分片计数');
  assert.equal(tracks.find((t: any) => t.url.includes('30280'))?.track, 'audio');
  assert.ok(res.media.some((m: any) => m.url.endsWith('plain.mp4') && m.kind === 'video'));
});

test('B站 清单通道：注入脚本转来的清单让弹窗拿到 H.264 + 声音的一条，而不是播放器在放的 AV1', async () => {
  const { readFileSync } = await import('node:fs');
  const { extractBiliTracks } = await import('../src/core/bili');
  const api = JSON.parse(readFileSync(new URL('./fixtures/bili-playurl-api-av1.json', import.meta.url), 'utf8'));
  const tracks = extractBiliTracks(api);
  const post = (data: unknown) =>
    windowListeners.forEach((fn) => fn({ source: (globalThis as any).window, data }));
  const loc = (globalThis as any).location;

  // 非 B站 页面：同样的消息一律不收（页面脚本能伪造 postMessage）
  post({ tag: '__gleaner_bili__', tracks });
  let res: any = await browserMock.tabs.sendMessage(1, { type: 'MEDIA_SCAN' });
  assert.ok(!res.media.some((m: any) => m.curated), '非 B站 页面不应接受清单');

  loc.hostname = 'www.bilibili.com';
  try {
    post({ tag: '__gleaner_bili__', tracks });
    // 播放器实际在放的 AV1 分片也被钩子报上来了
    postFromPage(`${tracks!.video.find((v) => v.codecid === 13 && v.id === 32)!.url}&range=0-999`);
    res = await browserMock.tabs.sendMessage(1, { type: 'MEDIA_SCAN' });
    const { consolidateMedia } = await import('../src/core/media');
    // 只看这个视频的行（上一条用例经钩子报过别的分片，content script 是同一个实例）
    const rows = consolidateMedia(res.media).filter(
      (m) => m.streamKind === 'dash-track' && m.url.includes('42285466216'),
    );
    assert.equal(rows.length, 1, JSON.stringify(rows.map((r) => r.url.split('?')[0].split('/').pop())));
    assert.equal(rows[0].codec, 'h264');
    assert.match(rows[0].url, /-1-30032\.m4s\?/);
    assert.match(rows[0].pairedAudioUrl ?? '', /-1-30280\.m4s\?/);
  } finally {
    delete loc.hostname;
  }
});

test('直连下载起步期间（download() 还没返回 id）弹窗对账：不得误判为「抓取被中断」', async () => {
  resetLogs();
  let open!: () => void;
  gateDownloadCall = new Promise<void>((r) => (open = r));
  let sent: Promise<unknown> | undefined;
  try {
    // 不 await：DOWNLOAD 的回复要等首批 download() 返回，而它正被 gate 挂着
    sent = browserMock.runtime.sendMessage({
      type: 'DOWNLOAD', items: [mk(`${origin}/gate1.svg`)],
      options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '起步对账',
    });
    await waitFor(() => progressLog.some((p) => p.total === 1 && p.running), 2000);
    await sleep(20);
    // 弹窗开着：GET_STATE 会触发 reconcile。此刻该项 active 且没有 downloadId
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    const it = st.items.find((i: any) => /gate1/.test(i.name));
    assert.equal(it.status, 'active', `起步中的直连下载被误判：${JSON.stringify(it)}`);
  } finally {
    gateDownloadCall = null;
    open();
  }
  await sent;
  await waitFor(() => lastState() === 'done', 3000);
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.items.find((i: any) => /gate1/.test(i.name)).status, 'done');
});

test('用户在 Chrome 下载栏里取消某个文件：记为已取消，不走页面通道重下', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/usercancel.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '下载栏取消',
  });
  await waitFor(() => heldIds.length === 1);
  const id = heldIds.shift()!;
  holdDownloads = false;
  downloadStates.set(id, 'interrupted');
  downloadChangedListeners.forEach((fn) =>
    fn({ id, state: { current: 'interrupted' }, error: { current: 'USER_CANCELED' } }));
  await sleep(200);
  assert.equal(downloadCalls.filter((c) => c.url.startsWith('blob:')).length, 0, '不应经页面通道重下');
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.items.find((i: any) => /usercancel/.test(i.name)).status, 'cancelled');
});

test('页面通道真暂停：抓取中止、不落盘；继续后带 Range 从断点续抓，拼出完整文件', async () => {
  resetLogs();
  rangedLog.length = 0;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/ranged/pausefetch-1-30080.m4s`,
    pageTitle: '真暂停', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => rangedLog.length === 1, 3000);
  await sleep(100); // 让 offscreen 读到前 1000 字节
  const p: any = await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'pause' });
  assert.equal(p.state, 'paused');
  await sleep(200);
  assert.equal(downloadCalls.filter((c) => /真暂停/.test(c.filename)).length, 0, '暂停后不应落盘');
  assert.ok(rangedAborted.length >= 1, '暂停必须真的中止网络请求（之前是后台照样下完）');
  let st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.progress.state, 'paused');

  const sizesBefore = blobSizes.length;
  const r: any = await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'resume' });
  assert.equal(r.state, 'running');
  await waitFor(() => downloadCalls.some((c) => /真暂停/.test(c.filename)), 3000);
  assert.equal(rangedLog[1], 'bytes=1000-', `继续时应从断点续抓，实际请求头 Range=${rangedLog[1]}`);
  assert.equal(blobSizes.slice(sizesBefore).at(-1), RANGED_SIZE, '续抓拼出的应是完整文件');
  await waitForAsync(async () => {
    st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 3000);
});

test('暂停期间所有项已结束（例如直连下载在暂停前一刻完成）：任务收尾，不永远停在「已暂停」', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/lastone.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '暂停收尾',
  });
  await waitFor(() => heldIds.length === 1);
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'pause' });
  const id = heldIds.shift()!;
  holdDownloads = false;
  downloadStates.set(id, 'complete');
  fireChanged(id, 'complete');
  await waitForAsync(async () => {
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 3000);
});

test('下载进行中再点下载：追加进当前任务，旧任务的剩余文件照样下完；重复点同一文件不重复下', async () => {
  resetLogs();
  holdDownloads = true;
  // 同一毫秒连点两次（真实用户双击就是这样）：批次 id 不能撞
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [1, 2, 3].map((i) => mk(`${origin}/first${i}.svg`)),
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '第一批',
  });
  await waitFor(() => heldIds.length === 1);
  // 用户在另一个页面又点了下载（含一个和第一批重复的文件）
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/second1.svg`), mk(`${origin}/first2.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '第二批',
  });
  Date.now = realNow;
  let st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.items.length, 4, `应追加 1 项（重复的 first2 跳过），实际：${st.items.map((i: any) => i.name)}`);
  assert.ok(st.items.some((i: any) => /second1/.test(i.name)));
  holdDownloads = false;
  const release = () => {
    const ids = heldIds.splice(0);
    ids.forEach((id) => { downloadStates.set(id, 'complete'); fireChanged(id, 'complete'); });
  };
  release();
  await waitForAsync(async () => {
    release();
    st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 3000);
  assert.equal(st.items.filter((i: any) => i.status === 'done').length, 4, '两批全部下完');
  const first = st.history.find((h: any) => h.title === '第一批');
  assert.equal(first?.state, 'done', '记录不能永远停在「进行中」');
  assert.equal(first?.total, 3, '第一批自己的记录只算自己的 3 项');
  const second = st.history.find((h: any) => h.title === '第二批');
  assert.equal(second?.total, 1, '追加的这一批要有自己的下载记录（之前记在旧任务标题下）');
  assert.equal(second?.state, 'done');
  assert.ok(!st.history.some((h: any) => h.state === 'running'), JSON.stringify(st.history.map((h: any) => [h.title, h.state])));
});

test('取消页面通道抓取：网络请求真的中止，已抓字节丢弃（再下同一文件从头来）', async () => {
  resetLogs();
  rangedLog.length = 0;
  rangedAborted.length = 0;
  const url = `${origin}/ranged/cancelnet-1-30080.m4s`;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url, pageTitle: '取消断网', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => rangedLog.length === 1, 3000);
  await sleep(100);
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  await sleep(200);
  assert.ok(rangedAborted.length >= 1, '取消必须中止网络请求（之前取消后仍在后台把整个文件下完）');
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url, pageTitle: '取消断网', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => rangedLog.length === 2, 3000);
  assert.equal(rangedLog[1], 'none', '取消后已抓字节应丢弃，重新下载从头开始');
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  await sleep(100);
});

test('升级后的原图地址直连 403、页面通道也 403：退回页面上原本显示的地址，不整项失败', async () => {
  resetLogs();
  const upgraded = `${origin}/forbid/big.jpg`;
  const original = `${origin}/thumb-ok.svg`;
  forbidDownloadUrls = new Set([upgraded]);
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [{ ...mk(upgraded), originalUrl: original }],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '退回原图',
  });
  await waitForAsync(async () => {
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 4000);
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.items[0].status, 'done', JSON.stringify(st.items));
  assert.ok(downloadCalls.some((c) => c.url === original), '应退回原地址直连下载');
});

test('Referer 规则：新任务不删旧任务在用的域名规则；只作用于扩展自己的请求（tabIds -1）', async () => {
  resetLogs();
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: 'https://cdn-a.example/v/a-1-30080.m4s',
    pageTitle: 'A', pageUrl: 'https://site-a.example/watch', tabId: 7,
  });
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: 'https://cdn-b.example/v/b-1-30080.m4s',
    pageTitle: 'B', pageUrl: 'https://site-b.example/watch', tabId: 7,
  });
  const media = dnrRules.filter((r) => r.id >= 2900 && r.id < 3900);
  const a = media.find((r) => r.condition.urlFilter === '||cdn-a.example');
  const b = media.find((r) => r.condition.urlFilter === '||cdn-b.example');
  assert.ok(a && b, `两个域名的规则都应在：${JSON.stringify(media.map((r) => r.condition.urlFilter))}`);
  assert.equal(a.action.requestHeaders[0].value, 'https://site-a.example/');
  assert.ok(media.every((r) => JSON.stringify(r.condition.tabIds) === '[-1]'), '规则必须限定 tabIds:[-1]');
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  await sleep(100);
});

test('B站 备用 CDN：主地址 403 时自动换 backupUrl（画面和声音都换），不整项失败', async () => {
  resetLogs();
  const before = blobSizes.length;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA',
    url: `${origin}/forbid/bk-1-30032.m4s?upsig=a`,
    audioUrl: `${origin}/forbid/bk-1-30280.m4s?upsig=a`,
    backupUrls: [`${origin}/cdn2/bk-1-30032.m4s?upsig=b`],
    audioBackupUrls: [`${origin}/cdn2/bk-1-30280.m4s?upsig=b`],
    pageTitle: '备用线路', pageUrl: 'https://www.bilibili.com/video/BV1', tabId: 7,
  });
  await waitForAsync(async () => {
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 5000);
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  const it = st.items.find((i: any) => /备用线路/.test(i.name));
  // 没有真 ffmpeg 时合并会失败 —— 这里只核对「没有因为主地址 403 而失败」
  assert.ok(!/403|过期/.test(it.error ?? ''), `不应停在主地址的 403：${JSON.stringify(it)}`);
  // Referer 规则要覆盖备用 CDN 的域名（同域名这里只有 127.0.0.1，核对规则存在即可）
  assert.ok(dnrRules.some((r) => r.id >= 2900 && r.condition.urlFilter === '||127.0.0.1'));
  void before;
});

test('B站 备用 CDN（单轨）：主地址 403 → 备用地址抓到完整文件并落盘', async () => {
  resetLogs();
  const before = blobSizes.length;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA',
    url: `${origin}/forbid/solo-1-30280.m4s?upsig=a`,
    backupUrls: [`${origin}/cdn2/solo-1-30280.m4s?upsig=b`],
    pageTitle: '备用单轨', pageUrl: 'https://www.bilibili.com/video/BV1', tabId: 7,
  });
  await waitFor(() => downloadCalls.some((c) => /备用单轨/.test(c.filename)), 4000);
  assert.equal(blobSizes.slice(before).at(-1), 4096, '应从备用地址抓到完整的 4096 字节');
});

test('有已暂停的任务时再点下载：新下载照常开始，暂停的保持暂停；新的下完整体回到「已暂停」，继续后全部下完', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/pz1.svg`), mk(`${origin}/pz2.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '先暂停的',
  });
  await waitFor(() => heldIds.length === 1);
  const firstId = heldIds[0];
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'pause' });
  assert.ok(pausedIds.has(firstId), '在下的应被原生暂停');
  const callsBefore = downloadCalls.length;

  holdDownloads = false;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/pz-new.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '后点的',
  });
  await waitFor(() => downloadCalls.slice(callsBefore).some((c) => /pz-new/.test(c.url)), 2000);
  let st: any;
  await waitForAsync(async () => {
    st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.items.find((i: any) => /pz-new/.test(i.name))?.status === 'done';
  }, 3000);
  assert.equal(st.items.find((i: any) => /pz2/.test(i.name)).status, 'paused', '暂停的项不能被新下载带着跑起来');
  assert.equal(st.progress.state, 'paused', '新的下完、只剩暂停项时，整体回到「已暂停」');
  assert.ok(!downloadCalls.some((c) => /pz2/.test(c.url)), 'pz2 暂停中不应开始');

  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'resume' });
  downloadStates.set(firstId, 'complete');
  fireChanged(firstId, 'complete');
  await waitForAsync(async () => {
    st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 3000);
  assert.ok(st.items.every((i: any) => i.status === 'done'), JSON.stringify(st.items));
});

test('追加进来的图片防盗链重试：Referer 用它自己的页面，而不是第一批的页面', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/refA.svg`)],
    options: { concurrency: 2, subfolder: '', asZip: false }, pageTitle: 'A 页', pageUrl: 'https://site-a.example/page',
  });
  await waitFor(() => heldIds.length === 1);
  holdDownloads = false;
  const pixiv = `${origin}/forbid/pixiv.jpg`;
  forbidDownloadUrls = new Set([pixiv]);
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(pixiv)],
    options: { concurrency: 2, subfolder: '', asZip: false }, pageTitle: 'B 页', pageUrl: 'https://site-b.example/gallery',
  });
  // 按域名精确匹配（别的用例也留下过 site-b 的规则，只看值会被骗过）
  const ruleFor127 = () =>
    dnrRules.find((r) => r.id >= 2900 && r.condition.urlFilter === `||${new URL(origin).hostname}`);
  try {
    await waitFor(() => ruleFor127()?.action.requestHeaders[0].value === 'https://site-b.example/', 3000)
      .catch(() => {});
    assert.equal(ruleFor127()?.action.requestHeaders[0].value, 'https://site-b.example/', '重试要带 B 页自己的 Referer');
  } finally {
    // 不管成败都收掉这个任务，别让后面的用例被追加进来
    await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
    await sleep(50);
  }
});

test('媒体 Referer 规则号段写满后：新域名挤掉最早的，同一批里不会分到重复 id（Chrome 会整批拒绝）', async () => {
  resetLogs();
  const media = () => dnrRules.filter((r) => r.id >= 2900 && r.id < 3900);
  // 灌满号段
  const hosts = Array.from({ length: 1000 }, (_, i) => `fill${i}.cdn.example`);
  const saved = dnrRules.filter((r) => !(r.id >= 2900 && r.id < 3900));
  dnrRules.length = 0;
  dnrRules.push(...saved, ...hosts.map((h, i) => ({
    id: 2900 + i, priority: 1,
    action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://x.example/' }] },
    condition: { urlFilter: `||${h}`, resourceTypes: ['xmlhttprequest'], tabIds: [-1] },
  })));
  const warn = console.warn;
  const warned: unknown[] = [];
  console.warn = (...a: unknown[]) => { warned.push(a); };
  try {
    // 一次同时要：覆盖一个已存在的域名（最早那个 id=2900）+ 两个新域名
    await browserMock.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA', url: 'https://fill0.cdn.example/v/a-1-30032.m4s',
      backupUrls: ['https://new1.cdn.example/v/a-1-30032.m4s', 'https://new2.cdn.example/v/a-1-30032.m4s'],
      pageTitle: '号段满', pageUrl: 'https://www.bilibili.com/video/BVfull', tabId: 7,
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(warned.length, 0, `规则写入被拒：${JSON.stringify(warned)}`);
  const byFilter = (f: string) => media().find((r) => r.condition.urlFilter === f);
  assert.equal(byFilter('||fill0.cdn.example')?.action.requestHeaders[0].value, 'https://www.bilibili.com/');
  assert.ok(byFilter('||new1.cdn.example') && byFilter('||new2.cdn.example'), '新域名都要有规则');
  assert.equal(media().length, 1000, '号段不超额');
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  await sleep(50);
});

test('ZIP 打包失败（全部抓不到）：广播收尾，弹窗进度条不能永远停在「正在打包」', async () => {
  resetLogs();
  const res: any = await browserMock.runtime.sendMessage({
    type: 'ZIP', items: [mk(`${origin}/missing-a.png`), mk(`${origin}/missing-b.png`)], name: '全失败',
  });
  assert.equal(res?.ok, false);
  // 弹窗只认带数字的广播来收尾 ZIP 进度条（total=0 的纯报错广播只进错误条），所以必须有这一条
  const closing = progressLog.find((p) => !p.state && p.total === 2 && p.running === false);
  assert.ok(closing, JSON.stringify(progressLog));
  assert.match(closing.message ?? '', /ZIP 打包失败.*全部图片下载失败/);
});

test('合并时一条轨失败：被连带中止的另一条的断点字节要丢掉（再下同一文件从头来）', async () => {
  resetLogs();
  rangedLog.length = 0;
  const video = `${origin}/ranged/muxfail-1-30032.m4s`;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: video, audioUrl: `${origin}/slowforbid/muxfail-1-30280.m4s`,
    pageTitle: '合并失败', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitForAsync(async () => {
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.items.find((i: any) => /合并失败/.test(i.name))?.status === 'failed';
  }, 4000);
  assert.equal(rangedLog[0], 'none');
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: video, pageTitle: '合并失败重下', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => rangedLog.length === 2, 3000);
  assert.equal(rangedLog[1], 'none', `断点字节应已释放，实际又带了 Range=${rangedLog[1]}`);
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  await sleep(50);
});

test('对账和中断事件赛跑（search 回包晚于事件）：防盗链重试不被作废，图片最终下好', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/race-a.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '对账赛跑',
  });
  await waitFor(() => heldIds.length === 1);
  const id = heldIds.shift()!;
  holdDownloads = false;
  downloadStates.set(id, 'interrupted');
  downloadErrors.set(id, 'SERVER_FORBIDDEN');
  searchDelay = 40;
  try {
    const st = browserMock.runtime.sendMessage({ type: 'GET_STATE' }); // 对账已发出 search
    await sleep(5);
    downloadChangedListeners.forEach((fn) =>
      fn({ id, state: { current: 'interrupted' }, error: { current: 'SERVER_FORBIDDEN' } }));
    await st;
  } finally {
    searchDelay = 0;
  }
  let s2: any;
  await waitForAsync(async () => {
    s2 = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return s2.progress.state === 'done';
  }, 4000);
  const it = s2.items.find((i: any) => /race-a/.test(i.name));
  assert.equal(it.status, 'done', `重试被对账作废：${JSON.stringify(it)}`);
});

test('只有对账发现中断（事件丢了）：对账自己发起防盗链重试，而不是直接判失败', async () => {
  resetLogs();
  holdDownloads = true;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD', items: [mk(`${origin}/race-b.svg`)],
    options: { concurrency: 1, subfolder: '', asZip: false }, pageTitle: '事件丢失',
  });
  await waitFor(() => heldIds.length === 1);
  const id = heldIds.shift()!;
  holdDownloads = false;
  downloadStates.set(id, 'interrupted');
  downloadErrors.set(id, 'SERVER_FORBIDDEN');
  let st: any;
  await waitForAsync(async () => {
    st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 4000);
  const it = st.items.find((i: any) => /race-b/.test(i.name));
  assert.equal(it.status, 'done', JSON.stringify(it));
  assert.ok(downloadCalls.some((c) => c.url.startsWith('blob:') && /race-b/.test(c.filename)), '应经页面通道重下');
});

test('主 CDN 中途断开、备用地址成功：主地址留下的断点字节被释放（不常驻内存）', async () => {
  resetLogs();
  dropLog.length = 0;
  const primary = `${origin}/dropmid/mem-1-30280.m4s`;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: primary, backupUrls: [`${origin}/cdn2/mem-1-30280.m4s`],
    pageTitle: '断开换备用', pageUrl: 'https://www.bilibili.com/video/BV1', tabId: 7,
  });
  await waitFor(() => downloadCalls.some((c) => /断开换备用/.test(c.filename)), 4000);
  // 等第一个任务真正结束：还在下的同一地址会被当成重复点击去重（这是正确行为），第二次请求就发不出去
  await waitForAsync(async () => {
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
    return st.progress.state === 'done';
  }, 4000);
  // 再下一次同一条：主地址若还留着断点字节，这次会带 Range
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: primary, pageTitle: '断开换备用2', pageUrl: 'https://www.bilibili.com/video/BV1', tabId: 7,
  });
  await waitFor(() => dropLog.length === 2, 4000);
  assert.equal(dropLog[1], 'none', `主地址的断点字节没释放，又带了 Range=${dropLog[1]}`);
  await sleep(100);
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  await sleep(50);
});

test('已进入合并阶段（收到 0/0 进度）的项：点暂停不打断它，合完照常落盘', async () => {
  resetLogs();
  rangedLog.length = 0;
  rangedAborted.length = 0;
  const url = `${origin}/ranged/muxing-1-30032.m4s`;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url, pageTitle: '合并中暂停', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => rangedLog.length === 1, 3000);
  // offscreen 抓完两条轨、开始 ffmpeg 合并时会发 0/0
  await browserMock.runtime.sendMessage({ type: 'FETCH_PROGRESS', url, received: 0, total: 0 });
  await sleep(30);
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'pause' });
  await sleep(100);
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  const it = st.items.find((i: any) => /合并中暂停/.test(i.name));
  assert.equal(it.status, 'active', '合并中的项不应被暂停（暂停会把合并结果丢掉）');
  assert.equal(rangedAborted.length, 0, '不应中止它的抓取');
  assert.ok(progressLog.some((p) => /正在合并/.test(p.message ?? '')), '进度文字应是「正在合并」');
  await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  await sleep(50);
});

test('未知消息类型没有任何监听器认领', async () => {
  const res = await browserMock.runtime.sendMessage({ type: 'NOPE' });
  assert.equal(res, undefined);
});

// ===================== 对抗式审查（74 agents）确认项的回归测试 =====================

test('ZIP 打包不会打断并发中的 DASH 抓取（offscreen 单例不被 closeDocument）', async () => {
  resetLogs();
  // 1) 先发起一条会停在 offscreen 里的 DASH 抓取（/held/ 挂住响应）
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/held/zipcase-1-30080.m4s`,
    pageTitle: '并发 ZIP', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => heldReleasers.length >= 1, 3000); // offscreen 已在读这条流
  const stBefore: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(stBefore.progress.state, 'running');

  // 2) 中途打一个 ZIP —— 修复前这里会 closeDocument，把上面的抓取杀掉
  // 注意：offscreenHasDoc 是 mock 旗标，前面有测试会手动拨它，与 background 里缓存的
  // offscreenReady 可能不同步。只看「ZIP 期间有没有新增 close 事件」这个行为本身。
  const closesBefore = offscreenEvents.filter((e) => e === 'close').length;
  const zip: any = await browserMock.runtime.sendMessage({
    type: 'ZIP', items: [mk(`${origin}/z1.svg`), mk(`${origin}/z2.svg`)], name: '并发打包',
  });
  assert.equal(zip.ok, true);
  const closesAfter = offscreenEvents.filter((e) => e === 'close').length;
  assert.equal(closesAfter, closesBefore, 'ZIP 不得 closeDocument，否则并发中的 DASH 抓取会被打断');

  // 3) 放行 DASH 流，它应当正常完成落盘，而不是被 ZIP 拖成失败
  const before = downloadCalls.length;
  releaseHeld();
  await waitFor(() => downloadCalls.length > before && lastState() === 'done', 5000);
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(st.progress.state, 'done');
  assert.ok(st.items.every((i: any) => i.status === 'done'), JSON.stringify(st.items));
});

test('offscreen 抓取途中 SW 死亡后残留的「active 且无 downloadId」项：超时即自愈为失败，不再永久卡住', async () => {
  resetLogs();
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/held/stale-1-30080.m4s`,
    pageTitle: '僵死项', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => heldReleasers.length >= 1, 3000);

  // 此时该项 active、downloadId 为空、pageChannelStartedAt=刚才。
  // 把时钟拨快 11 分钟，模拟 SW 早已死掉、用户很久之后才重新打开弹窗。
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' }); // 触发 reconcile
    const item = st.items.find((i: any) => /僵死项/.test(i.name));
    assert.ok(item, JSON.stringify(st.items));
    assert.equal(item.status, 'failed', '超时的无 downloadId 项应被判僵死');
    assert.match(item.error ?? '', /抓取被中断/);
    assert.equal(st.progress.state, 'done', '僵死项释放后任务应能结算，而不是永远「进行中」');
  } finally {
    Date.now = realNow;
    releaseHeld(); // 让挂着的抓取收尾（.then 会看到状态非 active 而放弃落盘）
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('取消任务时，正在 offscreen 抓取、还没有 downloadId 的项也被取消，且抓完后不落盘', async () => {
  resetLogs();
  cancelCalls.length = 0;
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/held/cancel-1-30080.m4s`,
    pageTitle: '抓取中取消', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => heldReleasers.length >= 1, 3000);

  const res: any = await browserMock.runtime.sendMessage({ type: 'JOB_CONTROL', action: 'cancel' });
  assert.equal(res.state, 'cancelled');
  let st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  const item = st.items.find((i: any) => /抓取中取消/.test(i.name));
  assert.equal(item.status, 'cancelled', 'downloads API 管不到的在抓项也应标取消');
  assert.equal(st.progress.state, 'cancelled', '不该因为一个无 downloadId 的 active 项而无法结算');

  // 抓取随后完成：必须根本不发起下载 —— blob 下载几乎瞬时落盘，事后再 cancel 来不及
  const callsBefore = downloadCalls.length;
  releaseHeld();
  await new Promise((r) => setTimeout(r, 300));
  const leaked = downloadCalls.slice(callsBefore).filter((c) => /抓取中取消/.test(c.filename));
  assert.equal(leaked.length, 0, `被取消的项抓完后不应发起下载，实际：${JSON.stringify(leaked)}`);
  st = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  assert.equal(
    st.items.find((i: any) => /抓取中取消/.test(i.name)).status, 'cancelled',
    '抓取收尾不应把「已取消」改写成「失败」',
  );
});

test('慢网下的大文件：抓取一直有进展就不判僵死（僵死看「多久没进展」而不是「开始了多久」）', async () => {
  resetLogs();
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/trickle/slow-1-30080.m4s`,
    pageTitle: '慢网大文件', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => trickleStages.length >= 1, 3000);

  // 距开始已过 11 分钟，但抓取仍在持续推进
  const realNow = Date.now;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    trickleStages.shift()!(); // 放出 600KB → offscreen 报一次 FETCH_PROGRESS（心跳）
    await waitFor(() => progressLog.some((p) => /抓取中/.test(p.message ?? '')), 3000);
    const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' }); // 触发 reconcile
    const item = st.items.find((i: any) => /慢网大文件/.test(i.name));
    assert.equal(item.status, 'active', `仍在推进的抓取不应被判僵死：${JSON.stringify(item)}`);
  } finally {
    Date.now = realNow;
  }
  const before = downloadCalls.length;
  trickleStages.shift()!(); // 收尾
  await waitFor(() => downloadCalls.slice(before).some((c) => /慢网大文件/.test(c.filename)), 3000);
  await waitFor(() => lastState() === 'done', 3000);
});

test('CDN 200 但返回网页（captive portal / 灰度错误页）不得存成 .mp4，要报「网页而非媒体」', async () => {
  resetLogs();
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/html/fake-1-30080.m4s`,
    pageTitle: '假媒体', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => lastState() === 'done', 3000);
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  const item = st.items.find((i: any) => /假媒体/.test(i.name));
  assert.equal(item.status, 'failed');
  assert.match(item.error ?? '', /网页而非媒体/);
  assert.ok(!downloadCalls.some((c) => /假媒体/.test(c.filename)), 'HTML 响应绝不能触发落盘');
});

test('CDN 403（签名过期）的失败文案要指向「链接已过期」，而不是只报一个状态码', async () => {
  resetLogs();
  await browserMock.runtime.sendMessage({
    type: 'DOWNLOAD_MEDIA', url: `${origin}/forbid/expired-1-30080.m4s`,
    pageTitle: '签名过期', pageUrl: 'https://site.example/watch', tabId: 7,
  });
  await waitFor(() => lastState() === 'done', 3000);
  const st: any = await browserMock.runtime.sendMessage({ type: 'GET_STATE' });
  const item = st.items.find((i: any) => /签名过期/.test(i.name));
  assert.equal(item.status, 'failed');
  assert.match(item.error ?? '', /403/);
  assert.match(item.error ?? '', /过期/);
});
