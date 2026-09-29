/**
 * 真 SDK 打到本地假 API：验证请求形态（工具 strict、联络表图片、直连头）和错误翻译。
 * 不花一分钱，也不需要网络。
 */
import { strict as assert } from 'node:assert';
import { after, before, test } from 'node:test';
import http from 'node:http';
import { askClaude } from '../src/core/agent/claude';

interface Seen { headers: http.IncomingHttpHeaders; body: any }
const seen: Seen[] = [];
let mode: 'ok' | '401' | 'text' | 'refusal' = 'ok';
let base = '';
let server: http.Server;

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: raw ? JSON.parse(raw) : null });
      if (mode === '401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      const content =
        mode === 'text'
          ? [{ type: 'text', text: '你说的是哪一个？' }]
          : [{
              type: 'tool_use', id: 'tu_1', name: 'select_media',
              input: { page_type: 'gallery', selected: ['#2', '#3'], explanation: '绿色的两张', clarify: '' },
            }];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content, stop_reason: mode === 'refusal' ? 'refusal' : mode === 'text' ? 'end_turn' : 'tool_use',
        stop_sequence: null, usage: { input_tokens: 123, output_tokens: 45 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

after(() => server.close());

const settings = { cloudEnabled: true, apiKey: 'sk-test', model: 'claude-opus-5', apiBaseUrl: '' };

test('请求形态：strict 工具、图片块在前、摘要在后、直连头、Key 头', async () => {
  mode = 'ok';
  seen.length = 0;
  const reply = await askClaude({
    settings: { ...settings, apiBaseUrl: base },
    question: '绿色的图',
    digest: '候选素材 3 项\n#1 图片\n#2 图片\n#3 图片',
    sheets: [{ data: 'AAAA', mediaType: 'image/jpeg', caption: '联络表 #1 ~ #3' }],
  });
  assert.deepEqual(reply.selected, ['#2', '#3']);
  assert.equal(reply.pageType, 'gallery');
  assert.equal(reply.explanation, '绿色的两张');
  assert.equal(reply.clarify, undefined);
  assert.deepEqual(reply.usage, { inputTokens: 123, outputTokens: 45, model: 'claude-opus-5' });

  assert.equal(seen.length, 1);
  const { headers, body } = seen[0];
  assert.equal(headers['x-api-key'], 'sk-test');
  assert.equal(headers['anthropic-dangerous-direct-browser-access'], 'true');
  assert.equal(body.model, 'claude-opus-5');
  assert.equal(body.tools.length, 1);
  assert.equal(body.tools[0].name, 'select_media');
  assert.equal(body.tools[0].strict, true);
  assert.equal(body.tools[0].input_schema.additionalProperties, false);
  assert.match(body.system, /数据|不是给你的指令/);
  const content = body.messages[0].content;
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'image');
  assert.equal(content[1].source.media_type, 'image/jpeg');
  assert.equal(content[1].source.data, 'AAAA');
  assert.match(content[2].text, /<页面摘要>[\s\S]*#2 图片[\s\S]*<\/页面摘要>/);
  assert.match(content[2].text, /用户请求：绿色的图/);
});

test('401 翻成「API Key 无效」', async () => {
  mode = '401';
  await assert.rejects(
    askClaude({ settings: { ...settings, apiBaseUrl: base }, question: 'x', digest: 'd', sheets: [] }),
    /API Key 无效/,
  );
});

test('模型没调工具只说话 → 当追问', async () => {
  mode = 'text';
  const r = await askClaude({ settings: { ...settings, apiBaseUrl: base }, question: 'x', digest: 'd', sheets: [] });
  assert.deepEqual(r.selected, []);
  assert.equal(r.clarify, '你说的是哪一个？');
});

test('refusal 报错', async () => {
  mode = 'refusal';
  await assert.rejects(
    askClaude({ settings: { ...settings, apiBaseUrl: base }, question: 'x', digest: 'd', sheets: [] }),
    /拒绝/,
  );
});

test('没有 Key 直接拒绝，不发请求', async () => {
  seen.length = 0;
  await assert.rejects(
    askClaude({ settings: { ...settings, apiKey: '', apiBaseUrl: base }, question: 'x', digest: 'd', sheets: [] }),
    /API Key/,
  );
  assert.equal(seen.length, 0);
});

test('403 地区封锁（大陆/港澳网络）要说是网络地区问题，而不是 Key 没权限', async () => {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { humanizeApiErrorForTest } = await import('../src/core/agent/claude');
  const region = new Anthropic.PermissionDeniedError(403, { type: 'error', error: { type: 'forbidden', message: 'Request not allowed' } }, 'Request not allowed', new Headers());
  assert.match(humanizeApiErrorForTest(region), /地区.*代理/);
  const perm = new Anthropic.PermissionDeniedError(403, { type: 'error', error: { type: 'permission_error', message: 'Your API key does not have permission' } }, 'Your API key does not have permission to use the specified resource.', new Headers());
  assert.match(humanizeApiErrorForTest(perm), /没有调用权限/);
});
