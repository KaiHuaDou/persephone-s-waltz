# 魔法少女小圆 珀耳塞福涅的华尔兹

## 项目简介

> 原文：<https://archiveofourown.org/works/577310>（ErinPtah，20 章，约 7 万词，2013-02-08 完结）

本仓库把 to-the-stars 的存档流水线迁移到《Persephone's Waltz》：原文存档、译文阅读版、VitePress 站点与 epub 打包四层结构保持一致，便于在 AO3 不可访问时继续阅读与分发。

目前中文翻译尚未开始，`books/` 只建立了两卷骨架；英文原文由 `scripts/update-source.ts` 同步到 `original/`，可在站点 `/original/` 阅读。

## 作品简介

在一次次拯救鹿目圆失败之后，晓美焰愈发绝望……直到把圆绑架、锁进地下室，等沃尔普吉斯之夜过去——这个点子听起来都不算疯狂了。

目录

- 卷 01 - In（第 1–12 章）
- 卷 02 - Out（第 13–20 章）

## 维护

初始化

1. 安装 Node.js 22 <https://nodejs.org/>
2. `pnpm i` 安装依赖
3. `pnpm update:source` 同步原文到 `original/`
4. `pnpm build-all` 构建站点与 epub
5. `pnpm deploy` 发布站点

原文同步默认访问 AO3；AO3 不可用（维护、成人内容拦截、网络错误）时自动回退到固定 Wayback Machine 快照（2021-09-25），保证结果可复现。常用参数：

- `pnpm update:source -- --wayback`：强制使用固定的 Wayback 快照
- `pnpm update:source -- --wayback 20210925115244`：指定快照时间戳
- `pnpm update:source -- --from-file <work.html>`：离线解析本地保存的作品页
- `pnpm update:source -- --dump-html <work.html>`：只抓取并保存 HTML，不写 `original/`
- `pnpm update:source -- --force`：忽略增量检查，强制重写

直连不通时可带上代理，如 `HTTPS_PROXY=http://127.0.0.1:7890 pnpm update:source`。

## 待配置

迁移模板中的以下位置仍是占位值，部署前请替换：

- `.vitepress/config.ts` 的 `hostname`、GitHub 仓库链接
- `.vitepress/theme/index.ts` 的 giscus `repoId` / `categoryId`（留空则不渲染评论区）
- `static/CNAME`（如需自定义域名）
