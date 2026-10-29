# dsh-skill-market

**English** | [简体中文](README.zh-CN.md)

A **skill marketplace** plugin for DeepSeek Harness: search four skill sites from one panel, install a skill into your local DSH skills directory with one click, uninstall it whenever you want.

- **Host side (Node):** 4 model tools + 5 HTTP routes + a `skillMarket` service.
- **Client side (browser):** a **Skill Market** panel inside the *Plugins* page (search / source filter / install / uninstall / installed list).
- **No build step:** `client/client.js` is a hand-written CJS bundle, `src/**` is plain ESM.

Repository: <https://github.com/zhao1722676538-cmd/dsh-skill-market>

## Sources

| id | Site | API | Notes |
| --- | --- | --- | --- |
| `skillsmp` | skillsmp.com | `GET /api/v1/skills/search` | Aggregated Anthropic-ecosystem index; anonymous quota 50/day, token supported |
| `skillstore` | skillstore.io | `GET /api/skills?q=` + `/api/skills/{slug}/manifest` | Ships risk levels and a signed manifest pinned to an immutable GitHub commit |
| `skillssh` | skills.sh | `GET /api/search?q=` | Registry sorted by install count; entries look like `anthropics/skills/pdf` |
| `github` | api.github.com | repo/code search + zipball install | Fallback: any `*/SKILL.md` in any repository can be installed |

Results are deduplicated by `repo + skill name` (`tags` keeps every source that saw it), then ranked by installs/stars and query relevance.

## Index-driven search (recommended)

By default the plugin hits all four sites live — slow, needs a GitHub token, and gets throttled by anonymous limits. Switch it to the same model the official plugin market uses: **one static index + local filtering**.

```bash
# 1. Harvest an index (repeatable, use the topics you care about)
node scripts/build-index.mjs -q pdf -q excel -q pptx -q react -q "code review" -q testing -q image -q docs
# → C:\Users\<you>\.dsh\cache\skill-market\skill-index.json (156 entries, ~90KB, ~12s)

# 2. Point the profile at it
#    - id: skill-market
#      name: 'dsh-skill-market'
#      config:
#        indexes: ['C:\\Users\\<you>\\.dsh\\cache\\skill-market\\skill-index.json']
```

Every later search becomes a **millisecond-scale local filter** (3–6 ms measured): no network, no GitHub quota, no token.

- A miss falls back to a live search when `indexFallbackLive` is on (default), so search never silently returns nothing.
- `indexes` accepts several locations: `http(s)://` URLs (self-hostable, ETag/Last-Modified + TTL caching), `file://`, or plain local paths.
- Index stale? Re-run the builder. `indexTtlMs` (default 6h) only controls how often a *remote* index is revalidated.
- The model can trigger it too: `skill_market_build_index` (`queries / sources / limit / outPath`).

A ready-made snapshot is hosted from this repository, so the plugin works out of the box:

```
https://raw.githubusercontent.com/zhao1722676538-cmd/dsh-skill-market/main/skill-index.json
```

## Model tools

| Tool | What it does |
| --- | --- |
| `skill_market_search` | Cross-source search; returns `id / name / repo / path / installs / stars / risk` plus `mode` (`index` / `index+live` / `live`) |
| `skill_market_build_index` | Harvests the four sources into one static index JSON (then wire its path into `indexes`) |
| `skill_market_install` | Accepts a search-result `id`, `owner/repo`, `owner/repo/path`, or a GitHub URL; resolves the skill directory and writes it to `$DSH_HOME/skills/<name>` |
| `skill_market_uninstall` | Removes a skill by name (registry first, then directory) |
| `skill_market_list` | Installed skills with their source, plus the enabled source list |

Installing refreshes `ctx.skills` immediately — the `skill` tool sees the new skill **without a restart**. Skill names are validated (`..` and path separators rejected) and an existing directory is never overwritten silently.

## Command line (any host, not just DSH)

The plugin shell (panel + model tools) is DSH-specific, but searching and installing is not. The CLI writes a `SKILL.md` tree into whatever directory a host scans, so any agent that can run a shell command — Codex CLI, Claude Code, plain terminal — can use it:

```bash
node src/cli.js search pdf --limit 5          # four sources, merged + ranked
node src/cli.js search pdf --index https://raw.githubusercontent.com/zhao1722676538-cmd/dsh-skill-market/main/skill-index.json
node src/cli.js install anthropics/skills/pdf --to claude
node src/cli.js install https://github.com/openai/skills/tree/main/skills/playwright --to ~/.agents/skills
node src/cli.js list --to dsh
node src/cli.js uninstall pdf --to claude
```

- `--to dsh|claude|agents|codex|cursor|gemini|copilot|opencode|amp|goose|windsurf|cline|roo|continue|qwen|<path>` selects the skills directory; without it the CLI auto-detects an existing DSH → `.agents` → `.claude` root.
- `--json` on every command for scripting; `--dry-run` on `install` to resolve without writing.
- `--source`, `--limit`, `--offline` for search; `--name`, `--path`, `--ref`, `--overwrite` for install.
- Web-only assistants (ChatGPT, Grok) have no local skills directory, so neither this CLI nor the plugin applies there.

### Where each host looks for skills

Every host reads `SKILL.md` folders from a directory; install into the one your agent scans (global scope shown):

| `--to` | Directory | Notes |
|---|---|---|
| `dsh` | `~/.dsh/skills` (or `$DSH_HOME/skills`) | DeepSeek Harness; project scope is `<project>/.dsh/skills` and `<project>/.agents/skills` |
| `agents` | `~/.agents/skills` (or `$AGENTS_HOME/skills`) | The shared convention: Codex, Gemini CLI, GitHub Copilot, OpenCode, Amp and Replit read this directory directly |
| `claude` / `claude-code` | `~/.claude/skills` (or `$CLAUDE_CONFIG_DIR/skills`) | Claude Code; project scope is `.claude/skills` |
| `codex` | `~/.codex/skills` (or `$CODEX_HOME/skills`) | Codex CLI |
| `cursor` | `~/.cursor/skills` | Cursor |
| `gemini` | `~/.gemini/skills` | Gemini CLI |
| `copilot` | `~/.copilot/skills` | GitHub Copilot |
| `opencode` | `$XDG_CONFIG_HOME/opencode/skills` (`~/.config/opencode/skills`) | OpenCode |
| `amp` | `$XDG_CONFIG_HOME/agents/skills` | Amp |
| `goose` | `$XDG_CONFIG_HOME/goose/skills` | Goose |
| `windsurf` | `~/.codeium/windsurf/skills` | Windsurf |
| `cline` / `roo` / `continue` | `~/.cline/skills`, `~/.roo/skills`, `~/.continue/skills` | Cline, Roo Code, Continue |
| `qwen` | `~/.qwen/skills` | Qwen Code |

Any other path still works: `--to "D:/some/agent/skills"`. The table follows [vercel-labs/skills v1.3.9 `src/agents.ts`](https://github.com/vercel-labs/skills/blob/main/src/agents.ts) (39 host definitions), the [Claude Code skills docs](https://code.claude.com/docs/en/skills) and DSH's own skill discovery.

## Install this plugin

```bash
node scripts/install-into-profile.mjs --dry-run   # show the plan
node scripts/install-into-profile.mjs             # copy into the profile + register dsh.profile.bundles
```

Then **restart DSH**; a *Skill Market* tab appears under *Plugins*. To remove it:

```bash
node scripts/install-into-profile.mjs --uninstall
```

## Let others install it in one click (DSH plugin market)

The plugin market stores no code — it reads a **format-1 index JSON** whose records carry an install coordinate. This repository produces that file:

```bash
# run inside a git checkout: reads package.json and the HEAD commit
node scripts/build-index.mjs --plugin-index --repo https://github.com/<you>/dsh-skill-market
# → ./plugin-index.json
```

It embeds package name, version, description, `engines.dsh`, the 40-char commit, commit time, repository URL and keywords. Host the file at an **https URL** (Gist raw / GitHub Pages / any static host) and add one line to your settings:

```yaml
- id: plugin-market
  name: '@deepseek-ai/dsh-plugin-market'
  config:
    indexes: ['https://raw.githubusercontent.com/zhao1722676538-cmd/dsh-skill-market/main/plugin-index.json']
```

Open *Plugins → Discover* and the plugin shows up with a one-click install — no clone, no manual profile edit.

Notes:

- The git coordinate **must pin a full 40-char commit**, so every release needs a regenerated index and an updated hosted file (`--commit` overrides the detected one).
- Monorepos: `--path packages/xxx`. Already on npm: add `--npm` and the index uses `name@version` instead of a git coordinate.
- The output uses the same format as the official `@deepseek-ai/dsh-plugin-market-index` validator; this repo's tests assert structural equivalence.

## Configuration

| key | default | Meaning |
| --- | --- | --- |
| `installRoot` | `$DSH_HOME/skills` | Where skills are installed |
| `allowOverwrite` | `false` | Allow replacing an already-installed skill with the same name |
| `sources` | all | Which sources are enabled |
| `indexes` | `[]` | Index locations (local path / `file://` / `http(s)` URL); non-empty switches on index-driven mode |
| `indexTtlMs` | `21600000` (6h) | Remote-index TTL; expired entries are revalidated (ETag, 304 avoids re-download) |
| `indexFallbackLive` | `true` | Fall back to a live search on an index miss |
| `indexCacheDir` | `$DSH_HOME/cache/skill-market` | Default cache dir for remote and generated indexes |
| `skillsmpApiKey` | — | skillsmp Bearer token (higher quota) |
| `githubToken` | — | GitHub token: anonymous search allows 10 req/min, with a token 5000/h, and unlocks `filename:SKILL.md` code search |

## Development

```bash
node --test test/unit.test.mjs          # pure functions + registry round-trip + GitHub adapter + index store + plugin-index regression (27 cases)
node --check src/index.js && node --check client/client.js
```

Maintenance workflow (publish, index refresh, troubleshooting): see [MAINTENANCE.md](MAINTENANCE.md) (Chinese).

## Known limitations

- Installation downloads a GitHub archive (`codeload`), so github.com must be reachable; the first download of a large repo can take from ten seconds to half a minute.
- The `github` source is limited to **10 searches/minute** anonymously: one search issues a single request and caches for 5 minutes in-process; when throttled, the panel/tool says "wait about a minute or set `githubToken`" instead of returning empty results.
- If a repository contains several `SKILL.md` files, install reports the ambiguity and lists candidates; re-run with `path=` (the panel entry already carries a path).
- The `skillsmp` anonymous quota is small.
- An index is a **snapshot**: skills published later are missing from it (a miss falls back to live search). Re-run the builder periodically, or host the index and let the host revalidate it by TTL.
- The client panel only calls this plugin's same-origin routes; it never contacts third-party sites directly.
- Skills only. The official plugin market (`dsh-plugin-market`) stays separate.
