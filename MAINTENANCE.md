# 维护与工作流

这份文档回答两件事：**平时怎么用**，以及**代码或索引更新后怎么做一次发布**。

---

## 0. 一页纸总览

| 东西 | 位置 | 作用 |
|---|---|---|
| 插件源码 | `D:\dsh\addskills` | host 半部（`src/`）+ 面板（`client/`） |
| 已安装的副本 | `C:\Users\17226\.dsh\profiles\desktop\node_modules\dsh-skill-market` | DSH 实际加载的那份，改完源码要重装才生效 |
| 技能安装目录 | `C:\Users\17226\.dsh\skills\<name>` | 搜到的 skill 装到这里，**立即生效、无需重启** |
| 技能索引（快照） | 仓库 `skill-index.json` → `raw.githubusercontent.com/.../main/skill-index.json` | 搜索时本地过滤，毫秒级、不耗额度 |
| 插件索引 | 仓库 `plugin-index.json` | 让别人在官方 Plugins→Discover 里装你这个插件 |
| 发布脚本 | `scripts/publish-api.mjs` | 走 REST API 推代码（本机 git 协议不通，且没装 Git） |
| 一键维护 | `scripts/maintain.mjs` | 测试 → 重建技能索引 → 发布 → 重钉插件索引 → 再发布 → 验证 |

---

## 1. 日常使用（不用碰代码）

三种入口，效果一样：

- **面板**：DSH → `Plugins` → `技能市场` 标签页 → 搜索 → Install / Uninstall
- **对话**：直接说「帮我搜个 pdf 的 skill」，模型会调 `skill_market_search` / `skill_market_install` / `skill_market_list` / `skill_market_uninstall`
- **查看已装**：`skill_market_list`（含「非本插件安装」的手工目录）

安装到 `~/.dsh/skills/<name>`，**当场生效**（skills catalog 会热刷新）；卸载是删目录 + 删注册表条目，被改过的文件会拒绝删除，加 `force` 才强删。

---

## 2. 改了代码之后：发布流程

### 2.1 一次性的 token 设置（每次开新终端都要设）

```powershell
$env:GITHUB_TOKEN = "ghp_xxxxxxxx"      # classic token，勾 repo，7 天够用
```

> token 只在当前终端窗口有效；关掉窗口就没了，这是故意的（不落盘）。
> **不要把 token 写进文件、提交进仓库、或贴到对话里。**
>
> 只勾 `repo` 就够日常维护：脚本默认**不发布** `.github/workflows/**`（见 §2.3）。
> 只有你想让脚本亲手改 workflow 文件时，才需要额外勾 `workflow`。

### 2.2 一条命令跑完

```powershell
cd D:\dsh\addskills
node scripts/maintain.mjs
```

它依次做：

1. 跑测试 —— `test/unit.test.mjs`（32 条）+ `test/install.test.mjs`（17 条），必须全绿
2. 重建 `skill-index.json`（默认 20 个主题词，每个源 10 条）
3. 发布代码 + 技能索引到 GitHub（生成 1 个 commit）
4. 用这个 commit 重新生成 `plugin-index.json`（把安装源钉到已存在的提交）
5. 再发布一次，让仓库里的插件索引指向正确提交
6. 匿名拉取 `package.json` / `README.md` 验证可公开访问

常用开关：

```powershell
node scripts/maintain.mjs --no-test          # 跳过测试
node scripts/maintain.mjs --no-publish       # 只在本地产出 skill-index.json，不需要 token
node scripts/maintain.mjs --queries "pdf,excel" --limit 5   # 只更新这两个主题
```

### 2.3 只想发一次代码、不重建索引

```powershell
$env:GITHUB_TOKEN = "ghp_xxxxxxxx"
node scripts/publish-api.mjs --message "fix: 描述你改了什么"
```

它会打印 `repo:` 和 `commit:` 两行，记下 commit 号。

> 脚本在**远端当前树**（`base_tree`）上增量构建，且 `force: false`：不会再像旧版那样拿本地整树覆盖远端——那会把 `.github/workflows/*`、`package-lock.json`、`test/dsh.test.js` 一并删掉。
> `.github/workflows/**` 默认不进载荷；确实要发布时加 `--with-workflows`，并且 token 必须有 `workflow` scope——脚本会先读 `x-oauth-scopes` 预检，缺 scope 立刻报错，不会提交到一半才 403。

### 2.4 改完代码要让 DSH 用上新版本

```powershell
node scripts/install-into-profile.mjs      # 拷进 profile 并登记 bundle
```

然后**重启 DSH**（面板和工具才换成新代码）。

### 2.5 CI 与每周重建索引（GitHub Actions）

仓库里有两份 workflow，**只能在网页上添加/修改**——`publish-api.mjs` 默认不把它们放进提交（见 §2.3）：

| 文件 | 触发 | 做什么 |
|---|---|---|
| `.github/workflows/ci.yml` | push / PR / 手动 | Node 20 + 22 双版本：`npm run check`（零依赖语法检查）→ `npm test` → 校验 `package.json` / `plugin-index.json` / `skill-index.json` 能解析 |
| `.github/workflows/index-rebuild.yml` | 每周一 03:17 UTC、可手动 | `node scripts/rebuild-index.mjs` 复用现有索引里的主题词重建 `skill-index.json`；**只有内容变了才开 PR**，不直接推 main |

网页添加步骤：仓库页 → `Add file` → `Create new file` → 文件名填完整路径（如 `.github/workflows/ci.yml`）→ 粘贴内容 → `Commit changes`。

- 第一次 CI 跑完，Actions 页会出现绿勾。
- `index-rebuild` 第一次多半报「index unchanged」然后正常结束——市场数据没变，不需要 PR。

> 反过来，如果你就是想让脚本发 workflow 文件：token 勾上 `workflow` scope，然后 `node scripts/publish-api.mjs --with-workflows`。

---

## 3. 索引维护

**索引是快照**：生成那一刻的搜索结果被固化进 JSON。之后新上架的 skill 不在里面，但**没命中会自动回落实时搜索**，所以不是硬伤，只是慢一点、吃额度。

| 场景 | 动作 |
|---|---|
| 平时 | 不用管，索引半年不过期也照样能搜（未命中走实时） |
| 想保持新鲜 | 每周跑一次 `node scripts/maintain.mjs` |
| 只加几个主题 | `--queries "新主题1,新主题2"` |
| 想在本地大改索引 | `node scripts/build-index.mjs -q ... -o skill-index.json`，满意再发布 |

改完索引后，**已运行的 DSH 需要重启**（或等 `indexTtlMs` = 6 小时过期）才会重新拉取远端版本。

---

## 4. 每周自动刷新（可选，本机 schtasks 版）

> 如果 §2.5 的 `index-rebuild.yml` 已经在跑，这一节可以跳过。下面这套适合「现在就想在本机立刻发布一次」。

Windows 任务计划程序，用户级、不需要管理员。**第一次运行时手动设一次环境变量并验证能发布**，再挂定时任务：

```powershell
$tok = read-host "粘贴 token"
setx GITHUB_TOKEN $tok                       # 存进用户环境变量（明文，见安全提示）
schtasks /create /tn "dsh-skill-market-refresh" /sc weekly /d MON /st 09:00 `
  /tr "cmd /c cd /d D:\dsh\addskills && node scripts\maintain.mjs > .work\refresh.log 2>&1" /f
```

查看 / 删除：

```powershell
schtasks /query /tn "dsh-skill-market-refresh" /v /fo LIST
schtasks /delete /tn "dsh-skill-market-refresh" /f
```

> `setx` 会把 token 明文存进注册表（`HKCU\Environment`）。更稳妥的做法是手动跑，或用一个只在发布时读取的本地文件（不要提交）。

---

## 5. 别人怎么用你的市场

### 装插件（官方 Plugins 页面）

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: plugin-market
  name: "@deepseek-ai/dsh-plugin-market"
  config:
    indexes:
      - "https://raw.githubusercontent.com/zhao1722676538-cmd/dsh-skill-market/main/plugin-index.json"
```

重启后在 Discover 里搜 `dsh-skill-market` 就能装（走 git 源，安装时需要能访问 github.com）。

### 直接用技能索引（不装插件也能拿数据）

```bash
curl -s https://raw.githubusercontent.com/zhao1722676538-cmd/dsh-skill-market/main/skill-index.json | head -c 300
```

---

## 6. 排障

| 现象 | 原因 | 修法 |
|---|---|---|
| `401 Bad credentials` | token 过期 / 已撤销 / 复制带了空格 | 重新生成 token（勾 `repo`），重新 `$env:GITHUB_TOKEN=...` |
| `403 rate limit` | 匿名搜 GitHub 额度用尽（10 次/分钟） | 等 1 分钟；或配 `githubToken`；或全靠索引（索引搜索不消耗额度） |
| `404` 拉索引 | 文件名/分支写错，或仓库是 Private | 确认 `main` 分支和 `raw.githubusercontent.com/<owner>/<repo>/main/<file>` |
| 面板没出现「技能市场」 | 插件没装进 profile / DSH 没重启 | `node scripts/install-into-profile.mjs` 后重启 |
| 索引改了但搜不到 | DSH 还在用旧缓存（TTL 6h） | 重启 DSH，或临时把 `indexTtlMs` 调小 |
| 安装报「多个 SKILL.md」 | 仓库里有多个技能目录 | 面板条目自带 path，重跑时带上 `path=` |
| 本机 `git push` 失败 | github.com 的 git 传输被阻断 + 没装 Git | 用 `scripts/publish-api.mjs`，别用 git |
| 加/改 workflow 报 403 `without workflow scope` | classic token 只勾了 `repo` | 在网页上加这个文件；或换带 `workflow` scope 的 token 再 `--with-workflows` |
| 发布后远端少了 `.github/`、`package-lock.json` | 旧版脚本整树覆盖 + `force: true` | 已修（`base_tree` + `force: false`）；换成最新的 `scripts/publish-api.mjs` |
| `npm test` 报 `spawn EPERM` | 在受限沙箱里跑，`node --test` 需要起子进程 | 换普通终端跑；或直接 `node test/unit.test.mjs && node test/install.test.mjs` |

---

## 7. 安全与备份

- **token**：classic、只勾 `repo`、7 天；用完在 <https://github.com/settings/tokens> 删掉。绝不要写进仓库文件或对话。
- **发布历史**：远端提交由脚本通过 API 创建，和本地 `git log` 是**两套历史**。想在本地同步，`git clone` 一份新的到别的目录，不要在这个目录里 `git push`。
- **备份**：真正需要备份的是 `src/`、`client/`、`scripts/`、文档——它们已经在 GitHub 上；`.work/` 里是逆向挖掘的产物，可随时删。

---

## 8. 目录里有什么

```
src/            host 半部：sources/（四个源）、install/（下载+落盘）、index-store.js（索引缓存）、index-build.js、tools.js、routes.js
src/cli.js      命令行入口：--to 指定任意宿主的技能目录，供 Codex / Claude Code 等非 DSH 宿主使用
client/         面板：手写 CJS bundle，注册到 Plugins 页的「技能市场」标签
scripts/        build-index.mjs（建索引）、rebuild-index.mjs（复用现有主题词重建索引）、check-syntax.mjs（零依赖语法检查）、install-into-profile.mjs（装进 DSH）、publish-api.mjs（发布）、maintain.mjs（一键维护）
test/           49 个测试（unit 32 + install 17，全部离线、无网络）
.github/workflows/  CI 与每周重建索引（只能在网页上改，见 §2.5）
docs/           流程图、发布步骤图
skill-index.json      技能索引快照（会随发布更新）
plugin-index.json     插件市场索引（安装源钉在某个提交上）
```
