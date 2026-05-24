# 🎧 蜻蜓FM → Apple播客 RSS 生成器

通过 GitHub Action 全量抓取蜻蜓FM频道节目，生成 Apple Podcasts 兼容的 RSS 订阅源。

## 架构

```
Telegram Bot / GitHub手动触发
  → GitHub Action（重体力爬虫，无时间限制）
  → 全量抓取节目列表 + 音频URL
  → 生成 RSS.xml
  → 部署到 GitHub Pages
  → Apple播客通过 Pages 链接订阅
```

## 使用方法

### 方式一：GitHub 手动触发
1. 进入 Actions → 🎧 蜻蜓播客爬虫 → Run workflow
2. 输入蜻蜓频道ID（如 `427910`）
3. 等待运行完成
4. 播客链接: `https://general74110.github.io/qtfm-podcast/{频道ID}.xml`

### 方式二：搜索频道
查看已抓取频道列表: [https://general74110.github.io/qtfm-podcast/](https://general74110.github.io/qtfm-podcast/)

## 技术细节

- **爬虫**: `scripts/scrape.js` — Node.js脚本，运行在GitHub Action中
- **音频代理**: Cloudflare Worker `qtfm-podcast` 实时代理音频签名
- **RSS托管**: GitHub Pages
- **触发器**: `workflow_dispatch` | `repository_dispatch`
