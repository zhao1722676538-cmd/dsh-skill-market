# 建议（目标四）

按「现在就能做 / 值得做 / 别做」分组，都是基于这次逆向和实现过程得出的判断。

## 一、产品建议

1. **把「搜索」和「安装」拆成两个心智**：搜索面板保持只读、可浏览、可复制 `owner/repo`；安装是显式动作，装前弹出目标目录 + 文件数 + 是否含脚本（`hasScripts`/`riskLevel` 来自 skillstore）。技能会进模型上下文，用户需要看到「我同意了什么」。
2. **风险等级要显性展示**：skillstore 的 `riskLevel`、`hasScripts`，以及 GitHub 来源是否含 `.sh`/`postinstall`，都应在列表里以小徽章呈现。这比装完再报错便宜得多。
3. **版本固定 + 可回滚**：按 `commit` 安装（本项目已记录 `commit` 到注册表），列表里显示 commit 短哈希；「更新」= 重新拉取并显示 diff 摘要，而不是静默覆盖。用户手改过的技能目录应当在更新/卸载前提示。
4. **支持 pack 批量安装**：skillstore 有 pack 概念，官方也有 bundle 概念。装一个 pack = 装多个技能 + 一份清单，适合「前端工程师起步包」这种场景。
5. **搜索诊断可见**：每个来源的 `ok/失败原因/耗时` 都要在 UI 上可展开（本项目宿主已返回 `reports`），限流时告诉用户「skillsmp 今天额度用完了，可用 token 提升」，而不是只显示空结果。

## 二、工程建议

6. **不要 monkey-patch 官方 `dsh-plugin-market`**：它已经占了 `plugin_market` 工具与服务名，且随版本升级。新功能应做成独立 bundle 插件（本项目 `dsh-skill-market` 就是这么做的），通过 `dsh.bundle.patch` + `dsh.client` 挂载。
7. **安装只走 GitHub 归档**：四源的最终产物几乎都落在 GitHub 仓库的某个子目录。统一成「解析 repo/ref/path → zipball 展开 → 定位 `SKILL.md` → 原子写入」，比给每个市场写一套安装器简单可靠。遇到多个 `SKILL.md` 必须报歧义让用户选，绝不猜（本项目 `locateSkillDir` 已如此）。
8. **安装目录与注册表分离**：技能文件放 `$DSH_HOME/skills/<name>`，元数据放 `skills/.skill-market/installed.json`。这样用户可手动管理目录，卸载也不会误删非本插件装的技能（本项目已实现：先查注册表再查目录）。
9. **限流与缓存**：skillsmp 匿名 50 天/10 分。客户端搜索加 300ms 防抖 + 每个查询的短 TTL 缓存；把 token 做成配置项。
10. **无构建步骤是刻意选择**：`client/client.js` 手写 `__ModuleLoader__` wrapper（与官方包一致的 CJS 形态），换来「改完即生效、无 pnpm/TS/打包链路」。代价是没有类型检查——用 `node --test` 覆盖纯函数即可，别为了框架再把供应链拉进来。

## 三、别做

11. **别试图改 app.asar 里的官方市场**：签名/完整性与升级都会踩，收益只是省一个 `dsh.profile.bundles` 条目。
12. **别把第三方站点的 HTML 抓成数据源**：四个站都有 JSON 接口（或 `.md` 端点），HTML 一变就全挂。真要兜底，用 GitHub code search。
13. **别让客户端直连第三方 API**：跨域、token 泄漏、CSP 都是坑。统一走本插件宿主路由（同源），客户端只拿整理好的 JSON（本项目所有请求都经 `/dsh-skill-market/*`）。

## 四、下一步优先级

| 优先级 | 事项 |
| --- | --- |
| P0 | 重启验证 GUI 面板真实渲染；确认 `skill_market_*` 四个工具在会话里可见 |
| P1 | 列表徽章（风险/脚本/commit）、安装确认弹窗、搜索诊断展开 |
| P1 | 更新/回滚：按 commit 重装 + diff 摘要 |
| P2 | pack 批量安装、workspace 级技能（`.dsh/skills`）、本地目录导入 |
| P2 | 单元测试补齐到覆盖四个适配器的响应解析（用录制的 JSON 样本，不打网络） |
