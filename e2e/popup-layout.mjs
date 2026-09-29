/**
 * 弹窗布局 + 进度显示的真浏览器检查（popup-ux#1/#6/#8/#10/#11/#12/#13/#14、bilibili-pipeline#12）。
 *
 * 用真 Chrome 加载构建好的扩展，把 popup.html 开在 740×600 的页面里（和真实弹窗同尺寸：
 * body 宽 740，Chrome 弹窗最高 600），在一个有 40 张图、十几条视频的页面上扫描并开始一个
 * 一直在下载的任务，然后逐项量：
 *   - 暂停/继续/取消、「下载 N 张」按钮、正在下载列表必须完整落在 600px 以内，而且
 *     document.elementFromPoint 在按钮中心点得到的就是按钮本身（没被裁、没被盖住）；
 *   - 整页不能滚动（document.scrollingElement.scrollHeight <= 600，.app 内部也没有被裁掉的内容）；
 *   - 暂停/继续/取消/下载 用 page.mouse 按坐标真点（看不见的按钮点不到）。
 *
 * 构建：OG_OUT_DIR=.output-popup npx wxt build
 * 运行：node e2e/popup-layout.mjs
 * 可选：OG_POPUP_EXT=<chrome-mv3 目录> 指定别的构建；OG_POPUP_SHOT=<png 路径> 指定截图位置。
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT_DIR = resolve(process.env.OG_POPUP_EXT || resolve(import.meta.dirname, '../.output-popup/chrome-mv3'));
const SHOT = process.env.OG_POPUP_SHOT || join(tmpdir(), 'gleaner-popup-busy.png');
const W = 740; // popup 的 CSS 宽度（style.css body width）
const H = 600; // Chrome 弹窗高度上限

const results = [];
const check = (name, ok, detail = '') => {
  results.push([name, Boolean(ok), detail]);
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => false);
    if (v) return v;
    if (Date.now() - t0 > ms) return false;
    await sleep(120);
  }
}
/** 一个步骤出错不拖垮后面的检查（跑旧构建做对比时尤其需要） */
async function step(name, fn) {
  try {
    await fn();
  } catch (e) {
    check(`${name}：步骤出错`, false, String(e?.message ?? e).slice(0, 200));
  }
}

// ---------------- 测试服务器 ----------------
const SVG = (n, c = 'teal') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="${c}"/><text x="20" y="150" font-size="40">${n}</text></svg>`;
const held = [];
const biliReqs = [];
let holdDownloads = true;
const isImgLoad = (req) => req.headers['sec-fetch-dest'] === 'image';
const LONG_TITLE = '【4K 60帧】超长标题的一期视频：从零开始的完整教程，附带所有素材和工程文件下载_哔哩哔哩_bilibili';
const LONG_ERROR = '页面通道也失败：服务器拒绝（HTTP 403）—— 链接可能已过期，重新播放一下再试';

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  const port = server.address().port;
  if (url === '/release') {
    held.splice(0).forEach((fn) => fn());
    res.end('released');
  } else if (url.startsWith('/img/')) {
    // 页面和弹窗预览（sec-fetch-dest: image）立即返回；下载请求先发一半、剩下的挂起 —— 任务一直「下载中」
    const body = SVG(url.split('/').pop());
    if (isImgLoad(req) || !holdDownloads) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(body);
      return;
    }
    const big = body.repeat(300);
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'content-length': String(big.length), 'cache-control': 'no-store' });
    res.write(big.slice(0, 100));
    held.push(() => {
      try { res.end(big.slice(100)); } catch {}
    });
  } else if (url.startsWith('/zimg/')) {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
    res.end(SVG(url.split('/').pop(), 'orange'));
  } else if (url.startsWith('/zfail/')) {
    // 页面里能显示，打包抓取时 403 —— 「ZIP 已保存，1 张抓取失败未入包」
    if (isImgLoad(req)) {
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      res.end(SVG('x', 'purple'));
    } else {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden');
    }
  } else if (url.startsWith('/vid/')) {
    const fake = Buffer.alloc(200000, 7);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(fake.length) });
    res.end(fake);
  } else if (url.startsWith('/dash/')) {
    const body = Buffer.alloc(40000, 5);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
    res.end(body);
  } else if (url === '/many') {
    // 40 张图（图片走 localhost，和页面 127.0.0.1 分开连接池：挂起的下载不堵页面导航）
    // + 12 个 <video> + 两条孤立 DASH 画面轨（无声音轨）+ 一条孤立 DASH 音频轨
    const imgs = Array.from({ length: 40 }, (_, i) =>
      `<img src="http://localhost:${port}/img/p${String(i + 1).padStart(2, '0')}.svg" width="300" height="300">`).join('');
    const vids = Array.from({ length: 12 }, (_, i) =>
      `<video src="/vid/clip${String(i + 1).padStart(2, '0')}.mp4" preload="auto" width="320" height="180"></video>`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>四十张图测试页</title><body>${imgs}${vids}<script>
      (async () => {
        for (let i = 0; i < 2; i++) {
          await fetch('/dash/aaa111-1-30080.m4s?range=' + i);
          await fetch('/dash/bbb222-1-30080.m4s?range=' + i);
          await fetch('/dash/ccc333-1-30280.m4s?range=' + i);
        }
      })();
    </script></body>`);
  } else if (url === '/zippage') {
    const imgs = [1, 2, 3].map((i) => `<img src="/zimg/z${i}.svg" width="300" height="300">`).join('');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>ZIP 测试页</title><body>${imgs}<img src="/zfail/bad.svg" width="300" height="300"></body>`);
  } else if (url.startsWith('/bili/') || url.startsWith('/bili-bk/')) {
    // B站 仿真 CDN：主 CDN 一律 404，备用 CDN 正常 —— 只记录请求，内容不重要
    biliReqs.push(url.split('?')[0]);
    if (url.startsWith('/bili/')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = Buffer.alloc(60000, 9);
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(body.length) });
    res.end(body);
  } else if (url.startsWith('/video/BVpop')) {
    // B站 仿真视频页（--host-resolver-rules 把 www.bilibili.com 指到本机）：清单里带 backupUrl
    const host = `http://www.bilibili.com:${port}`;
    const t = (id, codecid, codecs, w, h, name, bw) => ({
      id, codecid, codecs, width: w, height: h, bandwidth: bw,
      baseUrl: `${host}/bili/${name}?upsig=pop&deadline=9999999999`,
      backupUrl: [`${host}/bili-bk/${name}?upsig=pop&deadline=9999999999`],
    });
    const playinfo = { code: 0, data: { quality: 32, dash: {
      video: [t(32, 7, 'avc1.64001F', 852, 480, 'pop-1-30032.m4s', 632933)],
      audio: [t(30280, 0, 'mp4a.40.2', 0, 0, 'pop-1-30280.m4s', 190000)],
      dolby: { type: 0, audio: null }, flac: null,
    } } };
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>备用线路测试_哔哩哔哩_bilibili</title>
      <script>window.__playinfo__=${JSON.stringify(playinfo)}</script><body></body>`);
  } else if (url === '/plain') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><title>全新页面</title><body><p>没有图</p></body>');
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const release = () => fetch(`${origin}/release`).catch(() => {});

// 本地 file:// 页面（popup-ux#14）
const fileDir = mkdtempSync(join(tmpdir(), 'gleaner-file-'));
for (const n of [1, 2, 3]) writeFileSync(join(fileDir, `f${n}.svg`), SVG(`f${n}`, 'olive'));
writeFileSync(
  join(fileDir, 'local.html'),
  `<!doctype html><meta charset="utf-8"><title>本地页面</title><body>${[1, 2, 3].map((n) => `<img src="f${n}.svg" width="300" height="300">`).join('')}</body>`,
);
const fileUrl = pathToFileURL(join(fileDir, 'local.html')).href;

// ---------------- 启动真 Chrome（同 e2e/run.mjs） ----------------
const downloadDir = mkdtempSync(join(tmpdir(), 'gleaner-popup-dl-'));
const profileDir = mkdtempSync(join(tmpdir(), 'gleaner-popup-profile-'));
mkdirSync(join(profileDir, 'Default'), { recursive: true });
writeFileSync(
  join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true } }),
);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: profileDir,
  ignoreDefaultArgs: ['--disable-extensions'],
  pipe: true,
  defaultViewport: { width: W, height: H },
  args: [
    '--no-first-run', '--enable-unsafe-extension-debugging', '--window-position=2200,2200', '--window-size=900,760',
    // B站 备用线路场景：让 www.bilibili.com 解析到本地测试服务器（扩展只在 B站 域名读清单）
    '--host-resolver-rules=MAP www.bilibili.com 127.0.0.1',
  ],
});

// ---------------- 弹窗里的测量工具 ----------------
/** 在弹窗里找元素：'btn:暂停' = 文本以「暂停」开头的按钮；其余当 CSS 选择器 */
const MEASURE = `(q) => {
  let el;
  if (q.startsWith('btn:')) {
    const t = q.slice(4);
    el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(t));
  } else el = document.querySelector(q);
  if (!el) return { exists: false };
  const r = el.getBoundingClientRect();
  const inside = r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return {
    exists: true, inside, hittable: Boolean(hit && (hit === el || el.contains(hit))),
    top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height),
    cx, cy, disabled: Boolean(el.disabled), text: el.textContent.trim().slice(0, 60),
  };
}`;
const measure = (p, q) => p.evaluate(`(${MEASURE})(${JSON.stringify(q)})`);
const fmt = (m) => (m.exists ? `y=${m.top}–${m.bottom} ${m.w}×${m.h}${m.hittable ? '' : ' 点不到'}` : '不存在');
async function expectVisible(p, q, name) {
  const m = await measure(p, q);
  check(name, m.exists && m.inside && m.hittable, `${fmt(m)}，视口 ${W}×${H}`);
  return m;
}
/** 整页不滚动：文档不超 600，.app 里也没有被裁掉的内容 */
async function expectNoPageScroll(p, name) {
  const s = await p.evaluate(() => {
    const se = document.scrollingElement;
    const app = document.querySelector('.app');
    const root = document.getElementById('root');
    return {
      doc: se.scrollHeight, inner: innerHeight,
      root: root ? root.scrollHeight : -1,
      app: app ? app.scrollHeight : -1, appClient: app ? app.clientHeight : -1,
    };
  });
  check(name, s.doc <= H && s.root <= H && s.app <= s.appClient + 1,
    `document.scrollingElement.scrollHeight=${s.doc}，#root=${s.root}，.app ${s.app}/${s.appClient}`);
}
/** 真鼠标点击（元素必须真的在视口里才点得到） */
async function mouseClick(p, q) {
  await p.bringToFront();
  const m = await measure(p, q);
  if (!m.exists) return false;
  await p.mouse.click(m.cx, m.cy);
  return true;
}
/** 扫描要求测试页是活动标签：切回测试页后在弹窗里点「扫描」（先确认按钮看得见、点得到） */
async function scanFrom(fixture, popup) {
  await fixture.bringToFront();
  const m = await measure(popup, 'btn:扫描');
  if (!m.exists || m.disabled) return false;
  await popup.evaluate(() =>
    [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('扫描'))?.click());
  await sleep(300);
  return waitFor(async () => (await measure(popup, 'btn:扫描当前页面')).exists, 20000);
}
const progressText = (p, kind) =>
  p.evaluate((k) => document.querySelector(`.progress.${k}`)?.innerText.replace(/\s+/g, ' ') ?? '', kind);

let exitCode = 1;
try {
  const cdp = await browser.target().createCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  const swTarget = await waitFor(
    async () => browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId)), 10000);
  check('扩展在真 Chrome 中加载', Boolean(extId && swTarget), `${extId} ← ${EXT_DIR}`);
  const popupUrl = `chrome-extension://${extId}/popup.html`;

  const popup = await browser.newPage();
  await popup.setViewport({ width: W, height: H });
  const pageErrors = [];
  popup.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
  await popup.goto(popupUrl, { waitUntil: 'domcontentloaded' });

  // 预置 12 条下载记录：第一条是长标题 + 长失败原因 + 一个在 Chrome 里早已不存在的 downloadId
  await popup.evaluate(async (t, err) => {
    const now = Date.now();
    const list = [
      { id: 'seed-long', title: t, pageUrl: 'https://www.bilibili.com/video/BV1xx', time: now - 60000, total: 5, done: 3, failed: 2, state: 'done', error: err, firstDownloadId: 987654321 },
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `seed-${i}`, title: `过往任务 ${i + 1}`, pageUrl: 'https://example.com/', time: now - (i + 2) * 3600e3,
        total: 3, done: 3, failed: 0, state: 'done',
      })),
    ];
    await chrome.storage.local.set({ 'og-history': list });
  }, LONG_TITLE, LONG_ERROR);

  const fixture = await browser.newPage();
  await fixture.goto(`${origin}/many`, { waitUntil: 'domcontentloaded' });
  await sleep(1500); // 等 <video preload> 和 DASH 分片请求发出，供后台嗅探
  await fixture.bringToFront();
  await popup.reload({ waitUntil: 'domcontentloaded' });
  await waitFor(async () => (await popup.$$('.media-row')).length >= 12, 8000);
  await sleep(300);

  // ============ popup-ux#8：媒体全部列出 ============
  await step('媒体列表', async () => {
    const info = await popup.evaluate(() => {
      const head = document.querySelector('.media .history-head span')?.textContent ?? '';
      const n = Number(head.match(/（(\d+)）/)?.[1] ?? -1);
      return { n, rows: document.querySelectorAll('.media-row').length };
    });
    check('媒体标题的条数和实际列出的行数一致（>8 条）', info.n > 8 && info.rows === info.n, `标题 ${info.n}，列出 ${info.rows} 行`);
    // 滚到媒体栏最底：最后一行（音频）看得见、下载按钮点得到
    await popup.evaluate(() => {
      const m = document.querySelector('.media');
      m.scrollTop = m.scrollHeight;
    });
    await sleep(100);
    const last = await measure(popup, '.media-row:last-child .media-dl');
    check('媒体栏滚到底能点到最后一行的「下载」', last.exists && last.inside && last.hittable, fmt(last));
    await expectNoPageScroll(popup, '媒体很多时整页不滚动');
  });

  // ============ bilibili-pipeline#12：音频行不标「无声音轨」 ============
  await step('音频行标签', async () => {
    const rows = await popup.evaluate(() =>
      [...document.querySelectorAll('.media-row')].map((r) => r.innerText.replace(/\s+/g, ' ')));
    const audio = rows.filter((r) => r.startsWith('音频'));
    const loneVideo = rows.filter((r) => /aaa111|bbb222/.test(r));
    check('纯音频行不显示「无声音轨」', audio.length > 0 && audio.every((r) => !/无声音轨/.test(r)), audio.join(' | ') || '(没有音频行)');
    check('没配上声音的画面轨仍标「无声音轨」', loneVideo.length === 2 && loneVideo.every((r) => /无声音轨/.test(r)), loneVideo.join(' | '));
  });

  // ============ popup-ux#12：长失败原因不挤「定位文件」 ============
  await step('记录行排版', async () => {
    const row = await popup.evaluate(() => {
      const r = [...document.querySelectorAll('.history-row')].find((x) => x.textContent.includes('超长标题'));
      if (!r) return null;
      const btn = [...r.querySelectorAll('button')].find((b) => b.textContent.includes('定位文件'));
      const err = r.querySelector('.j-error');
      const rr = r.getBoundingClientRect();
      const b = btn?.getBoundingClientRect();
      const e = err?.getBoundingClientRect();
      return {
        rowH: Math.round(rr.height),
        btnW: Math.round(b?.width ?? 0), btnH: Math.round(b?.height ?? 0),
        errW: Math.round(e?.width ?? 0), errH: Math.round(e?.height ?? 0),
        errTitle: err?.getAttribute('title') ?? '',
      };
    });
    check('长失败原因时「定位文件」保持横排（不被挤成竖排）',
      row && row.btnW >= 48 && row.btnH <= 26, row ? `按钮 ${row.btnW}×${row.btnH}` : '找不到这一行');
    check('长失败原因完整可读（单独一行，悬停看全文），整行不超过 3 行高',
      row && row.errW > 300 && row.errH > 0 && row.rowH <= 62,
      row ? `原因 ${row.errW}×${row.errH}，行高 ${row.rowH}，title=${row.errTitle ? '有' : '无'}` : '');
  });

  // ============ 扫描 40 张图 ============
  await step('扫描', async () => {
    await scanFrom(fixture, popup);
    const ok = await waitFor(async () => (await popup.$$('.cell')).length >= 40, 20000);
    check('扫描出 40 张图', ok, `实际 ${(await popup.$$('.cell')).length}`);
    await expectVisible(popup, 'btn:下载 40 张', '扫描后「下载 40 张」按钮完整可见、点得到');
    await expectNoPageScroll(popup, '40 张图时整页不滚动（图片只在图片区里滚）');
    const grid = await popup.evaluate(() => {
      const m = document.querySelector('.main');
      return { sh: m.scrollHeight, ch: m.clientHeight };
    });
    check('图片区自己可以滚动', grid.sh > grid.ch, `图片区 ${grid.ch}px 高，内容 ${grid.sh}px`);
  });

  // ============ popup-ux#1：任务进行中，所有控制都看得见 ============
  await step('开始下载', async () => {
    check('鼠标点「下载 40 张」', await mouseClick(popup, 'btn:下载 40 张'));
    const running = await waitFor(async () => (await measure(popup, 'btn:暂停')).exists, 8000);
    check('任务开始后出现「暂停」', running);
    await waitFor(async () => (await popup.$$('.job-item')).length >= 10, 5000);
    await sleep(500);
  });
  await step('进行中布局', async () => {
    await expectVisible(popup, 'btn:暂停', '「暂停」完整可见、点得到');
    await expectVisible(popup, 'btn:取消', '「取消」完整可见、点得到');
    await expectVisible(popup, 'btn:下载 40 张', '任务进行中「下载 N 张」仍完整可见');
    await expectVisible(popup, '.job-list', '正在下载列表完整可见');
    await expectVisible(popup, '.job-list .job-item', '正在下载列表的第一行点得到');
    await expectVisible(popup, '.history .history-head', '下载记录标题行可见');
    await expectNoPageScroll(popup, '任务进行中 + 40 张图 + 12 条记录，整页不滚动');
    // 鼠标滚轮在图片区滚：图片区滚，整页不动，暂停钮原位
    await popup.bringToFront();
    const before = await measure(popup, 'btn:暂停');
    const main = await measure(popup, '.main');
    check('任务进行中图片区仍有可用高度（≥120px）', main.exists && main.inside && main.h >= 120, fmt(main));
    // 鼠标放在图片区里、媒体栏下面（媒体栏自己也能滚，滚轮会先被它吃掉）
    const mediaBox = await measure(popup, '.media');
    const wy = mediaBox.exists && mediaBox.bottom + 12 < main.bottom ? mediaBox.bottom + 8 : main.bottom - 10;
    await popup.mouse.move(W / 2, wy);
    for (let i = 0; i < 6; i++) await popup.mouse.wheel({ deltaY: 400 });
    await sleep(300);
    const after = await measure(popup, 'btn:暂停');
    const scrolls = await popup.evaluate(() => ({ win: scrollY, main: document.querySelector('.main').scrollTop }));
    check('滚轮只滚图片区，整页不动、暂停钮不移位',
      scrolls.win === 0 && scrolls.main > 0 && after.top === before.top && after.inside,
      `window.scrollY=${scrolls.win}，图片区 scrollTop=${scrolls.main}，暂停钮 ${before.top}→${after.top}`);
    const toolbar = await measure(popup, '.toolbar');
    check('图片区滚动时「过滤/全选」条贴在顶部', toolbar.exists && toolbar.inside && toolbar.hittable && Math.abs(toolbar.top - main.top) <= 1, fmt(toolbar));
    const cellHit = await popup.evaluate(() => {
      const m = document.querySelector('.main').getBoundingClientRect();
      const tb = document.querySelector('.toolbar').getBoundingClientRect();
      const el = document.elementFromPoint(m.left + 60, (tb.bottom + m.bottom) / 2);
      return Boolean(el?.closest('.cell'));
    });
    check('滚动后图片格子点得到', cellHit);
    await popup.screenshot({ path: SHOT });
    console.log(`  截图：${SHOT}`);
  });
  await step('展开 AI 设置', async () => {
    // 顶部内容变多（AI 设置展开）也不能把底部控制条挤出去
    await popup.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'AI 设置')?.click());
    await sleep(300);
    const opened = await popup.evaluate(() => Boolean(document.querySelector('.agent-settings')));
    check('AI 设置已展开', opened);
    await expectVisible(popup, 'btn:暂停', '展开 AI 设置时「暂停」仍完整可见');
    await expectVisible(popup, 'btn:下载 40 张', '展开 AI 设置时「下载 N 张」仍完整可见');
    await expectVisible(popup, '.job-list', '展开 AI 设置时正在下载列表仍完整可见');
    await expectNoPageScroll(popup, '展开 AI 设置 + 任务进行中，整页不滚动');
    await popup.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '收起')?.click());
    await sleep(200);
  });

  // ============ 暂停 → 扫描：继续/取消不能消失（popup-ux#11） ============
  await step('暂停', async () => {
    check('鼠标点「暂停」', await mouseClick(popup, 'btn:暂停'));
    const paused = await waitFor(async () => (await measure(popup, 'btn:继续')).exists, 6000);
    check('暂停后显示「继续」', paused, await progressText(popup, 'job'));
    await expectVisible(popup, 'btn:继续', '「继续」完整可见、点得到');
    await expectVisible(popup, 'btn:取消', '暂停时「取消」完整可见、点得到');
  });
  await step('暂停后扫描', async () => {
    const scanned = await scanFrom(fixture, popup);
    check('暂停状态下重新扫描完成', scanned);
    await sleep(1200);
    await expectVisible(popup, 'btn:继续', '暂停后点「扫描」，「继续」仍在');
    await expectVisible(popup, 'btn:取消', '暂停后点「扫描」，「取消」仍在');
    const rows = (await popup.$$('.job-item')).length;
    check('暂停后点「扫描」，正在下载列表仍在', rows > 0, `${rows} 行`);
  });

  // ============ 取消后「已取消」要留住（popup-ux#6） ============
  await step('取消', async () => {
    check('鼠标点「取消」', await mouseClick(popup, 'btn:取消'));
    const shown = await waitFor(async () => /已取消/.test(await progressText(popup, 'job')), 8000);
    check('进度条显示「已取消」', shown, await progressText(popup, 'job'));
    await sleep(2000); // 期间 GET_STATE 会刷新好几次
    const t = await progressText(popup, 'job');
    check('2 秒后「已取消」仍在进度条上（没被 GET_STATE 盖掉）', /已取消/.test(t), t);
    check('取消后暂停/继续/取消按钮收起', !(await measure(popup, 'btn:暂停')).exists && !(await measure(popup, 'btn:继续')).exists);
  });
  holdDownloads = false;
  await release();

  // ============ 定位文件：找不到文件时给出说明（popup-ux#13） ============
  await step('定位文件', async () => {
    // 后台 showDefaultFolder 换成计数器，别在测试机上真的弹出访达窗口
    const sw = await swTarget.worker();
    await sw.evaluate(() => {
      globalThis.__ogShowDefault = 0;
      const stub = (...a) => {
        globalThis.__ogShowDefault++;
        const cb = a[a.length - 1];
        if (typeof cb === 'function') cb();
        return Promise.resolve();
      };
      try { chrome.downloads.showDefaultFolder = stub; } catch {}
      if (chrome.downloads.showDefaultFolder !== stub) {
        Object.defineProperty(chrome.downloads, 'showDefaultFolder', { value: stub, configurable: true, writable: true });
      }
    });
    const btn = await popup.evaluate(() => {
      const r = [...document.querySelectorAll('.history-row')].find((x) => x.textContent.includes('超长标题'));
      const b = r && [...r.querySelectorAll('button')].find((x) => x.textContent.includes('定位文件'));
      if (!b) return null;
      b.scrollIntoView({ block: 'nearest' });
      const rr = b.getBoundingClientRect();
      return { cx: rr.left + rr.width / 2, cy: rr.top + rr.height / 2 };
    });
    if (!btn) return check('找到长标题记录的「定位文件」', false);
    await popup.bringToFront();
    await popup.mouse.click(btn.cx, btn.cy);
    const note = await waitFor(async () => popup.evaluate(() => document.querySelector('.flash')?.textContent ?? ''), 5000);
    check('点「定位文件」找不到文件时，弹窗说明已退回默认下载目录', /默认下载目录/.test(note || ''), note || '(没有任何提示)');
    const calls = await sw.evaluate(() => globalThis.__ogShowDefault).catch(() => -1);
    check('后台确实改为打开默认下载目录', calls >= 1, `showDefaultFolder 调用 ${calls} 次`);
  });

  // ============ 旧任务不冒充当前状态（popup-ux#10） + ZIP 结果留住（popup-ux#6） ============
  await step('新页面', async () => {
    await fixture.goto(`${origin}/zippage`, { waitUntil: 'load' });
    await fixture.bringToFront();
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1200);
    const n = (await popup.$$('.progress')).length;
    check('换页重开弹窗：不显示上一个已结束任务的进度条', n === 0, n ? await popup.evaluate(() => document.querySelector('.progress').innerText.replace(/\s+/g, ' ')) : '无进度条');
    const hist = await popup.evaluate(() => document.querySelector('.history')?.innerText ?? '');
    check('上一个任务仍在下载记录里（已取消）', /已取消/.test(hist));
  });
  await step('失败说明', async () => {
    await scanFrom(fixture, popup);
    const ok = await waitFor(async () => (await popup.$$('.cell')).length >= 4, 10000);
    check('ZIP 页扫描出 4 张图', ok, `实际 ${(await popup.$$('.cell')).length}`);
    // 先普通下载一次：第 4 张被服务器拒绝，任务结束时后台广播「1 个失败：原因」
    check('鼠标点「下载 4 张」（普通下载）', await mouseClick(popup, 'btn:下载 4 张'));
    const settled = await waitFor(async () => /个失败/.test(await progressText(popup, 'job')), 20000);
    check('任务结束显示「1 个失败：原因」', settled, await progressText(popup, 'job'));
    await sleep(2000);
    const t = await progressText(popup, 'job');
    check('2 秒后「1 个失败：原因」仍在（没被 GET_STATE 盖掉）', /1 个失败：.+/.test(t) && /3\/4/.test(t), t);
  });
  await step('ZIP', async () => {
    await popup.evaluate(() => {
      const zip = [...document.querySelectorAll('footer label')].find((l) => l.textContent.includes('ZIP'))?.querySelector('input');
      if (zip && !zip.checked) zip.click();
    });
    check('鼠标点「下载 4 张」（打包成 ZIP）', await mouseClick(popup, 'btn:下载 4 张'));
    const saw = await waitFor(async () => /正在抓取并打包|ZIP 已保存/.test(await progressText(popup, 'zip')), 5000);
    check('打包期间进度条显示「正在抓取并打包」而不是上一个任务', saw, (await progressText(popup, 'zip')) || (await progressText(popup, 'job')));
    const done = await waitFor(async () => /ZIP 已保存/.test(await progressText(popup, 'zip')), 20000);
    check('打包结束显示「ZIP 已保存」', done, (await progressText(popup, 'zip')) || (await progressText(popup, 'job')));
    await sleep(2000);
    const t = await progressText(popup, 'zip');
    check('2 秒后「ZIP 已保存，1 张抓取失败未入包」仍在，数字是这次的 3/4',
      /ZIP 已保存，1 张抓取失败未入包/.test(t) && /3\/4/.test(t), t || (await progressText(popup, 'job')));
    check('ZIP 时没有冒出上一个任务的进度条', (await popup.$$('.progress.job')).length === 0);
  });

  // ============ B站 备用 CDN 地址随下载请求一起发给后台 ============
  await step('B站备用线路', async () => {
    await fixture.goto(`http://www.bilibili.com:${server.address().port}/video/BVpop/`, { waitUntil: 'load' });
    await sleep(800);
    await fixture.bringToFront();
    await popup.reload({ waitUntil: 'domcontentloaded' });
    const row = await waitFor(async () =>
      popup.evaluate(() => [...document.querySelectorAll('.media-row')].map((r) => r.innerText.replace(/\s+/g, ' ')).find((t) => /B站/.test(t))), 8000);
    check('B站 清单条目出现在媒体列表', Boolean(row), row || '(没有)');
    if (!row) return;
    // 记录弹窗发给后台的消息
    await popup.evaluate(() => {
      window.__sent = [];
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (...a) => {
        window.__sent.push(JSON.parse(JSON.stringify(a[0])));
        return orig(...a);
      };
    });
    await popup.evaluate(() => {
      const r = [...document.querySelectorAll('.media-row')].find((x) => /B站/.test(x.innerText));
      r?.querySelector('.media-dl')?.click();
    });
    const msg = await waitFor(async () =>
      popup.evaluate(() => window.__sent.find((m) => m?.type === 'DOWNLOAD_MEDIA') ?? null), 5000);
    check('DOWNLOAD_MEDIA 带上画面轨备用地址',
      msg && Array.isArray(msg.backupUrls) && msg.backupUrls.some((u) => u.includes('/bili-bk/pop-1-30032.m4s')),
      JSON.stringify(msg?.backupUrls ?? null));
    check('DOWNLOAD_MEDIA 带上声音轨备用地址',
      msg && Array.isArray(msg.audioBackupUrls) && msg.audioBackupUrls.some((u) => u.includes('/bili-bk/pop-1-30280.m4s')),
      JSON.stringify(msg?.audioBackupUrls ?? null));
    // 仅供参考（后台重试策略不归弹窗管）：主 CDN 404 后有没有去备用 CDN
    const tried = await waitFor(async () => biliReqs.some((u) => u.startsWith('/bili-bk/')), 8000);
    console.log(`  （参考）后台请求：${[...new Set(biliReqs)].join(' ') || '无'}${tried ? '' : '，没看到备用 CDN 请求'}`);
    // 等这个任务结束，别和后面的场景搅在一起
    const settled = () => waitFor(async () => {
      const st = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }).then((r) => r?.progress?.state));
      return st === 'done' || st === 'cancelled';
    }, 30000);
    await settled();
    // 勾选这一行 →「下载选中 1 项」（DOWNLOAD_MIXED）同样要带备用地址
    await popup.evaluate(() => {
      const r = [...document.querySelectorAll('.media-row')].find((x) => /B站/.test(x.innerText));
      const cb = r?.querySelector('input[type=checkbox]');
      if (cb && !cb.checked) cb.click();
    });
    await sleep(200);
    check('勾选后出现「下载选中 1 项」', await mouseClick(popup, 'btn:下载选中'));
    const mixed = await waitFor(async () =>
      popup.evaluate(() => window.__sent.find((m) => m?.type === 'DOWNLOAD_MIXED') ?? null), 5000);
    const mm = mixed?.media?.[0];
    check('DOWNLOAD_MIXED 的媒体项带上画面轨和声音轨备用地址',
      mm && mm.backupUrls?.some((u) => u.includes('/bili-bk/pop-1-30032.m4s')) &&
        mm.audioBackupUrls?.some((u) => u.includes('/bili-bk/pop-1-30280.m4s')),
      JSON.stringify(mm ?? null));
    await settled();
  });

  // ============ 真正的工具栏弹窗（chrome.action.openPopup）：尺寸和按钮位置 ============
  await step('真弹窗', async () => {
    await fixture.goto(`${origin}/many`, { waitUntil: 'domcontentloaded' });
    await fixture.bringToFront();
    await sleep(500);
    const sw = await swTarget.worker();
    const opened = await sw.evaluate(() => chrome.action.openPopup().then(() => 'ok', (e) => String(e?.message ?? e)));
    const t = await browser
      .waitForTarget((x) => x.url().includes(`${extId}/popup.html`) && x !== popup.target(), { timeout: 5000 })
      .catch(() => null);
    check('打开真正的工具栏弹窗', opened === 'ok' && t, opened);
    if (!t) return;
    const real = await t.asPage();
    await sleep(600);
    await real.evaluate(() =>
      [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith('扫描'))?.click());
    await waitFor(async () => (await real.$$('.cell')).length >= 40, 20000);
    const size = await real.evaluate(() => [innerWidth, innerHeight]);
    check('真弹窗尺寸是 740×600', size[0] === W && size[1] === H, size.join('×'));
    await expectVisible(real, 'btn:下载 40 张', '真弹窗里 40 张图时「下载 40 张」完整可见、点得到');
    await expectVisible(real, 'btn:扫描当前页面', '真弹窗里「扫描当前页面」完整可见');
    await expectNoPageScroll(real, '真弹窗 40 张图时整页不滚动');
    await real.close().catch(() => {});
  });

  // ============ popup-ux#14：本地文件页 ============
  const fileCase = async (label, popup) => {
    await fixture.goto(fileUrl, { waitUntil: 'load' });
    await fixture.bringToFront();
    await popup.reload({ waitUntil: 'domcontentloaded' });
    await sleep(1000);
    const allowed = await popup.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
    const notice = await popup.evaluate(() => document.querySelector('.notice')?.innerText ?? '');
    const scanBtn = await measure(popup, 'btn:扫描');
    if (allowed) {
      check(`${label}：已允许访问文件网址 → 不拦截`, !notice && scanBtn.exists && !scanBtn.disabled, notice || '无拦截提示，扫描按钮可用');
      const scanned = await scanFrom(fixture, popup);
      const cells = (await popup.$$('.cell')).length;
      check(`${label}：本地页面能扫描出图片`, scanned && cells >= 3, `实际 ${cells} 张`);
    } else {
      check(`${label}：未允许访问文件网址 → 提示去打开，扫描按钮禁用`,
        /允许访问文件网址/.test(notice) && scanBtn.disabled && (await measure(popup, 'btn:去设置')).exists, notice);
      await popup.evaluate(() =>
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '去设置')?.click());
      const t = await browser
        .waitForTarget((x) => x.url().startsWith('chrome://extensions'), { timeout: 5000 })
        .catch(() => null);
      check(`${label}：「去设置」打开扩展详情页`, Boolean(t), t?.url() ?? '没打开');
      if (t) await (await t.asPage()).close().catch(() => {});
    }
    return allowed;
  };
  await step('本地文件', async () => {
    const first = await fileCase('本地文件页', popup);
    // 用扩展管理页切换「允许访问文件网址」，把另一种情况也测一遍
    const mgr = await browser.newPage();
    await mgr.goto(`chrome://extensions/?id=${extId}`, { waitUntil: 'domcontentloaded' });
    const toggled = await mgr
      .evaluate((id, v) => new Promise((r) => {
        chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: v }, () => r(!chrome.runtime.lastError));
      }), extId, !first)
      .catch(() => false);
    // 切换会让 Chrome 重载扩展；用 CDP 装的解压扩展重载后停在「已停用」，手动再启用
    await sleep(800);
    await mgr
      .evaluate((id) => new Promise((r) => chrome.management.setEnabled(id, true, () => r(!chrome.runtime.lastError))), extId)
      .catch(() => false);
    await mgr.close();
    if (!toggled) return console.log('  （无法切换「允许访问文件网址」，另一种情况跳过）');
    // 切换后 Chrome 会重载扩展
    await sleep(1500);
    await waitFor(async () => browser.targets().some((t) => t.type() === 'service_worker' && t.url().includes(extId)), 8000);
    // 扩展重载会关掉旧的弹窗页，另开一个
    const popup2 = await browser.newPage();
    await popup2.setViewport({ width: W, height: H });
    popup2.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));
    // 扩展重载期间打开会被拦（ERR_BLOCKED_BY_CLIENT），等它重新起来
    const opened = await waitFor(
      () => popup2.goto(popupUrl, { waitUntil: 'domcontentloaded' }).then(() => popup2.evaluate(() => Boolean(document.querySelector('.app')))),
      15000,
    );
    if (!opened) return check('切换授权后弹窗能重新打开', false);
    const second = await fileCase('切换后', popup2);
    check('两种授权状态都覆盖到', second !== first);
  });

  check('弹窗没有页面级报错', pageErrors.length === 0, pageErrors.join(' | '));
  const bad = results.filter(([, ok]) => !ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  exitCode = bad.length ? 1 : 0;
} catch (e) {
  console.log('✗ 运行出错', String(e?.stack ?? e).slice(0, 400));
} finally {
  holdDownloads = false;
  await release();
  await browser.close().catch(() => {});
  server.close();
  for (const d of [downloadDir, profileDir, fileDir]) rmSync(d, { recursive: true, force: true });
  process.exit(exitCode);
}
