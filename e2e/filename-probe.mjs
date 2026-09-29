/**
 * 文件名真机探针：Chrome 的 chrome.downloads.download 到底收哪些文件名、拒哪些。
 *
 * 为什么要有它：单元测试只能比对 JS 字符串，而 Chrome 会按自己的规则
 * （net::IsSafePortablePathComponent）直接拒掉不合格的路径，报 "Invalid filename"，
 * 整批下载一个文件都落不了盘。这类问题只有真 Chrome 能证明。
 *
 * 做法：本地起一个 http 服务给一个小文件；临时写一个只有 downloads 权限的最小 MV3 扩展，
 * 用 CDP 的 Extensions.loadUnpacked 装进一个临时 profile 的真 Chrome；
 * 在它的 service worker 里逐个调用 chrome.downloads.download，并等到落盘完成。
 *
 *   原始电池（raw）：tests/filename-battery.ts 里的每个字符串，原样放在
 *                    「文件夹名」「整个文件名」「文件名+.txt」三个位置 —— 记录 Chrome 收/拒（这是基准事实）
 *   清洗后电池（sanitized）：同一批字符串先过项目的 sanitize/joinPath/fileNameFromUrl，
 *                    按 background.ts 的真实拼法（图片 / 视频 / ZIP）生成路径 —— 要求 100% 落盘
 *
 * 不碰开发用的浏览器和 .output 目录；临时文件放在 OG_PROBE_TMP（默认系统临时目录），跑完删除。
 * 运行：node e2e/filename-probe.mjs            （只跑清洗后电池：OG_PROBE=sanitized）
 *       OG_PROBE=raw node e2e/filename-probe.mjs
 */
import puppeteer from 'puppeteer-core';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { tsImport } from 'tsx/esm/api';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ROOT = resolve(import.meta.dirname, '..');
const TMP = process.env.OG_PROBE_TMP || tmpdir();
const MODE = process.env.OG_PROBE || 'both'; // raw | sanitized | both
const KEEP = process.env.OG_PROBE_KEEP === '1';

const { BATTERY, chromeRejectsPath } = await tsImport(join(ROOT, 'tests/filename-battery.ts'), import.meta.url);
// OG_FILENAME_MODULE 可指向另一份 filename.ts（比如改动前的备份），用来对比修复前后
const FILENAME_MODULE = resolve(process.env.OG_FILENAME_MODULE || join(ROOT, 'src/core/filename.ts'));
const { sanitize, joinPath, fileNameFromUrl } = await tsImport(FILENAME_MODULE, import.meta.url);
const CONCURRENCY = 6;
/** 按原顺序返回结果，最多 CONCURRENCY 个下载同时进行（每个都在自己的目录里，不会互相重名） */
async function pool(tasks, fn) {
  const out = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await fn(tasks[i], i);
    }
  }));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 让不可见字符在终端里看得见 */
const show = (s) =>
  Array.from(s)
    .map((c) => {
      const cp = c.codePointAt(0);
      if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(c) || (/\s/.test(c) && c !== ' ') || /\p{Noncharacter_Code_Point}/u.test(c))
        return `<U+${cp.toString(16).toUpperCase().padStart(4, '0')}>`;
      return c;
    })
    .join('')
    .replace(/^ | $/g, '␠');
const clip = (s, n = 70) => (s.length > n ? `${s.slice(0, n)}…(${s.length})` : s);

// ---------- 小文件服务器 ----------
const server = http.createServer((req, res) => {
  // octet-stream：避免 Chrome 按 MIME 改扩展名，看到的就是「文件名本身」被收还是被拒
  res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': '5' });
  res.end('probe');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const fileUrl = `http://127.0.0.1:${server.address().port}/f.bin`;

// ---------- 临时扩展 + 临时 profile ----------
const work = mkdtempSync(join(TMP, 'og-fnprobe-'));
const extDir = join(work, 'ext');
const profileDir = join(work, 'profile');
const downloadDir = join(work, 'downloads');
mkdirSync(extDir, { recursive: true });
mkdirSync(join(profileDir, 'Default'), { recursive: true });
mkdirSync(downloadDir, { recursive: true });
writeFileSync(
  join(extDir, 'manifest.json'),
  JSON.stringify({
    manifest_version: 3,
    name: 'og-filename-probe',
    version: '1.0',
    permissions: ['downloads'],
    background: { service_worker: 'sw.js' },
  }),
);
// 参数用 UTF-16 码元数组传：孤立代理等字符走 JSON/CDP 时可能被悄悄换成 U+FFFD，数组不会
writeFileSync(
  join(extDir, 'sw.js'),
  `
self.probe = async (units, url) => {
  const filename = String.fromCharCode(...units);
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  } catch (e) {
    return { accepted: false, error: String((e && e.message) || e) };
  }
  const t0 = Date.now();
  for (;;) {
    const [it] = await chrome.downloads.search({ id });
    if (it && (it.state === 'complete' || it.state === 'interrupted')) {
      return { accepted: true, state: it.state, error: it.error, finalPath: it.filename };
    }
    if (Date.now() - t0 > 8000) {
      // 卡住的下载要撤掉，否则关浏览器时 Chrome 会停在「有下载正在进行」上
      await chrome.downloads.cancel(id).catch(() => {});
      return { accepted: true, state: 'timeout', finalPath: it && it.filename };
    }
    await new Promise((r) => setTimeout(r, 40));
  }
};
`,
);
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
  args: ['--no-first-run', '--enable-unsafe-extension-debugging', '--window-position=2200,2200', '--window-size=600,400'],
});

let exitCode = 0;
try {
  const version = await browser.version();
  const cdp = await browser.target().createCDPSession();
  const { id: extId } = await cdp.send('Extensions.loadUnpacked', { path: extDir });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    target = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes(extId));
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('探针扩展的 service worker 没起来');
  const worker = await target.worker();
  console.log(`Chrome ${version} · 下载目录 ${downloadDir}\nfilename 模块：${FILENAME_MODULE}\n`);

  // 传 UTF-16 码元（Array.from(string) 是按码点切，孤立代理会丢）
  const unitsOf = (s) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
  const probe = (filename) => worker.evaluate((units, url) => self.probe(units, url), unitsOf(filename), fileUrl);

  // ================= 原始电池：基准事实 =================
  if (MODE === 'raw' || MODE === 'both') {
    console.log('================ 原始字符串（Chrome 的真实规则） ================');
    const byClass = new Map(); // cls -> { total, rejected: [] }
    const POS = [
      ['文件夹', (n, x) => `OGP-raw/${n}/${x}/a.txt`],
      ['文件名', (n, x) => `OGP-raw/${n}/f/${x}`],
      ['名+.txt', (n, x) => `OGP-raw/${n}/t/${x}.txt`],
    ];
    const tasks = BATTERY.flatMap((c, n) => POS.map(([pos, mk]) => ({ c, pos, filename: mk(n, c.s) })));
    const results = await pool(tasks, (t) => probe(t.filename));
    // 单元测试用的规则（chromeRejectsPath）逐条对照真 Chrome：对不上说明单测的规则写错了
    const mismatches = [];
    const stricter = [];
    for (let i = 0; i < BATTERY.length; i++) {
      const c = BATTERY[i];
      const cells = [];
      for (let k = 0; k < POS.length; k++) {
        const t = tasks[i * POS.length + k];
        const r = results[i * POS.length + k];
        const ok = r.accepted && r.state === 'complete';
        let note = '';
        if (!r.accepted) note = r.error;
        else if (r.state !== 'complete') note = `${r.state} ${r.error ?? ''}`.trim();
        else {
          // 落盘名和请求的不一样（被 Chrome 截断 / 改字符）也记下来
          const want = t.filename.split('/').pop();
          const got = basename(r.finalPath || '');
          if (got !== want && got.normalize('NFC') !== want.normalize('NFC')) note = `落盘为 ${clip(show(got), 40)}`;
        }
        cells.push({ pos: t.pos, ok, note });
        const predicted = chromeRejectsPath(t.filename);
        if (!predicted && !ok) {
          // 规则说能过、Chrome 却拒了：单测的规则偏松，清洗可能漏网 —— 这才是要命的
          mismatches.push(`规则偏松 ${c.label}@${t.pos}：实测拒绝(${note})，规则预测接受`);
        } else if (predicted && ok) {
          // 规则说会拒、Chrome 这次收了：规则偏严（安全）。超 255 的文件夹名实测时好时坏（卡住 / 被取消 / 偶尔成功）
          stricter.push(`${c.label}@${t.pos}：实测接受，规则预测拒绝(${predicted})`);
        }
        const e = byClass.get(c.cls) ?? { total: 0, rejected: [] };
        e.total++;
        if (!ok) e.rejected.push(`${c.label}@${t.pos}`);
        byClass.set(c.cls, e);
      }
      const line = cells.map((x) => `${x.ok ? '✓' : '✗'}${x.pos}${x.note ? `(${x.note})` : ''}`).join('  ');
      console.log(`[${c.cls}] ${c.label} 「${clip(show(c.s))}」  ${line}`);
    }
    const same = tasks.length - mismatches.length - stricter.length;
    console.log(`\n---- 单元测试规则 vs 真 Chrome：${same}/${tasks.length} 一致，规则偏严 ${stricter.length}，规则偏松 ${mismatches.length} ----`);
    for (const m of mismatches) console.log(`  ✗ ${m}`);
    for (const m of stricter) console.log(`  · 偏严（安全）${m}`);
    if (mismatches.length) exitCode = 1;
    console.log('\n---- 原始字符串按类别汇总（✗ = Chrome 拒绝或未落盘） ----');
    for (const [cls, e] of byClass) {
      console.log(`${e.rejected.length ? '✗' : '✓'} ${cls}: ${e.total - e.rejected.length}/${e.total} 通过${e.rejected.length ? `；拒：${e.rejected.join('，')}` : ''}`);
    }
    console.log('');
  }

  // ================= 清洗后电池：必须 100% =================
  if (MODE === 'sanitized' || MODE === 'both') {
    console.log('================ 经 sanitize/joinPath/fileNameFromUrl 后（按 background.ts 真实拼法） ================');
    const tasks = [];
    BATTERY.forEach((c, n) => {
      const title = c.s;
      // 与 background.ts startJob / mediaItemFor / popup ZIP 同样的拼法
      const folder = joinPath('Gleaner', title || 'page');
      // URL 里不可能有孤立代理（浏览器会编码成 U+FFFD），先转成合法字符串再编码
      const seg = encodeURIComponent(title.toWellFormed());
      const paths = [
        ['图片', joinPath(folder, fileNameFromUrl(`https://cdn.example.com/p/${seg}.jpg`, 0, 'jpg'))],
        ['视频', joinPath(folder, `${sanitize(sanitize(title || 'Gleaner'))}.mp4`)],
        ['ZIP', `${sanitize(title || 'Gleaner')}.zip`],
        ['URL无后缀', joinPath('Gleaner/x', fileNameFromUrl(`https://cdn.example.com/${seg}`, 41, 'jpg'))],
      ];
      // 前面加一层隔离目录，避免同名互相 uniquify；每段都独立校验，不影响结论
      for (const [kind, p] of paths) tasks.push({ label: `[${c.cls}] ${c.label} ${kind}`, p, filename: `OGP-san/${n}/${kind}/${p}` });
    });
    // 扩展名边界：fileNameFromUrl 直接拿 item.ext 拼
    for (const ext of ['lnk', 'url', 'local', 'scf', 'LNK', 'jpg', '']) {
      const p = joinPath('Gleaner/ext', fileNameFromUrl(`https://cdn.example.com/a.${ext}`, 0, ext));
      tasks.push({ label: `扩展名 .${ext}`, p, filename: `OGP-san/ext-${ext || 'none'}/${p}` });
    }
    const results = await pool(tasks, (t) => probe(t.filename));
    // 清洗后的路径也过一遍单测规则，保证两边口径一致
    for (const t of tasks) {
      const why = chromeRejectsPath(t.filename);
      if (why) console.log(`  (规则预测会拒：${t.label} → ${why})`);
    }
    let pass = 0;
    const total = tasks.length;
    const fails = [];
    tasks.forEach((t, i) => {
      const r = results[i];
      const ok = r.accepted && r.state === 'complete';
      if (ok) pass++;
      else fails.push(`${t.label}: 「${show(t.p)}」 → ${r.accepted ? r.state : r.error}`);
      console.log(`${ok ? '✓' : '✗'} ${t.label}: ${clip(show(t.p), 110)}${ok ? '' : `  ← ${r.accepted ? r.state : r.error}`}`);
    });
    console.log(`\n---- 清洗后：${pass}/${total} 被 Chrome 接受并落盘 ----`);
    if (fails.length) {
      console.log(fails.map((f) => `  ✗ ${f}`).join('\n'));
      exitCode = 1;
    }
  }
} catch (e) {
  console.error('探针失败：', e);
  exitCode = 2;
} finally {
  // 关不掉就直接杀：实测 Chrome 自动更新后 / 有卡住的下载时 close() 可能永远不返回
  await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
  browser.process()?.kill('SIGKILL');
  server.close();
  if (!KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`保留临时目录：${work}`);
}
process.exit(exitCode);
