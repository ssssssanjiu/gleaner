import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { FILE_ACCESS_REASON, humanizeError, unsupportedReason } from '../src/core/page-support';

test('普通网页不拦', () => {
  assert.equal(unsupportedReason('https://example.com/a.html'), null);
  assert.equal(unsupportedReason('http://127.0.0.1:8080/page'), null);
  assert.equal(unsupportedReason(''), null);
});

test('浏览器内部页、空白页、应用商店照旧拦', () => {
  assert.match(unsupportedReason('chrome://extensions')!, /内部页面/);
  assert.match(unsupportedReason('about:blank')!, /空白页/);
  assert.match(unsupportedReason('https://chromewebstore.google.com/detail/x')!, /应用商店/);
  // 授权本地文件不影响这些页面
  assert.match(unsupportedReason('chrome://settings', { fileAccess: true })!, /内部页面/);
});

test('本地文件：没授权时提示去打开「允许访问文件网址」', () => {
  const url = 'file:///Users/me/Pictures/index.html';
  assert.equal(unsupportedReason(url), FILE_ACCESS_REASON);
  assert.equal(unsupportedReason(url, { fileAccess: false }), FILE_ACCESS_REASON);
  assert.match(FILE_ACCESS_REASON, /允许访问文件网址/);
});

test('本地文件：用户已打开「允许访问文件网址」后放行（popup-ux#14）', () => {
  assert.equal(unsupportedReason('file:///Users/me/Pictures/index.html', { fileAccess: true }), null);
  assert.equal(unsupportedReason('FILE:///C:/photos/a.jpg', { fileAccess: true }), null);
});

test('humanizeError 翻译常见英文报错', () => {
  assert.match(humanizeError('Could not establish connection. Receiving end does not exist.'), /刷新/);
  assert.match(humanizeError('Cannot access contents of url "file:///x"'), /无法读取/);
  assert.equal(humanizeError('其他错误'), '其他错误');
});
