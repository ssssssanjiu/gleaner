import puppeteer from 'puppeteer-core';
import { resolve } from 'node:path';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXT_DIR = resolve(import.meta.dirname, '../.output-e2e/chrome-mv3');
const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-first-run', '--enable-unsafe-extension-debugging'] });
try {
  const cdp = await b.target().createCDPSession();
  const { id } = await cdp.send('Extensions.loadUnpacked', { path: EXT_DIR });
  await new Promise(r => setTimeout(r, 1500));
  const p = await b.newPage(); const errs = [];
  p.on('pageerror', e => errs.push(String(e).slice(0,150)));
  await p.goto(`chrome-extension://${id}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await new Promise(r => setTimeout(r, 1200));
  const ok = await p.evaluate(() => document.body.innerText.includes('Gleaner'));
  console.log(ok ? '✓ popup 正常渲染' : '✗ popup 空白');
  if (errs.length) console.log('  错误:', errs.join(' | '));
  process.exitCode = ok ? 0 : 1;
} catch(e){ console.log('✗', String(e.message).slice(0,120)); process.exitCode=1; }
finally { await b.close().catch(()=>{}); }
