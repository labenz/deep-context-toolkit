#!/usr/bin/env bun

import { dns, fetch as bunFetch } from 'bun'

export type RequestOptions = {
  method?: string
  url: string
  headers?: Record<string, string>
  body?: unknown
  timeoutMs?: number
  retries?: number
  binary?: boolean
  logOnError?: boolean
  preconnect?: boolean | string
  prefetchDNS?: boolean
  verbose?: boolean | 'curl'
}

export type HttpResponse<T = unknown> = {
  status: number
  headers: Headers
  data: T
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function request<T = unknown>(opts: RequestOptions): Promise<HttpResponse<T>> {
  const method = (opts.method ?? 'GET').toUpperCase()
  const timeoutMs = opts.timeoutMs ?? 30_000
  const retries = opts.retries ?? 2
  const headers: Record<string, string> = {
    'User-Agent': `ai_cli/${Bun.env.npm_package_name ?? 'tools'}@${Bun.env.npm_package_version ?? '0.0.0'}`,
    ...(opts.headers ?? {}),
  }

  if (Bun.env.AI_CLI_DEBUG_HTTP === '1') {
    try { console.error(`[http] ${method} ${opts.url}`) } catch {}
  }

  // Bun HTTP niceties: DNS prefetch and preconnect
  try {
    const u = new URL(opts.url)
    const origin = `${u.protocol}//${u.host}`
    if (opts.prefetchDNS === true && u.hostname) {
      const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80)
      if (Number.isFinite(port)) {
        try { dns.prefetch(u.hostname, port) } catch {}
      }
    }
    if (opts.preconnect) {
      if (opts.preconnect === true) bunFetch.preconnect(origin)
      else if (typeof opts.preconnect === 'string') bunFetch.preconnect(String(opts.preconnect))
    }
  } catch {}

  const makeFetch = async () => {
    try {
      const init: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      }
      if (opts.verbose !== undefined) (init as unknown as { verbose?: boolean | 'curl' }).verbose = opts.verbose
      let body: string | Uint8Array | undefined
      if (opts.body !== undefined) {
        if (typeof opts.body === 'string' || opts.body instanceof Uint8Array) {
          body = opts.body
        } else {
          headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
          body = JSON.stringify(opts.body)
        }
        ;(init as unknown as { body?: string | Uint8Array }).body = body
      }
      try { if (opts.verbose) console.error(`[fetch] ${method} ${opts.url}`) } catch {}
      const res = await fetch(opts.url, init)
      return res
    } catch (err) {
      throw err
    }
  }

  let attempt = 0
  // retry on 429, 502, 503, 504
  const retryStatuses = new Set([429, 502, 503, 504])
  let lastError: unknown
  while (attempt <= retries) {
    try {
      const res = await makeFetch()
      const contentType = res.headers.get('content-type') ?? ''
      let data: unknown
      if (opts.binary === true) {
        const buf = await res.arrayBuffer()
        data = new Uint8Array(buf)
      } else if (contentType.includes('application/json')) {
        data = await res.json()
      } else {
        data = await res.text()
      }
      if (!res.ok) {
        if (retryStatuses.has(res.status) && attempt < retries) {
          attempt += 1
          const backoff = attempt === 1 ? 200 : 800
          await wait(backoff)
          continue
        }
        const snippet = typeof data === 'string' ? data.slice(0, 256) : JSON.stringify(data).slice(0, 256)
        if (opts.logOnError !== false) console.error(`HTTP ${res.status} ${opts.url} :: ${snippet}`)
        const error: Error & { status?: number; code?: number; data?: unknown } = new Error(
          `Request failed with status ${res.status}`,
        )
        error.status = res.status
        error.code = 70
        error.data = data
        throw error
      }
      return { status: res.status, headers: res.headers, data: data as T }
    } catch (err) {
      lastError = err
      // AbortError or network error
      if (attempt < retries) {
        attempt += 1
        const backoff = attempt === 1 ? 200 : 800
        await wait(backoff)
        continue
      }
      throw err
    }
  }
  // Should be unreachable
  throw lastError ?? new Error('Unknown HTTP error')
}


