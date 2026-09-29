import { breadcrumb, containerLabel } from './sections';

/**
 * 在页面里给一个元素定位「它在哪个区块」：沿祖先链找 id/class/role 线索 + 最近的标题。
 * 只跑在 content script（需要 DOM），纯逻辑在 sections.ts。
 */

const MAX_DEPTH = 30;

function hintOf(el: Element): string {
  const cls = typeof el.className === 'string' ? el.className : '';
  return `${el.tagName.toLowerCase()} ${el.id} ${cls} ${el.getAttribute('role') ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
}

function nearestHeading(container: Element): string | undefined {
  const h = container.querySelector('h1, h2, h3');
  const t = h?.textContent?.trim();
  return t ? t.replace(/\s+/g, ' ').slice(0, 30) : undefined;
}

export function sectionOf(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  const labels: string[] = [];
  let heading: string | undefined;
  let cur: Element | null = el.parentElement;
  let depth = 0;
  while (cur && cur !== document.body && depth++ < MAX_DEPTH) {
    const label = containerLabel(hintOf(cur));
    if (label) {
      labels.unshift(label);
      // 只取最内层带标签容器的标题，外层标题（整页 h1）没有定位价值
      if (!heading && labels.length === 1) heading = nearestHeading(cur);
    }
    cur = cur.parentElement;
  }
  if (!labels.length) {
    // 没有任何分区线索：退而求其次，用最近的 section/article 的标题
    const box = el.closest('section, article');
    if (box) heading = nearestHeading(box);
  }
  const crumb = breadcrumb(labels, heading);
  return crumb || undefined;
}

/** 页面级信息：og 元数据 + 标题层级 */
export function collectPageInfo() {
  const meta = (name: string) =>
    document.querySelector<HTMLMetaElement>(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || undefined;
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map((h) => h.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter((t) => t.length >= 2)
    .slice(0, 30);
  return {
    ogType: meta('og:type'),
    description: meta('description') ?? meta('og:description'),
    headings,
    lang: document.documentElement.lang || undefined,
  };
}
