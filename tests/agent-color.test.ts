import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { analyzePixels, classifyRgb, matchesColor } from '../src/core/agent/color';

test('单像素分类覆盖 12 种颜色', () => {
  assert.equal(classifyRgb(0, 200, 0), 'green');
  assert.equal(classifyRgb(34, 139, 34), 'green'); // forestgreen
  assert.equal(classifyRgb(255, 0, 0), 'red');
  assert.equal(classifyRgb(255, 255, 255), 'white');
  assert.equal(classifyRgb(0, 0, 0), 'black');
  assert.equal(classifyRgb(128, 128, 128), 'gray');
  assert.equal(classifyRgb(0, 0, 255), 'blue');
  assert.equal(classifyRgb(70, 130, 180), 'blue'); // steelblue
  assert.equal(classifyRgb(255, 165, 0), 'orange');
  assert.equal(classifyRgb(255, 255, 0), 'yellow');
  assert.equal(classifyRgb(128, 0, 128), 'purple');
  assert.equal(classifyRgb(255, 192, 203), 'pink');
  assert.equal(classifyRgb(139, 69, 19), 'brown'); // saddlebrown
  assert.equal(classifyRgb(0, 255, 255), 'cyan');
});

function pixels(spec: Array<[number, number, number, number, number]>): Uint8ClampedArray {
  // [r,g,b,a,count]
  const total = spec.reduce((n, s) => n + s[4], 0);
  const out = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [r, g, b, a, n] of spec) {
    for (let k = 0; k < n; k++) {
      out[i++] = r;
      out[i++] = g;
      out[i++] = b;
      out[i++] = a;
    }
  }
  return out;
}

test('60% 绿 + 40% 白 → 主色绿，算绿不算白', () => {
  const p = analyzePixels(pixels([[0, 180, 0, 255, 60], [255, 255, 255, 255, 40]]));
  assert.equal(p.dominant, 'green');
  assert.equal(p.chromaticTop, 'green');
  assert.ok(matchesColor(p, 'green'));
  assert.ok(!matchesColor(p, 'white'), '白底不到一半不算白');
  assert.ok(!matchesColor(p, 'red'));
});

test('白底 + 15% 绿 logo → 既算白也算绿（它是唯一的彩色）', () => {
  const p = analyzePixels(pixels([[255, 255, 255, 255, 85], [0, 160, 0, 255, 15]]));
  assert.equal(p.dominant, 'white');
  assert.equal(p.chromaticTop, 'green');
  assert.ok(matchesColor(p, 'green'));
  assert.ok(matchesColor(p, 'white'));
});

test('白底 + 5% 绿 → 太少，不算绿', () => {
  const p = analyzePixels(pixels([[255, 255, 255, 255, 95], [0, 160, 0, 255, 5]]));
  assert.ok(!matchesColor(p, 'green'));
});

test('红多绿少的图：绿不是彩色主色，也没到 25% → 不算绿', () => {
  const p = analyzePixels(pixels([[220, 20, 20, 255, 70], [0, 160, 0, 255, 20], [255, 255, 255, 255, 10]]));
  assert.ok(matchesColor(p, 'red'));
  assert.ok(!matchesColor(p, 'green'));
});

test('透明像素不计入；全透明图什么都不算', () => {
  const p = analyzePixels(pixels([[0, 180, 0, 0, 90], [200, 0, 0, 255, 10]]));
  assert.equal(p.opaquePixels, 10);
  assert.ok(matchesColor(p, 'red'));
  assert.ok(!matchesColor(p, 'green'));
  const empty = analyzePixels(pixels([[0, 180, 0, 0, 10]]));
  assert.ok(!matchesColor(empty, 'green'));
});
