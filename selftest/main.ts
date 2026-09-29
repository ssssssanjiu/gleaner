import { RULES, upgradeUrl } from '../src/core/rules';
import { LIVE_CASES, type LiveCase } from './cases';

interface LoadResult {
  ok: boolean;
  w: number;
  h: number;
  ms: number;
}

/** 用 <img> 探测 URL 可加载性与尺寸 —— 不受 CORS 限制，任何网络环境可用 */
function probe(url: string, timeoutMs = 15000): Promise<LoadResult> {
  return new Promise((resolve) => {
    const img = new Image();
    const t0 = performance.now();
    const done = (ok: boolean) =>
      resolve({ ok, w: img.naturalWidth, h: img.naturalHeight, ms: Math.round(performance.now() - t0) });
    const timer = setTimeout(() => done(false), timeoutMs);
    img.onload = () => { clearTimeout(timer); done(true); };
    img.onerror = () => { clearTimeout(timer); done(false); };
    img.referrerPolicy = 'no-referrer';
    img.src = url;
  });
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

type Verdict = 'pass' | 'equal' | 'thumb-only' | 'both-fail' | 'no-rule';

function verdictOf(c: { rule: string }, ruleId: string | undefined, thumb: LoadResult, orig: LoadResult): Verdict {
  if (ruleId !== c.rule) return 'no-rule';
  if (!thumb.ok && !orig.ok) return 'both-fail';
  if (!orig.ok) return 'thumb-only';
  if (!thumb.ok) return 'pass'; // 缩略图挂了但原图能下，规则本身是好的
  const gain = orig.w * orig.h - thumb.w * thumb.h;
  return gain > 0 ? 'pass' : 'equal';
}

const VERDICT_TEXT: Record<Verdict, [string, string]> = {
  pass: ['✅ 通过', '原图可下载且分辨率更高'],
  equal: ['🟡 持平', '原图可下载，分辨率与缩略图相同（可能页面上放的已是原图）'],
  'thumb-only': ['❌ 规则失效', '缩略图能下但升级后的 URL 打不开 —— 规则改写出的地址是错的'],
  'both-fail': ['⚠️ 无法访问', '两个 URL 都打不开：先怀疑网络/图被删，不代表规则坏了'],
  'no-rule': ['❌ 未命中规则', 'URL 没有套上预期的规则，match 正则可能失效'],
};

async function runCase(c: LiveCase, tbody: HTMLElement) {
  const { url: origUrl, ruleId } = upgradeUrl(c.thumb);
  const row = el('div', 'row loading');
  row.append(el('div', 'name', c.name + (c.note ? `（${c.note}）` : '')));
  const status = el('div', 'status', '测试中…');
  row.append(status);
  const detail = el('div', 'detail');
  row.append(detail);
  tbody.append(row);

  const [thumb, orig] = await Promise.all([probe(c.thumb), probe(origUrl)]);
  const v = verdictOf(c, ruleId, thumb, orig);
  const [label, explain] = VERDICT_TEXT[v];

  row.className = `row ${v}`;
  status.textContent = label;
  detail.append(
    el('div', 'line', `缩略图：${thumb.ok ? `${thumb.w}×${thumb.h}（${thumb.ms}ms）` : '加载失败'}`),
    el('div', 'line', `原图：　${orig.ok ? `${orig.w}×${orig.h}（${orig.ms}ms）` : '加载失败'}`),
    el('div', 'line url', origUrl),
    el('div', 'line muted', explain),
  );
  return v;
}

async function main() {
  const app = document.getElementById('app')!;
  const summary = el('div', 'summary', `规则表版本：${RULES.length} 条规则 · 用例 ${LIVE_CASES.length} 个`);
  app.append(summary);
  const tbody = el('div', 'tbody');
  app.append(tbody);

  const counts: Partial<Record<Verdict, number>> = {};
  for (const c of LIVE_CASES) {
    const v = await runCase(c, tbody);
    counts[v] = (counts[v] ?? 0) + 1;
  }
  summary.textContent =
    `完成：✅${counts.pass ?? 0} 🟡${counts.equal ?? 0} ` +
    `❌${(counts['thumb-only'] ?? 0) + (counts['no-rule'] ?? 0)} ⚠️${counts['both-fail'] ?? 0}` +
    ` —— 把这一行连同下面的红黄项截图发回来即可`;

  // 自定义 URL 试规则
  const custom = el('div', 'custom');
  const input = document.createElement('input');
  input.placeholder = '粘贴任意图片 URL，回车看规则改写结果并实测加载';
  const out = el('div', 'tbody');
  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const raw = input.value.trim();
    const { url, ruleId } = upgradeUrl(raw);
    await runCase({ name: `自定义（${ruleId ?? '无规则命中'}）`, rule: ruleId ?? '', thumb: raw }, out);
  });
  custom.append(input, out);
  app.append(custom);
}

main();
