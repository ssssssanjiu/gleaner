import type { MediaItem, ScanOptions, ScanResult, ItemSource } from './types';
import { upgradeUrl } from './rules';
import { collectPageInfo, sectionOf } from './agent/dom-sections';

const IMG_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|svg|heic)(\?|#|$)/i;
const LAZY_ATTRS = [
  'data-src',
  'data-original',
  'data-lazy-src',
  'data-actualsrc',
  'data-ks-lazyload',
  'data-echo',
  'data-url',
  'data-image',
  'data-thumb',
  'data-hi-res-src',
];

function absolute(u: string | null | undefined): string | null {
  if (!u) return null;
  const s = u.trim();
  if (!s || s.startsWith('data:') || s.startsWith('blob:') || s.startsWith('#')) return null;
  try {
    // 相对地址按文档的 base URL 解析（和浏览器算 currentSrc 的方式一致，<base href> 也算上）
    return new URL(s, document.baseURI || location.href).href;
  } catch {
    return null;
  }
}

export interface SrcsetCandidate {
  url: string;
  /** 宽度描述符 400w → 400（作者声明的图片真实宽度） */
  w?: number;
  /** 密度描述符 2x → 2；没写描述符时为 undefined（等同 1x） */
  x?: number;
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';

/**
 * 按 HTML 规范解析 srcset：URL 一直读到空白为止 —— URL 里的逗号是 URL 的一部分
 * （阿里云 OSS 的 resize,w_800、Cloudinary 的 w_400,c_fill），只有描述符后面的逗号才是分隔符。
 * 描述符非法（比如一个候选同时写了 w 和 x）的候选按规范丢掉。
 */
export function parseSrcset(srcset: string): SrcsetCandidate[] {
  const out: SrcsetCandidate[] = [];
  const s = srcset ?? '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(s[i]) || s[i] === ',')) i++;
    if (i >= n) break;
    const start = i;
    while (i < n && !isSpace(s[i])) i++;
    let url = s.slice(start, i);
    const descs: string[] = [];
    if (url.endsWith(',')) {
      // 「a.jpg, b.jpg 2x」：URL 紧跟逗号 = 没有描述符
      url = url.replace(/,+$/, '');
    } else {
      let cur = '';
      let inParens = false;
      while (i < n) {
        const c = s[i++];
        if (inParens) {
          cur += c;
          if (c === ')') inParens = false;
        } else if (c === '(') {
          cur += c;
          inParens = true;
        } else if (c === ',') {
          break;
        } else if (isSpace(c)) {
          if (cur) descs.push(cur);
          cur = '';
        } else {
          cur += c;
        }
      }
      if (cur) descs.push(cur);
    }
    if (!url) continue;
    const cand: SrcsetCandidate = { url };
    let valid = true;
    for (const d of descs) {
      const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(d);
      if (!m) continue; // 不认识的描述符（如未来的 h）忽略
      if (cand.w !== undefined || cand.x !== undefined) valid = false;
      if (m[2].toLowerCase() === 'w') cand.w = Math.round(parseFloat(m[1]));
      else cand.x = parseFloat(m[1]);
    }
    if (valid && !(cand.w === 0) && !(cand.x === 0)) out.push(cand);
  }
  return out;
}

const KNOWN_EXT = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico', 'heic', 'heif', 'tif', 'tiff', 'jxl', 'apng', 'jfif',
]);
const FORMAT_ALIAS: Record<string, string> = { jpeg: 'jpg', pjpg: 'jpg', pjpeg: 'jpg', jfif: 'jpg' };
const normFormat = (f: string) => FORMAT_ALIAS[f.toLowerCase()] ?? f.toLowerCase();

/**
 * 推断下载文件的扩展名：
 *   1. 路径末尾是图片扩展名 → 用它（a.png_360x360q90.jpg 升级后是 a.png）
 *   2. 查询参数里的格式提示：公众号 wx_fmt=gif、imgix fm=webp、推特 format=png、
 *      OSS x-oss-process=...format,webp、七牛 imageView2/.../format/webp
 *   3. 都没有才默认 jpg（逐个下载时 Chrome 会按响应 MIME 再纠正；ZIP 包里按 content-type 纠正）
 */
export function extOf(url: string): string {
  let u: URL | null = null;
  try {
    u = new URL(url);
  } catch {
    /* 相对地址等：退回按字符串猜 */
  }
  const path = u ? u.pathname : url.split(/[?#]/)[0];
  const m = path.match(/\.([a-z0-9]{2,5})$/i);
  if (m && KNOWN_EXT.has(m[1].toLowerCase())) return m[1].toLowerCase();
  if (u) {
    for (const k of ['wx_fmt', 'fm', 'format', 'imageformat']) {
      const v = u.searchParams.get(k);
      if (v && KNOWN_EXT.has(normFormat(v))) return normFormat(v);
    }
    const q = decodeURIComponentSafe(u.search);
    const fm = q.match(/(?:format[,/])([a-z0-9]{3,4})\b/i);
    if (fm && KNOWN_EXT.has(normFormat(fm[1]))) return normFormat(fm[1]);
  }
  return 'jpg';
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 触发懒加载：分段滚到底再滚回原位 */
async function autoScrollPage(): Promise<void> {
  const startY = window.scrollY;
  const step = window.innerHeight * 0.8;
  const max = () => document.documentElement.scrollHeight;
  let y = 0;
  let guard = 0;
  while (y < max() && guard++ < 60) {
    y += step;
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 120));
  }
  window.scrollTo(0, startY);
  await new Promise((r) => setTimeout(r, 200));
}

const DECODABLE = new Set([
  'image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp', 'image/avif',
  'image/svg+xml', 'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon',
]);

/** 同一个 <img> 的一个可选变体（来自 srcset、<picture><source>、或 src 本身） */
interface Variant extends SrcsetCandidate {
  /** 属于哪一组：0 = img 自己的 srcset/src，1.. = <picture> 里的各个 <source> */
  set: number;
}

interface Pick {
  best: Variant;
  /** 一共有几个变体（>1 说明来自 srcset / <picture>） */
  count: number;
  /** 用来预览的最小变体 */
  smallest: Variant;
  /** 浏览器实际加载的那个变体（currentSrc），没加载就是 undefined */
  loaded?: Variant;
  /** 下载文件（best）的真实尺寸；不知道就是 0 */
  width: number;
  height: number;
  /** 仅供过滤 / 排序参考的估计尺寸（不展示给用户） */
  hintW: number;
  hintH: number;
}

/**
 * 一个 <img>（连同它所在 <picture> 的全部 <source>）只挑一个变体下载：
 * 有宽度描述符就取最大宽度；全是密度描述符就取最大倍率；并列时优先浏览器正在用的那一组
 * （它一定能在这台机器上解码，而且宽高比已知）。
 * 尺寸只报知道的：w 描述符就是作者声明的真实宽度；浏览器加载的那张用 naturalWidth×倍率还原；
 * 其余一律 0（弹窗显示扩展名，不冒充分辨率）。
 */
function pickVariant(img: HTMLImageElement): Pick | null {
  const variants: Variant[] = [];
  const setHasMedia: boolean[] = [];
  const add = (cands: SrcsetCandidate[], set: number) => {
    for (const c of cands) {
      const url = absolute(c.url);
      if (url) variants.push({ ...c, url, set });
    }
  };

  const own = img.getAttribute('srcset') ? parseSrcset(img.getAttribute('srcset') || '') : [];
  add(own, 0);
  setHasMedia[0] = false;
  // 规范：srcset 里没有宽度描述符、也没有 1x 时，src 本身就是 1x 候选
  const src = img.getAttribute('src');
  if (src && !own.some((c) => c.w !== undefined || (c.x ?? 1) === 1)) add([{ url: src }], 0);

  const pic = img.parentElement;
  if (pic && pic.tagName === 'PICTURE') {
    let set = 1;
    for (const s of Array.from(pic.children)) {
      if (s.tagName !== 'SOURCE') continue;
      const ss = s.getAttribute('srcset');
      if (!ss) continue;
      // 浏览器解不了的格式（如 image/jxl）不当候选：下下来也打不开
      const type = (s.getAttribute('type') || '').trim().toLowerCase();
      if (type && !DECODABLE.has(type)) continue;
      setHasMedia[set] = s.hasAttribute('media');
      add(parseSrcset(ss), set);
      set++;
    }
  }

  const current = absolute(img.currentSrc || img.src);
  // currentSrc 不在任何一组里（脚本换过 src 等）：它就是这张图
  if (current && !variants.some((v) => v.url === current)) variants.push({ url: current, set: 0 });
  if (!variants.length) return null;

  const nw = img.naturalWidth || 0;
  const nh = img.naturalHeight || 0;
  const loaded = current && nw > 0 ? variants.find((v) => v.url === current) : undefined;

  const hasW = variants.some((v) => v.w !== undefined);
  const pool = hasW ? variants.filter((v) => v.w !== undefined) : variants;
  const score = (v: Variant) => (hasW ? v.w! : v.x ?? 1);
  const pref = (v: Variant) => (v === loaded ? 2 : loaded && v.set === loaded.set ? 1 : 0);
  let best = pool[0];
  let smallest = pool[0];
  for (const v of pool) {
    if (score(v) > score(best) || (score(v) === score(best) && pref(v) > pref(best))) best = v;
    if (score(v) < score(smallest)) smallest = v;
  }

  let width = 0;
  let height = 0;
  let hintW = 0;
  let hintH = 0;
  if (best.w !== undefined) {
    width = best.w;
    // 同一组（或都没有 media 条件、只是换格式的几组）里是同一张图的不同尺寸，宽高比相同
    const sameImage = loaded && (loaded.set === best.set || (!setHasMedia[loaded.set] && !setHasMedia[best.set]));
    if (sameImage && nw > 0 && nh > 0) height = Math.round((best.w * nh) / nw);
    hintW = width;
    hintH = height;
  } else if (loaded && best === loaded) {
    // naturalWidth 是按密度折算过的（2x 图报一半），乘回倍率才是文件的真实像素
    const d = best.x ?? 1;
    width = Math.round(nw * d);
    height = Math.round(nh * d);
    hintW = width;
    hintH = height;
  } else if (loaded) {
    // 倍率更高的那张没加载过：尺寸只能估计（按作者的倍率换算），只拿来过滤 / 排序
    const d = best.x ?? 1;
    hintW = Math.round(nw * d);
    hintH = Math.round(nh * d);
  } else {
    // 还没加载（懒加载 / 失败）：沿用渲染尺寸做过滤参考，不当成文件尺寸展示
    hintW = img.width || 0;
    hintH = img.height || 0;
  }
  return { best, count: variants.length, smallest, loaded, width, height, hintW, hintH };
}

interface Meta {
  /** URL 被站点规则改写过：真实尺寸未知 */
  upgraded: boolean;
  /**
   * 升级过、且站点的小缩略图本身就是内容（淘宝/京东商品图库）：不能按缩略图尺寸过滤。
   * 其余升级过的（B站 评论区头像 @48w 等）照样按页面上的尺寸过滤，否则几十个头像全列出来
   */
  keepSmall: boolean;
  hintW: number;
  hintH: number;
}

export async function scanPage(opts: ScanOptions): Promise<ScanResult> {
  const t0 = performance.now();
  if (opts.autoScroll) await autoScrollPage();

  /** key = 升级后的 URL，保证同一张图只留一条记录 */
  const found = new Map<string, MediaItem>();
  const meta = new Map<MediaItem, Meta>();

  const push = (
    rawUrl: string | null,
    source: ItemSource,
    size: { width: number; height: number; hintW: number; hintH: number },
    alt?: string,
    preview?: string | null,
    el?: Element,
    /** 页面上实际显示的地址（下载失败时的退路）；默认就是 rawUrl */
    shown?: string | null,
  ) => {
    const abs = absolute(rawUrl);
    if (!abs) return;
    const absPreview = absolute(preview ?? null) ?? absolute(shown ?? null) ?? abs;
    const { url, ruleId, sameSize, thumbnailsAreContent } = upgradeUrl(abs);
    // 只去压缩参数的规则（公众号）不改分辨率，量到的尺寸仍然作数
    const upgraded = url !== abs && !sameSize;
    // 规则改写过的地址指向原图：缩略图的尺寸不是它的尺寸
    const width = upgraded ? 0 : size.width;
    const height = upgraded ? 0 : size.height;
    const prev = found.get(url);
    if (prev) {
      const m = meta.get(prev)!;
      if (width * height > prev.width * prev.height || (!prev.width && !prev.height && (width || height))) {
        prev.width = width;
        prev.height = height;
      }
      m.upgraded ||= upgraded;
      m.keepSmall ||= upgraded && Boolean(thumbnailsAreContent);
      if (size.hintW * size.hintH > m.hintW * m.hintH) {
        m.hintW = size.hintW;
        m.hintH = size.hintH;
      }
      if (!prev.section && el) prev.section = sectionOf(el);
      return;
    }
    const item: MediaItem = {
      id: url,
      url,
      originalUrl: absolute(shown ?? null) ?? abs,
      previewUrl: absPreview,
      ruleId,
      width,
      height,
      ext: extOf(url),
      source,
      alt,
      section: el ? sectionOf(el) : undefined,
    };
    found.set(url, item);
    meta.set(item, {
      upgraded,
      keepSmall: upgraded && Boolean(thumbnailsAreContent),
      hintW: size.hintW,
      hintH: size.hintH,
    });
  };
  const UNKNOWN = { width: 0, height: 0, hintW: 0, hintH: 0 };

  // 1. <img>：一张图一条记录（srcset 各档、<picture> 各种格式合并成一张，挑最好的那个下载）
  const pictured = new Set<Element>();
  for (const img of Array.from(document.images)) {
    const p = pickVariant(img);
    const variantUrls = new Set<string>();
    if (p) {
      if (img.parentElement?.tagName === 'PICTURE') pictured.add(img.parentElement);
      const shown = p.loaded?.url ?? p.best.url;
      push(
        p.best.url,
        p.count > 1 && p.best !== p.loaded ? 'srcset' : 'img',
        p,
        img.alt,
        p.smallest.url,
        img,
        shown,
      );
      variantUrls.add(p.best.url);
      variantUrls.add(p.smallest.url);
      if (p.loaded) variantUrls.add(p.loaded.url);
    }
    for (const attr of LAZY_ATTRS) {
      const v = absolute(img.getAttribute(attr));
      // 已经是这张图的某个变体（懒加载完成后 data-src == src）就不再单列一张
      if (!v || variantUrls.has(v)) continue;
      variantUrls.add(v);
      // 尺寸传 0（未知）：占位图往往是 1×1，继承它的尺寸会让真图被 minSize 误杀
      push(v, 'lazy', UNKNOWN, img.alt, null, img);
    }
  }

  // 2. 没有 <img> 的 <picture>（不规范但见过）：每个 picture 一条
  for (const pic of Array.from(document.querySelectorAll('picture'))) {
    if (pictured.has(pic)) continue;
    let best: SrcsetCandidate | null = null;
    let smallest: SrcsetCandidate | null = null;
    for (const s of Array.from(pic.querySelectorAll('source[srcset]'))) {
      for (const c of parseSrcset(s.getAttribute('srcset') || '')) {
        const sc = c.w ?? (c.x ?? 1);
        if (!best || sc > (best.w ?? best.x ?? 1)) best = c;
        if (!smallest || sc < (smallest.w ?? smallest.x ?? 1)) smallest = c;
      }
    }
    if (best) {
      const w = best.w ?? 0;
      push(best.url, 'srcset', { width: w, height: 0, hintW: w, hintH: 0 }, undefined, smallest?.url, pic);
    }
  }

  // 3. 指向图片文件的 <a href>：相册站常见的「缩略图外套原图链接」
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    if (IMG_EXT.test(a.href)) push(a.href, 'link', UNKNOWN, undefined, null, a);
  }

  // 4. CSS 背景图（开销较大，限制遍历规模）
  if (opts.includeBackground) {
    const els = Array.from(document.querySelectorAll<HTMLElement>('*')).slice(0, 4000);
    for (const el of els) {
      const rect = el.getBoundingClientRect();
      // 元素盒子太小的背景多半是图标 / 雪碧图，直接跳过
      if (rect.width < opts.minSize && rect.height < opts.minSize) continue;
      const bg = getComputedStyle(el).backgroundImage;
      if (!bg || bg === 'none') continue;
      for (const m of bg.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
        // 盒子尺寸不是图片尺寸（600px 的图铺在 300px 的 div 里），只拿来排序
        const box = { width: 0, height: 0, hintW: Math.round(rect.width), hintH: Math.round(rect.height) };
        push(m[2], 'background', box, undefined, null, el);
      }
    }
  }

  const all = Array.from(found.values());
  // 只知道宽（srcset 的 w 描述符、跨组没法推高）时按正方形估面积，别排到最后去
  const area = (w: number, h: number) => (w && h ? w * h : Math.max(w, h) ** 2);
  const hintArea = (it: MediaItem) => {
    const m = meta.get(it)!;
    return Math.max(area(it.width, it.height), area(m.hintW, m.hintH));
  };
  const items = all
    .filter((it) => {
      const m = meta.get(it)!;
      // 商品图库的缩略图：下载的是原图，缩略图多小都不能按它过滤（淘宝缩略图条 60px → 800px 原图）
      if (m.keepSmall) return true;
      const w = it.width || m.hintW;
      const h = it.height || m.hintH;
      // 尺寸未知（懒加载尚未渲染）的一律保留，交给用户在面板里筛
      if (w === 0 && h === 0) return true;
      return w >= opts.minSize || h >= opts.minSize;
    })
    .sort((a, b) => hintArea(b) - hintArea(a));

  return {
    items,
    pageUrl: location.href,
    pageTitle: document.title,
    elapsed: Math.round(performance.now() - t0),
    page: collectPageInfo(),
  };
}
