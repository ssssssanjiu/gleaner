import type { Candidate, PageInfo, PageVerdict } from './types';

/**
 * 页面摘要：发给模型的唯一文本。刻意只放结构化元数据（尺寸、alt、分区、文件名），
 * 不放页面正文 —— 既省 token，也把「页面内容注入指令」的面缩到最小。
 * 素材用 #1..#N 编号，模型只需要回编号，本地再映射回真实 id。
 */

export const DIGEST_MAX_ITEMS = 120;

function shortName(url: string): string {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(p).slice(0, 40);
  } catch {
    return '';
  }
}

function clean(s: string | undefined, max: number): string {
  return (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function buildDigest(
  page: PageInfo,
  verdict: PageVerdict,
  candidates: Candidate[],
  max = DIGEST_MAX_ITEMS,
): { text: string; ids: string[] } {
  const list = candidates.slice(0, max);
  const ids = list.map((c) => c.id);
  let host = '';
  let path = '';
  try {
    const u = new URL(page.url);
    host = u.hostname;
    path = u.pathname.slice(0, 60);
  } catch {
    /* ignore */
  }

  const lines: string[] = [];
  lines.push(`页面标题: ${clean(page.title, 80)}`);
  lines.push(`站点: ${host}${path}`);
  if (page.ogType) lines.push(`og:type: ${clean(page.ogType, 20)}`);
  if (page.description) lines.push(`描述: ${clean(page.description, 120)}`);
  lines.push(`本地初判: ${verdict.label}（${verdict.reason}）`);
  if (page.headings.length) {
    lines.push(`标题层级: ${page.headings.slice(0, 15).map((h) => clean(h, 40)).join(' | ')}`);
  }
  lines.push('');
  lines.push(`候选素材 ${list.length} 项（编号即 id）:`);
  const kindZh = { image: '图片', video: '视频', audio: '音频' } as const;
  list.forEach((c, i) => {
    const parts = [`#${i + 1}`, kindZh[c.kind]];
    if (c.width && c.height) parts.push(`${c.width}×${c.height}`);
    if (c.kind === 'video') parts.push(c.hasAudio === false ? '无声' : c.hasAudio ? '含声音' : '');
    if (c.sizeBytes) parts.push(`${(c.sizeBytes / 1048576).toFixed(1)}MB`);
    if (c.section) parts.push(`区域=${clean(c.section, 50)}`);
    if (c.alt) parts.push(`alt="${clean(c.alt, 60)}"`);
    const name = shortName(c.url);
    if (name) parts.push(`文件=${name}`);
    lines.push(parts.filter(Boolean).join(' '));
  });
  if (candidates.length > list.length) lines.push(`（另有 ${candidates.length - list.length} 项未列出）`);
  return { text: lines.join('\n'), ids };
}

/** 模型回的编号（"#3"、"3"、或直接 id）→ 真实 id；认不出的丢掉 */
export function resolveSelected(selected: string[], ids: string[]): string[] {
  const out: string[] = [];
  for (const s of selected) {
    const m = String(s).trim().match(/^#?(\d+)$/);
    if (m) {
      const id = ids[parseInt(m[1], 10) - 1];
      if (id && !out.includes(id)) out.push(id);
    } else if (ids.includes(s) && !out.includes(s)) {
      out.push(s);
    }
  }
  return out;
}
