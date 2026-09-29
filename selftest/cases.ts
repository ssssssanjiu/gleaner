/**
 * 自测页用例：与 tests/rules.test.ts 同源，但这里只放「线上真实存在的图」，
 * 因为自测页会真的去加载它们。构造出来的假 URL（京东、公众号）放不进来。
 */
export interface LiveCase {
  name: string;
  rule: string;
  /** 页面上抓到的缩略图 URL */
  thumb: string;
  /** 站点冷门程度备注，图 404 时先怀疑图被删了而不是规则坏了 */
  note?: string;
}

export const LIVE_CASES: LiveCase[] = [
  {
    name: '淘宝首页商品图',
    rule: 'alicdn',
    thumb:
      'https://img.alicdn.com/imgextra/i4/O1CN013eTZ741GbcsPGs3Zj_!!6000000000641-2-tps-800-800.png_360x360q90.jpg',
  },
  {
    name: '微博 feed 配图',
    rule: 'weibo',
    thumb: 'https://wx3.sinaimg.cn/orj480/008b0m7nly1ifs9dqy6yxj30k00wgjs8.jpg',
    note: '用户可能删博，404 时换一张再测',
  },
  {
    name: '知乎发现页配图',
    rule: 'zhihu',
    thumb: 'https://picx.zhimg.com/50/v2-c477d81e8b8ddfd376f0802323a03bfa_720w.jpg?source=b1f6dc53',
  },
  {
    name: '知乎无 v2 前缀老图',
    rule: 'zhihu',
    thumb: 'https://picx.zhimg.com/50/260a51caa7e978390ffa2d7c3a6a98e7_720w.jpg?source=b1f6dc53',
  },
  {
    name: 'B站视频封面',
    rule: 'bilibili',
    thumb:
      'https://i0.hdslb.com/bfs/archive/27cc73b1eb44368966ceca7583d41ec04c43375e.png@672w_378h_1c.avif',
  },
  {
    name: 'Pinterest 图钉',
    rule: 'pinterest',
    thumb: 'https://i.pinimg.com/236x/f2/26/a8/f226a8bab0f364179cdb82e5fa9bb66f.jpg',
  },
  {
    name: '又拍云 OSS 处理参数',
    rule: 'oss-generic',
    thumb:
      'https://image.yunyingpai.com/wp/2020/06/dcAzeM84LYjY8ARE1zd8.jpg?x-oss-process=image/quality,q_80/format,webp',
  },
  {
    name: 'Unsplash 首页缩略图',
    rule: 'imgix',
    thumb:
      'https://images.unsplash.com/photo-1773332611476-6ec2ba68049f?w=100&auto=format&fit=crop&q=60&ixlib=rb-4.1.0&ixid=M3wxMjA3fDF8MHxmZWF0dXJlZC1waG90b3MtZmVlZHwxfHx8ZW58MHx8fHx8',
  },
];
