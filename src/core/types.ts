export type ItemSource = 'img' | 'srcset' | 'background' | 'link' | 'lazy';

export interface MediaItem {
  id: string;
  /** 经站点规则升级后的最终下载地址 */
  url: string;
  /** 页面上原始发现的地址（缩略图） */
  originalUrl: string;
  /** 已知最小的变体地址，专供列表预览用（srcset 最小项；没有就等于 originalUrl） */
  previewUrl?: string;
  /** 命中的站点规则 id，没命中为 undefined */
  ruleId?: string;
  /** 渲染尺寸或 naturalSize，未知为 0 */
  width: number;
  height: number;
  ext: string;
  source: ItemSource;
  alt?: string;
  /** 指定落盘文件名（不含扩展名）。CDN 的内部编号人类读不懂，媒体下载用它 */
  suggestedName?: string;
  /** 强制走页面通道下载（DASH 轨需要页面 Referer + 字节级修正） */
  preferPageChannel?: boolean;
  /** 有值时：这是 DASH 画面轨，需和该声音轨用 ffmpeg 合并成一个带声音的 MP4 */
  muxAudioUrl?: string;
  /** 备用 CDN 地址（主地址失败时依次换着试） */
  backupUrls?: string[];
  muxAudioBackupUrls?: string[];
  /** 所在页面区块的面包屑（「评论区 › 用户回复」），AI 助手按位置筛选用 */
  section?: string;
}

/** 页面级元信息（AI 助手判断页面类型用） */
export interface PageMeta {
  ogType?: string;
  description?: string;
  headings: string[];
  lang?: string;
}

export interface ScanResult {
  items: MediaItem[];
  pageUrl: string;
  pageTitle: string;
  /** 扫描耗时 ms */
  elapsed: number;
  page?: PageMeta;
}

export interface ScanOptions {
  /** 扫描前自动滚到底部，触发懒加载 */
  autoScroll: boolean;
  /** 忽略小于该边长的图（渲染尺寸） */
  minSize: number;
  /** 是否扫描 CSS 背景图 */
  includeBackground: boolean;
}

export interface DownloadOptions {
  concurrency: number;
  /** 下载目录名，空字符串表示直接放 Downloads 根目录 */
  subfolder: string;
  /** 打成一个 zip，而不是逐个落盘 */
  asZip: boolean;
}

export type JobState = 'running' | 'paused' | 'cancelled' | 'done';

export interface TaskProgress {
  total: number;
  done: number;
  failed: number;
  running: boolean;
  /** 批量下载任务的状态；ZIP 等一次性任务没有 */
  state?: JobState;
  message?: string;
}

/** 一条下载记录（chrome://downloads 的对应物）。任务开始即写入，结束时更新 */
export interface HistoryEntry {
  id: string;
  title: string;
  pageUrl: string;
  time: number;
  total: number;
  done: number;
  failed: number;
  state?: JobState;
  /** 失败原因（已翻成人话），失败的历史行直接显示，不用去翻别处 */
  error?: string;
  /** 任务里第一个成功落盘的 downloadId，用于 downloads.show() 定位文件 */
  firstDownloadId?: number;
}

/** 嗅探/扫描到的一条视频或音频 */
export interface MediaHit {
  url: string;
  kind: 'video' | 'audio' | 'stream';
  mime?: string;
  /** Content-Length 字节数，未知为 undefined */
  size?: number;
  /** 视频画面尺寸，仅 DOM 扫描到的 <video> 有，未知为 0 */
  width?: number;
  height?: number;
  /** 'sniffer' = 网络层捕获；'dom' = 页面 <video>/<audio> 标签 */
  via: 'sniffer' | 'dom';
  /**
   * 流的子类型：
   * - 'dash-track' = DASH 单轨（B站等）。分片是对同一 URL 的 Range 请求，
   *   去掉 range 参数整包下载即得完整轨道文件，可直接下载。
   * - 'hls' = m3u8 清单，需要下载全部分片再拼接。
   */
  streamKind?: 'dash-track' | 'hls';
  /** 轨道类型：视频轨没有声音，音频轨没有画面 */
  track?: 'video' | 'audio';
  /** 视频编码。AV1/HEVC 通用性差（QuickTime 打不开），H.264 到处都能播 */
  codec?: 'h264' | 'hevc' | 'av1';
  /** 已观察到的分片数，用于判断是否还在加载 */
  segments?: number;
  /**
   * DASH 配对的音频轨地址。视频轨和音频轨同属一个视频时合并成一条展示，
   * 用户看到的是「一个视频」而不是两条轨 —— DASH 的内部结构不该漏给用户。
   */
  pairedAudioUrl?: string;
  /** 所在页面区块的面包屑，仅 DOM 扫描到的 <video>/<audio> 有 */
  section?: string;
  /**
   * 来自站点自己的轨道清单（B站 __playinfo__ / playurl），已经挑好编码并配好声音。
   * 归并时原样保留，不再参与散轨配对。
   */
  curated?: boolean;
  /** curated 条目覆盖的全部轨道文件名：嗅探到的同名散轨在归并时去掉，避免重复 */
  coversKeys?: string[];
  /** 展示名（没有时显示 URL 文件名） */
  name?: string;
  /** 备用 CDN 地址（B站 清单的 backupUrl）：主地址 403/超时时换着试，播放器自己也是这么做的 */
  backupUrls?: string[];
  /**
   * 真正发起这个请求的页面来源（webRequest 的 initiator，带结尾 /）。
   * iframe 里的播放器（嵌在博客里的视频）要用它当 Referer，而不是外层网页
   */
  referer?: string;
  pairedAudioBackupUrls?: string[];
}

/** 当前任务里单个文件的视图（弹窗「正在下载」列表用） */
export interface JobItemView {
  name: string;
  status: 'pending' | 'active' | 'paused' | 'done' | 'failed' | 'cancelled';
  /** 失败原因（已翻成人话） */
  error?: string;
  /** 页面通道抓取进度（0~100），仅整包抓取时有 */
  percent?: number;
}
