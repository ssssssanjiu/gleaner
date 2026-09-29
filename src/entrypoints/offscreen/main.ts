import { buildZipBlobUrl } from '@/core/zip';
import type { BlobResponse, Message, ZipResponse } from '@/core/messages';
import { patchHev1ToHvc1 } from '@/core/fmp4';
import { muxVideoAudio } from '@/core/ffmpeg-mux';

/**
 * offscreen document 的职责：在有 DOM（能 createObjectURL / 编译 WebAssembly）的
 * 扩展上下文里，直接抓取媒体、（可选）用 ffmpeg 合并音视频、生成 blob。
 * 字节全程不出这个上下文 —— 这是修 0 字节 bug 的关键。
 */
browser.runtime.onMessage.addListener(
  (raw: unknown): Promise<ZipResponse | BlobResponse> | undefined => {
    const msg = raw as Message;

    if (msg.type === 'OFFSCREEN_ZIP') {
      const total = msg.items.length;
      return buildZipBlobUrl(msg.items, 6, (done, failed) => {
        browser.runtime
          .sendMessage({ type: 'ZIP_PROGRESS', done, failed, total } satisfies Message)
          .catch(() => {});
      }).catch((e): ZipResponse => ({ error: String(e?.message ?? e) }));
    }

    if (msg.type === 'OFFSCREEN_ABORT') {
      for (const u of msg.urls) {
        controllers.get(u)?.abort();
        if (!msg.keepPartial) partials.delete(u);
      }
      return;
    }

    if (msg.type === 'OFFSCREEN_REVOKE') {
      try {
        URL.revokeObjectURL(msg.blobUrl);
      } catch {
        /* 已释放，忽略 */
      }
      return;
    }

    if (msg.type === 'OFFSCREEN_FETCH') {
      return fetchToBlob([msg.url, ...(msg.backups ?? [])], msg.isAudio, msg.maxBytes).catch((e) =>
        failure(e, msg.kind ?? 'media'),
      );
    }

    if (msg.type === 'OFFSCREEN_MUX') {
      return muxToBlob(
        [msg.videoUrl, ...(msg.videoBackups ?? [])],
        [msg.audioUrl, ...(msg.audioBackups ?? [])],
        msg.maxBytes,
      ).catch(failure);
    }
  },
);

const isAbort = (e: any) => e?.name === 'AbortError';
const failure = (e: any, kind: 'media' | 'image' = 'media'): BlobResponse =>
  isAbort(e) ? { ok: false, error: '已暂停', aborted: true } : { ok: false, error: humanizeError(e, kind) };

/** 抓取失败的种类：文案要按「视频 / 图片」给出用户能照做的建议 */
class FetchFailure extends Error {
  constructor(readonly code: 'forbidden' | 'html' | 'status', readonly status = 0) {
    super(`HTTP ${status}`);
  }
}

/** 每个地址的在途抓取。同一地址只留一个：SW 重启后重新派发会撞上旧的那个，接管它 */
const controllers = new Map<string, AbortController>();

/**
 * 暂停时留下的已抓字节。继续时带 Range 从断点续抓，不从头来。
 * validator（ETag / Last-Modified）用于 If-Range：文件变了服务器会回整份 200，自动从头来
 */
interface PartialFetch {
  chunks: Uint8Array[];
  received: number;
  total: number;
  validator?: string;
  /** 正在往里写的那次抓取（它失败时才删，别误删接管者的） */
  owner?: unknown;
}
const partials = new Map<string, PartialFetch>();

/**
 * 视频：签名链接过期最常见，建议「重新播放一下」（播放器会拿到新签名）。
 * 图片：没有「播放」可言 —— 之前对图片也说「重新播放一下再试」，用户没法照做（审查实锤）
 */
function humanizeError(e: any, kind: 'media' | 'image'): string {
  const media = kind === 'media';
  if (e instanceof FetchFailure) {
    if (e.code === 'forbidden') {
      return media
        ? '服务器拒绝（HTTP 403）—— 链接可能已过期，重新播放一下再试'
        : '服务器拒绝（HTTP 403）—— 该站有防盗链，带上来源页重试仍被拒绝';
    }
    if (e.code === 'html') {
      return media
        ? '服务器返回的是网页而非媒体（链接可能已过期，重新播放一下再试）'
        : '服务器返回的是网页而非图片（多半是防盗链或需要登录）';
    }
    return `服务器拒绝（HTTP ${e.status}）`;
  }
  const raw = String(e?.message ?? e);
  if (/Failed to fetch|NetworkError/i.test(raw)) {
    return media ? '抓取失败（链接可能已过期，重新播放一下再试）' : '抓取失败（网络不通或被防盗链拦截）';
  }
  return raw;
}

/** 扩展页 fetch：跨域也能读到响应体，不带凭证（CDN 常回 ACAO:*）。Referer 由 DNR 补。 */
async function fetchBytes(
  url: string,
  maxBytes: number,
  onProgress?: (received: number, total: number) => void,
  group?: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string }> {
  // 接管同一地址的旧抓取（SW 重启后重新派发会撞上它）：旧的中止，已抓字节留给这次续上
  controllers.get(url)?.abort();
  const ctrl = new AbortController();
  controllers.set(url, ctrl);
  // group：同一次合并的两条轨共用。一条失败时只中止「这一次」的另一条 ——
  // 之前按地址去中止，会把接管后新发起的抓取一起杀掉（e2e 实测：SW 被回收后续传失败）
  const onGroupAbort = () => ctrl.abort();
  group?.addEventListener('abort', onGroupAbort, { once: true });
  try {
    return await fetchResumable(url, maxBytes, ctrl.signal, onProgress);
  } catch (e) {
    // 暂停（abort）留着已抓的字节；真失败就丢掉，别占着内存
    // owner 存的是 signal（fetchResumable 只拿得到 signal）；之前这里比的是 ctrl，永远不相等 ——
    // 真失败留下的断点字节从来没删过（审查实锤：主 CDN 断开、切备用成功后，几百 MB 常驻）
    if (!isAbort(e) && partials.get(url)?.owner === ctrl.signal) partials.delete(url);
    throw e;
  } finally {
    group?.removeEventListener('abort', onGroupAbort);
    if (controllers.get(url) === ctrl) controllers.delete(url);
  }
}

async function fetchResumable(
  url: string,
  maxBytes: number,
  signal: AbortSignal,
  onProgress?: (received: number, total: number) => void,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const prev = partials.get(url);
  // 复制一份再续：被接管的旧抓取在收到中止前可能还会往原对象里塞一块，别和它共用
  let part: PartialFetch | undefined = prev && { ...prev, chunks: [...prev.chunks], owner: signal };
  if (part) partials.set(url, part);
  const headers: Record<string, string> = {};
  if (part && part.received > 0) {
    headers.Range = `bytes=${part.received}-`;
    if (part.validator) headers['If-Range'] = part.validator;
  }
  const res = await fetch(url, { credentials: 'omit', signal, headers });

  if (res.status === 416 && part) {
    // 已抓的就是全部（或服务器不认这个区间）：丢掉续抓记录重来一次
    partials.delete(url);
    res.body?.cancel().catch(() => {});
    return fetchResumable(url, maxBytes, signal, onProgress);
  }
  if (!res.ok) {
    // 403 在 B站 这类签名 CDN 上几乎总是链接过期；文案按视频/图片在 humanizeError 里给
    throw new FetchFailure(res.status === 403 ? 'forbidden' : 'status', res.status);
  }
  const mime = (res.headers.get('content-type') ?? 'application/octet-stream').toLowerCase();
  // 200 + 网页也要拦：captive portal / 运营商劫持 / CDN 灰度错误页都会 200 回一段 HTML，
  // 不拦就会被存成一个打不开的 .mp4。在读 body 之前判，别白下一遍。
  if (/^(text\/html|application\/json|text\/plain|text\/xml|application\/xhtml)/.test(mime)) {
    throw new FetchFailure('html', res.status);
  }

  if (res.status === 206 && part) {
    // 续抓：核对服务器给的起点就是我们断开的位置，对不上就从头来
    const m = /bytes\s+(\d+)-\d+\/(\d+|\*)/i.exec(res.headers.get('content-range') ?? '');
    if (!m || Number(m[1]) !== part.received) {
      partials.delete(url);
      res.body?.cancel().catch(() => {});
      return fetchResumable(url, maxBytes, signal, onProgress);
    }
    if (m[2] !== '*') part.total = Number(m[2]);
  } else {
    // 200：第一次抓，或服务器没理 Range / 文件变了 —— 从头来
    part = {
      chunks: [],
      received: 0,
      total: Number(res.headers.get('content-length') ?? 0),
      validator: res.headers.get('etag') ?? res.headers.get('last-modified') ?? undefined,
      owner: signal,
    };
    partials.set(url, part);
  }
  if (part.total > maxBytes) throw new Error(`文件 ${(part.total / 1048576).toFixed(0)}MB，超出上限`);

  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    part.chunks.push(buf);
    part.received += buf.byteLength;
  } else {
    const reader = res.body.getReader();
    let last = part.received;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      part.chunks.push(value);
      part.received += value.byteLength;
      if (part.received > maxBytes) {
        reader.cancel().catch(() => {});
        throw new Error('文件过大，超出上限');
      }
      if (part.received - last > 512 * 1024) {
        last = part.received;
        onProgress?.(part.received, part.total);
      }
    }
  }

  const bytes = new Uint8Array(part.received);
  let off = 0;
  for (const c of part.chunks) {
    bytes.set(c, off);
    off += c.byteLength;
  }
  if (partials.get(url) === part) partials.delete(url); // 抓完就放掉分块引用，峰值内存从 2 份降到 1 份
  if (!bytes.byteLength) throw new Error('抓到 0 字节（响应为空）');
  return { bytes, mime };
}

/**
 * 主地址失败（403/5xx/网络/回了网页）就依次换备用 CDN 地址 —— B站 播放器自己也是这么做的，
 * 大陆网络下单个 CDN 节点拒绝/超时很常见。有断点的地址排最前（暂停前抓到一半的那个）。
 * 进度一律按主地址上报：后台按它找任务项、刷新心跳。
 */
async function fetchFirstWorking(
  urls: string[],
  maxBytes: number,
  group?: AbortSignal,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const primary = urls[0];
  const ordered = [...urls].sort((a, b) => Number(partials.has(b)) - Number(partials.has(a)));
  let firstError: unknown;
  for (const u of ordered) {
    try {
      const got = await fetchBytes(u, maxBytes, (r, t) => reportProgress(primary, r, t), group);
      // 这条轨已经拿全了：其它候选地址（中途断掉的主地址等）留下的断点字节没用了
      for (const other of urls) if (other !== u) partials.delete(other);
      return got;
    } catch (e) {
      if (isAbort(e)) throw e; // 暂停/取消：别再换地址
      firstError ??= e;
    }
  }
  throw firstError;
}

function reportProgress(url: string, received: number, total: number) {
  browser.runtime
    .sendMessage({ type: 'FETCH_PROGRESS', url, received, total } satisfies Message)
    .catch(() => {});
}

async function fetchToBlob(urls: string[], isAudio: boolean, maxBytes: number): Promise<BlobResponse> {
  const { bytes, mime } = await fetchFirstWorking(urls, maxBytes);
  const { patched } = isAudio ? { patched: false } : patchHev1ToHvc1(bytes);
  const outMime = isAudio ? 'audio/mp4' : mime || 'video/mp4';
  const blob = new Blob([bytes as unknown as BlobPart], { type: outMime });
  return { ok: true, blobUrl: URL.createObjectURL(blob), size: bytes.byteLength, patchedHevc: patched };
}

async function muxToBlob(videoUrls: string[], audioUrls: string[], maxBytes: number): Promise<BlobResponse> {
  const videoUrl = videoUrls[0];
  // 配额按两轨之和算，不要对半分：画面轨常占 90%+，对半分会让 30 分钟以上的
  // 1080P 视频直接失败。单轨各自不超总额，抓完再核对总和。
  let video: Uint8Array;
  let audio: Uint8Array;
  const group = new AbortController();
  try {
    [{ bytes: video }, { bytes: audio }] = await Promise.all([
      fetchFirstWorking(videoUrls, maxBytes, group.signal),
      fetchFirstWorking(audioUrls, maxBytes, group.signal),
    ]);
  } catch (e) {
    // 一条轨失败了另一条别在后台白白下完（暂停时两条都会被中止，已抓的留着）
    group.abort();
    // 真失败（不是暂停）：被连带中止的那条留下的断点字节也要丢，否则一直占到浏览器重启（审查实锤）
    if (!isAbort(e)) for (const u of [...videoUrls, ...audioUrls]) partials.delete(u);
    throw e;
  }
  if (video.byteLength + audio.byteLength > maxBytes) {
    throw new Error(
      `音视频合计 ${((video.byteLength + audio.byteLength) / 1048576).toFixed(0)}MB，超出上限`,
    );
  }

  reportProgress(videoUrl, 0, 0); // 触发一次「合并中」提示
  const merged = await muxVideoAudio(video, audio);
  // 合并后若是 HEVC 的 hev1 封装，改成 hvc1，QuickTime 才能播
  const { patched } = patchHev1ToHvc1(merged);
  const blob = new Blob([merged as unknown as BlobPart], { type: 'video/mp4' });
  return { ok: true, blobUrl: URL.createObjectURL(blob), size: merged.byteLength, patchedHevc: patched };
}
