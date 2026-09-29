/**
 * 页面分区词表：DOM 线索（id / class / role / 标签名）和用户口语（「评论区」「侧栏」）
 * 都归一到同一个 label，这样「评论区的视频」才能在本地按面包屑直接匹配。
 * 一份词表两头用，避免两边各写一套对不上。
 */

export interface SectionDef {
  label: string;
  /** 匹配 DOM 线索串：`${tag} ${id} ${class} ${role} ${aria-label}` */
  dom: RegExp;
  /** 匹配用户的话（已小写） */
  query: RegExp;
}

export const SECTIONS: readonly SectionDef[] = [
  { label: '评论区', dom: /comment|reply|replies|discuss|review/i, query: /评论区?|留言区?|回复区?|comments?\b|reviews?\b/ },
  { label: '页头', dom: /^header\b|masthead|site-header|page-header|topbar|top-bar/i, query: /页头|头部|顶部|最上[面方]|header\b|top of/ },
  { label: '导航', dom: /^nav\b|navbar|navigation|\bmenu\b/i, query: /导航栏?|菜单|nav(igation)?\b|menu\b/ },
  { label: '页脚', dom: /^footer\b|site-footer|page-footer|bottombar|bottom-bar/i, query: /页脚|底部|最下[面方]|footer\b|bottom of/ },
  { label: '侧边栏', dom: /^aside\b|sidebar|side-bar|rightbar|leftbar|complementary/i, query: /侧边栏?|侧栏|边栏|sidebar|aside\b/ },
  { label: '正文', dom: /^main\b|^article\b|article-content|post-content|entry-content|main-content|content-body|rich-?text/i, query: /正文|文章里?|主体|main content|article body|body text/ },
  { label: '推荐区', dom: /recommend|related|suggest|more-like|you-may|also-like|rcmd/i, query: /推荐区?|相关(推荐|内容)?|related\b|recommend/ },
  { label: '图集', dom: /gallery|carousel|swiper|slider|slideshow|banner|lightbox|album/i, query: /轮播图?|图集|画廊|相册|banner\b|carousel|gallery|slider/ },
  { label: '商品区', dom: /product|goods|\bsku\b|item-detail|merchandise|shop/i, query: /商品|产品|货品|product|goods/ },
  { label: '头像', dom: /avatar|profile-pic|user-pic|headshot/i, query: /头像|avatar/ },
  { label: '广告', dom: /\bads?\b|advert|sponsor|promo/i, query: /广告|\bads?\b|sponsor/ },
  { label: '播放器', dom: /player|video-wrap|bilibili-player/i, query: /播放器|player\b/ },
  { label: '搜索结果', dom: /search-result|result-list|\bsearch\b/i, query: /搜索结果|search results?/ },
];

/** 一个容器元素的线索 → 分区 label；没线索返回 null */
export function containerLabel(hint: string): string | null {
  for (const s of SECTIONS) if (s.dom.test(hint)) return s.label;
  return null;
}

/** 由外到内的 label 列表 + 最近标题 → 面包屑文本 */
export function breadcrumb(labels: string[], heading?: string): string {
  const uniq: string[] = [];
  for (const l of labels) if (!uniq.includes(l)) uniq.push(l);
  const parts = uniq.slice(-3);
  const h = heading?.trim().replace(/\s+/g, ' ').slice(0, 30);
  if (h && !parts.includes(h)) parts.push(h);
  return parts.join(' › ');
}

/** 用户的话里提到的分区（取第一个命中），并返回用于「消费」原文的正则 */
export function sectionInQuery(text: string): { label: string; re: RegExp } | null {
  for (const s of SECTIONS) if (s.query.test(text)) return { label: s.label, re: s.query };
  return null;
}

/** 面包屑是否属于某分区。label 命中即可；「正文」额外接受没有任何分区标签的素材 */
export function sectionMatches(section: string | undefined, label: string): boolean {
  if (!section) return label === '正文';
  return section.includes(label);
}
