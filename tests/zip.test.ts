/**
 * image-scan#9：ZIP 包里的扩展名。
 * 逐个下载时 Chrome 会按响应 MIME 纠正扩展名；ZIP 是 JSZip 自己命名，没有这层纠正，
 * 以前按 URL 猜、猜不到就 .jpg —— 公众号 wx_fmt=gif 的动图、无后缀 CDN 图在包里全变成 .jpg。
 */
import { strict as assert } from 'node:assert';
import { test, before, after } from 'node:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveObjectURL } from 'node:buffer';
import JSZip from 'jszip';
import { buildZipBlobUrl } from '../src/core/zip';
import type { MediaItem } from '../src/core/types';

const GIF = Buffer.from('474946383961010001000000002c00000000010001000002024401003b', 'hex');
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(16)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x20, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(16)]);
const JPG = Buffer.concat([Buffer.from('ffd8ffe000104a464946', 'hex'), Buffer.alloc(16)]);

let server: http.Server;
let origin = '';

before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url ?? '';
    // 公众号动图：路径没有扩展名，格式在 wx_fmt 里，响应 image/gif
    if (u.startsWith('/mmbiz_gif/')) return res.writeHead(200, { 'content-type': 'image/gif' }).end(GIF);
    // 无后缀 CDN 图，响应头还是 octet-stream：只能看文件头
    if (u.startsWith('/cdn/png')) return res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(PNG);
    // URL 写着 .jpg，CDN 按 Accept 自动转成了 webp
    if (u.startsWith('/auto/photo.jpg')) return res.writeHead(200, { 'content-type': 'image/webp' }).end(WEBP);
    // 普通 jpg
    if (u.startsWith('/plain/a.jpg')) return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPG);
    // 防盗链站：200 但回的是一张「禁止盗链」网页
    if (u.startsWith('/hotlink/')) return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<html>禁止盗链</html>');
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const item = (url: string, ext: string): MediaItem => ({
  id: url, url, originalUrl: url, width: 0, height: 0, ext, source: 'img',
});

test('ZIP 包内扩展名按文件头 / content-type 定，不再一律 .jpg', async () => {
  const { blobUrl, done, failed } = await buildZipBlobUrl([
    // ext 是扫描时按 URL 猜的（旧逻辑对这几张都会猜成 jpg）
    item(`${origin}/mmbiz_gif/abc/640?wx_fmt=gif`, 'jpg'),
    item(`${origin}/cdn/png/abc`, 'jpg'),
    item(`${origin}/auto/photo.jpg`, 'jpg'),
    item(`${origin}/plain/a.jpg`, 'jpg'),
  ]);
  assert.equal(done, 4);
  assert.equal(failed, 0);
  const blob = resolveObjectURL(blobUrl)!;
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(zip.files).sort(), ['001_640.gif', '002_abc.png', '003_photo.webp', '004_a.jpg']);
});

test('ZIP：200 但回的是网页（防盗链页 / 登录页）算失败，不塞进包里冒充图片', async () => {
  const { blobUrl, done, failed } = await buildZipBlobUrl([
    item(`${origin}/plain/a.jpg`, 'jpg'),
    item(`${origin}/hotlink/b.jpg`, 'jpg'),
  ]);
  assert.equal(done, 1);
  assert.equal(failed, 1, '网页响应应计为失败');
  const blob = resolveObjectURL(blobUrl)!;
  const zip = await JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
  assert.deepEqual(Object.keys(zip.files), ['001_a.jpg']);
});
