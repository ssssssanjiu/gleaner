/**
 * fMP4 容器层小修：把 HEVC 的 `hev1` 标记改成 `hvc1`。
 *
 * 为什么需要：HEVC 在 MP4 里有两种封装标记 ——
 *   - `hvc1`：参数集（VPS/SPS/PPS）放在 moov 的 hvcC 盒里
 *   - `hev1`：参数集内嵌在码流中
 * QuickTime / Finder 预览 / iOS 只认 `hvc1`，遇到 `hev1` 直接报「不兼容」，
 * 尽管文件本身完全正常（实测：macOS 元数据读到的是
 * "HEVC (Parameter Sets in Bitstream)"，时长分辨率都能解析出来）。
 *
 * B站 的 HEVC 轨恰好是 `hev1`，但它的 hvcC 盒里**同时**带着完整参数集，
 * 所以只要把 sample entry 的四字节类型名改掉，QuickTime 就能播了。
 * 这等价于 `ffmpeg -c copy -tag:v hvc1`，但不需要任何外部工具。
 */

const HEV1 = [0x68, 0x65, 0x76, 0x31]; // 'hev1'
const HVC1 = [0x68, 0x76, 0x63, 0x31]; // 'hvc1'
const HVCC = [0x68, 0x76, 0x63, 0x43]; // 'hvcC'

function matchesAt(bytes: Uint8Array, pos: number, sig: number[]): boolean {
  for (let i = 0; i < sig.length; i++) if (bytes[pos + i] !== sig[i]) return false;
  return true;
}

export interface Hev1PatchResult {
  /** 是否做了改写 */
  patched: boolean;
  /** 改写处数 */
  count: number;
}

/**
 * 原地把 `hev1` sample entry 改成 `hvc1`。
 * 只在附近能找到 `hvcC`（即参数集确实在 moov 里）时才改，
 * 否则改了会得到一个解不出参数集的坏文件。
 */
export function patchHev1ToHvc1(bytes: Uint8Array): Hev1PatchResult {
  let count = 0;
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (!matchesAt(bytes, i, HEV1)) continue;
    // sample entry 后面紧跟着若干子盒，hvcC 一定在很近的位置
    const limit = Math.min(i + 400, bytes.length - 4);
    let hasHvcC = false;
    for (let j = i; j <= limit; j++) {
      if (matchesAt(bytes, j, HVCC)) {
        hasHvcC = true;
        break;
      }
    }
    if (!hasHvcC) continue;
    bytes.set(HVC1, i);
    count++;
  }
  return { patched: count > 0, count };
}

/** 从 moov 里嗅出视频编码，比按 URL 编号猜准确 */
export function detectCodec(bytes: Uint8Array): 'h264' | 'hevc' | 'av1' | undefined {
  const head = bytes.subarray(0, Math.min(bytes.length, 200_000));
  const text = new TextDecoder('latin1').decode(head);
  if (text.includes('av01')) return 'av1';
  if (text.includes('hev1') || text.includes('hvc1')) return 'hevc';
  if (text.includes('avc1')) return 'h264';
  return undefined;
}
