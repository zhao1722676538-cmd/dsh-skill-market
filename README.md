# dsh-skill-market

**English** | [简体中文](README.zh-CN.md)

A skill marketplace plugin for **DeepSeek Harness**. Search skillsmp, SkillStore, skills.sh, and GitHub from one panel, preview a skill, install it locally, or uninstall it later.

Repository: <https://github.com/zhao1722676538-cmd/dsh-skill-market>

## Quick start

```bash
node scripts/install-into-profile.mjs --dry-run
node scripts/install-into-profile.mjs
```

Restart DSH, then open **Plugins → Skill Market**.

To remove the plugin:

```bash
node scripts/install-into-profile.mjs --uninstall
```

The repository also includes a [DSH plugin-market index](plugin-index.json), so it can be installed from *Plugins → Discover* when hosted as a raw HTTPS URL.

## Usage

Search in the panel, select **Check and install**, review the file/script/network/risk preview, then confirm.

The same workflow is available from the CLI on any supported host:

```bash
node src/cli.js search pdf --limit 5
node src/cli.js install anthropics/skills/pdf --to codex --dry-run
node src/cli.js install anthropics/skills/pdf --to codex
node src/cli.js list --to codex
node src/cli.js uninstall pdf --to codex
```

`--dry-run` downloads and resolves the repository, locates `SKILL.md`, and returns a safety preview without writing files.

## Sources

| Source | Registry | Notes |
| --- | --- | --- |
| `skillsmp` | skillsmp.com | Broad Anthropic-ecosystem index |
| `skillstore` | skillstore.io | Ed25519 manifest verification and immutable GitHub commit |
| `skillssh` | skills.sh | Registry ranked by installs |
| `github` | GitHub | Fallback repository and code search |

Results are deduplicated and ranked by popularity and query relevance. One failing source does not block the others.

## Safety

- Installations are staged and written transactionally.
- Existing local edits are not replaced without `overwrite=true`.
- Uninstall is refused when the installed tree cannot be verified.
- Path traversal, symlinks, oversized archives, gzip bombs, and unsafe Windows filenames are rejected.
- SkillStore signatures prove artifact integrity, not that a skill is safe.

## Optional index mode

Use one static index for fast local search without repeated marketplace requests:

```bash
node scripts/build-index.mjs -q pdf -q excel -q react -q testing -q docs
```

Point the plugin's `indexes` setting at the generated file. Index misses can fall back to live search. A ready-to-use snapshot is also [available in this repository](skill-index.json).

## Documentation

- [Host directories, CLI details, configuration, and limitations](docs/REFERENCE.md)
- [Publishing and one-click installation](PUBLISH.md)
- [Maintenance, refresh, and troubleshooting](MAINTENANCE.md)

## Development

```bash
npm test
npm run check
npm run check:json
```

Requires Node.js 20.3 or newer. MIT licensed.
