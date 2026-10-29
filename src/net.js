/**
 * Shared HTTP helper for every skill source. Node builtins only.
 * @module dsh-skill-market/net
 */

const DEFAULT_UA = 'dsh-skill-market/0.1 (+https://github.com/zhao1722676538-cmd/dsh-skill-market)'

/**
 * @param {{timeoutMs?: number, userAgent?: string, log?: (msg: string) => void}} [options]
 * @returns {(input: string | URL, init?: RequestInit & {timeoutMs?: number}) => Promise<Response>}
 */
export function createHttp(options = {}) {
  const defaultTimeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15000
  const userAgent = options.userAgent ?? DEFAULT_UA

  return async function http(input, init = {}) {
    const { timeoutMs: rawTimeout, headers, signal, ...rest } = init
    const timeout = Number.isFinite(rawTimeout) && rawTimeout > 0 ? rawTimeout : defaultTimeout
    const timeoutSignal = AbortSignal.timeout(timeout)
    const merged = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
    const url = typeof input === 'string' ? input : String(input)

    let response
    try {
      response = await fetch(url, {
        ...rest,
        redirect: rest.redirect ?? 'follow',
        headers: {
          'user-agent': userAgent,
          accept: 'application/json, text/plain, */*',
          ...headers,
        },
        signal: merged,
      })
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(`request timed out after ${timeout}ms: ${shortUrl(url)}`, { cause: err })
      }
      throw new Error(`request failed: ${shortUrl(url)}: ${err?.message ?? String(err)}`, { cause: err })
    }
    return response
  }
}

/**
 * GET/POST and JSON-decode, with a readable error for non-2xx responses.
 * @param {(input: string | URL, init?: RequestInit & {timeoutMs?: number}) => Promise<Response>} http
 */
export async function httpJson(http, url, init = {}) {
  const response = await http(url, init)
  const text = await response.text()
  if (!response.ok) {
    const hint = response.status === 429 ? ' (rate limited)' : ''
    throw new Error(`HTTP ${response.status}${hint} from ${shortUrl(String(url))}: ${truncate(text, 200)}`)
  }
  if (text.trim() === '') return null
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`expected JSON from ${shortUrl(String(url))}, got: ${truncate(text, 200)}`)
  }
}

/**
 * GET and return text, with a readable error for non-2xx responses.
 * @param {(input: string | URL, init?: RequestInit & {timeoutMs?: number}) => Promise<Response>} http
 */
export async function httpText(http, url, init = {}) {
  const response = await http(url, init)
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from ${shortUrl(String(url))}: ${truncate(text, 200)}`)
  }
  return text
}

/** @param {string} text @param {number} max */
export function truncate(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** @param {string} raw */
export function shortUrl(raw) {
  try {
    const url = new URL(raw)
    return `${url.origin}${url.pathname}`
  } catch {
    return truncate(raw, 120)
  }
}
