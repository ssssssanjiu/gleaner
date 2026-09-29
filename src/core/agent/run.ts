import type { AgentQuery, AgentResult, AgentSettings, Candidate, ColorName, Intent, PageType } from './types';
import { describeIntent, parseIntent } from './intent';
import { classifyPage } from './page-type';
import { analyzePixels, matchesColor } from './color';
import { sectionMatches } from './sections';
import { buildDigest, resolveSelected } from './digest';
import { SHEET_MAX_ITEMS, SHEET_MAX_SHEETS, chunk } from './sheet';
import type { CloudReply, CloudRequest } from './claude';

/**
 * agent 主流程（纯逻辑，外部能力全部注入，便于单测）：
 *   解析意图 → 本地筛选（类型/尺寸/方向/分区/颜色/序号）→ 还有语义残留才上云。
 */

export interface AgentDeps {
  /** 取缩略图的 RGBA 像素；拿不到返回 null（视为颜色未知，不命中） */
  pixels(url: string): Promise<ArrayLike<number> | null>;
  /**
   * 把一批候选缩略图拼成联络表，每格角上印 labels[i]（就是摘要里的 #n）；
   * 失败返回 null（云端就只能靠文字推断）
   */
  sheet(
    cands: Candidate[],
    labels: string[],
  ): Promise<{ data: string; mediaType: 'image/jpeg' | 'image/png' } | null>;
  ask(req: CloudRequest): Promise<CloudReply>;
}

const PAGE_LABEL: Record<PageType, string> = {
  video: '视频页', gallery: '图库', article: '文章页', product: '商品页',
  social: '社交/社区页', search: '搜索结果页', home: '首页', other: '普通网页',
};

export async function mapLimit<T, R>(arr: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(arr.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= arr.length) return;
      out[idx] = await fn(arr[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

function side(c: Candidate) {
  return Math.max(c.width, c.height);
}

/** 本地能做的全部筛选 */
export async function localFilter(
  intent: Intent,
  all: Candidate[],
  pixels: AgentDeps['pixels'],
): Promise<{ list: Candidate[]; applied: boolean }> {
  let list = intent.kind === 'any' ? all.slice() : all.filter((c) => c.kind === intent.kind);
  let applied = intent.kind !== 'any';

  if (intent.minSide) {
    list = list.filter((c) => side(c) >= intent.minSide!);
    applied = true;
  }
  if (intent.maxSide) {
    list = list.filter((c) => c.width && c.height && side(c) <= intent.maxSide!);
    applied = true;
  }
  if (intent.orientation) {
    list = list.filter((c) => {
      if (!c.width || !c.height) return false;
      const r = c.width / c.height;
      if (intent.orientation === 'landscape') return r > 1.15;
      if (intent.orientation === 'portrait') return r < 0.87;
      return r >= 0.87 && r <= 1.15;
    });
    applied = true;
  }
  if (intent.section) {
    list = list.filter((c) => sectionMatches(c.section, intent.section!));
    applied = true;
  }
  if (intent.colors.length) {
    // 只有图片有缩略图可分析；视频封面拿不到，颜色条件下直接排除
    const imgs = list.filter((c) => c.kind === 'image' && c.thumb);
    const hits = await mapLimit(imgs, 6, async (c) => {
      const px = await pixels(c.thumb!);
      if (!px) return false;
      const prof = analyzePixels(px);
      return intent.colors.some((name: ColorName) => matchesColor(prof, name));
    });
    list = imgs.filter((_, i) => hits[i]);
    applied = true;
  }

  if (intent.ordinal) {
    const byIndex = list.slice().sort((a, b) => a.index - b.index);
    list = byIndex[intent.ordinal - 1] ? [byIndex[intent.ordinal - 1]] : [];
    applied = true;
  } else if (intent.order) {
    const sorted = list.slice();
    if (intent.order === 'largest') sorted.sort((a, b) => b.width * b.height - a.width * a.height);
    else if (intent.order === 'smallest') sorted.sort((a, b) => a.width * a.height - b.width * b.height);
    else if (intent.order === 'first') sorted.sort((a, b) => a.index - b.index);
    else sorted.sort((a, b) => b.index - a.index);
    list = sorted.slice(0, intent.limit ?? 1);
    applied = true;
  }
  return { list, applied };
}

export async function runAgent(q: AgentQuery, settings: AgentSettings, deps: AgentDeps): Promise<AgentResult> {
  const intent = parseIntent(q.text);
  const page = classifyPage(q.page, q.candidates);
  const base = { page, intent };

  if (!q.candidates.length) {
    return { ok: true, via: 'local', matchedIds: [], explanation: '页面上还没扫到任何素材', ...base };
  }

  const { list, applied } = await localFilter(intent, q.candidates, deps.pixels);
  const desc = describeIntent(intent);

  // 分区没命中：页面可能根本没标出那个区块，让云端按内容再试一次（开了的话）
  const sectionMiss = Boolean(intent.section) && list.length === 0;
  const wantCloud = intent.needsCloud || sectionMiss;

  if (!wantCloud) {
    return {
      ok: true, via: 'local', matchedIds: list.map((c) => c.id),
      explanation: applied ? `本地筛选：${desc} → 命中 ${list.length} 项` : `未识别到筛选条件，列出全部 ${list.length} 项`,
      ...base,
    };
  }

  if (!settings.cloudEnabled) {
    const why = intent.needsCloud
      ? `「${intent.semantic}」需要看内容才能判断`
      : `页面上没有标记为「${intent.section}」的区块`;
    return {
      ok: true, via: 'local', matchedIds: [], needsCloud: true,
      explanation: `${why}。本地只能按颜色、尺寸、方向、位置、序号筛选；在设置里开启云端助手（需自带 API Key）后可以理解这类请求。`,
      ...base,
    };
  }

  // 上云：先用本地条件缩小范围（分区没命中时退回全量），再交给模型
  const pool = sectionMiss ? (intent.kind === 'any' ? q.candidates : q.candidates.filter((c) => c.kind === intent.kind)) : (applied ? list : q.candidates);
  const { text, ids } = buildDigest(q.page, page, pool);
  const listed = pool.slice(0, ids.length);

  // 联络表：只拼图片（视频没封面可拼）
  const sheets: CloudRequest['sheets'] = [];
  const imgs = listed.filter((c) => c.kind === 'image' && c.thumb);
  if (intent.kind !== 'audio' && imgs.length) {
    for (const group of chunk(imgs, SHEET_MAX_ITEMS).slice(0, SHEET_MAX_SHEETS)) {
      const nums = group.map((c) => `#${ids.indexOf(c.id) + 1}`);
      const img = await deps.sheet(group, nums);
      if (!img) continue;
      sheets.push({ ...img, caption: `联络表（每格左上角的数字是编号）：${nums[0]} ~ ${nums[nums.length - 1]}，共 ${group.length} 格` });
    }
  }

  const reply = await deps.ask({ settings, question: q.text, digest: text, sheets });
  const matched = resolveSelected(reply.selected, ids);
  const verdict = reply.pageType && reply.pageType !== page.type
    ? { ...page, type: reply.pageType, label: page.label.replace(/^[^·]+/, PAGE_LABEL[reply.pageType]), reason: '模型判断' }
    : page;
  return {
    ok: true, via: 'cloud', matchedIds: matched, page: verdict, intent,
    explanation: reply.explanation || (matched.length ? `模型选出 ${matched.length} 项` : '模型没有选中任何素材'),
    clarify: reply.clarify,
    usage: reply.usage,
  };
}
