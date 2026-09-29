import JSZip from 'jszip';
import type { MediaItem } from './types';
import { fileNameFromUrl } from './filename';
import { runPool } from './queue';

/** 响应的 content-type → 扩展名（只认图片 / 音视频；其余返回 undefined） */
const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/pjpeg': 'jpg', 'image/png': 'png', 'image/apng': 'png',
  'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'image/bmp': 'bmp',
  'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/heic': 'heic', 'image/heif': 'heif',
  'image/tiff': 'tiff', 'image/jxl': 'jxl', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
};

export function extFromContentType(contentType: string | null | undefined): string | undefined {
  const mime = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return MIME_EXT[mime];
}

/** 按文件头认格式：CDN 常把图片标成 application/octet-stream，文件头才是真话 */
export function sniffExt(bytes: Uint8Array): string | undefined {
  const b = bytes;
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length < 12) return undefined;
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif';
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'webp';
  if (ascii(4, 4) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 4))) return 'avif';
  if (at(0, 0x42, 0x4d)) return 'bmp';
  return undefined;
}

export interface ZipBuildResult {
  blobUrl: string;
  done: number;
  failed: number;
}

/**
 * 拉取全部图片并打成 zip，返回 blobUrl 和真实成败计数。
 * 必须跑在有 DOM 的上下文里（offscreen document / Firefox event page），
 * MV3 的 service worker 没有 URL.createObjectURL。
 */
export async function buildZipBlobUrl(
  items: MediaItem[],
  concurrency = 6,
  onProgress?: (done: number, failed: number) => void,
): Promise<ZipBuildResult> {
  const zip = new JSZip();
  let done = 0;
  let failed = 0;

  await runPool(items, concurrency, async (item, index) => {
    const res = await fetch(item.url, { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // 200 但回的是网页（防盗链页 / 登录页 / 运营商劫持）：不能当图片塞进包里
    if (/^(text\/html|application\/xhtml|application\/json|text\/plain)/i.test(res.headers.get('content-type') ?? '')) {
      res.body?.cancel().catch(() => {});
      throw new Error('服务器返回的是网页而非图片');
    }
    // ArrayBuffer 而不是 Blob：JSZip 对非浏览器 Blob 实现（如 Node/undici）的类型探测会失败
    const buf = await res.arrayBuffer();
    // 包里的扩展名：文件头 > 响应的 content-type > 扫描时按 URL 猜的。
    // 逐个下载时 Chrome 会按 MIME 纠正扩展名，ZIP 是 JSZip 自己命名，没有这层纠正
    //（公众号 wx_fmt=gif 的动图、无后缀 CDN 图以前在包里全变成 .jpg）
    const ext = sniffExt(new Uint8Array(buf, 0, Math.min(buf.byteLength, 16))) ??
      extFromContentType(res.headers.get('content-type')) ?? item.ext;
    zip.file(fileNameFromUrl(item.url, index, ext), buf);
  }, (ok) => {
    ok ? done++ : failed++;
    onProgress?.(done, failed);
  });

  if (done === 0) throw new Error('全部图片下载失败，可能是防盗链或网络问题');

  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  return { blobUrl: URL.createObjectURL(blob), done, failed };
}
