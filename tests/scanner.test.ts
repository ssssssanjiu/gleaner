/**
 * 扫描器回归测试：在 linkedom 搭的页面上跑真实的 scanPage。
 *
 * linkedom 没有布局和图片解码，浏览器才有的属性用 data-* 标注后补上：
 *   data-natural="800x533"   → naturalWidth / naturalHeight（浏览器实际解码出的尺寸，已按密度折算）
 *   data-current="url"       → currentSrc（浏览器从 srcset / <picture> 里实际选中的那个）
 *   data-rendered="300x300"  → img.width / img.height（渲染尺寸）
 *   data-box="300x300"       → getBoundingClientRect（背景图所在元素的盒子）
 *   data-bg="url"            → getComputedStyle().backgroundImage
 * 真浏览器里的同一批场景见 selftest/scan-real-chrome.mjs。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { scanPage, parseSrcset, extOf } from '../src/core/scanner';
import type { MediaItem } from '../src/core/types';

const require = createRequire(import.meta.url);
// linkedom 是 wxt 的依赖，node_modules 里一定有
const { parseHTML } = require('linkedom') as { parseHTML: (html: string) => { document: any; window: any } };

const PAGE = 'https://shop.example.com/goods/1.html';
const size = (v: string | null) => (v ? v.split('x').map(Number) : [0, 0]);

async function scan(body: string, opts: Partial<{ minSize: number; includeBackground: boolean }> = {}) {
  const { document } = parseHTML(`<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`);
  const abs = (u: string | null) => (u ? new URL(u, PAGE).href : '');
  for (const img of document.querySelectorAll('img')) {
    const [nw, nh] = size(img.getAttribute('data-natural'));
    const [rw, rh] = img.hasAttribute('data-rendered') ? size(img.getAttribute('data-rendered')) : [nw, nh];
    const current = img.hasAttribute('data-current')
      ? abs(img.getAttribute('data-current'))
      : nw
        ? abs(img.getAttribute('src'))
        : '';
    Object.defineProperties(img, {
      naturalWidth: { value: nw },
      naturalHeight: { value: nh },
      width: { value: rw },
      height: { value: rh },
      currentSrc: { value: current },
      src: { value: abs(img.getAttribute('src')) },
      srcset: { value: img.getAttribute('srcset') ?? '' },
    });
  }
  for (const el of document.querySelectorAll('*')) {
    const [bw, bh] = size(el.getAttribute('data-box'));
    el.getBoundingClientRect = () => ({ width: bw, height: bh });
  }
  for (const a of document.querySelectorAll('a[href]')) {
    Object.defineProperty(a, 'href', { value: abs(a.getAttribute('href')) });
  }
  Object.defineProperty(document, 'images', { value: Array.from(document.querySelectorAll('img')) });
  const g = globalThis as any;
  g.document = document;
  g.location = new URL(PAGE);
  g.getComputedStyle = (el: any) => ({
    backgroundImage: el.getAttribute('data-bg') ? `url("${el.getAttribute('data-bg')}")` : 'none',
  });
  const r = await scanPage({ autoScroll: false, minSize: 200, includeBackground: false, ...opts });
  return r.items;
}

const urls = (items: MediaItem[]) => items.map((i) => i.url);

// ---------------- image-scan#2：按缩略图尺寸过滤掉了能升级成原图的商品图 ----------------

test('淘宝：60px 缩略图条能升级成原图，不能被最小边长过滤掉', async () => {
  const thumbs = ['AAA', 'BBB', 'CCC', 'DDD']
    .map((h) => `<img src="https://img.alicdn.com/imgextra/i1/2201/O1CN01${h}.jpg_60x60q90.jpg" data-natural="60x60">`)
    .join('');
  const items = await scan(
    `<img src="https://img.alicdn.com/imgextra/i1/2201/O1CN01AAA.jpg_460x460q90.jpg" data-natural="460x460">${thumbs}`,
  );
  assert.deepEqual(
    urls(items).sort(),
    ['AAA', 'BBB', 'CCC', 'DDD'].map((h) => `https://img.alicdn.com/imgextra/i1/2201/O1CN01${h}.jpg`),
    '4 张不同的商品主图都应该出现（主图和第 1 张缩略图是同一张，合并）',
  );
  assert.ok(items.every((i) => i.ruleId === 'alicdn'));
});

test('京东：s54x54 缩略图升级到 /n0/ 后不被过滤', async () => {
  const items = await scan(
    '<img src="https://img14.360buyimg.com/n1/s450x450_jfs/t1/aaa.jpg" data-natural="450x450">' +
      '<img src="https://img14.360buyimg.com/n5/s54x54_jfs/t1/bbb.jpg" data-natural="54x54">' +
      '<img src="https://img14.360buyimg.com/n5/s54x54_jfs/t1/ccc.jpg" data-natural="54x54">',
  );
  assert.equal(items.length, 3, urls(items).join('\n'));
});

test('B站 评论区头像（@48w 能升级）照样按页面尺寸过滤：不能几十个头像全列出来还默认全选', async () => {
  const avatars = Array.from({ length: 30 }, (_, i) =>
    `<img src="https://i0.hdslb.com/bfs/face/avatar${i}.jpg@48w_48h_1c_1s.webp" data-natural="48x48">`).join('');
  const items = await scan(
    `<img src="https://i0.hdslb.com/bfs/archive/cover.jpg@672w_378h_1c.webp" data-natural="672x378">${avatars}`,
  );
  assert.deepEqual(urls(items), ['https://i0.hdslb.com/bfs/archive/cover.jpg'], urls(items).join('\n'));
});

test('不能升级的小图标照样按最小边长过滤', async () => {
  const items = await scan(
    '<img src="https://cdn.example.com/icon.png" data-natural="16x16">' +
      '<img src="https://cdn.example.com/photo.jpg" data-natural="800x600">',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/photo.jpg']);
});

// ---------------- image-scan#3：卡片分辨率必须是下载文件的分辨率 ----------------

test('规则升级过的图：不报缩略图尺寸（未知 = 0，弹窗显示扩展名）', async () => {
  const items = await scan(
    '<img src="https://i.pinimg.com/236x/f2/26/a8/f226a8bab0f364179cdb82e5fa9bb66f.jpg" data-natural="236x354">',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://i.pinimg.com/originals/f2/26/a8/f226a8bab0f364179cdb82e5fa9bb66f.jpg');
  assert.equal(items[0].width, 0, `报了缩略图宽度 ${items[0].width}`);
  assert.equal(items[0].height, 0);
  assert.equal(items[0].originalUrl, 'https://i.pinimg.com/236x/f2/26/a8/f226a8bab0f364179cdb82e5fa9bb66f.jpg');
});

test('CSS 背景图：不报元素盒子尺寸', async () => {
  const items = await scan('<div data-box="300x300" data-bg="https://cdn.example.com/bg600.jpg"></div>', {
    includeBackground: true,
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].width, 0, `报了盒子宽度 ${items[0].width}`);
  assert.equal(items[0].height, 0);
});

test('密度描述符：没加载过的 2x 图不冒充尺寸，但也不被过滤', async () => {
  const items = await scan(
    '<img src="https://cdn.example.com/a300.jpg" srcset="https://cdn.example.com/a300.jpg 1x, https://cdn.example.com/big800.jpg 2x" data-natural="300x300">',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/big800.jpg']);
  assert.equal(items[0].width, 0);
  assert.equal(items[0].height, 0);
});

test('密度描述符：浏览器加载的就是 2x 图时，naturalWidth 乘回倍率才是文件尺寸', async () => {
  const items = await scan(
    '<img src="https://cdn.example.com/a.jpg" srcset="https://cdn.example.com/a.jpg 1x, https://cdn.example.com/a@2x.jpg 2x" data-current="https://cdn.example.com/a@2x.jpg" data-natural="400x300">',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/a@2x.jpg']);
  assert.deepEqual([items[0].width, items[0].height], [800, 600]);
});

// ---------------- image-scan#4：srcset / <picture> 一张图只出一张卡片 ----------------

test('WordPress srcset：只出一张卡片，下最大档，尺寸是最大档的', async () => {
  const items = await scan(
    '<img src="https://blog.example.com/wp-content/uploads/cat-800x533.jpg" ' +
      'srcset="https://blog.example.com/wp-content/uploads/cat-400x267.jpg 400w, https://blog.example.com/wp-content/uploads/cat-800x533.jpg 800w, https://blog.example.com/wp-content/uploads/cat-1600x1066.jpg 1600w" ' +
      'data-natural="800x533" data-current="https://blog.example.com/wp-content/uploads/cat-800x533.jpg">',
  );
  assert.equal(items.length, 1, urls(items).join('\n'));
  const it = items[0];
  assert.equal(it.url, 'https://blog.example.com/wp-content/uploads/cat-1600x1066.jpg');
  assert.deepEqual([it.width, it.height], [1600, 1066]);
  assert.equal(it.originalUrl, 'https://blog.example.com/wp-content/uploads/cat-800x533.jpg', '退路是页面上实际显示的那张');
  assert.equal(it.previewUrl, 'https://blog.example.com/wp-content/uploads/cat-400x267.jpg');
});

test('<picture> 三种格式：只出一张卡片，取浏览器实际用的格式', async () => {
  const items = await scan(
    '<picture><source type="image/avif" srcset="https://cdn.example.com/hero.avif">' +
      '<source type="image/webp" srcset="https://cdn.example.com/hero.webp">' +
      '<img src="https://cdn.example.com/hero.jpg" data-natural="1600x900" data-current="https://cdn.example.com/hero.avif"></picture>',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/hero.avif']);
  assert.deepEqual([items[0].width, items[0].height], [1600, 900]);
});

test('<picture> 带宽度描述符：跨格式取最大宽度，同尺寸时取浏览器在用的格式', async () => {
  const items = await scan(
    '<picture><source type="image/webp" srcset="https://cdn.example.com/p-800.webp 800w, https://cdn.example.com/p-1600.webp 1600w">' +
      '<img src="https://cdn.example.com/p-800.jpg" srcset="https://cdn.example.com/p-800.jpg 800w, https://cdn.example.com/p-1600.jpg 1600w" ' +
      'data-natural="800x450" data-current="https://cdn.example.com/p-800.webp"></picture>',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/p-1600.webp']);
  assert.deepEqual([items[0].width, items[0].height], [1600, 900]);
});

test('<picture> 里浏览器解不了的格式（jxl）不当候选', async () => {
  const items = await scan(
    '<picture><source type="image/jxl" srcset="https://cdn.example.com/p.jxl 3000w">' +
      '<img src="https://cdn.example.com/p.jpg" srcset="https://cdn.example.com/p.jpg 1200w" data-natural="1200x800"></picture>',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/p.jpg']);
});

test('懒加载完成后 data-src 与 src 相同：不重复出卡片', async () => {
  const items = await scan(
    '<img src="https://cdn.example.com/a-800.jpg" data-src="https://cdn.example.com/a-800.jpg" ' +
      'srcset="https://cdn.example.com/a-800.jpg 800w, https://cdn.example.com/a-1600.jpg 1600w" data-natural="800x600">',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/a-1600.jpg']);
});

test('懒加载占位图：真图在 data-src，照常采集（尺寸未知保留）', async () => {
  const items = await scan(
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://cdn.example.com/lazy400.jpg" data-natural="1x1">',
  );
  assert.deepEqual(urls(items), ['https://cdn.example.com/lazy400.jpg']);
  assert.equal(items[0].width, 0);
});

// ---------------- image-scan#5：srcset 里 URL 自带逗号 ----------------

test('阿里云 OSS srcset（URL 里有 resize,w_800）：不产生指向页面域名的假卡片', async () => {
  const oss = 'https://bkt.oss-cn-hangzhou.aliyuncs.com/p/a.jpg?x-oss-process=image/resize,';
  const items = await scan(
    `<img src="${oss}w_400" srcset="${oss}w_400 400w, ${oss}w_800 800w" data-natural="400x400">`,
  );
  assert.ok(!urls(items).some((u) => u.startsWith('https://shop.example.com/')), urls(items).join('\n'));
  assert.deepEqual(urls(items), ['https://bkt.oss-cn-hangzhou.aliyuncs.com/p/a.jpg']);
});

test('Cloudinary srcset（w_400,c_fill）：下载地址和预览地址都完整', async () => {
  const c = 'https://res.cloudinary.com/demo/image/upload';
  const items = await scan(
    `<img src="${c}/w_400,c_fill/sample.jpg" srcset="${c}/w_400,c_fill/sample.jpg 400w, ${c}/w_1200,c_fill/sample.jpg 1200w" data-natural="400x267">`,
  );
  assert.deepEqual(urls(items), [`${c}/w_1200,c_fill/sample.jpg`]);
  assert.equal(items[0].previewUrl, `${c}/w_400,c_fill/sample.jpg`);
  assert.equal(items[0].width, 1200);
});

test('parseSrcset 按 HTML 规范：URL 读到空白为止，URL 里的逗号保留', () => {
  assert.deepEqual(parseSrcset('a.jpg?x=resize,w_400 400w, a.jpg?x=resize,w_800 800w'), [
    { url: 'a.jpg?x=resize,w_400', w: 400 },
    { url: 'a.jpg?x=resize,w_800', w: 800 },
  ]);
  assert.deepEqual(parseSrcset('a.jpg, b.jpg 2x'), [{ url: 'a.jpg' }, { url: 'b.jpg', x: 2 }]);
  assert.deepEqual(parseSrcset('a.jpg 1x,b.jpg 2x'), [{ url: 'a.jpg', x: 1 }, { url: 'b.jpg', x: 2 }]);
  assert.deepEqual(parseSrcset('  \n a.jpg   1.5x  ,  '), [{ url: 'a.jpg', x: 1.5 }]);
  // 同一个候选既有 w 又有 x：非法，丢掉
  assert.deepEqual(parseSrcset('bad.jpg 100w 2x, ok.jpg 200w'), [{ url: 'ok.jpg', w: 200 }]);
});

// ---------------- image-scan#6（扫描层面）：代理地址不被合并 ----------------

test('三张不同的 weserv 代理图：三张卡片，不被当成微博图合并', async () => {
  const items = await scan(
    ['001aaa', '002bbb', '003ccc']
      .map((h) => `<img src="https://images.weserv.nl/?url=wx1.sinaimg.cn/mw690/${h}.jpg" data-natural="690x600">`)
      .join(''),
  );
  assert.equal(items.length, 3, urls(items).join('\n'));
});

// ---------------- image-scan#9：扩展名 ----------------

test('公众号 wx_fmt=gif / png 的图扩展名不是 jpg', async () => {
  const items = await scan(
    '<img src="https://mmbiz.qpic.cn/mmbiz_gif/abc/640?wx_fmt=gif&tp=webp" data-natural="640x360">' +
      '<img src="https://mmbiz.qpic.cn/mmbiz_png/def/640?wx_fmt=png" data-natural="640x360">',
  );
  assert.deepEqual(items.map((i) => i.ext).sort(), ['gif', 'png']);
});

test('extOf：路径扩展名 > 查询参数格式提示 > 默认 jpg', () => {
  assert.equal(extOf('https://mmbiz.qpic.cn/mmbiz_jpg/a/640?wx_fmt=jpeg'), 'jpg');
  assert.equal(extOf('https://demo.imgix.net/a?fm=webp'), 'webp');
  assert.equal(extOf('https://pbs.twimg.com/media/X?format=png&name=large'), 'png');
  assert.equal(extOf('https://b.oss-cn-hangzhou.aliyuncs.com/a?x-oss-process=image/resize,w_300/format,webp'), 'webp');
  assert.equal(extOf('https://cdn.example.com/a?imageView2/2/w/300/format/avif'), 'avif');
  assert.equal(extOf('https://img.alicdn.com/a.png'), 'png');
  assert.equal(extOf('https://photo.example.com/show.php?id=1'), 'jpg', '.php 不是图片扩展名');
  assert.equal(extOf('https://cdn.example.com/abc'), 'jpg');
});

test('公众号：规则只去压缩参数、不改分辨率 —— 尺寸照报，20px 的装饰小图照样按最小边长过滤', async () => {
  const items = await scan(
    '<img src="https://mmbiz.qpic.cn/mmbiz_png/deco/640?wx_fmt=png&tp=webp&wxfrom=5" data-natural="20x20">' +
      '<img src="https://mmbiz.qpic.cn/mmbiz_jpg/photo/640?wx_fmt=jpeg&tp=webp&wxfrom=5" data-natural="640x427">',
  );
  assert.deepEqual(urls(items), ['https://mmbiz.qpic.cn/mmbiz_jpg/photo/640?wx_fmt=jpeg']);
  assert.deepEqual([items[0].width, items[0].height], [640, 427]);
});
