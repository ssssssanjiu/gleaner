/**
 * 页面世界（MAIN world）注入脚本 —— 媒体捕获的第二条通道。
 *
 * 为什么需要它：webRequest 嗅探跑在 MV3 的 service worker 里，而 SW 随时可能
 * 被回收，事件在 SW 冷启动的缝隙里会丢；某些站点（B站等）的分片请求也可能
 * 完全落在观察窗口之外。直接在页面里挂钩 fetch / XHR 不依赖任何后台生命周期，
 * 播放器请求什么就看到什么。
 *
 * 这里不能用 chrome.* API（MAIN world 没有扩展权限），只能 postMessage 给
 * 隔离世界的 content script 转交。
 */
import { installFetchHook } from '@/core/page-hooks';
import { extractBiliTracks, isBiliPlayurlApi } from '@/core/bili';

const TAG = '__gleaner_media__';
/** B站 轨道清单（含全部编码的签名地址），见 core/bili.ts */
const BILI_TAG = '__gleaner_bili__';

/**
 * 最近一份清单。必须留着：本脚本在 document_start 就跑，内嵌清单在 DOMContentLoaded
 * 就发出去了，而接收方 content script 要到 document_idle 才开始监听 —— 首发必丢
 * （e2e 实测）。content script 就绪后会发 BILI_REQ，这里再补发一次。
 */
let lastBili: unknown = null;
const BILI_REQ = '__gleaner_bili_req__';

function reportBili(json: unknown) {
  try {
    const tracks = extractBiliTracks(json);
    if (!tracks) return;
    lastBili = tracks;
    window.postMessage({ tag: BILI_TAG, tracks }, '*');
  } catch {
    /* 解析失败绝不能影响页面 */
  }
}

const absolute = (u: string) => {
  try {
    return new URL(u, location.href).href; // B站 用 //api.bilibili.com/... 这种协议相对地址
  } catch {
    return u;
  }
};

const MEDIA_RE =
  /\.(mp4|webm|mov|m4v|mkv|avi|flv|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd|m4s|ts)([?#]|$)/i;

function report(rawUrl: string, contentType?: string) {
  try {
    if (!rawUrl) return;
    const url = new URL(rawUrl, location.href).href;
    if (url.startsWith('blob:') || url.startsWith('data:')) return;
    const ct = (contentType ?? '').toLowerCase();
    const looksMedia =
      MEDIA_RE.test(url) || ct.startsWith('video/') || ct.startsWith('audio/') ||
      ct.includes('mpegurl') || ct.includes('dash+xml');
    if (!looksMedia) return;
    window.postMessage({ tag: TAG, url, contentType: ct }, '*');
  } catch {
    /* 捕获失败绝不能影响页面本身 */
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start', // 必须早于播放器初始化，否则钩不到
  world: 'MAIN',
  allFrames: true,
  main() {
    // 1. hook fetch（实现见 core/page-hooks.ts，那里有单测保证透明性）
    installFetchHook(window, report, (url, res) => {
      if (!isBiliPlayurlApi(absolute(url))) return;
      res.clone().json().then(reportBili, () => {});
    });

    // 2. hook XMLHttpRequest
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      this.addEventListener('load', () => {
        report(String(url), this.getResponseHeader('content-type') ?? undefined);
        if (!isBiliPlayurlApi(absolute(String(url)))) return;
        try {
          // 只读页面已经拿到的响应，不发任何额外请求
          const rt = this.responseType;
          if (rt === 'json') reportBili(this.response);
          else if (rt === '' || rt === 'text') reportBili(JSON.parse(this.responseText));
        } catch {
          /* 解析失败绝不能影响页面 */
        }
      });
      // @ts-expect-error 透传原始参数
      return origOpen.call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;

    // 3. B站 首屏：清单直接内嵌在 HTML 的 window.__playinfo__ 里，不走接口
    //    （实测有的视频内嵌、有的走 playurl 接口，两路都要接）
    if (/(^|\.)bilibili\.com$/.test(location.hostname)) {
      window.addEventListener('message', (e) => {
        if (e.source !== window || (e.data as { tag?: string } | null)?.tag !== BILI_REQ) return;
        if (lastBili) window.postMessage({ tag: BILI_TAG, tracks: lastBili }, '*');
      });
      const readPlayinfo = () => reportBili((window as { __playinfo__?: unknown }).__playinfo__);
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', readPlayinfo, { once: true });
      } else {
        readPlayinfo();
      }
    }

    // 4. 兜底：定时扫 <video>/<audio> 的 currentSrc（有些播放器直接赋值不发 XHR）
    const sweep = () => {
      for (const el of Array.from(document.querySelectorAll('video, audio'))) {
        report((el as HTMLMediaElement).currentSrc || (el as HTMLMediaElement).src);
      }
    };
    setInterval(sweep, 3000);
  },
});
