import type { TaskProgress } from '@/core/types';

/**
 * 弹窗进度区的视图状态。进度有两个来源，必须分开处理：
 *
 * - PROGRESS 广播：最新、带说明文字（「全部完成」「已取消」「N 个失败：原因」「ZIP 已保存…」）。
 * - GET_STATE 轮询：后台只回当前批量任务的数字，不带说明文字；
 *   ZIP 这类一次性任务不建任务，GET_STATE 回的是「上一个」批量任务。
 *
 * 以前两路都直接 setProgress，GET_STATE 晚到一步就把广播的说明文字和 ZIP 进度整个盖掉
 * （popup-ux#6），弹窗一打开还会把几天前结束的旧任务当成当前状态摆出来（popup-ux#10）。
 */
export interface ProgressView {
  /** 批量任务（有 state，可暂停/继续/取消） */
  job: TaskProgress | null;
  /** job 内容最后一次真正变化的时间 */
  jobAt: number;
  /** ZIP 这类一次性任务（没有 state） */
  oneOff: TaskProgress | null;
  oneOffAt: number;
  /** 最近一次收到广播的时间：比它早发出的 GET_STATE 回包是旧数据，不能覆盖进度 */
  lastBroadcastAt: number;
}

export const EMPTY_VIEW: ProgressView = { job: null, jobAt: 0, oneOff: null, oneOffAt: 0, lastBroadcastAt: 0 };

export const isLive = (p?: TaskProgress | null) => p?.state === 'running' || p?.state === 'paused';

const sameNumbers = (a: TaskProgress, b: TaskProgress) =>
  a.state === b.state && a.total === b.total && a.done === b.done && a.failed === b.failed;

function mergeJob(v: ProgressView, p: TaskProgress, now: number): ProgressView {
  const prev = v.job;
  // 没带说明文字的更新（后台结算后紧跟着的那次 report、GET_STATE）：
  // 数字没变就沿用上一条说明，「全部完成」「已取消」「N 个失败：原因」才留得住
  const message = p.message || (prev && prev.message && sameNumbers(prev, p) ? prev.message : undefined);
  const next: TaskProgress = { ...p, message };
  const changed = !prev || !sameNumbers(prev, next) || prev.message !== next.message;
  // 新任务开始：清掉已经结束的 ZIP 结果（还在打包的留着）
  const startedNew = isLive(next) && !isLive(prev);
  return {
    ...v,
    job: next,
    jobAt: changed ? now : v.jobAt,
    oneOff: startedNew && !v.oneOff?.running ? null : v.oneOff,
  };
}

/** 收到后台 PROGRESS 广播 */
export function onBroadcast(v: ProgressView, p: TaskProgress, now: number): ProgressView {
  if (!p.state) {
    // 纯报错广播（total 0）：同一条错误已经由请求的回包显示在错误条里，不占进度条
    if (!p.total && !p.running) return v;
    return { ...v, oneOff: p, oneOffAt: now, lastBroadcastAt: now };
  }
  return { ...mergeJob(v, p, now), lastBroadcastAt: now };
}

/**
 * GET_STATE 回包。requestedAt = 发请求的时间。
 * - 请求发出后又收到过广播：回包是旧数据，不动进度（任务列表和记录照常更新）。
 * - 弹窗还没在跟踪任何任务、而后台的任务早已结束：不摆出来，结果在「下载记录」里看。
 * - 进行中/已暂停的任务：照常恢复（关掉弹窗再打开，暂停/继续/取消和任务列表都要回来）。
 */
export function onState(v: ProgressView, p: TaskProgress | undefined, requestedAt: number, now: number): ProgressView {
  if (!p || !p.state) return v;
  if (v.lastBroadcastAt > requestedAt) return v;
  if (!v.job && !isLive(p)) return v;
  return mergeJob(v, p, now);
}

/** 重新扫描：清掉已经结束的结果，进行中/已暂停的任务和正在打包的 ZIP 一律保留（popup-ux#11） */
export function clearFinished(v: ProgressView): ProgressView {
  return {
    ...v,
    job: isLive(v.job) ? v.job : null,
    oneOff: v.oneOff?.running ? v.oneOff : null,
  };
}

/** 该显示哪几条进度 */
export function visibleBars(v: ProgressView): { job: TaskProgress | null; oneOff: TaskProgress | null } {
  const job = v.job && (isLive(v.job) || v.jobAt >= v.oneOffAt) ? v.job : null;
  const oneOff = v.oneOff && (v.oneOff.running || !job || v.oneOffAt > v.jobAt) ? v.oneOff : null;
  return { job, oneOff };
}

/** 进度条左侧的说明文字 */
export function progressLabel(p: TaskProgress): string {
  if (p.state === 'paused') return '已暂停';
  if (p.message) return p.message;
  switch (p.state) {
    case 'running':
      return '下载中';
    case 'cancelled':
      return '已取消';
    case 'done':
      return p.failed ? `${p.failed} 个失败，原因见下载记录` : '全部完成';
    default:
      return p.running ? '处理中' : '已结束';
  }
}
