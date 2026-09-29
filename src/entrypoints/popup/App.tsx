import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  HistoryEntry, JobItemView, MediaHit, MediaItem, PageMeta, ScanOptions, TaskProgress,
} from '@/core/types';
import type {
  ActionResponse, MediaScanResponse, Message, PageInfoResponse, ScanResponse,
} from '@/core/messages';
import { RULES } from '@/core/rules';
import { sanitize } from '@/core/filename';
import { FILE_ACCESS_REASON, humanizeError, unsupportedReason } from '@/core/page-support';
import { consolidateMedia } from '@/core/media';
import { AGENT_MODELS, AGENT_SETTINGS_KEY, DEFAULT_AGENT_SETTINGS } from '@/core/agent/types';
import type { AgentResult, AgentSettings, PageInfo } from '@/core/agent/types';
import { buildCandidates } from '@/core/agent/candidates';
import { classifyPage } from '@/core/agent/page-type';
import { createRecognizer } from '@/core/agent/voice';
import {
  EMPTY_VIEW, clearFinished, isLive, onBroadcast, onState, progressLabel, visibleBars,
} from './progress';
import type { ProgressView } from './progress';

const DEFAULT_SCAN: ScanOptions = { autoScroll: true, minSize: 200, includeBackground: true };

export default function App() {
  const [scanOpts, setScanOpts] = useState<ScanOptions>(DEFAULT_SCAN);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [keyword, setKeyword] = useState('');
  const [pageTitle, setPageTitle] = useState('');
  const [tabUrl, setTabUrl] = useState('');
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [pview, setPview] = useState<ProgressView>(EMPTY_VIEW);
  /** 「定位文件」等操作的简短反馈，几秒后自动消失 */
  const [flash, setFlash] = useState<{ text: string; warn?: boolean } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
  /** 用户是否已在扩展管理里打开「允许访问文件网址」 */
  const [fileAccess, setFileAccess] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [jobItems, setJobItems] = useState<JobItemView[]>([]);
  const [media, setMedia] = useState<MediaHit[]>([]);
  const [mediaSelected, setMediaSelected] = useState<Set<string>>(new Set());
  /** 正在探测原图尺寸的卡片 id（规则升级过 / 懒加载，扫描时不知道原图多大） */
  const [probing, setProbing] = useState<Set<string>>(new Set());
  const [mediaNote, setMediaNote] = useState('');
  const [pageMeta, setPageMeta] = useState<PageMeta | null>(null);

  // ---- AI 助手 ----
  const [agentText, setAgentText] = useState('');
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentResult, setAgentResult] = useState<AgentResult | null>(null);
  const [agentError, setAgentError] = useState('');
  const [agentSettings, setAgentSettings] = useState<AgentSettings>(DEFAULT_AGENT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);
  const [listening, setListening] = useState(false);
  const stopListenRef = useRef<() => void>(() => {});
  const scannedRef = useRef(false);
  const recognizer = useMemo(() => createRecognizer(window), []);

  async function currentTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  /**
   * 三路来源合并：网络嗅探（后台 webRequest） + 页面钩子（注入脚本挂 fetch/XHR）
   * + 标签扫描。任何一路失败都要说出来 —— 静默吞异常会让「坏了」和「没抓到」
   * 长得一模一样，排查不了。
   */
  async function refreshMedia(): Promise<MediaHit[]> {
    const notes: string[] = [];
    try {
      const tab = await currentTab();
      if (!tab?.id) {
        setMediaNote('拿不到当前标签页');
        return [];
      }
      const sniffed: ActionResponse = await browser.runtime
        .sendMessage({ type: 'GET_MEDIA', tabId: tab.id } satisfies Message)
        .then((r) => r as ActionResponse)
        .catch((e): ActionResponse => ({ ok: false, error: String(e?.message ?? e) }));
      const dom: MediaScanResponse = await browser.tabs
        .sendMessage(tab.id, { type: 'MEDIA_SCAN' } satisfies Message)
        .then((r) => r as MediaScanResponse)
        .catch((e): MediaScanResponse => ({ ok: false, error: String(e?.message ?? e) }));

      if (!sniffed?.ok) notes.push(`后台嗅探不可用（${sniffed?.error ?? '无响应'}）`);
      if (!dom?.ok) notes.push('页面脚本未注入，刷新页面后重试');

      // 跨 CDN 去重 + 音视频轨配对成一条，见 core/media.ts
      const list = consolidateMedia([
        ...((sniffed?.ok && sniffed.media) || []),
        ...((dom?.ok && dom.media) || []),
      ]);
      setMedia(list);
      setMediaNote(notes.join('；'));
      return list;
    } catch (e: any) {
      setMediaNote(String(e?.message ?? e));
      return [];
    }
  }

  async function fetchPageInfo(tabId: number): Promise<PageMeta | null> {
    const res = (await browser.tabs
      .sendMessage(tabId, { type: 'PAGE_INFO' } satisfies Message)
      .catch(() => null)) as PageInfoResponse | null;
    if (res?.ok) {
      setPageMeta(res.page);
      return res.page;
    }
    return null;
  }

  /**
   * pairedAudioUrl 有值时是 DASH 分轨，画面和声音一起下，算同一个任务。
   * 备用 CDN 地址（B站 清单里的 backupUrl）一并带上，主 CDN 挂了后台会换着试
   */
  async function downloadMedia(m: MediaHit) {
    const tab = await currentTab();
    const res = (await browser.runtime.sendMessage({
      type: 'DOWNLOAD_MEDIA',
      url: m.url,
      audioUrl: m.pairedAudioUrl,
      backupUrls: m.backupUrls,
      audioBackupUrls: m.pairedAudioBackupUrls,
      referer: m.referer,
      pageTitle,
      pageUrl: tabUrl,
      tabId: tab?.id,
    } satisfies Message).catch(() => null)) as ActionResponse | null;
    if (res && !res.ok) setError(res.error);
  }
  const [concurrency, setConcurrency] = useState(4);
  const [asZip, setAsZip] = useState(false);

  async function refreshState() {
    const requestedAt = Date.now();
    const res = (await browser.runtime
      .sendMessage({ type: 'GET_STATE' } satisfies Message)
      .catch(() => null)) as ActionResponse | null;
    if (res?.ok) {
      // 只补数字，不盖掉广播给的说明文字；弹窗刚打开时不把早已结束的旧任务摆出来
      setPview((v) => onState(v, res.progress, requestedAt, Date.now()));
      setJobItems(res.items ?? []);
      setHistory(res.history ?? []);
    }
  }

  function showFlash(text: string, warn = false) {
    clearTimeout(flashTimer.current);
    setFlash({ text, warn });
    flashTimer.current = setTimeout(() => setFlash(null), warn ? 9000 : 6000);
  }

  useEffect(() => {
    const listener = (raw: unknown) => {
      const msg = raw as Message;
      if (msg.type !== 'PROGRESS') return;
      setPview((v) => onBroadcast(v, msg.progress, Date.now()));
      // 每次进度变化都同步当前任务列表和记录（本地消息，开销可忽略）
      refreshState();
    };
    browser.runtime.onMessage.addListener(listener);
    return () => browser.runtime.onMessage.removeListener(listener);
  }, []);

  // 面板一打开：判断当前页能不能扫 + 恢复后台任务状态和下载记录
  // （任务归 background 所有，弹窗只是视图 —— 关掉弹窗下载不会停）
  useEffect(() => {
    // 本地文件页要先知道用户有没有打开「允许访问文件网址」，再决定拦不拦（popup-ux#14）
    Promise.all([
      currentTab().catch(() => undefined),
      browser.extension.isAllowedFileSchemeAccess().catch(() => false),
    ])
      .then(([tab, fileOk]) => {
        setFileAccess(Boolean(fileOk));
        setTabUrl(tab?.url ?? '');
        setPageTitle(tab?.title ?? '');
        if (tab?.id) fetchPageInfo(tab.id);
      })
      .catch(() => {});
    refreshState();
    refreshMedia();
    browser.storage.local
      .get(AGENT_SETTINGS_KEY)
      .then((o) => {
        const saved = o?.[AGENT_SETTINGS_KEY] as Partial<AgentSettings> | undefined;
        if (saved) setAgentSettings({ ...DEFAULT_AGENT_SETTINGS, ...saved });
      })
      .catch(() => {});
    // 设置可能在别处改（另一个弹窗实例、脚本），面板上的开关得跟着变，不然显示的和后台用的不一致
    const onStorage = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !(AGENT_SETTINGS_KEY in changes)) return;
      const next = changes[AGENT_SETTINGS_KEY].newValue as Partial<AgentSettings> | undefined;
      setAgentSettings({ ...DEFAULT_AGENT_SETTINGS, ...(next ?? {}) });
    };
    browser.storage.onChanged.addListener(onStorage);
    return () => {
      browser.storage.onChanged.removeListener(onStorage);
      stopListenRef.current();
      clearTimeout(flashTimer.current);
    };
  }, []);

  async function control(action: 'pause' | 'resume' | 'cancel') {
    const res = (await browser.runtime
      .sendMessage({ type: 'JOB_CONTROL', action } satisfies Message)
      .catch(() => null)) as ActionResponse | null;
    if (res && !res.ok) setError(res.error);
  }

  /**
   * 定位文件 / 打开下载位置。记录被 Chrome 清掉或文件被挪走时，后台会退回打开默认下载目录并给出 note，
   * 这里一定要让用户看到，否则就是「点了没反应」（popup-ux#13）
   */
  async function reveal(downloadId?: number) {
    const res = (await browser.runtime
      .sendMessage({ type: 'REVEAL', downloadId } satisfies Message)
      .catch((e): ActionResponse => ({ ok: false, error: String(e?.message ?? e) }))) as ActionResponse | undefined;
    if (!res) return;
    if (!res.ok) showFlash(`没能打开文件位置：${humanizeError(res.error)}`, true);
    else if (res.note) showFlash(res.note);
  }

  function openExtensionSettings() {
    browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` }).catch(() => {});
  }

  const blocked = useMemo(() => unsupportedReason(tabUrl, { fileAccess }), [tabUrl, fileAccess]);

  const visible = useMemo(() => {
    const k = keyword.trim().toLowerCase();
    if (!k) return items;
    return items.filter(
      (it) => it.url.toLowerCase().includes(k) || (it.alt ?? '').toLowerCase().includes(k),
    );
  }, [items, keyword]);

  const matchedRule = useMemo(() => {
    const ids = new Set(items.map((i) => i.ruleId).filter(Boolean));
    return RULES.filter((r) => ids.has(r.id)).map((r) => r.name);
  }, [items]);

  /** 页面类型的本地判断：不用模型、不联网，扫完就有 */
  const pageVerdict = useMemo(() => {
    if (!tabUrl || blocked) return null;
    const page: PageInfo = {
      url: tabUrl, title: pageTitle, headings: pageMeta?.headings ?? [],
      ogType: pageMeta?.ogType, description: pageMeta?.description, lang: pageMeta?.lang,
    };
    return classifyPage(page, buildCandidates(items, media));
  }, [tabUrl, pageTitle, pageMeta, items, media, blocked]);

  /**
   * 卡片要标「图片 + 分辨率」：扫描时尺寸未知的（规则升级到原图的、懒加载的），
   * 让后台只拉文件头读出真实宽高，分批回来就更新
   */
  async function probeSizes(list: MediaItem[]) {
    const unknown = list.filter((i) => !i.width && !i.height).slice(0, 200);
    if (!unknown.length) return;
    setProbing(new Set(unknown.map((i) => i.id)));
    for (let i = 0; i < unknown.length; i += 24) {
      const batch = unknown.slice(i, i + 24);
      const res = (await browser.runtime
        .sendMessage({ type: 'PROBE_SIZES', items: batch.map((b) => ({ id: b.id, url: b.url })) } satisfies Message)
        .catch(() => null)) as ActionResponse | null;
      const sizes = res && res.ok ? res.sizes ?? {} : {};
      setItems((prev) =>
        prev.map((it) => (sizes[it.id] ? { ...it, width: sizes[it.id][0], height: sizes[it.id][1] } : it)),
      );
      setProbing((prev) => {
        const next = new Set(prev);
        for (const b of batch) next.delete(b.id);
        return next;
      });
    }
  }

  async function scan(): Promise<MediaItem[]> {
    setScanning(true);
    setError('');
    // 只清掉已经结束的结果。暂停中/进行中的任务不能跟着消失 ——
    // 暂停后后台不再发进度，清掉就再也回不来了（popup-ux#11）
    setPview(clearFinished);
    try {
      const tab = await currentTab();
      if (!tab?.id) throw new Error('拿不到当前标签页');
      setPageTitle(tab.title ?? '');

      const send = () =>
        browser.tabs.sendMessage(tab.id!, { type: 'SCAN', options: scanOpts } satisfies Message);

      let res: ScanResponse;
      try {
        res = (await send()) as ScanResponse;
      } catch {
        // 扩展刚装上、页面早就打开了 —— 手动注入一次
        await browser.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content-scripts/content.js'],
        });
        res = (await send()) as ScanResponse;
      }

      if (!res?.ok) throw new Error(res?.error ?? '扫描无响应');
      setItems(res.result.items);
      setSelected(new Set(res.result.items.map((i) => i.id)));
      if (res.result.page) setPageMeta(res.result.page);
      scannedRef.current = true;
      void probeSizes(res.result.items);
      return res.result.items;
    } catch (e: any) {
      setError(humanizeError(String(e?.message ?? e)));
      return [];
    } finally {
      setScanning(false);
      refreshState();
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleMedia(url: string) {
    setMediaSelected((prev) => {
      const next = new Set(prev);
      next.has(url) ? next.delete(url) : next.add(url);
      return next;
    });
  }

  const chosen = items.filter((i) => selected.has(i.id));
  const chosenMedia = media.filter(
    (m) => mediaSelected.has(m.url) && !(m.kind === 'stream' && m.streamKind !== 'dash-track'),
  );

  async function download() {
    if (!chosen.length) return;
    const name = sanitize(pageTitle || 'Gleaner');
    const msg: Message = asZip
      ? { type: 'ZIP', items: chosen, name }
      : {
          type: 'DOWNLOAD',
          items: chosen,
          options: { concurrency, subfolder: '', asZip: false },
          pageTitle,
          pageUrl: tabUrl,
        };
    const res = (await browser.runtime.sendMessage(msg)) as { ok: boolean; error?: string };
    if (!res?.ok) setError(res?.error ?? '下载失败');
    // 任务结束后刷新记录区
    if (res?.ok && !asZip) setTimeout(refreshState, 500);
  }

  /** 助手命中的图片 + 音视频合成一个任务下载 */
  async function downloadChosenAll() {
    if (!chosen.length && !chosenMedia.length) return;
    const tab = await currentTab();
    const res = (await browser.runtime
      .sendMessage({
        type: 'DOWNLOAD_MIXED',
        items: chosen,
        media: chosenMedia.map((m) => ({
          url: m.url,
          audioUrl: m.pairedAudioUrl,
          backupUrls: m.backupUrls,
          audioBackupUrls: m.pairedAudioBackupUrls,
          referer: m.referer,
        })),
        pageTitle,
        pageUrl: tabUrl,
        tabId: tab?.id,
      } satisfies Message)
      .catch((e) => ({ ok: false, error: String(e?.message ?? e) }))) as ActionResponse;
    if (!res?.ok) setError(res?.error ?? '下载失败');
    else setTimeout(refreshState, 500);
  }

  // ---------------- AI 助手 ----------------

  async function saveAgentSettings(patch: Partial<AgentSettings>) {
    const next = { ...agentSettings, ...patch };
    setAgentSettings(next);
    await browser.storage.local.set({ [AGENT_SETTINGS_KEY]: next }).catch(() => {});
  }

  async function runAssistant(text: string) {
    const q = text.trim();
    if (!q || agentBusy) return;
    if (blocked) {
      setAgentError(`${blocked}，换个普通网页再试`);
      return;
    }
    setAgentBusy(true);
    setAgentError('');
    setAgentResult(null);
    try {
      const tab = await currentTab();
      if (!tab?.id) throw new Error('拿不到当前标签页');
      // 还没扫过就先扫一遍：助手需要完整的候选列表
      let curItems = items;
      if (!scannedRef.current) curItems = await scan();
      const curMedia = await refreshMedia();
      const meta = (await fetchPageInfo(tab.id)) ?? pageMeta;
      const page: PageInfo = {
        url: tab.url ?? tabUrl,
        title: tab.title ?? pageTitle,
        headings: meta?.headings ?? [],
        ogType: meta?.ogType,
        description: meta?.description,
        lang: meta?.lang,
      };
      const candidates = buildCandidates(curItems, curMedia);
      const res = (await browser.runtime.sendMessage({
        type: 'AGENT_QUERY', text: q, page, candidates,
      } satisfies Message)) as ActionResponse | undefined;
      if (!res?.ok) throw new Error(res?.error ?? '助手无响应');
      const r = res.agent!;
      setAgentResult(r);
      // 命中项直接打勾：图片在网格里、音视频在媒体区
      const ids = new Set(r.matchedIds);
      setSelected(new Set(curItems.filter((i) => ids.has(i.id)).map((i) => i.id)));
      setMediaSelected(new Set(curMedia.filter((m) => ids.has(m.url)).map((m) => m.url)));
    } catch (e: any) {
      setAgentError(humanizeError(String(e?.message ?? e)));
    } finally {
      setAgentBusy(false);
    }
  }

  function openMicPage() {
    browser.tabs.create({ url: browser.runtime.getURL('/mic.html' as never) }).catch(() => {});
  }

  function toggleVoice() {
    if (listening) {
      stopListenRef.current();
      return;
    }
    setAgentError('');
    setListening(true);
    stopListenRef.current = recognizer.listen({
      onInterim: (t) => setAgentText(t),
      onFinal: (t) => {
        setAgentText(t);
        void runAssistant(t);
      },
      onError: (m) => {
        setAgentError(m);
        setListening(false);
        // 弹窗里弹不出授权框，借一个扩展页面请求一次
        if (/权限/.test(m)) openMicPage();
      },
      onEnd: () => setListening(false),
    });
  }

  const verdictShown = agentResult?.page ?? pageVerdict;
  const totalChosen = chosen.length + chosenMedia.length;
  const bars = visibleBars(pview);
  const liveJob = isLive(bars.job) ? bars.job : null;

  function fmtTime(t: number) {
    const d = new Date(t);
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function progressBar(p: TaskProgress, kind: 'job' | 'zip') {
    const label = progressLabel(p);
    const pct = p.total > 0 ? Math.min(100, ((p.done + (kind === 'zip' ? p.failed : 0)) / p.total) * 100) : 0;
    return (
      <div className={`progress ${kind} ${p.state ?? ''}`} data-testid={`progress-${kind}`}>
        <div className="bar" style={{ width: `${pct}%` }} />
        <span className="p-label" title={label}>{label}</span>
        <span className="p-count">
          {p.done}/{p.total}
          {p.failed ? ` · 失败 ${p.failed}` : ''}
        </span>
        {kind === 'job' && isLive(p) && (
          <span className="job-controls">
            {p.state === 'running' ? (
              <button onClick={() => control('pause')}>暂停</button>
            ) : (
              <button onClick={() => control('resume')}>继续</button>
            )}
            <button onClick={() => control('cancel')}>取消</button>
          </span>
        )}
      </div>
    );
  }

  /*
   * 布局（popup-ux#1）：Chrome 弹窗最高 600px，整页绝不能滚动。
   *   header                 固定
   *   .top  助手 / 扫描选项   固定，内容再多也最多占一小半，自己滚
   *   .main 媒体 + 图片网格   占满剩余空间，自己滚（图片再多也只在这里滚）
   *   .dock 下载按钮 / 进度 + 暂停继续取消 / 正在下载列表 / 下载记录   固定在底部，永远看得见
   */
  return (
    <div className="app">
      <header>
        <div className="brand">
          拾穗 <span className="brand-en">Gleaner</span> <span className="badge">v0.2</span>
        </div>
        <div className="sub">零上报 · 全本地处理</div>
      </header>

      <div className="top">
        {!blocked && (
          <section className="agent" data-testid="agent">
            <div className="agent-row">
              <input
                className="search"
                placeholder="用一句话说要什么：所有绿色的图片 / 评论区的视频 / 最大的 3 张图"
                value={agentText}
                onChange={(e) => setAgentText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void runAssistant(agentText);
                }}
                disabled={agentBusy}
              />
              <button
                className={`mic ${listening ? 'listening' : ''}`}
                title={recognizer.supported ? (listening ? '停止' : '语音输入') : '当前浏览器不支持语音识别'}
                onClick={toggleVoice}
                disabled={!recognizer.supported || agentBusy}
              >
                {listening ? '■' : '🎤'}
              </button>
              <button className="primary" onClick={() => runAssistant(agentText)} disabled={agentBusy || !agentText.trim()}>
                {agentBusy ? '思考中…' : '执行'}
              </button>
              <button className="link" onClick={() => setShowSettings((s) => !s)}>
                {showSettings ? '收起' : 'AI 设置'}
              </button>
            </div>

            <div className="agent-status">
              {verdictShown && (
                <span className="chip" title={verdictShown.reason}>
                  {verdictShown.label}
                </span>
              )}
              {agentResult && (
                <span className={`chip ${agentResult.via}`} title={agentResult.usage ? `${agentResult.usage.model} · 输入 ${agentResult.usage.inputTokens} / 输出 ${agentResult.usage.outputTokens} tokens` : '没有联网'}>
                  {agentResult.via === 'cloud' ? '云端理解' : '本地完成'}
                </span>
              )}
              {agentError ? (
                <span className="agent-explain warn">{agentError}</span>
              ) : agentResult ? (
                <span className={`agent-explain ${agentResult.needsCloud ? 'warn' : ''}`}>
                  {agentResult.clarify ? `追问：${agentResult.clarify}` : agentResult.explanation}
                </span>
              ) : (
                <span className="agent-explain">
                  {listening ? '正在听…' : '颜色、尺寸、位置在本地筛；需要看内容的请求可选开云端'}
                </span>
              )}
              {agentResult?.needsCloud && (
                <button className="link" onClick={() => setShowSettings(true)}>去开启</button>
              )}
              {(agentResult || chosenMedia.length > 0) && totalChosen > 0 && (
                <button className="primary" onClick={downloadChosenAll}>
                  下载选中 {totalChosen} 项
                </button>
              )}
            </div>

            {showSettings && (
              <div className="agent-settings">
                <label>
                  <input
                    type="checkbox"
                    checked={agentSettings.cloudEnabled}
                    onChange={(e) => saveAgentSettings({ cloudEnabled: e.target.checked })}
                  />
                  开启云端助手
                </label>
                <span className="h-meta">默认关闭；开启后才会把请求发给 Anthropic</span>
                <label htmlFor="og-key">API Key</label>
                <input
                  id="og-key"
                  type="password"
                  placeholder="sk-ant-…（只存在本机，不会上传到别处）"
                  value={agentSettings.apiKey}
                  onChange={(e) => saveAgentSettings({ apiKey: e.target.value.trim() })}
                  autoComplete="off"
                />
                <label htmlFor="og-model">模型</label>
                <select
                  id="og-model"
                  value={agentSettings.model}
                  onChange={(e) => saveAgentSettings({ model: e.target.value })}
                >
                  {AGENT_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} · {m.price}
                    </option>
                  ))}
                </select>
                <div className="full">
                  会发送什么：你的这句话、页面摘要（标题、素材尺寸 / alt / 所在区块，不含正文）、
                  一张缩略图拼成的联络表。绝不发原图，绝不在你没点「执行」时发任何东西。
                  颜色 / 尺寸 / 方向 / 位置 / 序号这类筛选永远在本机完成，不会上云。
                  语音识别由 Chrome 内置能力完成（音频经 Google 语音服务），与拾穗无关。
                </div>
              </div>
            )}
          </section>
        )}

        <section className="opts">
          <label>
            <input
              type="checkbox"
              checked={scanOpts.autoScroll}
              onChange={(e) => setScanOpts({ ...scanOpts, autoScroll: e.target.checked })}
            />
            自动滚动触发懒加载
          </label>
          <label>
            <input
              type="checkbox"
              checked={scanOpts.includeBackground}
              onChange={(e) => setScanOpts({ ...scanOpts, includeBackground: e.target.checked })}
            />
            含 CSS 背景图
          </label>
          <label>
            最小边长
            <input
              type="number"
              min={0}
              step={50}
              value={scanOpts.minSize}
              onChange={(e) => setScanOpts({ ...scanOpts, minSize: Number(e.target.value) })}
            />
            px
          </label>
          <button className="primary" onClick={scan} disabled={scanning || Boolean(blocked)}>
            {scanning ? '扫描中…' : '扫描当前页面'}
          </button>
        </section>

        {blocked && (
          <div className="notice">
            {blocked === FILE_ACCESS_REASON ? (
              <>
                {blocked}：点「去设置」，在拾穗的详情页打开「允许访问文件网址」，然后刷新这个本地页面、重新打开面板。
                <button className="link" onClick={openExtensionSettings}>去设置</button>
              </>
            ) : (
              <>{blocked}。切换到一个普通网页再打开面板。</>
            )}
          </div>
        )}

        {error && <div className="error">{error}</div>}
      </div>

      <main className="main">
        {!blocked && (
          <section className="media">
            <div className="history-head media-head">
              <span>视频 / 音频（{media.length}）</span>
              <button className="link" onClick={refreshMedia}>刷新</button>
              {mediaNote ? (
                <span className="h-meta media-warn">⚠ {mediaNote}</span>
              ) : media.length === 0 ? (
                <span className="h-meta">未检测到 —— 先在页面上点播放，再点「刷新」</span>
              ) : null}
            </div>
            {/* 全部列出，多了在这一栏里滚动（以前只渲染前 8 条，排在后面的音频看不到也下不了） */}
            {media.map((m) => (
              <div key={m.url} className={`media-row ${mediaSelected.has(m.url) ? 'on' : ''}`} title={m.url}>
                <input
                  type="checkbox"
                  checked={mediaSelected.has(m.url)}
                  onChange={() => toggleMedia(m.url)}
                  // m3u8 清单还不支持：之前照样能勾，「下载选中」会存下一个文本清单还显示成功
                  disabled={m.kind === 'stream' && m.streamKind !== 'dash-track'}
                  title={
                    m.kind === 'stream' && m.streamKind !== 'dash-track'
                      ? 'm3u8 清单需要下载全部分片再拼接，暂不支持'
                      : '选中后可和图片一起下载'
                  }
                />
                <span className={`m-kind ${m.kind === 'audio' ? 'audio' : 'video'}`}>
                  {m.kind === 'audio' ? '音频' : '视频'}
                  {m.width && m.height ? ` ${m.width}×${m.height}` : ''}
                </span>
                <span className="j-name">
                  {m.name ?? decodeURIComponent(m.url.split('/').pop()?.split('?')[0] ?? m.url)}
                </span>
                {m.section ? <span className="h-meta" title="所在区块">{m.section}</span> : null}
                {m.size ? <span className="h-meta">{(m.size / 1048576).toFixed(1)}MB</span> : null}
                {m.codec === 'hevc' ? (
                  <span
                    className="h-meta"
                    title="HEVC 编码。下载时会自动修正容器标记（hev1→hvc1），QuickTime 可直接播放"
                  >
                    HEVC·已自动兼容
                  </span>
                ) : m.codec === 'av1' ? (
                  <span className="h-meta media-warn" title="AV1 编码，旧版 QuickTime 不支持，请用 VLC / IINA">
                    AV1·需 VLC
                  </span>
                ) : null}
                {m.kind === 'stream' && m.streamKind !== 'dash-track' ? (
                  <span className="h-meta" title="m3u8 清单需要下载全部分片再拼接，下个版本支持">
                    m3u8·暂不支持
                  </span>
                ) : (
                  <>
                    {/* 「含声音 / 无声音轨」只说画面轨；音频行本身就是声音，不能再标「无声音轨」 */}
                    {m.streamKind === 'dash-track' && m.kind !== 'audio' && (
                      <span
                        className="h-meta"
                        title={
                          m.pairedAudioUrl
                            ? '下载时自动合并画面和声音为一个带声音的 MP4（ffmpeg，本地完成）'
                            : '这个源只有画面轨，没有独立声音'
                        }
                      >
                        {m.pairedAudioUrl ? '含声音' : '无声音轨'}
                      </span>
                    )}
                    <button
                      className="link media-dl"
                      onClick={() => downloadMedia(m)}
                    >
                      下载
                    </button>
                  </>
                )}
              </div>
            ))}
          </section>
        )}

        {items.length > 0 ? (
          <>
            <section className="toolbar">
              <input
                className="search"
                placeholder="按 URL / alt 过滤"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              <button onClick={() => setSelected(new Set(visible.map((i) => i.id)))}>全选</button>
              <button onClick={() => setSelected(new Set())}>清空</button>
              <span className="count">
                {chosen.length} / {items.length}
              </span>
            </section>

            {matchedRule.length > 0 && (
              <div className="hint">已套用原图规则：{matchedRule.join('、')}</div>
            )}

            <section className="grid">
              {visible.map((it) => (
                <button
                  key={it.id}
                  className={`cell ${selected.has(it.id) ? 'on' : ''}`}
                  onClick={() => toggle(it.id)}
                  title={it.section ? `${it.section}\n${it.url}` : it.url}
                >
                  <img
                    src={it.previewUrl ?? it.originalUrl}
                    loading="lazy"
                    alt=""
                    onError={(e) => {
                      // 预览变体挂了就退回原始发现地址
                      const el = e.currentTarget;
                      if (el.src !== it.originalUrl) el.src = it.originalUrl;
                    }}
                  />
                  <span className="meta">
                    <span className="tag">图片</span>
                    {it.width && it.height
                      ? `${it.width}×${it.height}`
                      : probing.has(it.id)
                        ? '测尺寸中'
                        : it.ext.toUpperCase()}
                    {it.ruleId && <i className="dot" title={`已套用原图规则：${it.ruleId}`} />}
                  </span>
                </button>
              ))}
            </section>
          </>
        ) : (
          !blocked && !scanning && <div className="empty">点「扫描当前页面」，这里会列出页面上的图片</div>
        )}
      </main>

      <div className="dock">
        {items.length > 0 && (
          <footer>
            <label>
              并发
              <input
                type="number"
                min={1}
                max={16}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
              />
            </label>
            <label>
              <input type="checkbox" checked={asZip} onChange={(e) => setAsZip(e.target.checked)} />
              打包成 ZIP
            </label>
            <button className="primary" onClick={download} disabled={!chosen.length}>
              下载 {chosen.length} 张
            </button>
          </footer>
        )}

        {bars.job && progressBar(bars.job, 'job')}
        {bars.oneOff && progressBar(bars.oneOff, 'zip')}

        {/* 只在任务进行中显示。之前「有失败就显示」会把上一个页面的旧任务
            当成当前状态摆出来，看着像凭空冒出两个文件 —— 失败原因改在历史里看 */}
        {jobItems.length > 0 && liveJob && (
          <section className="job-list">
            {jobItems.map((it, i) => (
              <div key={i} className={`job-item ${it.status}`}>
                <span className="j-status">
                  {{ pending: '排队', active: '下载中', paused: '已暂停', done: '✓', failed: '失败', cancelled: '已取消' }[it.status]}
                </span>
                <span className="j-name" title={it.name}>{it.name}</span>
                {it.percent != null && it.status === 'active' && (
                  <span className="h-meta">{it.percent}%</span>
                )}
                {it.error && <span className="j-error" title={it.error}>{it.error}</span>}
              </div>
            ))}
          </section>
        )}

        {history.length > 0 && (
          <section className={`history ${liveJob ? 'compact' : ''}`}>
            <div className="history-head">
              <span>下载记录</span>
              {/* 优先定位到最近任务的文件（直达任务文件夹）；没有可定位的才退回下载根目录 */}
              <button
                className="link"
                onClick={() => reveal(history.find((h) => h.firstDownloadId != null)?.firstDownloadId)}
              >
                打开下载位置
              </button>
              <button
                className="link"
                onClick={async () => {
                  await browser.runtime.sendMessage({ type: 'CLEAR_HISTORY' } satisfies Message).catch(() => {});
                  setHistory([]);
                }}
              >
                清空
              </button>
            </div>
            {flash && (
              <div className={`flash ${flash.warn ? 'warn' : ''}`} role="status" title={flash.text}>
                {flash.text}
              </div>
            )}
            <div className="history-list">
              {history.slice(0, 20).map((h) => (
                <div key={h.id} className="history-row" title={h.pageUrl}>
                  <span className="h-title" title={h.title}>{h.title}</span>
                  <span className="h-meta">
                    {fmtTime(h.time)} · {h.done}/{h.total}
                    {h.failed ? ` · 失败 ${h.failed}` : ''}
                    {h.state === 'running' ? ' · 进行中' : h.state === 'paused' ? ' · 已暂停' : h.state === 'cancelled' ? ' · 已取消' : ''}
                  </span>
                  {h.firstDownloadId != null && (
                    <button className="link h-reveal" onClick={() => reveal(h.firstDownloadId)}>
                      定位文件
                    </button>
                  )}
                  {/* 失败原因单独占一行，完整显示（最多两行，悬停看全文），不再把「定位文件」挤成竖排 */}
                  {h.error && <span className="j-error h-error" title={h.error}>{h.error}</span>}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
