import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_LOCALE, LOCALES, pickLocale, setLang, t } from '../src/core/i18n';

const ALL = ['en', 'zh-CN', 'zh-TW', 'pt', 'pt-BR', 'ja'];

test('pickLocale：完全匹配 / 语言部分 / 同语言其他地区 / 偏好顺序 / 回退英文', () => {
  assert.equal(pickLocale(['zh-CN'], ALL), 'zh-CN');
  assert.equal(pickLocale(['en-US'], ALL), 'en');
  assert.equal(pickLocale(['pt-PT'], ALL), 'pt'); // 只匹配语言部分
  assert.equal(pickLocale(['ja-JP'], ALL), 'ja');
  assert.equal(pickLocale(['zh-HK'], ALL), 'zh-TW'); // 繁体优先 zh-TW
  assert.equal(pickLocale(['zh-Hant'], ALL), 'zh-TW');
  assert.equal(pickLocale(['zh-SG'], ALL), 'zh-CN'); // 其他地区退到同语言
  assert.equal(pickLocale(['zh-Hant-HK'], ['en', 'zh-CN']), 'zh-CN'); // 没有繁体就退简体，好过英文
  assert.equal(pickLocale(['fr', 'ja'], ALL), 'ja'); // 按偏好顺序，跳过没有的
  assert.equal(pickLocale(['fr', 'de'], ALL), DEFAULT_LOCALE);
  assert.equal(pickLocale([], ALL), DEFAULT_LOCALE);
  assert.equal(pickLocale(['pt_BR'], ALL), 'pt-BR'); // 下划线写法
});

test('t：zh-CN 原样输出中文 key；其他语言按字典翻译；占位符按位置替换', () => {
  assert.equal(DEFAULT_LOCALE, 'en');
  setLang('zh-CN');
  assert.equal(t('下载选中 {0} 项', 3), '下载选中 3 项');
  setLang('en');
  assert.equal(t('下载选中 {0} 项', 3), 'Download selected 3');
  assert.equal(t('字典里没有 {0}', 'x'), '字典里没有 x'); // 都没有时才是中文原文
  setLang('zh-CN');
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'i18n' ? [] : sources(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}

/** 静态扫描源码里 t('…') / t("…") 的第一个字符串参数（动态 key 扫不到，由各语言字典自行覆盖） */
function usedKeys(): Set<string> {
  const keys = new Set<string>();
  const re = /(?<![\w$.])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)")/g;
  for (const f of sources(join(import.meta.dirname, '../src'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(re)) {
      keys.add((m[1] ?? m[2]).replace(/\\(['"\\])/g, '$1'));
    }
  }
  return keys;
}

test('en 是参考语言：源码里每个 t() key 都有译文', () => {
  const missing = [...usedKeys()].filter((k) => !(k in LOCALES.en.messages));
  assert.deepEqual(missing, []);
});

test('每种语言的译文占位符和中文 key 一致', () => {
  const ph = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join();
  for (const [code, l] of Object.entries(LOCALES)) {
    for (const [k, v] of Object.entries(l.messages)) {
      assert.equal(ph(v), ph(k), `${code}: ${k}`);
    }
  }
});
