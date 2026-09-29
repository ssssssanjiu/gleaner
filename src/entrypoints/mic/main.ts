/**
 * 麦克风授权页。扩展弹窗里的 SpeechRecognition 拿不到权限提示框，
 * 用一个普通扩展页调一次 getUserMedia，授权给扩展来源后弹窗就能直接用了。
 */
const statusEl = document.getElementById('status')!;
const retryBtn = document.getElementById('retry') as HTMLButtonElement;

async function request() {
  statusEl.className = '';
  statusEl.textContent = '正在请求麦克风权限…';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop()); // 只要权限，不录音
    statusEl.className = 'ok';
    statusEl.textContent = '已授权。回到拾穗面板点麦克风按钮就能说话了，这个页面可以关掉。';
    retryBtn.hidden = true;
  } catch (e: any) {
    statusEl.className = 'err';
    const name = String(e?.name ?? '');
    statusEl.textContent =
      name === 'NotAllowedError'
        ? '权限被拒绝。点地址栏左侧的图标允许麦克风后，再点「重新请求」。'
        : name === 'NotFoundError'
          ? '没有找到麦克风设备。'
          : `请求失败：${String(e?.message ?? e)}`;
  }
}

retryBtn.addEventListener('click', request);
request();
