# 把 dsh-skill-market 发布进 DSH 插件市场（图文步骤）

> 目标：别人在 DSH 的「插件 → Discover」里看到你的插件，点一下就装上。
> 总耗时约 10 分钟，其中只有「GitHub 建仓库」和「push」需要你本人操作（要你的账号）。

![发布流程](publish-flow.svg)

---

## 第 0 步：确认环境（1 分钟）

```bash
cd /d/dsh/addskills
git --version      # 需要 2.20+
node --version     # 需要 20+
```

本机实测：git 2.56.0 ✅、Node 24 ✅。**只差一个 GitHub 仓库**。

---

## 第 1 步：加上发布必需的两样信息（2 分钟）

打开 `package.json`，确认/补上这几项（`name`、`version`、`engines.dsh` 已经有了）：

```jsonc
{
  "name": "dsh-skill-market",
  "version": "0.1.0",
  "description": "Search and install agent skills from skillsmp / skillstore / skills.sh / GitHub",
  "keywords": ["dsh", "dsh-plugin", "skills", "marketplace", "agent-skills"],
  "author": "你的名字",
  "homepage": "https://github.com/你的用户名/dsh-skill-market#readme",
  "repository": {
    "type": "git",
    "url": "https://github.com/你的用户名/dsh-skill-market"
  },
  "engines": { "dsh": ">=0.2.1-rc.3 <0.3.0" }
}
```

为什么要 `engines.dsh`：插件市场用它显示「兼容哪些 DSH 版本」，不兼容的会标灰。
为什么要 `keywords`：市场条目没有关键词等于搜不到，只能靠名字翻。

顺手加一个 `.gitignore`（**别把 182MB 的挖掘产物提交上去**）：

```gitignore
node_modules/
.work/
*.log
plugin-index.json
```

> `plugin-index.json` 排除是因为它每次发版都重新生成，避免和代码提交互相纠缠；托管位置见第 4 步。

---

## 第 2 步：本地初始化并提交（2 分钟）

```bash
cd /d/dsh/addskills
git init
git add .
git commit -m "feat: dsh-skill-market 0.1.0"
git rev-parse HEAD
```

最后一行会打印 40 位十六进制，例如：

```
0123456789abcdef0123456789abcdef01234567
```

**这就是 commit**。它 = 「此刻代码的指纹」，插件索引靠它把安装版本钉死。

> 也可以让我帮你跑这三条（不需要任何账号）。commit 之后随时可以再改，改完重新提交会得到新 commit。

---

## 第 3 步：在 GitHub 建仓库并 push（详细版，5 分钟）

![第 3 步拆解](step3-github.svg)

### 3.1 前置检查

```bash
git rev-parse HEAD        # 必须能打印 40 位十六进制（第 2 步做完才有）
git log --oneline -1      # 应看到你的提交
```

没有输出 = 还没 commit，先回第 2 步。**push 的对象是 commit，没有 commit 就 push 不上去。**

### 3.2 建仓库（网页操作）

1. 登录 <https://github.com>，点右上角 **`+` → New repository**（直达 <https://github.com/new>）。
2. 按下表填：

| 页面上的字段 | 选什么 | 为什么 |
| --- | --- | --- |
| **Repository name** | `dsh-skill-market` | 建议和 `package.json` 的 `name` 一致，不强制 |
| **Description** | 随便写或留空 | 只影响仓库页展示 |
| **Public / Private** | **Public** | 私有仓库的 raw 链接别人打不开，插件市场读不到索引 |
| Add a README file | **不勾** | 本地已有提交，勾了会让 push 变 non-fast-forward |
| Add .gitignore | **不勾** | 原因同上（我们第 1 步自己写了） |
| Choose a license | **不勾** | 同上；想加 license 事后再加 |
| Template | 不选 | — |

3. 点绿色 **Create repository**。
4. 跳转后的页面标题是 **Quick setup**，中间有三条命令 —— 下面照着做。

### 3.3 执行三条命令

在 **`D:\dsh\addskills`** 里执行（把「你的用户名」换成你的 GitHub 用户名，**大小写敏感**）：

```bash
git remote add origin https://github.com/你的用户名/dsh-skill-market.git
git branch -M main
git push -u origin main
```

三条命令分别做什么：

| 命令 | 作用 | 重复执行会怎样 |
| --- | --- | --- |
| `git remote add origin …` | 给本地仓库记下「远端在哪」 | 报 `remote origin already exists`，此时先 `git remote remove origin` |
| `git branch -M main` | 把当前分支强制改名为 `main` | 幂等，无副作用 |
| `git push -u origin main` | 上传提交，并让本地 `main` 记住跟踪远端 | 之后直接 `git push` 即可 |

### 3.4 认证：第一次 push 会要你登录

Git for Windows 自带 **Git Credential Manager**，第一次 push 通常弹出一个窗口：

> **Sign in with your browser** → 点它 → 浏览器打开 GitHub 授权页 → 点 **Authorize** → 回到终端，push 自动继续。

成功后再 push 不会重复问（凭据存进了 Windows 凭据管理器）。

**如果弹窗没出现 / 提示输入 Username、Password：**

- 方式 A（推荐）：命令行执行 `git config --global credential.helper manager`，再 push 一次。
- 方式 B（Token 当密码）：
  1. 打开 <https://github.com/settings/tokens> → **Generate new token (classic)**
  2. Note 随便填，Expiration 选 30 天，勾选 **repo** 权限
  3. 生成后复制 `ghp_...`（只显示一次）
  4. push 时：Username 填你的 GitHub 用户名，**Password 粘贴 token**（不是账号密码；GitHub 早已禁用密码推送）
- 方式 C（SSH，已配置过 SSH key 的人）：
  ```bash
  git remote set-url origin git@github.com:你的用户名/dsh-skill-market.git
  git push -u origin main
  ```
  没配置过 SSH key 就别走这条，见 3.5 最后一行。

### 3.5 成功的输出长什么样

```
Enumerating objects: 42, done.
Counting objects: 100% (42/42), done.
Writing objects: 100% (42/42), 120.34 KiB | 2.1 MiB/s, done.
To https://github.com/你的用户名/dsh-skill-market.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

验证三件事：

1. 刷新仓库网页 → 能看到 `src/`、`client/`、`package.json`、`README.md`（**不应**看到 `.work/`、`node_modules/`）。
2. `git remote -v` → 显示 fetch/push 两条地址。
3. `git log --oneline -1` 与网页上最新 commit 的短哈希一致。

### 3.6 push 失败对照表

| 报错 | 原因 | 修法 |
| --- | --- | --- |
| `Repository not found` | 用户名/仓库名拼错，或仓库是 Private | 用网页地址逐字核对；把仓库改成 Public |
| `Authentication failed` / `could not read Username` | 填了账号密码而不是 token；或凭据缓存失效 | 见 3.4 方式 A/B |
| `src refspec main does not match any` | 本地还没有 commit，或分支名不是 main | 先 `git log`；没有就回第 2 步；有则 `git branch -M main` |
| `remote origin already exists` | origin 已配置 | `git remote remove origin` 后重加 |
| `failed to push some refs` / `non-fast-forward` | 建仓时勾了 README/.gitignore，远端已有提交 | `git pull --rebase origin main` 再 push |
| `Permission denied (publickey)` | 用了 SSH 地址但没配 key | 切回 https 地址，或按 GitHub 文档加 SSH key |
| 卡住无响应 | 网络到 github.com 不通 | 配代理：`git config --global http.proxy http://127.0.0.1:端口` |

### 3.7 不想敲命令？

- **VS Code**：打开 `D:\dsh\addskills` → 左侧「源代码管理」→ **Publish to GitHub** → 选 **Publish to GitHub public repository**（注意别选成 private）。
- **GitHub Desktop**：Add local repository → 选中目录 → Publish repository → **取消勾选 Keep this code private**。

两者效果和命令行完全一样，之后回来继续第 4 步。

---

## 第 4 步：生成插件索引（1 分钟）

回到本地仓库，一条命令：

```bash
node scripts/build-index.mjs --plugin-index --repo https://github.com/你的用户名/dsh-skill-market
```

它会自动读 `package.json` + git HEAD，输出：

```json
{
  "out": "D:\\dsh\\addskills\\plugin-index.json",
  "bytes": 980,
  "format": 1,
  "plugin": "dsh-skill-market",
  "version": "0.1.0",
  "source": "git+https://github.com/你的用户名/dsh-skill-market.git#0123456789abcdef…"
}
```

生成的 `plugin-index.json` 长这样（关键三行）：

```jsonc
{
  "format": 1,
  "plugins": [{
    "name": "dsh-skill-market",
    "versions": [{
      "version": "0.1.0",
      "source": { "type": "git", "url": "https://github.com/…/dsh-skill-market", "commit": "0123…4567" },
      "engines": { "dsh": ">=0.2.1-rc.3 <0.3.0" }
    }]
  }]
}
```

**这份 JSON 就是「上架信息」**：市场只读它，不读你的代码。

---

## 第 5 步：把索引托管出去（1 分钟）

最简单：把索引也提交进仓库，用 GitHub 的 raw 链接：

```bash
# 临时把 plugin-index.json 从 .gitignore 里拿掉（或删掉那一行）
git add -f plugin-index.json
git commit -m "chore: publish plugin market index"
git push
```

拿到 URL（把「你的用户名」替换掉）：

```
https://raw.githubusercontent.com/你的用户名/dsh-skill-market/main/plugin-index.json
```

浏览器打开这个链接，应该直接看到那段 JSON。**这就是后面要填的索引地址。**

> 为什么这样不会死循环：索引里钉的 commit 是**代码那次提交**；索引自己也提交一次无所谓，因为别人装的是 index 里写的那个 commit，不是 index 所在的最新提交。
>
> 想更干净就放 Gist（raw 链接）或 GitHub Pages，效果一样。

---

## 第 6 步：在 DSH 里填索引（30 秒）

编辑 `C:\Users\17226\.dsh\profiles\desktop\cordis.patch.yml`，找到 `plugin-market` 那段（现在 `indexes: []`），改成：

```yaml
- id: plugin-market
  name: '@deepseek-ai/dsh-plugin-market'
  config:
    indexes:
      - 'https://raw.githubusercontent.com/你的用户名/dsh-skill-market/main/plugin-index.json'
```

保存后**重启 DSH**。

---

## 第 7 步：验收（1 分钟）

1. 打开「插件」页 → **Discover** 标签。
2. 应该出现一张卡片：`dsh-skill-market`，带版本 0.1.0、作者、描述、关键词。
3. 点安装 → 装进 profile → 按提示重启。
4. 重启后「插件」里多出 **Skill Market** 面板；模型侧多出 `skill_market_*` 工具。

看不到时的排查顺序：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| Discover 空白 | 索引 URL 抓不到 | 浏览器直开该 URL 必须能看到 JSON；私有仓库不行 |
| 卡片标「不兼容」 | `engines.dsh` 与当前 DSH 版本不符 | 改 `package.json` 的 engines 后重新发版 |
| 安装报错 404 | commit 不是 40 位 / 仓库地址错 | `node scripts/build-index.mjs --plugin-index --repo <正确URL>` 重生成 |
| 装上但没面板 | 没重启 / profile 没加载 | 重启 DSH，检查 `dsh.profile.bundles` 里有 `dsh-skill-market` |

---

## 第 8 步：别人怎么装

发给对方两样：索引 URL + 一句话。

> 在 `cordis.patch.yml` 的 `plugin-market` 下加
> `indexes: ['https://raw.githubusercontent.com/…/plugin-index.json']`，
> 重启后在「插件 → Discover」里点安装。

---

## 以后发新版本

```bash
git add -A && git commit -m "feat: 0.2.0" && git push
# package.json 里 version 改成 0.2.0 后：
node scripts/build-index.mjs --plugin-index --repo https://github.com/你的用户名/dsh-skill-market
git add -f plugin-index.json && git commit -m "chore: index 0.2.0" && git push
```

索引里的 commit 会自动换成新的 HEAD，老用户刷新 Discover 就会看到「可更新」。

---

## 附：不想上 GitHub 的替代方案

| 方式 | 别人怎么用 | 缺点 |
| --- | --- | --- |
| 直接拷目录 | `node scripts/install-into-profile.mjs` | 手动、不跟踪版本 |
| 自己开静态服务器 | 索引 URL 指向内网/公网 IP | 要一台常开机器 |
| 只给索引文件 | 对方填 `file:///路径/plugin-index.json` | 只能本机装，别人不行 |
