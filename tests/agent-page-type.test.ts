import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyPage } from '../src/core/agent/page-type';
import type { Candidate } from '../src/core/agent/types';

const img = (i: number): Candidate => ({ id: `i${i}`, kind: 'image', url: `https://x/${i}.jpg`, width: 800, height: 600, index: i });
const vid = (i: number): Candidate => ({ id: `v${i}`, kind: 'video', url: `https://x/${i}.mp4`, width: 1920, height: 1080, index: i });

test('已知站点按域名判断，首页单独算', () => {
  const b = classifyPage({ url: 'https://www.bilibili.com/video/BV1xx', title: 'x', headings: [] }, []);
  assert.equal(b.type, 'video');
  assert.equal(b.label, '视频页 · bilibili.com');
  assert.equal(classifyPage({ url: 'https://www.bilibili.com/', title: 'x', headings: [] }, []).type, 'home');
  assert.equal(classifyPage({ url: 'https://unsplash.com/s/photos/cat', title: 'x', headings: [] }, []).type, 'search');
  assert.equal(classifyPage({ url: 'https://unsplash.com/t/nature', title: 'x', headings: [] }, []).type, 'gallery');
  assert.equal(classifyPage({ url: 'https://item.taobao.com/item.htm?id=1', title: 'x', headings: [] }, []).type, 'product');
  assert.equal(classifyPage({ url: 'https://weibo.com/u/123', title: 'x', headings: [] }, []).type, 'social');
});

test('搜索结果页看 URL 参数', () => {
  assert.equal(classifyPage({ url: 'https://www.google.com/search?q=cat', title: 'x', headings: [] }, []).type, 'search');
  assert.equal(classifyPage({ url: 'https://www.baidu.com/s?wd=cat', title: 'x', headings: [] }, []).type, 'search');
});

test('未知站点看 og:type', () => {
  assert.equal(classifyPage({ url: 'https://a.com/p/1', title: 'x', headings: [], ogType: 'video.other' }, []).type, 'video');
  assert.equal(classifyPage({ url: 'https://a.com/p/1', title: 'x', headings: [], ogType: 'article' }, []).type, 'article');
  assert.equal(classifyPage({ url: 'https://a.com/p/1', title: 'x', headings: [], ogType: 'product.item' }, []).type, 'product');
});

test('再没有就看素材构成', () => {
  assert.equal(classifyPage({ url: 'https://a.com/p/1', title: 'x', headings: ['h'] }, [vid(0), img(1)]).type, 'video');
  const gallery = Array.from({ length: 25 }, (_, i) => img(i));
  assert.equal(classifyPage({ url: 'https://a.com/p/1', title: 'x', headings: [] }, gallery).type, 'gallery');
  assert.equal(classifyPage({ url: 'https://a.com/p/1', title: 'x', headings: ['a', 'b', 'c', 'd'] }, [img(0)]).type, 'article');
  assert.equal(classifyPage({ url: 'https://a.com/', title: 'x', headings: [] }, []).type, 'home');
  assert.equal(classifyPage({ url: 'https://a.com/x', title: 'x', headings: [] }, []).type, 'other');
});

test('非法 URL 不炸', () => {
  assert.equal(classifyPage({ url: 'not a url', title: 'x', headings: [] }, []).type, 'other');
});
