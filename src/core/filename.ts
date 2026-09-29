/**
 * 文件名清洗。规则不是猜的：来自真 Chrome 153 / 154 实测（e2e/filename-probe.mjs 可重跑）。
 *
 * chrome.downloads.download 对路径的每一段（文件夹名、文件名）都做同一套检查，
 * 任何一段不合格就整个拒绝，报 "Invalid filename"，下载根本不会开始：
 *   1. 任何位置都不能有：\ / : * ? " < > |、控制字符（Cc，含 DEL 和 U+0080-009F）、
 *      格式字符（Cf：零宽空格、ZWJ（🙋‍♀️ 这类组合 emoji 里就有）、方向控制符、BOM、软连字符、
 *      旗帜 emoji 的 tag 字符）、非字符（U+FDD0-FDEF、U+xFFFE/xFFFF）、孤立的代理项
 *   2. 开头和结尾不能是空白（含全角空格、NBSP）、「.」、「~」；中间可以
 *   3. 最后一个扩展名不能是 lnk / local / url / scf / {...}
 *   4. 不能是 Windows 保留名：CON PRN AUX NUL COM1-9 LPT1-9 CLOCK$（含「CON.xxx」），
 *      以及 desktop.ini、thumbs.db
 * 实测都能过的（不要动它们）：中文、全角标点（：？｜＊＜＞～…）、普通 emoji、❤️ 的 U+FE0F、
 * 组合附加符、% # & ' ` ! @ $ ^ + = ( ) [ ] { } ; ,（文件名里的 % 落盘时会被 Chrome 自己换成 _）。
 * 另外：文件夹名超过 255 个字符时 Chrome 不截断，下载会卡住或被取消（实测时好时坏）；
 * 文件名超长 Chrome 会自己截到约 244 字节。
 */

/** 单段最长 80 个 UTF-16 单元：最坏每单元 3 字节 UTF-8 = 240 字节，留出序号/扩展名/「 (1)」的余量 */
const MAX_LEN = 80;
/** 带扩展名的文件名那一段：主干上限放宽到 90 单元，但整段不超过 250 字节 */
const MAX_FILE_LEN = 90;
const MAX_FILE_BYTES = 250;

/** ASCII 非法字符 + 控制字符 → 换成 _（看得见的字符，换掉比删掉更不容易把词粘在一起） */
const ILLEGAL = /[\\/:*?"<>|\p{Cc}]/gu;
/** 格式字符 / 非字符 / 孤立代理 → 直接删掉：本来就看不见，删掉后 🙋‍♀️ 变成 🙋♀️，仍然可读 */
const INVISIBLE = /[\p{Cf}\p{Noncharacter_Code_Point}\p{Cs}]/gu;
/** 首尾不允许的字符（JS 的 \s 覆盖 Unicode White_Space，含全角空格 U+3000、NBSP） */
const BAD_ENDS = /^[\s.~]+|[\s.~]+$/gu;
/** Windows 保留设备名：整名相同，或以「设备名.」开头（Chrome 同款判定，不区分大小写） */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9]|clock\$)(\.|$)/i;
const MAGIC = /^(desktop\.ini|thumbs\.db)$/i;
/** 会被 Windows Shell 解释的扩展名：把分隔的点换成 _ */
const SHELL_EXT = /\.(lnk|local|url|scf|\{[^.]*\})$/i;

let segmenter: Intl.Segmenter | null | undefined;
function graphemes(s: string): string[] {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
        ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
        : null;
    } catch {
      segmenter = null;
    }
  }
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/**
 * 截到 maxUnits 个 UTF-16 单元、maxBytes 个 UTF-8 字节以内（macOS / Linux 单段上限 255 字节）。
 * 按字形簇截：不会把 emoji 的代理对 / 国旗 / 肤色修饰拆开（拆开会留下孤立代理，Chrome 直接拒）。
 */
function truncate(s: string, maxUnits: number, maxBytes = Infinity): string {
  if (s.length <= maxUnits && (maxBytes === Infinity || utf8Len(s) <= maxBytes)) return s;
  const fit = (parts: string[]) => {
    let out = '';
    let bytes = 0;
    for (const g of parts) {
      const b = maxBytes === Infinity ? 0 : utf8Len(g);
      if (out.length + g.length > maxUnits || bytes + b > maxBytes) break;
      out += g;
      bytes += b;
    }
    return out;
  };
  // 单个字形簇就超长（极端的叠加符号串）时退回按码点截，同样不拆代理对
  return fit(graphemes(s)) || fit(Array.from(s));
}

const trimEnds = (s: string) => s.replace(BAD_ENDS, '');

/** 保留名加前缀、危险扩展名去掉点。对整段（含扩展名）做，拼好扩展名之后也要再过一次 */
function defuse(s: string): string {
  if (RESERVED.test(s) || MAGIC.test(s)) s = `_${s}`;
  return s.replace(SHELL_EXT, '_$1');
}

function clean(name: string, maxUnits: number, maxBytes?: number): string {
  let s = String(name ?? '')
    .replace(INVISIBLE, '')
    .replace(ILLEGAL, '_')
    .replace(/\s+/g, ' ');
  s = defuse(trimEnds(s));
  // 先截断再修首尾：截断点可能正好落在空格、点、~ 上
  return defuse(trimEnds(truncate(s, maxUnits, maxBytes)));
}

/**
 * 把任意字符串清洗成一段 Chrome 一定接受的文件名 / 文件夹名（不含路径分隔符）。
 * 清完为空（或只剩 . _ 空格）时返回 fallback。结果最长 80 个 UTF-16 单元（≤240 字节）；
 * 重复清洗结果不变。
 */
export function sanitize(name: string, fallback = 'untitled'): string {
  const s = clean(name, MAX_LEN);
  return /[^._ ]/.test(s) ? s : fallback;
}

/** 扩展名只留字母数字（最多 8 位）；没有就返回空串，调用方不加点 */
function safeExt(ext: string): string {
  return String(ext ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 8);
}

/**
 * 清洗「文件名.扩展名」这一段：扩展名保住不被截掉；主干最多 90 单元、整段不超过 250 字节
 * （fileNameFromUrl 的「001_」+ 80 字主干原样通过；Chrome 重名时加的「 (1)」也还放得下）。
 * 拼好之后整段再检查一次保留名 / 危险扩展名（desktop + .ini、a + .lnk 这类拼出来才出问题的）。
 */
export function sanitizeFileName(file: string, fallback = 'untitled'): string {
  const m = /^(.*)\.([A-Za-z0-9]{1,8})$/s.exec(String(file ?? ''));
  if (m) {
    const base = clean(m[1], MAX_FILE_LEN, MAX_FILE_BYTES - 1 - m[2].length);
    if (/[^._ ]/.test(base)) return defuse(`${base}.${m[2]}`);
  }
  const s = clean(file, MAX_FILE_LEN, MAX_FILE_BYTES);
  return /[^._ ]/.test(s) ? s : fallback;
}

/** 从 URL 推一个可读文件名；重名交给 downloads API 的 uniquify 处理 */
export function fileNameFromUrl(url: string, index: number, ext: string): string {
  let base = '';
  try {
    const seg = new URL(url).pathname.split('/').pop() || '';
    try {
      base = decodeURIComponent(seg);
    } catch {
      base = seg; // 残缺的 %xx 编码：退回原样，别把整个名字丢掉
    }
  } catch {
    /* 非法 URL，忽略 */
  }
  base = sanitize(base.replace(/\.[a-z0-9]{2,5}$/i, ''), '');
  const prefix = String(index + 1).padStart(3, '0');
  const e = safeExt(ext);
  const dotExt = e ? `.${e}` : '';
  return defuse(base ? `${prefix}_${base}${dotExt}` : `${prefix}${dotExt}`);
}

/**
 * 拼下载路径：文件夹按 / 切段、每段各自清洗，空段丢掉（顺带挡住 ..）；
 * 文件名那一段按「文件名.扩展名」清洗。拼出来的每一段都满足 Chrome 的要求。
 */
export function joinPath(folder: string, file: string): string {
  const f = String(folder ?? '')
    .split('/')
    .map((p) => sanitize(p, ''))
    .filter(Boolean)
    .join('/');
  const name = sanitizeFileName(file);
  return f ? `${f}/${name}` : name;
}
