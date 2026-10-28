# dsh-skill-market

这不是插件市场，这是skills市场。
DeepSeek Harness 的**技能市场**插件：在一个面板里跨四个站点搜索 skill，点一下安装到本机 DSH 技能目录，随时卸载。

- 宿主侧（Node）：注册 4 个模型工具 + 5 个 HTTP 路由 + 一个 `skillMarket` service。
- 客户端侧（浏览器）：在「插件」页签里加一个 **Skill Market** 面板（搜索 / 来源筛选 / 安装 / 卸载 / 已安装列表）。
- 无构建步骤：`client/client.js` 手写的 CJS bundle，`src/**` 直接是 ESM 源码。

## 四个来源

| 来源 id | 站点 | 接口 | 说明 |
| --- | --- | --- | --- |
| `skillsmp` | skillsmp.com | `GET /api/v1/skills/search` | Anthropic 生态聚合索引；匿名限流 50/天，可配 token |
| `skillstore` | skillstore.io | `GET /api/skills?q=` + `/api/skills/{slug}/manifest` | 带风险等级/签名清单，manifest 指向不可变 GitHub commit |
| `skillssh` | skills.sh | `GET /api/search?q=` | 按安装量排序的 registry，条目形如 `anthropics/skills/pdf` |
| `github` | api.github.com | search repo/code + zipball 安装 | 兜底来源：任意仓库里的 `*/SKILL.md` 都能装 |

结果会按 `repo + skill 名` 去重合并（`tags` 记录见过的来源），再按安装量/star 与查询相关性排序。

## 索引驱动搜索（推荐）

默认是「实时打四个站」：慢、要 GitHub token、还会被匿名限额卡。可以改成插件市场的形态——**一份静态索引 + 本地过滤**：

```bash
# 1. 抓一份索引（可重复，用你关心的主题）
node scripts/build-index.mjs -q pdf -q excel -q pptx -q react -q "code review" -q testing -q image -q docs
# → C:\Users\<you>\.dsh\cache\skill-market\skill-index.json（156 条，约 90KB，12 秒）

# 2. 在 profile 的 cordis.patch.yml 里指过去
#    - id: skill-market
#      name: 'dsh-skill-market'
#      config:
#        indexes: ['C:\\Users\\<you>\\.dsh\\cache\\skill-market\\skill-index.json']
```

之后每次搜索都是**毫秒级的本地过滤**（实测 3–6ms），不联网、不消耗 GitHub 额度、不需要 token：

- 索引未命中时按 `indexFallbackLive` 回落实时搜索（默认开），不会「搜不到就没了」。
- `indexes` 支持多个位置：`http(s)://` 索引 URL（可自托管，带 ETag/Last-Modified 与 TTL 缓存）、`file://` 或本地路径。
- 索引过期？重跑生成器即可；`indexTtlMs`（默认 6h）只控制远端索引的重新校验频率。
- 模型侧也能触发：`skill_market_build_index`（参数 `queries / sources / limit / outPath`）。

## 模型工具

| 工具 | 作用 |
| --- | --- |
| `skill_market_search` | 跨源搜索，返回 `id / name / repo / path / installs / stars / risk`，以及 `mode`（`index` / `index+live` / `live`） |
| `skill_market_build_index` | 把四源搜索结果抓成一份静态索引 JSON（索引用它生成；写文件后把路径配进 `indexes`） |
| `skill_market_install` | 接受搜索结果的 `id`，或 `owner/repo`、`owner/repo/path`、GitHub URL；解析出技能目录后写入 `$DSH_HOME/skills/<name>` |
| `skill_market_uninstall` | 按名字卸载（先查注册表，再查目录） |
| `skill_market_list` | 已安装技能 + 来源 + 支持的来源清单 |

安装后自动刷新 `ctx.skills`，**无需重启**即可被 skill 工具看到。会校验技能名（禁止 `..`、路径分隔符），已存在的目录不会被静默覆盖。

## 安装本插件

```bash
node scripts/install-into-profile.mjs --dry-run   # 先看计划
node scripts/install-into-profile.mjs             # 复制进 profile 并写入 dsh.profile.bundles
```

然后**重启 DSH（或刷新 GUI 后重启宿主进程）**，在「插件」里应出现 Skill Market 面板。卸载插件：

```bash
node scripts/install-into-profile.mjs --uninstall
```

## 让别人一键装（发布到 DSH 插件市场）

插件市场不存代码，只读一份 **format 1 的索引 JSON**，里面的每条记录带「安装坐标」。本仓库能直接产出这份索引：

```bash
# 在你的 git checkout 里跑，自动读 package.json 和 HEAD commit
node scripts/build-index.mjs --plugin-index --repo https://github.com/<you>/dsh-skill-market
# → ./plugin-index.json
```

会自动带上：包名、版本、描述、`engines.dsh`、40 位 commit、commit 时间、仓库地址、keywords。
然后把它托管成 **https URL**（Gist raw / GitHub Pages / 任意静态站都行），别人在设置里加一行：

```yaml
- id: plugin-market
  name: '@deepseek-ai/dsh-plugin-market'
  config:
    indexes: ['https://your.host/plugin-index.json']
```

打开「插件 → Discover」就能看到并一键安装——**不需要 clone、不需要手改 profile**。

要点：

- git 源**必须钉死 40 位 commit**，所以每次发版都要重新生成索引并更新托管文件（`--commit` 可手工指定）。
- monorepo 用 `--path packages/xxx`；已经发到 npm 的话加 `--npm`，索引就写 `name@version` 而不是 git 坐标。
- 产物用的是官方 `@deepseek-ai/dsh-plugin-market-index` 校验器同一个格式；本仓库的单测只做等价的结构校验。

## 配置（插件设置里）

| key | 默认 | 说明 |
| --- | --- | --- |
| `installRoot` | `$DSH_HOME/skills` | 安装目标目录 |
| `allowOverwrite` | `false` | 允许覆盖同名已装技能 |
| `sources` | 全部 | 启用哪些来源 |
| `indexes` | `[]` | 索引位置列表（本地路径 / `file://` / `http(s)` 索引 URL）；非空即进入索引驱动模式 |
| `indexTtlMs` | `21600000`（6h） | 远端索引的 TTL；过期才重新校验（带 ETag，304 不重下） |
| `indexFallbackLive` | `true` | 索引未命中时是否回落实时搜索 |
| `indexCacheDir` | `$DSH_HOME/cache/skill-market` | 远端索引与生成索引的默认缓存目录 |
| `skillsmpApiKey` | — | skillsmp 的 Bearer token（提高限额） |
| `githubToken` | — | GitHub token：匿名搜索只有 10 次/分钟，填 token 后 5000 次/小时，并解锁 `filename:SKILL.md` 代码搜索 |

## 开发

```bash
node --test test/unit.test.mjs          # 纯函数 + 注册表往返 + GitHub 适配器 + 索引存储 + 插件索引回归（27 个用例）
node --check src/index.js && node --check client/client.js
```

## 已知限制

- 安装走 GitHub 归档下载（`codeload`），需要能访问 github.com；大仓库首次下载可能十几秒到半分钟。
- `github` 源匿名只有 **10 次搜索/分钟**：一次搜索只发一个请求，并在进程内缓存 5 分钟；触发限流时面板/工具会给出「等约 1 分钟或填 githubToken」的提示，而不是空结果。
- GitHub 仓库里有多个 `SKILL.md` 时安装会报歧义并列出候选目录，重跑时用 `path=` 指定（面板里就是条目自带的 path）。
- `skillsmp` 匿名额度较小。
- 索引是**快照**：生成后新上架的 skill 不在里面（未命中会回落实时搜索）；想保持新鲜就定期重跑生成器，或把索引托管成 URL 让宿主按 TTL 自动校验。
- 客户端面板只调用本插件的同源路由，不直接访问第三方站点。
- 只做「技能」；插件市场（`dsh-plugin-market`）保持独立。
