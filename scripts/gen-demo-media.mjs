/**
 * 生成 README 截图演示页用的视频和音频（只需跑一次，结果已提交在 docs/demo/）：
 * - timelapse.mp4：在 docs/demo/bay.jpg（CC0 照片）上做 8 秒缓慢推镜，配一段海浪般的底噪
 * - ambience.m4a：同一段底噪
 * 用扩展自带的 ffmpeg.wasm 在真 Chrome 里生成，不依赖本机装 ffmpeg。
 *
 * 用法：node scripts/gen-demo-media.mjs   （需要先 npm install，src/public/ffmpeg 里要有 ffmpeg-core）
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const FF = join(ROOT, 'src/public/ffmpeg');
const DEMO = join(ROOT, 'docs/demo');

const server = http.createServer((req, res) => {
  const f = (req.url ?? '').slice(1);
  if (f === '') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>gen</title>');
  }
  if (/^ffmpeg-core\.(js|wasm)$/.test(f)) {
    res.writeHead(200, { 'content-type': f.endsWith('.wasm') ? 'application/wasm' : 'text/javascript' });
    return res.end(readFileSync(join(FF, f)));
  }
  if (f === 'bay.jpg') {
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    return res.end(readFileSync(join(DEMO, 'bay.jpg')));
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}/`;

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, pipe: true, userDataDir: mkdtempSync(join(tmpdir(), 'gleaner-gen-')),
});
try {
  const page = await browser.newPage();
  await page.goto(origin);
  const out = await page.evaluate(async (base) => {
    await new Promise((ok, bad) => {
      const s = document.createElement('script');
      s.src = base + 'ffmpeg-core.js';
      s.onload = ok;
      s.onerror = bad;
      document.head.appendChild(s);
    });
    const wasmBinary = new Uint8Array(await (await fetch(base + 'ffmpeg-core.wasm')).arrayBuffer());
    const logs = [];
    const core = await window.createFFmpegCore({ wasmBinary, locateFile: (p) => base + p, print: (m) => logs.push(m), printErr: (m) => logs.push(m) });
    core.FS.writeFile('bay.jpg', new Uint8Array(await (await fetch(base + 'bay.jpg')).arrayBuffer()));
    const run = (...args) => { core.reset?.(); core.exec(...args); return core.ret; };
    // 海浪般的底噪：棕噪声 + 低通 + 淡入淡出
    const ambience = 'anoisesrc=color=brown:amplitude=0.22:duration=8,lowpass=f=700,afade=t=in:d=1.2,afade=t=out:st=6.6:d=1.4';
    const a = run('-f', 'lavfi', '-i', ambience, '-c:a', 'aac', '-b:a', '96k', 'ambience.m4a');
    // 缓慢推镜：先放大到 4000 宽再 zoompan，避免小整数步进造成的抖动
    const v = run(
      '-loop', '1', '-i', 'bay.jpg', '-i', 'ambience.m4a',
      '-vf', "scale=4000:-2,zoompan=z='min(zoom+0.0006,1.12)':d=200:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1280x720:fps=25",
      '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'medium', '-crf', '24',
      '-c:a', 'copy', '-shortest', '-movflags', '+faststart', 'timelapse.mp4',
    );
    const b64 = (u8) => {
      let s = '';
      for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return btoa(s);
    };
    if (a !== 0 || v !== 0) return { err: `ffmpeg 退出码 audio=${a} video=${v}`, logs: logs.slice(-15) };
    return { mp4: b64(core.FS.readFile('timelapse.mp4')), m4a: b64(core.FS.readFile('ambience.m4a')) };
  }, origin);
  if (out.err) {
    console.error(out.err, '\n' + out.logs.join('\n'));
    process.exitCode = 1;
  } else {
    writeFileSync(join(DEMO, 'timelapse.mp4'), Buffer.from(out.mp4, 'base64'));
    writeFileSync(join(DEMO, 'ambience.m4a'), Buffer.from(out.m4a, 'base64'));
    console.log('✓ docs/demo/timelapse.mp4、ambience.m4a');
  }
} finally {
  await browser.close();
  server.close();
}
