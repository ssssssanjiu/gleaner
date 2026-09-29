/**
 * B站 轨道清单测试。夹具取自 2026-09 真实页面（签名已替换为假值）：
 * - bili-playurl-api-av1.json：BV1i4aL6QEYX，清单来自 playurl 接口；播放器在 Chrome 里选了 AV1（100023），
 *   直接跟着播放器下载 → QuickTime「无法打开」（实测）
 * - bili-playinfo-window.json：BV1uv411q7Mv，清单内嵌在 window.__playinfo__；
 *   H.264 轨文件名前缀和其他轨不同（214334689_nb2-1-30032），按前缀配对会配不上
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  biliCodec, biliMediaHit, estimateBytes, extractBiliTracks, isBiliPlayurlApi, pickBiliVideo, sanitizeBiliTracks,
  type BiliTrack,
} from '../src/core/bili';
import { codecOf, consolidateMedia } from '../src/core/media';
import type { MediaHit } from '../src/core/types';

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8'));
const API_AV1 = fixture('bili-playurl-api-av1.json');
const WINDOW = fixture('bili-playinfo-window.json');
const file = (u?: string) => u?.split('?')[0].split('/').pop();

test('接口清单：取出全部编码的画面轨和音轨', () => {
  const t = extractBiliTracks(API_AV1)!;
  assert.equal(t.video.length, 6);
  assert.equal(t.audio.length, 3);
  assert.deepEqual(
    t.video.map((v) => `${v.id}/${biliCodec(v)}`).sort(),
    ['16/av1', '16/h264', '16/hevc', '32/av1', '32/h264', '32/hevc'],
  );
});

test('播放器选了 AV1 时，仍然挑同清晰度的 H.264 + 最高码率 AAC（修 QuickTime 打不开）', () => {
  const hit = biliMediaHit(extractBiliTracks(API_AV1)!)!;
  assert.equal(file(hit.url), '42285466216-1-30032.m4s', '应选 480P 的 H.264，而不是播放器在放的 100023（AV1）');
  assert.equal(hit.codec, 'h264');
  assert.equal(file(hit.pairedAudioUrl), '42285466216-1-30280.m4s', '声音选码率最高的 30280');
  assert.equal(hit.width, 852);
  assert.equal(hit.height, 480);
  assert.equal(hit.name, '480P · H.264');
  assert.ok(hit.url.includes('upsig='), '必须用清单里带签名的完整地址');
  assert.ok(hit.coversKeys!.includes('42285466216-1-100023.m4s'));
  assert.equal(hit.backupUrls?.length, 1, '备用 CDN 地址要带上（主地址 403/超时时换着试）');
  assert.match(hit.backupUrls![0], /-1-30032\.m4s\?/);
  assert.match(hit.pairedAudioBackupUrls?.[0] ?? '', /-1-30280\.m4s\?/);
});

test('内嵌 __playinfo__：H.264 轨文件名前缀不同也能选中并配上声音', () => {
  const hit = biliMediaHit(extractBiliTracks(WINDOW)!)!;
  assert.equal(file(hit.url), '214334689_nb2-1-30032.m4s');
  assert.equal(file(hit.pairedAudioUrl), '214334689_nb2-1-30280.m4s');
});

test('清晰度优先：1080P 只有 HEVC/AV1、720P 有 H.264 时选 1080P HEVC（HEVC 会自动修正可播）', () => {
  const t = (id: number, codecid: number, h: number): BiliTrack => ({
    url: `https://c/x-1-${id}${codecid}.m4s`, backups: [], id, codecid, codecs: '',
    width: Math.round((h * 16) / 9), height: h, bandwidth: 1,
  });
  const v = pickBiliVideo([t(80, 12, 1080), t(80, 13, 1080), t(64, 7, 720), t(64, 13, 720)])!;
  assert.equal(v.height, 1080);
  assert.equal(biliCodec(v), 'hevc');
});

test('只有 AV1 可选时如实选 AV1（不会凭空消失），标注交给弹窗', () => {
  const only: BiliTrack = {
    url: 'https://c/x-1-100026.m4s', backups: [], id: 80, codecid: 13, codecs: 'av01.0.08M.08',
    width: 1920, height: 1080, bandwidth: 1,
  };
  const hit = biliMediaHit({ video: [only], audio: [] })!;
  assert.equal(hit.codec, 'av1');
  assert.equal(hit.pairedAudioUrl, undefined);
});

test('playurl 接口识别：普通/番剧/课程命中；带 gen=playurlv2 的媒体分片不命中', () => {
  assert.ok(isBiliPlayurlApi('https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1&cid=1'));
  assert.ok(isBiliPlayurlApi('https://api.bilibili.com/x/player/playurl?bvid=BV1'));
  assert.ok(isBiliPlayurlApi('https://api.bilibili.com/pgc/player/web/v2/playurl?ep_id=1'));
  assert.ok(isBiliPlayurlApi('https://api.bilibili.com/pugv/player/web/playurl?ep_id=1'));
  assert.ok(!isBiliPlayurlApi('https://upos-sz-mirrorcosov.bilivideo.com/x/1-1-30032.m4s?gen=playurlv2&upsig=x'));
  assert.ok(!isBiliPlayurlApi('https://api.bilibili.com/x/player/wbi/playurlx'));
  assert.ok(!isBiliPlayurlApi('https://evil.example/api.bilibili.com/x/player/playurl'));
});

test('番剧接口结构（result.video_info.dash）也能取', () => {
  const t = extractBiliTracks({ code: 0, result: { video_info: { dash: WINDOW.data.dash } } });
  assert.equal(t?.video.length, 4);
});

test('页面伪造的清单：非 http(s) 地址被丢掉，形状不对整体丢弃', () => {
  assert.equal(sanitizeBiliTracks(null), null);
  assert.equal(sanitizeBiliTracks({ video: 'x' }), null);
  assert.equal(sanitizeBiliTracks({ video: [{ url: 'javascript:alert(1)' }] }), null);
  const ok = sanitizeBiliTracks({
    video: [{ url: 'https://c/a-1-30032.m4s', id: '32', codecid: 7, backups: ['file:///etc/passwd', 'https://b/a'] }],
    audio: 'nope',
  })!;
  assert.equal(ok.video[0].id, 32);
  assert.deepEqual(ok.video[0].backups, ['https://b/a']);
  assert.deepEqual(ok.audio, []);
});

test('归并：清单条目在，播放器实际在放的 AV1 散轨和各档音轨全部让位 —— 只剩一行', () => {
  const curated = biliMediaHit(extractBiliTracks(API_AV1)!)!;
  const sniff = (name: string, track: 'video' | 'audio'): MediaHit => ({
    url: `https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/16/62/42285466216/${name}?upsig=zzz`,
    kind: 'stream', streamKind: 'dash-track', track, codec: codecOf(name), via: 'sniffer',
  });
  const out = consolidateMedia([
    sniff('42285466216-1-100023.m4s', 'video'),
    sniff('42285466216-1-100022.m4s', 'video'),
    sniff('42285466216-1-30216.m4s', 'audio'),
    curated,
  ]);
  assert.equal(out.length, 1, JSON.stringify(out.map((m) => file(m.url))));
  assert.equal(out[0].codec, 'h264');
  assert.equal(file(out[0].url), '42285466216-1-30032.m4s');
});

test('归并：有清单时，之前播过的其他视频的散轨（切分P/连播后残留）不再列出', () => {
  const curated = biliMediaHit(extractBiliTracks(API_AV1)!)!;
  const prevEpisode: MediaHit[] = [
    { url: 'https://upos-sz-mirrorcosov.bilivideo.com/x/11111111-1-30032.m4s?upsig=a', kind: 'stream',
      streamKind: 'dash-track', track: 'video', codec: 'h264', via: 'sniffer' },
    { url: 'https://upos-sz-mirrorcosov.bilivideo.com/x/11111111-1-30280.m4s?upsig=a', kind: 'stream',
      streamKind: 'dash-track', track: 'audio', via: 'sniffer' },
  ];
  const out = consolidateMedia([...prevEpisode, curated]);
  assert.equal(out.length, 1, JSON.stringify(out.map((m) => file(m.url))));
  assert.equal(out[0].curated, true);
});

test('归并：清单没覆盖的其他视频/直链照常保留', () => {
  const curated = biliMediaHit(extractBiliTracks(API_AV1)!)!;
  const other: MediaHit = { url: 'https://cdn.example/ad.mp4', kind: 'video', via: 'sniffer' };
  const out = consolidateMedia([other, curated]);
  assert.equal(out.length, 2);
  assert.equal(out[0].curated, true, '清单条目排最前');
});

test('codecOf 兜底表与实测一致：1000xx=AV1，1001xx=HEVC，30011/30033=HEVC，30016/30032=H.264', () => {
  assert.equal(codecOf('https://c/x-1-100022.m4s'), 'av1');
  assert.equal(codecOf('https://c/x-1-100023.m4s'), 'av1');
  assert.equal(codecOf('https://c/x-1-100113.m4s'), 'hevc');
  assert.equal(codecOf('https://c/x-1-30011.m4s'), 'hevc');
  assert.equal(codecOf('https://c/x-1-30033.m4s'), 'hevc');
  assert.equal(codecOf('https://c/x-1-30016.m4s'), 'h264');
  assert.equal(codecOf('https://c/x-1-30032.m4s'), 'h264');
  // 夹具里每条轨的 codecid 都要和兜底表一致（兜底表是照这份真实数据校的）
  for (const src of [API_AV1, WINDOW]) {
    for (const v of extractBiliTracks(src)!.video) {
      assert.equal(codecOf(v.url), biliCodec(v), `${file(v.url)} codecid=${v.codecid}`);
    }
  }
});

const trk = (id: number, codecid: number, h: number, bw: number): BiliTrack => ({
  url: `https://c/long-1-${30000 + id}.m4s?upsig=x`, backups: [], id, codecid, codecs: codecid === 7 ? 'avc1' : 'hev1',
  width: Math.round((h * 16) / 9), height: h, bandwidth: bw,
});

test('体积上限：1 小时视频 1080P 放不下 600MB 时退到放得下的 720P（之前只看清晰度，下完才报超限）', () => {
  const tracks = {
    duration: 3600,
    video: [trk(80, 7, 1080, 2_000_000), trk(64, 7, 720, 1_000_000), trk(32, 7, 480, 600_000)],
    audio: [{ ...trk(30280, 0, 0, 130_000), codecs: 'mp4a.40.2' }],
  };
  const hit = biliMediaHit(tracks)!;
  assert.equal(hit.height, 720, `应退到 720P，实际 ${hit.height}`);
  assert.ok(hit.size! <= 600 * 1048576, `估算体积 ${hit.size} 应在上限内`);
  assert.ok(!/超出/.test(hit.name!), hit.name ?? "");
});

test('体积上限：连最低清晰度都放不下时选最小的一条，并在名字里直说下不了', () => {
  const tracks = {
    duration: 3 * 3600,
    video: [trk(32, 7, 480, 900_000), trk(16, 7, 360, 600_000)],
    audio: [{ ...trk(30216, 0, 0, 67_000), codecs: 'mp4a.40.2' }],
  };
  const hit = biliMediaHit(tracks)!;
  assert.equal(hit.height, 360);
  assert.match(hit.name!, /超出 600MB 上限/);
});

test('体积估算：真实清单（110 秒、480P）照常选 H.264，估算体积与实测落盘同一量级', () => {
  const t = extractBiliTracks(API_AV1)!;
  assert.equal(t.duration, 110);
  const hit = biliMediaHit(t)!;
  assert.equal(file(hit.url), '42285466216-1-30032.m4s');
  // 实测：这个视频合并后 11,148,162 字节
  assert.ok(hit.size! > 5e6 && hit.size! < 2e7, `估算 ${hit.size}`);
  assert.equal(estimateBytes(undefined, 100), 0);
});
