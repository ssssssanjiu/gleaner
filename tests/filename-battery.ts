/**
 * 文件名「电池」：一组真实会出现在网页标题 / 图片地址里的刁钻字符串。
 *
 * 两处共用：
 *   - e2e/filename-probe.mjs  拿它们去真 Chrome 的 chrome.downloads.download 里实测「收 / 拒」
 *   - tests/sanitize-chrome.test.ts  断言 sanitize/joinPath 的输出满足实测得出的规则
 *
 * cls 是字符类别，probe 按类别汇总「Chrome 拒了哪些类」。
 */
export interface BatteryCase {
  /** 类别（汇总用） */
  cls: string;
  /** 人读的说明 */
  label: string;
  /** 原始字符串（可能含不可见字符） */
  s: string;
}

const rep = (ch: string, n: number) => ch.repeat(n);

export const BATTERY: BatteryCase[] = [
  // ---- 对照组 ----
  { cls: 'control', label: '普通中文标题', s: '今天也是元气满满的一天 - 小红书' },
  { cls: 'control', label: 'plain ascii', s: 'normal title' },
  { cls: 'control', label: 'B站标题后缀', s: '危险的黑子_哔哩哔哩_bilibili' },

  // ---- 波浪号 ----
  { cls: 'tilde', label: '~ 开头', s: '~lead' },
  { cls: 'tilde', label: '~ 结尾', s: '好物分享~' },
  { cls: 'tilde', label: '~ 在中间', s: '【4K】好听到哭~_哔哩哔哩_bilibili' },
  { cls: 'tilde', label: '抖音 ~tplv', s: 'oAAbcdEF~tplv-dy-aweme-images_q75' },
  { cls: 'tilde', label: '单个 ~', s: '~' },

  // ---- ZWJ 组合 emoji ----
  { cls: 'zwj-emoji', label: '👨‍👩‍👧 家庭', s: '👨‍👩‍👧 一家人' },
  { cls: 'zwj-emoji', label: '🙋‍♀️ 小红书', s: '今天也是元气满满的一天🙋‍♀️ - 小红书' },
  { cls: 'zwj-emoji', label: '❤️‍🔥', s: '❤️‍🔥 燃' },
  { cls: 'zwj-emoji', label: '👩‍💻 开头', s: '👩‍💻程序员日常_哔哩哔哩_bilibili' },

  // ---- 零宽字符 ----
  { cls: 'zero-width', label: 'U+200B 零宽空格', s: '标题​里有零宽空格 - 知乎' },
  { cls: 'zero-width', label: 'U+200C ZWNJ', s: 'a‌b' },
  { cls: 'zero-width', label: 'U+200D ZWJ', s: 'a‍b' },
  { cls: 'zero-width', label: 'U+2060 WJ', s: 'a⁠b' },
  { cls: 'zero-width', label: 'U+FEFF BOM 开头', s: '﻿标题' },
  { cls: 'zero-width', label: 'U+FEFF BOM 中间', s: 'a﻿b' },

  // ---- 双向控制符 ----
  { cls: 'bidi', label: 'U+202A LRE', s: 'a‪b' },
  { cls: 'bidi', label: 'U+202B RLE', s: 'a‫b' },
  { cls: 'bidi', label: 'U+202C PDF', s: 'a‬b' },
  { cls: 'bidi', label: 'U+202D LRO', s: 'a‭b' },
  { cls: 'bidi', label: 'U+202E RLO（伪装扩展名）', s: 'invoice‮gpj.exe' },
  { cls: 'bidi', label: 'U+2066 LRI', s: 'a⁦b' },
  { cls: 'bidi', label: 'U+2067 RLI', s: 'a⁧b' },
  { cls: 'bidi', label: 'U+2068 FSI', s: 'a⁨b' },
  { cls: 'bidi', label: 'U+2069 PDI', s: 'a⁩b' },
  { cls: 'bidi', label: 'U+200E LRM', s: 'a‎b' },
  { cls: 'bidi', label: 'U+200F RLM', s: 'a‏b' },

  // ---- 其他 Cf 格式字符 ----
  { cls: 'other-cf', label: 'U+00AD 软连字符', s: 'soft­hyphen' },
  { cls: 'other-cf', label: 'U+061C ALM', s: 'a؜b' },
  { cls: 'other-cf', label: 'U+180E MVS', s: 'a᠎b' },
  { cls: 'other-cf', label: 'U+2061 函数应用', s: 'a⁡b' },
  { cls: 'other-cf', label: 'U+FFF9 注音锚点', s: 'a￹b' },
  { cls: 'other-cf', label: '英格兰旗（U+E0067 等 tag 字符）', s: '🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} England' },

  // ---- Cc 控制字符 ----
  { cls: 'cc', label: 'U+0001', s: 'a\u0001b' },
  { cls: 'cc', label: 'TAB', s: 'tab\there' },
  { cls: 'cc', label: 'LF', s: 'line\nbreak' },
  { cls: 'cc', label: 'U+007F DEL', s: 'a\u007Fb' },
  { cls: 'cc', label: 'U+0085 NEL', s: 'a\u0085b' },
  { cls: 'cc', label: 'U+009F', s: 'a\u009Fb' },

  // ---- 非字符 / 孤立代理 ----
  { cls: 'nonchar', label: 'U+FDD0', s: 'a﷐b' },
  { cls: 'nonchar', label: 'U+FFFE', s: 'a￾b' },
  { cls: 'nonchar', label: 'U+1FFFF', s: 'a\u{1FFFF}b' },
  { cls: 'lone-surrogate', label: '孤立高代理', s: 'a\uD83Db' },
  { cls: 'lone-surrogate', label: '孤立低代理结尾', s: 'ab\uDE00' },

  // ---- 首尾的点 ----
  { cls: 'dots', label: '. 开头', s: '.NET 8 新特性一览 - 博客园' },
  { cls: 'dots', label: '. 结尾', s: 'Just do it.' },
  { cls: 'dots', label: '... 结尾', s: 'Loading...' },
  { cls: 'dots', label: '中文 ... 结尾', s: '周末去哪儿...' },
  { cls: 'dots', label: '中间 ..', s: 'a..b' },
  { cls: 'dots', label: '单个 .', s: '.' },
  { cls: 'dots', label: '..', s: '..' },
  { cls: 'dots', label: '...', s: '...' },

  // ---- 首尾空白 ----
  { cls: 'spaces', label: '空格开头', s: ' lead' },
  { cls: 'spaces', label: '空格结尾', s: 'trail ' },
  { cls: 'spaces', label: '全角空格开头', s: '　全角空格开头' },
  { cls: 'spaces', label: '全角空格结尾', s: '全角空格结尾　' },
  { cls: 'spaces', label: 'NBSP 结尾', s: 'nbsp ' },
  { cls: 'spaces', label: 'EM SPACE 开头', s: ' em' },
  { cls: 'spaces', label: '全角空格在中间', s: '上半句　下半句' },
  { cls: 'spaces', label: '点+空格结尾', s: 'dot space. ' },

  // ---- 会被 Windows Shell 解释的扩展名 ----
  { cls: 'shell-ext', label: '.lnk', s: 'shortcut.lnk' },
  { cls: 'shell-ext', label: '.LNK 大写', s: 'shortcut.LNK' },
  { cls: 'shell-ext', label: '.local', s: 'app.local' },
  { cls: 'shell-ext', label: '.url', s: 'Visit example.url' },
  { cls: 'shell-ext', label: '.scf', s: 'cmd.scf' },
  { cls: 'shell-ext', label: '.{clsid}', s: 'folder.{645FF040-5081-101B-9F08-00AA002F954E}' },
  { cls: 'shell-ext', label: '.lnk 在中间', s: 'a.lnk.txt' },

  // ---- Windows 保留名 ----
  { cls: 'reserved', label: 'CON', s: 'CON' },
  { cls: 'reserved', label: 'con 小写', s: 'con' },
  { cls: 'reserved', label: 'nul.txt', s: 'nul.txt' },
  { cls: 'reserved', label: 'COM1', s: 'COM1' },
  { cls: 'reserved', label: 'LPT9', s: 'LPT9' },
  { cls: 'reserved', label: 'CLOCK$', s: 'CLOCK$' },
  { cls: 'reserved', label: 'aux.tar.gz', s: 'aux.tar.gz' },
  { cls: 'reserved', label: 'desktop.ini', s: 'desktop.ini' },
  { cls: 'reserved', label: 'thumbs.db', s: 'Thumbs.db' },
  { cls: 'reserved', label: 'CON-x（不是保留名）', s: 'CON-x' },
  { cls: 'reserved', label: 'CON 空格 x', s: 'CON x' },

  // ---- ASCII 符号 ----
  { cls: 'ascii-punct', label: '%', s: '100% 纯棉' },
  { cls: 'ascii-punct', label: '%20', s: 'a%20b' },
  { cls: 'ascii-punct', label: '#', s: 'C# 入门 #1' },
  { cls: 'ascii-punct', label: '&', s: 'Tom & Jerry' },
  { cls: 'ascii-punct', label: "' ` !", s: "it's `ok`!" },
  { cls: 'ascii-punct', label: '@ $ ^ + =', s: 'a@b$c^d+e=f' },
  { cls: 'ascii-punct', label: '()[]{};,', s: '(a)[b]{c};d,e' },
  { cls: 'ascii-illegal', label: ': 冒号', s: '标题: 测试' },
  { cls: 'ascii-illegal', label: '* ?', s: 'what*is?' },
  { cls: 'ascii-illegal', label: '" < > |', s: '"a"<b>|c' },
  { cls: 'ascii-illegal', label: '反斜杠', s: 'a\\b' },

  // ---- 全角标点 ----
  { cls: 'fullwidth', label: '全角冒号问号竖线', s: '标题：为什么？｜知乎' },
  { cls: 'fullwidth', label: '全角星号尖括号', s: '＊重要＊＜必看＞' },
  { cls: 'fullwidth', label: '中文引号书名号', s: '“引号”《书名》【方括号】（括号）' },
  { cls: 'fullwidth', label: '，。！结尾', s: '好看，好用！' },
  { cls: 'fullwidth', label: '全角波浪号结尾', s: '好物分享～' },
  { cls: 'fullwidth', label: '省略号 … 结尾', s: '加载中…' },
  { cls: 'fullwidth', label: '中文句号结尾', s: '完结。' },

  // ---- 普通 emoji / 变体选择符 / 组合符 ----
  { cls: 'emoji', label: '❤️（带 FE0F）', s: '爱你❤️ - 小红书' },
  { cls: 'emoji', label: '😀', s: '😀开心' },
  { cls: 'emoji', label: '国旗 🇨🇳', s: '🇨🇳 中国' },
  { cls: 'emoji', label: '肤色 👍🏽', s: '👍🏽 点赞' },
  { cls: 'emoji', label: 'emoji 结尾', s: '夏天必备🔥' },
  { cls: 'variation', label: 'U+FE0F 结尾', s: 'a️' },
  { cls: 'variation', label: 'U+FE0E', s: 'x︎y' },
  { cls: 'variation', label: 'U+E0100 VS17', s: '葛\u{E0100}' },
  { cls: 'combining', label: 'e + U+0301', s: 'café' },
  { cls: 'combining', label: '组合符开头', s: '́abc' },

  // ---- 长度 ----
  { cls: 'long', label: 'ascii ×80', s: rep('a', 80) },
  { cls: 'long', label: 'ascii ×150', s: rep('a', 150) },
  { cls: 'long', label: 'ascii ×255', s: rep('a', 255) },
  { cls: 'long', label: 'ascii ×256', s: rep('a', 256) },
  { cls: 'long', label: 'ascii ×300', s: rep('a', 300) },
  { cls: 'long', label: '汉 ×80（240 字节）', s: rep('汉', 80) },
  { cls: 'long', label: '汉 ×85（255 字节）', s: rep('汉', 85) },
  { cls: 'long', label: '汉 ×86（258 字节）', s: rep('汉', 86) },
  { cls: 'long', label: '汉 ×150（450 字节）', s: rep('汉', 150) },
  { cls: 'long', label: '😀 ×40（80 单元 160 字节）', s: rep('😀', 40) },
  { cls: 'long', label: '😀 ×64（256 字节）', s: rep('😀', 64) },
  {
    cls: 'long',
    label: '英文长标题第 80 字是空格',
    s: 'Everything you need to know about Apple’s new MacBook Pro lineup announced this week at the event',
  },
  { cls: 'long', label: '第 80 字是点', s: rep('b', 79) + '.' + rep('c', 20) },
  { cls: 'long', label: '第 80 字截在 emoji 中间', s: rep('d', 79) + '😀' + 'tail' },
  { cls: 'long', label: '第 80 字截在 ZWJ 序列中间', s: rep('e', 77) + '👩‍💻' + 'tail' },
];

/**
 * Chrome 对一段文件名 / 文件夹名的判定（null = 接受，否则是拒绝原因）。
 * 这不是抄来的规则：e2e/filename-probe.mjs 会拿它的预测和真 Chrome 153 对上面整组字符串的
 * 实际结果逐条比对（见 probe 输出的「预测 vs 实测」），对不上就说明规则写错了。
 */
export function chromeRejectsComponent(c: string, isLast: boolean): string | null {
  if (!c) return '空段';
  if (c === '.' || c === '..') return '. / .. 段';
  if (!c.isWellFormed()) return '孤立代理';
  if (/[\\/:*?"<>|]/.test(c)) return 'ASCII 非法字符';
  if (/\p{Cc}/u.test(c)) return '控制字符 Cc';
  if (/\p{Cf}/u.test(c)) return '格式字符 Cf';
  if (/\p{Noncharacter_Code_Point}/u.test(c)) return '非字符';
  if (/^[\s.~]|[\s.~]$/u.test(c)) return '首尾是空白 / . / ~';
  const dot = c.lastIndexOf('.');
  if (dot > 0) {
    const ext = c.slice(dot + 1).toLowerCase();
    if (['lnk', 'local', 'url', 'scf'].includes(ext) || /^\{.*\}$/.test(ext)) return 'Shell 扩展名';
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i.test(c) || /^(desktop\.ini|thumbs\.db)$/i.test(c)) {
    return 'Windows 保留名';
  }
  // 文件夹名 Chrome 不截断，超过 255 个 UTF-16 单元时建目录失败、下载一直卡住（macOS 实测）；
  // 文件名超长 Chrome 会自己截断
  if (!isLast && c.length > 255) return '文件夹名超长';
  return null;
}

/** 整条相对路径：每一段都要过；返回第一个不合格的原因 */
export function chromeRejectsPath(path: string): string | null {
  const parts = path.split('/');
  for (let i = 0; i < parts.length; i++) {
    const why = chromeRejectsComponent(parts[i], i === parts.length - 1);
    if (why) return `第 ${i + 1} 段「${parts[i].slice(0, 30)}」：${why}`;
  }
  return null;
}
