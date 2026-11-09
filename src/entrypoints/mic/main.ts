import { getLang, initLang, t } from '@/core/i18n';
/**
 * 麦克风授权页。扩展弹窗里的 SpeechRecognition 拿不到权限提示框，
 * 用一个普通扩展页调一次 getUserMedia，授权给扩展来源后弹窗就能直接用了。
 */
const statusEl = document.getElementById('status')!;
const retryBtn = document.getElementById('retry') as HTMLButtonElement;

async function request() {
  statusEl.className = '';
  statusEl.textContent = t('正在请求麦克风权限…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // 只要权限，不录音
    statusEl.className = 'ok';
    statusEl.textContent = t('已授权。回到拾穗面板点麦克风按钮就能说话了，这个页面可以关掉。');
    retryBtn.hidden = true;
  } catch (e: any) {
    statusEl.className = 'err';
    const name = String(e?.name ?? '');
    statusEl.textContent =
      name === 'NotAllowedError'
        ? t('权限被拒绝。点地址栏左侧的图标允许麦克风后，再点「重新请求」。')
        : name === 'NotFoundError'
          ? t('没有找到麦克风设备。')
          : t('请求失败：{0}', String(e?.message ?? e));
  }
}

retryBtn.addEventListener('click', request);

// index.html 里的静态文案是默认语言（英文），读到语言后换成对应译文
initLang().finally(() => {
  document.documentElement.lang = getLang();
  document.title = t('拾穗 Gleaner · 麦克风授权');
  const set = (id: string, text: string) => (document.getElementById(id)!.textContent = text);
  set('title', t('授权麦克风'));
  set('p1', t('拾穗的语音输入需要麦克风权限。弹窗里没法弹出授权框，所以借这个页面请求一次；授权一次即可。'));
  set('p2', t('语音转文字由 Chrome 内置的语音识别完成（音频经 Google 语音服务），不经过拾穗的任何服务器。'));
  retryBtn.textContent = t('重新请求');
  request();
});
