/**
 * hev1 → hvc1 修正测试。
 * 用真实 B站 下载文件验证过：修正前 macOS 读到
 * "HEVC (Parameter Sets in Bitstream)"（QuickTime 拒绝），修正后读到 "HEVC"（正常播放）。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { patchHev1ToHvc1, detectCodec } from '../src/core/fmp4';

const enc = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

test('hev1 后面跟着 hvcC 时改写为 hvc1', () => {
  const bytes = new Uint8Array([
    ...enc('....hev1'), ...new Array(40).fill(0), ...enc('hvcC'), ...new Array(10).fill(0),
  ]);
  const r = patchHev1ToHvc1(bytes);
  assert.equal(r.patched, true);
  assert.equal(r.count, 1);
  assert.equal(new TextDecoder('latin1').decode(bytes.subarray(4, 8)), 'hvc1');
});

test('附近没有 hvcC 时不改写（参数集不在 moov 里，改了会得到坏文件）', () => {
  const bytes = new Uint8Array([...enc('....hev1'), ...new Array(600).fill(0), ...enc('hvcC')]);
  const r = patchHev1ToHvc1(bytes);
  assert.equal(r.patched, false);
  assert.equal(new TextDecoder('latin1').decode(bytes.subarray(4, 8)), 'hev1');
});

test('已经是 hvc1 的文件不受影响', () => {
  const bytes = new Uint8Array([...enc('....hvc1'), ...new Array(20).fill(0), ...enc('hvcC')]);
  const before = new TextDecoder('latin1').decode(bytes);
  assert.equal(patchHev1ToHvc1(bytes).patched, false);
  assert.equal(new TextDecoder('latin1').decode(bytes), before);
});

test('H.264 文件不受影响', () => {
  const bytes = new Uint8Array([...enc('....avc1'), ...new Array(20).fill(0), ...enc('avcC')]);
  assert.equal(patchHev1ToHvc1(bytes).patched, false);
});

test('detectCodec 从字节里嗅编码', () => {
  assert.equal(detectCodec(new Uint8Array(enc('xxxxhev1xxxxhvcC'))), 'hevc');
  assert.equal(detectCodec(new Uint8Array(enc('xxxxavc1xxxxavcC'))), 'h264');
  assert.equal(detectCodec(new Uint8Array(enc('xxxxav01xxxxav1C'))), 'av1');
  assert.equal(detectCodec(new Uint8Array(enc('nothing here'))), undefined);
});
