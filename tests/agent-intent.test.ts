/**
 * 本地意图解析：每条规则都要能被一句真实的话触发，且不该上云的话绝不标 needsCloud。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cnNumber, describeIntent, parseIntent } from '../src/core/agent/intent';

test('用户原话：我需要页面内所有绿色的图片 → 本地 · 图片 · 绿', () => {
  const i = parseIntent('我需要页面内所有绿色的图片');
  assert.equal(i.kind, 'image');
  assert.deepEqual(i.colors, ['green']);
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('用户原话：我要页面内评论区的视频，给我下载下来 → 本地 · 视频 · 评论区', () => {
  const i = parseIntent('我要页面内评论区的视频，给我下载下来');
  assert.equal(i.kind, 'video');
  assert.equal(i.section, '评论区');
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('把有猫的图片下载下来 → 需要云端，语义保留「猫」', () => {
  const i = parseIntent('把有猫的图片下载下来');
  assert.equal(i.kind, 'image');
  assert.equal(i.needsCloud, true);
  assert.match(i.semantic, /猫/);
});

test('英文：download all the green images on this page', () => {
  const i = parseIntent('Download all the green images on this page');
  assert.equal(i.kind, 'image');
  assert.deepEqual(i.colors, ['green']);
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('多个颜色是或关系', () => {
  const i = parseIntent('所有绿色和蓝色的图片');
  assert.deepEqual(i.colors, ['green', 'blue']);
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('最大的三张图 → 按面积取 3', () => {
  const i = parseIntent('最大的三张图');
  assert.equal(i.kind, 'image');
  assert.equal(i.order, 'largest');
  assert.equal(i.limit, 3);
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('top 3 largest photos', () => {
  const i = parseIntent('top 3 largest photos');
  assert.equal(i.order, 'largest');
  assert.equal(i.limit, 3);
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('the biggest video → 最大 1 个视频', () => {
  const i = parseIntent('the biggest video');
  assert.equal(i.kind, 'video');
  assert.equal(i.order, 'largest');
  assert.equal(i.limit, 1);
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('第二个视频 → 序号 2', () => {
  const i = parseIntent('第二个视频');
  assert.equal(i.kind, 'video');
  assert.equal(i.ordinal, 2);
  assert.equal(i.needsCloud, false);
});

test('页面里最后一张图 → last 1', () => {
  const i = parseIntent('页面里最后一张图');
  assert.equal(i.order, 'last');
  assert.equal(i.limit, 1);
  assert.equal(i.needsCloud, false, `残留语义: ${i.semantic}`);
});

test('first 5 pictures → 前 5', () => {
  const i = parseIntent('first 5 pictures');
  assert.equal(i.order, 'first');
  assert.equal(i.limit, 5);
  assert.equal(i.ordinal, undefined);
});

test('尺寸：大于 1000px 的图片 / 高清大图 / 小图 / 1080p 视频', () => {
  assert.equal(parseIntent('大于1000px的图片').minSide, 1000);
  assert.equal(parseIntent('高清大图').minSide, 800);
  assert.equal(parseIntent('小图').maxSide, 300);
  const v = parseIntent('1080p的视频');
  assert.equal(v.kind, 'video');
  assert.equal(v.minSide, 1080);
  for (const t of ['大于1000px的图片', '高清大图', '小图', '1080p的视频']) {
    assert.equal(parseIntent(t).needsCloud, false, `${t} 残留: ${parseIntent(t).semantic}`);
  }
});

test('方向：横图 / 竖图 / 方图', () => {
  assert.equal(parseIntent('横图').orientation, 'landscape');
  assert.equal(parseIntent('所有竖版的图片').orientation, 'portrait');
  assert.equal(parseIntent('square images').orientation, 'square');
});

test('分区：侧栏的图 / 产品图 / 页脚的视频', () => {
  assert.equal(parseIntent('侧栏的图').section, '侧边栏');
  const p = parseIntent('产品图');
  assert.equal(p.section, '商品区');
  assert.equal(p.kind, 'image');
  assert.equal(p.needsCloud, false, `残留: ${p.semantic}`);
  assert.equal(parseIntent('页脚的视频').section, '页脚');
});

test('音频类型', () => {
  assert.equal(parseIntent('把音频下下来').kind, 'audio');
  assert.equal(parseIntent('all the audio').kind, 'audio');
});

test('把所有素材都下载下来 → 无条件、本地', () => {
  const i = parseIntent('把所有素材都下载下来');
  assert.equal(i.kind, 'any');
  assert.equal(i.colors.length, 0);
  assert.equal(i.needsCloud, false, `残留: ${i.semantic}`);
});

test('语义请求：产品的白底图 / photos with people → 需要云端', () => {
  assert.equal(parseIntent('像海报一样的图片').needsCloud, true);
  assert.equal(parseIntent('photos with people in them').needsCloud, true);
});

test('中文数字', () => {
  assert.equal(cnNumber('三'), 3);
  assert.equal(cnNumber('两'), 2);
  assert.equal(cnNumber('十'), 10);
  assert.equal(cnNumber('十二'), 12);
  assert.equal(cnNumber('二十'), 20);
  assert.equal(cnNumber('12'), 12);
  assert.equal(cnNumber('x'), undefined);
});

test('describeIntent 说人话', () => {
  const d = describeIntent(parseIntent('评论区最大的两张绿色横图'));
  assert.match(d, /图片/);
  assert.match(d, /绿色/);
  assert.match(d, /横图/);
  assert.match(d, /评论区/);
  assert.match(d, /最大 2 个/);
});
