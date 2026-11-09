import type { Candidate, PageInfo, PageType, PageVerdict } from './types';
import { t } from '../i18n';

/**
 * 页面类型的本地判断：域名规则 + og:type + 素材构成。
 * 不需要模型就能给出「视频页 / 图库 / 商品页」这种一眼判断；上云时也把它作为提示
 * 一并发给模型，模型可以纠正。
 */

const HOST_RULES: Array<[RegExp, PageType]> = [
  [/(^|\.)(bilibili\.com|youtube\.com|youtu\.be|douyin\.com|kuaishou\.com|vimeo\.com|ixigua\.com|acfun\.cn|iqiyi\.com|v\.qq\.com|youku\.com|twitch\.tv|tiktok\.com)$/, 'video'],
  [/(^|\.)(unsplash\.com|pexels\.com|pixabay\.com|flickr\.com|500px\.com|artstation\.com|behance\.net|dribbble\.com|huaban\.com|pinterest\.[a-z.]+|zcool\.com\.cn|deviantart\.com|imgur\.com)$/, 'gallery'],
  [/(^|\.)(taobao\.com|tmall\.com|jd\.com|pinduoduo\.com|yangkeduo\.com|amazon\.[a-z.]+|aliexpress\.[a-z.]+|1688\.com|shopee\.[a-z.]+|etsy\.com|ebay\.[a-z.]+|xiaohongshu\.com)$/, 'product'],
  [/(^|\.)(weibo\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|reddit\.com|zhihu\.com|douban\.com|tieba\.baidu\.com|v2ex\.com|threads\.net|mastodon\.[a-z.]+|linkedin\.com)$/, 'social'],
];

const LABEL: Record<PageType, string> = {
  video: '视频页',
  gallery: '图库',
  article: '文章页',
  product: '商品页',
  social: '社交/社区页',
  search: '搜索结果页',
  home: '首页',
  other: '普通网页',
};

export function classifyPage(page: PageInfo, candidates: Candidate[]): PageVerdict {
  let host = '';
  let path = '';
  let search = '';
  try {
    const u = new URL(page.url);
    host = u.hostname.replace(/^www\./, '');
    path = u.pathname;
    search = u.search;
  } catch {
    /* 非法 URL 只靠内容判断 */
  }
  const done = (type: PageType, reason: string): PageVerdict => ({
    type,
    label: host ? `${t(LABEL[type])} · ${host}` : t(LABEL[type]),
    reason,
  });

  // 搜索结果：URL 形态最可靠
  if (/\/(search|s|so|query)\b/.test(path) || /[?&](q|query|wd|keyword|kw|search)=/.test(search)) {
    return done('search', t('URL 带搜索参数'));
  }

  for (const [re, type] of HOST_RULES) {
    if (re.test(host)) {
      // 站点首页单独算（视频站首页不是视频页）
      if (path === '/' || path === '') return done('home', t('{0} 首页', host));
      return done(type, t('已知站点 {0}', host));
    }
  }

  const og = (page.ogType ?? '').toLowerCase();
  if (og.startsWith('video')) return done('video', 'og:type=video');
  if (og === 'article' || og.startsWith('article')) return done('article', 'og:type=article');
  if (og.startsWith('product')) return done('product', 'og:type=product');
  if (og === 'profile') return done('social', 'og:type=profile');

  const images = candidates.filter((c) => c.kind === 'image').length;
  const videos = candidates.filter((c) => c.kind === 'video').length;
  const headings = page.headings.length;

  if (videos >= 1 && images <= 8) return done('video', t('{0} 个视频、图片很少', videos));
  if (images >= 20 && headings <= 3) return done('gallery', t('{0} 张图、几乎没有标题层级', images));
  if (headings >= 3 && images <= 12) return done('article', t('{0} 级标题、图片不多', headings));
  if (host && (path === '/' || path === '')) return done('home', t('站点根路径'));
  return done('other', t('没有明显特征'));
}
