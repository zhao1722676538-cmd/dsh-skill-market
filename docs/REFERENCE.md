# Reference

## Host skill directories

Use `--to <name>` or pass any custom directory.

| `--to` | Directory |
| --- | --- |
| `dsh` | `~/.dsh/skills` or `$DSH_HOME/skills` |
| `agents` | `~/.agents/skills` or `$AGENTS_HOME/skills` |
| `claude` / `claude-code` | `~/.claude/skills` or `$CLAUDE_CONFIG_DIR/skills` |
| `codex` | `~/.codex/skills` or `$CODEX_HOME/skills` |
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

Example: `--to "D:/some/agent/skills"`.

## CLI

```text
search <query> [--source ...] [--limit N] [--index ...] [--offline] [--json]
install <coordinate> [--name NAME] [--path DIR] [--ref REF] [--to TARGET] [--dry-run] [--overwrite] [--json]
list [--to TARGET] [--json]
uninstall <name> [--to TARGET] [--force] [--json]
sources
```

Without `--to`, the CLI checks DSH, `.agents`, then `.claude`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `installRoot` | `$DSH_HOME/skills` | Skill installation directory |
| `allowOverwrite` | `false` | Allow replacing an existing skill |
| `sources` | all | Enabled marketplace sources |
| `indexes` | `[]` | Local paths, `file://`, or HTTP(S) index URLs |
| `indexTtlMs` | `21600000` | Remote-index TTL |
| `indexFallbackLive` | `true` | Fall back to live search on an index miss |
| `indexCacheDir` | `$DSH_HOME/cache/skill-market` | Index cache directory |
| `skillsmpApiKey` | empty | SkillsMP bearer token |
| `githubToken` | empty | Higher GitHub quota and code search |

## Index mode

```bash
node scripts/build-index.mjs -q pdf -q excel -q react
```

Generated index:

`~/.dsh/cache/skill-market/skill-index.json`

Configure it under:

```yaml
- id: skill-market
  name: dsh-skill-market
  config:
    indexes: ['C:\\Users\\<you>\\.dsh\\cache\\skill-market\\skill-index.json']
```

## Limitations

- GitHub archives must be reachable; very large repositories can take time.
- Anonymous GitHub search is limited to about 10 requests per minute.
- Ambiguous repositories require a specific skill `path`.
- SkillStore signatures establish integrity and commit identity, not safety.
- SkillsMP anonymous quota is small.
- A static index is a snapshot; use live fallback or rebuild it periodically.
