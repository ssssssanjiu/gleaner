/**
 * 联络表（contact sheet）布局：几十张缩略图拼成一张带编号的图发给模型。
 * 一次图片输入代替几十次 —— 成本和延迟都降一个量级。
 * 这里只算几何，画图在 background 里用 OffscreenCanvas 完成。
 */

export const SHEET_MAX_ITEMS = 48;
export const SHEET_MAX_SHEETS = 3;

export interface SheetSlot {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLayout {
  cols: number;
  rows: number;
  cell: number;
  width: number;
  height: number;
  slots: SheetSlot[];
}

export function sheetLayout(n: number, cell = 144, cols = 6): SheetLayout {
  const count = Math.max(0, Math.min(n, SHEET_MAX_ITEMS));
  const c = Math.max(1, Math.min(cols, count || 1));
  const rows = Math.max(1, Math.ceil(count / c));
  const slots: SheetSlot[] = [];
  for (let i = 0; i < count; i++) {
    slots.push({ index: i, x: (i % c) * cell, y: Math.floor(i / c) * cell, w: cell, h: cell });
  }
  return { cols: c, rows, cell, width: c * cell, height: rows * cell, slots };
}

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
