import type { MediaHit, MediaItem } from '../types';
import type { Candidate } from './types';

/**
 * 弹窗里的两张表（图片 items、音视频 media）→ agent 的统一候选列表。
 * id 沿用原对象的 id / url，命中后弹窗能直接映射回去打勾。
 */
export function buildCandidates(items: MediaItem[], media: MediaHit[]): Candidate[] {
  const imgs: Candidate[] = items.map((it, i) => ({
    id: it.id,
    kind: 'image',
    url: it.url,
    thumb: it.previewUrl ?? it.originalUrl,
    width: it.width,
    height: it.height,
    alt: it.alt || undefined,
    section: it.section,
    index: i,
    ext: it.ext,
  }));

  let vi = 0;
  let ai = 0;
  const meds: Candidate[] = [];
  for (const m of media) {
    // m3u8 还不能下载，别让 agent 选中一个下不了的东西
    if (m.kind === 'stream' && m.streamKind !== 'dash-track') continue;
    const isAudio = m.kind === 'audio' || m.track === 'audio';
    meds.push({
      id: m.url,
      kind: isAudio ? 'audio' : 'video',
      url: m.url,
      width: m.width ?? 0,
      height: m.height ?? 0,
      section: m.section,
      index: isAudio ? ai++ : vi++,
      sizeBytes: m.size,
      hasAudio: m.streamKind === 'dash-track' ? Boolean(m.pairedAudioUrl) : undefined,
    });
  }
  return [...imgs, ...meds];
}
