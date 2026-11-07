# 参考

## 各宿主技能目录

使用 `--to <名称>`，也可以直接传任意目录。

| `--to` | 目录 |
| --- | --- |
| `dsh` | `~/.dsh/skills` 或 `$DSH_HOME/skills` |
| `agents` | `~/.agents/skills` 或 `$AGENTS_HOME/skills` |
| `claude` / `claude-code` | `~/.claude/skills` 或 `$CLAUDE_CONFIG_DIR/skills` |
| `codex` | `~/.codex/skills` 或 `$CODEX_HOME/skills` |
| `cursor` | `~/.cursor/skills` |
| `gemini` | `~/.gemini/skills` |
| `copilot` | `~/.copilot/skills` |
| `opencode` | `$XDG_CONFIG_HOME/opencode/skills` |
| `amp` | `$XDG_CONFIG_HOME/agents/skills` |
| `goose` | `$XDG_CONFIG_HOME/goose/skills` |
| `windsurf` | `~/.codeium/windsurf/skills` |
| `cline` | `~/.cline/skills` |
| `roo` | `~/.roo/skills` |
| `continue` | `~/.continue/skills` |
| `qwen` | `~/.qwen/skills` |

示例：`--to "D:/some/agent/skills"`。

## CLI

```text
search <query> [--source ...] [--limit N] [--index ...] [--offline] [--json]
install <coordinate> [--name NAME] [--path DIR] [--ref REF] [--to TARGET] [--dry-run] [--overwrite] [--json]
list [--to TARGET] [--json]
uninstall <name> [--to TARGET] [--force] [--json]
sources
```

不传 `--to` 时，依次检测 DSH、`.agents` 和 `.claude`。

## 配置

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `installRoot` | `$DSH_HOME/skills` | 技能安装目录 |
| `allowOverwrite` | `false` | 允许覆盖同名技能 |
| `sources` | 全部 | 启用的来源 |
| `indexes` | `[]` | 本地路径、`file://` 或 HTTP(S) 索引 URL |
| `indexTtlMs` | `21600000` | 远端索引 TTL |
| `indexFallbackLive` | `true` | 索引未命中时回落实时搜索 |
| `indexCacheDir` | `$DSH_HOME/cache/skill-market` | 索引缓存目录 |
| `skillsmpApiKey` | 空 | SkillsMP Bearer token |
| `githubToken` | 空 | 提高 GitHub 额度并启用代码搜索 |

## 索引模式

```bash
node scripts/build-index.mjs -q pdf -q excel -q react
```

默认生成：

`~/.dsh/cache/skill-market/skill-index.json`

配置示例：

```yaml
- id: skill-market
  name: dsh-skill-market
  config:
    indexes: ['C:\\Users\\<you>\\.dsh\\cache\\skill-market\\skill-index.json']
```

## 已知限制

- 需要能访问 GitHub 归档；超大仓库首次下载可能较慢。
- GitHub 匿名搜索约 10 次/分钟。
- 仓库内有多个 `SKILL.md` 时需要指定 `path`。
- SkillStore 签名证明完整性和 commit 身份，不代表技能安全。
- SkillsMP 匿名额度较小。
- 静态索引是快照；可使用实时回退或定期重建。
