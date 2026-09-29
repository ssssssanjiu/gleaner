/**
 * 站点规则回归测试。
 * 每条 case 的 from 都是 2026-08 在真实站点上抓到的 URL，to 是实测能下载、
 * 且体积不小于缩略图的原图 URL。改 rules.ts 后必须跑一遍：npm test
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { upgradeUrl, refererFor, isSignedUrl } from '../src/core/rules';
import { mediaRefererFor } from '../src/core/rules';

const CASES: Array<{ name: string; from: string; to: string; rule?: string }> = [
  {
    name: '淘宝 缩略图后缀（实测 141KB→516KB）',
    from: 'https://img.alicdn.com/imgextra/i4/O1CN013eTZ741GbcsPGs3Zj_!!6000000000641-2-tps-800-800.png_360x360q90.jpg',
    to: 'https://img.alicdn.com/imgextra/i4/O1CN013eTZ741GbcsPGs3Zj_!!6000000000641-2-tps-800-800.png',
    rule: 'alicdn',
  },
  {
    name: '淘宝 webp 双后缀',
    from: 'https://img.alicdn.com/imgextra/i1/123/abc.jpg_400x400q90.jpg_.webp',
    to: 'https://img.alicdn.com/imgextra/i1/123/abc.jpg',
    rule: 'alicdn',
  },
  {
    name: '微博 orj480→large（实测 25KB→41KB）',
    from: 'https://wx3.sinaimg.cn/orj480/0000000000test0000000000000000.jpg',
    to: 'https://wx3.sinaimg.cn/large/0000000000test0000000000000000.jpg',
    rule: 'weibo',
  },
  {
    name: '微博 签名参数剥除（实测剥掉后仍 200）',
    from: 'https://tvax2.sinaimg.cn/crop.0.0.1080.1080.180/0000000000testavatar000000.jpg?KID=imgbed,tva&Expires=1790000000&ssig=FAKESIG',
    to: 'https://tvax2.sinaimg.cn/crop.0.0.1080.1080.180/0000000000testavatar000000.jpg',
    rule: 'weibo',
  },
  {
    name: '知乎 /50/ 目录 + _720w（实测 58KB→152KB）',
    from: 'https://picx.zhimg.com/50/v2-c477d81e8b8ddfd376f0802323a03bfa_720w.jpg?source=b1f6dc53',
    to: 'https://picx.zhimg.com/v2-c477d81e8b8ddfd376f0802323a03bfa_r.jpg',
    rule: 'zhihu',
  },
  {
    name: '知乎 无 v2- 前缀的老图（实测 _r 可下载）',
    from: 'https://picx.zhimg.com/50/260a51caa7e978390ffa2d7c3a6a98e7_720w.jpg?source=b1f6dc53',
    to: 'https://picx.zhimg.com/260a51caa7e978390ffa2d7c3a6a98e7_r.jpg',
    rule: 'zhihu',
  },
  {
    name: '知乎 /100/ 目录 + _hd',
    from: 'https://pic2.zhimg.com/100/v2-ef323e8437820770cf51aa01788643f1_hd.png',
    to: 'https://pic2.zhimg.com/v2-ef323e8437820770cf51aa01788643f1_r.png',
    rule: 'zhihu',
  },
  {
    name: 'B站 @尺寸后缀（实测原图 770KB 可下载）',
    from: 'https://i0.hdslb.com/bfs/archive/27cc73b1eb44368966ceca7583d41ec04c43375e.png@3840w_360h_1c.avif?mirror_report_banner=1',
    to: 'https://i0.hdslb.com/bfs/archive/27cc73b1eb44368966ceca7583d41ec04c43375e.png',
    rule: 'bilibili',
  },
  {
    name: 'Pinterest 236x→originals（实测 62KB→383KB）',
    from: 'https://i.pinimg.com/236x/f2/26/a8/f226a8bab0f364179cdb82e5fa9bb66f.jpg',
    to: 'https://i.pinimg.com/originals/f2/26/a8/f226a8bab0f364179cdb82e5fa9bb66f.jpg',
    rule: 'pinterest',
  },
  {
    name: '通用 OSS x-oss-process（实测剥掉后 200）',
    from: 'https://image.yunyingpai.com/wp/2020/06/dcAzeM84LYjY8ARE1zd8.jpg?x-oss-process=image/quality,q_80/format,webp',
    to: 'https://image.yunyingpai.com/wp/2020/06/dcAzeM84LYjY8ARE1zd8.jpg',
    rule: 'oss-generic',
  },
  {
    name: '公众号 只留 wx_fmt',
    from: 'https://mmbiz.qpic.cn/mmbiz_jpg/abcDEF123/640?wx_fmt=jpeg&tp=webp&wxfrom=5&wx_lazy=1',
    to: 'https://mmbiz.qpic.cn/mmbiz_jpg/abcDEF123/640?wx_fmt=jpeg',
    rule: 'wechat',
  },
  {
    name: '京东 n5→n0（未实测：海外 IP 拿不到商品页，形态存疑）',
    from: 'https://img14.360buyimg.com/n5/jfs/t1/1234/abc.jpg!q70.dpg',
    to: 'https://img14.360buyimg.com/n0/jfs/t1/1234/abc.jpg',
    rule: 'jd',
  },
  {
    name: '普通图片 URL 不套任何规则',
    from: 'https://image.woshipm.com/wp-files/2024/04/6GgzZKB2vv6oJwWZrfvI.jpg',
    to: 'https://image.woshipm.com/wp-files/2024/04/6GgzZKB2vv6oJwWZrfvI.jpg',
    rule: undefined,
  },
];

for (const c of CASES) {
  test(c.name, () => {
    const r = upgradeUrl(c.from);
    assert.equal(r.url, c.to, `URL 改写不符\n  got:  ${r.url}\n  want: ${c.to}`);
    assert.equal(r.ruleId, c.rule, `命中规则不符: got ${r.ruleId}, want ${c.rule}`);
  });
}

test('七牛斜杠语法（fixture 抓出的 bug 回归）', () => {
  const r = upgradeUrl('https://cdn.example.com/a300.jpg?imageView2/2/w/100');
  assert.equal(r.url, 'https://cdn.example.com/a300.jpg');
  assert.equal(r.ruleId, 'oss-generic');
});

test('watermarked=true 不误伤 watermark 规则', () => {
  const r = upgradeUrl('https://cdn.example.com/a.jpg?watermarked=true');
  assert.equal(r.ruleId, undefined);
});

test('Unsplash imgix 尺寸参数剥除（实测 100×150→1830×2740）', () => {
  const r = upgradeUrl('https://images.unsplash.com/photo-1773332611476-6ec2ba68049f?w=100&auto=format&fit=crop&q=60&ixlib=rb-4.1.0&ixid=M3wxMjA3fDF8MHxmZWF0dXJlZC1waG90b3MtZmVlZHwxfHx8ZW58MHx8fHx8');
  assert.equal(r.ruleId, 'imgix');
  assert.ok(!/[?&](w|h|fit|crop)=/.test(r.url), `尺寸参数未删净: ${r.url}`);
  assert.ok(r.url.includes('ixid='), 'ixid 应保留');
});

test('imgix 变体合并：同图不同 w 升级后 URL 相同', () => {
  const base = 'https://images.unsplash.com/photo-abc123?auto=format&fit=crop&q=60';
  const a = upgradeUrl(base.replace('?', '?w=100&'));
  const b = upgradeUrl(base.replace('?', '?w=1830&'));
  assert.equal(a.url, b.url);
});

test('无尺寸参数的 unsplash URL 不命中 imgix 规则', () => {
  const r = upgradeUrl('https://images.unsplash.com/photo-abc123?q=60&ixid=xyz');
  assert.equal(r.ruleId, undefined);
});

// ---------- image-scan#6：规则只看主机名，不看 query ----------
// 反例：代理 / 跳转地址的参数里带着别家图床的域名。旧实现对整条 URL 跑正则，
// 会把代理当成微博图、剥掉 query（真图地址就在 query 里），下载到的是代理站首页，
// 而且同一代理下的多张不同图被合并成一条。


test('代理地址 query 里的 sinaimg.cn/ 不命中微博规则（weserv）', () => {
  const from = 'https://images.weserv.nl/?url=wx1.sinaimg.cn/mw690/001aaa.jpg';
  const r = upgradeUrl(from);
  assert.equal(r.url, from, `代理地址被改写了: ${r.url}`);
  assert.equal(r.ruleId, undefined);
  assert.equal(refererFor(from), undefined, '代理站不该被伪造微博 Referer');
});

test('百度图片跳转地址不命中微博规则', () => {
  const from = 'https://image.baidu.com/search/down?tn=download&url=https://wx2.sinaimg.cn/mw690/002bbb.jpg';
  assert.deepEqual(upgradeUrl(from), { url: from });
});

test('参数里的 hdslb.com/ 不命中 B站规则', () => {
  const from = 'https://some.site/img.php?src=https://i0.hdslb.com/bfs/archive/abc.jpg@200w.webp&id=9';
  assert.deepEqual(upgradeUrl(from), { url: from });
});

test('同一代理下三张不同的图升级后仍是三个不同地址（不被合并）', () => {
  const urls = ['001aaa', '002bbb', '003ccc'].map(
    (h) => upgradeUrl(`https://images.weserv.nl/?url=wx1.sinaimg.cn/mw690/${h}.jpg`).url,
  );
  assert.equal(new Set(urls).size, 3, urls.join('\n'));
});

test('路径里带别家域名的代理（Jetpack Photon）也不套微博规则', () => {
  const from = 'https://i0.wp.com/wx1.sinaimg.cn/mw690/001aaa.jpg';
  assert.equal(upgradeUrl(from).ruleId, undefined);
});

test('长得像的主机名不算：notalicdn.com / sinaimg.cn.evil.com', () => {
  assert.equal(upgradeUrl('https://notalicdn.com/a.jpg_60x60q90.jpg').ruleId, undefined);
  assert.equal(upgradeUrl('https://sinaimg.cn.evil.com/mw690/a.jpg').ruleId, undefined);
  // 正常子域名照常命中
  assert.equal(upgradeUrl('https://gw.alicdn.com/imgextra/i1/1/a.jpg_60x60q90.jpg').ruleId, 'alicdn');
  assert.equal(refererFor('https://wx1.sinaimg.cn/mw690/a.jpg'), 'https://weibo.com/');
});

test('普通参数 watermark=0 不命中 oss-generic，不同 id 的图不被合并', () => {
  const a = upgradeUrl('https://photo.example.com/show.php?id=12345&watermark=0');
  const b = upgradeUrl('https://photo.example.com/show.php?id=67890&watermark=0');
  assert.equal(a.ruleId, undefined);
  assert.notEqual(a.url, b.url);
});

// ---------- image-scan#7：签名缩略图不能动参数 ----------
// 私有桶的缩略图 URL 带签名，签名覆盖了处理参数（OSS V1 连 x-oss-process 都签进去），
// 删掉任何参数都 403。旧实现 stripQuery 把签名一起剥掉 → 页面能看、下载全 403。

const SIGNED: Array<[string, string]> = [
  [
    '阿里云 OSS V1 签名',
    'https://priv-bkt.oss-cn-hangzhou.aliyuncs.com/u/1/a.jpg?x-oss-process=image%2Fresize%2Cw_300&OSSAccessKeyId=LTAI5tXXXX&Expires=1790000000&Signature=abc%2Bdef%3D',
  ],
  [
    '阿里云 OSS V4 签名',
    'https://priv-bkt.oss-cn-hangzhou.aliyuncs.com/a.jpg?x-oss-process=image/resize,w_300&x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-credential=LTAI%2F20260929%2Fcn-hangzhou%2Foss%2Faliyun_v4_request&x-oss-date=20260929T000000Z&x-oss-expires=3600&x-oss-signature=abcdef',
  ],
  [
    '腾讯云 COS 签名',
    'https://bkt-1250000000.cos.ap-guangzhou.myqcloud.com/a.png?q-sign-algorithm=sha1&q-ak=AKIDxx&q-sign-time=1790000000%3B1790003600&q-key-time=1790000000%3B1790003600&q-header-list=&q-url-param-list=&q-signature=abc&imageMogr2/thumbnail/300x',
  ],
  ['七牛私有空间', 'https://priv.example-qiniu.com/a.jpg?imageView2/2/w/300&e=1790000000&token=AK:sig='],
  ['imgix 安全签名', 'https://demo.imgix.net/a.jpg?w=100&fit=crop&s=0123456789abcdef'],
];

for (const [name, from] of SIGNED) {
  test(`签名地址不升级：${name}`, () => {
    assert.ok(isSignedUrl(from));
    const r = upgradeUrl(from);
    assert.equal(r.url, from, `签名地址被改写，私有桶会 403:\n  got: ${r.url}`);
    assert.equal(r.ruleId, undefined, '没改写就不该显示「已套用原图规则」');
  });
}

test('无签名时只删处理参数，其余参数原样保留（含原始编码）', () => {
  assert.equal(
    upgradeUrl('https://cdn.example.com/a.jpg?x-oss-process=image/resize,w_300&v=2&name=%E5%9B%BE').url,
    'https://cdn.example.com/a.jpg?v=2&name=%E5%9B%BE',
  );
  assert.equal(
    upgradeUrl('https://cdn.example.com/a.png?imageMogr2/thumbnail/300x&v=3').url,
    'https://cdn.example.com/a.png?v=3',
  );
  assert.equal(upgradeUrl('https://cdn.example.com/a.jpg?imageslim').url, 'https://cdn.example.com/a.jpg');
});

test('视频 CDN 的固定 Referer：B站 upos / mcdn / akamaized 节点一律 bilibili.com（嵌在博客里的播放器也一样）', () => {
  for (const u of [
    'https://upos-sz-mirrorcosov.bilivideo.com/upgcxcode/1/2/3-1-30032.m4s?upsig=x',
    'https://upos-hz-mirrorakam.akamaized.net/upgcxcode/1/2/3-1-30032.m4s?upsig=x',
    'https://xy123x45x67x89xy.mcdn.bilivideo.cn:8082/v1/resource/3-1-30280.m4s',
    'https://cn-gdfs-ct-01-01.bilivideo.com/upgcxcode/3-1-30280.m4s',
  ]) assert.equal(mediaRefererFor(u), 'https://www.bilibili.com/', u);
  assert.equal(mediaRefererFor('https://other.akamaized.net/v.mp4'), undefined, '别家的 akamai 不能套');
  assert.equal(mediaRefererFor('https://evil.example/bilivideo.com/x.m4s'), undefined, '只看主机名');
});
