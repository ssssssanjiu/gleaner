import type { MediaHit } from './types';

/**
 * 整包抓取（offscreen 里拼字节 + ffmpeg 合并）的体积上限。内存峰值约是文件的 3~4 倍
 * （抓取字节 + ffmpeg 虚拟盘 + 输出 + Blob），再大扩展进程会被 Chrome 杀掉
 */
export const MAX_MEDIA_BYTES = 600 * 1024 * 1024;

export const MANIFEST_EXT = /\.(m3u8|mpd)([?#]|$)/i;
/** DASH 单文件轨：分片是对同一 URL 的 Range 请求，去掉 range 即整轨（B站 等） */
export const FRAGMENT_EXT = /\.m4s([?#]|$)/i;
/**
 * HLS 的 .ts 分片：每段是不同的文件，单独下只有几秒钟。之前被当成 DASH 单轨，
 * 每段列一行「视频 · 无声音轨」，直播能堆出上千行（审查实锤）。一律不列，由 m3u8 那一行代表整条流
 */
export const HLS_SEGMENT_EXT = /\.ts([?#]|$)/i;
export const AUDIO_EXT = /\.(mp3|m4a|aac|flac|wav|ogg|opus)([?#]|$)/i;
export const VIDEO_EXT = /\.(mp4|webm|mov|m4v|mkv|avi|flv)([?#]|$)/i;

/** URL 是否长得像真媒体。不满足就别收 —— 埋点接口、`/web` 这类路径会污染列表 */
export function isMediaUrl(url: string): boolean {
  return (
    MANIFEST_EXT.test(url) || FRAGMENT_EXT.test(url) || HLS_SEGMENT_EXT.test(url) || AUDIO_EXT.test(url) ||
    VIDEO_EXT.test(url)
  );
}

/** content-type 是否像真媒体，用来挡掉带 .ts 后缀的埋点接口 */
export function isMediaContentType(ct: string): boolean {
  if (!ct) return true; // 没给类型时交给后缀判断
  return (
    ct.startsWith('video/') ||
    ct.startsWith('audio/') ||
    ct.includes('mp4') ||
    ct.includes('octet-stream') ||
    ct.includes('mpegurl') ||
    ct.includes('dash+xml')
  );
}

/** B站 DASH 轨道编号：302xx 是音频，其余是视频 */
export function trackOf(url: string, contentType = ''): 'video' | 'audio' | undefined {
  const m = url.match(/-(\d{4,6})\.m4s/);
  if (m) {
    const id = Number(m[1]);
    return id >= 30200 && id < 30300 ? 'audio' : 'video';
  }
  // DASH 服务端常把音频轨也标成 video/mp4，content-type 只能当兜底
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  return undefined;
}

/**
 * 分片 URL 归一化：只剥掉分段用的 range 参数，**必须保留鉴权签名**
 * （B站 的 upsig/deadline/oi/trid 等；整串剥掉会被 CDN 拒绝，
 * 下回来的是错误页而不是视频——实测踩过）。
 */
export function normalizeFragmentUrl(raw: string): string {
  const RANGE_PARAMS = ['range', 'bytestart', 'byteend', 'start', 'end', 'offset', 'len'];
  try {
    const u = new URL(raw);
    for (const p of RANGE_PARAMS) u.searchParams.delete(p);
    return u.href;
  } catch {
    return raw;
  }
}

/**
 * 从 B站 轨道编号猜编码格式。只是兜底：拿得到 B站 轨道清单时以清单的 codecid 为准
 * （见 core/bili.ts），拿到字节后 fmp4.detectCodec 更准。
 */
export function codecOf(url: string): 'h264' | 'hevc' | 'av1' | undefined {
  const m = url.match(/-(\d{4,6})\.m4s/);
  if (!m) return undefined;
  const id = Number(m[1]);
  // 实测（2026-09，B站 playurl 清单 codecid + 落盘字节双重核对）：
  // 1000xx = AV1（100022/100023 → av01），1001xx = HEVC（100113 → hev1），
  // 30011/30033 = HEVC（hvc1/hev1），30016/30032 = H.264（avc1）。
  // 之前把 100xxx 一律当 HEVC，AV1 被标成「HEVC·已自动兼容」，下下来 QuickTime 打不开。
  if (id >= 100000 && id < 100100) return 'av1';
  if (id >= 100100) return 'hevc';
  if (HEVC_IDS.has(id)) return 'hevc';
  return 'h264';
}
/** 30xxx 段里的 HEVC 编号（其余按 H.264）：360P/480P/720P/1080P 的 HEVC，及 1080P+ 等 */
const HEVC_IDS = new Set([30011, 30033, 30066, 30077, 30102, 30106, 30112, 30062]);

/** 兼容性排序：H.264 到处能播 > HEVC > AV1（QuickTime 不支持） */
const CODEC_RANK: Record<string, number> = { h264: 0, hevc: 1, av1: 2 };
function moreCompatible(a: MediaHit, b: MediaHit): MediaHit {
  const ra = CODEC_RANK[a.codec ?? 'h264'] ?? 1;
  const rb = CODEC_RANK[b.codec ?? 'h264'] ?? 1;
  return ra <= rb ? a : b;
}

/** 取路径末段作为去重键：B站 会从多个 CDN 域名拉同一个文件，按完整 URL 去重会重复 */
export function basenameKey(url: string): string {
  try {
    return new URL(url).pathname.split('/').pop() || url;
  } catch {
    return url.split('?')[0].split('/').pop() || url;
  }
}

/** 文件名去掉最后一段数字：seg-00012.m4s → seg-#.m4s（同目录下） */
function sequenceKey(url: string): string {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* 用原串 */
  }
  return path.replace(/\d+(?=\.m4s$)/i, '#');
}

/**
 * 一串编号连续的 .m4s（HLS-fMP4 / DASH SegmentTemplate 的分段）：每个文件只是几秒钟，
 * 当成「一条轨」下载拿到的就是一小段。B站 的轨道编号（30xxx / 100xxx）不算 —— 那是不同的轨，不是分段。
 */
function findSegmentSequences(hits: MediaHit[]): Set<string> {
  const nums = new Map<string, Set<number>>();
  for (const h of hits) {
    if (h.streamKind !== 'dash-track') continue;
    const m = /(\d+)\.m4s$/i.exec(h.url.split(/[?#]/)[0]);
    if (!m || /^(30\d{3}|100\d{3})$/.test(m[1])) continue;
    const k = sequenceKey(h.url);
    if (!nums.has(k)) nums.set(k, new Set());
    nums.get(k)!.add(Number(m[1]));
  }
  const out = new Set<string>();
  for (const [k, set] of nums) {
    const arr = [...set];
    if (arr.length >= 4 && Math.max(...arr) - Math.min(...arr) <= arr.length * 3) out.add(k);
  }
  return out;
}

/** 同一视频的音视频轨共享文件名前缀：41472951104-1-100026.m4s / -1-30232.m4s */
function pairKey(url: string): string {
  const base = basenameKey(url);
  return base.replace(/-\d{4,6}\.m4s$/i, '');
}

/**
 * 把原始采集结果整理成给用户看的列表：
 * 1. 跨 CDN 去重（按文件名，不是完整 URL）
 * 2. 同一视频的视频轨 + 音频轨合并成一条 —— 用户要的是「一个视频」
 * 3. 纯音频页面（只有音频轨）保持显示为音频
 */
export function consolidateMedia(hits: MediaHit[]): MediaHit[] {
  // 0. 站点清单给出的条目（B站 已挑好 H.264 并配好声音）原样保留；
  //    同一视频被嗅探到的散轨（播放器实际在放的 AV1/HEVC 轨、各档音轨）全部让位，
  //    否则用户会看到同一个视频两行，还可能点到打不开的那行
  const curated = new Map<string, MediaHit>();
  const covered = new Set<string>();
  for (const h of hits) {
    if (!h.curated) continue;
    if (!curated.has(h.url)) curated.set(h.url, { ...h });
    for (const k of h.coversKeys ?? []) covered.add(k);
  }
  // 有清单条目时，其余 DASH 散轨一律不列：它们是同一页面里之前播过的视频
  // （B站 切分P / 自动连播后，旧视频的轨还留在嗅探记录里）。列出来两行都叫「视频」，
  // 用户分不清，点错就会把上一集按当前标题保存（审查实锤）。
  // 清单总是跟着播放器最新一次 playurl 请求更新，代表的就是正在看的这个视频。
  const loose = hits.filter(
    (h) => !h.curated && !(h.streamKind === 'dash-track' && (curated.size > 0 || covered.has(basenameKey(h.url)))),
  );

  // 1. 按文件名去重，保留信息更全的那条（有 size / 分片数更多）
  const byName = new Map<string, MediaHit>();
  const segmentGroups = findSegmentSequences(loose);
  for (const h of loose) {
    if (HLS_SEGMENT_EXT.test(h.url)) continue;
    if (h.streamKind === 'dash-track' && segmentGroups.has(sequenceKey(h.url))) continue;
    const key = basenameKey(h.url);
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, { ...h });
      continue;
    }
    prev.segments = (prev.segments ?? 0) + (h.segments ?? 0) || undefined;
    if (h.size && !prev.size) prev.size = h.size;
    if (h.width && !prev.width) {
      prev.width = h.width;
      prev.height = h.height;
    }
    // 区块只有 DOM 扫描那一路知道，嗅探那条先到也不能把它丢了
    if (h.section && !prev.section) prev.section = h.section;
    // 发起请求的 frame 来源只有嗅探那一路知道（iframe 播放器下载要用它当 Referer）
    if (h.referer && !prev.referer) prev.referer = h.referer;
  }

  // 2. DASH 轨配对
  const out: MediaHit[] = [];
  const tracks = new Map<string, { video?: MediaHit; audio?: MediaHit }>();
  for (const h of byName.values()) {
    if (h.streamKind === 'dash-track' && h.track) {
      const g = tracks.get(pairKey(h.url)) ?? {};
      const existing = g[h.track];
      // 同一视频可能同时抓到 AV1 和 H.264 两条画面轨，留兼容性好的那条
      g[h.track] = existing ? moreCompatible(existing, h) : h;
      tracks.set(pairKey(h.url), g);
    } else {
      out.push(h);
    }
  }

  const groups = Array.from(tracks.values());

  // 兜底：按文件名前缀没配上，但整页恰好只有一条视频轨和一条音频轨时，
  // 它们必然属于同一个视频（B站 前缀相同，但别的 DASH 站不一定）
  const loneVideo = groups.filter((g) => g.video && !g.audio);
  const loneAudio = groups.filter((g) => g.audio && !g.video);
  if (loneVideo.length === 1 && loneAudio.length === 1) {
    loneVideo[0].audio = loneAudio[0].audio;
    loneAudio[0].audio = undefined;
  }

  for (const g of groups) {
    if (g.video) {
      out.push({
        ...g.video,
        // 有配对音频就是一个完整视频，没有就是无声视频
        pairedAudioUrl: g.audio?.url,
        segments: (g.video.segments ?? 0) + (g.audio?.segments ?? 0) || undefined,
      });
    } else if (g.audio) {
      // 只有音频轨（纯音频页面）：就按音频展示
      out.push({ ...g.audio, kind: 'audio' });
    }
  }

  // 清单条目最可靠，排最前；其余有画面的排前面
  return [
    ...curated.values(),
    ...out.sort((a, b) => (a.kind === 'audio' ? 1 : 0) - (b.kind === 'audio' ? 1 : 0)),
  ];
}
