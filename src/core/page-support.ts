export interface PageSupportContext {
  /**
   * 用户是否已在扩展管理里打开「允许访问文件网址」
   * （chrome.extension.isAllowedFileSchemeAccess()）。
   * 打开后 <all_urls> 覆盖 file://，内容脚本和 executeScript 都能用，不该再拦。
   */
  fileAccess?: boolean;
}

/** 本地文件页面没授权时的提示（弹窗据此显示「去设置」的具体步骤） */
export const FILE_ACCESS_REASON = '本地文件页面需要先在扩展管理里打开「允许访问文件网址」';

/**
 * 浏览器禁止扩展向某些页面注入脚本。与其等 executeScript 抛出英文原始报错，
 * 不如在 popup 打开时就判断出来，把按钮禁掉并说清楚原因。
 */
export function unsupportedReason(url: string, ctx: PageSupportContext = {}): string | null {
  if (!url) return null; // 还没拿到 tab url，先不拦

  if (/^https?:\/\//i.test(url)) {
    // 应用商店是唯一被特殊对待的 http(s) 页面
    if (/^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons)/i.test(url)) {
      return '浏览器应用商店页面禁止任何扩展注入脚本';
    }
    return null;
  }

  if (/^about:/i.test(url)) return '这是浏览器空白页，没有内容可扫描';
  if (/^(chrome|edge|brave|opera|vivaldi|arc|browser):/i.test(url)) {
    return '浏览器内部页面禁止扩展注入脚本';
  }
  if (/^chrome-extension:/i.test(url)) return '扩展页面之间不能互相注入脚本';
  if (/^view-source:/i.test(url)) return '源码视图页面无法扫描';
  if (/^file:/i.test(url)) {
    return ctx.fileAccess ? null : FILE_ACCESS_REASON;
  }
  if (/^(devtools|data|blob):/i.test(url)) return '当前页面类型不支持扫描';

  return null;
}

/** 把浏览器抛出的英文报错翻成人话 */
export function humanizeError(raw: string): string {
  if (/Cannot access contents of|Missing host permission|cannot be scripted|Cannot access a chrome/i.test(raw)) {
    return '无法读取当前页面内容。请在普通网页（http / https）上使用——浏览器内部页面、空白页和应用商店禁止扩展注入脚本。';
  }
  if (/Receiving end does not exist|Could not establish connection/i.test(raw)) {
    return '页面脚本没有响应。刷新一下页面再重新扫描。';
  }
  if (/No tab with id|No window with id/i.test(raw)) {
    return '标签页已关闭或切换，重新打开面板再试。';
  }
  return raw;
}
