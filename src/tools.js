/**
 * Agent-facing tools. Registered on the `tools` service from src/index.js.
 * @module dsh-skill-market/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

/** @param {(value: any) => string} fn */
const textRender = (fn) => (_args, value) => [{ type: 'text', text: fn(value) }]

/**
 * Drop undefined object values (and undefined array holes) so a tool result
 * survives the host's lossless-JSON check.
 * @param {any} value
 * @returns {any}
 */
function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact).filter((item) => item !== undefined)
  }
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return Object.is(value, -0) ? 0 : value
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const next = compact(item)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  return value
}

const SOURCE_IDS = ['skillsmp', 'skillstore', 'skillssh', 'github']

const INSTALL_NOTE =
  'Installing writes a third-party SKILL.md (plus its assets) into the local skills directory. ' +
  'Before installing, show the user what the skill is and where it comes from, and get their agreement.'

/**
 * @param {any} ctx
 * @param {any} service
 * @returns {() => void} disposer
 */
export function registerTools(ctx, service) {
  /** @type {(() => void)[]} */
  const disposers = []
  /** @param {any} definition */
  const add = (definition) => {
    // The host validates every tool result as lossless JSON, so an optional
    // field that happens to be undefined ("repo", "stars", ...) makes the whole
    // call fail. Strip undefined before the value leaves the tool.
    const execute = definition?.execute
    const compacted =
      typeof execute === 'function'
        ? { ...definition, execute: async (...args) => compact(await execute(...args)) }
        : definition
    const off = ctx.tools.register(compacted)
    if (typeof off === 'function') disposers.push(off)
  }

  add(
    defineTool({
      name: 'skill_market_search',
      description:
        'Search public skill marketplaces for installable agent skills. Sources: skillsmp (skillsmp.com), ' +
        'skillstore (skillstore.io), skillssh (skills.sh), github (repositories with agent-skill topics). ' +
        'Use this before creating a skill from scratch, and when the user asks to find/install a skill. ' +
        'Results are merged and ranked; `installable` says whether the entry carries enough to install.',
      parameters: {
        query: { type: 'string', required: true, description: 'What the skill should do, e.g. "pdf form filling" or "pdf".' },
        sources: {
          type: 'array',
          items: { type: 'string', enum: SOURCE_IDS },
          description: 'Restrict to some sources; default = every enabled source.',
        },
        limit: { type: 'number', description: 'Max entries per source (default 10, capped at 25).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true, description: 'One-line result summary including per-source status.' },
            mode: { type: 'string', description: 'index | index+live | live — which path answered.' },
            indexed: { type: 'number', description: 'How many entries the local index holds, when index-driven.' },
            items: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string', required: true },
                  name: { type: 'string', required: true },
                  description: { type: 'string', required: true },
                  id: { type: 'string', required: true },
                  repo: { type: 'string' },
                  path: { type: 'string' },
                  installs: { type: 'number' },
                  stars: { type: 'number' },
                  risk: { type: 'string' },
                  url: { type: 'string' },
                  installable: { type: 'boolean', required: true },
                },
              },
            },
            reports: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  source: { type: 'string', required: true },
                  ok: { type: 'boolean', required: true },
                  count: { type: 'number' },
                  error: { type: 'string' },
                  ms: { type: 'number', required: true },
                },
              },
            },
          },
        },
        render: textRender(renderSearch),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const outcome = await service.search({
          query: args.query,
          sources: args.sources,
          limit: args.limit,
        })
        return {
          summary: summarizeSearch(outcome),
          mode: outcome.mode ?? 'live',
          indexed: outcome.index?.entries,
          items: outcome.items.map((item) => ({
            source: item.source,
            name: item.name,
            description: item.description,
            id: item.id,
            repo: item.repo,
            path: item.path,
            installs: item.installs,
            stars: item.stars,
            risk: item.risk,
            url: item.url,
            installable: Boolean(item.repo),
          })),
          reports: outcome.reports,
        }
      },
    }),
  )

  add(
    defineTool({
      name: 'skill_market_build_index',
      description:
        'Build a static skill index (JSON) out of live marketplace searches. Wire the resulting file or URL into the ' +
        'plugin config `indexes` and every later search becomes a local filter — no GitHub token, no anonymous rate ' +
        'limit, sub-millisecond. Use it when the user wants the market to be fast/offline, or after curating a set of ' +
        'topics worth keeping.',
      parameters: {
        queries: {
          type: 'array',
          items: { type: 'string' },
          required: true,
          description: 'Search terms to harvest, e.g. ["pdf", "excel", "slides"].',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: SOURCE_IDS },
          description: 'Restrict harvesting to some sources; default = every enabled source.',
        },
        limit: { type: 'number', description: 'Entries per query (default 10, capped at 50).' },
        outPath: { type: 'string', description: 'Where to write the index JSON (default: the plugin cache dir).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            count: { type: 'number', required: true },
            bytes: { type: 'number' },
            reports: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  query: { type: 'string', required: true },
                  ok: { type: 'boolean', required: true },
                  count: { type: 'number' },
                  error: { type: 'string' },
                },
              },
            },
            hint: { type: 'string' },
            warning: { type: 'string' },
          },
        },
        render: textRender(
          (value) =>
            `Built index with ${value.count} skill(s) → ${value.path}` +
            (value.warning ? `\n⚠ ${value.warning}` : '') +
            (value.hint ? `\n${value.hint}` : ''),
        ),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const result = await service.buildIndexDocument({
          queries: args.queries,
          sources: args.sources,
          limit: args.limit,
          outPath: args.outPath,
        })
        const failed = result.reports.filter((report) => !report.ok)
        return {
          ok: true,
          path: result.path,
          count: result.count,
          bytes: result.bytes,
          reports: result.reports.map((report) => ({
            query: report.query,
            ok: report.ok === true,
            count: report.count ?? 0,
            error: report.error,
          })),
          warning: result.warning,
          hint:
            `Add this path (or a URL serving the same JSON) to the plugin config \`indexes\` to make searches local: ` +
            `${JSON.stringify([result.path])}.` +
            (failed.length > 0 ? ` ${failed.length} query/queries failed while harvesting.` : ''),
        }
      },
    }),
  )

  add(
    defineTool({
      name: 'skill_market_install',
      description:
        `Install one skill from a marketplace into the local skills directory, then make it usable immediately. ${INSTALL_NOTE} ` +
        'Pass either `repo` (+ optional `path`/`ref`) for a GitHub source, or `source`+`id` from a search result. ' +
        '`name` is the directory name / skill name to install as (lowercase, digits, dot, dash, underscore).',
      parameters: {
        name: { type: 'string', required: true, description: 'Skill name to install as, e.g. "pdf".' },
        source: { type: 'string', enum: SOURCE_IDS, description: 'Marketplace the entry came from.' },
        id: { type: 'string', description: 'Source-specific id from skill_market_search.' },
        repo: { type: 'string', description: 'GitHub repository "owner/name" — the direct install coordinate.' },
        path: { type: 'string', description: 'Directory inside the repository that holds SKILL.md (optional; auto-located).' },
        ref: { type: 'string', description: 'Commit/branch/tag to install from (default: repository default branch).' },
        overwrite: { type: 'boolean', description: 'Replace an existing directory that this plugin does not manage.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            name: { type: 'string', required: true },
            dir: { type: 'string' },
            files: { type: 'number' },
            repo: { type: 'string' },
            commit: { type: 'string' },
            source: { type: 'string' },
            warnings: { type: 'array', items: { type: 'string' } },
            hint: { type: 'string' },
          },
        },
        render: textRender(
          (value) =>
            `Installed skill "${value.name}"${value.repo ? ` from ${value.repo}@${(value.commit ?? '').slice(0, 12)}` : ''}` +
            `${value.files ? ` (${value.files} files)` : ''} → ${value.dir ?? '(unknown)'}. ${value.hint ?? ''}`.trim(),
        ),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const entry = await service.resolveEntry(args)
        const result = await service.install(entry, { overwrite: args.overwrite === true })
        return {
          ok: true,
          name: result.name,
          dir: result.dir,
          files: result.files,
          repo: result.repo,
          commit: result.commit,
          source: entry.source,
          warnings: result.warnings ?? [],
          hint: service.installHint(result),
        }
      },
    }),
  )

  add(
    defineTool({
      name: 'skill_market_uninstall',
      description:
        'Uninstall a skill that this plugin installed: removes its directory and its registry entry. ' +
        'Files that changed on disk after install are reported instead of deleted; pass force to delete anyway.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name (see skill_market_list).' },
        force: { type: 'boolean', description: 'Delete even when files were modified after install.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            name: { type: 'string', required: true },
            removed: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
            conflicts: { type: 'array', items: { type: 'string' } },
            hint: { type: 'string' },
          },
        },
        render: textRender((value) =>
          value.ok
            ? `Uninstalled "${value.name}" (${(value.removed ?? []).length} paths removed). ${value.hint ?? ''}`.trim()
            : `Did not uninstall "${value.name}": ${value.reason ?? 'unknown reason'}. ${value.hint ?? ''}`.trim(),
        ),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        const result = await service.uninstall(args.name, { force: args.force === true })
        return {
          ok: result.ok === true,
          name: result.name ?? args.name,
          removed: result.removed ?? [],
          reason: result.reason,
          conflicts: result.conflicts,
          hint: service.uninstallHint(result),
        }
      },
    }),
  )

  add(
    defineTool({
      name: 'skill_market_list',
      description:
        'List every skill installed through this plugin, with source repository, pinned commit and whether the ' +
        'directory is still present on disk. Also reports skills present in the skills directory that this plugin ' +
        'does not manage (installed by hand or by another tool).',
      parameters: {
        includeUnmanaged: { type: 'boolean', description: 'Also list unmanaged skill directories found on disk (default true).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', required: true },
            installed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  source: { type: 'string' },
                  repo: { type: 'string' },
                  commit: { type: 'string' },
                  installedAt: { type: 'string' },
                  present: { type: 'boolean', required: true },
                  dir: { type: 'string' },
                },
              },
            },
            unmanaged: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  dir: { type: 'string' },
                },
              },
            },
            root: { type: 'string', required: true },
          },
        },
        render: textRender(renderList),
      },
      execute: async (args, exec) => {
        exec.signal.throwIfAborted()
        return service.list(args.includeUnmanaged !== false)
      },
    }),
  )

  return () => {
    for (const off of disposers) {
      try {
        off()
      } catch {
        /* best effort */
      }
    }
    disposers.length = 0
  }
}

/** @param {any} outcome */
function summarizeSearch(outcome) {
  const ok = outcome.reports.filter((report) => report.ok)
  const bad = outcome.reports.filter((report) => !report.ok)
  const parts = [`${outcome.items.length} skill(s)`]
  if (outcome.mode === 'index') parts.push(`from local index (${outcome.index?.entries ?? 0} entries)`)
  else if (outcome.mode === 'index+live') parts.push('from local index + live search')
  if (ok.length > 0) parts.push(`from ${ok.map((report) => `${report.source}:${report.count ?? 0}`).join(', ')}`)
  if (bad.length > 0) parts.push(`failed ${bad.map((report) => `${report.source} (${report.error ?? 'error'})`).join('; ')}`)
  return parts.join(' ')
}

/** @param {any} value */
function renderSearch(value) {
  const lines = [value.summary]
  for (const item of value.items.slice(0, 20)) {
    const facts = [item.source, item.installs ? `${item.installs} installs` : '', item.stars ? `${item.stars}★` : '', item.risk ?? '']
      .filter(Boolean)
      .join(' · ')
    lines.push(`- ${item.name} [${facts}]${item.repo ? ` ${item.repo}${item.path ? `/${item.path}` : ''}` : ''}`)
    if (item.description) lines.push(`  ${item.description}`)
  }
  if (value.items.length > 20) lines.push(`… ${value.items.length - 20} more`)
  const failed = value.reports.filter((report) => !report.ok)
  if (failed.length > 0) lines.push(`Source errors: ${failed.map((report) => `${report.source}: ${report.error}`).join(' | ')}`)
  return lines.join('\n')
}

/** @param {any} value */
function renderList(value) {
  const lines = [`${value.installed.length} managed skill(s) in ${value.root}`]
  for (const item of value.installed) {
    const where = item.repo ? `${item.repo}${item.commit ? `@${String(item.commit).slice(0, 12)}` : ''}` : (item.source ?? 'unknown')
    lines.push(`- ${item.name} — ${where}${item.present ? '' : ' (missing on disk)'}`)
  }
  if (value.unmanaged && value.unmanaged.length > 0) {
    lines.push(`Unmanaged on disk: ${value.unmanaged.map((item) => item.name).join(', ')}`)
  }
  return lines.join('\n')
}
