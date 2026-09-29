import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildDigest, resolveSelected } from '../src/core/agent/digest';
import type { Candidate } from '../src/core/agent/types';

const cands: Candidate[] = [
  { id: 'a', kind: 'image', url: 'https://cdn.x/photos/cat%20one.jpg?x=1', width: 800, height: 600, alt: '一只猫', section: '正文 › 评论区', index: 0 },
  { id: 'b', kind: 'video', url: 'https://cdn.x/v/1.m4s', width: 1920, height: 1080, index: 0, hasAudio: true, sizeBytes: 12 * 1048576 },
  { id: 'c', kind: 'audio', url: 'https://cdn.x/a/1.m4a', width: 0, height: 0, index: 0 },
];

test('摘要按 #n 编号，带尺寸 / alt / 区域 / 文件名，不带正文', () => {
  const { text, ids } = buildDigest(
    { url: 'https://site.x/post/1', title: '标题', headings: ['一级', '二级'], ogType: 'article' },
    { type: 'article', label: '文章页 · site.x', reason: 'og' },
    cands,
  );
  assert.deepEqual(ids, ['a', 'b', 'c']);
  assert.match(text, /#1 图片 800×600 区域=正文 › 评论区 alt="一只猫" 文件=cat one\.jpg/);
  assert.match(text, /#2 视频 1920×1080 含声音 12\.0MB 文件=1\.m4s/);
  assert.match(text, /#3 音频 文件=1\.m4a/);
  assert.match(text, /标题层级: 一级 \| 二级/);
  assert.match(text, /本地初判: 文章页/);
});

test('超过上限只列前 N 项并注明', () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ ...cands[0], id: `i${i}` }));
  const { text, ids } = buildDigest({ url: 'https://s.x/', title: 't', headings: [] }, { type: 'other', label: 'x', reason: '' }, many);
  assert.equal(ids.length, 120);
  assert.match(text, /另有 10 项未列出/);
});

test('模型回的编号映射回 id，容错 "#3" / "3" / 原 id / 乱填', () => {
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(resolveSelected(['#3', '1'], ids), ['c', 'a']);
  assert.deepEqual(resolveSelected(['b', '#2', '#9', 'zzz'], ids), ['b']);
  assert.deepEqual(resolveSelected([], ids), []);
});
