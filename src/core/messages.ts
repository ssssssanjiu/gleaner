import type {
  DownloadOptions, HistoryEntry, JobItemView, JobState, MediaHit, MediaItem, PageMeta, ScanOptions, ScanResult,
  TaskProgress,
} from './types';
import type { AgentResult, Candidate, PageInfo } from './agent/types';

export type Message =
  /** popup → content script */
  | { type: 'SCAN'; options: ScanOptions }
  /** popup → content script：页面元信息（og:type、标题层级），AI 助手判断页面类型用 */
  | { type: 'PAGE_INFO' }
  /**
   * popup → background：AI 助手。候选素材由弹窗整理好一起送过来
   * （background 是 SW，没有页面上下文；颜色分析、联络表拼图在那边用 OffscreenCanvas 做）
   */
  | { type: 'AGENT_QUERY'; text: string; page: PageInfo; candidates: Candidate[] }
  /**
   * popup → background：图片 + 音视频混合成「一个」任务下载（AI 助手命中项一键下载）。
   * 单独发两个任务会互相顶掉 —— 任务系统同一时刻只有一个当前任务。
   */
  | {
      type: 'DOWNLOAD_MIXED';
      items: MediaItem[];
      media: Array<{
        url: string; audioUrl?: string; backupUrls?: string[]; audioBackupUrls?: string[]; referer?: string;
      }>;
      pageTitle: string;
      pageUrl: string;
      tabId?: number;
    }
  /** popup → background。DOWNLOAD 立即返回，进度走 PROGRESS 广播 */
  | { type: 'DOWNLOAD'; items: MediaItem[]; options: DownloadOptions; pageTitle: string; pageUrl?: string }
  | { type: 'ZIP'; items: MediaItem[]; name: string }
  | { type: 'JOB_CONTROL'; action: 'pause' | 'resume' | 'cancel' }
  | { type: 'GET_STATE' }
  /** downloadId 缺省时打开默认下载目录 */
  | { type: 'REVEAL'; downloadId?: number }
  | { type: 'CLEAR_HISTORY' }
  /** popup → background：取某标签页嗅探到的媒体 */
  | { type: 'GET_MEDIA'; tabId: number }
  /** popup → background：下载一条媒体（走任务系统，享受角标/记录/暂停） */
  | {
      type: 'DOWNLOAD_MEDIA'; url: string; audioUrl?: string; pageTitle: string; pageUrl: string; tabId?: number;
      /** 备用 CDN 地址（B站 清单的 backupUrl） */
      backupUrls?: string[]; audioBackupUrls?: string[];
      /** 发起请求的页面来源（iframe 播放器），优先于 pageUrl 当 Referer */
      referer?: string;
    }
  /**
   * popup → background：规则升级过 / 懒加载的图，扫描时不知道原图多大。
   * 后台只拉文件头（Range）读出宽高，卡片才能标「图片 + 分辨率」
   */
  | { type: 'PROBE_SIZES'; items: Array<{ id: string; url: string }> }
  /** popup → content script：扫页面上的 <video>/<audio> 标签 */
  | { type: 'MEDIA_SCAN' }
  /** offscreen → background：整包抓取的进度（长视频要几十秒，不报进度像死了） */
  | { type: 'FETCH_PROGRESS'; url: string; received: number; total: number }
  /**
   * background → offscreen：直接抓取媒体并生成可下载 blob。
   * 关键：字节全程留在 offscreen 一个上下文里，绝不跨 sendMessage
   * （ArrayBuffer 过 sendMessage 会被 JSON 序列化成 {}，落盘就是 0 字节 —— 实测踩过）。
   * offscreen 是扩展页，带 host 权限时 fetch 不受 CORS 限制，Referer 由 DNR 补。
   */
  | {
      type: 'OFFSCREEN_FETCH'; url: string; isAudio: boolean; maxBytes: number; backups?: string[];
      /** 失败文案按它给建议：视频「重新播放一下」，图片「有防盗链」 */
      kind?: 'media' | 'image';
    }
  /**
   * background → offscreen：抓画面轨 + 声音轨，用 ffmpeg.wasm 合成一个带声音的 MP4。
   * 同样字节不跨消息边界，只回 blob URL。
   */
  | {
      type: 'OFFSCREEN_MUX'; videoUrl: string; audioUrl: string; maxBytes: number;
      videoBackups?: string[]; audioBackups?: string[];
    }
  /** background → offscreen：释放不再需要的 blob URL */
  | { type: 'OFFSCREEN_REVOKE'; blobUrl: string }
  /**
   * background → offscreen：中止这些地址的在途抓取。
   * keepPartial=true（暂停）：已抓的字节留着，下次同一地址带 Range 续抓；false（取消）：丢弃
   */
  | { type: 'OFFSCREEN_ABORT'; urls: string[]; keepPartial: boolean }
  /** offscreen → background：ZIP 打包进度 */
  | { type: 'ZIP_PROGRESS'; done: number; failed: number; total: number }
  /** background → offscreen document（类型必须和上面的 ZIP 区分开，否则会被自己人重复处理） */
  | { type: 'OFFSCREEN_ZIP'; items: MediaItem[] }
  /** background → popup 广播 */
  | { type: 'PROGRESS'; progress: TaskProgress };

export type ScanResponse = { ok: true; result: ScanResult } | { ok: false; error: string };
export type ActionResponse =
  | {
      ok: true;
      done?: number;
      failed?: number;
      state?: JobState;
      progress?: TaskProgress;
      items?: JobItemView[];
      history?: HistoryEntry[];
      media?: MediaHit[];
      agent?: AgentResult;
      /** 给用户看的补充说明（比如「定位文件」退回到了默认下载目录） */
      note?: string;
      /** PROBE_SIZES 的结果：id → [宽, 高]（读不出的不出现） */
      sizes?: Record<string, [number, number]>;
    }
  | { ok: false; error: string };

export type MediaScanResponse = { ok: true; media: MediaHit[] } | { ok: false; error: string };
export type PageInfoResponse = { ok: true; page: PageMeta } | { ok: false; error: string };
export type BlobResponse =
  | { ok: true; blobUrl: string; size: number; patchedHevc?: boolean }
  /** aborted：被 OFFSCREEN_ABORT 中止（暂停/取消），不是失败 */
  | { ok: false; error: string; aborted?: boolean };
export type ZipResponse = { blobUrl: string; done: number; failed: number } | { error: string };
