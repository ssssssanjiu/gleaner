import { scanPage } from '@/core/scanner';
import type { MediaScanResponse, Message, PageInfoResponse, ScanResponse } from '@/core/messages';
import type { MediaHit } from '@/core/types';
import { collectPageInfo, sectionOf } from '@/core/agent/dom-sections';
import {
  AUDIO_EXT, FRAGMENT_EXT, HLS_SEGMENT_EXT, MANIFEST_EXT, basenameKey, codecOf, isMediaContentType, isMediaUrl,
  normalizeFragmentUrl, trackOf,
} from '@/core/media';
import { biliMediaHit, sanitizeBiliTracks, type BiliTracks } from '@/core/bili';

/**
 * 页面世界注入脚本上报的媒体（第二条捕获通道，不依赖 service worker 生命周期）。
 * key = url，避免同一分片刷屏。
 */
const pageHooked = new Map<string, { contentType: string; count: number }>();
/** 注入脚本转来的 B站 轨道清单，最新一份为准（站内切视频会再请求一次） */
let biliLatest: BiliTracks | null = null;

function listenInjected() {
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data as { tag?: string; url?: string; contentType?: string; tracks?: unknown } | null;
    if (d?.tag === '__gleaner_bili__') {
      // 只在 B站 页面收；形状校验见 sanitizeBiliTracks（页面任何脚本都能发这个消息）
      if (!/(^|\.)bilibili\.com$/.test(location.hostname)) return;
      const t = sanitizeBiliTracks(d.tracks);
      if (t) biliLatest = t;
      return;
    }
    if (d?.tag !== '__gleaner_media__' || typeof d.url !== 'string') return;
    // postMessage 任何页面脚本都能发，不能无条件信任注入脚本的过滤：
    // 只收 http(s) 真实地址，挡掉 blob:/data:/javascript: 之类
    if (!/^https?:\/\//i.test(d.url)) return;
    // HLS 分段一律不收：直播一小时就是上千个 .ts，既没法单独下载，又会把弹窗拖慢
    if (HLS_SEGMENT_EXT.test(d.url)) return;
    const prev = pageHooked.get(d.url);
    if (prev) prev.count++;
    else {
      // 上限：长时间播放的页面也不能无限涨（最早的先出）
      if (pageHooked.size >= 2000) pageHooked.delete(pageHooked.keys().next().value!);
      pageHooked.set(d.url, { contentType: d.contentType ?? '', count: 1 });
    }
  });
  // 我们在 document_idle 才开始听，注入脚本早在 DOMContentLoaded 就发过清单了：
  // 就绪后向它要一次最新的（B站 首屏清单内嵌在 HTML 里，不要就永远收不到）
  if (/(^|\.)bilibili\.com$/.test(location.hostname)) {
    window.postMessage?.({ tag: '__gleaner_bili_req__' }, '*');
  }
}

/** 把页面钩子攒到的记录整理成 MediaHit（分片按基础 URL 归并成轨） */
function hookedMedia(): MediaHit[] {
  const out = new Map<string, MediaHit>();

  for (const [url, meta] of pageHooked) {
    // 不是真媒体就别收。之前这里有个「默认当视频」的兜底，
    // 结果把 /web 这类普通接口也列成了视频轨
    if (!isMediaUrl(url) && !/^(video|audio)\//.test(meta.contentType)) continue;
    if (FRAGMENT_EXT.test(url) && !isMediaContentType(meta.contentType)) continue;

    if (FRAGMENT_EXT.test(url)) {
      // 保留鉴权签名，只去掉 range 参数（剥光签名会被 CDN 拒绝）
      const base = normalizeFragmentUrl(url);
      const key = basenameKey(base);
      const hit = out.get(key); // 之前每条都遍历一遍已有结果（分片多时是平方级，弹窗要卡好几秒）
      if (hit) {
        hit.segments = (hit.segments ?? 1) + meta.count;
        continue;
      }
      out.set(key, {
        url: base,
        kind: 'stream',
        streamKind: 'dash-track',
        track: trackOf(base, meta.contentType),
        codec: codecOf(base),
        mime: meta.contentType,
        segments: meta.count,
        via: 'dom',
      });
      continue;
    }
    if (out.has(url)) continue;
    const kind: MediaHit['kind'] = MANIFEST_EXT.test(url)
      ? 'stream'
      : AUDIO_EXT.test(url) || meta.contentType.startsWith('audio/')
        ? 'audio'
        : 'video';
    out.set(url, {
      url,
      kind,
      mime: meta.contentType,
      via: 'dom',
      ...(kind === 'stream' ? { streamKind: 'hls' as const } : {}),
    });
  }
  return Array.from(out.values());
}

/** 扫页面上的 <video>/<audio>/<source> 直链（blob: 是 MSE 假地址，跳过——那些靠网络嗅探） */
function scanMediaTags(): MediaHit[] {
  const out: MediaHit[] = [];
  const seen = new Set<string>();
  const push = (
    raw: string | null | undefined,
    kind: 'video' | 'audio',
    el: Element,
    width = 0,
    height = 0,
  ) => {
    if (!raw || raw.startsWith('blob:') || raw.startsWith('data:')) return;
    try {
      const url = new URL(raw, location.href).href;
      if (seen.has(url)) return;
      seen.add(url);
      out.push({ url, kind, width, height, via: 'dom', section: sectionOf(el) });
    } catch {
      /* 非法 URL */
    }
  };
  for (const v of Array.from(document.querySelectorAll<HTMLVideoElement>('video'))) {
    push(v.currentSrc || v.src, 'video', v, v.videoWidth, v.videoHeight);
    for (const s of Array.from(v.querySelectorAll('source'))) {
      push(s.src, 'video', v, v.videoWidth, v.videoHeight);
    }
  }
  for (const a of Array.from(document.querySelectorAll<HTMLAudioElement>('audio'))) {
    push(a.currentSrc || a.src, 'audio', a);
    for (const s of Array.from(a.querySelectorAll('source'))) push(s.src, 'audio', a);
  }
  return out;
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: false,
  main() {
    listenInjected();

    // 同步判断类型，只在命中时返回 Promise（原因见 background.ts 同处注释）
    browser.runtime.onMessage.addListener(
      (raw: unknown): Promise<ScanResponse | MediaScanResponse | PageInfoResponse> | undefined => {
        const msg = raw as Message;
        if (msg.type === 'PAGE_INFO') {
          try {
            return Promise.resolve<PageInfoResponse>({ ok: true, page: collectPageInfo() });
          } catch (e: any) {
            return Promise.resolve<PageInfoResponse>({ ok: false, error: String(e?.message ?? e) });
          }
        }
        if (msg.type === 'SCAN') {
          return scanPage(msg.options)
            .then((result): ScanResponse => ({ ok: true, result }))
            .catch((e): ScanResponse => ({ ok: false, error: String(e?.message ?? e) }));
        }
        if (msg.type === 'MEDIA_SCAN') {
          try {
            // 页面钩子的结果优先（能看到播放器真实请求），标签扫描兜底。
            // 注入脚本每 3 秒也会把 <video> 的 src 报上来，和标签扫描撞同一个 URL 是常态：
            // 这时不能把标签扫描那条整个丢掉 —— 区块面包屑和画面尺寸只有它知道
            // （实测：这条漏了会让「评论区的视频」时灵时不灵，取决于弹窗打开时钩子有没有先报过）
            const merged = new Map<string, MediaHit>();
            // B站 清单条目：已挑好兼容编码（H.264 优先）并配好声音，排在最前
            const bili = biliLatest ? biliMediaHit(biliLatest) : null;
            if (bili) merged.set(bili.url, bili);
            for (const m of hookedMedia()) if (!merged.has(m.url)) merged.set(m.url, m);
            for (const m of scanMediaTags()) {
              const prev = merged.get(m.url);
              if (!prev) {
                merged.set(m.url, m);
                continue;
              }
              if (m.section && !prev.section) prev.section = m.section;
              if (m.width && !prev.width) {
                prev.width = m.width;
                prev.height = m.height;
              }
            }
            return Promise.resolve<MediaScanResponse>({
              ok: true,
              media: Array.from(merged.values()),
            });
          } catch (e: any) {
            return Promise.resolve<MediaScanResponse>({ ok: false, error: String(e?.message ?? e) });
          }
        }
      },
    );
  },
});
