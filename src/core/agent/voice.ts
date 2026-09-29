/**
 * 语音输入：Chrome 自带的 Web Speech API（用户拍板的方案）。
 * 免费、零后端；代价是音频经 Google 的语音服务转文字，不是纯本地 —— 设置页里明说。
 * 构造函数可注入，方便单测和以后换本地 whisper。
 */

export interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export interface ListenOptions {
  lang?: string;
  onInterim?: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd?: () => void;
}

export function humanizeSpeechError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return '麦克风权限未授予';
    case 'no-speech':
      return '没听到声音，再试一次';
    case 'audio-capture':
      return '没有找到可用的麦克风';
    case 'network':
      // Chrome 的语音识别走 Google 服务器：大陆网络下几乎必然是这个错误，只说「需要联网」会让人以为自己断网了
      return '语音识别连不上服务器（Chrome 的语音识别走 Google，大陆网络下通常需要代理）';
    case 'aborted':
      return '已取消';
    case 'language-not-supported':
      return '当前语言不支持';
    default:
      return `语音识别出错（${code}）`;
  }
}

export function createRecognizer(win: any = globalThis) {
  const Ctor = win?.SpeechRecognition ?? win?.webkitSpeechRecognition;
  return {
    supported: typeof Ctor === 'function',
    /** 开始听；返回停止函数 */
    listen(opts: ListenOptions): () => void {
      if (typeof Ctor !== 'function') {
        opts.onError('当前浏览器不支持语音识别');
        return () => {};
      }
      const rec: RecognitionLike = new Ctor();
      rec.lang = opts.lang ?? (win?.navigator?.language || 'zh-CN');
      rec.continuous = false;
      rec.interimResults = true;
      let finalText = '';
      rec.onresult = (e: any) => {
        let interim = '';
        for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
          const r = e.results[i];
          const t = r[0]?.transcript ?? '';
          if (r.isFinal) finalText += t;
          else interim += t;
        }
        if (interim) opts.onInterim?.(finalText + interim);
        else if (finalText) opts.onInterim?.(finalText);
      };
      rec.onerror = (e: any) => {
        if (e?.error === 'aborted') return;
        opts.onError(humanizeSpeechError(String(e?.error ?? 'unknown')));
      };
      rec.onend = () => {
        if (finalText.trim()) opts.onFinal(finalText.trim());
        opts.onEnd?.();
      };
      try {
        rec.start();
      } catch (e: any) {
        opts.onError(String(e?.message ?? e));
      }
      return () => {
        try {
          rec.stop();
        } catch {
          /* 已停止 */
        }
      };
    },
  };
}
