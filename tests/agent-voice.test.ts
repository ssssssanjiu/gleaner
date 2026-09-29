import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createRecognizer, humanizeSpeechError } from '../src/core/agent/voice';

/** 假的 SpeechRecognition：记录配置，允许测试手动触发事件 */
class FakeRecognition {
  static last: FakeRecognition | null = null;
  lang = '';
  continuous = true;
  interimResults = false;
  onresult: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  constructor() {
    FakeRecognition.last = this;
  }
  start() { this.started++; }
  stop() { this.stopped++; this.onend?.(); }
  abort() {}
}

const win = { webkitSpeechRecognition: FakeRecognition, navigator: { language: 'zh-CN' } };

test('不支持的环境直接报错，不抛异常', () => {
  const r = createRecognizer({});
  assert.equal(r.supported, false);
  let err = '';
  r.listen({ onFinal: () => {}, onError: (m) => { err = m; } });
  assert.match(err, /不支持/);
});

test('中间结果实时回传，最终结果在 end 时一次给出', () => {
  const r = createRecognizer(win);
  assert.equal(r.supported, true);
  const interims: string[] = [];
  let final = '';
  const stop = r.listen({ onInterim: (t) => interims.push(t), onFinal: (t) => { final = t; }, onError: () => {} });
  const rec = FakeRecognition.last!;
  assert.equal(rec.lang, 'zh-CN');
  assert.equal(rec.started, 1);
  assert.equal(rec.interimResults, true);
  rec.onresult!({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: '所有绿' } }] });
  rec.onresult!({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: '所有绿色的图片' } }] });
  assert.deepEqual(interims, ['所有绿', '所有绿色的图片']);
  assert.equal(final, '');
  stop();
  assert.equal(rec.stopped, 1);
  assert.equal(final, '所有绿色的图片');
});

test('错误码翻成人话；aborted 不报', () => {
  const r = createRecognizer(win);
  const errs: string[] = [];
  r.listen({ onFinal: () => {}, onError: (m) => errs.push(m) });
  const rec = FakeRecognition.last!;
  rec.onerror!({ error: 'not-allowed' });
  rec.onerror!({ error: 'aborted' });
  rec.onerror!({ error: 'network' });
  assert.deepEqual(errs, ['麦克风权限未授予', '语音识别连不上服务器（Chrome 的语音识别走 Google，大陆网络下通常需要代理）']);
  assert.equal(humanizeSpeechError('no-speech'), '没听到声音，再试一次');
});
