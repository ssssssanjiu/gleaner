/**
 * README 顶部横幅（1280×640，@2x 输出，也可当 GitHub 社交预览图）。
 * 用真实截图（docs-shots.mjs 产出的 page-demo.png + screenshot-scan.png）拼出「浏览器 + 扩展弹窗」的产品画面。
 *
 * 版式：暗色底 + 产品背后一束暖金光 + 衬线大字（2026-09 从三版里选定）。
 * 用法：node scripts/hero.mjs [a] [输出路径]   （默认输出 docs/assets/hero.png）
 */
import puppeteer from 'puppeteer-core';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const A = (f) => readFileSync(join(ROOT, 'docs/assets', f));
const b64 = (buf) => buf.toString('base64');
const LOGO = `data:image/svg+xml;base64,${b64(A('logo.svg'))}`;
const PAGE = `data:image/png;base64,${b64(A('page-demo.png'))}`;
const POPUP = `data:image/png;base64,${b64(A('screenshot-scan.png'))}`;

const variant = process.argv[2] || 'a';
const out = process.argv[3] || join(ROOT, 'docs/assets/hero.png');

const FONTS = `
  --serif: ui-serif, 'New York', 'Iowan Old Style', Georgia, serif;
  --sans: -apple-system, 'SF Pro Display', 'Helvetica Neue', 'PingFang SC', system-ui, sans-serif;
  --cjk-serif: 'Songti SC', 'STSong', serif;`;
// 细颗粒噪点，压掉大面积渐变的「数码感」
const GRAIN = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .55 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")`;

/** 浏览器窗口 + 扩展弹窗 */
const windowMock = ({ dark, width, pageDim = 1 }) => `
  <div class="win ${dark ? 'dark' : 'light'}" style="width:${width}px">
    <div class="bar">
      <i></i><i></i><i></i>
      <div class="url">gallery.example/landscapes</div>
      <div class="ext"><img src="${LOGO}"></div>
    </div>
    <div class="viewport">
      <img class="page" src="${PAGE}" style="filter:brightness(${pageDim})">
      <img class="popup" src="${POPUP}">
    </div>
  </div>`;

const WINDOW_CSS = `
  .win{border-radius:14px;overflow:hidden;position:relative}
  .win.dark{background:#1c1b18;box-shadow:0 0 0 1px rgba(255,255,255,.07),0 50px 100px -20px rgba(0,0,0,.75),0 30px 60px -30px rgba(0,0,0,.6)}
  .win.light{background:#fff;box-shadow:0 0 0 1px rgba(20,16,8,.08),0 50px 100px -30px rgba(60,40,10,.35),0 20px 40px -20px rgba(60,40,10,.18)}
  .bar{height:38px;display:flex;align-items:center;gap:8px;padding:0 14px}
  .dark .bar{background:#252420;border-bottom:1px solid rgba(255,255,255,.05)}
  .light .bar{background:#f1efea;border-bottom:1px solid rgba(0,0,0,.06)}
  .bar i{width:11px;height:11px;border-radius:50%;display:block}
  .bar i:nth-child(1){background:#ff5f57}.bar i:nth-child(2){background:#febc2e}.bar i:nth-child(3){background:#28c840}
  .url{flex:1;margin:0 18px;height:22px;border-radius:7px;font:12px var(--sans);display:flex;align-items:center;justify-content:center}
  .dark .url{background:#1a1916;color:#8c867b}
  .light .url{background:#fff;color:#8a8378;box-shadow:inset 0 0 0 1px rgba(0,0,0,.06)}
  .ext{width:24px;height:24px;border-radius:6px;display:grid;place-items:center}
  .dark .ext{background:rgba(255,200,100,.12)} .light .ext{background:rgba(240,138,36,.12)}
  .ext img{width:16px;height:16px}
  .viewport{position:relative;height:calc(100% - 38px)}
  .page{width:100%;display:block}
  .popup{position:absolute;right:12px;top:8px;width:60%;border-radius:10px;
    box-shadow:0 0 0 1px rgba(0,0,0,.08),0 30px 60px -10px rgba(0,0,0,.45),0 12px 24px -12px rgba(0,0,0,.35)}
`;

const VARIANTS = {
  // A：暗色杂志风 —— 近黑底 + 一束暖金光，衬线大字
  a: `
  <style>
    :root{${FONTS}}
    body{margin:0;width:1280px;height:640px;overflow:hidden;background:#0c0b09;position:relative;font-family:var(--sans)}
    .glow{position:absolute;inset:0;background:
      radial-gradient(620px 420px at 78% 62%, rgba(236,164,58,.34), transparent 70%),
      radial-gradient(420px 260px at 12% 8%, rgba(255,214,150,.07), transparent 70%)}
    .grain{position:absolute;inset:0;background-image:${GRAIN};opacity:.07;mix-blend-mode:overlay}
    .left{position:absolute;left:84px;top:128px;width:440px}
    .mark{display:flex;align-items:center;gap:12px}
    .mark img{width:44px;height:44px;border-radius:11px;box-shadow:0 8px 24px rgba(240,138,36,.35)}
    .mark span{font:500 20px var(--cjk-serif);color:#d7b27a;letter-spacing:.35em}
    h1{margin:26px 0 0;font:500 104px/0.95 var(--serif);color:#f4eee4;letter-spacing:-2.5px}
    p{margin:26px 0 0;font:400 21px/1.55 var(--sans);color:#aaa294;max-width:430px}
    .rule{margin:34px 0 18px;height:1px;width:380px;background:linear-gradient(90deg,rgba(215,178,122,.55),transparent)}
    .feat{font:600 11.5px var(--sans);letter-spacing:.2em;color:#8d8578;text-transform:uppercase;line-height:2}
    .feat b{color:#d7b27a;font-weight:600}
    .stage{position:absolute;left:566px;top:96px}
    ${WINDOW_CSS}
    .win{height:448px}
  </style>
  <div class="glow"></div>
  <div class="left">
    <div class="mark"><img src="${LOGO}"><span>拾穗</span></div>
    <h1>Gleaner</h1>
    <p>Collect full-resolution images, video with sound, and audio from any web page.</p>
    <div class="rule"></div>
    <div class="feat">Original images <b>·</b> Video + audio <b>·</b> Pause &amp; resume<br>Local-first <b>·</b> Zero telemetry</div>
  </div>
  <div class="stage">${windowMock({ dark: true, width: 674, pageDim: 0.62 })}</div>
  <div class="grain"></div>`,

};

if (!VARIANTS[variant]) throw new Error(`未知版本 ${variant}（目前只有 a）`);
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, pipe: true, userDataDir: mkdtempSync(join(tmpdir(), 'gleaner-hero-')),
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 640, deviceScaleFactor: 2 });
  await page.setContent(`<!doctype html><meta charset="utf-8">${VARIANTS[variant]}`, { waitUntil: 'load' });
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: out });
  console.log(`✓ hero ${variant} → ${out}`);
} finally {
  await browser.close();
}
