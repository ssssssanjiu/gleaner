# 贡献指南

最有价值的贡献是**加一条站点规则**。会写正则就能提。

## 加一条站点规则

编辑 [`src/core/rules.ts`](src/core/rules.ts)，往 `RULES` 数组里加一项：

```ts
{
  id: 'douban',                       // 唯一标识，小写
  name: '豆瓣',                        // 面板上展示的名字
  host: /(^|\.)doubanio\.com$/i,      // 匹配图片 URL 的「主机名」，锚定到结尾（不看路径和参数，
                                      // 否则代理地址 ?url=xxx.doubanio.com/ 这种也会被误套）
  when: (url) => url.pathname.includes('_ratio_poster'), // 可选：主机名命中后再按路径 / 参数细判
  upgrade: (u) => u.replace(/\/(s|m)_ratio_poster\//, '/l_ratio_poster/'),
  referer: 'https://www.douban.com/', // 可选，仅防盗链站点需要
}
```

另外几个可选字段：

- `sameSize: true`：改写只去掉压缩 / 转格式参数、**不改分辨率**（比如公众号去 `tp=webp`）。这样页面上量到的尺寸仍然作数，小装饰图照样按最小边长过滤。
- `thumbnailsAreContent: true`：这个站页面上的小缩略图本身就是内容（淘宝 / 京东的商品图库缩略图条），升级后是大图，**不能按缩略图尺寸过滤**。别的站别开：B站 评论区头像 `@48w` 也能升级，开了会把几十个头像全列出来。

**带签名的地址不要改写**：私有桶 / 防盗链 CDN 的地址靠 `Signature`、`Expires`、`q-sign-*`、`token` 这类参数放行，而且签名往往把整条 query 算在内，改动任何参数都会 403。通用规则遇到 `isSignedUrl()` 为真的地址一律原样下载；站点专属规则只有在逐条实测过「剥掉仍能下」时才可以例外。

### 怎么找出原图规则

1. 在目标站右键图片 → 复制图片地址，得到缩略图 URL
2. 点开大图，再复制一次，得到原图 URL
3. 对比两者差异，通常是以下几种形态之一：
   - **路径段**：`/thumb150/` → `/large/`（微博）
   - **文件名后缀**：`xxx.jpg_400x400q90.jpg` → `xxx.jpg`（淘宝）
   - **查询参数**：`?imageView2/2/w/540` 直接删掉（七牛 / OSS）
   - **尺寸目录**：`/236x/` → `/originals/`（Pinterest）
4. 把原图 URL 单独粘到地址栏验证能打开，再写规则

### 自测

```bash
npm run dev
```

打开目标站点 → 点扩展图标 → 扫描 → 面板上带绿点的图说明命中了规则，把鼠标停在绿点上能看到规则 id。

### PR 要求

- 一个 PR 一个站点，标题写 `rules: 新增 <站点名>`
- 在描述里贴一组「缩略图 URL → 原图 URL」的实例，方便复核
- `upgrade` 必须是纯函数，不要在里面发请求

## 其他方向

- **扫描器**：发现新的懒加载属性名，加到 `scanner.ts` 的 `LAZY_ATTRS`
- **Bug**：附上站点 URL 和浏览器版本
- **视频能力**：见 Roadmap v0.3 / v0.4，动手前先开 Issue 对齐设计。**任何涉及 DRM 解密的 PR 一律不合并。**

## 代码规范

```bash
npm run compile   # tsc --noEmit，PR 前必须通过
```
