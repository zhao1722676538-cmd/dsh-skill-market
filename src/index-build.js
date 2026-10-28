/**
 * Index builder: turn live marketplace searches into one static index document.
 *
 * Run it occasionally (a script, a cron job, a chat tool call) and every later
 * search is a local filter — no marketplace API, no GitHub token, no rate limit.
 * @module dsh-skill-market/index-build
 */

import { searchAll, dedupe } from './sources/index.js'
import { INDEX_VERSION, serializeIndex } from './index-store.js'

/**
 * @param {{
 *   queries: string[],
 *   sources?: string[],
 *   perSourceLimit?: number,
 *   deps: any,
 *   log?: (m: string) => void,
 *   onQuery?: (info: {query: string, count: number, ms: number}) => void,
 * }} options
 */
export async function buildIndex(options) {
  const queries = (options.queries ?? []).map((query) => String(query).trim()).filter(Boolean)
  if (queries.length === 0) throw new Error('at least one query is required to build an index')
  const sources = (options.sources ?? []).map((source) => String(source).trim()).filter(Boolean)
  const perSourceLimit = Number.isFinite(options.perSourceLimit)
    ? Math.max(1, Math.min(50, Math.trunc(options.perSourceLimit)))
    : 10
  const log = options.log ?? (() => {})

  /** @type {import('./types.js').SkillEntry[]} */
  let collected = []
  /** @type {Record<string, any>[]} */
  const reports = []

  for (const query of queries) {
    const started = Date.now()
    try {
      const outcome = await searchAll(
        { query, sources: sources.length > 0 ? sources : undefined, limit: perSourceLimit },
        options.deps,
      )
      const items = outcome.items.slice(0, perSourceLimit * 2)
      collected = dedupe([...collected, ...items])
      reports.push({ query, ok: true, count: items.length, ms: Date.now() - started, sources: outcome.reports })
      log(`built ${query}: ${items.length} entries`)
      options.onQuery?.({ query, count: items.length, ms: Date.now() - started })
    } catch (err) {
      const message = err?.message ?? String(err)
      reports.push({ query, ok: false, error: message, count: 0, ms: Date.now() - started })
      log(`build ${query} failed: ${message}`)
      options.onQuery?.({ query, count: 0, ms: Date.now() - started })
    }
  }

  const usedSources = sources.length > 0
    ? sources
    : [...new Set(reports.flatMap((report) => (report.sources ?? []).filter((item) => item.ok).map((item) => item.source)))]

  return {
    version: INDEX_VERSION,
    generatedAt: new Date().toISOString(),
    queries,
    sources: usedSources,
    skills: collected,
    reports,
  }
}

/**
 * Build and serialize in one call — what the CLI script and the tool do.
 * @param {{} & Parameters<typeof buildIndex>[0]} options
 */
export async function buildIndexDocument(options) {
  const index = await buildIndex(options)
  return { index, text: serializeIndex(index) }
}

export default { buildIndex, buildIndexDocument }
