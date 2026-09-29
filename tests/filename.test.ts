import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { sanitize, fileNameFromUrl, joinPath } from '../src/core/filename';

test('sanitize 保留空格和连字符', () => {
  assert.equal(sanitize('我的图片 2024-01'), '我的图片 2024-01');
  assert.equal(sanitize('hero-banner v2'), 'hero-banner v2');
});

test('sanitize 替换非法字符', () => {
  assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.equal(sanitize('tab\there\nnewline'), 'tab_here_newline');
});

test('sanitize 折叠连续空白并截断到 80 字符', () => {
  assert.equal(sanitize('a    b  c'), 'a b c');
  assert.equal(sanitize('x'.repeat(200)).length, 80);
});

test('sanitize 空值与纯点名回退', () => {
  assert.equal(sanitize(''), 'untitled');
  assert.equal(sanitize('   '), 'untitled');
  assert.equal(sanitize('...'), 'untitled');
  assert.equal(sanitize('///', 'x'), 'x');
});

test('fileNameFromUrl 取 pathname 末段并解码', () => {
  assert.equal(
    fileNameFromUrl('https://a.com/img/%E5%9B%BE%E7%89%871.png?x=1', 0, 'png'),
    '001_图片1.png',
  );
});

test('fileNameFromUrl 无可读名时只用序号', () => {
  assert.equal(fileNameFromUrl('https://a.com/', 4, 'jpg'), '005.jpg');
  assert.equal(fileNameFromUrl('not a url', 10, 'gif'), '011.gif');
});

test('fileNameFromUrl 序号从 001 开始补零', () => {
  assert.equal(fileNameFromUrl('https://a.com/x.jpg', 0, 'jpg'), '001_x.jpg');
  assert.equal(fileNameFromUrl('https://a.com/x.jpg', 99, 'jpg'), '100_x.jpg');
});

test('joinPath 清洗每段并丢弃空段', () => {
  assert.equal(joinPath('Gleaner/标题: 测试', 'a.jpg'), 'Gleaner/标题_ 测试/a.jpg');
  assert.equal(joinPath('///', 'a.jpg'), 'a.jpg');
  assert.equal(joinPath('', 'a.jpg'), 'a.jpg');
});

test('joinPath 防路径穿越：.. 段被回退掉', () => {
  const p = joinPath('Gleaner/../..', 'a.jpg');
  assert.ok(!p.includes('..'), `不应包含 ..，got: ${p}`);
});

// ---- 以下用例都是真 Chrome 153 实测会报 "Invalid filename" 的标题（image-scan#1 / offscreen-memory#2 /
//      test-fidelity#1 / popup-ux#9 / bilibili-pipeline#10）。完整字符集见 tests/sanitize-chrome.test.ts ----

test('sanitize 去掉零宽字符：ZWJ 组合 emoji、零宽空格', () => {
  assert.equal(sanitize('今天也是元气满满的一天🙋‍♀️ - 小红书'), '今天也是元气满满的一天🙋♀️ - 小红书');
  assert.equal(sanitize('标题​里有零宽空格 - 知乎'), '标题里有零宽空格 - 知乎');
  assert.equal(sanitize('﻿标题'), '标题');
});

test('sanitize 去掉开头的点、结尾的点 / ~ / 空格', () => {
  assert.equal(sanitize('.NET 8 新特性一览 - 博客园'), 'NET 8 新特性一览 - 博客园');
  assert.equal(sanitize('Loading...'), 'Loading');
  assert.equal(sanitize('周末去哪儿...'), '周末去哪儿');
  assert.equal(sanitize('好物分享~'), '好物分享');
  assert.equal(sanitize('全角空格结尾　'), '全角空格结尾');
});

test('sanitize 截断后不留结尾空格', () => {
  const s = sanitize('a'.repeat(79) + ' tail');
  assert.equal(s, 'a'.repeat(79));
});

test('sanitize 中间的 ~ 保留（Chrome 只拒首尾的 ~）', () => {
  assert.equal(sanitize('【4K】好听到哭~_哔哩哔哩_bilibili'), '【4K】好听到哭~_哔哩哔哩_bilibili');
  assert.equal(
    fileNameFromUrl('https://p3.douyinpic.com/obj/oAAbcdEF~tplv-dy-aweme-images:q75.webp', 0, 'webp'),
    '001_oAAbcdEF~tplv-dy-aweme-images_q75.webp',
  );
});

test('sanitize Windows 保留名加前缀', () => {
  assert.equal(sanitize('CON'), '_CON');
  assert.equal(sanitize('nul.txt'), '_nul.txt');
  assert.equal(sanitize('CON x'), 'CON x');
});

test('joinPath 文件夹来自带 ZWJ emoji / 结尾 ... 的标题时每段都合法', () => {
  assert.equal(
    joinPath(joinPath('Gleaner', '🙋‍♀️ 通勤穿搭分享 - 小红书'), '001_x.jpg'),
    'Gleaner/🙋♀️ 通勤穿搭分享 - 小红书/001_x.jpg',
  );
  assert.equal(joinPath(joinPath('Gleaner', 'Loading...'), '001_x.jpg'), 'Gleaner/Loading/001_x.jpg');
  assert.equal(joinPath(joinPath('Gleaner', '.NET 入门'), 'NET 入门.mp4'), 'Gleaner/NET 入门/NET 入门.mp4');
});
