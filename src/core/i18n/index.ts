/**
 * i18n：t('中文原文', ...args)。
 *  - key 就是中文原文（源语言，无需字典）；其他语言字典（locales/*.ts）把它映射成译文，缺失回退英文，所以半成品语言也能用。
 *  - 占位符用 {0} {1}…，按参数顺序；译文里可以调换顺序（'{1} / {0}'）。
 *  - 语言存在 storage.local（设置里选），'auto' = 按浏览器语言列表匹配已有语言，见 pickLocale。
 */
import { DEFAULT_LOCALE, LOCALES, SOURCE_LOCALE } from './locales';
import type { LocaleCode, Messages } from './locales';

export { DEFAULT_LOCALE, LOCALES, SOURCE_LOCALE } from './locales';
export type { LocaleCode } from './locales';
export type LangSetting = 'auto' | LocaleCode;
export const LANG_KEY = 'og-lang';

/** 下拉框选项 */
export const LOCALE_OPTIONS = Object.entries(LOCALES).map(([code, l]) => ({ code: code as LocaleCode, name: l.name }));

const isLocale = (c: unknown): c is LocaleCode => typeof c === 'string' && Object.prototype.hasOwnProperty.call(LOCALES, c);

/**
 * 按用户偏好顺序（navigator.languages）挑一个已有的语言：
 * 完全匹配 → 只匹配语言部分（pt-BR → pt）→ 同语言的其他地区（zh-HK → zh-TW / zh-CN）→ 下一个偏好 → 默认语言（英文）。
 * 繁体（zh-Hant / TW / HK / MO）优先找 zh-TW，没有再退到同语言的其他地区。
 */
export function pickLocale(requested: readonly string[], available: readonly string[] = Object.keys(LOCALES)): string {
  const lower = new Map(available.map((a) => [a.toLowerCase(), a]));
  for (const raw of requested) {
    const tag = raw.toLowerCase().replace(/_/g, '-');
    const [base] = tag.split('-');
    const traditional = base === 'zh' && /-(hant|tw|hk|mo)\b/.test(tag);
    const hit =
      (traditional && lower.get('zh-tw')) ||
      lower.get(tag) ||
      lower.get(base) ||
      available.find((a) => a.toLowerCase().split('-')[0] === base);
    if (hit) return hit;
  }
  return DEFAULT_LOCALE;
}

let current: LocaleCode = DEFAULT_LOCALE;
let messages: Messages = LOCALES[DEFAULT_LOCALE].messages;
const listeners = new Set<() => void>();

export function t(key: string, ...args: Array<string | number>): string {
  // 源语言原样输出；其他语言缺失的 key 回退到英文（en 必须完整），再不行才是中文原文
  const msg = current === SOURCE_LOCALE ? key : (messages[key] ?? LOCALES[DEFAULT_LOCALE].messages[key] ?? key);
  return args.length ? msg.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? '')) : msg;
}
export const getLang = (): LocaleCode => current;

/** 直接设定语言（单测用；扩展里走 storage + initLang） */
export function setLang(code: LocaleCode): void {
  if (code === current) return;
  current = code;
  messages = LOCALES[code].messages;
  listeners.forEach((f) => f());
}
export function onLangChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function resolve(setting: unknown): LocaleCode {
  if (isLocale(setting)) return setting;
  const nav = globalThis.navigator;
  const prefs = nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : [];
  return pickLocale(prefs) as LocaleCode;
}

/** 每个扩展上下文（popup / background / offscreen / mic）启动时调一次 */
export async function initLang(): Promise<void> {
  const storage = (globalThis as any).chrome?.storage;
  if (!storage?.local) return;
  const apply = (v?: unknown) => setLang(resolve(v));
  apply((await storage.local.get(LANG_KEY).catch(() => ({})))?.[LANG_KEY]);
  storage.onChanged.addListener((c: any, area: string) => {
    if (area === 'local' && LANG_KEY in c) apply(c[LANG_KEY].newValue);
  });
}
