/**
 * 真实 B站 实测：真 Chrome + 构建好的扩展 → 打开真实视频页 → 弹窗里点下载 →
 * 用 macOS AVFoundation（QuickTime 同款）核对落盘文件能不能播。
 *
 * 为什么要有：本地 e2e 只能喂本地字节，B站 CDN 的真实行为（编码选择、签名、Range）
 * 只有真站能验。2026-09 就是靠它发现「播放器在 Chrome 里选 AV1 → M1/M2 Mac 打不开」。
 *
 * 用法：npm run live-bili                       （默认几个热门/长视频）
 *      VIDEOS=BVxxx,BVyyy npm run live-bili     （指定视频）
 *      PAUSE_TEST=1 VIDEOS=BVxxx npm run live-bili（下几秒→暂停→继续，核对续传）
 * 需要能访问 bilibili.com；未登录只能拿到 480P。
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(ROOT + '/package.json');
const puppeteer = require('puppeteer-core');
const SCRATCH = mkdtempSync(join(tmpdir(), 'gleaner-live-'));
// AVFoundation 探针：第一次用时编译（macOS 自带 swiftc）
const AVPROBE = join(SCRATCH, 'avprobe');
try {
  execFileSync('swiftc', ['-O', join(ROOT, 'e2e/avprobe.swift'), '-o', AVPROBE], { stdio: 'ignore' });
} catch {
  console.warn('swiftc 不可用：跳过「能否播放」核对');
}
const EXT_DIR = process.env.EXT_DIR || ROOT + '/.output-e2e/chrome-mv3';
const VIDEOS = (process.env.VIDEOS || 'BV1uv411q7Mv,BV1i4aL6QEYX').split(',');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const downloadDir = mkdtempSync(join(SCRATCH, 'bili-dl-'));
const profileDir = mkdtempSync(join(SCRATCH, 'bili-profile-'));
mkdirSync(join(profileDir, 'Default'), { recursive: true });
writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
  download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
}));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: false,
  userDataDir: profileDir,
  ignoreDefaultArgs: ['--disable-extensions', '--mute-audio'],
  pipe: true,
  args: ['--no-first-run', '--enable-unsafe-extension-debugging', '--autoplay-policy=no-user-gesture-required',
    '--window-position=2200,2200', '--window-size=1280,800'],
});

const walk = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]) : []);

function inspect(path) {
  const buf = readFileSync(path);
  const has = (s) => buf.includes(Buffer.from(s, 'latin1'));
  const traks = (() => { let n = 0, i = -1; while ((i = buf.indexOf('trak', i + 1)) >= 0) n++; return n; })();
  let mdls = '';
  try {
    execFileSync('mdimport', [path]);
    mdls = execFileSync('mdls', ['-name', 'kMDItemCodecs', '-name', 'kMDItemDurationSeconds',
      '-name', 'kMDItemPixelHeight', '-name', 'kMDItemPixelWidth', '-name', 'kMDItemAudioChannelCount', path]).toString();
  } catch (e) { mdls = 'mdls 失败: ' + e.message; }
  let av = '';
  try { av = execFileSync(AVPROBE, [path], { timeout: 60000 }).toString(); } catch (e) { av = 'avprobe 失败: ' + e.message; }
  return {
    av,
    size: buf.length, head: buf.subarray(4, 8).toString('latin1'),
    avc1: has('avc1'), hvc1: has('hvc1'), hev1: has('hev1'), av01: has('av01'), mp4a: has('mp4a'),
    html: /<html|<!doctype/i.test(buf.subarray(0, 512).toString('latin1')), traks, mdls,
  };
}

const report = [];
try {
  const cdp = await browser.target().createCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  for (let i = 0; i < 50 && !browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId)); i++) await sleep(200);
  console.log('扩展已加载', extId);

  for (const bv of VIDEOS) {
    const r = { bv };
    report.push(r);
    const before = new Set(walk(downloadDir));
    const page = await browser.newPage();
    await page.goto(`https://www.bilibili.com/video/${bv}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(6000);
    r.title = await page.title();
    r.video = await page.evaluate(async () => {
      const v = document.querySelector('video');
      if (!v) return 'no <video>';
      v.muted = true;
      try { await v.play(); } catch (e) { return 'play() 失败: ' + e; }
      return `src=${v.currentSrc.slice(0, 40)} rs=${v.readyState} ${v.videoWidth}x${v.videoHeight}`;
    });
    await sleep(6000);
    r.playedTo = await page.evaluate(() => document.querySelector('video')?.currentTime);

    const popup = await browser.newPage();
    await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await popup.reload({ waitUntil: 'domcontentloaded' });
    let rows = [];
    for (let i = 0; i < 40; i++) {
      rows = await popup.evaluate(() => [...document.querySelectorAll('.media-row')].map((x) => x.innerText.replace(/\n+/g, ' | ')));
      if (rows.length) break;
      await sleep(250);
    }
    r.rows = rows;
    r.sniffed = await popup.evaluate(async () => {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const m = await chrome.runtime.sendMessage({ type: 'GET_MEDIA', tabId: t?.id });
      return (m?.media ?? []).map((x) => `${x.track ?? x.kind}/${x.codec ?? '?'} ${x.url.split('?')[0].split('/').pop()}${x.pairedAudioUrl ? ' +audio ' + x.pairedAudioUrl.split('?')[0].split('/').pop() : ''}`);
    });
    if (!rows.length) { r.error = '弹窗里没有媒体行'; await page.close(); await popup.close(); continue; }

    await popup.evaluate(() => document.querySelector('.media-dl')?.click());
    if (process.env.PAUSE_TEST) {
      // 下几秒 → 暂停 → 确认不落盘、进度不再涨 → 继续 → 应从断点续传
      const ctl = (a) => popup.evaluate((x) => chrome.runtime.sendMessage({ type: 'JOB_CONTROL', action: x }), a);
      await sleep(4000);
      const s1 = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
      r.beforePause = s1?.items?.map((i) => `${i.status} ${i.percent ?? '?'}%`);
      r.pause = (await ctl('pause'))?.state;
      await sleep(5000);
      const s2 = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
      r.whilePaused = { state: s2?.progress?.state, items: s2?.items?.map((i) => `${i.status} ${i.percent ?? '?'}%`),
        files: walk(downloadDir).filter((p) => !before.has(p)).length };
      r.resume = (await ctl('resume'))?.state;
    }
    const t0 = Date.now();
    let file;
    let st;
    await sleep(1500);
    while (Date.now() - t0 < 900000) {
      st = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' })).catch(() => null);
      file = walk(downloadDir).find((p) => !before.has(p) && !p.endsWith('.crdownload') && statSync(p).size > 0);
      const mine = st?.items?.some((i) => r.title && i.name.startsWith(r.title.slice(0, 6)));
      if (mine && st?.progress?.state && st.progress.state !== 'running' && (file || st.progress.failed)) break;
      await sleep(1000);
    }
    r.seconds = Math.round((Date.now() - t0) / 1000);
    r.state = st?.progress;
    r.items = st?.items;
    r.files = walk(downloadDir).filter((p) => !before.has(p)).map((p) => `${p.replace(downloadDir + '/', '')} ${statSync(p).size}B`);
    if (file) r.inspect = inspect(file);
    await page.close();
    await popup.close();
  }
} catch (e) {
  report.push({ fatal: String(e?.stack ?? e) });
} finally {
  console.log(JSON.stringify(report, null, 2));
  console.log('下载目录:', downloadDir);
  await browser.close();
}
let bad = 0;
for (const r of report) {
  const ok = r.inspect?.av?.includes('playable=true') && /codec=(avc1|hvc1)/.test(r.inspect.av) && /soun/.test(r.inspect.av);
  if (!ok) bad++;
  console.log(`${ok ? '✓' : '✗'} ${r.bv} ${r.title ?? ''} ${r.error ?? ''}`);
}
process.exit(bad ? 1 : 0);
