/**
 * agent 主流程：外部能力全部用假的，验证「本地能做的绝不上云、上云时送的是什么」。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { runAgent, type AgentDeps } from '../src/core/agent/run';
import type { AgentSettings, Candidate, PageInfo } from '../src/core/agent/types';
import type { CloudReply, CloudRequest } from '../src/core/agent/claude';

const page: PageInfo = { url: 'https://site.x/post/1', title: '测试页', headings: ['标题'] };

function px(r: number, g: number, b: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(16 * 4);
  for (let i = 0; i < 16; i++) out.set([r, g, b, 255], i * 4);
  return out;
}

const cands: Candidate[] = [
  { id: 'g1', kind: 'image', url: 'https://c/g1.jpg', thumb: 't-green', width: 1200, height: 800, section: '正文', index: 0 },
  { id: 'r1', kind: 'image', url: 'https://c/r1.jpg', thumb: 't-red', width: 600, height: 900, section: '正文 › 评论区', index: 1 },
  { id: 'g2', kind: 'image', url: 'https://c/g2.jpg', thumb: 't-green', width: 300, height: 300, section: '侧边栏', index: 2 },
  { id: 'x1', kind: 'image', url: 'https://c/x1.jpg', thumb: 't-broken', width: 900, height: 900, index: 3 },
  { id: 'v1', kind: 'video', url: 'https://c/v1.mp4', width: 1920, height: 1080, section: '播放器', index: 0, hasAudio: true },
  { id: 'v2', kind: 'video', url: 'https://c/v2.mp4', width: 640, height: 360, section: '正文 › 评论区', index: 1 },
];

function deps(overrides: Partial<AgentDeps> = {}) {
  const asks: CloudRequest[] = [];
  const sheets: Array<{ ids: string[]; labels: string[] }> = [];
  const d: AgentDeps & { asks: CloudRequest[]; sheets: typeof sheets } = {
    asks,
    sheets,
    async pixels(url) {
      if (url === 't-green') return px(0, 170, 0);
      if (url === 't-red') return px(220, 20, 20);
      return null;
    },
    async sheet(cs, labels) {
      sheets.push({ ids: cs.map((c) => c.id), labels });
      return { data: 'AAAA', mediaType: 'image/jpeg' };
    },
    async ask(req) {
      asks.push(req);
      const reply: CloudReply = {
        pageType: 'gallery',
        selected: ['#2'],
        explanation: '第 2 项符合',
        usage: { inputTokens: 10, outputTokens: 5, model: 'claude-opus-5' },
      };
      return reply;
    },
    ...overrides,
  };
  return d;
}

const off: AgentSettings = { cloudEnabled: false, apiKey: '', model: 'claude-opus-5' };
const on: AgentSettings = { cloudEnabled: true, apiKey: 'k', model: 'claude-opus-5' };

test('绿色的图片：本地按像素筛，坏图不命中，不上云', async () => {
  const d = deps();
  const r = await runAgent({ text: '我需要页面内所有绿色的图片', page, candidates: cands }, off, d);
  assert.equal(r.via, 'local');
  assert.deepEqual(r.matchedIds.sort(), ['g1', 'g2']);
  assert.equal(d.asks.length, 0);
  assert.match(r.explanation, /绿色/);
});

test('评论区的视频：按面包屑筛', async () => {
  const d = deps();
  const r = await runAgent({ text: '我要页面内评论区的视频', page, candidates: cands }, off, d);
  assert.deepEqual(r.matchedIds, ['v2']);
  assert.equal(d.asks.length, 0);
});

test('第二张图 / 最大的两个视频 / 横图', async () => {
  const d = deps();
  assert.deepEqual((await runAgent({ text: '第二张图', page, candidates: cands }, off, d)).matchedIds, ['r1']);
  assert.deepEqual((await runAgent({ text: '最大的两个视频', page, candidates: cands }, off, d)).matchedIds, ['v1', 'v2']);
  assert.deepEqual((await runAgent({ text: '所有横图', page, candidates: cands }, off, d)).matchedIds, ['g1']);
  assert.equal(d.asks.length, 0);
});

test('无条件请求列出全部', async () => {
  const r = await runAgent({ text: '把所有素材都下载下来', page, candidates: cands }, off, deps());
  assert.equal(r.matchedIds.length, cands.length);
});

test('语义请求 + 云端未开：不命中、明确说需要开启、绝不联网', async () => {
  const d = deps();
  const r = await runAgent({ text: '把有猫的图片下载下来', page, candidates: cands }, off, d);
  assert.equal(r.needsCloud, true);
  assert.deepEqual(r.matchedIds, []);
  assert.match(r.explanation, /猫/);
  assert.match(r.explanation, /开启云端/);
  assert.equal(d.asks.length, 0);
});

test('语义请求 + 云端已开：送摘要 + 联络表，编号映射回 id，页面类型采纳模型判断', async () => {
  const d = deps();
  const r = await runAgent({ text: '把有猫的图片下载下来', page, candidates: cands }, on, d);
  assert.equal(r.via, 'cloud');
  assert.equal(d.asks.length, 1);
  const req = d.asks[0];
  assert.equal(req.question, '把有猫的图片下载下来');
  // 「图片」是本地条件 → 池子只有图片，视频不进摘要
  assert.match(req.digest, /#1 图片/);
  assert.ok(!/视频/.test(req.digest.split('候选素材')[1]), '视频不该出现在候选里');
  assert.equal(d.sheets.length, 1);
  assert.deepEqual(d.sheets[0].ids, ['g1', 'r1', 'g2', 'x1']);
  assert.deepEqual(d.sheets[0].labels, ['#1', '#2', '#3', '#4']);
  assert.equal(req.sheets.length, 1);
  assert.match(req.sheets[0].caption, /#1 ~ #4/);
  assert.deepEqual(r.matchedIds, ['r1']);
  assert.equal(r.page.type, 'gallery');
  assert.equal(r.explanation, '第 2 项符合');
  assert.equal(r.usage?.inputTokens, 10);
});

test('分区没命中 + 云端已开：退回同类全量让模型按内容找', async () => {
  const d = deps();
  const r = await runAgent({ text: '页脚的视频', page, candidates: cands }, on, d);
  assert.equal(d.asks.length, 1);
  assert.match(d.asks[0].digest, /#1 视频/);
  assert.match(d.asks[0].digest, /#2 视频/);
  assert.equal(d.sheets.length, 0, '视频没缩略图，不拼联络表');
  assert.equal(r.via, 'cloud');
});

test('分区没命中 + 云端未开：说清楚原因', async () => {
  const r = await runAgent({ text: '页脚的视频', page, candidates: cands }, off, deps());
  assert.equal(r.needsCloud, true);
  assert.match(r.explanation, /页脚/);
});

test('模型追问原样带回', async () => {
  const d = deps({
    async ask() {
      return { selected: [], explanation: '', clarify: '有两个视频，要哪个？', usage: { inputTokens: 1, outputTokens: 1, model: 'm' } };
    },
  });
  const r = await runAgent({ text: '那个有意思的视频', page, candidates: cands }, on, d);
  assert.equal(r.clarify, '有两个视频，要哪个？');
  assert.deepEqual(r.matchedIds, []);
});

test('联络表失败时仍然上云（只靠文字）', async () => {
  const d = deps({ async sheet() { return null; } });
  const r = await runAgent({ text: '有猫的图', page, candidates: cands }, on, d);
  assert.equal(d.asks[0].sheets.length, 0);
  assert.equal(r.via, 'cloud');
});

test('没有候选时直说', async () => {
  const r = await runAgent({ text: '绿色的图', page, candidates: [] }, off, deps());
  assert.deepEqual(r.matchedIds, []);
  assert.match(r.explanation, /没扫到/);
});
