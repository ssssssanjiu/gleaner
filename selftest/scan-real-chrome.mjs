/**
 * 扫描器真机验证：在真 Chrome 里跑 src/core/scanner.ts 的 scanPage。
 *
 * 为什么要真机：卡片上的分辨率、srcset 选哪一档、naturalWidth 按密度折算、<picture> 选哪个格式，
 * 这些都是浏览器自己决定的，linkedom 模拟不出来（单元测试在 tests/scanner.test.ts）。
 *
 * 做法：本地起一个 HTTPS 服务，按 URL 里的尺寸现场生成对应大小的 PNG；
 * 用 --host-resolver-rules 把所有域名指到本机（img.alicdn.com、res.cloudinary.com 等都是真实主机名，
 * 站点规则按主机名匹配，所以不能换成 localhost）；每个场景一个页面，注入打包好的 scanPage 跑一遍。
 * 不装扩展、不碰 .output 目录和开发浏览器；临时 profile 跑完删除。
 *
 * 运行：node selftest/scan-real-chrome.mjs
 *       OG_SCANNER=/path/to/scanner.ts node selftest/scan-real-chrome.mjs   （对比别的版本，比如改动前的备份）
 */
import { createRequire } from 'node:module';
import https from 'node:https';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const require = createRequire(join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const { build } = require('esbuild');

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SCANNER = resolve(process.env.OG_SCANNER || join(ROOT, 'src/core/scanner.ts'));
const work = mkdtempSync(join(process.env.OG_PROBE_TMP || tmpdir(), 'og-scanprobe-'));

// ---------- 打包 scanPage ----------
const bundle = (
  await build({
    stdin: {
      contents: `import { scanPage } from ${JSON.stringify(SCANNER)}; window.__scan = scanPage;`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    write: false,
    target: 'es2022',
  })
).outputFiles[0].text;

// ---------- 按尺寸现场生成 PNG ----------
function png(w, h) {
  const row = Buffer.alloc(1 + w * 3, 0x80);
  row[0] = 0;
  const idat = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** URL → 这张图的真实像素尺寸（服务器照此生成） */
function sizeFor(url) {
  const named = { lazy400: [400, 300], bg600: [600, 600], a300: [300, 300], big800: [800, 800], hero: [1600, 900],
    icon: [16, 16], weserv: [690, 600], mmbiz: [640, 360], 'dpr-a1x': [400, 300], 'dpr-a2x': [800, 600] };
  for (const [k, v] of Object.entries(named)) if (url.includes(k)) return v;
  const m = url.match(/(\d{2,4})x(\d{2,4})/);
  if (m) return [Number(m[1]), Number(m[2])];
  const w = url.match(/w_(\d+)/);
  if (w) return [Number(w[1]), Math.round((Number(w[1]) * 2) / 3)];
  return [320, 240];
}

// ---------- 场景 ----------
// 地址里不带端口（站点规则只认主机名，但旧实现是对整条 URL 跑正则，带端口会让对比失真）；
// --host-resolver-rules 把所有主机的 443 都转到本机服务的端口
let P = 0;
const H = (host, path) => `https://${host}${path}`;
const SCENARIOS = [
  {
    name: 'image-scan#2 淘宝 60px 缩略图条（能升级成原图，不能被过滤）',
    html: () =>
      `<img src="${H('img.alicdn.com', '/imgextra/i1/2201/O1CN01AAA.jpg_460x460q90.jpg')}">` +
      ['AAA', 'BBB', 'CCC', 'DDD'].map((h) => `<img src="${H('img.alicdn.com', `/imgextra/i1/2201/O1CN01${h}.jpg_60x60q90.jpg`)}">`).join(''),
    check: (items) => [items.length === 4, `${items.length} 张（应为 4 张不同的商品主图）`],
  },
  {
    name: 'image-scan#3 规则升级项不报缩略图尺寸（Pinterest 236x）',
    html: () => `<img src="${H('i.pinimg.com', '/236x354/f2/26/a8/f226.jpg')}">`,
    check: (items) => [
      items.length === 1 && items[0].url.includes('/originals/') && items[0].width === 0 && items[0].height === 0,
      items.map((i) => `${i.width}×${i.height} ${i.url}`).join(' | '),
    ],
  },
  {
    name: 'image-scan#3+#4 WordPress srcset：一张卡片、下最大档、尺寸是最大档的',
    html: () => {
      const u = (s) => H('blog.example.com', `/wp-content/uploads/cat-${s}.jpg`);
      return `<img src="${u('800x533')}" sizes="800px" srcset="${u('400x267')} 400w, ${u('800x533')} 800w, ${u('1600x1066')} 1600w">`;
    },
    check: (items) => [
      items.length === 1 && items[0].url.endsWith('cat-1600x1066.jpg') && items[0].width === 1600 && items[0].height === 1066,
      items.map((i) => `${i.width}×${i.height} ${i.url.split('/').pop()}`).join(' | '),
    ],
  },
  {
    name: 'image-scan#4 <picture> 多格式：一张卡片（jxl 浏览器不支持，不当候选）',
    html: () =>
      `<picture><source type="image/jxl" srcset="${H('cdn.example.com', '/hero.jxl')}">` +
      `<source type="image/webp" srcset="${H('cdn.example.com', '/hero.webp')}">` +
      `<img src="${H('cdn.example.com', '/hero.jpg')}"></picture>`,
    check: (items) => [
      items.length === 1 && items[0].url.endsWith('/hero.webp') && items[0].width === 1600 && items[0].height === 900,
      items.map((i) => `${i.width}×${i.height} ${i.url.split('/').pop()}`).join(' | '),
    ],
  },
  {
    name: 'image-scan#5 阿里云 OSS srcset（URL 里有逗号）：没有指向页面域名的假卡片',
    html: () => {
      const o = (w) => H('bkt.oss-cn-hangzhou.aliyuncs.com', `/p/a.jpg?x-oss-process=image/resize,w_${w}`);
      return `<img src="${o(400)}" sizes="400px" srcset="${o(400)} 400w, ${o(800)} 800w">`;
    },
    check: (items) => [
      items.length === 1 && !items.some((i) => i.url.includes('shop.example.com')) && items[0].url.endsWith('/p/a.jpg'),
      items.map((i) => i.url).join(' | '),
    ],
  },
  {
    name: 'image-scan#5 Cloudinary srcset（w_400,c_fill）：下载 / 预览地址完整',
    html: () => {
      const c = (w) => H('res.cloudinary.com', `/demo/image/upload/w_${w},c_fill/sample.jpg`);
      return `<img src="${c(400)}" sizes="400px" srcset="${c(400)} 400w, ${c(1200)} 1200w">`;
    },
    check: (items) => [
      items.length === 1 && items[0].url.includes('w_1200,c_fill/sample.jpg') && items[0].previewUrl.includes('w_400,c_fill/sample.jpg') &&
        items[0].width === 1200,
      items.map((i) => `${i.width}×${i.height} ${i.url} (预览 ${i.previewUrl})`).join(' | '),
    ],
  },
  {
    name: 'image-scan#3 CSS 背景图：不报元素盒子尺寸',
    html: () => `<div style="width:300px;height:300px;background-image:url('${H('cdn.example.com', '/bg600.png')}')"></div>`,
    check: (items) => [
      items.length === 1 && items[0].width === 0 && items[0].height === 0,
      items.map((i) => `${i.width}×${i.height} ${i.url.split('/').pop()}`).join(' | '),
    ],
  },
  {
    name: '密度描述符（1x 屏）：没加载的 2x 图不冒充尺寸',
    html: () => `<img src="${H('cdn.example.com', '/a300.png')}" srcset="${H('cdn.example.com', '/a300.png')} 1x, ${H('cdn.example.com', '/big800.png')} 2x">`,
    check: (items) => [
      items.length === 1 && items[0].url.endsWith('/big800.png') && items[0].width === 0,
      items.map((i) => `${i.width}×${i.height} ${i.url.split('/').pop()}`).join(' | '),
    ],
  },
  {
    name: '密度描述符（2x 屏）：浏览器加载了 2x 图，naturalWidth 被折半，卡片要报文件真实像素',
    dpr: 2,
    html: () => `<img src="${H('cdn.example.com', '/dpr-a1x.png')}" srcset="${H('cdn.example.com', '/dpr-a1x.png')} 1x, ${H('cdn.example.com', '/dpr-a2x.png')} 2x">`,
    check: (items, raw) => [
      items.length === 1 && items[0].url.endsWith('/dpr-a2x.png') && items[0].width === 800 && items[0].height === 600,
      `${items.map((i) => `${i.width}×${i.height} ${i.url.split('/').pop()}`).join(' | ')}（浏览器 naturalWidth=${raw.nw}）`,
    ],
  },
  {
    name: 'image-scan#6 三张不同的 weserv 代理图：三张卡片',
    html: () =>
      ['001aaa', '002bbb', '003ccc'].map((h) => `<img src="${H('images.weserv.nl', `/?url=wx1.sinaimg.cn/mw690/${h}.jpg&k=weserv`)}">`).join(''),
    check: (items) => [items.length === 3, items.map((i) => i.url).join(' | ')],
  },
  {
    name: 'image-scan#9 公众号 wx_fmt=gif：扩展名 gif',
    html: () => `<img src="${H('mmbiz.qpic.cn', '/mmbiz_gif/abc/640?wx_fmt=gif&k=mmbiz')}">`,
    check: (items) => [items.length === 1 && items[0].ext === 'gif', items.map((i) => `${i.ext} ${i.url}`).join(' | ')],
  },
  {
    name: '回归：不能升级的 16px 图标照样被过滤，懒加载占位图的真图照样采集',
    html: () =>
      `<img src="${H('cdn.example.com', '/icon.png')}">` +
      `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="${H('cdn.example.com', '/lazy400.png')}">`,
    check: (items) => [
      items.length === 1 && items[0].url.endsWith('/lazy400.png'),
      items.map((i) => `${i.width}×${i.height} ${i.url.split('/').pop()}`).join(' | '),
    ],
  },
];

// ---------- HTTPS 服务 ----------
const key = join(work, 'key.pem');
const cert = join(work, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=og-selftest'], { stdio: 'ignore' });
const server = https.createServer({ key: readFileSync(key), cert: readFileSync(cert) }, (req, res) => {
  const url = decodeURIComponent(req.url || '');
  const m = url.match(/^\/__page\/(\d+)/);
  if (m) {
    const s = SCENARIOS[Number(m[1])];
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>${s.name}</title><body>${s.html()}</body>`);
  }
  if (url.includes('.jxl')) return res.writeHead(404).end();
  const [w, h] = sizeFor(url);
  res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
  res.end(png(w, h));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
P = server.address().port;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: join(work, 'profile'),
  pipe: true,
  acceptInsecureCerts: true,
  args: [
    '--no-first-run', '--window-position=2200,2200', '--window-size=1000,800',
    `--host-resolver-rules=MAP * 127.0.0.1:${P}`, '--ignore-certificate-errors',
  ],
});
let fails = 0;
try {
  console.log(`Chrome ${await browser.version()} · 扫描器：${SCANNER}\n`);
  for (let i = 0; i < SCENARIOS.length; i++) {
    const s = SCENARIOS[i];
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 800, deviceScaleFactor: s.dpr ?? 1 });
    await page.goto(H('shop.example.com', `/__page/${i}`), { waitUntil: 'load' });
    await page.addScriptTag({ content: bundle });
    const { items, nw } = await page.evaluate(async () => {
      const r = await window.__scan({ autoScroll: false, minSize: 200, includeBackground: true });
      return { items: r.items, nw: document.images[0]?.naturalWidth };
    });
    const [ok, detail] = s.check(items, { nw });
    if (!ok) fails++;
    console.log(`${ok ? '✓' : '✗'} ${s.name}\n    ${detail}`);
    await page.close();
  }
  console.log(`\n${SCENARIOS.length - fails}/${SCENARIOS.length} 通过`);
} finally {
  await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  browser.process()?.kill('SIGKILL');
  server.close();
  rmSync(work, { recursive: true, force: true });
}
process.exit(fails ? 1 : 0);
