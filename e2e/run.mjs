/**
 * 真浏览器端到端测试：用 puppeteer 驱动真 Chrome 加载生产构建的扩展，
 * 走完「扫描 → 下载落盘 → 暂停/继续 → 取消 → 弹窗重开恢复 → 下载记录」全流程。
 * 文件真实写入磁盘并逐一核对。
 *
 * 运行：npm run e2e
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtempSync, readdirSync, existsSync, rmSync, mkdirSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT_DIR = resolve(import.meta.dirname, '../.output-e2e/chrome-mv3');

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, ok, detail]);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000, tag = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`waitFor 超时: ${tag}`);
    await sleep(120);
  }
}

// ---------- 图片服务器：普通图 + 可控放行的「慢速图」 ----------
const SVG = (n) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="teal"/><text x="20" y="150">${n}</text></svg>`;
// 真实 B站 轨道（供 ffmpeg 合并用；缺失则跳过 mux 相关场景）
// DASH 画面轨 / 声音轨（fMP4，和 B站 的 .m4s 同构），ffmpeg 合并场景要用真字节。
// 默认用仓库里 ffmpeg 生成的版权干净样本（彩条画面 + 440Hz 正弦音）；
// 想用真实 B站 分轨：OG_TRACK_BASE=<路径前缀>（需要 <前缀>_视频.mp4 和 <前缀>_音频.mp4）
const TRACK_BASE = process.env.OG_TRACK_BASE ?? resolve(import.meta.dirname, '../tests/fixtures/media/synthetic');
const HAS_TRACKS = existsSync(TRACK_BASE + '_视频.mp4');
const REALV = HAS_TRACKS ? readFileSync(TRACK_BASE + '_视频.mp4') : Buffer.alloc(120000, 3);
const REALA = HAS_TRACKS ? readFileSync(TRACK_BASE + '_音频.mp4') : Buffer.alloc(60000, 4);
/** 慢速单轨下载用：样本轨重复几遍凑到 3MB 以上（不参与合并，只看进度） */
const SLOW_BODY = Buffer.concat(Array.from({ length: Math.max(1, Math.ceil(3.5e6 / REALV.length)) }, () => REALV));
const isAudioTrackUrl = (u) => /-(30232|30280)\b/.test(u) || /audio/i.test(u);
const trackBytes = (u) => (isAudioTrackUrl(u) ? REALA : REALV);

// ---------- 纯色 PNG（AI 助手的颜色筛选要真像素；SVG 在 SW 里解不了码） ----------
function crc32(buf) {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = r;
      raw[o + 2 + x * 3] = g;
      raw[o + 3 + x * 3] = b;
    }
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type, 'latin1');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
const PNG_GREEN = png(300, 300, [30, 170, 60]);
const PNG_RED = png(300, 300, [210, 30, 30]);
const PNG_BLUE = png(300, 200, [40, 80, 200]);
/** 假 Anthropic API 收到的请求 */
const aiRequests = [];

const held = []; // 挂起的响应，等 /release
/** B站 仿真 CDN 收到的请求路径 */
const biliReqs = [];
/** 淘宝仿真 CDN：原图请求的 [Range, Referer] */
const tbReqs = [];
const TB_ORIGINAL = readFileSync(resolve(import.meta.dirname, '../tests/fixtures/images/j1601x1203.jpg'));
/** 慢速可续传 CDN 的请求记录：[path, Range 头]，以及被客户端中止的连接数 */
const slowReqs = [];
let slowAborted = 0;
const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  if (url === '/v1/messages') {
    // 假 Anthropic API：记录请求形态，固定回一个工具调用（选 #1）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' });
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      aiRequests.push({ headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify({
        id: 'msg_e2e', type: 'message', role: 'assistant', model: body.model,
        content: [{
          type: 'tool_use', id: 'tu_1', name: 'select_media',
          input: { page_type: 'article', selected: ['#1'], explanation: 'e2e 假模型：选第 1 项', clarify: '' },
        }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 321, output_tokens: 42 },
      }));
    });
  } else if (url.startsWith('/png/')) {
    const body = url.includes('green') ? PNG_GREEN : url.includes('blue') ? PNG_BLUE : PNG_RED;
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
    res.end(body);
  } else if (url === '/aipage') {
    // 带分区结构的页面：页头 logo、正文 3 图 1 视频、评论区 1 图 1 视频、页脚 1 图
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>AI 测试页</title>
      <meta property="og:type" content="article"></head><body>
      <header class="site-header"><img src="/png/red-logo.png" width="300" height="300" alt="logo"></header>
      <main class="main-content"><h1>正文标题</h1>
        <img src="/png/green-1.png" width="300" height="300" alt="草地">
        <img src="/png/green-2.png" width="300" height="300" alt="森林">
        <img src="/png/blue-1.png" width="300" height="200" alt="天空">
        <video src="/vid/main.mp4" preload="auto" width="640" height="360"></video>
      </main>
      <section id="comments" class="comment-list"><h2>评论</h2>
        <img src="/png/green-3.png" width="300" height="300" alt="评论配图">
        <video src="/vid/reply.mp4" preload="auto" width="320" height="180"></video>
      </section>
      <footer><img src="/png/red-foot.png" width="300" height="300" alt="页脚"></footer>
    </body></html>`);
  } else if (url === '/release') {
    held.splice(0).forEach((fn) => fn());
    res.end('released');
  } else if (url.startsWith('/held/')) {
    // 先发一半 body，剩下的等放行 —— 下载保持 in_progress，暂停/取消可稳定复现
    const body = SVG(url).repeat(200);
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(body.length) });
    res.write(body.slice(0, 100));
    held.push(() => res.end(body.slice(100)));
  } else if (url.startsWith('/vid/')) {
    // 伪 mp4：内容不重要，content-type 对就会被嗅探到
    const fake = Buffer.alloc(300000, 7);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(fake.length) });
    res.end(fake);
  } else if (url.startsWith('/cors/')) {
    // 复现 B站 CDN：只给 Access-Control-Allow-Origin: *（不允许带凭证）
    const body = trackBytes(url);
    res.writeHead(200, {
      'content-type': 'video/mp4',
      'content-length': String(body.length),
      'access-control-allow-origin': '*',
    });
    res.end(body);
  } else if (url.startsWith('/slow/')) {
    // 分块慢速返回，模拟长视频整包抓取（验证并发不被堵 + 进度会动）
    const full = SLOW_BODY; // 要够大（>3MB），整包抓取才会多次报百分比进度
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(full.length) });
    const step = Math.ceil(full.length / 6);
    let off = 0;
    const tick = () => {
      if (off >= full.length) return res.end();
      res.write(full.subarray(off, off + step));
      off += step;
      setTimeout(tick, 200);
    };
    tick();
  } else if (url.startsWith('/refcheck/')) {
    // 复现 B站 CDN 防盗链：必须带 Referer 指向站点，否则 403
    const ref = req.headers.referer ?? '';
    console.log(`  [refcheck] Referer = ${ref || '(无)'}`);
    if (!ref.includes('127.0.0.1')) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html>403 no referer</html>');
      return;
    }
    const body = trackBytes(url);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
    res.end(body);
  } else if (url.startsWith('/signed/')) {
    // 复现 B站 CDN：没有鉴权签名就返回 HTML 错误页（Chrome 会存成 .html）
    if (!url.includes('upsig=')) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body>403 Forbidden</body></html>');
      return;
    }
    const body = trackBytes(url);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
    res.end(body);
  } else if (url.startsWith('/log/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  } else if (url.startsWith('/cdn2/dash/') || url.startsWith('/dash/')) {
    // 发真实 fMP4 轨道，ffmpeg 才能真的合并
    const body = trackBytes(url);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
    res.end(body);
  } else if (url === '/dpage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>DASH 页</title><body><script>
      (async () => {
        for (let i = 0; i < 5; i++) {
          await fetch('/dash/41472951104-1-100113.m4s?range=' + i);
          await fetch('/dash/41472951104-1-30232.m4s?range=' + i);
        }
      })();
    </script>`);
  } else if (url === '/msepage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>MSE 页</title><body>
      <video id="v"></video>
      <script>
        // 播放器把 blob: 挂到 video 上，真实分片走 fetch —— 和 B站 同构
        const v = document.getElementById('v');
        v.src = URL.createObjectURL(new Blob([new Uint8Array(10)]));
        (async () => {
          for (let i = 0; i < 4; i++) {
            // 同一文件从两个「CDN」拉 —— 复现用户截图里的重复行
            await fetch('/dash/mse-1-30080.m4s?range=' + i);
            await fetch('/cdn2/dash/mse-1-30080.m4s?range=' + i);
            await fetch('/dash/mse-1-30280.m4s?range=' + i);
          }
          // 埋点接口 —— 复现被误列成「视频轨」的 /web
          await fetch('/log/web');
          await fetch('/log/report.ts');
        })();
      </script>`);
  } else if (url === '/failfetchpage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>失败请求页</title><body><script>
      // 页面自己发起会失败的请求（切清晰度中止分片是常态），
      // 我们的钩子不能因此冒出 Uncaught (in promise)
      fetch('http://127.0.0.1:1/never.m4s').catch(() => {});
      const c = new AbortController();
      fetch('/slow/abort-1-30080.m4s', { signal: c.signal }).catch(() => {});
      setTimeout(() => c.abort(), 50);
    </script>`);
  } else if (url === '/corspage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>CORS 页</title><body><script>
      (async () => {
        for (let i = 0; i < 2; i++) {
          const cdn = 'http://localhost:${server.address().port}';
          await fetch(cdn + '/cors/c-1-30080.m4s?range=' + i);
          await fetch(cdn + '/cors/c-1-30280.m4s?range=' + i);
        }
      })();
    </script>`);
  } else if (url === '/slowpage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>慢速流页</title><body><script>
      (async () => {
        for (let i = 0; i < 3; i++) {
          await fetch('/slow/slow-1-30080.m4s?upsig=x&range=' + i);
        }
      })();
    </script>`);
  } else if (url === '/refpage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>防盗链页</title><body><script>
      (async () => {
        for (let i = 0; i < 3; i++) {
          await fetch('/refcheck/ref-1-100113.m4s?upsig=x&range=' + i);
        }
      })();
    </script>`);
  } else if (url === '/signedpage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>签名流页</title><body><script>
      (async () => {
        for (let i = 0; i < 3; i++) {
          await fetch('/signed/77788899-1-100113.m4s?upsig=abc123&deadline=999&range=' + i);
          await fetch('/signed/77788899-1-30232.m4s?upsig=abc123&deadline=999&range=' + i);
        }
      })();
    </script>`);
  } else if (url.startsWith('/bili/')) {
    // B站 仿真 CDN：记录被请求的轨道，核对扩展下的是 H.264 而不是播放器在放的 AV1
    biliReqs.push(url);
    const body = trackBytes(url);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
    res.end(body);
  } else if (url.startsWith('/bslow/')) {
    // 慢速、支持断点续传的 CDN：无 Range 的请求先发 64KB 然后挂住（模拟大视频下到一半）；
    // 带 Range 的立刻回 206 + 剩余字节
    const body = trackBytes(url);
    const range = req.headers.range;
    slowReqs.push([url.split('?')[0], range ?? 'none']);
    const m = /bytes=(\d+)-/.exec(range ?? '');
    if (m) {
      const start = Number(m[1]);
      res.writeHead(206, {
        'content-type': 'video/mp4', 'content-length': String(body.length - start),
        'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
      });
      res.end(body.subarray(start));
    } else if (/30280/.test(url)) {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
      res.end(body);
    } else {
      res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
      res.write(body.subarray(0, 65536));
      req.on('close', () => { if (!res.writableEnded) slowAborted++; });
      held.push(() => {}); // 不放行：只能靠扩展暂停时中止
    }
  } else if (url.startsWith('/imgextra/') && /_\d+x\d+q\d+\.jpg$/.test(url.split('?')[0])) {
    // 淘宝缩略图（60×60）
    const body = PNG_GREEN;
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(body.length) });
    res.end(body);
  } else if (url.startsWith('/imgextra/')) {
    // 淘宝原图：防盗链（不带 taobao 的 Referer 就 403），支持 Range
    tbReqs.push([req.headers.range ?? 'none', req.headers.referer ?? '(无)']);
    if (!(req.headers.referer ?? '').includes('taobao.com')) {
      res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html>403</html>');
      return;
    }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? '');
    if (m) {
      const end = Math.min(Number(m[2]), TB_ORIGINAL.length - 1);
      res.writeHead(206, {
        'content-type': 'image/jpeg', 'content-length': String(end - Number(m[1]) + 1),
        'content-range': `bytes ${m[1]}-${end}/${TB_ORIGINAL.length}`,
      });
      res.end(TB_ORIGINAL.subarray(Number(m[1]), end + 1));
    } else {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(TB_ORIGINAL.length) });
      res.end(TB_ORIGINAL);
    }
  } else if (url === '/tbpage') {
    const cdn = `http://img.alicdn.com:${server.address().port}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>淘宝商品页</title><body>` +
      ['AAA', 'BBB', 'CCC'].map((h) => `<img src="${cdn}/imgextra/i1/O1CN01${h}.jpg_60x60q90.jpg" width="60" height="60">`).join(''));
  } else if (url.startsWith('/video/BVorphan')) {
    const host = `http://www.bilibili.com:${server.address().port}`;
    const t = (id, codecid, codecs, w, h, name, bw) => ({
      id, codecid, codecs, width: w, height: h, bandwidth: bw,
      baseUrl: `${host}/bslow/${name}?upsig=e2e`, backupUrl: [],
    });
    const playinfo = { code: 0, data: { dash: {
      video: [t(32, 7, 'avc1.64001F', 852, 480, 'orphan-1-30032.m4s', 632933)],
      audio: [t(30280, 0, 'mp4a.40.2', 0, 0, 'orphan-1-30280.m4s', 190000)],
    } } };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>后台被回收_哔哩哔哩_bilibili</title>
      <script>window.__playinfo__=${JSON.stringify(playinfo)}</script><body>`);
  } else if (url.startsWith('/video/BVslow')) {
    const host = `http://www.bilibili.com:${server.address().port}`;
    const t = (id, codecid, codecs, w, h, name, bw) => ({
      id, codecid, codecs, width: w, height: h, bandwidth: bw,
      baseUrl: `${host}/bslow/${name}?upsig=e2e`, backupUrl: [],
    });
    const playinfo = { code: 0, data: { dash: {
      video: [t(32, 7, 'avc1.64001F', 852, 480, 'slow-1-30032.m4s', 632933)],
      audio: [t(30280, 0, 'mp4a.40.2', 0, 0, 'slow-1-30280.m4s', 190000)],
    } } };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>慢速长视频_哔哩哔哩_bilibili</title>
      <script>window.__playinfo__=${JSON.stringify(playinfo)}</script><body>`);
  } else if (url.startsWith('/video/BVe2e')) {
    // B站 仿真视频页（经 --host-resolver-rules 以 www.bilibili.com 访问）：
    // 清单结构照搬真实 __playinfo__（480P/360P × H.264/HEVC/AV1），播放器按 Chrome 的偏好拉 AV1
    const host = `http://www.bilibili.com:${server.address().port}`;
    const t = (id, codecid, codecs, w, h, name, bw) => ({
      id, codecid, codecs, width: w, height: h, bandwidth: bw,
      baseUrl: `${host}/bili/${name}?upsig=e2e&deadline=9999999999`, backupUrl: [],
    });
    const playinfo = { code: 0, data: { quality: 32, dash: {
      video: [
        t(32, 7, 'avc1.64001F', 852, 480, 'e2e_nb2-1-30032.m4s', 632933),
        t(32, 12, 'hvc1.1.6.L120.90', 852, 480, 'e2e-1-30033.m4s', 302873),
        t(32, 13, 'av01.0.08M.08.0.110.01.01.01.0', 852, 480, 'e2e-1-100023.m4s', 271685),
        t(16, 7, 'avc1.64001E', 640, 360, 'e2e-1-30016.m4s', 391688),
      ],
      audio: [
        t(30216, 0, 'mp4a.40.2', 0, 0, 'e2e-1-30216.m4s', 67000),
        t(30280, 0, 'mp4a.40.2', 0, 0, 'e2e_nb2-1-30280.m4s', 190000),
      ],
      dolby: { type: 0, audio: null }, flac: null,
    } } };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>危险的黑子_哔哩哔哩_bilibili</title>
      <script>window.__playinfo__=${JSON.stringify(playinfo)}</script><body><script>
      (async () => {
        for (let i = 0; i < 3; i++) {
          await fetch('/bili/e2e-1-100023.m4s?upsig=e2e&deadline=9999999999&range=' + i);
          await fetch('/bili/e2e-1-30216.m4s?upsig=e2e&deadline=9999999999&range=' + i);
        }
      })();
    </script>`);
  } else if (url === '/vpage') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>视频页</title><body><video src="/vid/demo.mp4" preload="auto"></video>');
  } else if (url.startsWith('/img/')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml' });
    res.end(SVG(url));
  } else if (url === '/page' || url.startsWith('/page?')) {
    const held3 = url.includes('held')
      ? [1, 2, 3].map((i) => `<img src="/held/h${i}.svg" width="300" height="300">`).join('')
      : [1, 2, 3].map((i) => `<img src="/img/f${i}.svg" width="300" height="300">`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>E2E 测试页</title><body>${held3}</body>`);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const release = () => fetch(`${origin}/release`);

// ---------- 启动真 Chrome + 扩展 ----------
const downloadDir = mkdtempSync(join(tmpdir(), 'gleaner-e2e-'));
const profileDir = mkdtempSync(join(tmpdir(), 'gleaner-profile-'));
// 用 Chrome 偏好设定下载目录（CDP 的 setDownloadBehavior 会覆盖扩展指定的文件名，不能用）
mkdirSync(join(profileDir, 'Default'), { recursive: true });
writeFileSync(
  join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } }),
);
// Chrome 137+ 禁用了 --load-extension；正确姿势是 CDP 的 Extensions.loadUnpacked
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: profileDir,
  ignoreDefaultArgs: ['--disable-extensions'],
  pipe: true, // 实测比 websocket 更稳、启动更快（Chrome 更新期间 ws 曾整体超时）
  args: [
    '--no-first-run', '--enable-unsafe-extension-debugging', '--window-position=2200,2200', '--window-size=900,700',
    // B站 仿真场景：让 www.bilibili.com 解析到本地测试服务器（扩展只在 B站 域名收清单）
    '--host-resolver-rules=MAP www.bilibili.com 127.0.0.1,MAP img.alicdn.com 127.0.0.1',
  ],
});

try {
  const cdp = await browser.target().createCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  await waitFor(
    async () => browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId)),
    10000, 'service worker',
  );
  check('扩展在真 Chrome 中加载', Boolean(extId), extId);

  const openPopup = async () => {
    const p = await browser.newPage();
    await p.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
    return p;
  };
  const clickByText = (p, text) =>
    p.evaluate((t) => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(t));
      if (!b || b.disabled) return false;
      b.click();
      return true;
    }, text);
  const popupText = (p) => p.evaluate(() => document.body.innerText);
  const jobState = (p) =>
    p.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((r) => r?.progress?.state));
  const allDl = () =>
    readdirSync(join(downloadDir, 'Gleaner')).flatMap((d) =>
      readdirSync(join(downloadDir, 'Gleaner', d)).map((f) => ({ f, p: join(downloadDir, 'Gleaner', d, f) })));
  const hasAudioTrack = (path) => readFileSync(path).includes(Buffer.from('mp4a', 'latin1'));

  // ============ 场景 1：扫描 → 下载 → 文件落盘 ============
  const fixture = await browser.newPage();
  await release();
  await fixture.goto(`${origin}/page`, { waitUntil: 'load' });
  let popup = await openPopup();
  await fixture.bringToFront(); // 扫描要求测试页是活动标签
  await popup.reload({ waitUntil: 'domcontentloaded' }); // 重载让弹窗以测试页为活动标签初始化
  await sleep(300);

  check('点击扫描', await clickByText(popup, '扫描'));
  await waitFor(async () => (await popup.$$('.cell')).length >= 3, 8000, '扫描结果');
  const cells = (await popup.$$('.cell')).length;
  check('扫描出 3 张图', cells === 3, `实际 ${cells}`);

  check('点击下载', await clickByText(popup, '下载'));
  try {
    await waitFor(async () => (await jobState(popup)) === 'done', 8000, '下载完成');
  } catch (e) {
    const st = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch((x) => ({ err: String(x) })));
    console.log('  [诊断] GET_STATE:', JSON.stringify(st));
    console.log('  [诊断] 弹窗文本:', (await popupText(popup)).replace(/\n+/g, ' | ').slice(0, 600));
    throw e;
  }
  await sleep(400);
  const jobDir = join(downloadDir, 'Gleaner');
  const downloaded = existsSync(jobDir)
    ? readdirSync(jobDir).flatMap((d) => readdirSync(join(jobDir, d)))
    : [];
  check('3 个文件真实落盘', downloaded.length === 3, downloaded.join(', '));
  check('文件名带序号前缀', downloaded.every((f) => /^\d{3}_/.test(f)));
  check('下载记录出现', /下载记录/.test(await popupText(popup)));
  check('记录含定位文件按钮', /定位文件/.test(await popupText(popup)));

  // ============ 场景 2：慢速下载 → 暂停 → 关弹窗重开恢复 → 继续 ============
  await release();
  await fixture.goto(`${origin}/page?held`, { waitUntil: 'domcontentloaded' });
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(300);
  await clickByText(popup, '扫描');
  await waitFor(async () => (await popup.$$('.cell')).length >= 3, 8000, '扫描 held');
  await clickByText(popup, '下载');
  await waitFor(async () => /暂停/.test(await popupText(popup)), 5000, '进行中出现暂停钮');

  check('点击暂停', await clickByText(popup, '暂停'));
  await waitFor(async () => /已暂停/.test(await popupText(popup)), 5000, '已暂停态');
  check('显示已暂停', true);

  // 关掉弹窗再打开 —— 任务视图必须恢复
  await popup.close();
  popup = await openPopup();
  await sleep(500);
  const reopened = await popupText(popup);
  check('重开弹窗恢复进度条', /已暂停/.test(reopened));
  // 暂停现在是逐项的：列表里每个文件如实显示「已暂停」（以前显示「下载中/排队」，其实并没在下）
  const jobRows = await popup.evaluate(() => [...document.querySelectorAll('.job-item')].map((r) => r.innerText.replace(/\n+/g, ' ')));
  check('重开弹窗显示任务文件列表（逐项显示已暂停）',
    jobRows.length >= 3 && jobRows.some((r) => /001_/.test(r)) && jobRows.every((r) => /已暂停|✓/.test(r)),
    jobRows.join(' | '));
  check('历史显示进行中任务', /进行中/.test(reopened));

  check('点击继续', await clickByText(popup, '继续'));
  await sleep(400);
  await release(); // 放行慢速响应
  await waitFor(async () => (await jobState(popup)) === 'done', 10000, '继续后完成');
  check('继续后全部完成', true);

  // ============ 场景 3：取消 ============
  await release();
  await fixture.goto(`${origin}/page?held2=1&held`, { waitUntil: 'domcontentloaded' });
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(300);
  await clickByText(popup, '扫描');
  await waitFor(async () => (await popup.$$('.cell')).length >= 3, 8000, '扫描 cancel');
  await clickByText(popup, '下载');
  await waitFor(async () => /取消/.test(await popupText(popup)), 5000, '取消钮出现');
  check('点击取消', await clickByText(popup, '取消'));
  await waitFor(async () => /已取消/.test(await popupText(popup)), 6000, '已取消态');
  check('显示已取消并入历史', /已取消/.test(await popupText(popup)));
  await release();

  // ============ 场景 4：视频嗅探 → 下载落盘 ============
  await release(); // 放行上个场景挂起的连接，否则会拖住后续导航
  await release();
  await fixture.goto(`${origin}/vpage`, { waitUntil: 'load' });
  await sleep(800); // 等 video preload 发出请求，供嗅探
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => /视频 \/ 音频/.test(await popupText(popup)), 8000, '媒体区出现');
  await sleep(300);
  // 媒体区现在总是渲染（空态也显示），所以要等真实数据回来而不是等区块出现
  await waitFor(async () => /demo\.mp4/.test(await popupText(popup)), 8000, '媒体行出现');
  const mediaText = await popupText(popup);
  check('嗅探到视频并显示大小', /demo\.mp4/.test(mediaText) && /0\.3MB/.test(mediaText),
    mediaText.split('\n').filter((l) => /mp4|MB/.test(l)).join(' '));

  check('点击媒体下载', await popup.evaluate(() => {
    const b = document.querySelector('.media-dl');
    if (!b) return false;
    b.click();
    return true;
  }));
  await waitFor(async () => (await jobState(popup)) === 'done', 8000, '视频下载完成');
  const vidFiles = readdirSync(join(downloadDir, 'Gleaner'))
    .flatMap((d) => readdirSync(join(downloadDir, 'Gleaner', d)))
    .filter((f) => f.endsWith('.mp4'));
  check('视频文件真实落盘', vidFiles.length === 1, vidFiles.join(','));

  // ============ 场景 5：DASH 分片归并成可下载轨道 ============
  await release();
  await fixture.goto(`${origin}/dpage`, { waitUntil: 'load' });
  await sleep(1200);
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, 'DASH 媒体行出现');
  const dashRows = await popup.evaluate(() =>
    [...document.querySelectorAll('.media-row')].map((r) => r.innerText.replace(/\n/g, ' ')));
  check('DASH 音视频轨合并成一条「视频」', dashRows.length === 1 && /视频/.test(dashRows[0]),
    dashRows.join(' | '));
  check('标注含声音', /含声音/.test(dashRows[0] ?? ''), dashRows[0]);
  check('HEVC 轨标注为已自动兼容', /HEVC·已自动兼容/.test(dashRows[0] ?? ''), dashRows[0]);

  // 点这一条，应合并成「一个」带声音的 MP4
  const before5 = new Set(allDl().map((x) => x.f));
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  try {
    await waitFor(async () => allDl().some((x) => !before5.has(x.f) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000),
      30000, 'DASH 合并文件落盘');
  } catch (e) {
    const st = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    console.log('  [诊断] 任务项:', JSON.stringify(st?.items));
    console.log('  [诊断] 进度:', JSON.stringify(st?.progress));
    throw e;
  }
  const muxed5 = allDl().filter((x) => !before5.has(x.f) && /\.mp4$/.test(x.f));
  check('DASH 合并成「一个」MP4', muxed5.length === 1, muxed5.map((x) => x.f).join(','));
  const big5 = muxed5.find((x) => statSync(x.p).size > 100000);
  check('合并文件非 0 字节', big5 && statSync(big5.p).size > 100000, big5 ? statSync(big5.p).size + 'B' : '无');
  check('合并文件含音频轨（有声音）', big5 && hasAudioTrack(big5.p));

  // ============ 场景 5b：B站 播放器在放 AV1 —— 必须从清单里改下 H.264 ============
  // 真实回归：Chrome 里 B站 播放器优先 AV1，跟着下 → M1/M2 Mac 的 QuickTime「无法打开」
  const bili = await browser.newPage();
  await bili.goto(`http://www.bilibili.com:${server.address().port}/video/BVe2e/`, { waitUntil: 'load' });
  await sleep(1200);
  await popup.close();
  popup = await openPopup();
  await bili.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, 'B站 媒体行出现');
  await sleep(600); // 等嗅探那一路也到齐，确认散轨不会冒出第二行
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, 'B站 媒体行出现（重开）');
  const biliRows = await popup.evaluate(() =>
    [...document.querySelectorAll('.media-row')].map((r) => r.innerText.replace(/\n+/g, ' ')));
  check('B站：同一视频只显示一行', biliRows.length === 1, biliRows.join(' | '));
  check('B站：标注分辨率「视频 852×480」', /视频 852×480/.test(biliRows[0] ?? ''), biliRows[0]);
  check('B站：选的是 H.264 而不是 AV1', /H\.264/.test(biliRows[0] ?? '') && !/AV1/.test(biliRows[0] ?? ''), biliRows[0]);
  check('B站：含声音', /含声音/.test(biliRows[0] ?? ''), biliRows[0]);

  const before5b = new Set(allDl().map((x) => x.p));
  const reqsBefore = biliReqs.length;
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  await waitFor(async () => allDl().some((x) => !before5b.has(x.p) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000),
    30000, 'B站 合并文件落盘');
  const dlReqs = biliReqs.slice(reqsBefore).filter((u) => !/[?&]range=/.test(u));
  check('B站：扩展抓的是 H.264 画面轨（30032）', dlReqs.some((u) => u.includes('-1-30032.m4s')), dlReqs.join(' '));
  check('B站：扩展抓的是最高码率声音轨（30280）', dlReqs.some((u) => u.includes('-1-30280.m4s')), dlReqs.join(' '));
  check('B站：扩展没去整包下 AV1 轨', !dlReqs.some((u) => u.includes('100023')), dlReqs.join(' '));
  const biliFile = allDl().find((x) => !before5b.has(x.p) && /\.mp4$/.test(x.f));
  check('B站：落盘为「页面标题.mp4」且含声音', biliFile && /危险的黑子/.test(biliFile.f) && hasAudioTrack(biliFile.p),
    biliFile?.f);
  await bili.close();

  // ============ 场景 5c：B站 视频下到一半暂停 → 网络真停 → 继续从断点续传 ============
  // 真实回归：之前「暂停」对页面通道无效，后台照样抓完落盘；「取消」也停不掉
  const slow = await browser.newPage();
  await slow.goto(`http://www.bilibili.com:${server.address().port}/video/BVslow/`, { waitUntil: 'load' });
  await popup.close();
  popup = await openPopup();
  await slow.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, '慢速视频行出现');
  const before5c = new Set(allDl().map((x) => x.p));
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  await waitFor(() => slowReqs.some(([p, r]) => /30032/.test(p) && r === 'none'), 8000, '开始抓画面轨');
  await sleep(800); // 让扩展收到前 64KB
  const ctl = (action) => popup.evaluate((a) => chrome.runtime.sendMessage({ type: 'JOB_CONTROL', action: a }), action);
  const paused = await ctl('pause');
  check('B站暂停：任务进入已暂停', paused?.state === 'paused', JSON.stringify(paused));
  await sleep(800);
  check('B站暂停：网络请求真的中止了', slowAborted >= 1, `中止连接数 ${slowAborted}`);
  check('B站暂停：暂停期间没有文件落盘', !allDl().some((x) => !before5c.has(x.p) && /慢速长视频/.test(x.f)));
  const reqsAtPause = slowReqs.length;
  const resumed = await ctl('resume');
  check('B站继续：任务恢复运行', resumed?.state === 'running', JSON.stringify(resumed));
  await waitFor(() => allDl().some((x) => !before5c.has(x.p) && /慢速长视频.*\.mp4$/.test(x.f) && statSync(x.p).size > 100000),
    30000, '续传后合并文件落盘');
  const vReq = slowReqs.slice(reqsAtPause).find(([p]) => /30032/.test(p));
  check('B站继续：从断点续传（带 Range，起点 > 0）', vReq && /^bytes=[1-9]\d*-$/.test(vReq[1]), JSON.stringify(vReq));
  const slowFile = allDl().find((x) => !before5c.has(x.p) && /慢速长视频/.test(x.f));
  check('B站续传：合并文件完整且含声音', slowFile && statSync(slowFile.p).size > 100000 && hasAudioTrack(slowFile.p),
    slowFile ? `${slowFile.f} ${statSync(slowFile.p).size}B` : '无');
  await slow.close();

  // ============ 场景 5d：抓取途中 service worker 被 Chrome 回收 → 唤醒后自动接着下 ============
  // 真实回归：之前这种项会一直显示「下载中」，要等 10 分钟才判失败，用户只能重下
  const orphan = await browser.newPage();
  await orphan.goto(`http://www.bilibili.com:${server.address().port}/video/BVorphan/`, { waitUntil: 'load' });
  await popup.close();
  popup = await openPopup();
  await orphan.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, '孤儿场景视频行出现');
  const before5d = new Set(allDl().map((x) => x.p));
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  await waitFor(() => slowReqs.some(([p, r]) => /orphan-1-30032/.test(p) && r === 'none'), 8000, '开始抓孤儿画面轨');
  await sleep(800);
  // 用 DevTools 的「停止 service worker」—— 和 Chrome 闲置回收是同一条路径
  const swCdp = await popup.createCDPSession();
  const versions = [];
  swCdp.on('ServiceWorker.workerVersionUpdated', (e) => versions.push(...e.versions));
  await swCdp.send('ServiceWorker.enable');
  await sleep(300);
  const running = versions.filter((v) => v.scriptURL.includes(extId) && v.runningStatus === 'running');
  for (const v of running) await swCdp.send('ServiceWorker.stopWorker', { versionId: v.versionId });
  await sleep(1000);
  const stoppedNow = versions.filter((v) => v.scriptURL.includes(extId)).at(-1)?.runningStatus;
  check('孤儿：service worker 已被停止', running.length > 0 && stoppedNow === 'stopped', `状态 ${stoppedNow}`);
  const reqsAtKill = slowReqs.length;
  // 用户重新打开弹窗 → SW 被唤醒
  await popup.close();
  popup = await openPopup();
  try {
    await waitFor(() => allDl().some((x) => !before5d.has(x.p) && /后台被回收.*\.mp4$/.test(x.f) && statSync(x.p).size > 100000),
      30000, 'SW 重启后自动续传并落盘');
  } catch (e) {
    const st = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' })).catch((x) => String(x));
    console.log('  [诊断] 停止后的请求:', JSON.stringify(slowReqs.slice(reqsAtKill)));
    console.log('  [诊断] 任务:', JSON.stringify(st?.items), JSON.stringify(st?.progress));
    const ctx = await browser.targets().map((t) => `${t.type()} ${t.url().slice(0, 80)}`);
    console.log('  [诊断] targets:', ctx.filter((x) => x.includes('chrome-extension')).join(' | '));
    throw e;
  }
  const oReq = slowReqs.slice(reqsAtKill).find(([p]) => /orphan-1-30032/.test(p));
  check('孤儿：SW 唤醒后自动接着下（带 Range 续传，不是从头）', oReq && /^bytes=[1-9]\d*-$/.test(oReq[1]), JSON.stringify(oReq));
  const oFile = allDl().find((x) => !before5d.has(x.p) && /后台被回收/.test(x.f));
  check('孤儿：文件完整且含声音', oFile && hasAudioTrack(oFile.p), oFile ? `${oFile.f} ${statSync(oFile.p).size}B` : '无');
  const oState = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  check('孤儿：任务正常结束，不再卡在「下载中」', oState?.progress?.state === 'done', JSON.stringify(oState?.progress));
  await orphan.close();

  // ============ 场景 5e：规则升级到原图的图片，卡片标出原图的真实分辨率 ============
  // 真实回归：淘宝/京东/微博整页卡片只显示「图片 JPG」，看不到原图多大（需求：图片 + 分辨率）
  const tb = await browser.newPage();
  await tb.goto(`${origin}/tbpage`, { waitUntil: 'load' });
  await popup.close();
  popup = await openPopup();
  await tb.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(300);
  check('淘宝页：点击扫描', await clickByText(popup, '扫描'));
  await waitFor(async () => (await popup.$$('.cell')).length >= 3, 8000, '淘宝页扫描结果');
  const cellText = () => popup.evaluate(() => [...document.querySelectorAll('.cell')].map((c) => c.innerText.replace(/\n+/g, ' ')));
  try {
    await waitFor(async () => (await cellText()).filter((t) => /1601×1203/.test(t)).length === 3, 10000, '原图尺寸回填');
  } catch (e) {
    console.log('  [诊断] 卡片:', JSON.stringify(await cellText()), '原图请求:', JSON.stringify(tbReqs));
    throw e;
  }
  check('淘宝页：3 张缩略图都升级成原图，卡片标原图分辨率 1601×1203', true, (await cellText()).join(' | '));
  check('淘宝页：尺寸探测只拉文件头（Range）', tbReqs.length >= 3 && tbReqs.every(([r]) => r === 'bytes=0-131071'),
    JSON.stringify(tbReqs.slice(0, 3)));
  check('淘宝页：探测请求带上了站点 Referer（DNR 对后台请求生效）', tbReqs.every(([, ref]) => ref.includes('taobao.com')),
    JSON.stringify(tbReqs.slice(0, 3)));
  await tb.close();

  // ============ 场景 6：MSE 播放器（blob: 假地址）—— 只能靠页面钩子捕获 ============
  await release();
  await fixture.goto(`${origin}/msepage`, { waitUntil: 'load' });
  await sleep(1200);
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(600);
  const mseText = await popupText(popup);
  const mediaRows = await popup.evaluate(() =>
    [...document.querySelectorAll('.media-row')].map((r) => r.innerText.replace(/\n/g, ' ')));

  check('MSE 页捕获到媒体（页面钩子通道）', mediaRows.length > 0, mediaRows.join(' | '));
  check('音视频轨合并成一条，不暴露分轨', mediaRows.length === 1,
    `期望 1 行，实际 ${mediaRows.length}：${mediaRows.join(' | ')}`);
  check('该行标为「视频」且注明含声音',
    /视频/.test(mediaRows[0] ?? '') && /含声音/.test(mediaRows[0] ?? ''), mediaRows[0]);
  check('不再出现「视频轨/音频轨」字样', !/视频轨|音频轨/.test(mseText));
  check('跨 CDN 重复行已去重', (mseText.match(/mse-1-30080/g) ?? []).length <= 1);
  check('埋点接口未被误列（/web、report.ts）', !/\bweb\b/.test(mseText) && !/report\.ts/.test(mseText),
    mediaRows.join(' | '));
  check('blob: 假地址未被误列', !/blob:/.test(mseText));
  check('媒体区无错误提示', !/⚠/.test(mseText),
    mseText.split('\n').filter((l) => /⚠/.test(l)).join(' '));

  // 点一次 → 合并成一个带声音的 MP4
  const before6 = new Set(allDl().map((x) => x.f));
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  await waitFor(async () => allDl().some((x) => !before6.has(x.f) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000),
    30000, 'MSE 合并文件落盘');
  const muxed6 = allDl().filter((x) => !before6.has(x.f) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000);
  check('MSE 页也合并成一个带声音的 MP4', muxed6.length === 1 && hasAudioTrack(muxed6[0].p),
    muxed6.map((x) => x.f).join(','));

  // ============ 场景 7：鉴权签名必须保留（B站 403 回归） ============
  await release();
  await fixture.goto(`${origin}/signedpage`, { waitUntil: 'load' });
  await sleep(1000);
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, '签名流出现');

  const signedUrls = await popup.evaluate(() =>
    [...document.querySelectorAll('.media-row')].map((r) => r.getAttribute('title')));
  check('分片 URL 保留了鉴权签名', signedUrls.every((u) => /upsig=abc123/.test(u ?? '')),
    signedUrls.join(' | '));
  check('range 参数已剥离', signedUrls.every((u) => !/range=/.test(u ?? '')), signedUrls.join(' | '));

  const before7 = new Set(allDl().map((x) => x.f));
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  await waitFor(async () => allDl().some((x) => !before7.has(x.f) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000),
    30000, '签名流合并落盘');
  const muxed7 = allDl().filter((x) => !before7.has(x.f) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000);
  check('带签名的流合并成功（非 .html 错误页、含音频）',
    muxed7.length === 1 && !muxed7[0].f.endsWith('.html') && hasAudioTrack(muxed7[0].p),
    muxed7.map((x) => x.f).join(','));

  // ============ 场景 8：防盗链 Referer 是否真的作用到 downloads API ============
  await release();
  await fixture.goto(`${origin}/refpage`, { waitUntil: 'load' });
  await sleep(1000);
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, '防盗链流出现');

  const before8 = new Set(
    readdirSync(join(downloadDir, 'Gleaner')).flatMap((d) =>
      readdirSync(join(downloadDir, 'Gleaner', d))));
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  await waitFor(async () => {
    const now = readdirSync(join(downloadDir, 'Gleaner')).flatMap((d) =>
      readdirSync(join(downloadDir, 'Gleaner', d)));
    return now.filter((f) => !before8.has(f) && /\.(mp4|m4a)$/.test(f)).length >= 1;
  }, 12000, '防盗链文件落盘');
  const after8 = readdirSync(join(downloadDir, 'Gleaner'))
    .flatMap((d) => readdirSync(join(downloadDir, 'Gleaner', d)))
    .filter((f) => !before8.has(f) && /\.(mp4|m4a)$/.test(f));
  check('防盗链站点能下载成功（页面通道兜底）',
    after8.length >= 1 && after8.every((f) => !f.endsWith('.html')), after8.join(',') || '(无文件)');

  // 重试成功后账本必须同步 —— 文件下来了却显示「失败」是谎报
  await waitFor(async () => (await jobState(popup)) === 'done', 10000, '任务收敛为完成').catch(() => {});
  const jobText8 = await popupText(popup);
  check('重试成功后任务状态为完成，不残留失败',
    (await jobState(popup)) === 'done' && !/失败/.test(jobText8.split('下载记录')[0]),
    jobText8.split('\n').filter((l) => /失败|服务器|完成|\d\/\d/.test(l)).slice(0, 3).join(' | '));

  // ============ 场景 9：旧任务不得冒充当前状态 ============
  // 前面场景留下了已完成/失败的任务。换一个全新页面打开弹窗，
  // 不该看到上个页面遗留的文件列表（用户截图里「还没扫描就有两个 mp4」）
  await release();
  await fixture.goto(`${origin}/page`, { waitUntil: 'domcontentloaded' });
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(700);
  const freshJobRows = await popup.evaluate(() => document.querySelectorAll('.job-item').length);
  check('新页面打开弹窗不显示上个任务的文件列表', freshJobRows === 0, `实际 ${freshJobRows} 行`);
  const freshText = await popupText(popup);
  check('历史区仍能看到过往任务及失败原因',
    /下载记录/.test(freshText) && /\d+\/\d+/.test(freshText));

  // ============ 场景 10：长视频不堵塞、有进度 ============
  await release();
  await fixture.goto(`${origin}/slowpage`, { waitUntil: 'load' });
  await sleep(1500);
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, '慢速流出现');
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());

  const sawPercent = await waitFor(async () => /\d+%/.test(await popupText(popup)), 12000, '进度显示')
    .then(() => true).catch(() => false);
  check('整包抓取显示百分比进度', sawPercent,
    (await popupText(popup)).split('\n').filter((l) => /%/.test(l)).join(' '));

  await waitFor(async () => (await jobState(popup)) === 'done', 25000, '慢速流完成').catch(() => {});
  check('慢速流最终下载完成', (await jobState(popup)) === 'done', String(await jobState(popup)));

  // ============ 场景 11：跨域 CDN（ACAO:*）—— 带凭证会被浏览器拒绝 ============
  await release();
  await fixture.goto(`${origin}/corspage`, { waitUntil: 'load' });
  await sleep(1200);
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length > 0, 8000, '跨域流出现');

  const before11 = new Set(allDl().map((x) => x.f));
  await popup.evaluate(() => document.querySelector('.media-dl')?.click());
  const gotCors = await waitFor(
    async () => allDl().some((x) => !before11.has(x.f) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000),
    30000, '跨域流合并落盘',
  ).then(() => true).catch(() => false);
  if (!gotCors) {
    const st = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
    console.log('  [诊断] 跨域任务项:', JSON.stringify(st?.items));
  }
  const muxed11 = allDl().filter((x) => !before11.has(x.f) && /\.mp4$/.test(x.f) && statSync(x.p).size > 100000);
  check('跨域 CDN（ACAO:*）能抓取并合并成功', gotCors && muxed11.length >= 1 && hasAudioTrack(muxed11[0].p),
    muxed11.map((x) => x.f).join(','));

  // ============ 场景 12：AI 助手 · 本地颜色筛选（不联网）→ 一键下载命中项 ============
  await release();
  aiRequests.length = 0;
  await fixture.goto(`${origin}/aipage`, { waitUntil: 'load' });
  await sleep(800);
  await popup.close();
  popup = await openPopup();
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(500);
  const askAgent = async (text) => {
    await popup.evaluate((t) => {
      const input = document.querySelector('section.agent input.search');
      if (!input) return;
      // React 受控输入：要走原生 setter + input 事件才会更新 state
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, t);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, text);
    await sleep(80);
    const clicked = await clickByText(popup, '执行');
    if (!clicked) return { clicked, status: await agentStatus() };
    // 跑的时候「执行」钮变成「思考中…」；等它变回来再读结果，别靠猜时间
    const runBtn = () => popup.evaluate(() => document.querySelector('section.agent button.primary')?.textContent ?? '');
    await waitFor(async () => /思考中/.test(await runBtn()), 3000, '助手开始').catch(() => {});
    await waitFor(async () => !/思考中/.test(await runBtn()), 30000, '助手结束');
    await sleep(150);
    const status = await agentStatus();
    console.log(`  [助手] ${text} → ${status.replace(/\n+/g, ' | ')}`);
    return { clicked, status };
  };
  const agentStatus = () => popup.evaluate(() => document.querySelector('.agent-status')?.innerText ?? '');
  const selectedCells = () => popup.$$('.cell.on').then((c) => c.length);
  const checkedMedia = () => popup.evaluate(() => document.querySelectorAll('.media-row input:checked').length);

  check('助手面板渲染', (await popup.$$('section.agent')).length === 1);
  check('页面类型本地判断（og:type=article → 文章页）', /文章页/.test(await agentStatus()), await agentStatus());
  const a12 = await askAgent('我需要页面内所有绿色的图片');
  check('输入「我需要页面内所有绿色的图片」并执行', a12.clicked);
  check('本地完成、命中 3 项', /本地完成/.test(a12.status) && /命中 3 项/.test(a12.status), a12.status);
  check('网格里恰好选中 3 张', (await selectedCells()) === 3, `实际 ${await selectedCells()}`);
  const chosenSrc = await popup.evaluate(() => [...document.querySelectorAll('.cell.on img')].map((i) => i.getAttribute('src')));
  check('选中的全是绿色图（真像素判定）', chosenSrc.length === 3 && chosenSrc.every((s) => /green/.test(s)), chosenSrc.join(','));
  check('本地筛选零 API 请求', aiRequests.length === 0);
  await popup.screenshot({ path: join(downloadDir, 'popup-ai-local.png') });

  const before12 = new Set(allDl().map((x) => x.f));
  check('点击「下载选中 3 项」', await clickByText(popup, '下载选中'));
  await waitFor(async () => (await jobState(popup)) === 'done', 10000, '命中项下载完成');
  await sleep(300);
  const new12 = allDl().filter((x) => !before12.has(x.f));
  check(
    '3 张绿色 PNG 真实落盘（PNG 签名）',
    new12.length === 3 && new12.every((x) => readFileSync(x.p).subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))),
    new12.map((x) => `${x.f}:${statSync(x.p).size}B`).join(','),
  );

  // ============ 场景 13：AI 助手 · 本地位置筛选（评论区的视频）→ 混合任务下载 ============
  const a13 = await askAgent('我要页面内评论区的视频，给我下载下来');
  check('输入「我要页面内评论区的视频」并执行', a13.clicked);
  if (!/命中 1 项/.test(a13.status)) {
    const rows = await popup.evaluate(() => [...document.querySelectorAll('.media-row')].map((r) => r.innerText.replace(/\n+/g, ' ')));
    console.log('  [诊断] 媒体行:', JSON.stringify(rows));
  }
  check('评论区视频本地命中 1 项', /本地完成/.test(a13.status) && /命中 1 项/.test(a13.status), a13.status);
  check('媒体区恰好勾选 1 条', (await checkedMedia()) === 1, `实际 ${await checkedMedia()}`);
  const checkedRow = await popup.evaluate(() => document.querySelector('.media-row.on')?.innerText ?? '');
  check('勾选的是评论区的 reply.mp4（带区块标注）', /reply\.mp4/.test(checkedRow) && /评论区/.test(checkedRow), checkedRow);
  check('图片网格选择已清空', (await selectedCells()) === 0);
  const before13 = new Set(allDl().map((x) => x.f));
  check('点击「下载选中 1 项」', await clickByText(popup, '下载选中'));
  await waitFor(async () => (await jobState(popup)) === 'done', 10000, '评论区视频下载完成');
  await sleep(300);
  const new13 = allDl().filter((x) => !before13.has(x.f));
  check('评论区视频落盘为完整 mp4', new13.length === 1 && /\.mp4$/.test(new13[0].f) && statSync(new13[0].p).size === 300000,
    new13.map((x) => `${x.f}:${statSync(x.p).size}B`).join(','));

  // ============ 场景 14：语义请求 + 云端未开 → 说明原因、绝不联网 ============
  aiRequests.length = 0;
  const a14 = await askAgent('把有猫的图片下载下来');
  check('输入「把有猫的图片下载下来」并执行（云端未开）', a14.clicked);
  const s14 = a14.status;
  check('未开云端：指出「猫」需要看内容 + 提示去开启', /猫/.test(s14) && /开启云端/.test(s14), s14);
  check('未开云端：零请求', aiRequests.length === 0);
  check('未开云端：不选中任何项', (await selectedCells()) === 0 && (await checkedMedia()) === 0);

  // ============ 场景 15：云端理解（假 API）：摘要 + 联络表 + 直连头 + 编号映射 ============
  await popup.evaluate(
    (base) => chrome.storage.local.set({ 'og-agent': { cloudEnabled: true, apiKey: 'sk-e2e-test', model: 'claude-opus-5', apiBaseUrl: base } }),
    origin,
  );
  const a15 = await askAgent('把有猫的图片下载下来');
  check('输入「把有猫的图片下载下来」并执行（云端已开）', a15.clicked);
  const s15 = a15.status;
  check('显示云端理解 + 模型解释', /云端理解/.test(s15) && /e2e 假模型/.test(s15), s15);
  check('假 API 收到恰好 1 次请求', aiRequests.length === 1, `实际 ${aiRequests.length}`);
  const r15 = aiRequests[0];
  check('直连头 + Key 头正确',
    r15?.headers['anthropic-dangerous-direct-browser-access'] === 'true' && r15?.headers['x-api-key'] === 'sk-e2e-test');
  const b15 = r15?.body;
  check('模型按设置', b15?.model === 'claude-opus-5');
  check('请求带 strict 工具 select_media', b15?.tools?.[0]?.name === 'select_media' && b15.tools[0].strict === true);
  const content15 = b15?.messages?.[0]?.content ?? [];
  const img15 = content15.find((c) => c.type === 'image');
  const txt15 = content15.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  check('带联络表且是真 JPEG',
    Boolean(img15) && img15.source.media_type === 'image/jpeg' &&
      Buffer.from(img15.source.data, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])),
    img15 ? `${img15.source.data.length} chars` : '无图片块');
  writeFileSync(join(downloadDir, 'contact-sheet.jpg'), img15 ? Buffer.from(img15.source.data, 'base64') : Buffer.alloc(0));
  check('摘要只含图片候选（6 项），带区域和 alt',
    /候选素材 6 项/.test(txt15) && /#1 图片/.test(txt15) && /区域=.*评论区/.test(txt15) && /alt="草地"/.test(txt15) && !/#\d+ 视频/.test(txt15),
    txt15.split('\n').filter((l) => /^#\d/.test(l)).join(' | '));
  check('用户原话原样附上', /用户请求：把有猫的图片下载下来/.test(txt15));
  check('模型选的 #1 映射回网格并选中', (await selectedCells()) === 1, `实际 ${await selectedCells()}`);
  await clickByText(popup, 'AI 设置');
  await sleep(200);
  await popup.screenshot({ path: join(downloadDir, 'popup-ai-cloud.png') });
  await popup.evaluate(() => chrome.storage.local.remove('og-agent'));

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n===== E2E 结果：${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) process.exitCode = 1;
} catch (e) {
  console.error('E2E 失败:', e);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
  rmSync(profileDir, { recursive: true, force: true });
  console.log('下载目录（保留供检查）:', downloadDir);
}
