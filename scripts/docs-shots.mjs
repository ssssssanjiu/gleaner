/**
 * 生成 README 用的截图：真 Chrome + 构建好的扩展 + 本地演示页。
 * 演示页的照片来自 Wikimedia Commons（CC0，见 docs/demo/credits.json），视频由其中一张照片生成。
 *
 * 用法：npm run docs:shots（会先构建到 .output-e2e），输出到 docs/assets/
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const EXT_DIR = process.env.EXT_DIR || join(ROOT, '.output-e2e/chrome-mv3');
const OUT = join(ROOT, 'docs/assets');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 10000, tag = '') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`waitFor 超时: ${tag}`);
    await sleep(150);
  }
}

// ---------- 演示素材 ----------
// docs/demo/：Wikimedia Commons 上的 CC0 照片（来源和作者见 credits.json），
// 以及 scripts/gen-demo-media.mjs 用其中一张照片生成的短片和底噪音频
const DEMO = join(ROOT, 'docs/demo');
const PHOTOS = JSON.parse(readFileSync(join(DEMO, 'credits.json'), 'utf8'))
  .filter((c) => c.file !== 'bay.jpg') // 这张用作视频画面，不单独进图集
  .map((c) => ({ slug: c.file.replace(/\.jpg$/, ''), name: c.name, bytes: readFileSync(join(DEMO, c.file)) }));
const VIDEO = readFileSync(join(DEMO, 'timelapse.mp4'));
const AUDIO = readFileSync(join(DEMO, 'ambience.m4a'));
/** JPEG 文件头里的宽高（SOF 段） */
function jpegSize(b) {
  for (let o = 2; o + 9 < b.length; ) {
    if (b[o] !== 0xff) { o++; continue; }
    const mk = b[o + 1];
    if (mk >= 0xc0 && mk <= 0xcf && mk !== 0xc4 && mk !== 0xc8 && mk !== 0xcc) {
      return [b.readUInt16BE(o + 7), b.readUInt16BE(o + 5)];
    }
    o += 2 + b.readUInt16BE(o + 2);
  }
  return [0, 0];
}
const photoBySlug = new Map(PHOTOS.map((p) => [p.slug, p]));

// ---------- 本地服务器（gallery.example 经 host-resolver-rules 指到这里） ----------
const heldImgs = [];
let holdImages = false;
const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  const m = /^\/photos\/([\w-]+)\.jpg/.exec(url);
  if (m && photoBySlug.has(m[1])) {
    const body = photoBySlug.get(m[1]).bytes;
    const send = () => {
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': String(body.length) });
      res.end(body);
    };
    // 截「下载中」那张图时挂住前几个下载请求，让进度停在进行中（缩略图早已加载、有缓存，不受影响）
    if (holdImages && heldImgs.length < 5) heldImgs.push(send);
    else send();
    return;
  }
  if (url.startsWith('/media/') || url.startsWith('/music/')) {
    const body = url.startsWith('/music/') ? AUDIO : VIDEO;
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
    if (r) {
      const start = Number(r[1]);
      const end = r[2] ? Math.min(Number(r[2]), body.length - 1) : body.length - 1;
      res.writeHead(206, {
        'content-type': url.startsWith('/music/') ? 'audio/mp4' : 'video/mp4',
        'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${body.length}`,
      });
      return res.end(body.subarray(start, end + 1));
    }
    res.writeHead(200, { 'content-type': url.startsWith('/music/') ? 'audio/mp4' : 'video/mp4', 'content-length': String(body.length) });
    return res.end(body);
  }
  if (url.startsWith('/landscapes')) {
    const cards = PHOTOS.map(({ slug, name, bytes }) => {
      const [w, h] = jpegSize(bytes);
      return `<figure><img src="/photos/${slug}.jpg" alt="${name}"><figcaption>${name} <span>${w}×${h}</span></figcaption></figure>`;
    }).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset="utf-8"><title>Landscapes · Photography Collection</title>
<style>
  body{margin:0;background:#f6f4ef;color:#1d1b17;font:15px -apple-system,'SF Pro Text','PingFang SC',system-ui,sans-serif}
  header{padding:40px 56px 8px;display:flex;align-items:baseline;gap:18px}
  h1{margin:0;font:600 34px ui-serif,'New York',Georgia,serif;letter-spacing:-.5px}
  header p{margin:0;color:#8a8378}
  .media{margin:18px 56px 8px;display:flex;gap:22px;align-items:center;color:#8a8378;font-size:13px}
  .media video{width:220px;border-radius:10px;display:block}
  .media audio{height:32px}
  .g{columns:4 220px;column-gap:18px;padding:18px 56px 56px}
  figure{margin:0 0 18px;break-inside:avoid}
  img{width:100%;display:block;border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 8px 24px rgba(0,0,0,.06)}
  figcaption{display:flex;justify-content:space-between;padding:8px 2px 0;font-size:13px;color:#4a463f}
  figcaption span{color:#a39c90;font-variant-numeric:tabular-nums}
</style>
<header><h1>Landscapes</h1><p>A photography collection · ${PHOTOS.length} works</p></header>
<div class="media"><video src="/media/timelapse.mp4" preload="auto" muted playsinline></video>
  <span>Ambience</span><audio src="/music/ambience.m4a" controls></audio></div>
<div class="g">${cards}</div>`);
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ---------- 启动 Chrome + 扩展 ----------
const downloadDir = mkdtempSync(join(tmpdir(), 'gleaner-shots-dl-'));
const profileDir = mkdtempSync(join(tmpdir(), 'gleaner-shots-profile-'));
mkdirSync(join(profileDir, 'Default'), { recursive: true });
writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
}));
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false, userDataDir: profileDir, pipe: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', '--enable-unsafe-extension-debugging', '--window-position=2200,2200', '--window-size=1200,900',
    '--host-resolver-rules=MAP gallery.example 127.0.0.1', '--lang=zh-CN'],
});

try {
  const cdp = await browser.target().createCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  await waitFor(async () => browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId)), 10000, 'SW');

  const page = await browser.newPage();
  await page.goto(`http://gallery.example:${port}/landscapes`, { waitUntil: 'load' });
  await sleep(1500);
  const popup = await browser.newPage();
  await popup.setViewport({ width: 740, height: 600, deviceScaleFactor: 2 });
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(500);
  // 只为截图：藏掉 macOS 浮动滚动条（拍摄瞬间偶尔会露出来，和界面本身无关）
  const hideScrollbars = () => popup.addStyleTag({ content: '*::-webkit-scrollbar{display:none}' });
  await hideScrollbars();
  const click = (text) => popup.evaluate((t) => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(t) && !x.disabled);
    b?.click();
    return Boolean(b);
  }, text);

  // ⓪ 演示页本身（横幅里浏览器窗口的内容）
  await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 2 });
  // 等照片和视频第一帧都出来再拍
  await waitFor(() => page.evaluate(() =>
    [...document.images].every((i) => i.complete && i.naturalWidth) &&
    (document.querySelector('video')?.readyState ?? 0) >= 2), 15000, '演示页素材加载');
  await sleep(400);
  await page.screenshot({ path: join(OUT, 'page-demo.png') });

  // ① 扫描结果：视频（B站 480P · H.264 · 含声音）+ 音频 + 图片（原图分辨率）
  await click('扫描');
  await waitFor(async () => (await popup.$$('.cell')).length >= PHOTOS.length, 10000, '扫描结果');
  await waitFor(async () => (await popup.$$('.media-row')).length >= 2, 10000, '媒体行');
  await sleep(800);
  await popup.bringToFront();
  await popup.screenshot({ path: join(OUT, 'screenshot-scan.png') });
  console.log('✓ screenshot-scan.png');

  // ② 下载中：进度、暂停 / 取消、下载列表
  holdImages = true;
  // 点底部的「下载 N 张」（不是媒体行里的「下载」链接）；演示页保持在前台，扩展才认得当前页
  await page.bringToFront();
  await popup.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => /^下载 \d+ 张/.test(b.textContent.trim()))?.click());
  await waitFor(async () => /暂停/.test(await popup.evaluate(() => document.body.innerText)), 8000, '下载中');
  await popup.bringToFront();
  await sleep(1500);
  await popup.screenshot({ path: join(OUT, 'screenshot-download.png') });
  console.log('✓ screenshot-download.png');
  holdImages = false;
  heldImgs.splice(0).forEach((f) => f());
  await waitFor(async () => !/暂停/.test(await popup.evaluate(() => document.body.innerText)), 20000, '下载完成');
  await sleep(800);

  // ③ AI 助手（本地筛选，不联网）：「把绿色的图片下载下来」
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await sleep(500);
  await hideScrollbars();
  await click('扫描');
  await waitFor(async () => (await popup.$$('.cell')).length >= PHOTOS.length, 10000, '再次扫描');
  // 演示页保持在前台（执行时扩展按「当前标签页」取页面信息）；输入框用原生 setter 赋值，React 才收得到
  await page.bringToFront();
  await popup.evaluate((text) => {
    const el = document.querySelector('section.agent input, section.agent textarea');
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, '所有绿色的图片');
  await sleep(300);
  await popup.evaluate(() => document.querySelector('section.agent button.primary')?.click());
  await waitFor(async () => (await popup.evaluate(() => document.querySelector('.agent-status')?.innerText ?? '')).length > 0, 15000, 'AI 结果');
  await sleep(1000);
  await popup.bringToFront();
  await sleep(300);
  await popup.screenshot({ path: join(OUT, 'screenshot-ai.png') });
  console.log('✓ screenshot-ai.png');

} finally {
  await browser.close().catch(() => {});
  server.close();
}
