import type { ColorName } from './types';

/**
 * 颜色判定：对缩略图像素做 HSL 分桶统计。
 * 「绿色的图片」这种请求在本机就能确定地回答，不用把图发给任何人。
 */

export interface ColorProfile {
  /** 各色在不透明像素里的占比 0~1 */
  share: Record<ColorName, number>;
  /** 占比最高的颜色（含黑白灰） */
  dominant: ColorName;
  /** 彩色像素里占比最高的颜色；全图无彩色时为 undefined */
  chromaticTop?: ColorName;
  opaquePixels: number;
}

const ALL: ColorName[] = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'black', 'white', 'gray', 'brown',
];
const ACHROMATIC = new Set<ColorName>(['black', 'white', 'gray']);

/** 单个像素 → 颜色名 */
export function classifyRgb(r: number, g: number, b: number): ColorName {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));

  if (l < 0.13) return 'black';
  if (l > 0.9 && s < 0.25) return 'white';
  if (s < 0.14) return 'gray';

  let h = 0;
  if (d !== 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  // 很亮的红就是粉（255,192,203 这种）
  if (h < 15 || h >= 345) return l >= 0.7 ? 'pink' : 'red';
  // 暗一点的橙就是棕（saddlebrown 139,69,19 这种）
  if (h < 42) return l < 0.42 ? 'brown' : 'orange';
  if (h < 68) return l < 0.35 ? 'brown' : 'yellow';
  if (h < 165) return 'green';
  if (h < 200) return 'cyan';
  if (h < 255) return 'blue';
  if (h < 290) return 'purple';
  return l >= 0.55 ? 'pink' : 'purple';
}

/** RGBA 像素数组 → 颜色分布 */
export function analyzePixels(data: ArrayLike<number>): ColorProfile {
  const count: Record<ColorName, number> = Object.fromEntries(ALL.map((c) => [c, 0])) as Record<ColorName, number>;
  let opaque = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 32) continue; // 透明像素不算
    opaque++;
    count[classifyRgb(data[i], data[i + 1], data[i + 2])]++;
  }
  const share = Object.fromEntries(
    ALL.map((c) => [c, opaque ? count[c] / opaque : 0]),
  ) as Record<ColorName, number>;
  let dominant: ColorName = 'gray';
  let chromaticTop: ColorName | undefined;
  let best = -1;
  let bestC = -1;
  for (const c of ALL) {
    if (count[c] > best) {
      best = count[c];
      dominant = c;
    }
    if (!ACHROMATIC.has(c) && count[c] > bestC && count[c] > 0) {
      bestC = count[c];
      chromaticTop = c;
    }
  }
  return { share, dominant, chromaticTop, opaquePixels: opaque };
}

/**
 * 「这张图算不算 X 色」：
 * - 彩色：占比 ≥ 25%，或者它是图里最主要的彩色且至少占 8%（白底绿 logo 也算绿）
 * - 黑白灰：要占到一半以上才算，否则每张带白底的图都成了「白色的图」
 */
export function matchesColor(p: ColorProfile, name: ColorName): boolean {
  if (!p.opaquePixels) return false;
  const s = p.share[name];
  if (ACHROMATIC.has(name)) return s >= 0.5;
  return s >= 0.25 || (p.chromaticTop === name && s >= 0.08);
}
