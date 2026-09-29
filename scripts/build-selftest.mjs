// 把规则表 + 自测逻辑打成一个零依赖的单文件 HTML：selftest.html
// 任何浏览器（含手机）直接打开即可跑，不需要装扩展、不需要服务器。
import { build } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const result = await build({
  entryPoints: [join(root, 'selftest/main.ts')],
  bundle: true,
  format: 'iife',
  write: false,
  minify: false,
  target: 'es2020',
});
const js = result.outputFiles[0].text;

// 扫描器 fixture 页（selftest/fixture/index.html）用的两个 harness：把扫描器 / 打包器打成浏览器能直接加载的脚本，
// 页面里用 window.__scan(...) / window.__zip(...) 手动调用
for (const [name, code] of [
  ['scan-harness.js', `import { scanPage } from './src/core/scanner'; window.__scan = scanPage;`],
  ['zip-harness.js', `import { buildZipBlobUrl } from './src/core/zip'; window.__zip = buildZipBlobUrl;`],
]) {
  await build({
    stdin: { contents: code, resolveDir: root, loader: 'ts' },
    bundle: true,
    format: 'iife',
    target: 'es2020',
    outfile: join(root, 'selftest/fixture', name),
    alias: { '@': join(root, 'src') },
  });
}

const css = `
  :root { --bg:#fff; --fg:#16181d; --muted:#6b7280; --line:#e5e7eb; --accent:#2563eb; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181d; --fg:#e9eaee; --muted:#9aa1ac; --line:#2c3038; } }
  * { box-sizing:border-box }
  body { margin:0; padding:20px; background:var(--bg); color:var(--fg);
         font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; max-width:760px; margin-inline:auto }
  h1 { font-size:18px } h1 small { color:var(--muted); font-weight:400 }
  .summary { padding:10px 0; color:var(--muted); border-bottom:1px solid var(--line); margin-bottom:8px }
  .row { padding:12px 10px; border:1px solid var(--line); border-radius:8px; margin:8px 0 }
  .row.loading { opacity:.6 }
  .row.pass { border-color:#16a34a55 } .row.equal { border-color:#ca8a0455 }
  .row.thumb-only, .row.no-rule { border-color:#dc262699 }
  .row.both-fail { border-color:#f9731699 }
  .name { font-weight:600 } .status { margin:2px 0 6px }
  .line { font-size:13px; color:var(--fg) } .line.muted { color:var(--muted); font-size:12px }
  .line.url { font-family:ui-monospace,monospace; font-size:11px; color:var(--muted); word-break:break-all }
  .custom { margin-top:20px; padding-top:14px; border-top:1px solid var(--line) }
  .custom input { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px;
                  background:transparent; color:var(--fg); font:inherit }
`;

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>拾穗 Gleaner 规则自测</title>
<style>${css}</style>
</head>
<body>
<h1>拾穗 Gleaner 规则自测 <small>· 无需装扩展 · 生成于 ${new Date().toISOString().slice(0, 10)}</small></h1>
<div id="app"></div>
<script>${js}</script>
</body>
</html>`;

const out = join(root, 'selftest.html');
writeFileSync(out, html);
console.log(`✔ ${out}  (${(html.length / 1024).toFixed(1)} KB)`);
