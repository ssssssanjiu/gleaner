/**
 * 媒体归并测试。用例取自真实 B站 页面（用户截图里的文件名）。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { consolidateMedia, isMediaUrl, trackOf, basenameKey, normalizeFragmentUrl, codecOf } from '../src/core/media';
import type { MediaHit } from '../src/core/types';

const track = (url: string, t: 'video' | 'audio', extra: Partial<MediaHit> = {}): MediaHit => ({
  url, kind: 'stream', streamKind: 'dash-track', track: t, via: 'sniffer', segments: 1, ...extra,
});

test('B站 音视频轨配对成一条「视频」，不再暴露分轨', () => {
  const out = consolidateMedia([
    track('https://cdn1.bilivideo.com/x/41472951104-1-100026.m4s', 'video'),
    track('https://cdn1.bilivideo.com/x/41472951104-1-30232.m4s', 'audio'),
  ]);
  assert.equal(out.length, 1, `应合并成一条，实际 ${out.length}`);
  assert.equal(out[0].track, 'video');
  assert.ok(out[0].pairedAudioUrl?.endsWith('-30232.m4s'), '应带上配对音频地址');
});

test('跨 CDN 同名文件去重（用户截图里的重复行）', () => {
  const out = consolidateMedia([
    track('https://upos-sz-mirrorcoso1.bilivideo.com/x/41472951104-1-100026.m4s', 'video'),
    track('https://upos-hz-mirrorakam.akamaized.net/x/41472951104-1-100026.m4s', 'video'),
    track('https://upos-sz-mirrorcoso1.bilivideo.com/x/41472951104-1-30232.m4s', 'audio'),
    track('https://upos-hz-mirrorakam.akamaized.net/x/41472951104-1-30232.m4s', 'audio'),
  ]);
  assert.equal(out.length, 1, `跨 CDN 应去重后合并成一条，实际 ${out.length}`);
});

test('只有视频轨没有音频轨时如实标注', () => {
  const out = consolidateMedia([track('https://c/x-1-100026.m4s', 'video')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].pairedAudioUrl, undefined);
});

test('纯音频页面：只有音频轨时展示为音频，不硬凑成视频', () => {
  const out = consolidateMedia([track('https://c/x-1-30232.m4s', 'audio')]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'audio');
});

test('普通直链视频与音频各自独立，不参与配对', () => {
  const out = consolidateMedia([
    { url: 'https://c/movie.mp4', kind: 'video', via: 'sniffer' },
    { url: 'https://c/song.mp3', kind: 'audio', via: 'sniffer' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].kind, 'video', '有画面的排前面');
  assert.equal(out[1].kind, 'audio');
});

test('合并时保留更全的信息（尺寸、体积、分片数累加）', () => {
  const out = consolidateMedia([
    track('https://a/x-1-100026.m4s', 'video', { segments: 10 }),
    track('https://b/x-1-100026.m4s', 'video', { segments: 5, width: 1920, height: 1080 }),
    track('https://a/x-1-30232.m4s', 'audio', { segments: 8 }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].width, 1920, '应从另一条补上尺寸');
  assert.equal(out[0].segments, 23, `分片数应累加 10+5+8，实际 ${out[0].segments}`);
});

test('isMediaUrl 挡掉非媒体路径（/web 之流）', () => {
  assert.equal(isMediaUrl('https://data.bilibili.com/log/web'), false);
  assert.equal(isMediaUrl('https://api.bilibili.com/x/player/playurl?ts=1'), false);
  assert.equal(isMediaUrl('https://c/a-1-100026.m4s'), true);
  assert.equal(isMediaUrl('https://c/movie.mp4?token=x'), true);
  assert.equal(isMediaUrl('https://c/list.m3u8'), true);
});

test('trackOf 认得 B站 六位轨道号', () => {
  assert.equal(trackOf('https://c/x-1-100026.m4s'), 'video');
  assert.equal(trackOf('https://c/x-1-30232.m4s'), 'audio');
  assert.equal(trackOf('https://c/x-1-30280.m4s'), 'audio');
  assert.equal(trackOf('https://c/x-1-30080.m4s'), 'video');
});

test('basenameKey 忽略域名和查询参数', () => {
  assert.equal(
    basenameKey('https://a.com/p/x-1-100026.m4s?range=0-99'),
    basenameKey('https://b.net/p/x-1-100026.m4s?deadline=123'),
  );
});

test('前缀不同但全页只有一视频一音频时兜底配对', () => {
  const out = consolidateMedia([
    track('https://c/videoStream-1-30080.m4s', 'video'),
    track('https://c/audioStream-1-30280.m4s', 'audio'),
  ]);
  assert.equal(out.length, 1, `应兜底配对成一条，实际 ${out.length}`);
  assert.ok(out[0].pairedAudioUrl?.includes('audioStream'));
});

test('多个视频轨时不乱配对（避免张冠李戴）', () => {
  const out = consolidateMedia([
    track('https://c/aaa-1-30080.m4s', 'video'),
    track('https://c/bbb-1-30080.m4s', 'video'),
    track('https://c/ccc-1-30280.m4s', 'audio'),
  ]);
  assert.equal(out.length, 3, '前缀都不同且视频轨多于一条时，不应瞎配');
  assert.ok(out.every((m) => !m.pairedAudioUrl));
});

test('分片 URL 归一化：保留鉴权签名，只去 range（B站 403 回归）', () => {
  const signed =
    'https://upos-sz-mirrorcoso1.bilivideo.com/upgcxcode/x/41383559614-1-100026.m4s' +
    '?e=ig8euxZM2rNcNbdl&deadline=1788300000&oi=1234567&trid=abc&platform=pc&upsig=deadbeef&range=0-999';
  const n = normalizeFragmentUrl(signed);
  assert.ok(n.includes('upsig=deadbeef'), '签名必须保留，否则 CDN 返回错误页');
  assert.ok(n.includes('deadline=1788300000'), 'deadline 必须保留');
  assert.ok(n.includes('trid=abc'), 'trid 必须保留');
  assert.ok(!n.includes('range='), 'range 参数应去掉，否则只下到一个分段');
});

test('归一化后同轨不同 range 的分片视为同一条', () => {
  const a = normalizeFragmentUrl('https://c/x-1-100026.m4s?upsig=s&range=0-99');
  const b = normalizeFragmentUrl('https://c/x-1-100026.m4s?upsig=s&range=100-199');
  assert.equal(a, b);
});

test('codecOf：1001xx 是 HEVC（实测 -1-100113.m4s 落盘为 hev1），1000xx 是 AV1', () => {
  assert.equal(codecOf('https://c/x-1-100113.m4s'), 'hevc');
  // 实测 100022/100023 落盘为 av01、清单 codecid=13；之前误标成 HEVC，用户下到打不开的 AV1
  assert.equal(codecOf('https://c/x-1-100026.m4s'), 'av1');
  assert.equal(codecOf('https://c/x-1-30080.m4s'), 'h264');
  assert.equal(codecOf('https://c/x-1-30112.m4s'), 'hevc');
});

test('同时抓到 HEVC 和 H.264 画面轨时，优先留 H.264（兼容性最好）', () => {
  const out = consolidateMedia([
    { url: 'https://c/vid-1-100113.m4s', kind: 'stream', streamKind: 'dash-track',
      track: 'video', codec: 'hevc', via: 'sniffer' },
    { url: 'https://c/vid-1-30080.m4s', kind: 'stream', streamKind: 'dash-track',
      track: 'video', codec: 'h264', via: 'sniffer' },
    { url: 'https://c/vid-1-30232.m4s', kind: 'stream', streamKind: 'dash-track',
      track: 'audio', codec: 'h264', via: 'sniffer' },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].codec, 'h264', `应选 H.264，实际 ${out[0].codec}`);
  assert.ok(out[0].url.includes('30080'));
});

test('只有 HEVC 可用时如实保留并标注', () => {
  const out = consolidateMedia([
    { url: 'https://c/only-1-100113.m4s', kind: 'stream', streamKind: 'dash-track',
      track: 'video', codec: 'hevc', via: 'sniffer' },
  ]);
  assert.equal(out[0].codec, 'hevc');
});

test('HLS：.ts 分段不单独列出（直播能堆出上千行、单段只有几秒），m3u8 那一行保留', () => {
  const segs: MediaHit[] = Array.from({ length: 50 }, (_, i) => ({
    url: `https://live.example/hls/seg${i}.ts`, kind: 'stream', streamKind: 'dash-track', track: 'video', via: 'dom',
  }));
  const manifest: MediaHit = { url: 'https://live.example/hls/index.m3u8', kind: 'stream', streamKind: 'hls', via: 'sniffer' };
  const out = consolidateMedia([...segs, manifest]);
  assert.equal(out.length, 1, JSON.stringify(out.map((m) => m.url)));
  assert.equal(out[0].streamKind, 'hls');
});

test('编号连续的 .m4s 分段（HLS-fMP4 / SegmentTemplate）不当成整轨列出；B站 的轨道编号不受影响', () => {
  const segs = Array.from({ length: 12 }, (_, i) =>
    track(`https://cdn.example/v/chunk-stream0-${String(i + 1).padStart(5, '0')}.m4s`, 'video'));
  assert.equal(consolidateMedia(segs).length, 0, '分段序列应被隐藏');
  const bili = consolidateMedia([
    track('https://c/42285466216-1-100022.m4s', 'video'),
    track('https://c/42285466216-1-100023.m4s', 'video'),
    track('https://c/42285466216-1-100024.m4s', 'video'),
    track('https://c/42285466216-1-100026.m4s', 'video'),
    track('https://c/42285466216-1-30280.m4s', 'audio'),
  ]);
  assert.equal(bili.length, 1, 'B站 各档画质轨 + 音轨应合成一条');
});
