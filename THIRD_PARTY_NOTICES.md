# 第三方组件声明 / Third-party notices

拾穗 Gleaner 自己的代码以 [MIT](LICENSE) 许可发布。**发布的扩展安装包**（Releases 里的 zip）还打包了下列第三方组件，
它们各自遵循自己的许可证。安装包里的 `licenses/` 目录附有：本项目的 `LICENSE`、这份说明、以及所有组件的许可证全文
`THIRD_PARTY_LICENSES.txt`（由 [`scripts/prepare-public.mjs`](scripts/prepare-public.mjs) 在装依赖时生成）。

## FFmpeg / ffmpeg.wasm 核心（GPL-2.0-or-later）

- 文件：安装包里的 `ffmpeg/ffmpeg-core.js`、`ffmpeg/ffmpeg-core.wasm`。
- 来源：npm 包 [`@ffmpeg/core@0.12.10`](https://www.npmjs.com/package/@ffmpeg/core/v/0.12.10)，即 ffmpeg.wasm 项目的官方构建，**未做任何修改**。
  本仓库不包含这两个文件，装依赖时从该 npm 包原样复制。
- 用途：只在「把视频的画面轨和声音轨合并成一个文件」时，在扩展的 offscreen 页面里加载，用 `-c copy` 换容器，不重新编码。
- 许可证：该构建启用了 `--enable-gpl`，整体按 **GPL-2.0-or-later** 分发。**因此包含它的扩展安装包在再分发时须遵守 GPL。**
- 对应源代码：
  - ffmpeg.wasm 构建脚本（Dockerfile 固定了下表每个组件的版本）：<https://github.com/ffmpegwasm/ffmpeg.wasm/tree/v0.12.10>
  - 下表每个组件的源码地址。

| 组件 | 版本 / 标签 | 许可证 | 源码 |
|---|---|---|---|
| FFmpeg | n5.1.4 | GPL-2.0-or-later（本构建） | <https://github.com/FFmpeg/FFmpeg/tree/n5.1.4> |
| x264 | 4-cores 分支 | GPL-2.0-or-later | <https://github.com/ffmpegwasm/x264/tree/4-cores> |
| x265 | 3.4 | GPL-2.0-or-later | <https://github.com/ffmpegwasm/x265/tree/3.4> |
| libvpx | v1.13.1 | BSD-3-Clause（另附专利授权） | <https://github.com/ffmpegwasm/libvpx/tree/v1.13.1> |
| LAME | master | LGPL-2.0-or-later | <https://github.com/ffmpegwasm/lame> |
| libogg | v1.3.4 | BSD-3-Clause | <https://github.com/ffmpegwasm/Ogg/tree/v1.3.4> |
| libtheora | v1.1.1 | BSD-3-Clause | <https://github.com/ffmpegwasm/theora/tree/v1.1.1> |
| Opus | v1.3.1 | BSD-3-Clause | <https://github.com/ffmpegwasm/opus/tree/v1.3.1> |
| libvorbis | v1.3.3 | BSD-3-Clause | <https://github.com/ffmpegwasm/vorbis/tree/v1.3.3> |
| zlib | v1.2.11 | Zlib | <https://github.com/ffmpegwasm/zlib/tree/v1.2.11> |
| libwebp | v1.3.2 | BSD-3-Clause（另附专利授权） | <https://github.com/ffmpegwasm/libwebp/tree/v1.3.2> |
| FreeType | VER-2-10-4 | FreeType License（FTL） | <https://github.com/ffmpegwasm/freetype2/tree/VER-2-10-4> |
| FriBidi | v1.0.9 | LGPL-2.1-or-later | <https://github.com/fribidi/fribidi/tree/v1.0.9> |
| HarfBuzz | 5.2.0 | MIT（Old MIT） | <https://github.com/harfbuzz/harfbuzz/tree/5.2.0> |
| libass | 0.15.0 | ISC | <https://github.com/libass/libass/tree/0.15.0> |
| zimg | release-3.0.5 | WTFPL | <https://github.com/sekrit-twc/zimg/tree/release-3.0.5> |

Portions of this software are copyright © The FreeType Project (www.freetype.org). All rights reserved.

各组件的许可证原文取自上表对应标签的官方仓库，存放在本仓库 [`licenses/third-party/`](licenses/third-party/)。

## 其它打包进扩展的库

| 组件 | 许可证 |
|---|---|
| [React / React DOM / scheduler](https://github.com/facebook/react) | MIT |
| [JSZip](https://github.com/Stuk/jszip) | MIT（该库为 MIT 或 GPL-3.0 双许可，本项目按 MIT 使用） |
| JSZip 的依赖 [pako](https://github.com/nodeca/pako)、lie、immediate、setimmediate、readable-stream | MIT（pako 为 MIT AND Zlib） |
| [Anthropic TypeScript SDK](https://github.com/anthropics/anthropic-sdk-typescript) 及其依赖 standardwebhooks | MIT |
| [WXT](https://github.com/wxt-dev/wxt) 运行时 | MIT |
| [webextension-polyfill](https://github.com/mozilla/webextension-polyfill) | MPL-2.0（未修改，源码见链接） |
