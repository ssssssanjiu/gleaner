// npm install 之后自动运行（postinstall），准备要打进扩展包的静态文件：
//
// 1. ffmpeg.wasm 核心：MV3 禁止远程加载代码，ffmpeg 必须打包进扩展；但 32MB 的二进制不放进 git，
//    从 @ffmpeg/core 原样复制（逐字节就是官方发布的 umd 构建），来源可查。
// 2. 许可证：扩展包是一份「副本」，MIT / BSD 等要求副本里附带版权和许可声明，
//    GPL 要求附带许可证全文和源码获取方式。生成 src/public/licenses/：
//    - LICENSE：拾穗自己的 MIT 许可证
//    - THIRD_PARTY_NOTICES.md：第三方组件说明（相对链接改成 GitHub 绝对链接，包里没有仓库文件）
//    - THIRD_PARTY_LICENSES.txt：打进包的每个库的许可证全文（npm 依赖 + ffmpeg.wasm 的各个组件）
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const REPO_URL = 'https://github.com/ssssssanjiu/gleaner/blob/main/';

// ---------- 1. ffmpeg core ----------
// @ffmpeg/core 的 exports 没导出 package.json，直接按 node_modules 路径找
const ffFrom = join(root, 'node_modules/@ffmpeg/core/dist/umd');
const ffTo = join(root, 'src/public/ffmpeg');
mkdirSync(ffTo, { recursive: true });
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  if (!existsSync(join(ffFrom, f))) throw new Error(`@ffmpeg/core 里找不到 ${f}，先 npm install`);
  copyFileSync(join(ffFrom, f), join(ffTo, f));
}

// ---------- 2. licenses ----------
const licDir = join(root, 'src/public/licenses');
mkdirSync(licDir, { recursive: true });
copyFileSync(join(root, 'LICENSE'), join(licDir, 'LICENSE'));

const notices = readFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8').replace(
  /\]\((?!https?:|#)([^)]+)\)/g,
  (_, rel) => `](${REPO_URL}${rel})`,
);
writeFileSync(join(licDir, 'THIRD_PARTY_NOTICES.md'), notices);

/** 打进扩展包的 npm 依赖（含传递依赖）。改依赖后在这里同步 */
const BUNDLED_NPM = [
  'react', 'react-dom', 'scheduler',
  'jszip', 'pako', 'lie', 'immediate', 'setimmediate', 'readable-stream',
  '@anthropic-ai/sdk', 'standardwebhooks',
  'wxt', 'webextension-polyfill',
  '@ffmpeg/core',
];
const LICENSE_FILE = /^(licen[sc]e|copying)(\.(md|markdown|txt))?$/i;
const parts = [
  '拾穗 Gleaner —— 第三方组件许可证全文 / Third-party licenses',
  '说明见同目录的 THIRD_PARTY_NOTICES.md。',
  '',
];
const missing = [];
for (const name of BUNDLED_NPM) {
  const dir = join(root, 'node_modules', name);
  if (!existsSync(dir)) {
    missing.push(`${name}（未安装）`);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  parts.push('='.repeat(78), `${name}@${pkg.version} —— ${pkg.license ?? '（未声明）'}`, '='.repeat(78));
  if (file) parts.push(readFileSync(join(dir, file), 'utf8').trim());
  else if (name === '@ffmpeg/core') parts.push('见下方 FFmpeg / 各组件许可证（该 npm 包本身不带许可证文件）。');
  else missing.push(`${name}（包里没有许可证文件，只有 package.json 的 license 字段：${pkg.license}）`);
  parts.push('');
}
// ffmpeg.wasm v0.12.10 编进 ffmpeg-core.wasm 的各个组件（许可证取自各自官方仓库对应标签，存在 licenses/third-party/）
const thirdDir = join(root, 'licenses/third-party');
for (const f of readdirSync(thirdDir).sort()) {
  parts.push('='.repeat(78), `ffmpeg-core.wasm 组件：${f.replace(/\.txt$/, '')}`, '='.repeat(78));
  parts.push(readFileSync(join(thirdDir, f), 'utf8').trim(), '');
}
if (missing.length) parts.push('注：', ...missing.map((m) => `- ${m}`));
writeFileSync(join(licDir, 'THIRD_PARTY_LICENSES.txt'), parts.join('\n') + '\n');

console.log(`已准备 src/public/ffmpeg 与 src/public/licenses${missing.length ? `（注意：${missing.join('；')}）` : ''}`);
