import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { buildCandidates } from '../src/core/agent/candidates';
import type { MediaHit, MediaItem } from '../src/core/types';

const items: MediaItem[] = [
  { id: 'https://c/a.jpg', url: 'https://c/a.jpg', originalUrl: 'https://c/a_s.jpg', previewUrl: 'https://c/a_xs.jpg', width: 800, height: 600, ext: 'jpg', source: 'img', alt: 'A', section: '正文' },
  { id: 'https://c/b.png', url: 'https://c/b.png', originalUrl: 'https://c/b.png', width: 0, height: 0, ext: 'png', source: 'lazy', alt: '' },
];
const media: MediaHit[] = [
  { url: 'https://c/v.m4s', kind: 'stream', streamKind: 'dash-track', track: 'video', via: 'sniffer', pairedAudioUrl: 'https://c/a.m4s', size: 100 },
  { url: 'https://c/x.m3u8', kind: 'stream', streamKind: 'hls', via: 'sniffer' },
  { url: 'https://c/s.mp3', kind: 'audio', via: 'dom', section: '侧边栏' },
  { url: 'https://c/d.mp4', kind: 'video', via: 'dom', width: 640, height: 360 },
];

test('图片用 previewUrl 当缩略图，空 alt 归 undefined', () => {
  const c = buildCandidates(items, []);
  assert.equal(c.length, 2);
  assert.equal(c[0].thumb, 'https://c/a_xs.jpg');
  assert.equal(c[0].section, '正文');
  assert.equal(c[1].thumb, 'https://c/b.png');
  assert.equal(c[1].alt, undefined);
  assert.deepEqual(c.map((x) => x.index), [0, 1]);
});

test('音视频：m3u8 不进候选；DASH 标注有无声音；类型内各自编序号', () => {
  const c = buildCandidates([], media);
  assert.deepEqual(c.map((x) => x.id), ['https://c/v.m4s', 'https://c/s.mp3', 'https://c/d.mp4']);
  assert.equal(c[0].kind, 'video');
  assert.equal(c[0].hasAudio, true);
  assert.equal(c[0].index, 0);
  assert.equal(c[1].kind, 'audio');
  assert.equal(c[1].section, '侧边栏');
  assert.equal(c[2].kind, 'video');
  assert.equal(c[2].index, 1);
  assert.equal(c[2].hasAudio, undefined);
});
