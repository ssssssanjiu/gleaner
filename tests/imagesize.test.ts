/**
 * 文件头读宽高。样图是真文件：PNG/JPEG/GIF/BMP/HEIC 由 macOS sips 生成，
 * WebP 由真 Chrome 的 canvas 编码（VP8X 扩展格式），简单格式 VP8 / VP8L 从中提取重新封装。
 * 文件名里写着真实尺寸。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readImageSize } from '../src/core/imagesize';

const DIR = join(import.meta.dirname, 'fixtures', 'images');

test('真实样图：每种格式都从文件头读对宽高', () => {
  const files = readdirSync(DIR);
  assert.ok(files.length >= 10, files.join(','));
  for (const f of files) {
    const m = /(\d+)x(\d+)\.\w+$/.exec(f)!;
    const got = readImageSize(new Uint8Array(readFileSync(join(DIR, f))));
    assert.deepEqual(got, { width: Number(m[1]), height: Number(m[2]) }, f);
  }
});

test('只拿到文件开头一段就够：PNG/GIF/WebP/BMP 前 64 字节，普通 JPEG 前 64KB', () => {
  for (const f of ['p1601x1203.png', 'g1601x1203.gif', 'wvp8_1601x1203.webp', 'wvp8l_1601x1203.webp', 'walpha1601x1203.webp', 'b321x203.bmp']) {
    const head = new Uint8Array(readFileSync(join(DIR, f))).subarray(0, 64);
    assert.ok(readImageSize(head), f);
  }
  const jpg = new Uint8Array(readFileSync(join(DIR, 'j1601x1203.jpg'))).subarray(0, 65536);
  assert.deepEqual(readImageSize(jpg), { width: 1601, height: 1203 });
});

test('JPEG 前面有 70KB 的大 EXIF：前 64KB 读不到（返回 null 而不是乱报），读到 128KB 就有了', () => {
  const all = new Uint8Array(readFileSync(join(DIR, 'jbigexif1601x1203.jpg')));
  assert.equal(readImageSize(all.subarray(0, 65536)), null);
  assert.deepEqual(readImageSize(all.subarray(0, 131072)), { width: 1601, height: 1203 });
});

test('AVIF：meta → iprp → ipco → ispe 盒子里的宽高', () => {
  const box = (type: string, body: number[]) => {
    const len = 8 + body.length;
    return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...[...type].map((c) => c.charCodeAt(0)), ...body];
  };
  const u32 = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ispe = box('ispe', [0, 0, 0, 0, ...u32(3840), ...u32(2160)]);
  const bytes = new Uint8Array([
    ...box('ftyp', [...'avif'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0])),
    ...box('meta', [0, 0, 0, 0, ...box('hdlr', new Array(25).fill(0)), ...box('iprp', box('ipco', ispe))]),
  ]);
  assert.deepEqual(readImageSize(bytes), { width: 3840, height: 2160 });
});

test('不是图片 / 截断 / 垃圾：返回 null，不抛错', () => {
  assert.equal(readImageSize(new TextEncoder().encode('<html><body>403 Forbidden</body></html>')), null);
  assert.equal(readImageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(readImageSize(new Uint8Array(20).fill(0xff)), null);
  assert.equal(readImageSize(new Uint8Array(0)), null);
});
