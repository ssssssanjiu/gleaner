import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { breadcrumb, containerLabel, sectionInQuery, sectionMatches } from '../src/core/agent/sections';

test('DOM 线索 → 分区标签', () => {
  assert.equal(containerLabel('div comment-list  '), '评论区');
  assert.equal(containerLabel('section  reply-box  '), '评论区');
  assert.equal(containerLabel('header  site-header  '), '页头');
  assert.equal(containerLabel('nav   navigation '), '导航');
  assert.equal(containerLabel('footer   '), '页脚');
  assert.equal(containerLabel('aside  sidebar  complementary '), '侧边栏');
  assert.equal(containerLabel('main   main '), '正文');
  assert.equal(containerLabel('div  rcmd-list  '), '推荐区');
  assert.equal(containerLabel('div  swiper-container  '), '图集');
  assert.equal(containerLabel('div  product-gallery '), '图集', '两个线索都命中时取词表里靠前的');
  assert.equal(containerLabel('div  goods-detail  '), '商品区');
  assert.equal(containerLabel('img  user-avatar  '), '头像');
  assert.equal(containerLabel('div  ad-banner '), '图集');
  assert.equal(containerLabel('div  wrapper  '), null);
});

test('面包屑：去重、最多 3 层、带标题', () => {
  assert.equal(breadcrumb(['正文', '评论区', '评论区'], '热门评论'), '正文 › 评论区 › 热门评论');
  assert.equal(breadcrumb(['页头', '导航', '正文', '评论区']), '导航 › 正文 › 评论区');
  assert.equal(breadcrumb([], '  多余   空格  的标题'), '多余 空格 的标题');
  assert.equal(breadcrumb([]), '');
});

test('用户口语 → 分区标签', () => {
  assert.equal(sectionInQuery('评论区的视频')?.label, '评论区');
  assert.equal(sectionInQuery('sidebar images')?.label, '侧边栏');
  assert.equal(sectionInQuery('顶部的 banner')?.label, '页头');
  assert.equal(sectionInQuery('随便什么图'), null);
});

test('面包屑匹配：包含即命中；没有任何标签的素材归「正文」', () => {
  assert.ok(sectionMatches('正文 › 评论区 › 热评', '评论区'));
  assert.ok(!sectionMatches('侧边栏 › 推荐区', '评论区'));
  assert.ok(sectionMatches(undefined, '正文'));
  assert.ok(!sectionMatches(undefined, '评论区'));
});
