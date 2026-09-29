import type { ActionResponse, BlobResponse, Message, ZipResponse } from '@/core/messages';
import type { DownloadOptions, HistoryEntry, JobState, MediaHit, MediaItem, TaskProgress } from '@/core/types';
import { mediaRefererFor, refererFor } from '@/core/rules';
import {
  AUDIO_EXT, FRAGMENT_EXT, HLS_SEGMENT_EXT, MANIFEST_EXT, MAX_MEDIA_BYTES, VIDEO_EXT, basenameKey, codecOf, isMediaContentType,
  normalizeFragmentUrl, trackOf,
} from '@/core/media';
import { fileNameFromUrl, joinPath, sanitize } from '@/core/filename';
import { buildZipBlobUrl } from '@/core/zip';
import { mapLimit, runAgent, type AgentDeps } from '@/core/agent/run';
import { readImageSize, type ImageSize } from '@/core/imagesize';
import { askClaude } from '@/core/agent/claude';
import { sheetLayout } from '@/core/agent/sheet';
import { AGENT_SETTINGS_KEY, DEFAULT_AGENT_SETTINGS, type AgentSettings } from '@/core/agent/types';

const OFFSCREEN_PATH = 'offscreen.html';
/**
 * 页面通道（offscreen 抓取）超过这个时长没有任何进展、也没拿到 downloadId，就判定为僵死：
 * SW 在抓取期间被回收（扩展重载/崩溃/单请求超 Chrome 上限）会留下这种项，
 * 之前没有任何路径能救它，只能永远显示「下载中」。
 */
const STALE_PAGE_CHANNEL_MS = 10 * 60 * 1000;
const offscreenApi = () => (globalThis as any).chrome?.offscreen;

/**
 * offscreen 文档全局只能有一个。并发下载（画面+声音同时抓）会同时来创建，
 * 第二个必然报 "Only a single offscreen document may be created."
 * 用一个共享 Promise 做互斥：谁先来谁创建，其余等它。
 */
let offscreenReady: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const offscreen = offscreenApi();
  if (!offscreen) throw new Error('当前浏览器不支持 offscreen');
  if (!offscreenReady) {
    offscreenReady = (async () => {
      if (await offscreen.hasDocument?.()) return;
      try {
        await offscreen.createDocument({
          url: OFFSCREEN_PATH,
          reasons: ['BLOBS'],
          justification: '在有 DOM 的上下文里处理媒体字节并生成可下载的 blob',
        });
      } catch (e: any) {
        // 已存在就当成功（另一路刚好抢先创建了）
        if (!/single offscreen document/i.test(String(e?.message ?? e))) {
          offscreenReady = null;
          throw e;
        }
      }
    })();
  }
  return offscreenReady;
}

// ---------------------------------------------------------------------------
// 任务模型（对齐 Chrome 下载管理器语义）：
// - 任务归 background 所有，popup 只是视图 —— 关弹窗不影响下载
// - 逐项状态持久化到 storage；service worker 被杀后由 onChanged 事件唤醒并续跑
// - 暂停/继续/取消直接映射到 chrome.downloads 的原生状态机
// ---------------------------------------------------------------------------

interface JobItem {
  url: string;
  filename: string;
  /**
   * paused 是「逐项」的：暂停只停当时在下/在排队的项。暂停后又点了别的下载，
   * 新项照常开始 —— 之前整个任务一个 state，新下载会被塞进暂停的任务里一个都不动（审查实锤）
   */
  status: 'pending' | 'active' | 'paused' | 'done' | 'failed' | 'cancelled';
  /** 所属批次（一次「下载」点击 = 一批，各自一条下载记录） */
  batch?: string;
  /** 来源页面：防盗链重试的 Referer 用它，而不是任务里第一批的页面 */
  pageUrl?: string;
  downloadId?: number;
  /** 防盗链场景下代抓所用的标签页 */
  tabId?: number;
  /**
   * 该项最近一次有进展的时刻：发起时写入（直连和页面通道都写），每次 FETCH_PROGRESS 刷新。
   * SW 若在发起/抓取期间死掉，该项会以 active + 无 downloadId 的状态残留在 storage ——
   * reconcile 用它判断是否已僵死。
   * 直连下载也必须写：await downloads.download() 的那几毫秒里 downloadId 同样为空，
   * 之前只有页面通道写，弹窗开着时的对账会把正常起步的直连下载判成「抓取被中断」（审查实锤）。
   */
  lastActivityAt?: number;
  /** 旧字段名（0.2.0 开发版写过），读取兼容 */
  pageChannelStartedAt?: number;
  /** 已经用页面通道重试过，避免死循环 */
  retriedViaPage?: boolean;
  /**
   * 直接走页面通道，不先试 downloads API。
   * DASH 轨必须这样：既要页面的 Referer，也要拿到字节做 hev1→hvc1 修正。
   */
  preferPageChannel?: boolean;
  /** 页面通道抓取进度 0~100 */
  percent?: number;
  /** 有值时：这是要合并的画面轨，需和该声音轨用 ffmpeg 合成一个文件 */
  muxAudioUrl?: string;
  /** 备用 CDN 地址：主地址失败时 offscreen 依次换着试 */
  backupUrls?: string[];
  muxAudioBackupUrls?: string[];
  /** Chrome 给的失败原因，翻成人话展示 —— 只说「失败」用户没法排查 */
  error?: string;
  /**
   * 页面上原本能显示的地址（规则升级前）。升级后的原图地址直连、页面通道都失败时，
   * 退回下这个 —— 至少拿到页面上那张，而不是整项失败
   */
  fallbackUrl?: string;
  usedFallback?: boolean;
  /**
   * 'mux'：两条轨已抓完、ffmpeg 正在本地合并。这时暂停不了也不该暂停 ——
   * 之前暂停会把合并结果丢掉、断点字节也已释放，继续时几百 MB 从头重下（审查实锤）
   */
  phase?: 'mux';
  /**
   * 页面通道的发起令牌。暂停会把抓取中的项退回排队、继续时重新发起；
   * 旧那次抓取的结果回来时令牌已过期，必须丢弃，不能改写这一项的状态
   */
  attempt?: number;
}

interface Job {
  id: string;
  title: string;
  pageUrl: string;
  createdAt: number;
  concurrency: number;
  state: 'running' | 'paused' | 'cancelled' | 'done';
  /** 已写入下载记录。防止并发完成事件触发的双重收尾重复写记录 */
  recorded?: boolean;
  items: JobItem[];
  /** 追加进来的每一批（第一批的 id = 任务 id）。旧存档没有这个字段，按单批处理 */
  batches?: Array<{ id: string; title: string; pageUrl: string; createdAt: number }>;
}

const JOB_KEY = 'og-current-job';
const HISTORY_KEY = 'og-history';
// 必须用 storage.local：storage.session 在扩展重载时被清空，
// 会造成「下载还在跑、任务账本没了」的永久卡死（实测踩过）
const jobStore = () => browser.storage.local;

let currentJob: Job | null = null;
let jobLoaded = false;
let jobLoading: Promise<Job | null> | null = null;

/**
 * SW 冷启动时常有好几个事件同时到（多个下载完成、弹窗 GET_STATE）。
 * 必须共用同一次 storage 读取：各读各的会得到好几份任务对象，
 * 一个事件改的是 A、另一个存的是 B，更新互相覆盖（重复下载、永远「进行中」）。
 */
async function loadJob(): Promise<Job | null> {
  if (jobLoaded) return currentJob;
  jobLoading ??= jobStore()
    .get(JOB_KEY)
    .then((o) => {
      // 读取期间 startJob 可能已经设好了新任务，别用旧存档把它盖掉
      if (!jobLoaded) {
        currentJob = (o?.[JOB_KEY] as Job | undefined) ?? null;
        jobLoaded = true;
        if (currentJob) adoptOrphanFetches(currentJob);
      }
      return currentJob;
    })
    .finally(() => {
      jobLoading = null;
    });
  return jobLoading;
}

/**
 * SW 刚冷启动：上一个 SW 实例发起的页面通道抓取，结果会回给已经不存在的调用方 ——
 * 这些项会以「active 但没有 downloadId」一直挂着（之前要等 10 分钟才判僵死）。
 * 退回排队并立刻重新派发；offscreen 里同一地址的旧抓取会被接管，已抓的字节带 Range 续上。
 */
function adoptOrphanFetches(job: Job) {
  let n = 0;
  for (const it of job.items) {
    if (it.status === 'active' && it.downloadId == null && (it.preferPageChannel || it.retriedViaPage)) {
      it.status = 'pending';
      n++;
    }
  }
  if (n && job.state === 'running') queueMicrotask(() => void dispatch(job));
}

async function saveJob() {
  if (currentJob) await jobStore().set({ [JOB_KEY]: currentJob });
  else await jobStore().remove(JOB_KEY);
}

function counts(job: Job) {
  let done = 0;
  let failed = 0;
  let active = 0;
  let pending = 0;
  let paused = 0;
  for (const it of job.items) {
    if (it.status === 'done') done++;
    else if (it.status === 'failed') failed++;
    else if (it.status === 'active') active++;
    else if (it.status === 'pending') pending++;
    else if (it.status === 'paused') paused++;
  }
  return { done, failed, active, pending, paused, total: job.items.length };
}

function progressOf(job: Job, message?: string): TaskProgress {
  const c = counts(job);
  return {
    total: c.total,
    done: c.done,
    failed: c.failed,
    running: job.state === 'running',
    state: job.state,
    message,
  };
}

/** popup 可能已关闭，广播失败直接吞掉 */
function report(progress: TaskProgress) {
  browser.runtime.sendMessage({ type: 'PROGRESS', progress } satisfies Message).catch(() => {});
}

// ------------------------------- 图标角标 ----------------------------------

const actionApi = () => (browser as any).action ?? (browser as any).browserAction;

function setBadge(text: string, color?: string) {
  const a = actionApi();
  if (!a?.setBadgeText) return;
  a.setBadgeText({ text }).catch?.(() => {});
  if (color) a.setBadgeBackgroundColor?.({ color })?.catch?.(() => {});
}

let badgeClearTimer: ReturnType<typeof setTimeout> | undefined;

function updateBadge(job: Job) {
  const c = counts(job);
  clearTimeout(badgeClearTimer);
  if (job.state === 'paused') return setBadge('❚❚', '#ca8a04');
  if (job.state === 'cancelled') return setBadge('', undefined);
  if (job.state === 'done') {
    setBadge(c.failed ? '!' : '✓', c.failed ? '#dc2626' : '#16a34a');
    badgeClearTimer = setTimeout(() => setBadge(''), 6000);
    return;
  }
  setBadge(String(c.pending + c.active), '#2563eb');
}

// ------------------------------- 下载记录 ----------------------------------

let idSeq = 0;
/** 任务/批次 id。只用时间戳会撞：同一毫秒连点两次下载，两批共用一个 id，记录互相覆盖（测试实锤） */
const newJobId = () => `job-${Date.now()}-${++idSeq}`;

/** Chrome 同款语义：任务一开始就进历史（state=running），结束时原地更新 */
let historyChain: Promise<unknown> = Promise.resolve();

/**
 * 每一批（一次「下载」点击）一条记录。串行写：记录是「读 → 改 → 写」，
 * 两个完成事件同时写会互相覆盖掉对方的更新。
 */
function upsertHistory(job: Job): Promise<void> {
  const run = async () => {
    const batches = job.batches ?? [{ id: job.id, title: job.title, pageUrl: job.pageUrl, createdAt: job.createdAt }];
    const o = await browser.storage.local.get(HISTORY_KEY);
    const list = ((o?.[HISTORY_KEY] as HistoryEntry[] | undefined) ?? []);
    for (const b of batches) {
      const items = job.items.filter((i) => (i.batch ?? job.id) === b.id);
      const n = (st: JobItem['status']) => items.filter((i) => i.status === st).length;
      const open = n('pending') + n('active');
      const state: JobState =
        job.state === 'cancelled' && !open
          ? 'cancelled'
          : open
            ? 'running'
            : n('paused')
              ? 'paused'
              : 'done';
      const entry: HistoryEntry = {
        id: b.id,
        title: b.title,
        pageUrl: b.pageUrl,
        time: b.createdAt,
        total: items.length,
        done: n('done'),
        failed: n('failed'),
        state,
        error: items.find((i) => i.error)?.error,
        firstDownloadId: items.find((i) => i.status === 'done')?.downloadId,
      };
      const i = list.findIndex((e) => e.id === b.id);
      if (i >= 0) list[i] = entry;
      else list.unshift(entry);
    }
    await browser.storage.local.set({ [HISTORY_KEY]: list.slice(0, 50) });
  };
  const p = historyChain.then(run, run);
  historyChain = p.catch(() => {});
  return p;
}

async function getHistory(): Promise<HistoryEntry[]> {
  const o = await browser.storage.local.get(HISTORY_KEY);
  return (o?.[HISTORY_KEY] as HistoryEntry[] | undefined) ?? [];
}

/** Chrome 的 DownloadInterruptReason → 人话 */
function humanizeDownloadError(code?: string): string | undefined {
  if (!code) return undefined;
  const map: Record<string, string> = {
    SERVER_FORBIDDEN: '服务器拒绝（403）—— 多半是防盗链或链接已过期',
    SERVER_UNAUTHORIZED: '需要登录凭证（401）',
    SERVER_BAD_CONTENT: '服务器没有返回文件（404）',
    SERVER_FAILED: '服务器错误',
    SERVER_NO_RANGE: '服务器不支持断点续传',
    NETWORK_FAILED: '网络中断',
    NETWORK_TIMEOUT: '网络超时',
    NETWORK_DISCONNECTED: '网络已断开',
    FILE_ACCESS_DENIED: '本地文件写入被拒绝',
    FILE_NO_SPACE: '磁盘空间不足',
    FILE_NAME_TOO_LONG: '文件名过长',
    USER_CANCELED: '已取消',
  };
  return map[code] ?? code;
}

// ------------------------------- 调度核心 ----------------------------------

/** 保持最多 concurrency 个在途下载；每次落盘/失败事件后被再次调用补位 */
async function dispatch(job: Job) {
  while (job.state === 'running') {
    const c = counts(job);
    if (c.active >= job.concurrency) break;
    const next = job.items.find((i) => i.status === 'pending');
    if (!next) break;
    next.status = 'active';
    try {
      if (next.preferPageChannel || next.retriedViaPage) {
        // DASH 轨一开始就走页面通道；防盗链重试过的图片暂停后继续，也要接着走页面通道
        next.retriedViaPage = true;
        launchPageChannel(next); // 不 await：整包抓取要几十秒，会把后面的项全堵在「排队」
      } else {
        next.lastActivityAt = Date.now();
        const id = await browser.downloads.download({
          url: next.url,
          filename: next.filename,
          conflictAction: 'uniquify',
        });
        next.downloadId = id;
        // await 期间用户可能点了取消/暂停：controlJob 那一刻还没有 id，管不到这个下载
        if (next.status !== 'active') await browser.downloads.cancel(id).catch(() => {});
        // （TS 在 while 条件里把 state 收窄成了 running，但 await 期间它会变）
        else if ((job.state as Job['state']) === 'paused') {
          await browser.downloads.pause(id).catch(() => {});
          next.status = 'paused';
        }
      }
    } catch (e: any) {
      next.status = 'failed';
      // 之前这里没记原因，用户只看到「失败」无从排查
      const raw = String(e?.message ?? e);
      next.error = /invalid filename/i.test(raw)
        ? `文件名不被 Chrome 接受：${next.filename.split('/').pop()}`
        : raw;
    }
  }
  await saveJob();
  await settleIfFinished(job);
  if (!job.recorded) await upsertHistory(job);
  report(progressOf(job));
  updateBadge(job);
}

/**
 * 发起一次页面通道抓取（不 await）。attempt 是这次发起的令牌：暂停会把项退回排队、
 * 继续时重新发起 —— 旧那次的结果回来时令牌已过期，一律丢弃。
 */
function launchPageChannel(target: JobItem) {
  const attempt = (target.attempt = (target.attempt ?? 0) + 1);
  target.phase = undefined;
  // 记下起始时刻：SW 若在 offscreen 抓取期间死掉，这一项会以 active + 无 downloadId
  // 残留在 storage，reconcile 靠它判断是否已僵死（见 STALE_PAGE_CHANNEL_MS）
  target.lastActivityAt = Date.now();
  const stale = () => target.attempt !== attempt || target.status !== 'active';
  void downloadViaPage(target, stale)
    .then(async (id) => {
      if (stale()) {
        // 发起下载的一瞬间被取消/暂停：撤掉，别落盘
        await browser.downloads.cancel(id).catch(() => {});
        return;
      }
      target.downloadId = id;
      await saveJob();
      // blob 下载几乎瞬时完成，完成事件可能在上面赋值之前就飞过去了。
      // 主动对一次账把它捞回来，否则这一项会永远停在「下载中」。
      const j = await loadJob();
      if (j) {
        if (await reconcile(j)) await saveJob();
        await dispatch(j);
      }
    })
    .catch(async (e: any) => {
      if (!stale()) {
        // 这一项仍在进行、却收到「被中止」：不是用户点的暂停/取消，而是抓取被打断了。
        // 别显示成「已取消」（之前就是这么误导人的）
        const msg = e instanceof PageChannelAborted ? '抓取被中断，请重新下载' : String(e?.message ?? e);
        if (!useFallback(target)) {
          target.status = 'failed';
          target.error = target.preferPageChannel ? msg : `页面通道也失败：${msg}`;
        }
      }
      await saveJob();
      const j = await loadJob();
      if (j) await dispatch(j);
    });
}

/** 升级后的原图地址怎么都下不来：退回页面上原本显示的那个地址，重新排队（先直连） */
function useFallback(item: JobItem): boolean {
  if (!item.fallbackUrl || item.usedFallback || item.fallbackUrl === item.url) return false;
  item.usedFallback = true;
  item.url = item.fallbackUrl;
  item.retriedViaPage = false;
  item.downloadId = undefined;
  item.error = undefined;
  item.status = 'pending';
  return true;
}

async function settleIfFinished(job: Job) {
  const c = counts(job);
  if (c.active > 0) return;
  if (job.state !== 'cancelled') {
    // 还有排队项：running 会继续派发；paused 等用户点继续
    if (c.pending > 0) return;
    // 能动的都结束了，只剩暂停的项（例如暂停后追加的新下载已经下完）：整体回到「已暂停」
    if (c.paused > 0) {
      job.state = 'paused';
      return;
    }
    // 暂停期间最后几项都结束了（直连下载在暂停前一刻完成等）：照样收尾，别永远停在「已暂停」
    job.state = 'done';
  }
  if ((job.state === 'done' || job.state === 'cancelled') && !job.recorded) {
    job.recorded = true;
    await saveJob();
    await upsertHistory(job);
    const msg =
      job.state === 'cancelled'
        ? '已取消'
        : c.failed
          ? `${c.failed} 个失败：${job.items.find((i) => i.error)?.error ?? '原因未知'}`
          : '全部完成';
    report(progressOf(job, msg));
    updateBadge(job);
  }
}

// 顶层同步注册（MV3 要求）：这个事件也是 SW 被杀后的唤醒信号
function registerDownloadListener() {
  browser.downloads.onChanged.addListener(async (delta) => {
    const s = delta.state?.current;
    if (s !== 'complete' && s !== 'interrupted') return;
    const job = await loadJob();
    if (!job) return;
    const item = job.items.find((i) => i.downloadId === delta.id);
    // paused 也要认：用户可能在 Chrome 下载栏里把暂停的项继续下完，或者直接取消
    if (!item || (item.status !== 'active' && item.status !== 'paused')) return;
    const outcome = await applyTerminal(job, item, s, (delta as any).error?.current);
    if (outcome === 'retrying') {
      await saveJob();
      report(progressOf(job, '防盗链，改用页面通道重试'));
      return;
    }
    await dispatch(job); // 内部会 saveJob + settle + 广播 + 角标
  });
}

/**
 * 一个下载结束（完成 / 中断）后该项怎么走。实时事件（onChanged）和对账（reconcile）
 * 必须走同一套：之前对账遇到 interrupted 直接写 failed —— 和事件赛跑时，
 * 会把正在走页面通道重试的防盗链图作废，或者让重试根本不发起（审查实锤）
 */
async function applyTerminal(
  job: Job, item: JobItem, state: 'complete' | 'interrupted', reason?: string,
): Promise<'retrying' | 'settled'> {
  item.status =
    state === 'complete'
      ? 'done'
      : job.state === 'cancelled' || reason === 'USER_CANCELED'
        ? 'cancelled'
        : 'failed';
  if (item.status !== 'failed') return 'settled';
  item.error = humanizeDownloadError(reason) ?? '下载被中断';
  if (!item.retriedViaPage) {
    // 防盗链导致的失败：改用扩展自己的抓取通道、带上站点 Referer 重抓一次
    item.retriedViaPage = true;
    item.status = 'active';
    item.error = undefined;
    // 必须清掉旧 ID：留着的话 reconcile 会用它查到那次 403，
    // 把正在重试的任务又标回失败（实测踩过）
    item.downloadId = undefined;
    // 规则表之外的图床（如 Pixiv）没有预置 Referer 规则：用任务所在页面补一条，
    // 否则重试请求照样不带 Referer，必然再 403
    await ensureRetryReferer(item.url, item.pageUrl ?? job.pageUrl);
    launchPageChannel(item);
    return 'retrying';
  }
  useFallback(item);
  return 'settled';
}

async function startJob(
  items: MediaItem[], options: DownloadOptions, pageTitle: string, pageUrl: string,
  tabId?: number,
) {
  await ensureRefererRules(items);
  const folder = options.subfolder || joinPath('Gleaner', pageTitle || 'page');
  const newItems: JobItem[] = items.map((it, index) => ({
    url: it.url,
    filename: joinPath(
      folder,
      it.suggestedName
        ? `${sanitize(it.suggestedName)}.${it.ext}`
        : fileNameFromUrl(it.url, index, it.ext),
    ),
    status: 'pending' as const,
    tabId,
    pageUrl,
    preferPageChannel: it.preferPageChannel,
    muxAudioUrl: it.muxAudioUrl,
    backupUrls: it.backupUrls,
    muxAudioBackupUrls: it.muxAudioBackupUrls,
    fallbackUrl: it.originalUrl && it.originalUrl !== it.url ? it.originalUrl : undefined,
  }));

  // 已有任务在下：追加进去，Chrome 的下载也是「再点一个就多一条」。
  // 之前是直接新建任务把它顶掉 —— 旧任务剩下的文件永远不下，记录永远停在「进行中」
  const running = await loadJob();
  if (running && (running.state === 'running' || running.state === 'paused')) {
    // 双击 / 重复点：还在排队、下载中或暂停中的同一地址不再加一遍
    const inFlight = new Set(
      running.items
        .filter((i) => i.status === 'pending' || i.status === 'active' || i.status === 'paused')
        .map((i) => i.url),
    );
    const fresh = newItems.filter((i) => !inFlight.has(i.url));
    if (fresh.length) {
      // 每一批各自一条下载记录（之前追加的图片记在旧任务标题下，这一批的记录根本不存在）
      const batchId = newJobId();
      running.batches ??= [{ id: running.id, title: running.title, pageUrl: running.pageUrl, createdAt: running.createdAt }];
      running.batches.push({ id: batchId, title: sanitize(pageTitle || 'Gleaner'), pageUrl, createdAt: Date.now() });
      for (const it of fresh) it.batch = batchId;
      running.items.push(...fresh);
      // 暂停中又点了下载：新项照常开始，已暂停的那些保持暂停（Chrome 同款）
      running.state = 'running';
    }
    await saveJob();
    report(progressOf(running, fresh.length ? `已加入下载列表（${fresh.length} 项）` : '已经在下载列表里了'));
    await dispatch(running); // 内部会更新下载记录、角标
    return running.id;
  }

  const job: Job = {
    id: newJobId(),
    title: sanitize(pageTitle || 'Gleaner'),
    pageUrl,
    createdAt: Date.now(),
    concurrency: Math.max(1, Math.min(16, options.concurrency)),
    state: 'running',
    items: newItems,
  };
  job.batches = [{ id: job.id, title: job.title, pageUrl, createdAt: job.createdAt }];
  for (const it of newItems) it.batch = job.id;
  currentJob = job;
  jobLoaded = true;
  await saveJob();
  await upsertHistory(job); // 开始即入历史，Chrome 同款
  report(progressOf(job, '开始下载'));
  await dispatch(job);
  return job.id;
}

/**
 * 对账：以 downloads.search() 的真实状态为准修正任务账本。
 * 事件丢失（扩展重载、SW 被杀的缝隙）后弹窗一打开即自愈，不会永久卡死。
 */
async function reconcile(job: Job): Promise<boolean> {
  let changed = false;
  for (const it of job.items) {
    if (it.status === 'paused' && it.downloadId == null) continue; // 暂停的抓取：没有下载可对
    if (it.status !== 'active' && it.status !== 'paused') continue;
    if (it.downloadId == null) {
      // 正在 offscreen 抓取、还没拿到下载 ID。正常几十秒到几分钟就会有；
      // 但 SW 若在抓取期间被回收，这一项会永远停在这个状态 —— 之前没有任何路径能救它。
      // 没有起始时刻的是旧版残留，一并判僵死，否则用户那条卡住的任务永远好不了。
      const started = it.lastActivityAt ?? it.pageChannelStartedAt ?? 0;
      if (!started || Date.now() - started > STALE_PAGE_CHANNEL_MS) {
        it.status = 'failed';
        it.error = '抓取被中断（扩展重载或超时），请重新下载';
        changed = true;
      }
      continue;
    }
    const id = it.downloadId;
    try {
      const [d] = await browser.downloads.search({ id });
      // 等 search 回包期间，onChanged 可能已经处理过这一项（比如切去页面通道重试、换了新下载）：
      // 回包说的是旧那次下载，不能拿来改现在的状态
      if (it.downloadId !== id || (it.status !== 'active' && it.status !== 'paused')) continue;
      if (!d) {
        it.status = 'failed';
        changed = true;
      } else if (d.state === 'complete') {
        it.status = 'done';
        changed = true;
      } else if (d.state === 'interrupted') {
        // 和实时事件同一套处理：该重试的照样重试，而不是直接判失败
        await applyTerminal(job, it, 'interrupted', (d as any).error);
        changed = true;
      }
    } catch {
      /* search 不可用就保持原状 */
    }
  }
  return changed;
}

function itemViews(job: Job) {
  return job.items.map((i) => ({
    name: i.filename.split('/').pop() ?? i.filename,
    status: i.status,
    error: i.error,
    percent: i.percent,
  }));
}

async function abortPageFetches(items: JobItem[], keepPartial: boolean) {
  const urls = items.flatMap((i) => [
    i.url, ...(i.backupUrls ?? []),
    ...(i.muxAudioUrl ? [i.muxAudioUrl, ...(i.muxAudioBackupUrls ?? [])] : []),
  ]);
  if (!urls.length) return;
  await browser.runtime
    .sendMessage({ type: 'OFFSCREEN_ABORT', urls, keepPartial } satisfies Message)
    .catch(() => {}); // offscreen 不在就没有在抓的东西
}

async function controlJob(action: 'pause' | 'resume' | 'cancel') {
  const job = await loadJob();
  if (!job) throw new Error('没有进行中的任务');
  const isPage = (i: JobItem) => Boolean(i.preferPageChannel || i.retriedViaPage);
  const withId = (st: JobItem['status']) =>
    job.items.filter((i) => i.status === st && i.downloadId != null);

  if (action === 'pause' && job.state === 'running') {
    job.state = 'paused';
    const downloading = withId('active');
    // offscreen 里正在抓的项：downloads API 管不到，要中止抓取
    // 正在合并的（phase=mux）不暂停：纯本地运算，合完直接落盘
    const fetching = job.items.filter(
      (i) => i.status === 'active' && i.downloadId == null && isPage(i) && i.phase !== 'mux',
    );
    await Promise.allSettled(downloading.map((i) => browser.downloads.pause(i.downloadId!)));
    for (const it of downloading) it.status = 'paused';
    // 真暂停：中止抓取、已抓的字节留在 offscreen，继续时带 Range 从断点续抓。
    // 之前这里什么都不做 —— 后台照样抓完、合并、落盘，界面却显示「已暂停」
    for (const it of fetching) it.status = 'paused';
    await abortPageFetches(fetching, true);
    for (const it of job.items) if (it.status === 'pending') it.status = 'paused';
    // 正在 await download() 的直连项还没有 id：dispatch 拿到 id 后看到任务已暂停会自己暂停它
  } else if (action === 'resume' && job.items.some((i) => i.status === 'paused')) {
    job.state = 'running';
    const downloads = withId('paused');
    await Promise.allSettled(downloads.map((i) => browser.downloads.resume(i.downloadId!)));
    for (const it of job.items) {
      if (it.status !== 'paused') continue;
      it.status = it.downloadId != null ? 'active' : 'pending';
    }
    await dispatch(job);
    return job.state;
  } else if (action === 'cancel' && (job.state === 'running' || job.state === 'paused')) {
    job.state = 'cancelled';
    const downloads = [...withId('active'), ...withId('paused')];
    // offscreen 里正在抓的、以及暂停时留着断点字节的：都要丢掉，别一直占着内存（审查实锤）
    const fetches = job.items.filter(
      (i) => (i.status === 'active' || i.status === 'paused') && i.downloadId == null && isPage(i),
    );
    for (const it of job.items) {
      if (it.status === 'pending' || (it.status === 'paused' && it.downloadId == null)) it.status = 'cancelled';
      // 正在 offscreen 抓取、还没有 downloadId 的项：downloads API 管不到它，直接标取消；
      // 抓完后 launchPageChannel 看到状态不是 active 会放弃落盘
      if (it.status === 'active' && it.downloadId == null) it.status = 'cancelled';
    }
    await Promise.allSettled(downloads.map((i) => browser.downloads.cancel(i.downloadId!)));
    // 暂停中的下载被取消时 Chrome 不一定再发 interrupted 事件：直接记为取消
    for (const it of downloads) if (it.status === 'paused') it.status = 'cancelled';
    // offscreen 里的抓取也要真停下（之前取消后它仍在后台把整个文件下完），已抓的字节丢弃
    await abortPageFetches(fetches, false);
    // 在途项会以 interrupted 事件收尾；若已无在途项这里直接结算
    await settleIfFinished(job);
  }
  await saveJob();
  report(progressOf(job));
  updateBadge(job);
  return job.state;
}

// ------------------------------- 媒体嗅探 ----------------------------------
// 观察模式 webRequest：捕获页面加载的视频/音频真实地址（MSE 的 blob: 是假地址，
// 只有网络层能看到真实的媒体请求）。SW 存活期间持续记录，按标签页隔离。

// MV3 的 service worker 闲置约 30 秒就被回收，纯内存 Map 会整个丢失
// （用户播完视频过一会儿才点开弹窗 → 什么都看不到）。内存作缓存，storage 作真相。
const MEDIA_KEY = 'og-media';
const mediaByTab = new Map<number, MediaHit[]>();
let mediaLoaded = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

const mediaStore = () => (browser.storage as any).session ?? browser.storage.local;

let mediaLoading: Promise<void> | null = null;

/**
 * SW 唤醒后从 storage 恢复嗅探记录。所有调用方共用同一次读取，读完才算「已恢复」：
 * 之前一进来就置 mediaLoaded=true —— 唤醒瞬间的 GET_MEDIA 拿到空列表；同一标签页
 * 紧接着的第二个嗅探事件在空 Map 上新建列表，恢复时又因「已有」而跳过，旧记录丢失并被写盘覆盖（审查实锤）
 */
async function loadMedia() {
  if (mediaLoaded) return;
  mediaLoading ??= (async () => {
    try {
      const o = await mediaStore().get(MEDIA_KEY);
      const saved = (o?.[MEDIA_KEY] as Record<string, MediaHit[]> | undefined) ?? {};
      for (const [tabId, list] of Object.entries(saved)) {
        const id = Number(tabId);
        const mem = mediaByTab.get(id);
        // 兜底合并：万一有人没等恢复就写了内存，别把存档整个丢掉
        if (!mem) mediaByTab.set(id, list);
        else {
          const seen = new Set(mem.map((m) => m.url));
          mediaByTab.set(id, [...list.filter((m) => !seen.has(m.url)), ...mem]);
        }
      }
    } catch {
      /* 读不到就当空的 */
    }
    mediaLoaded = true;
  })();
  await mediaLoading;
}

/** 合并写盘：嗅探是高频事件，逐条写会拖垮 storage */
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    const obj: Record<string, MediaHit[]> = {};
    for (const [tabId, list] of mediaByTab) obj[String(tabId)] = list;
    mediaStore().set({ [MEDIA_KEY]: obj }).catch(() => {});
  }, 400);
}
/** 返回 null=不是媒体；'fragment'=分片本体，需要按基础 URL 归并成轨 */
function classifyMedia(url: string, contentType: string): MediaHit['kind'] | 'fragment' | null {
  if (contentType.includes('mpegurl') || contentType.includes('dash+xml') || MANIFEST_EXT.test(url)) {
    return 'stream';
  }
  // 分片：content-type 常是 video/mp4，但只是一段。埋点接口也可能带 .ts，
  // 所以必须同时满足「像媒体」才认，否则统计域名会被误报成视频流
  if (HLS_SEGMENT_EXT.test(url)) return null; // HLS 分段：由 m3u8 那一行代表，单段只有几秒
  if (FRAGMENT_EXT.test(url)) return isMediaContentType(contentType) ? 'fragment' : null;
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  if (AUDIO_EXT.test(url)) return 'audio';
  if (VIDEO_EXT.test(url)) return 'video';
  return null;
}

function registerMediaSniffer() {
  const wr = (browser as any).webRequest;
  if (!wr?.onResponseStarted?.addListener) return;
  wr.onResponseStarted.addListener(
    async (d: {
      tabId: number; url: string; initiator?: string; frameId?: number;
      responseHeaders?: Array<{ name: string; value?: string }>;
    }) => {
      // iframe 里的播放器：记下它自己的来源，下载时拿来当 Referer（顶层页面的请求不用记）
      const referer = d.frameId && d.initiator && /^https?:/.test(d.initiator) ? `${d.initiator}/` : undefined;
      if (d.tabId < 0) return;
      // 唤醒后内存是空的；不先恢复就写盘会抹掉其他标签页已嗅到的记录
      await loadMedia();
      const header = (name: string) =>
        d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
      const kind = classifyMedia(d.url, header('content-type').toLowerCase());
      if (!kind) return;
      const list = mediaByTab.get(d.tabId) ?? [];

      // 分片本体：DASH 的几百段其实是对同一 URL 发 Range 请求，
      // 按「去掉查询参数的基础 URL」归并，一组就是一条完整轨道，可整包下载
      if (kind === 'fragment') {
        // 保留鉴权签名，只去掉 range 参数；按路径去重（同一轨的分片路径相同）
        const base = normalizeFragmentUrl(d.url);
        const key = basenameKey(base);
        const existing = list.find((m) => basenameKey(m.url) === key);
        if (existing) {
          existing.segments = (existing.segments ?? 1) + 1;
        } else {
          list.push({
            url: base,
            kind: 'stream',
            streamKind: 'dash-track',
            track: trackOf(d.url, header('content-type').toLowerCase()),
            codec: codecOf(d.url),
            mime: header('content-type'),
            segments: 1,
            via: 'sniffer',
            ...(referer ? { referer } : {}),
          });
        }
        mediaByTab.set(d.tabId, list);
        scheduleFlush();
        return;
      }

      if (list.some((m) => m.url === d.url)) return;
      const size = parseInt(header('content-length')) || undefined;
      list.push({
        url: d.url,
        kind,
        mime: header('content-type'),
        size,
        via: 'sniffer',
        ...(referer ? { referer } : {}),
        ...(kind === 'stream' ? { streamKind: 'hls' as const } : {}),
      });
      if (list.length > 80) list.shift();
      mediaByTab.set(d.tabId, list);
      scheduleFlush();
    },
    { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'object', 'other'] },
    ['responseHeaders'],
  );
  // 真正换页时才清记录。注意只认 status=loading 且带 url 的整页导航，
  // 否则 B站 这类 SPA 的路由变化会把刚嗅到的视频误清掉
  browser.tabs?.onUpdated?.addListener(async (tabId, info) => {
    if (info.status === 'loading' && info.url) {
      // SW 可能正是被这次导航唤醒的：内存是空的，不先恢复就写盘，
      // 会把「所有」标签页已嗅到的视频一起抹掉（审查实锤）
      await loadMedia();
      mediaByTab.delete(tabId);
      scheduleFlush();
    }
  });
}

/**
 * 给媒体 CDN 补 Referer（会话级 DNR 规则，号段 2900-2999），
 * 扩展进程的 fetch 才不会被防盗链拒掉。图片规则在 1000 号段，互不干扰。
 */
/**
 * 每个域名的 Referer 取值优先级：
 * 1. 视频 CDN 固定要求的（B站 upos 只认 bilibili.com，见 rules.ts MEDIA_REFERERS）
 * 2. 真正发起请求的 frame（嵌在博客里的播放器 → 播放器自己的域名）
 * 3. 标签页的页面
 */
async function ensureMediaReferer(urls: string[], pageUrl: string, initiator?: string) {
  let fallback: string | undefined;
  try {
    fallback = initiator || (pageUrl ? new URL(pageUrl).origin + '/' : undefined);
  } catch {
    fallback = initiator;
  }
  try {
    const byHost = new Map<string, string>();
    for (const u of urls) {
      const referer = mediaRefererFor(u) ?? fallback;
      if (referer) byHost.set(new URL(u).hostname, referer);
    }
    // offscreen 的 fetch 归 xmlhttprequest；media/other 兜底。
    // 不要全量列出：main_frame/script 等会连页面自身的导航和脚本请求一起改写。
    await upsertRefererRules(MEDIA_RULES, byHost, ['xmlhttprequest', 'media', 'other']);
  } catch (e) {
    console.warn('[Gleaner] 媒体 Referer 规则设置失败:', e);
  }
}

/** 嗅探到的媒体 → 任务项。audioUrl 有值 = DASH 分轨，合并成一个带声音的 MP4 */
interface MediaBackups {
  backupUrls?: string[];
  audioBackupUrls?: string[];
  /** 发起请求的 frame 来源（iframe 播放器） */
  referer?: string;
}

function mediaItemFor(url: string, base: string, audioUrl?: string, bk: MediaBackups = {}): MediaItem {
  if (audioUrl) {
    // DASH 画面轨 + 声音轨 → 合并成一个带声音的 MP4（offscreen 里用 ffmpeg.wasm）
    return {
      id: url, url, originalUrl: url, width: 0, height: 0, ext: 'mp4',
      source: 'img', suggestedName: base,
      preferPageChannel: true, muxAudioUrl: audioUrl,
      backupUrls: bk.backupUrls, muxAudioBackupUrls: bk.audioBackupUrls,
    };
  }
  const m = url.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
  let ext = (m?.[1] ?? 'mp4').toLowerCase();
  const isAudioTrack = ext === 'm4s' && trackOf(url, '') === 'audio';
  if (ext === 'm4s') ext = isAudioTrack ? 'm4a' : 'mp4';
  return {
    id: url, url, originalUrl: url, width: 0, height: 0, ext,
    source: 'img', suggestedName: base,
    preferPageChannel: url.includes('.m4s'),
    backupUrls: bk.backupUrls,
  };
}

/** 主地址 + 备用地址（Referer 规则要把备用 CDN 的域名也覆盖到） */
const withBackups = (url: string, audioUrl?: string, bk: MediaBackups = {}) => [
  url, ...(bk.backupUrls ?? []), ...(audioUrl ? [audioUrl, ...(bk.audioBackupUrls ?? [])] : []),
];

/** 下载嗅探到的媒体：按页面来源补 Referer，然后走任务系统（角标/记录/暂停全都有） */
async function downloadMedia(
  url: string, pageTitle: string, pageUrl: string, audioUrl?: string, tabId?: number, bk: MediaBackups = {},
) {
  // 兜底：m3u8/mpd 是文本清单，直接下只会存下一段文本还显示「成功」
  if (MANIFEST_EXT.test(url)) throw new Error('m3u8/mpd 清单需要下载全部分片再拼接，暂不支持');
  await ensureMediaReferer(withBackups(url, audioUrl, bk), pageUrl, bk.referer);
  const base = sanitize(pageTitle || 'Gleaner');
  await startJob(
    [mediaItemFor(url, base, audioUrl, bk)],
    { concurrency: 2, subfolder: '', asZip: false }, pageTitle, pageUrl, tabId,
  );
}

/** 图片 + 音视频合成一个任务（AI 助手命中项一键下载）。分开发会互相顶掉当前任务 */
async function downloadMixed(
  items: MediaItem[], media: Array<{ url: string; audioUrl?: string } & MediaBackups>,
  pageTitle: string, pageUrl: string, tabId?: number,
) {
  const manifests = media.filter((m) => MANIFEST_EXT.test(m.url)).length;
  media = media.filter((m) => !MANIFEST_EXT.test(m.url)); // 同上：清单不能当文件下
  for (const m of media) await ensureMediaReferer(withBackups(m.url, m.audioUrl, m), pageUrl, m.referer);
  const base = sanitize(pageTitle || 'Gleaner');
  const mediaItems = media.map((m, i) =>
    mediaItemFor(m.url, media.length > 1 ? `${base}_${String(i + 1).padStart(2, '0')}` : base, m.audioUrl, m),
  );
  if (!items.length && !mediaItems.length) {
    throw new Error(manifests ? 'm3u8/mpd 清单暂不支持下载（需要下载全部分片再拼接）' : '没有可下载的项');
  }
  await startJob(
    [...items, ...mediaItems],
    { concurrency: 3, subfolder: '', asZip: false }, pageTitle, pageUrl, tabId,
  );
}

// ------------------------------- AI 助手 ----------------------------------
// 纯逻辑在 core/agent/run.ts；这里只提供 SW 才有的能力：跨域取图（有 host 权限，
// 不像页面里的 canvas 会被污染）、OffscreenCanvas 读像素 / 拼联络表、调 Claude。

async function loadAgentSettings(): Promise<AgentSettings> {
  const o = await browser.storage.local.get(AGENT_SETTINGS_KEY);
  return { ...DEFAULT_AGENT_SETTINGS, ...((o?.[AGENT_SETTINGS_KEY] as Partial<AgentSettings> | undefined) ?? {}) };
}

async function fetchBitmap(url: string, resize?: number): Promise<ImageBitmap | null> {
  try {
    const res = await fetch(url, { credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (blob.size > 8 * 1048576) return null; // 这不是缩略图，别为了看颜色拉一张 8MB 的原图
    return await createImageBitmap(
      blob,
      resize ? { resizeWidth: resize, resizeHeight: resize, resizeQuality: 'low' } : {},
    );
  } catch {
    return null;
  }
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const agentDeps: AgentDeps = {
  async pixels(url) {
    const bmp = await fetchBitmap(url, 24);
    if (!bmp) return null;
    const cv = new OffscreenCanvas(24, 24);
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, 24, 24);
    bmp.close();
    return ctx.getImageData(0, 0, 24, 24).data;
  },

  async sheet(cands, labels) {
    const layout = sheetLayout(cands.length);
    const cv = new OffscreenCanvas(layout.width, layout.height);
    const ctx = cv.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#1f2937';
    ctx.fillRect(0, 0, layout.width, layout.height);
    const bitmaps = await mapLimit(cands, 6, (c) => (c.thumb ? fetchBitmap(c.thumb) : Promise.resolve(null)));
    let drawn = 0;
    layout.slots.forEach((s, i) => {
      const bmp = bitmaps[i];
      if (bmp) {
        // cover 裁切：短边铺满格子
        const scale = Math.max(s.w / bmp.width, s.h / bmp.height);
        const w = bmp.width * scale;
        const h = bmp.height * scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect(s.x, s.y, s.w, s.h);
        ctx.clip();
        ctx.drawImage(bmp, s.x + (s.w - w) / 2, s.y + (s.h - h) / 2, w, h);
        ctx.restore();
        bmp.close();
        drawn++;
      }
      // 编号角标：模型靠它把格子对回摘要里的 #n
      const label = labels[i] ?? `#${i + 1}`;
      ctx.font = 'bold 18px sans-serif';
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = 'rgba(0,0,0,0.85)';
      ctx.fillRect(s.x, s.y, tw, 24);
      ctx.fillStyle = '#fff';
      ctx.fillText(label, s.x + 5, s.y + 18);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.w - 1, s.h - 1);
    });
    if (!drawn) return null;
    const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.75 });
    return { data: toBase64(await blob.arrayBuffer()), mediaType: 'image/jpeg' };
  },

  ask: askClaude,
};

/**
 * offscreen 通道：在 offscreen 文档里直接 fetch（扩展页 + host 权限，不受 CORS 限制，
 * Referer 由 DNR 会话规则补上），字节留在 offscreen 内生成 blob，只把 blob URL 传回来落盘。
 * 二进制绝不经过 sendMessage —— 那会被序列化成 {}，落盘就是 0 字节。
 * downloads API 自己发的请求带不上 Referer（DNR 对它不生效，headers 里也禁设 Referer），
 * 所以防盗链站点必须走这条通道。
 */
/** 抓取期间该项已不再 active（取消/暂停/判僵死）：调用方保持原状态，不要改写成「失败」 */
class PageChannelAborted extends Error {
  constructor() {
    super('已取消');
  }
}

async function downloadViaPage(
  item: JobItem,
  stale: () => boolean = () => item.status !== 'active',
): Promise<number> {
  await ensureOffscreen();
  const MAX = MAX_MEDIA_BYTES;

  let made: BlobResponse | undefined;
  if (item.muxAudioUrl) {
    // 画面轨 + 声音轨 → offscreen 里 ffmpeg 合并成一个带声音的 MP4
    report(progressOf((await loadJob())!, '正在抓取并合并音视频'));
    made = (await browser.runtime.sendMessage({
      type: 'OFFSCREEN_MUX',
      videoUrl: item.url,
      audioUrl: item.muxAudioUrl,
      videoBackups: item.backupUrls,
      audioBackups: item.muxAudioBackupUrls,
      maxBytes: MAX,
    } satisfies Message)) as BlobResponse | undefined;
  } else {
    const isAudio = item.filename.endsWith('.m4a');
    made = (await browser.runtime.sendMessage({
      type: 'OFFSCREEN_FETCH',
      url: item.url,
      isAudio,
      // 页面通道重试的防盗链图片 vs 嗅探到的音视频（失败文案不同）
      kind: item.preferPageChannel ? 'media' : 'image',
      backups: item.backupUrls,
      maxBytes: MAX,
    } satisfies Message)) as BlobResponse | undefined;
  }
  if (made && !made.ok && made.aborted) throw new PageChannelAborted();
  if (!made?.ok) throw new Error(made?.error ?? 'offscreen 无响应');
  if (!made.size) throw new Error('抓到 0 字节');

  const blobUrl = made.blobUrl;
  const revoke = () =>
    browser.runtime.sendMessage({ type: 'OFFSCREEN_REVOKE', blobUrl } satisfies Message).catch(() => {});

  // 抓取要几十秒到几分钟，期间用户可能已取消（或被 reconcile 判僵死）。
  // 必须在发起下载「之前」判：blob 下载几乎瞬时落盘，事后再 cancel 基本来不及，文件照样出现在磁盘上。
  if (stale()) {
    await revoke();
    throw new PageChannelAborted();
  }

  // 与 handleZip 保持同一不变量：先注册完成监听，再发起下载
  const tracker = trackDownloadCompletion();
  let id: number;
  try {
    id = await browser.downloads.download({
      url: blobUrl,
      filename: item.filename,
      conflictAction: 'uniquify',
    });
  } catch (e) {
    // download() 本身失败（非法文件名等）时 blob 没人释放，会一直占着 offscreen 内存
    tracker.dispose();
    await revoke();
    throw e;
  }

  // 落盘后释放 blob，避免 offscreen 内存越积越多
  tracker.wait(id).then(revoke).finally(() => tracker.dispose());
  return id;
}

// ------------------------------- 原图尺寸探测 ------------------------------

const PROBE_MAX_ITEMS = 200;

/**
 * 规则升级过的原图、懒加载图：扫描时只知道缩略图多大。卡片要标「图片 + 分辨率」，
 * 就只拉文件头读宽高（审查实锤：淘宝/京东/微博整页卡片都只显示「JPG」）。
 * 在 SW 里 fetch：有 host 权限不受 CORS 限制；DNR 的 Referer 规则（tabIds:[-1]）对它同样生效。
 */
async function probeSizes(items: Array<{ id: string; url: string }>): Promise<Record<string, [number, number]>> {
  const list = items.filter((i) => /^https?:/i.test(i.url)).slice(0, PROBE_MAX_ITEMS);
  await ensureRefererRules(list as unknown as MediaItem[]);
  const out: Record<string, [number, number]> = {};
  await mapLimit(list, 6, async (it) => {
    const size = await probeOne(it.url).catch(() => null);
    if (size) out[it.id] = [size.width, size.height];
  });
  return out;
}

async function probeOne(url: string): Promise<ImageSize | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // 128KB：PNG/GIF/WebP 几十字节就够，JPEG 的 SOF 段前面可能有几十 KB 的 EXIF
    const res = await fetch(url, { credentials: 'omit', headers: { Range: 'bytes=0-131071' }, signal: ctrl.signal });
    if (!res.ok || !res.body) return null;
    if (/^(text\/|application\/(json|xhtml))/i.test(res.headers.get('content-type') ?? '')) return null;
    const reader = res.body.getReader();
    const buf = new Uint8Array(524288); // 服务器不理 Range、整张图都过来时，最多读 512KB 就停
    let n = 0;
    try {
      while (n < buf.length) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        const take = Math.min(value.byteLength, buf.length - n);
        buf.set(value.subarray(0, take), n);
        n += take;
        const got = readImageSize(buf.subarray(0, n));
        if (got) return got;
      }
      return readImageSize(buf.subarray(0, n));
    } finally {
      reader.cancel().catch(() => {});
    }
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------- 防盗链 ------------------------------------

async function ensureRefererRules(items: MediaItem[]) {
  const byHost = new Map<string, string>();
  for (const it of items) {
    const referer = refererFor(it.url);
    if (!referer) continue;
    try {
      byHost.set(new URL(it.url).hostname, referer);
    } catch {
      /* 跳过非法 URL */
    }
  }
  await upsertRefererRules(IMAGE_RULES, byHost, ['image', 'media', 'other', 'xmlhttprequest']);
}

/** 防盗链重试：规则表里有就用规则的 Referer，没有就用任务所在页面 */
async function ensureRetryReferer(url: string, pageUrl: string) {
  let referer = refererFor(url);
  if (!referer && pageUrl) {
    try {
      referer = new URL(pageUrl).origin + '/';
    } catch {
      /* 页面地址不合法就算了 */
    }
  }
  if (!referer) return;
  try {
    await upsertRefererRules(MEDIA_RULES, new Map([[new URL(url).hostname, referer]]), ['xmlhttprequest', 'media', 'other']);
  } catch {
    /* 非法 URL */
  }
}

/**
 * 会话级 DNR 规则号段：图片规则 1000-1999，媒体/重试规则 2900-3899。
 * 媒体号段原来只有 100 条：加了 B站 备用 CDN 以后每个视频要 3~5 个域名，
 * 一个会话下三十来个视频就满了（Chrome 会话规则上限 5000，放得下）
 */
const IMAGE_RULES = { lo: 1000, hi: 2000 };
const MEDIA_RULES = { lo: 2900, hi: 3900 };
let dnrChain: Promise<unknown> = Promise.resolve();

/**
 * 按域名增量写 Referer 规则。两条硬约束：
 * 1. 增量：之前每次都把整个号段清空重建 —— 新任务开始时，旧任务还在抓的域名规则被删，
 *    后续请求不带 Referer 直接 403。现在同域名覆盖、别的域名保留。
 * 2. tabIds: [-1]（TAB_ID_NONE）：只作用于不属于任何标签页的请求，也就是扩展自己
 *    （offscreen 抓取、弹窗预览图）。之前作用于所有标签页，会改写其他网站自己的请求、
 *    泄露来源页，嵌入式播放器也会被搞坏。
 * 串行执行：并发的「读规则 → 写规则」会分到同一个 id，updateSessionRules 直接报错。
 */
function upsertRefererRules(
  range: { lo: number; hi: number },
  byHost: Map<string, string>,
  resourceTypes: string[],
): Promise<void> {
  const dnr = (browser as any).declarativeNetRequest;
  if (!dnr?.updateSessionRules || !byHost.size) return Promise.resolve();
  const run = async () => {
    const existing: Array<{ id: number; condition?: { urlFilter?: string } }> = await dnr.getSessionRules();
    const inRange = existing.filter((r) => r.id >= range.lo && r.id < range.hi);
    const idOfHost = new Map(inRange.map((r) => [(r.condition?.urlFilter ?? '').replace(/^\|\|/, ''), r.id]));
    const used = new Set(inRange.map((r) => r.id));
    // 这一批里要原地覆盖的 id 不能再被挤掉分给别的域名：
    // 之前号段满了会把同一个 id 分给两个域名，整批更新被 Chrome 拒绝（审查实锤）
    const reused = new Set([...byHost.keys()].map((h) => idOfHost.get(h)).filter((id) => id != null));
    const free: number[] = [];
    for (let id = range.lo; id < range.hi; id++) if (!used.has(id)) free.push(id);
    const evictable = inRange.map((r) => r.id).filter((id) => !reused.has(id)).sort((a, b) => a - b);
    const removeRuleIds: number[] = [];
    const addRules: unknown[] = [];
    for (const [host, referer] of byHost) {
      const id = idOfHost.get(host) ?? free.shift() ?? evictable.shift(); // 满了从最早的挤
      if (id == null) break;
      if (used.has(id)) removeRuleIds.push(id);
      used.add(id);
      addRules.push({
        id,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: referer }],
        },
        condition: { urlFilter: `||${host}`, resourceTypes, tabIds: [-1] },
      });
    }
    await dnr.updateSessionRules({ removeRuleIds, addRules });
  };
  const p = dnrChain.then(run, run).catch((e) => {
    // 规则没加上的唯一症状是 403，静默吞掉会让排查无从下手
    console.warn('[Gleaner] Referer 规则设置失败:', e);
  });
  dnrChain = p;
  return p;
}

// ------------------------------- ZIP（一次性任务） --------------------------

async function handleZip(items: MediaItem[], name: string) {
  report({ total: items.length, done: 0, failed: 0, running: true, message: '正在抓取并打包' });
  await ensureRefererRules(items);

  const useOffscreen = Boolean(offscreenApi());
  const result = useOffscreen
    ? await zipViaOffscreen(items)
    : await buildZipBlobUrl(items, 6, (done, failed) =>
        report({ total: items.length, done, failed, running: true, message: '正在抓取并打包' }),
      );

  // 必须先注册监听再发起下载：完成事件若落在 download() resolve
  // 与 addListener 之间的缝隙里，后注册的监听器会永远等不到
  const tracker = trackDownloadCompletion();
  try {
    const id = await browser.downloads.download({
      url: result.blobUrl,
      filename: `${name}.zip`,
      conflictAction: 'uniquify',
    });
    await tracker.wait(id);
  } catch (e) {
    // download() 本身失败（非法文件名等）：blob 在 offscreen 里，没人释放就一直占到浏览器重启
    await releaseZipBlob(useOffscreen, result.blobUrl);
    throw e;
  } finally {
    tracker.dispose();
  }
  // 不要 closeDocument：offscreen 是全局单例，DASH 抓取/ffmpeg 合并可能正在里面跑
  // （dispatch 故意不 await），关掉会把那些任务整个打断、已抓的字节全丢。
  // 只释放这次的 blob —— 它是在 offscreen 里创建的，得让 offscreen 自己 revoke。
  await releaseZipBlob(useOffscreen, result.blobUrl);

  report({
    total: items.length,
    done: result.done,
    failed: result.failed,
    running: false,
    message: result.failed ? `ZIP 已保存，${result.failed} 张抓取失败未入包` : 'ZIP 已保存',
  });
}

async function releaseZipBlob(useOffscreen: boolean, blobUrl: string) {
  if (useOffscreen) {
    await browser.runtime
      .sendMessage({ type: 'OFFSCREEN_REVOKE', blobUrl } satisfies Message)
      .catch(() => {});
  } else {
    URL.revokeObjectURL?.(blobUrl);
  }
}

async function zipViaOffscreen(items: MediaItem[]): Promise<{ blobUrl: string; done: number; failed: number }> {
  await ensureOffscreen();

  const res = (await browser.runtime.sendMessage({
    type: 'OFFSCREEN_ZIP',
    items,
  } satisfies Message)) as ZipResponse | undefined;

  if (!res || !('blobUrl' in res)) {
    throw new Error(res && 'error' in res ? res.error : 'offscreen 打包失败');
  }
  return res;
}

function trackDownloadCompletion() {
  const finished = new Set<number>();
  let notify: (() => void) | null = null;
  const onChanged = (delta: { id: number; state?: { current?: string } }) => {
    const s = delta.state?.current;
    if (s === 'complete' || s === 'interrupted') {
      finished.add(delta.id);
      notify?.();
    }
  };
  browser.downloads.onChanged.addListener(onChanged);
  return {
    async wait(id: number) {
      while (!finished.has(id)) {
        await new Promise<void>((r) => { notify = r; });
      }
    },
    dispose() {
      browser.downloads.onChanged.removeListener(onChanged);
    },
  };
}

// ------------------------------- 消息入口 ----------------------------------

export default defineBackground(() => {
  registerDownloadListener();
  registerMediaSniffer();

  // 同步判断类型，只在命中时返回 Promise（async 一把梭会抢答其他上下文的消息）
  browser.runtime.onMessage.addListener((raw: unknown): Promise<ActionResponse> | undefined => {
    const msg = raw as Message;
    if (msg.type === 'ZIP_PROGRESS') {
      // 之前 ZIP 全程没有进度，弹窗一直停在「正在抓取并打包 0/N」
      report({
        total: msg.total, done: msg.done, failed: msg.failed, running: true,
        message: `正在抓取并打包 ${msg.done + msg.failed}/${msg.total}`,
      });
      return;
    }
    if (msg.type === 'FETCH_PROGRESS') {
      void (async () => {
        const job = await loadJob();
        const item = job?.items.find((i) => i.url === msg.url && i.status === 'active');
        if (!job || !item) return;
        // 心跳：僵死判定看的是「多久没进展」而不是「开始了多久」。
        // 否则慢网下载一个大视频超过 10 分钟，会被 reconcile 当成僵死、抓完也不落盘。
        item.lastActivityAt = Date.now();
        if (!msg.received && !msg.total) {
          // offscreen 抓完两条轨、开始 ffmpeg 合并时发 0/0。之前这里照样显示「抓取中 0.0MB」，
          // 百分比也被清掉，看起来像下载从头开始了
          item.percent = undefined;
          item.phase = 'mux';
          await saveJob();
          report(progressOf(job, '正在合并画面和声音…'));
          return;
        }
        item.percent = msg.total ? Math.round((msg.received / msg.total) * 100) : undefined;
        report(progressOf(job, `抓取中 ${(msg.received / 1048576).toFixed(1)}MB`));
      })();
      return;
    }
    if (
      msg.type !== 'DOWNLOAD' && msg.type !== 'ZIP' && msg.type !== 'JOB_CONTROL' &&
      msg.type !== 'GET_STATE' && msg.type !== 'REVEAL' && msg.type !== 'CLEAR_HISTORY' &&
      msg.type !== 'GET_MEDIA' && msg.type !== 'DOWNLOAD_MEDIA' &&
      msg.type !== 'AGENT_QUERY' && msg.type !== 'DOWNLOAD_MIXED' && msg.type !== 'PROBE_SIZES'
    ) return;

    return (async (): Promise<ActionResponse> => {
      try {
        switch (msg.type) {
          case 'DOWNLOAD': {
            // 立即返回；进度走 PROGRESS 广播，弹窗关了任务照跑
            await startJob(msg.items, msg.options, msg.pageTitle, msg.pageUrl ?? '');
            return { ok: true };
          }
          case 'ZIP':
            try {
              await handleZip(msg.items, msg.name);
            } catch (e: any) {
              // 之前失败时没有收尾广播：弹窗进度条永远停在「正在抓取并打包 3/3」且算作进行中
              report({
                total: msg.items.length, done: 0, failed: msg.items.length, running: false,
                message: `ZIP 打包失败：${String(e?.message ?? e)}`,
              });
              throw e;
            }
            return { ok: true };
          case 'JOB_CONTROL': {
            const state = await controlJob(msg.action);
            return { ok: true, state };
          }
          case 'GET_STATE': {
            const job = await loadJob();
            if (job) {
              // 弹窗每次打开都和浏览器下载管理器对账，修正丢失的事件
              const changed = await reconcile(job);
              if (changed) {
                await saveJob();
                await dispatch(job); // 对账释放了并发位，补派 + 结算
              }
            }
            return {
              ok: true,
              progress: job ? progressOf(job) : undefined,
              items: job ? itemViews(job) : undefined,
              history: await getHistory(),
            };
          }
          case 'PROBE_SIZES':
            return { ok: true, sizes: await probeSizes(msg.items) };
          case 'REVEAL': {
            // downloads.show 对已从 Chrome 下载列表清除、或文件已被删掉的记录是静默无效的
            // （用户点了没任何反应）。先查一下，找不到就打开默认下载目录并说明原因
            if (msg.downloadId != null) {
              const [d] = await browser.downloads.search({ id: msg.downloadId }).catch(() => []);
              if (d && (d as { exists?: boolean }).exists !== false) {
                await browser.downloads.show(msg.downloadId);
                return { ok: true };
              }
              await browser.downloads.showDefaultFolder();
              return {
                ok: true,
                note: d ? '文件已被移动或删除，已打开默认下载目录' : 'Chrome 下载列表里的这条记录已被清除，已打开默认下载目录',
              };
            }
            await browser.downloads.showDefaultFolder();
            return { ok: true };
          }
          case 'CLEAR_HISTORY': {
            await browser.storage.local.remove(HISTORY_KEY);
            return { ok: true };
          }
          case 'GET_MEDIA':
            // service worker 可能刚被唤醒，内存是空的，先从 storage 恢复
            await loadMedia();
            return { ok: true, media: mediaByTab.get(msg.tabId) ?? [] };
          case 'DOWNLOAD_MEDIA': {
            await downloadMedia(msg.url, msg.pageTitle, msg.pageUrl, msg.audioUrl, msg.tabId, {
              backupUrls: msg.backupUrls, audioBackupUrls: msg.audioBackupUrls, referer: msg.referer,
            });
            return { ok: true };
          }
          case 'DOWNLOAD_MIXED': {
            await downloadMixed(msg.items, msg.media, msg.pageTitle, msg.pageUrl, msg.tabId);
            return { ok: true };
          }
          case 'AGENT_QUERY': {
            const settings = await loadAgentSettings();
            const agent = await runAgent(
              { text: msg.text, page: msg.page, candidates: msg.candidates }, settings, agentDeps,
            );
            return { ok: true, agent };
          }
        }
      } catch (e: any) {
        const error = String(e?.message ?? e);
        // 助手的错误在助手面板里显示，别混进下载进度条
        if (msg.type !== 'AGENT_QUERY') report({ total: 0, done: 0, failed: 0, running: false, message: error });
        return { ok: false, error };
      }
    })();
  });
});
