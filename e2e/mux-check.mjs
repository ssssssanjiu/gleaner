// 最小浏览器验证：在真扩展的 offscreen 页里，用打包的 ffmpeg.wasm 合并两条真实 B站 轨道。
// 只开一个扩展页，不做任何页面导航（规避 flaky）。
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT_DIR = resolve(import.meta.dirname, '../.output-e2e/chrome-mv3');
// 分轨文件前缀：默认用仓库里 ffmpeg 生成的版权干净样本；
// 想用真实 B站 分轨：OG_TRACK_BASE=<前缀>（需要 <前缀>_视频.mp4 和 <前缀>_音频.mp4）
const BASE = process.env.OG_TRACK_BASE ??
  new URL('../tests/fixtures/media/synthetic', import.meta.url).pathname;
import { existsSync } from 'node:fs';
if (!existsSync(BASE + '_视频.mp4')) { console.log('(跳过：本地无真实 B站 轨道 fixture)'); process.exit(0); }
const V = readFileSync(BASE + '_视频.mp4');
const A = readFileSync(BASE + '_音频.mp4');

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'video/mp4', 'access-control-allow-origin': '*' });
  res.end(req.url.includes('audio') ? A : V);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', '--enable-unsafe-extension-debugging'],
});
try {
  const cdp = await browser.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  await new Promise((r) => setTimeout(r, 1500));
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  [offscreen error]', String(e).slice(0, 160)));
  await page.goto(`chrome-extension://${id}/offscreen.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });

  const out = await page.evaluate(async (origin) => {
    const base = '/ffmpeg/';
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = base + 'ffmpeg-core.js';
      s.onload = res; s.onerror = () => rej(new Error('core.js 加载失败'));
      document.head.appendChild(s);
    });
    if (!window.createFFmpegCore) return { err: 'createFFmpegCore 未定义' };
    const wasmBinary = new Uint8Array(await (await fetch(base + 'ffmpeg-core.wasm')).arrayBuffer());
    const core = await window.createFFmpegCore({ wasmBinary, locateFile: (p) => base + p, print(){}, printErr(){} });
    const v = new Uint8Array(await (await fetch(origin + '/v')).arrayBuffer());
    const a = new Uint8Array(await (await fetch(origin + '/audio')).arrayBuffer());
    core.FS.writeFile('v.mp4', v);
    core.FS.writeFile('a.m4a', a);
    core.exec('-i', 'v.mp4', '-i', 'a.m4a', '-c', 'copy', '-movflags', '+faststart', 'out.mp4');
    const o = core.FS.readFile('out.mp4');
    const txt = new TextDecoder('latin1').decode(o.subarray(0, 200000));
    return { ret: core.ret, size: o.length, vSize: v.length, aSize: a.length,
             hasVideo: txt.includes('hev1') || txt.includes('hvc1') || txt.includes('avc1'),
             hasAudio: txt.includes('mp4a'), traks: (txt.match(/trak/g) || []).length };
  }, origin);

  console.log('结果:', JSON.stringify(out));
  const ok = out.ret === 0 && out.size > out.vSize && out.hasVideo && out.hasAudio && out.traks === 2;
  console.log(ok ? '✓ offscreen 里 ffmpeg 合并成功：输出含视频+音频两条轨' : '✗ 合并异常');
  process.exitCode = ok ? 0 : 1;
} catch (e) {
  console.log('✗ 失败:', String(e.message).slice(0, 160)); process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  server.close();
}
