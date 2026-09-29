/**
 * 从图片文件开头的字节里读出宽高，不需要下载整张图。
 *
 * 为什么要有：规则升级过的原图（淘宝 / 京东 / 微博 / B站 封面……）、懒加载图，
 * 扫描时只知道缩略图多大，原图多大要真去问服务器。卡片要标「图片 + 分辨率」，
 * 只拉文件头（Range: bytes=0-…）就够了：PNG/GIF/WebP/BMP 在前 30 字节，
 * JPEG 的 SOF 段一般在前几十 KB（前面可能有很大的 EXIF / 缩略图），AVIF 在 meta 盒子里。
 */

export interface ImageSize {
  width: number;
  height: number;
}

const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

const ok = (width: number, height: number): ImageSize | null =>
  width > 0 && height > 0 && width < 100000 && height < 100000 ? { width, height } : null;

function png(b: Uint8Array): ImageSize | null {
  // 签名 8 字节 + IHDR 长度 4 + 'IHDR' 4 + 宽 4 + 高 4
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return ok(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10) return null;
  return ok(u16le(b, 6), u16le(b, 8));
}

function bmp(b: Uint8Array): ImageSize | null {
  if (b.length < 26) return null;
  return ok(i32le(b, 18), Math.abs(i32le(b, 22)));
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  const kind = ascii(b, 12, 4);
  if (kind === 'VP8 ') {
    // 帧头：3 字节帧标签 + 起始码 9d 01 2a + 宽高各 14 位
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return ok(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (kind === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (kind === 'VP8X') return ok(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

function jpeg(b: Uint8Array): ImageSize | null {
  let o = 2;
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++;
      continue;
    }
    const marker = b[o + 1];
    if (marker === 0xff) {
      o++; // 填充字节
      continue;
    }
    // 没有长度字段的标记：RSTn、SOI、TEM
    if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
      o += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // 到了图像数据还没找到 SOF
    const len = u16be(b, o + 2);
    // SOF0..SOF15，排除 DHT(C4) / JPG(C8) / DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return ok(u16be(b, o + 7), u16be(b, o + 5));
    }
    o += 2 + len;
  }
  return null;
}

/** ISO BMFF（AVIF / HEIC）：在 meta → iprp → ipco 里找 ispe 盒子 */
function isobmff(b: Uint8Array): ImageSize | null {
  const find = (start: number, end: number, path: string[]): number => {
    let o = start;
    while (o + 8 <= end) {
      let size = u32be(b, o);
      const type = ascii(b, o + 4, 4);
      let header = 8;
      if (size === 1) {
        if (o + 16 > end) return -1;
        size = u32be(b, o + 12); // 64 位长度，文件头里不会超过 4GB
        header = 16;
      } else if (size === 0) size = end - o;
      if (size < header) return -1;
      if (type === path[0]) {
        if (path.length === 1) return o;
        // meta 是 full box：多 4 字节版本和标志
        const inner = o + header + (type === 'meta' ? 4 : 0);
        return find(inner, Math.min(o + size, end), path.slice(1));
      }
      o += size;
    }
    return -1;
  };
  const ipco = find(0, b.length, ['meta', 'iprp', 'ipco']);
  if (ipco < 0) return null;
  // ipco 里每个图像项一个 ispe。HEIC / 大 AVIF 常把整图切成 512×512 的格子（grid），
  // 第一个 ispe 往往是某个格子的 —— 取面积最大的那个才是整图（真 HEIC 样图实测）
  const end = Math.min(ipco + u32be(b, ipco), b.length);
  let best: ImageSize | null = null;
  for (let o = ipco + 8; o + 8 <= end; ) {
    const size = u32be(b, o);
    if (size < 8) break;
    // ispe：8 字节盒头 + 4 字节版本标志 + 宽 4 + 高 4
    if (ascii(b, o + 4, 4) === 'ispe' && o + 20 <= b.length) {
      const got = ok(u32be(b, o + 12), u32be(b, o + 16));
      if (got && (!best || got.width * got.height > best.width * best.height)) best = got;
    }
    o += size;
  }
  return best;
}

export function readImageSize(b: Uint8Array): ImageSize | null {
  if (b.length < 12) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return png(b);
  if (b[0] === 0xff && b[1] === 0xd8) return jpeg(b);
  if (ascii(b, 0, 3) === 'GIF') return gif(b);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return webp(b);
  if (b[0] === 0x42 && b[1] === 0x4d) return bmp(b);
  if (ascii(b, 4, 4) === 'ftyp') return isobmff(b);
  return null;
}
