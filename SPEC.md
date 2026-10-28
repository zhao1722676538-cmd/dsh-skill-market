# dsh-skill-market — 实现契约 (SPEC)

DSH 插件：在 4 个 skill 目录站上搜索 skill，并让用户自行安装/卸载。
目标环境：本机 DSH `0.2.1-rc.3`，profile `desktop`，Node 24.22，**纯 ESM JavaScript，零运行时依赖**（只用 Node 内置 + host 提供的 `@deepseek-ai/*`），**没有构建步骤**。

## 0. 硬约束（违反即返工）

1. `src/sources/**` 和 `src/install/**` **不许** import 任何 `@deepseek-ai/*`；只用 `node:` 内置。原因：这两层要能脱离 DSH 独立跑 `node test/*.mjs`。
2. 只有 `src/index.js` / `src/tools.js` / `src/routes.js` 可以 import host 包。
3. 网络请求全部走 `fetch()`，必须支持 `AbortSignal`，超时默认 15s，**禁止无限等待**。
4. 不用任何第三方 npm 依赖；不跑 pnpm；不碰 profile 的 `package.json`。
5. 所有写盘操作限定在 `config.installRoot` 之内，路径必须 `path.resolve()` 后校验前缀，拒绝 `..`。
6. 代码注释/文案：注释中文或英文皆可，UI 文案中英双语由 locale 提供；**日志不打印密钥**。

## 1. 目录

```
D:\dsh\addskills\
  SPEC.md  README.md  package.json  icon.svg
  cordis.patch.yml            # 待安装步骤使用（见 §7）
  locale/zh-CN.json  locale/en.json
  src/
    index.js                  # host 插件入口（Lead）
    types.js                  # 纯 JSDoc typedef（无运行时代码）
    config.js                 # Config schema（Lead）
    sources/
      index.js                # 注册表 + 并发 fan-out + 去重/排序（Lead 写壳，适配器作者填）
      skillsmp.js  skillstore.js  skillssh.js  github.js
    install/
      github.js               # repo → tarball → 文件树
      tar.js                  # 最小 tar.gz 读取器（zlib + tar header 解析）
      installer.js            # 安装/卸载/清单
    registry.js               # 已安装清单（installed.json）读写
    tools.js                  # 4 个 agent 工具（Lead）
    routes.js                 # host HTTP 路由（Lead）
    client.js                 # 客户端 UI bundle（唯一产出物，手写 __ModuleLoader__ 格式）
  scripts/
    probe-sources.mjs         # 4 源真机连通性/字段探针
    probe-install.mjs         # 端到端安装探针
  test/
    sources.test.mjs  install.test.mjs  (node:test)
```

## 2. 数据模型（`src/types.js`，JSDoc）

```js
/** @typedef {'skillsmp'|'skillstore'|'skillssh'|'github'} SourceId */

/**
 * @typedef {Object} SkillEntry
 * @property {SourceId} source
 * @property {string} id           // 全局稳定 id：`${source}:${key}`；key 由适配器定义且可回传 install
 * @property {string} name         // 展示名，小写连字符优先
 * @property {string} [title]      // 人类可读标题
 * @property {string} description
 * @property {string} [author]
 * @property {string} [repo]       // 'owner/name'
 * @property {string} [ref]        // commit/branch/tag
 * @property {string} [path]       // repo 内含 SKILL.md 的目录（相对，'' = 根）
 * @property {string} [url]        // 人类可读详情页
 * @property {number} [installs]
 * @property {number} [stars]
 * @property {string} [risk]       // skillstore riskLevel
 * @property {string[]} [tags]
 */

/**
 * @typedef {Object} SearchQuery
 * @property {string} query
 * @property {SourceId[]} [sources]   // 缺省 = 全部启用源
 * @property {number} [limit]         // 每源条数上限，默认 10
 * @property {number} [page]          // 1-based，默认 1
 * @property {AbortSignal} [signal]
 * @property {(ev:{source:SourceId,ms:number,count:number,error?:string}) => void} [onSource]
 */

/**
 * @typedef {Object} SearchOutcome
 * @property {SkillEntry[]} items
 * @property {{source:SourceId, ok:boolean, count?:number, error?:string, ms:number}[]} reports
 */

/**
 * @typedef {Object} SourceDeps
 * @property {(input:string|URL, init?:RequestInit & {timeoutMs?:number}) => Promise<Response>} http
 * @property {{skillsmp?:string, github?:string}} tokens   // 可选 token
 * @property {(msg:string)=>void} log
 */
```

每个源模块导出：

```js
export const id = 'skillsmp'
export const label = 'SkillsMP'
export const home = 'https://skillsmp.com'
export const capabilities = { search: true, browse: false, detail: true } // browse=无 query 时能否列热门
/** @returns {Promise<SkillEntry[]>} */
export async function search(q /* SearchQuery */, deps /* SourceDeps */) {}
/** 可选：把 entry 补全为安装坐标（repo/ref/path）。缺省认为 search 已给全。 */
export async function resolve(entry, deps) { return entry }
```

**约定**：`search` 必须自己处理分页与 limit 截断；出错必须抛出带可读信息的 `Error`，由注册表捕获为 `reports[].error`。`search` 不得返回 `id` 缺失的条目；`name` 缺失时用 `path` 末段或 `id` 尾段兜底。

## 3. 四个源的真实契约（已实测，2026-10-28）

### 3.1 skillsmp (`src/sources/skillsmp.js`)
- 搜索：`GET https://skillsmp.com/api/v1/skills/search?q=<query>&limit=<n>&offset=<n>`
  匿名限流 **50/天、10/分**；可用 `Authorization: Bearer <token>` 提额 → `config.skillsmpApiKey`。
- 详情：`GET https://skillsmp.com/api/v1/skills/{id}`（可选）。
- 需要先跑一次探针确认响应字段名（`data` / `skills` / `results`，以及 github 链接字段），把真实结构和映射写进适配器注释。
- `id` = 站点 skill id。

### 3.2 skillstore (`src/sources/skillstore.js`)
- 搜索：`GET https://skillstore.io/api/skills?q=<query>` → `{ data: [ { slug, emoji, displayName, description, category, riskLevel, hasScripts, ... } ] }`。
- 详情/manifest：`GET https://skillstore.io/api/skills/{slug}/manifest`（含不可变 GitHub commit artifact，字段待探针确认）→ 用来填 `repo/ref/path`。
- Markdown 上下文：`GET https://skillstore.io/skills/{slug}.md`。
- `https://skillstore.io/llms.txt` 是权威路由清单；**不要**假设未列出的路由。
- `id` = slug；`risk` = riskLevel。

### 3.3 skills.sh (`src/sources/skillssh.js`)
- 搜索：`GET https://skills.sh/api/search?q=<query>` →
  `{ query, searchType, searchVersion, skills: [ { id, source, skillId, name, installs } ] }`，
  `id` 形如 `anthropics/skills/pdf`，`source` = `owner/repo`，`skillId` = 技能目录名。
  `q` 至少 2 字符（否则 400），适配器需在本地先校验并给出友好错误。
- 安装坐标：`repo = source`；`path` 未知 → `path: undefined`，交给安装器在仓库树里按 `skillId` 定位 `SKILL.md`（**这是安装器的能力**，见 §5 `locateSkillDir`）。
- 详情页：`https://skills.sh/{source}/{skillId}`。
- 无 token 需求；限流未知，默认 1 req/s 内。

### 3.4 github (`src/sources/github.js`)
- 只用 `api.github.com`，匿名 60/h；`config.githubToken` 可选（有则 `Authorization: Bearer`，elevate 5000/h）。
- 两条查询合并去重：
  1. `GET /search/repositories?q=<query>+topic:agent-skills&per_page=<n>`（再补 `topic:claude-skills`、`topic:skills`，最多 3 次）
  2. `GET /search/code?q=<query>+filename:SKILL.md&per_page=<n>`（需要 token；无 token 时跳过并记 note）
- repo 命中 → 用 `default_branch` 作为 `ref`，`path` 待安装器定位。
- 排序：stars 降序；`installs` 留空。
- 限流/未授权必须返回明确 error（含 `X-RateLimit-Remaining` 信息），不得静默空数组。

## 4. 注册表与排序（`src/sources/index.js`）

```js
export const SOURCES = { skillsmp, skillstore, skillssh, github }
export async function searchAll(q /* SearchQuery */, deps): Promise<SearchOutcome>
export function rank(items /* SkillEntry[] */): SkillEntry[]
```
- 并发：`Promise.allSettled`，单源失败不影响其它源；总超时由 caller 控制。
- 去重键：`repo + '|' + (path||slugify(name))`，保留 installs/stars 更大的那条，`sources` 合并记录到 `tags` 可选。
- 排序：`installs`（log 归一化）+ `stars` + 名字/描述命中 query 的加权；同分按 name 字典序稳定。
- 结果上限：`limit` 作用于每源，合并后再截 `limit*2` 总量。

## 5. 安装器（`src/install/`）

### 5.1 `src/install/tar.js`
`export async function readTarGz(buf /* Buffer */): Promise<{path:string, mode:number, type:'file'|'dir'|'other', data?:Buffer}[]>`
- `zlib.gunzipSync` 后按 512 字节头遍历；支持 `ustar`、GNU longname(`L`)、pax(`x`) 头；跳过 `symlink`/`hardlink`/设备（记为 `other` 且不落地）。
- 只读，不写盘。

### 5.2 `src/install/github.js`
```js
export async function fetchRepoArchive({repo, ref}, deps) // → { files, commit, repo, ref }
export async function resolveDefaultBranch({repo}, deps)  // → 'main'|...（api.github.com，失败时回退 codeload HEAD）
export function locateSkillDir(files, { hintPath, name }) // → { dir, skillFile } | null
export async function fetchSingleFile({repo, ref, path}, deps) // → string（raw.githubusercontent，兜底 api contents）
```
- `fetchRepoArchive`：`GET https://codeload.github.com/{repo}/tar.gz/{ref||'HEAD'}`，跟随重定向，压缩包顶层目录形如 `{repo}-{sha}/`，**统一剥掉第一段**得到仓库相对路径。
- `commit`：从顶层目录名里的 sha 提取；若为 `main` 之类分支则调用 `api.github.com/repos/{repo}/commits/{ref}` 取 sha（失败不致命，记为 `ref`）。
- 缓存：同一 `repo@ref` 10 分钟内不重复下载（进程内 Map）。
- `locateSkillDir`：按优先级找 `<hintPath>/SKILL.md` → 任意 `**/SKILL.md` 且其目录末段 ≈ `name`/hint → 唯一 `SKILL.md` 时用它 → 多个时返回 `{ambiguous:[...]}` 让调用方报错（不要瞎猜）。

### 5.3 `src/install/installer.js`
```js
export async function installSkill(entry /* SkillEntry */, opts /* {installRoot, deps, overwrite?, dryRun?} */)
// → { ok:true, name, dir, files:number, repo, commit, ref, path, warnings:string[] }
export async function uninstallSkill(name, opts /* {installRoot} */) // → { ok:true, removed:string[] }
export async function listInstalled(opts /* {installRoot} */)        // → InstalledSkill[]
export function validateSkillName(name) // → 规范化后的 name 或抛错
```
- `installRoot` 默认 `$DSH_HOME/skills`（`process.env.DSH_HOME || ~/.dsh`）→ `<installRoot>/<name>/`。
- 落盘前：`readTarGz` → 过滤出 skill 目录子树（含子目录）→ 校验存在 `SKILL.md` → 解析 frontmatter 取 `name`/`description`（`name` 必须匹配 `^[a-z0-9][a-z0-9._-]{0,63}$`，非法 fallback 到目录名 slug）。
- **原子性**：先写到 `<installRoot>/.staging/<rand>/`，成功后 `fs.rename` 到目标；目标已存在且非本清单管理 → 除非 `overwrite` 否则抛 `EEXIST_MANAGED_ELSEWHERE`。已是本清单管理的旧版本 → 备份到 `.dsh-skill-market/backup/<name>-<ts>/` 再替换。
- 写清单 `~/.dsh/skill-market/registry.json`：`{ version:1, skills: { [name]: { source, id, repo, ref, commit, path, installedAt, files: [{path, sha256, size}] } } }`，写盘用 tmp+rename。
- 卸载：只删清单里登记且文件哈希与清单一致的条目；不一致 → 返回 `{ok:false, reason:'modified', conflicts:[...]}` 并给 `force` 覆盖项。名字非法或不在清单 → 明确错误。

### 5.4 `src/registry.js`
清单读写 + 路径解析工具（`resolveInstallRoot`, `registryPath`）。所有函数接受显式 `installRoot`，禁止读全局单例。

## 6. host 层（Lead 负责）

### 6.1 `src/index.js`
```js
export const name = 'skill-market'
export const inject = ['tools']           // routes 额外 await ctx.get('webServer')
export const Config = Schema.object({ ... })
export function apply(ctx, config) {}
```
Config 字段（全部 `Schema.*().default()`）：
`enabled(bool,true)` `installRoot(string,'')` `sources(array,['skillsmp','skillstore','skillssh','github'])`
`perSourceLimit(number,10)` `timeoutMs(number,15000)` `skillsmpApiKey(string,'')` `githubToken(string,'')`
`allowOverwrite(bool,false)` `mountRoutes(bool,true)` `routePrefix(string,'/dsh-skill-market')`

### 6.2 `src/tools.js`（4 个工具，名称固定）
| 工具 | 参数 | 行为 |
|---|---|---|
| `skill_market_search` | `query`(必填), `sources?`(string[]), `limit?` | 调 `searchAll`，返回 `{summary, items:[{source,name,description,repo,installable,installs,stars,risk}]}`；`summary` 用人话说明各源命中/失败 |
| `skill_market_install` | `name`(必填,目标名) + `source`/`id` 或 `repo`+`path?`+`ref?` | 调 `installSkill`；成功后 `ctx.skills?.refresh?.()` 尽力触发重扫，返回路径与下一步提示 |
| `skill_market_uninstall` | `name`(必填), `force?` | 调 `uninstallSkill` |
| `skill_market_list` | `installed?`(bool,默认 true) | 已安装清单 + 是否仍在磁盘 + 是否有可用更新（不实现远端版本对比则留 null） |
- 工具描述必须写清"安装会把第三方 SKILL.md 写进本机 skills 目录，执行前应把要装的东西展示给用户确认"。
- 输出走 `output.schema` + `render`（文本表格），保持简短。

### 6.3 `src/routes.js`
- `POST <prefix>/search`  `{query, sources?, limit?}` → `{items, reports}`
- `GET  <prefix>/installed` → `{items}`
- `POST <prefix>/install` `{name, source, id?, repo?, path?, ref?}` → `{ok, result}`
- `POST <prefix>/uninstall` `{name, force?}` → `{ok, result}`
- `GET  <prefix>/sources` → `{sources:[{id,label,home,enabled,note}]}`
- 安全门：只接受 `POST` 的 `content-type: application/json`；`Origin` 存在时必须与请求 Host 同源；否则 403。响应 `cache-control: no-store`。
- 路由注册方式：`const webServer = ctx.get('webServer')`；若 `webServer.route/mount/addRoute/register` 任一可用则用（用 `typeof === 'function'` 探测，全部失败则 `ctx.logger.warn` 并跳过，不可抛错导致插件起不来）。**精确 API 以 recon 结果为准**（见 `.work/recon/INSTALL-PROCEDURE.md`、`dshmarket/src/routes.ts` 的 `register()` 包装）。
- 任何 route 内部异常必须 `500 + {error}`，不得让 HTTP 连接悬挂。

## 7. 客户端 UI（`src/client.js`，交付到 `client/client.js`）

- 文件格式（照抄 dshmarket，**不是**普通 ESM）：
```js
window.__ModuleLoader__.load({ id: 'dsh-skill-market', factory: (require) => {
  const React = require('react')
  const h = React.createElement
  const name = 'dsh-skill-market'
  const inject = [/* 见 recon */]
  function apply(ctx) { /* ctx.slots.inject(...) */ }
  return { name, inject, apply }
}})
```
- 注册进 `settings.plugins.tab`：`{ name:'settings.plugins.tab', id:'dsh-skill-market', order:70, label:()=> 'Skills' }`，body 是一个面板组件。
- 面板功能（最小可用）：搜索输入框 + 源筛选 chips + 结果行（名称/描述/来源徽标/安装按钮）+ "已安装" 列表（卸载按钮）+ 加载/错误/空态。
- 样式：只用 `--dsw-alias-*` CSS 变量（例如 `var(--dsw-alias-bg-elevated)`、`var(--dsw-alias-border-subtle)`、`var(--dsw-alias-text-primary)`, `var(--dsw-alias-brand-primary)`）；不用 CSS 文件；不用 iframe；不 require 额外 Harness Client 包（除 `react`）。
- 数据来源：`fetch(new URL('dsh-skill-market/search', document.baseURI).pathname, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(...)})`。
- 组件必须能容忍接口 404/500（显示错误条，绝不白屏），且 `apply` 里对 `ctx.slots` 缺失做降级（`if (!ctx.slots) return`）。

## 8. 验证清单（每个人自测）

- [ ] `node test/*.mjs` 全绿（node:test）。
- [ ] `node scripts/probe-sources.mjs "pdf"` 对 4 个源都打印真实命中（或明确失败原因）。
- [ ] `node scripts/probe-install.mjs anthropics/skills pdf` 能真装到临时 installRoot 并列出。
- [ ] 无 `console.log` 噪音（用注入的 `log`）。
- [ ] 没有把 token 写进日志/清单。
