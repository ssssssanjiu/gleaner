/**
 * 诊断脚本：加载扩展，把 service worker 的控制台输出和未捕获异常打出来，
 * 并确认消息监听器已注册。构建后 SW 若在顶层就炸了，e2e 只会表现成「下载不动」，这里能直接看到原因。
 * 运行：node e2e/sw-check.mjs
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT_DIR = resolve(import.meta.dirname, process.env.OG_EXT_DIR ?? '../.output-e2e/chrome-mv3');
const profileDir = mkdtempSync(join(tmpdir(), 'gleaner-swcheck-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  userDataDir: profileDir,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', '--enable-unsafe-extension-debugging', '--window-position=2200,2200', '--window-size=600,400'],
});
let exitCode = 0;
try {
  const cdp = await browser.target().createCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    target = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId));
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('没找到 service worker');
  const worker = await target.worker();
  const logs = [];
  worker.on('console', (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
  await sleep(1500);
  const probe = await worker.evaluate(async () => {
    const out = {
      hasMessageListener: chrome.runtime.onMessage.hasListeners(),
      hasDownloadListener: chrome.downloads.onChanged.hasListeners(),
      offscreenCanvas: typeof OffscreenCanvas,
      createImageBitmap: typeof createImageBitmap,
    };
    try {
      const cv = new OffscreenCanvas(40, 30);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = '#123';
      ctx.fillRect(0, 0, 40, 30);
      ctx.font = 'bold 18px sans-serif';
      ctx.fillStyle = '#fff';
      ctx.fillText('#1', 4, 20);
      const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
      out.jpegBytes = blob.size;
    } catch (e) {
      out.canvasError = String(e?.message ?? e);
    }
    return out;
  });
  console.log('SW 探针:', JSON.stringify(probe, null, 2));
  console.log('SW 控制台:', logs.length ? '\n' + logs.join('\n') : '（无输出）');
  // 通过弹窗页发一条消息，确认后台真的会回
  const p = await browser.newPage();
  await p.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  const state = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }).catch((e) => ({ err: String(e) })));
  console.log('GET_STATE 应答:', JSON.stringify(state));
  const errors = await p.evaluate(() => new Promise((r) => chrome.runtime.sendMessage({ type: '__nope__' }, (x) => r(x ?? chrome.runtime.lastError?.message))));
  console.log('未知消息应答:', JSON.stringify(errors));
  if (!probe.hasMessageListener || !state?.ok) exitCode = 1;
} catch (e) {
  console.error('sw-check 失败:', e);
  exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  rmSync(profileDir, { recursive: true, force: true });
  process.exitCode = exitCode;
}
