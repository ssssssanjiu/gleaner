import { t } from './i18n';
/**
 * 用 ffmpeg.wasm 把 DASH 的画面轨和声音轨合成一个带声音的 MP4。
 * 只在 offscreen document 里跑（有 DOM、能编译 WebAssembly）。
 *
 * 走的是 `-c copy`（不重新编码，只换容器），单线程核心也很快。
 * 核心文件本地打包，绝不远程加载（MV3 禁止）。已用真实 B站 轨道验证：
 * 输出含 HEVC 视频轨 + AAC 音频轨，可正常播放。
 */

interface FFCore {
  FS: {
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
  };
  exec(...args: string[]): void;
  ret: number;
}

declare global {
  interface Window {
    createFFmpegCore?: (opts: Record<string, unknown>) => Promise<FFCore>;
  }
}

let corePromise: Promise<FFCore> | null = null;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(t('ffmpeg-core.js 加载失败')));
    document.head.appendChild(s);
  });
}

async function getCore(): Promise<FFCore> {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    // WXT 的 getURL 类型只认已知入口，public 里的资源用 as any 绕过
    const base = browser.runtime.getURL('/ffmpeg/' as never);
    await loadScript(base + 'ffmpeg-core.js');
    if (!window.createFFmpegCore) throw new Error(t('createFFmpegCore 未就绪'));
    const wasmBinary = new Uint8Array(await (await fetch(base + 'ffmpeg-core.wasm')).arrayBuffer());
    return window.createFFmpegCore({
      wasmBinary,
      locateFile: (p: string) => base + p,
      print: () => {},
      printErr: () => {},
    });
  })().catch((e) => {
    corePromise = null; // 失败后允许重试
    throw e;
  });
  return corePromise;
}

/**
 * 合并画面轨 + 声音轨 → 单个 MP4 的字节。
 * videoExt/audioExt 只影响 ffmpeg 的输入文件名后缀（帮它认容器），一般用 'mp4' / 'm4a'。
 */
export async function muxVideoAudio(
  video: Uint8Array,
  audio: Uint8Array,
): Promise<Uint8Array> {
  const core = await getCore();
  const vName = 'in_v.mp4';
  const aName = 'in_a.m4a';
  const outName = 'out.mp4';

  core.FS.writeFile(vName, video);
  core.FS.writeFile(aName, audio);
  try {
    // -c copy：不重编码；faststart：moov 前置，边下边播
    // -strict experimental：B站 Hi-Res 无损音轨是 FLAC，ffmpeg 往 MP4 里封 FLAC 需要它，否则直接失败
    core.exec(
      '-i', vName, '-i', aName, '-c', 'copy', '-strict', 'experimental', '-movflags', '+faststart', outName,
    );
    if (core.ret !== 0) throw new Error(t('ffmpeg 退出码 {0}', core.ret));
    const out = core.FS.readFile(outName);
    if (!out.byteLength) throw new Error(t('合并输出为空'));
    return out;
  } finally {
    for (const f of [vName, aName, outName]) {
      try {
        core.FS.unlink(f);
      } catch {
        /* 没写成功的文件 unlink 会抛，忽略 */
      }
    }
  }
}
