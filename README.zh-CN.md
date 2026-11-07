# dsh-skill-market

[English](README.md) | **简体中文**

DeepSeek Harness 的 skill 市场插件。在一个面板里搜索 skillsmp、SkillStore、skills.sh 和 GitHub，预览后安装到本地，也可以随时卸载。

仓库：<https://github.com/zhao1722676538-cmd/dsh-skill-market>

## 快速开始

```bash
node scripts/install-into-profile.mjs --dry-run
node scripts/install-into-profile.mjs
```

重启 DSH，然后打开 **插件 → 技能市场**。

卸载插件：

```bash
node scripts/install-into-profile.mjs --uninstall
```

仓库也包含 [DSH 插件市场索引](plugin-index.json)，托管为 HTTPS 原始文件后，可以直接从 **插件 → Discover** 安装。

## 使用方法

在面板中搜索，点击 **检查并安装**，查看文件、脚本、联网提示和风险预览，确认后安装。

CLI 支持在任意兼容宿主中完成同样操作：

```bash
node src/cli.js search pdf --limit 5
node src/cli.js install anthropics/skills/pdf --to codex --dry-run
node src/cli.js install anthropics/skills/pdf --to codex
node src/cli.js list --to codex
node src/cli.js uninstall pdf --to codex
```

`--dry-run` 会真实下载并解析仓库、定位 `SKILL.md`，输出安全预览但不写入文件。

## 四个来源

| 来源 | 站点 | 说明 |
| --- | --- | --- |
| `skillsmp` | skillsmp.com | Anthropic 生态聚合索引 |
| `skillstore` | skillstore.io | 校验 Ed25519 manifest，并固定不可变 GitHub commit |
| `skillssh` | skills.sh | 按安装量排序的技能注册表 |
| `github` | GitHub | 仓库与代码搜索兜底 |

搜索结果会去重，并按安装量、star 和查询相关性排序。单个来源失败不会影响其他来源。

## 安全行为

- 安装使用暂存目录和事务化写入。
- 已有本地修改不会被静默覆盖，必须显式 `overwrite=true`。
- 无法校验当前文件树时会拒绝卸载。
- 拒绝路径穿越、符号链接、超大归档、gzip bomb 和 Windows 非法文件名。
- SkillStore 签名只证明 artifact 完整性，不代表技能已被证明安全。

## 可选：索引模式

生成静态索引，避免每次搜索都请求外部站点：

```bash
node scripts/build-index.mjs -q pdf -q excel -q react -q testing -q docs
```

把插件配置中的 `indexes` 指向生成文件。索引未命中时可回退到实时搜索。仓库也提供[现成快照](skill-index.json)。

## 更多文档

- [宿主目录、CLI 细节、完整配置与限制](docs/REFERENCE.zh-CN.md)
- [发布与一键安装](PUBLISH.md)
- [维护、刷新与排障](MAINTENANCE.md)

## 开发

```bash
npm test
npm run check
npm run check:json
```

需要 Node.js 20.3 或更高版本，使用 MIT License。
