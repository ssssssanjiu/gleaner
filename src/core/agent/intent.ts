import type { ColorName, Intent } from './types';
import { sectionInQuery } from './sections';

/**
 * 本地意图解析：把一句中文 / 英文口语拆成「能在本机执行的条件」。
 * 做法是逐类识别并把识别掉的片段从原句里抠掉；最后剩下的、还带实词的部分
 * 就是本地理解不了的语义（「有猫的」「像海报一样的」），交给云端。
 *
 * 不做分词，全靠正则 —— 够用、可预测、零依赖，而且每条规则都能单测。
 */

const COLOR_WORDS: Array<[ColorName, RegExp]> = [
  ['red', /红色?|\bred\b/],
  ['orange', /橙色?|橘色?|\borange\b/],
  ['yellow', /黄色?|\byellow\b/],
  ['green', /绿色?|\bgreen\b/],
  ['cyan', /青色?|蓝绿色?|\bcyan\b|\bteal\b/],
  ['blue', /蓝色?|\bblue\b/],
  ['purple', /紫色?|\bpurple\b|\bviolet\b/],
  ['pink', /粉红?色?|\bpink\b/],
  ['black', /黑色?|黑白|\bblack\b|\bdark\b/],
  ['white', /白色?|\bwhite\b/],
  ['gray', /灰色?|\bgr[ae]y\b/],
  ['brown', /棕色?|褐色?|咖啡色|\bbrown\b/],
];

/** 中文数字 → 数 */
export function cnNumber(s: string): number | undefined {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const map: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  if (s === '十') return 10;
  const m = s.match(/^([一二三四五六七八九两])?十([一二三四五六七八九])?$/);
  if (m) return (m[1] ? map[m[1]] : 1) * 10 + (m[2] ? map[m[2]] : 0);
  if (s.length === 1 && s in map) return map[s];
  return undefined;
}

const NUM = '(\\d+|[一二三四五六七八九十两]+)';
const UNIT = '(?:个|张|条|段|块|只|幅|部|支|首)?';

// 越长的短语越靠前，避免「下载下来」被「下载」先吃掉一半
const STOP_PHRASES = [
  '下载下来', '下载到本地', '保存下来', '给我下载', '帮我下载', '帮我找', '帮我把', '给我把', '给我找',
  '这个页面', '当前页面', '本页面', '页面内', '页面上', '页面里', '页面中', '这一页', '这页', '网页',
  '我需要', '我想要', '我要', '我想', '请', '帮我', '给我', '把', '下载', '保存', '抓取', '抓', '找出', '找到', '找',
  '所有的', '所有', '全部的', '全部', '每一', '所有的', '一共', '总共', '一下', '一些',
  '里面的', '里面', '里的', '里', '内的', '内', '上的', '上', '中的', '中', '的', '地', '得',
  '它们', '他们', '这些', '那些', '这个', '那个', '这', '那', '都', '也', '就', '来', '去', '吧', '呢', '啊', '呀', '哦', '嘛', '吗',
  '和', '与', '及', '以及', '或', '或者', '还有', '并且', '然后', '要', '需要', '想要', '可以', '能', '能不能', '可不可以',
  '素材', '文件', '资源', '东西', '内容', '颜色', '色', '类型', '格式', '尺寸', '大小',
];

const STOP_WORDS_EN = [
  'i', 'need', 'want', 'would', 'like', 'please', 'download', 'save', 'get', 'grab', 'fetch', 'give', 'me',
  'all', 'every', 'each', 'the', 'a', 'an', 'of', 'in', 'on', 'from', 'this', 'that', 'these', 'those',
  'page', 'website', 'site', 'here', 'them', 'it', 'and', 'or', 'with', 'for', 'to', 'is', 'are', 'be',
  'can', 'you', 'could', 'find', 'show', 'select', 'pick', 'choose', 'files', 'file', 'stuff', 'things',
  'color', 'colour', 'colored', 'coloured', 'size', 'type', 'ones', 'one', 'kind', 'only', 'just',
];

function consume(rest: string, re: RegExp): string {
  return rest.replace(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), ' ');
}

export function parseIntent(input: string): Intent {
  let rest = input
    .toLowerCase()
    .replace(/[，。！？、；：“”‘’"'()（）【】\[\]{}<>《》,.!?;:~～…\-—_/\\|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const intent: Intent = { kind: 'any', colors: [], semantic: '', needsCloud: false };

  // ---- 素材类型 ----
  // 只判断、先不抠掉：「横图」「小图」这类词既说明类型又带条件，得留给后面的规则看。
  // 「音视频 / 媒体」是统称，先于「视频」判断，否则会被误认成只要视频
  const KIND_RES: Array<[Intent['kind'], RegExp]> = [
    ['any', /音视频|媒体|\bmedia\b/],
    ['video', /视频|影片|短片|录像|片子|\bvideos?\b|\bclips?\b|\bmovies?\b/],
    ['audio', /音频|声音|音乐|配乐|音轨|歌曲?|\baudios?\b|\bsounds?\b|\bmusic\b|\bsongs?\b/],
    ['image', /图片|图像|照片|相片|插图|海报|截图|图|\bimages?\b|\bpictures?\b|\bphotos?\b|\bpics?\b|\bimgs?\b/],
  ];
  const kindHit = KIND_RES.find(([, re]) => re.test(rest));
  if (kindHit) intent.kind = kindHit[0];

  // ---- 颜色（可多个，或关系）----
  for (const [name, re] of COLOR_WORDS) {
    if (re.test(rest)) {
      intent.colors.push(name);
      rest = consume(rest, re);
    }
  }

  // ---- 序号 / 排序 / 数量（要在「大的/小的」这类尺寸形容词之前，否则「最大的」会被拆成「最」+「大的」）----
  const ord = rest.match(new RegExp(`第\\s*${NUM}\\s*${UNIT}`));
  if (ord) {
    const n = cnNumber(ord[1]);
    if (n) intent.ordinal = n;
    rest = rest.replace(ord[0], ' ');
  } else {
    const ordEn = rest.match(/\b(first|second|third|fourth|fifth)\b(?!\s+\d)/);
    if (ordEn) {
      intent.ordinal = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5 }[ordEn[1]];
      rest = rest.replace(ordEn[0], ' ');
    }
  }
  // 「最大的三张」「top 3 largest」「3 largest」都认
  const largest = rest.match(new RegExp(`(?:(?:前|top)?\\s*${NUM}\\s*${UNIT}\\s*)?(?:最大|最高清|最清晰|\\blargest\\b|\\bbiggest\\b|\\bhighest\\b)\\s*(?:的)?\\s*(?:${NUM}\\s*${UNIT})?`));
  if (largest) {
    intent.order = 'largest';
    const n = cnNumber(largest[1] ?? largest[2] ?? '');
    intent.limit = n ?? 1;
    rest = rest.replace(largest[0], ' ');
  }
  const smallest = rest.match(new RegExp(`(?:(?:前|top)?\\s*${NUM}\\s*${UNIT}\\s*)?(?:最小|\\bsmallest\\b)\\s*(?:的)?\\s*(?:${NUM}\\s*${UNIT})?`));
  if (smallest) {
    intent.order = 'smallest';
    const n = cnNumber(smallest[1] ?? smallest[2] ?? '');
    intent.limit = n ?? 1;
    rest = rest.replace(smallest[0], ' ');
  }
  const firstN = rest.match(new RegExp(`(?:前|头|开头|\\btop\\b|\\bfirst\\b)\\s*${NUM}\\s*${UNIT}`));
  if (firstN) {
    intent.order = 'first';
    intent.limit = cnNumber(firstN[1]);
    rest = rest.replace(firstN[0], ' ');
  }
  const lastN = rest.match(new RegExp(`(?:最后|末尾|\\blast\\b)\\s*(?:${NUM}\\s*${UNIT})?`));
  if (lastN) {
    intent.order = 'last';
    intent.limit = lastN[1] ? cnNumber(lastN[1]) : 1;
    rest = rest.replace(lastN[0], ' ');
  }

  // ---- 尺寸 ----
  const gt = rest.match(new RegExp(`(?:宽|高|边长|分辨率|width|height|size)?\\s*(?:大于|超过|不小于|至少|高于|>=?|≥|over|above|at least|bigger than|larger than|more than)\\s*${NUM}\\s*(?:px|像素|p|像素点)?`));
  if (gt) {
    const n = cnNumber(gt[1]);
    if (n) intent.minSide = n;
    rest = rest.replace(gt[0], ' ');
  }
  const lt = rest.match(new RegExp(`(?:宽|高|边长|分辨率|width|height|size)?\\s*(?:小于|不超过|不大于|低于|至多|<=?|≤|under|below|at most|smaller than|less than)\\s*${NUM}\\s*(?:px|像素|p)?`));
  if (lt) {
    const n = cnNumber(lt[1]);
    if (n) intent.maxSide = n;
    rest = rest.replace(lt[0], ' ');
  }
  const res = rest.match(/\b(\d{3,4})p\b/);
  if (res && !intent.minSide) {
    intent.minSide = parseInt(res[1], 10);
    rest = rest.replace(res[0], ' ');
  }
  const bigRe = /大图|高清|高分辨率|大尺寸|(?<!最)大的|大一点|大一些|\bbig\b|\blarge\b|\bhd\b|\bhigh[- ]?res(olution)?\b/;
  if (bigRe.test(rest)) {
    intent.minSide ??= 800;
    rest = consume(rest, bigRe);
  }
  const smallRe = /小图|缩略图|(?<!最)小的|小一点|\bsmall\b|\bthumbnails?\b|\btiny\b/;
  if (smallRe.test(rest)) {
    intent.maxSide ??= 300;
    rest = consume(rest, smallRe);
  }

  // ---- 方向 ----
  if (/横图|横向|横的|横版|\blandscape\b|\bwide\b|\bhorizontal\b/.test(rest)) {
    intent.orientation = 'landscape';
    rest = consume(rest, /横图|横向|横的|横版|\blandscape\b|\bwide\b|\bhorizontal\b/);
  } else if (/竖图|竖向|竖的|竖版|\bportrait\b|\bvertical\b|\btall\b/.test(rest)) {
    intent.orientation = 'portrait';
    rest = consume(rest, /竖图|竖向|竖的|竖版|\bportrait\b|\bvertical\b|\btall\b/);
  } else if (/方图|正方形|方形|\bsquare\b/.test(rest)) {
    intent.orientation = 'square';
    rest = consume(rest, /方图|正方形|方形|\bsquare\b/);
  }

  // ---- 分区 ----
  const sec = sectionInQuery(rest);
  if (sec) {
    intent.section = sec.label;
    rest = consume(rest, sec.re);
  }

  // 「随便来 N 张」「N 张」：只有数量没有排序，按出现顺序取前 N
  const bare = rest.match(new RegExp(`(?:^|\\s)${NUM}\\s*(?:个|张|条|段|块|幅|部)(?:\\s|$)`));
  if (bare && intent.limit == null) {
    intent.order ??= 'first';
    intent.limit = cnNumber(bare[1]);
    rest = rest.replace(bare[0], ' ');
  }

  // ---- 现在才抠掉类型词，然后去掉套话，看还剩什么 ----
  if (kindHit) rest = consume(rest, kindHit[1]);
  for (const p of STOP_PHRASES) rest = rest.split(p).join(' ');
  rest = rest
    .split(/\s+/)
    .filter((w) => w && !STOP_WORDS_EN.includes(w) && !/^\d+$/.test(w) && !/^(px|像素)$/.test(w))
    .join(' ')
    .trim();

  // 还剩实词（任意汉字，或 ≥3 字母的英文词）→ 本地理解不了
  const leftover = rest.replace(/[^\p{Script=Han}a-z]+/gu, ' ').trim();
  const hasMeaning = /\p{Script=Han}/u.test(leftover) || /[a-z]{3,}/.test(leftover);
  if (hasMeaning) {
    intent.semantic = leftover;
    intent.needsCloud = true;
  }
  return intent;
}

/** 把意图翻回人话，给结果区解释「本地按什么筛的」 */
export function describeIntent(i: Intent): string {
  const parts: string[] = [];
  parts.push({ image: '图片', video: '视频', audio: '音频', any: '全部素材' }[i.kind]);
  if (i.colors.length) {
    const zh: Record<ColorName, string> = {
      red: '红', orange: '橙', yellow: '黄', green: '绿', cyan: '青', blue: '蓝',
      purple: '紫', pink: '粉', black: '黑', white: '白', gray: '灰', brown: '棕',
    };
    parts.push(i.colors.map((c) => zh[c]).join('/') + '色');
  }
  if (i.minSide) parts.push(`边长≥${i.minSide}`);
  if (i.maxSide) parts.push(`边长≤${i.maxSide}`);
  if (i.orientation) parts.push({ landscape: '横图', portrait: '竖图', square: '方图' }[i.orientation]);
  if (i.section) parts.push(i.section);
  if (i.ordinal) parts.push(`第 ${i.ordinal} 个`);
  if (i.order && i.limit) {
    parts.push({ largest: `最大 ${i.limit} 个`, smallest: `最小 ${i.limit} 个`, first: `前 ${i.limit} 个`, last: `最后 ${i.limit} 个` }[i.order]);
  }
  return parts.join(' · ');
}
