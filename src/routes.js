/**
 * Host HTTP routes backing the client panel. Registered on the webServer
 * service: `register({ kind: 'exact'|'prefix', path, handler(req, res) })`.
 * @module dsh-skill-market/routes
 */

const MAX_BODY_BYTES = 1024 * 1024

/**
 * @param {{
 *   server: { register(route: {kind: 'exact' | 'prefix', path: string, handler: (req: any, res: any) => void | Promise<void>}): unknown },
 *   settings: { routePrefix: string },
 *   service: any,
 *   log?: (msg: string) => void,
 *   warn?: (msg: string) => void,
 * }} options
 * @returns {() => void} disposer removing every registered route
 */
export function mountRoutes(options) {
  const { server, settings, service, warn = () => {} } = options
  const prefix = normalizePrefix(settings.routePrefix)
  /** @type {(() => void)[]} */
  const disposers = []

  /** @param {string} suffix @param {(body: any, req: any) => Promise<any>} handler */
  const route = (suffix, handler) => {
    const path = `${prefix}${suffix}`
    const off = server.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        try {
          assertSameOrigin(req)
          const body = await readJsonBody(req)
          const payload = await handler(body, req)
          writeJson(res, 200, payload)
        } catch (err) {
          const status = Number.isInteger(err?.status) ? err.status : 500
          if (status >= 500) warn(`[skill-market] route ${path} failed: ${err?.stack ?? err}`)
          writeJson(res, status, { error: err?.message ?? String(err) })
        }
      },
    })
    // webServer.register returns a disposer in 0.2.x; tolerate a void return.
    if (typeof off === 'function') disposers.push(off)
  }

  route('/search', async (body, req) => {
    requireMethod(req, ['POST'])
    const query = typeof body?.query === 'string' ? body.query.trim() : ''
    if (query === '') throw httpError(400, 'query is required')
    const outcome = await service.search({ query, sources: body?.sources, limit: body?.limit, refresh: body?.refresh })
    return {
      entries: outcome.items,
      reports: outcome.reports,
      mode: outcome.mode ?? 'live',
      index: outcome.index ?? service.indexMeta?.(),
      failures: outcome.reports.filter((report) => !report.ok).map((report) => ({ source: report.source, error: report.error })),
    }
  })

  route('/index', async (body, req) => {
    requireMethod(req, ['GET', 'POST'])
    const meta = service.indexMeta?.() ?? { indexes: 0, mode: 'live' }
    if (body?.refresh !== true) return meta
    const loaded = await service.loadIndex({ refresh: true })
    return {
      ...meta,
      loaded: {
        entries: loaded.entries.length,
        reports: loaded.reports,
      },
    }
  })

  route('/index/build', async (body, req) => {
    requireMethod(req, ['POST'])
    const queries = Array.isArray(body?.queries) ? body.queries : [body?.query]
    const result = await service.buildIndexDocument({
      queries,
      sources: body?.sources,
      limit: body?.limit,
      outPath: body?.outPath,
    })
    return {
      path: result.path,
      count: result.count,
      bytes: result.bytes,
      reports: result.reports.map((report) => ({
        query: report.query,
        ok: report.ok === true,
        count: report.count ?? 0,
        error: report.error,
      })),
    }
  })

  route('/installed', async (body, req) => {
    requireMethod(req, ['GET', 'POST'])
    const listing = await service.list(true)
    return {
      root: listing.root,
      installed: listing.installed.map((item) => ({
        id: item.name,
        name: item.name,
        source: item.source ?? 'unknown',
        revision: item.commit ?? null,
        repo: item.repo ?? null,
        dir: item.dir,
        present: item.present !== false,
      })),
      unmanaged: listing.unmanaged,
    }
  })

  route('/install', async (body, req) => {
    requireMethod(req, ['POST'])
    const entry = await service.resolveEntry(body?.entry ?? body ?? {})
    const result = await service.install(entry, { overwrite: body?.overwrite === true })
    return {
      skill: {
        name: result.name,
        dir: result.dir,
        source: result.source ?? entry.source,
        repo: result.repo ?? entry.repo ?? null,
        commit: result.commit ?? null,
      },
      fresh: result.refreshed === true,
      hint: service.installHint(result),
    }
  })

  route('/uninstall', async (body, req) => {
    requireMethod(req, ['POST'])
    if (typeof body?.name !== 'string' || body.name.trim() === '') throw httpError(400, 'name is required')
    const name = body.name.trim()
    const result = await service.uninstall(name, { force: body?.force === true })
    if (result?.ok === false) throw httpError(409, result.reason ?? 'uninstall refused')
    return { removed: result?.name ?? name, fresh: result?.refreshed === true }
  })

  route('/sources', async (body, req) => {
    requireMethod(req, ['GET', 'POST'])
    return { sources: service.sourcesMeta() }
  })

  return () => {
    for (const off of disposers) {
      try {
        off()
      } catch {
        /* disposal is best-effort */
      }
    }
    disposers.length = 0
  }
}

/** @param {string} raw */
function normalizePrefix(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return '/dsh-skill-market'
  const withSlash = value.startsWith('/') ? value : `/${value}`
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

/**
 * Same-origin gate: a browser page on the harness origin may call these routes,
 * a foreign origin may not. Requests without Origin are only accepted when the
 * browser says the navigation is same-origin/none (or says nothing at all).
 * @param {any} req
 */
function assertSameOrigin(req) {
  const origin = req?.headers?.origin
  const host = req?.headers?.host
  if (typeof origin === 'string' && origin !== '') {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      throw httpError(403, 'malformed Origin header')
    }
    if (host && originHost !== host) throw httpError(403, 'cross-origin request rejected')
    return
  }
  const site = req?.headers?.['sec-fetch-site']
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') {
    throw httpError(403, `cross-origin request rejected (sec-fetch-site: ${site})`)
  }
}

/** @param {any} req @param {string[]} allowed */
function requireMethod(req, allowed) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (!allowed.includes(method)) throw httpError(405, `method ${method} not allowed`)
}

/** @param {any} req @returns {Promise<any>} */
async function readJsonBody(req) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method === 'GET') return {}
  const contentType = String(req?.headers?.['content-type'] ?? '')
  if (!contentType.includes('application/json')) {
    throw httpError(415, 'content-type must be application/json')
  }
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw httpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw httpError(400, 'request body is not valid JSON')
  }
}

/** @param {any} res @param {number} status @param {any} payload */
function writeJson(res, status, payload) {
  const body = JSON.stringify(payload ?? null)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

/** @param {number} status @param {string} message */
function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}
