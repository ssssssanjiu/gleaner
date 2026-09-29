/**
 * 文件名清洗 × Chrome 真实规则。
 *
 * 单元测试调不了 Chrome，所以断言的是「规则」：chromeRejectsPath 把 Chrome 153 的判定写成代码，
 * e2e/filename-probe.mjs 会拿它和真 Chrome 对整组字符串（tests/filename-battery.ts）的实测结果逐条比对。
 * 这里要求：整组刁钻标题 / 图片地址，按 background.ts 的真实拼法生成的每一条路径都被规则接受，
 * 同时正常的中文标题一个字都不许改。
 *
 * 重跑真机验证：node e2e/filename-probe.mjs
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitize, joinPath, fileNameFromUrl, sanitizeFileName } from '../src/core/filename';
import { BATTERY, chromeRejectsPath } from './filename-battery';

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

/** 与 background.ts（startJob / mediaItemFor）和 popup（ZIP）同样的拼法 */
function pathsFor(title: string): Array<[string, string]> {
  const folder = joinPath('Gleaner', title || 'page');
  const seg = encodeURIComponent(title.toWellFormed());
  return [
    ['图片', joinPath(folder, fileNameFromUrl(`https://cdn.example.com/p/${seg}.jpg`, 0, 'jpg'))],
    ['视频', joinPath(folder, `${sanitize(sanitize(title || 'Gleaner'))}.mp4`)],
    ['ZIP', `${sanitize(title || 'Gleaner')}.zip`],
    ['URL无后缀', joinPath('Gleaner/x', fileNameFromUrl(`https://cdn.example.com/${seg}`, 41, 'jpg'))],
  ];
}

test('规则自检：原始电池里 Chrome 实测会拒的，规则也判拒（抽样）', () => {
  // 完整比对在 e2e/filename-probe.mjs；这里固定几条实测结论，防止规则被改松
  const rejected = ['Gleaner/好物分享~/a.txt', 'Gleaner/Loading.../a.txt', 'Gleaner/.NET 8/a.txt',
    'Gleaner/trail /a.txt', 'Gleaner/a‍b/a.txt', 'Gleaner/CON/a.txt', 'Gleaner/x/shortcut.lnk',
    'Gleaner/x/a\uD83Db.txt', 'Gleaner/　全角/a.txt', 'Gleaner/desktop.ini/a.txt'];
  for (const p of rejected) assert.ok(chromeRejectsPath(p), `应判拒：${JSON.stringify(p)}`);
  const accepted = ['Gleaner/【4K】好听到哭~_哔哩哔哩_bilibili/a.txt', 'Gleaner/爱你❤️ - 小红书/a.txt',
    'Gleaner/标题：为什么？｜知乎/a.txt', 'Gleaner/加载中…/a.txt', 'Gleaner/好物分享～/a.txt',
    'Gleaner/100% 纯棉 C# & Tom/a.txt', 'Gleaner/CON x/a.txt', 'Gleaner/x/Loading....txt'];
  for (const p of accepted) assert.equal(chromeRejectsPath(p), null, p);
});

for (const c of BATTERY) {
  test(`[${c.cls}] ${c.label}：清洗后每条路径 Chrome 都接受`, () => {
    for (const [kind, p] of pathsFor(c.s)) {
      assert.equal(chromeRejectsPath(p), null, `${kind}：${JSON.stringify(p)}`);
      const parts = p.split('/');
      parts.forEach((part, i) => {
        const last = i === parts.length - 1;
        // 比 Chrome 更严：Linux 单段上限是 255 字节，文件夹 ≤ 240、文件名 ≤ 250 才留得下「 (1)」
        assert.ok(utf8(part) <= (last ? 250 : 240), `${kind} 第 ${i + 1} 段 ${utf8(part)} 字节`);
      });
    }
    // 重复清洗结果不变（background 会对同一个名字清洗两三遍）
    const once = sanitize(c.s);
    assert.equal(sanitize(once), once);
    assert.equal(sanitizeFileName(`${once}.mp4`), `${once}.mp4`);
  });
}

test('正常标题一个字都不改（不过度清洗）', () => {
  for (const s of [
    '今天也是元气满满的一天 - 小红书',
    '【4K】好听到哭~_哔哩哔哩_bilibili',
    '标题：为什么？｜知乎',
    '＊重要＊＜必看＞',
    '“引号”《书名》【方括号】（括号）',
    '好物分享～',
    '加载中…',
    '爱你❤️ - 小红书',
    '🇨🇳 中国',
    '👍🏽 点赞',
    '夏天必备🔥',
    '100% 纯棉',
    'C# 入门 #1',
    'Tom & Jerry',
    "it's `ok`!",
    '(a)[b]{c};d,e',
    'CON x',
    'café',
  ]) {
    assert.equal(sanitize(s), s);
  }
});

test('ZWJ 组合 emoji：去掉零宽连接符，emoji 本身保留', () => {
  assert.equal(sanitize('今天也是元气满满的一天🙋‍♀️ - 小红书'), '今天也是元气满满的一天🙋♀️ - 小红书');
  assert.equal(sanitize('👨‍👩‍👧 一家人'), '👨👩👧 一家人');
});

test('截断到 80：不留结尾空格 / 点，不拆代理对，不拆 emoji', () => {
  const t = 'Everything you need to know about Apple’s new MacBook Pro lineup announced this week at the event';
  const s = sanitize(t);
  assert.ok(s.length <= 80);
  assert.ok(!/[\s.~]$/.test(s), JSON.stringify(s));
  assert.equal(s, 'Everything you need to know about Apple’s new MacBook Pro lineup announced this');

  assert.equal(sanitize('b'.repeat(79) + '.' + 'c'.repeat(20)), 'b'.repeat(79));
  const e = sanitize('d'.repeat(79) + '😀tail');
  assert.ok(e.isWellFormed(), '截断拆开了代理对');
  assert.equal(e, 'd'.repeat(79));
  // 国旗是两个区域指示符组成的一个字形，截断不能只留半个
  const f = sanitize('f'.repeat(78) + '🇨🇳');
  assert.equal(f, 'f'.repeat(78));
});

test('fileNameFromUrl + joinPath：「001_」+ 80 字主干原样保留，不被二次截断', () => {
  const name = fileNameFromUrl(`https://cdn.example.com/${encodeURIComponent('汉'.repeat(100))}.jpg`, 0, 'jpg');
  assert.equal(name, `001_${'汉'.repeat(80)}.jpg`);
  assert.equal(joinPath('Gleaner/x', name), `Gleaner/x/${name}`);
});

test('joinPath：标题里的 / 不再拆出一层多余的文件夹', () => {
  assert.equal(joinPath('Gleaner', 'AC/DC - 知乎'), 'Gleaner/AC_DC - 知乎');
  assert.equal(joinPath(joinPath('Gleaner', 'AC/DC - 知乎'), '001_x.jpg'), 'Gleaner/AC_DC - 知乎/001_x.jpg');
});

test('扩展名：Shell 扩展名去掉点，空扩展名不留结尾的点', () => {
  assert.equal(fileNameFromUrl('https://a.com/a.lnk', 0, 'lnk'), '001_a_lnk');
  assert.equal(fileNameFromUrl('https://a.com/a', 0, ''), '001_a');
  assert.equal(sanitizeFileName('desktop.ini'), '_desktop.ini');
  assert.equal(sanitizeFileName('CON.txt'), '_CON.txt');
});
