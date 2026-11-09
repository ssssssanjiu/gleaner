/**
 * B站 播放信息通道：从播放器自己拿到的轨道清单里挑「下下来就能播」的那条。
 *
 * 为什么需要：B站 每个清晰度都同时提供 H.264 / HEVC / AV1 三种编码，Chrome 里
 * 播放器默认挑 AV1。只跟着播放器实际请求的轨下载，拿到的就是 AV1 —— M1/M2 Mac 的
 * QuickTime 直接「无法打开」（实测 2026-09 热门视频 4 个里 2 个是 AV1）。
 * 清单里有全部编码的签名地址（页面内嵌的 window.__playinfo__，或播放器请求的
 * playurl 接口），从那里挑 H.264 才能保证兼容。
 *
 * 清单结构（实测）：data.dash.video[] / data.dash.audio[]，每条有
 * id（画质 qn）、codecid（7=H.264 / 12=HEVC / 13=AV1）、codecs、width、height、
 * bandwidth、baseUrl（带签名）、backupUrl[]。
 */
import { MAX_MEDIA_BYTES, basenameKey } from './media';
import type { MediaHit } from './types';
import { t } from './i18n';

export interface BiliTrack {
  url: string;
  backups: string[];
  /** 视频是画质 qn（16/32/64/80…），音频是音质 id（30216/30232/30280…） */
  id: number;
  /** 7 = H.264，12 = HEVC，13 = AV1；音频为 0 */
  codecid: number;
  codecs: string;
  width: number;
  height: number;
  bandwidth: number;
}

export interface BiliTracks {
  video: BiliTrack[];
  audio: BiliTrack[];
  /** 时长（秒）。用码率 × 时长估体积，挑放得进上限的清晰度 */
  duration?: number;
}

const PLAYURL_RE =
  /^https?:\/\/api\.bilibili\.com\/(x\/player\/(wbi\/)?playurl|pgc\/player\/web\/(v2\/)?playurl|pugv\/player\/web\/playurl)([?#/]|$)/;

/** 是否是 B站 的播放地址接口（普通视频 / 番剧 / 课程） */
export function isBiliPlayurlApi(url: string): boolean {
  return PLAYURL_RE.test(url);
}

const isHttp = (s: unknown): s is string => typeof s === 'string' && /^https?:\/\//i.test(s);

function findDash(json: any): any {
  const roots = [json?.data, json?.result, json?.data?.video_info, json?.result?.video_info, json];
  for (const r of roots) if (r?.dash && Array.isArray(r.dash.video)) return r.dash;
  return null;
}

function toTrack(t: any): BiliTrack | null {
  const url = t?.baseUrl ?? t?.base_url;
  if (!isHttp(url)) return null;
  const rawBackups = t.backupUrl ?? t.backup_url;
  return {
    url,
    backups: Array.isArray(rawBackups) ? rawBackups.filter(isHttp) : [],
    id: Number(t.id) || 0,
    codecid: Number(t.codecid) || 0,
    codecs: typeof t.codecs === 'string' ? t.codecs : '',
    width: Number(t.width) || 0,
    height: Number(t.height) || 0,
    bandwidth: Number(t.bandwidth) || 0,
  };
}

/**
 * 从 __playinfo__ / playurl 接口响应里取出轨道清单。
 * 杜比全景声、Hi-Res 无损音轨不取：QuickTime 兼容性不稳，普通 AAC 到处能播。
 */
export function extractBiliTracks(json: unknown): BiliTracks | null {
  const dash = findDash(json);
  if (!dash) return null;
  const video = (dash.video as unknown[]).map(toTrack).filter((t): t is BiliTrack => Boolean(t));
  const audio = (Array.isArray(dash.audio) ? (dash.audio as unknown[]) : [])
    .map(toTrack)
    .filter((t): t is BiliTrack => Boolean(t));
  const root = (json as any)?.data ?? (json as any)?.result;
  const duration = Number(dash.duration) || Number(root?.timelength) / 1000 || undefined;
  return video.length ? { video, audio, duration } : null;
}

/**
 * 校验 postMessage 收到的清单（页面任何脚本都能发这个消息，不能照单全收）。
 * 形状不对就整个丢弃。
 */
export function sanitizeBiliTracks(raw: unknown): BiliTracks | null {
  const r = raw as { video?: unknown; audio?: unknown } | null;
  if (!r || !Array.isArray(r.video)) return null;
  const clean = (arr: unknown[]): BiliTrack[] =>
    arr.flatMap((t: any) =>
      isHttp(t?.url)
        ? [{
            url: t.url,
            backups: Array.isArray(t.backups) ? t.backups.filter(isHttp) : [],
            id: Number(t.id) || 0,
            codecid: Number(t.codecid) || 0,
            codecs: typeof t.codecs === 'string' ? t.codecs : '',
            width: Number(t.width) || 0,
            height: Number(t.height) || 0,
            bandwidth: Number(t.bandwidth) || 0,
          }]
        : [],
    );
  const video = clean(r.video);
  const duration = Number((r as { duration?: unknown }).duration) || undefined;
  return video.length ? { video, audio: Array.isArray(r.audio) ? clean(r.audio) : [], duration } : null;
}

export function biliCodec(t: BiliTrack): 'h264' | 'hevc' | 'av1' | undefined {
  if (t.codecid === 7 || /^avc1/i.test(t.codecs)) return 'h264';
  if (t.codecid === 12 || /^(hev1|hvc1)/i.test(t.codecs)) return 'hevc';
  if (t.codecid === 13 || /^av01/i.test(t.codecs)) return 'av1';
  return undefined;
}

const CODEC_RANK: Record<string, number> = { h264: 0, hevc: 1, av1: 2 };
const rankOf = (t: BiliTrack) => CODEC_RANK[biliCodec(t) ?? 'hevc'];

/** 码率 × 时长估算的字节数（清单的 bandwidth 是 bit/s）；缺数据时为 0 = 不知道 */
export function estimateBytes(t: BiliTrack | undefined, duration?: number): number {
  return t && duration ? Math.round((t.bandwidth * duration) / 8) : 0;
}

/**
 * 挑画面轨：
 * 1. 只要还有别的可选就不要 AV1（M1/M2 Mac 的 QuickTime、大量 Windows 播放器放不了）
 * 2. 放得进体积上限（limit 字节，已扣掉声音轨）：之前只看清晰度，一小时以上的 1080P
 *    必定超 600MB，而且要整段下完才报错（审查实锤）。都放不下就挑最小的那条
 * 3. 清晰度优先（高度 → 画质 qn）
 * 4. 同清晰度下 H.264 > HEVC（HEVC 下载时会修正成 hvc1，QuickTime 也能播）
 */
export function pickBiliVideo(video: BiliTrack[], duration?: number, limit = Infinity): BiliTrack | undefined {
  const playable = video.filter((v) => biliCodec(v) !== 'av1');
  const pool = playable.length ? playable : video;
  const fits = pool.filter((v) => estimateBytes(v, duration) <= limit);
  if (!fits.length) {
    return [...pool].sort((a, b) => a.bandwidth - b.bandwidth || rankOf(a) - rankOf(b))[0];
  }
  return [...fits].sort(
    (a, b) => b.height - a.height || b.id - a.id || rankOf(a) - rankOf(b) || b.bandwidth - a.bandwidth,
  )[0];
}

/** 挑声音轨：AAC 里码率最高的 */
export function pickBiliAudio(audio: BiliTrack[]): BiliTrack | undefined {
  const aac = audio.filter((a) => !a.codecs || /^mp4a/i.test(a.codecs));
  const pool = aac.length ? aac : audio;
  return [...pool].sort((a, b) => b.bandwidth - a.bandwidth || b.id - a.id)[0];
}

const CODEC_NAME = { h264: 'H.264', hevc: 'HEVC', av1: 'AV1' } as const;

/**
 * 清单 → 给用户看的「一个视频」。coversKeys 列出清单里所有轨道的文件名，
 * 归并时用它把嗅探到的同一视频的散轨（比如播放器实际在放的 AV1 轨）去掉，免得重复出现。
 */
export function biliMediaHit(tracks: BiliTracks, maxBytes = MAX_MEDIA_BYTES): MediaHit | null {
  const a = pickBiliAudio(tracks.audio);
  // 留 5% 余量：码率是平均值，实际文件会有上下浮动
  const budget = maxBytes * 0.95 - estimateBytes(a, tracks.duration);
  const v = pickBiliVideo(tracks.video, tracks.duration, budget);
  if (!v) return null;
  const codec = biliCodec(v);
  const p = Math.min(v.width, v.height) || v.height;
  const size = estimateBytes(v, tracks.duration) + estimateBytes(a, tracks.duration) || undefined;
  const tooBig = Boolean(size && size > maxBytes);
  return {
    url: v.url,
    kind: 'video',
    via: 'dom',
    streamKind: 'dash-track',
    track: 'video',
    codec,
    width: v.width || undefined,
    height: v.height || undefined,
    pairedAudioUrl: a?.url,
    backupUrls: v.backups.length ? v.backups : undefined,
    pairedAudioBackupUrls: a?.backups.length ? a.backups : undefined,
    curated: true,
    size,
    name: `${p ? `${p}P` : t('视频')}${codec ? ` · ${CODEC_NAME[codec]}` : ''}${
      tooBig ? t(' · 约 {0}MB，超出 {1}MB 上限，下不了', Math.round(size! / 1048576), Math.round(maxBytes / 1048576)) : ''
    }`.trim(),
    coversKeys: [...tracks.video, ...tracks.audio].map((t) => basenameKey(t.url)),
  };
}
