import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  // e2e 用独立输出目录，避免和 dev 浏览器正在用的 .output 互相覆盖
  outDir: process.env.OG_OUT_DIR || '.output',
  modules: ['@wxt-dev/module-react'],
  // 开发时直接落在一个图多的真实页面上，别停在 about:blank——扩展扫不了空白页。
  // 持久 profile：dev 窗口的登录态、历史、下载记录跨重启保留，可当日常测试浏览器用
  runner: {
    startUrls: ['https://unsplash.com/'],
    keepProfileChanges: true,
    chromiumProfile: '.wxt/chrome-profile',
  },
  manifest: ({ browser }) => ({
    name: '拾穗 Gleaner · 网页原图/视频/音频一键下载',
    description: '一键拾取网页里的原图、视频和音频：原图自动升级、视频音画自动合并、真暂停与断点续传。零上报，全部本地处理。',
    default_locale: undefined,
    permissions: [
      'downloads',
      'storage',
      'scripting',
      'activeTab',
      // 观察模式的网络嗅探，用于捕获页面的视频/音频真实地址
      'webRequest',
      // Firefox 走 MV2 event page：自带 DOM 不需要 offscreen，
      // 也没有 declarativeNetRequest，Referer 补全暂不生效（见 README「已知限制」）
      ...(browser === 'firefox'
        ? []
        : ['offscreen', 'declarativeNetRequestWithHostAccess']),
    ],
    host_permissions: ['<all_urls>'],
    action: { default_title: '拾穗 Gleaner' },
    // ffmpeg.wasm 在 offscreen 里编译 WebAssembly，MV3 扩展页需显式放行
    ...(browser === 'firefox'
      ? {}
      : {
          content_security_policy: {
            extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
          },
        }),
  }),
});
