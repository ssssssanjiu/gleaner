/**
 * 站点适配规则表 —— 本项目的核心资产。
 *
 * 每条规则做两件事：
 *   1. upgrade()  把页面上的缩略图 URL 还原成原图 URL
 *   2. referer    某些图床有防盗链，下载时需要伪造 Referer
 *
 * 匹配只看解析后的 URL：host 对「主机名」测试，when 再按路径 / 参数细判。
 * 不能对整条 URL 跑正则 —— 代理地址（images.weserv.nl/?url=wx1.sinaimg.cn/...）
 * 的参数里经常带着别家图床的域名，整条匹配会把代理当成微博图，剥掉参数后只剩代理站首页。
 *
 * 欢迎 PR 新规则，写法见 CONTRIBUTING.md。
 */

export interface SiteRule {
  id: string;
  name: string;
  /** 匹配图片 URL 的主机名（不是页面 URL，也不看路径和参数）。写成 /(^|\.)example\.com$/i 这样锚定到结尾 */
  host: RegExp;
  /** 可选：主机名命中后再按解析后的 URL 细判（路径 / 参数），返回 false 就当没命中 */
  when?: (url: URL) => boolean;
  upgrade?: (url: string) => string;
  /** 改写只去掉压缩 / 转格式参数、不改分辨率（页面上量到的尺寸就是原图尺寸） */
  sameSize?: boolean;
  /**
   * 页面上的小缩略图本身就是内容（商品图库的缩略图条）：升级后是大图，不能按缩略图尺寸过滤。
   * 只给确实如此的站点开 —— 别的站（B站 评论区头像 @48w 也能升级）小图多是头像/图标，
   * 一律放行会把几十个头像全列出来还默认全选
   */
  thumbnailsAreContent?: boolean;
  /** 下载时伪造的 Referer，通常是站点首页 */
  referer?: string;
}

const stripQuery = (u: string) => u.split('?')[0];

/**
 * 带签名 / 鉴权的参数：私有桶、防盗链 CDN 的地址靠它们放行，而且签名往往把整条 query
 * （含处理参数，OSS V1 连 x-oss-process 都签进去）算在内 —— 改动任何参数都会 403。
 * 通用规则（oss-generic / imgix）遇到这些参数一律不升级，原样下载页面上能打开的那一张。
 * 站点专属规则（如微博的 KID/Expires/ssig）是逐条实测过剥掉仍能下的，不受此限。
 */
const SIGNATURE_PARAMS = new Set([
  // 阿里云 OSS V1 / V4、STS
  'ossaccesskeyid', 'signature', 'expires', 'security-token',
  'x-oss-signature', 'x-oss-credential', 'x-oss-date', 'x-oss-expires', 'x-oss-signature-version',
  'x-oss-security-token',
  // 腾讯云 COS
  'q-sign-algorithm', 'q-ak', 'q-sign-time', 'q-key-time', 'q-header-list', 'q-url-param-list',
  'q-signature', 'x-cos-security-token',
  // 七牛私有空间
  'token', 'e',
  // AWS S3 / CloudFront
  'x-amz-signature', 'x-amz-credential', 'x-amz-algorithm', 'x-amz-security-token',
  'awsaccesskeyid', 'key-pair-id', 'policy',
  // 常见 CDN 防盗链（阿里云 CDN A 型 auth_key、腾讯云 sign/t、又拍云 _upt、imgix 安全签名 s）
  'auth_key', 'sign', '_upt', 'txsecret', 's', 'sig',
]);

/** query 里每一段的「参数名」（解码后、小写）。七牛斜杠语法 ?imageView2/2/w/100 的参数名就是整段 */
function paramKeys(url: URL): string[] {
  return url.search
    .slice(1)
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const k = part.split('=')[0];
      try {
        return decodeURIComponent(k.replace(/\+/g, ' ')).toLowerCase();
      } catch {
        return k.toLowerCase();
      }
    });
}

export function isSignedUrl(raw: string | URL): boolean {
  try {
    const url = typeof raw === 'string' ? new URL(raw) : raw;
    return paramKeys(url).some((k) => SIGNATURE_PARAMS.has(k));
  } catch {
    return false;
  }
}

/**
 * 图片处理参数（缩放 / 裁剪 / 压缩 / 水印），删掉即原图：
 *   OSS：x-oss-process=image/resize,w_300
 *   七牛 / 腾讯数据万象：imageView2/2/w/100、imageMogr2/thumbnail/300x、watermark/1/...、imageslim
 * 只认完整的参数名，?id=123&watermark=0 这种普通参数不算。
 */
function isProcessingKey(k: string): boolean {
  return (
    k === 'x-oss-process' ||
    /^(imageview2?|imagemogr2|watermark)\/./.test(k) ||
    /^imageslim(\||$)/.test(k)
  );
}

/** 只删处理参数，其余参数按原始编码逐字保留 */
function dropProcessingParams(u: string): string {
  const i = u.indexOf('?');
  if (i < 0) return u;
  const hashAt = u.indexOf('#', i);
  const query = u.slice(i + 1, hashAt < 0 ? undefined : hashAt);
  const hash = hashAt < 0 ? '' : u.slice(hashAt);
  const kept = query.split('&').filter((part) => {
    if (!part) return false;
    let k = part.split('=')[0];
    try {
      k = decodeURIComponent(k.replace(/\+/g, ' '));
    } catch {
      /* 保持原样 */
    }
    return !isProcessingKey(k.toLowerCase());
  });
  return u.slice(0, i) + (kept.length ? `?${kept.join('&')}` : '') + hash;
}

export const RULES: SiteRule[] = [
  {
    id: 'alicdn',
    name: '淘宝 / 天猫 / 1688',
    host: /(^|\.)alicdn\.com$/i,
    // xxx.jpg_400x400q90.jpg_.webp  ->  xxx.jpg
    upgrade: (u) =>
      stripQuery(u)
        .replace(/_\.webp$/i, '')
        .replace(/\.(jpe?g|png|webp)_[^/]*$/i, '.$1'),
    referer: 'https://www.taobao.com/',
    thumbnailsAreContent: true,
  },
  {
    id: 'jd',
    name: '京东',
    host: /(^|\.)360buyimg\.com$/i,
    // //img14.360buyimg.com/n5/jfs/... -> /n0/jfs/...   s450x450_jfs -> jfs
    upgrade: (u) =>
      stripQuery(u)
        .replace(/\/n\d+\//i, '/n0/')
        .replace(/\/s\d+x\d+_jfs\//i, '/jfs/')
        .replace(/!q\d+(\.dpg)?$/i, ''),
    referer: 'https://www.jd.com/',
    thumbnailsAreContent: true,
  },
  {
    id: 'weibo',
    name: '微博',
    host: /(^|\.)sinaimg\.cn$/i,
    // /thumb150/ /orj360/ /mw690/ /bmiddle/ /wap360/ -> /large/
    upgrade: (u) =>
      stripQuery(u).replace(
        /\/(thumb\d+|orj\d+|mw\d+|bmiddle|small|square|wap\d+|thumbnail)\//i,
        '/large/',
      ),
    // 微博图床强防盗链，必须带 Referer
    referer: 'https://weibo.com/',
  },
  {
    id: 'zhihu',
    name: '知乎',
    host: /(^|\.)zhimg\.com$/i,
    // 实测（2026-08）：/50/v2-xxx_720w.jpg → v2-xxx_r.jpg 才是完整原图，
    // 要同时去掉 /50/ /100/ 尺寸目录；部分老图 hash 没有 v2- 前缀
    upgrade: (u) =>
      stripQuery(u)
        .replace(/\/\d+\/((?:v2-)?[0-9a-f]{8,})/i, '/$1')
        .replace(/((?:v2-)?[0-9a-f]{8,})_[0-9a-z]+\.(jpe?g|png|webp|gif)$/i, '$1_r.$2'),
    referer: 'https://www.zhihu.com/',
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    host: /(^|\.)xhscdn\.com$/i,
    // 去掉 ?imageView2/... 处理参数即原图
    upgrade: (u) => stripQuery(u),
    referer: 'https://www.xiaohongshu.com/',
  },
  {
    id: 'pinterest',
    name: 'Pinterest',
    host: /(^|\.)pinimg\.com$/i,
    upgrade: (u) => stripQuery(u).replace(/\/\d+x\d*\//, '/originals/'),
  },
  {
    id: 'wechat',
    name: '微信公众号',
    host: /(^|\.)mmbiz\.q(pic|logo)\.cn$/i,
    // 保留 wx_fmt，去掉 tp/wxfrom/wx_lazy 等压缩参数（只转格式，分辨率不变）
    sameSize: true,
    upgrade: (u) => {
      try {
        const url = new URL(u);
        const fmt = url.searchParams.get('wx_fmt');
        url.search = fmt ? `?wx_fmt=${fmt}` : '';
        return url.href;
      } catch {
        return u;
      }
    },
    referer: 'https://mp.weixin.qq.com/',
  },
  {
    id: 'bilibili',
    name: '哔哩哔哩',
    host: /(^|\.)hdslb\.com$/i,
    // 去掉 @480w_270h_1c.webp 这类后缀
    upgrade: (u) => stripQuery(u).replace(/@[^/]*$/i, ''),
    referer: 'https://www.bilibili.com/',
  },
  {
    id: 'imgix',
    name: 'Unsplash / imgix 系',
    // imgix 全靠 query 参数裁剪；删掉尺寸参数即得原始分辨率
    // 实测（2026-09 unsplash 首页）：w=100 缩略图 → 1830×2740 原图
    host: /^(images|plus)\.unsplash\.com$|\.imgix\.net$/i,
    // 带 s= 的是 imgix 安全签名地址，改参数会 403，不升级
    when: (url) => !isSignedUrl(url) && ['w', 'h', 'fit', 'crop', 'dpr'].some((k) => url.searchParams.has(k)),
    upgrade: (u) => {
      try {
        const url = new URL(u);
        for (const k of ['w', 'h', 'fit', 'crop', 'rect', 'dpr', 'ar', 'max-w', 'max-h', 'min-w', 'min-h']) {
          url.searchParams.delete(k);
        }
        return url.href;
      } catch {
        return u;
      }
    },
  },
  {
    id: 'oss-generic',
    name: '通用 OSS / 七牛 / 又拍处理参数',
    // 任何主机都可能是 OSS / 七牛 / COS 自定义域名，所以只看参数名；
    // 七牛是斜杠语法（?imageView2/2/w/100），OSS 是等号语法（?x-oss-process=...）
    host: /(?:)/, // 任何主机（含 file:// 这种没有主机名的）
    // 私有桶的签名缩略图：签名覆盖了处理参数，删掉任何参数都 403 —— 不升级，原样下载
    when: (url) => !isSignedUrl(url) && paramKeys(url).some(isProcessingKey),
    upgrade: dropProcessingParams,
  },
];

export interface UpgradeResult {
  url: string;
  ruleId?: string;
  /** 命中的规则不改分辨率（见 SiteRule.sameSize） */
  sameSize?: boolean;
  /** 见 SiteRule.thumbnailsAreContent */
  thumbnailsAreContent?: boolean;
}

function ruleFor(raw: string): SiteRule | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  return RULES.find((r) => r.host.test(url.hostname) && (!r.when || r.when(url)));
}

export function upgradeUrl(raw: string): UpgradeResult {
  const rule = ruleFor(raw);
  if (!rule) return { url: raw };
  const next = rule.upgrade ? rule.upgrade(raw) : raw;
  const out: UpgradeResult = { url: next || raw, ruleId: rule.id };
  if (rule.sameSize) out.sameSize = true;
  if (rule.thumbnailsAreContent) out.thumbnailsAreContent = true;
  return out;
}

/**
 * 视频 CDN 固定要的 Referer。B站 的 upos 节点只认 bilibili.com 来的请求 ——
 * 博客 / 论坛里用 iframe 嵌的 B站 播放器，外层网页的域名当 Referer 必然 403（审查实锤，curl 实测）
 */
const MEDIA_REFERERS: Array<{ host: RegExp; referer: string }> = [
  { host: /(^|\.)(bilivideo\.(com|cn)|hdslb\.com)$/i, referer: 'https://www.bilibili.com/' },
  { host: /^upos-[^.]*\.akamaized\.net$/i, referer: 'https://www.bilibili.com/' },
];

export function mediaRefererFor(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return MEDIA_REFERERS.find((r) => r.host.test(host))?.referer;
}

export function refererFor(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return undefined;
  }
  return RULES.find((r) => r.referer && r.host.test(host))?.referer;
}
