/**
 * 语言注册表。加一种语言：
 *   1. 复制 locales/en.ts 为 locales/<code>.ts，把右边翻成目标语言（左边的中文 key 不要改，没翻的会回退到英文）
 *   2. 在下面 import 并登记一行
 *   3.（可选）复制 src/public/_locales/zh_CN 为 _locales/<code>（Chrome 用下划线，如 pt_BR），翻译扩展名和描述
 * 弹窗里的语言下拉、自动检测、单测都从这张表读取，不用改别处。
 */
import en from './locales/en';

export type Messages = Record<string, string>;

/**
 * 源语言：代码里 t('…') 的 key 就是中文原文，所以中文不需要字典（空对象即原样输出）。
 * 其他语言都是「中文 → 译文」的字典，en 是参考，必须完整（单测检查）。
 */
export const SOURCE_LOCALE = 'zh-CN';

/** 默认语言：英文。自动检测匹配不到任何已有语言、或还没读到设置时用它；其他语言缺失的 key 也回退到英文 */
export const DEFAULT_LOCALE = 'en';

export const LOCALES = {
  en: { name: 'English', messages: en },
  'zh-CN': { name: '简体中文', messages: {} as Messages },
} as const satisfies Record<string, { name: string; messages: Messages }>;

export type LocaleCode = keyof typeof LOCALES;
