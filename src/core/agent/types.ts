/**
 * AI 助手（agent）的数据模型。
 *
 * 设计原则（用户拍板）：
 * - 本地优先：颜色 / 尺寸 / 位置 / 序号这类确定性筛选永远在本机完成，不碰网络
 * - 云端可选：只有「有猫的图」这类语义请求才需要模型；默认关闭，用户自带 API Key
 * - 上云时只发页面摘要 + 缩略图联络表，不发页面全文，不发大图
 */
import { t } from '../i18n';

export type CandidateKind = 'image' | 'video' | 'audio';

/** agent 眼里的一个候选素材：图片和音视频统一成一种形状 */
export interface Candidate {
  /** 对应 MediaItem.id（图片）或 MediaHit.url（音视频） */
  id: string;
  kind: CandidateKind;
  url: string;
  /** 小缩略图地址（图片才有）：颜色分析、联络表都用它，绝不拉原图 */
  thumb?: string;
  /** 未知为 0 */
  width: number;
  height: number;
  alt?: string;
  /** 页面分区面包屑，如「评论区 › 用户回复」；嗅探到的流没有 */
  section?: string;
  /** 同类素材在页面里的出现顺序，0 起 */
  index: number;
  ext?: string;
  sizeBytes?: number;
  /** DASH 视频是否配有声音轨 */
  hasAudio?: boolean;
}

export interface PageInfo {
  url: string;
  title: string;
  ogType?: string;
  description?: string;
  /** 页面 h1~h3 文本（截断），用于判断页面类型和给模型定位区块 */
  headings: string[];
  lang?: string;
}

export type PageType =
  | 'video'
  | 'gallery'
  | 'article'
  | 'product'
  | 'social'
  | 'search'
  | 'home'
  | 'other';

export interface PageVerdict {
  type: PageType;
  /** 给用户看的标签，如「视频页 · bilibili.com」 */
  label: string;
  reason: string;
}

export type ColorName =
  | 'red'
  | 'orange'
  | 'yellow'
  | 'green'
  | 'cyan'
  | 'blue'
  | 'purple'
  | 'pink'
  | 'black'
  | 'white'
  | 'gray'
  | 'brown';

/** 本地意图解析结果：能在本机执行的条件 + 剩下需要模型理解的语义 */
export interface Intent {
  kind: CandidateKind | 'any';
  /** 多个颜色是「或」关系 */
  colors: ColorName[];
  minSide?: number;
  maxSide?: number;
  orientation?: 'landscape' | 'portrait' | 'square';
  /** 分区标签（已归一到 sections.ts 里的 label，如「评论区」） */
  section?: string;
  /** 第 N 个（1 起） */
  ordinal?: number;
  limit?: number;
  order?: 'largest' | 'smallest' | 'first' | 'last';
  /** 本地消化不掉的描述，非空就意味着需要云端 */
  semantic: string;
  needsCloud: boolean;
}

export interface AgentSettings {
  cloudEnabled: boolean;
  apiKey: string;
  model: string;
  /** 隐藏项：自定义 API 地址（走代理 / 端到端测试用） */
  apiBaseUrl?: string;
}

export const AGENT_MODELS: ReadonlyArray<{ id: string; label: string; price: string }> = [
  { id: 'claude-opus-5', get label() { return t('Claude Opus 5 · 最准'); }, get price() { return t('$5 / $25 每百万 tokens'); } },
  { id: 'claude-sonnet-5', get label() { return t('Claude Sonnet 5 · 均衡'); }, get price() { return t('$2 / $10 每百万 tokens'); } },
  { id: 'claude-haiku-4-5', get label() { return t('Claude Haiku 4.5 · 最快最省'); }, get price() { return t('$1 / $5 每百万 tokens'); } },
];

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  cloudEnabled: false,
  apiKey: '',
  model: 'claude-opus-5',
};

export const AGENT_SETTINGS_KEY = 'og-agent';

export interface AgentQuery {
  text: string;
  page: PageInfo;
  candidates: Candidate[];
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AgentResult {
  ok: true;
  via: 'local' | 'cloud';
  page: PageVerdict;
  matchedIds: string[];
  /** 给用户看的一句话：做了什么、命中多少 */
  explanation: string;
  /** 本地理解不了、云端又没开 */
  needsCloud?: boolean;
  /** 模型觉得问法有歧义时的追问 */
  clarify?: string;
  intent: Intent;
  usage?: AgentUsage;
}

export type AgentResponse = AgentResult | { ok: false; error: string };
