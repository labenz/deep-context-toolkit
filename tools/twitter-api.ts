#!/usr/bin/env bun
/**
 * twitter-api.ts — X API v2 client (official endpoints, OAuth 1.0a / Bearer).
 *
 * Talks to the official X API v2: user-context endpoints via OAuth 1.0a,
 * app-only endpoints via Bearer. (deep-context's live Twitter extraction calls
 * this tool's `user-tweets` command — there is no scraping/cookie path.)
 *
 * Auth (in tools/.env):
 *   X_API_CONSUMER_KEY            (a.k.a. API Key)
 *   X_API_CONSUMER_SECRET         (a.k.a. API Secret)
 *   X_API_BEARER_TOKEN            (App-only — works for public tweet lookups)
 *   X_API_ACCESS_TOKEN            (User OAuth 1.0a — required for /users/me, likes)
 *   X_API_ACCESS_TOKEN_SECRET     (User OAuth 1.0a)
 *
 * Access Token + Secret are generated with one click on the same X Developer
 * Portal page where Consumer Key/Secret live ("Keys and tokens" → "Access
 * Token and Secret" → Generate). They are NOT the Bearer Token.
 *
 * Subcommands:
 *   whoami                              GET /2/users/me  (user context)
 *   user-tweets [--user-id|--username] [--limit N] [--all]
 *                                       GET /2/users/:id/tweets  (your own timeline;
 *                                       retweets excluded unless --include-retweets)
 *   liked-tweets [--user-id|--username] [--limit N] [--all]
 *                                       GET /2/users/:id/liked_tweets
 *                                       (user context, like.read scope)
 *   tweet <id>                          GET /2/tweets/:id  (bearer OK)
 *   user <username>                     GET /2/users/by/username/:u  (bearer OK)
 *   post <text> [--reply-to ID] [--quote-of ID] [--dry-run]   POST /2/tweets
 *   delete-tweet <id>                   DELETE /2/tweets/:id  (user context)
 *   dm <@handle|user_id> <text>         POST /2/dm_conversations/.../messages
 *   trends                              GET /2/users/personalized_trends
 *   stream-rules <list|add|delete>      Manage filtered-stream rules
 *   env-check                           Print which auth modes are configured
 *
 * Output:
 *   Default: JSON to stdout (one object — full payload incl. pagination meta).
 *   --md flag on tweet-returning commands: human-readable Markdown summary.
 *   --out PATH: write output to file instead of stdout.
 *
 * Rate limits (X API v2, per docs as of Apr 2026):
 *   /users/:id/liked_tweets — 75 / 15 min (user context).  Up to 100/page.
 */

import { createHmac, randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { load_env } from './_lib/env'
import { parse_flags, print_help, type ParsedArgs } from './_lib/cli'

const API_BASE = 'https://api.x.com/2'

// ─────────────────────────────────────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────────────────────────────────────

type Creds = {
  consumerKey?: string
  consumerSecret?: string
  bearerToken?: string
  accessToken?: string
  accessTokenSecret?: string
}

function loadCreds(env: Record<string, string>): Creds {
  return {
    consumerKey: env.X_API_CONSUMER_KEY || undefined,
    consumerSecret: env.X_API_CONSUMER_SECRET || undefined,
    bearerToken: env.X_API_BEARER_TOKEN || undefined,
    accessToken: env.X_API_ACCESS_TOKEN || undefined,
    accessTokenSecret: env.X_API_ACCESS_TOKEN_SECRET || undefined,
  }
}

function hasUserContext(c: Creds): boolean {
  return !!(c.consumerKey && c.consumerSecret && c.accessToken && c.accessTokenSecret)
}

function hasBearer(c: Creds): boolean {
  return !!c.bearerToken
}

function rfc3986(s: string): string {
  // OAuth 1.0a uses RFC 3986 percent-encoding (encodeURIComponent doesn't
  // encode ! * ' ( ); RFC 3986 does).
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  )
}

function oauth1Header(
  method: string,
  url: string,
  queryParams: Record<string, string>,
  c: Required<Pick<Creds, 'consumerKey' | 'consumerSecret' | 'accessToken' | 'accessTokenSecret'>>,
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: c.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: c.accessToken,
    oauth_version: '1.0',
  }
  // Combine query params + oauth params, then sort, then urlencode for sig base
  const all: Record<string, string> = { ...queryParams, ...oauthParams }
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(all[k]!)}`)
    .join('&')
  const baseString = [method.toUpperCase(), rfc3986(url), rfc3986(paramString)].join('&')
  const signingKey = `${rfc3986(c.consumerSecret)}&${rfc3986(c.accessTokenSecret)}`
  const signature = createHmac('sha1', signingKey).update(baseString).digest('base64')
  oauthParams.oauth_signature = signature

  return (
    'OAuth ' +
    Object.keys(oauthParams)
      .sort()
      .map((k) => `${rfc3986(k)}="${rfc3986(oauthParams[k]!)}"`)
      .join(', ')
  )
}

type AuthMode = 'user' | 'bearer'

async function apiCall(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  query: Record<string, string | number | undefined>,
  body: unknown,
  creds: Creds,
  mode: AuthMode,
): Promise<any> {
  const cleanQuery: Record<string, string> = {}
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === '') continue
    cleanQuery[k] = String(v)
  }
  const url = `${API_BASE}${path}`
  const qs = new URLSearchParams(cleanQuery).toString()
  const fullUrl = qs ? `${url}?${qs}` : url

  const headers: Record<string, string> = {
    'User-Agent': 'deep-context-toolkit/1.0',
    Accept: 'application/json',
  }

  if (mode === 'user') {
    if (!hasUserContext(creds)) {
      throw new Error(
        'User-context endpoint requires X_API_CONSUMER_KEY/SECRET and ' +
          'X_API_ACCESS_TOKEN/SECRET in tools/.env. Generate Access Token + ' +
          'Secret in your X Developer Portal "Keys and tokens" page.',
      )
    }
    // OAuth 1.0a signature base string includes query params but NOT JSON body.
    headers.Authorization = oauth1Header(
      method,
      url,
      cleanQuery,
      {
        consumerKey: creds.consumerKey!,
        consumerSecret: creds.consumerSecret!,
        accessToken: creds.accessToken!,
        accessTokenSecret: creds.accessTokenSecret!,
      },
    )
  } else {
    if (!hasBearer(creds)) {
      throw new Error('Bearer endpoint requires X_API_BEARER_TOKEN in tools/.env.')
    }
    headers.Authorization = `Bearer ${creds.bearerToken}`
  }

  const init: RequestInit = { method, headers }
  if (body !== undefined && body !== null) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const res = await fetch(fullUrl, init)
  const text = await res.text()
  if (!res.ok) {
    const reset = res.headers.get('x-rate-limit-reset')
    const remaining = res.headers.get('x-rate-limit-remaining')
    const rateInfo =
      reset || remaining
        ? ` (rate-limit remaining=${remaining ?? '?'}, reset=${reset ?? '?'})`
        : ''
    const hint =
      res.status === 403
        ? '\nHint: 403 on a write endpoint usually means the Access Token was ' +
          'generated before the app had write/DM scope. Regenerate at ' +
          'https://developer.x.com/en/portal/dashboard → Keys and tokens → ' +
          '"Access Token and Secret" → Regenerate.'
        : ''
    throw new Error(
      `X API ${res.status} ${res.statusText}${rateInfo}${hint}\n${text.slice(0, 2000)}`,
    )
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`Failed to parse X API response: ${e}\nBody: ${text.slice(0, 1000)}`)
  }
}

function apiGet(
  path: string,
  query: Record<string, string | number | undefined>,
  creds: Creds,
  mode: AuthMode,
): Promise<any> {
  return apiCall('GET', path, query, undefined, creds, mode)
}

function apiPost(
  path: string,
  body: unknown,
  creds: Creds,
  mode: AuthMode,
): Promise<any> {
  return apiCall('POST', path, {}, body, creds, mode)
}

function apiDelete(
  path: string,
  creds: Creds,
  mode: AuthMode,
): Promise<any> {
  return apiCall('DELETE', path, {}, undefined, creds, mode)
}

// ─────────────────────────────────────────────────────────────────────────────
// Default field/expansion sets — request rich payloads by default
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_TWEET_FIELDS = [
  'id',
  'text',
  'created_at',
  'author_id',
  'conversation_id',
  'in_reply_to_user_id',
  'lang',
  'public_metrics',
  'possibly_sensitive',
  'reply_settings',
  'source',
  'entities',
  'attachments',
  'referenced_tweets',
  'note_tweet',
].join(',')

const DEFAULT_USER_FIELDS = [
  'id',
  'name',
  'username',
  'created_at',
  'description',
  'verified',
  'verified_type',
  'profile_image_url',
  'public_metrics',
  'url',
  'location',
].join(',')

const DEFAULT_MEDIA_FIELDS = [
  'media_key',
  'type',
  'url',
  'preview_image_url',
  'alt_text',
  'duration_ms',
  'public_metrics',
  'width',
  'height',
].join(',')

const DEFAULT_EXPANSIONS = [
  'author_id',
  'attachments.media_keys',
  'referenced_tweets.id',
  'referenced_tweets.id.author_id',
  'in_reply_to_user_id',
].join(',')

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

function flagString(flags: ParsedArgs, key: string): string | undefined {
  const v = flags[key]
  if (typeof v === 'string') return v
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0]
  return undefined
}

function flagNumber(flags: ParsedArgs, key: string): number | undefined {
  const s = flagString(flags, key)
  if (s === undefined) return undefined
  const n = Number(s)
  if (!Number.isFinite(n)) {
    throw new Error(`--${key} must be a number, got "${s}"`)
  }
  return n
}

function flagBool(flags: ParsedArgs, key: string): boolean {
  return flags[key] === true
}

function emit(value: any, outPath: string | undefined): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  if (outPath) {
    writeFileSync(outPath, text)
    console.error(`Wrote ${text.length} bytes to ${outPath}`)
  } else {
    process.stdout.write(text)
    if (!text.endsWith('\n')) process.stdout.write('\n')
  }
}

async function cmdWhoami(_argv: string[], creds: Creds): Promise<void> {
  const r = await apiGet('/users/me', { 'user.fields': DEFAULT_USER_FIELDS }, creds, 'user')
  emit(r, undefined)
}

async function resolveUserId(
  flags: ParsedArgs,
  creds: Creds,
): Promise<{ id: string; username: string | undefined }> {
  const explicitId = flagString(flags, 'user-id')
  if (explicitId) return { id: explicitId, username: undefined }
  const username = flagString(flags, 'username')
  if (username) {
    const handle = username.startsWith('@') ? username.slice(1) : username
    const r = await apiGet(
      `/users/by/username/${encodeURIComponent(handle)}`,
      { 'user.fields': 'id,username' },
      creds,
      hasBearer(creds) ? 'bearer' : 'user',
    )
    const id = r?.data?.id
    if (!id) throw new Error(`Could not resolve user @${handle}: ${JSON.stringify(r)}`)
    return { id, username: r.data.username }
  }
  // Default: authenticated user
  const me = await apiGet('/users/me', { 'user.fields': 'id,username' }, creds, 'user')
  const id = me?.data?.id
  if (!id) throw new Error(`Could not resolve authenticated user: ${JSON.stringify(me)}`)
  return { id, username: me.data.username }
}

async function cmdLikedTweets(argv: string[], creds: Creds): Promise<void> {
  const flags = parse_flags(argv, {
    'user-id': { type: 'string' },
    username: { type: 'string' },
    limit: { type: 'string', alias: 'l' },
    'page-size': { type: 'string' },
    all: { type: 'boolean' },
    pages: { type: 'string' },
    hours: { type: 'string' },
    since: { type: 'string' },
    out: { type: 'string' },
    md: { type: 'boolean' },
  })

  const { id: userId, username } = await resolveUserId(flags, creds)
  // Pagination ceiling: --all > --pages > --limit-derived
  // Default --limit raised when --hours/--since is set (likes can be dense).
  const hours = flagNumber(flags, 'hours')
  const sinceStr = flagString(flags, 'since')
  const cutoffMs =
    sinceStr !== undefined
      ? Date.parse(sinceStr)
      : hours !== undefined
        ? Date.now() - hours * 3600_000
        : undefined
  if (cutoffMs !== undefined && Number.isNaN(cutoffMs)) {
    throw new Error(`--since must be ISO 8601 (e.g. 2026-05-22T00:00:00Z), got "${sinceStr}"`)
  }

  const limit = flagNumber(flags, 'limit') ?? (cutoffMs !== undefined ? 1000 : 100)
  const pageSize = Math.min(100, flagNumber(flags, 'page-size') ?? 100)
  const maxPages = flagBool(flags, 'all') || cutoffMs !== undefined
    ? Infinity
    : (flagNumber(flags, 'pages') ?? Math.ceil(limit / pageSize))
  const out = flagString(flags, 'out')

  const collected: any[] = []
  const collectedIncludes = {
    users: new Map<string, any>(),
    tweets: new Map<string, any>(),
    media: new Map<string, any>(),
  }
  let nextToken: string | undefined
  let pages = 0
  let stoppedByCutoff = false

  while (pages < maxPages && collected.length < limit && !stoppedByCutoff) {
    const remaining = limit - collected.length
    const thisPage = Math.min(pageSize, Math.max(5, remaining))
    const r = await apiGet(
      `/users/${userId}/liked_tweets`,
      {
        max_results: thisPage,
        pagination_token: nextToken,
        'tweet.fields': DEFAULT_TWEET_FIELDS,
        'user.fields': DEFAULT_USER_FIELDS,
        'media.fields': DEFAULT_MEDIA_FIELDS,
        expansions: DEFAULT_EXPANSIONS,
      },
      creds,
      'user',
    )

    const data: any[] = Array.isArray(r?.data) ? r.data : []
    // The X liked_tweets endpoint returns "most recently liked first" — but the
    // tweet's own created_at can be older than the like timestamp. Filter on
    // created_at since that's what's exposed; in practice for a 48h window
    // this matches "recent liked posts" closely enough.
    for (const t of data) {
      if (collected.length >= limit) break
      if (cutoffMs !== undefined && t.created_at) {
        const ts = Date.parse(t.created_at)
        if (Number.isFinite(ts) && ts < cutoffMs) {
          stoppedByCutoff = true
          continue
        }
      }
      collected.push(t)
    }
    for (const u of r?.includes?.users ?? []) collectedIncludes.users.set(u.id, u)
    for (const t of r?.includes?.tweets ?? []) collectedIncludes.tweets.set(t.id, t)
    for (const m of r?.includes?.media ?? []) collectedIncludes.media.set(m.media_key, m)

    nextToken = r?.meta?.next_token
    pages += 1
    if (!nextToken || data.length === 0) break

    process.stderr.write(
      `  page ${pages}: ${data.length} tweets (cumulative ${collected.length}); next_token=${nextToken ? 'yes' : 'no'}${stoppedByCutoff ? ' (cutoff reached)' : ''}\n`,
    )
  }

  process.stderr.write(
    `Fetched ${collected.length} liked tweets across ${pages} page(s) for user ${username ? `@${username}` : userId}.\n`,
  )

  const payload = {
    user: { id: userId, username },
    data: collected,
    includes: {
      users: [...collectedIncludes.users.values()],
      tweets: [...collectedIncludes.tweets.values()],
      media: [...collectedIncludes.media.values()],
    },
    meta: {
      result_count: collected.length,
      pages_fetched: pages,
      next_token: nextToken ?? null,
    },
  }

  if (flagBool(flags, 'md')) {
    emit(renderLikedTweetsMarkdown(payload), out)
  } else {
    emit(payload, out)
  }
}

// Fetch a user's own timeline (GET /2/users/:id/tweets). Defaults to the
// authenticated user and excludes retweets (we only want authored tweets).
// Emits the same {user, data, includes, meta} payload shape as liked-tweets.
async function cmdUserTweets(argv: string[], creds: Creds): Promise<void> {
  const flags = parse_flags(argv, {
    'user-id': { type: 'string' },
    username: { type: 'string' },
    limit: { type: 'string', alias: 'l' },
    'page-size': { type: 'string' },
    all: { type: 'boolean' },
    pages: { type: 'string' },
    'include-retweets': { type: 'boolean' },
    out: { type: 'string' },
  })

  const { id: userId, username } = await resolveUserId(flags, creds)
  const limit = flagNumber(flags, 'limit') ?? 200
  const pageSize = Math.min(100, flagNumber(flags, 'page-size') ?? 100)
  const maxPages = flagBool(flags, 'all')
    ? Infinity
    : (flagNumber(flags, 'pages') ?? Math.ceil(limit / pageSize))
  const out = flagString(flags, 'out')
  const exclude = flagBool(flags, 'include-retweets') ? undefined : 'retweets'

  const collected: any[] = []
  const collectedIncludes = {
    users: new Map<string, any>(),
    tweets: new Map<string, any>(),
    media: new Map<string, any>(),
  }
  let nextToken: string | undefined
  let pages = 0

  while (pages < maxPages && collected.length < limit) {
    const remaining = limit - collected.length
    const thisPage = Math.min(pageSize, Math.max(5, remaining))
    const r = await apiGet(
      `/users/${userId}/tweets`,
      {
        max_results: thisPage,
        pagination_token: nextToken,
        exclude,
        'tweet.fields': DEFAULT_TWEET_FIELDS,
        'user.fields': DEFAULT_USER_FIELDS,
        'media.fields': DEFAULT_MEDIA_FIELDS,
        expansions: DEFAULT_EXPANSIONS,
      },
      creds,
      hasUserContext(creds) ? 'user' : 'bearer',
    )

    const data: any[] = Array.isArray(r?.data) ? r.data : []
    for (const t of data) {
      if (collected.length >= limit) break
      collected.push(t)
    }
    for (const u of r?.includes?.users ?? []) collectedIncludes.users.set(u.id, u)
    for (const t of r?.includes?.tweets ?? []) collectedIncludes.tweets.set(t.id, t)
    for (const m of r?.includes?.media ?? []) collectedIncludes.media.set(m.media_key, m)

    nextToken = r?.meta?.next_token
    pages += 1
    if (!nextToken || data.length === 0) break

    process.stderr.write(
      `  page ${pages}: ${data.length} tweets (cumulative ${collected.length}); next_token=${nextToken ? 'yes' : 'no'}\n`,
    )
  }

  process.stderr.write(
    `Fetched ${collected.length} tweets across ${pages} page(s) for user ${username ? `@${username}` : userId}.\n`,
  )

  emit(
    {
      user: { id: userId, username },
      data: collected,
      includes: {
        users: [...collectedIncludes.users.values()],
        tweets: [...collectedIncludes.tweets.values()],
        media: [...collectedIncludes.media.values()],
      },
      meta: {
        result_count: collected.length,
        pages_fetched: pages,
        next_token: nextToken ?? null,
      },
    },
    out,
  )
}

function renderLikedTweetsMarkdown(payload: {
  user: { id: string; username: string | undefined }
  data: any[]
  includes: { users: any[]; tweets: any[]; media: any[] }
  meta: any
}): string {
  const userById = new Map<string, any>(payload.includes.users.map((u) => [u.id, u]))
  const mediaByKey = new Map<string, any>(payload.includes.media.map((m) => [m.media_key, m]))
  const lines: string[] = []
  lines.push(
    `# Liked tweets for ${payload.user.username ? `@${payload.user.username}` : payload.user.id}`,
  )
  lines.push('')
  lines.push(
    `${payload.meta.result_count} tweets, ${payload.meta.pages_fetched} page(s). next_token: ${payload.meta.next_token ?? '(none)'}`,
  )
  lines.push('')
  for (const t of payload.data) {
    const author = userById.get(t.author_id)
    const handle = author?.username ?? t.author_id
    const m = t.public_metrics ?? {}
    lines.push(`## @${handle} — ${t.created_at ?? ''}`)
    lines.push('')
    lines.push(t.text ?? '')
    lines.push('')
    const stats: string[] = []
    if (m.like_count !== undefined) stats.push(`${m.like_count} ❤`)
    if (m.retweet_count !== undefined) stats.push(`${m.retweet_count} 🔁`)
    if (m.reply_count !== undefined) stats.push(`${m.reply_count} 💬`)
    if (m.quote_count !== undefined) stats.push(`${m.quote_count} 💭`)
    if (m.impression_count !== undefined) stats.push(`${m.impression_count} 👁`)
    if (m.bookmark_count !== undefined) stats.push(`${m.bookmark_count} 🔖`)
    if (stats.length) lines.push(`*${stats.join(' · ')}*`)
    const mediaKeys: string[] = t.attachments?.media_keys ?? []
    for (const k of mediaKeys) {
      const med = mediaByKey.get(k)
      if (!med) continue
      const link = med.url || med.preview_image_url
      if (link) lines.push(`![${med.type ?? 'media'}](${link})`)
    }
    lines.push(`https://x.com/${handle}/status/${t.id}`)
    lines.push('')
  }
  return lines.join('\n')
}

async function cmdTweet(argv: string[], creds: Creds): Promise<void> {
  const flags = parse_flags(argv, { out: { type: 'string' } })
  const id = flags._[0]
  if (!id) throw new Error('Usage: twitter-api.ts tweet <id>')
  const mode: AuthMode = hasBearer(creds) ? 'bearer' : 'user'
  const r = await apiGet(
    `/tweets/${encodeURIComponent(id)}`,
    {
      'tweet.fields': DEFAULT_TWEET_FIELDS,
      'user.fields': DEFAULT_USER_FIELDS,
      'media.fields': DEFAULT_MEDIA_FIELDS,
      expansions: DEFAULT_EXPANSIONS,
    },
    creds,
    mode,
  )
  emit(r, flagString(flags, 'out'))
}

async function cmdUser(argv: string[], creds: Creds): Promise<void> {
  const flags = parse_flags(argv, { out: { type: 'string' } })
  const handle = flags._[0]
  if (!handle) throw new Error('Usage: twitter-api.ts user <username>')
  const u = handle.startsWith('@') ? handle.slice(1) : handle
  const mode: AuthMode = hasBearer(creds) ? 'bearer' : 'user'
  const r = await apiGet(
    `/users/by/username/${encodeURIComponent(u)}`,
    { 'user.fields': DEFAULT_USER_FIELDS },
    creds,
    mode,
  )
  emit(r, flagString(flags, 'out'))
}

async function cmdPost(argv: string[], creds: Creds): Promise<void> {
  const flags = parse_flags(argv, {
    text: { type: 'string' },
    'reply-to': { type: 'string' },
    'quote-of': { type: 'string' },
    'dry-run': { type: 'boolean' },
  })
  const text = flagString(flags, 'text') ?? flags._.join(' ').trim()
  if (!text) {
    throw new Error('Usage: twitter-api.ts post <text>  OR  --text "..."')
  }
  const body: any = { text }
  const replyTo = flagString(flags, 'reply-to')
  if (replyTo) body.reply = { in_reply_to_tweet_id: replyTo }
  const quoteOf = flagString(flags, 'quote-of')
  if (quoteOf) body.quote_tweet_id = quoteOf

  if (flagBool(flags, 'dry-run')) {
    console.log('[dry-run] would POST /2/tweets with body:')
    console.log(JSON.stringify(body, null, 2))
    return
  }
  const r = await apiPost('/tweets', body, creds, 'user')
  emit(r, undefined)
  const id = r?.data?.id
  if (id) console.error(`Tweet posted: https://x.com/i/status/${id}`)
}

async function cmdDeleteTweet(argv: string[], creds: Creds): Promise<void> {
  const id = argv[0]
  if (!id) throw new Error('Usage: twitter-api.ts delete-tweet <id>')
  const r = await apiDelete(`/tweets/${encodeURIComponent(id)}`, creds, 'user')
  emit(r, undefined)
}

async function cmdDm(argv: string[], creds: Creds): Promise<void> {
  const flags = parse_flags(argv, {
    to: { type: 'string' },
    text: { type: 'string' },
    'dry-run': { type: 'boolean' },
  })
  const target = flagString(flags, 'to') ?? flags._[0]
  const text = flagString(flags, 'text') ?? flags._.slice(1).join(' ').trim()
  if (!target || !text) {
    throw new Error(
      'Usage: twitter-api.ts dm <@handle|user_id> <text>  OR  --to <id> --text "..."',
    )
  }
  // Resolve handle → numeric user_id if needed
  let userId = target
  if (!/^\d+$/.test(target)) {
    const handle = target.startsWith('@') ? target.slice(1) : target
    const r = await apiGet(
      `/users/by/username/${encodeURIComponent(handle)}`,
      { 'user.fields': 'id,username' },
      creds,
      hasBearer(creds) ? 'bearer' : 'user',
    )
    userId = r?.data?.id
    if (!userId) throw new Error(`Could not resolve @${handle}: ${JSON.stringify(r)}`)
    console.error(`Resolved @${handle} → ${userId}`)
  }

  const body = { text }
  if (flagBool(flags, 'dry-run')) {
    console.log(`[dry-run] would POST /2/dm_conversations/with/${userId}/messages with body:`)
    console.log(JSON.stringify(body, null, 2))
    return
  }
  const r = await apiPost(`/dm_conversations/with/${userId}/messages`, body, creds, 'user')
  emit(r, undefined)
}

// ─────────────────────────────────────────────────────────────────────────────
// Filtered stream rules (CRUD over /2/tweets/search/stream/rules)
// ─────────────────────────────────────────────────────────────────────────────

async function cmdStreamRules(argv: string[], creds: Creds): Promise<void> {
  const action = argv[0]
  if (!action || action === 'list') {
    const r = await apiGet('/tweets/search/stream/rules', {}, creds, 'bearer')
    emit(r, undefined)
    return
  }
  if (action === 'add') {
    // twitter-api.ts stream-rules add <tag> <query>
    //   tag = short identifier for management (e.g. "ai-keywords")
    //   query = the filter rule body (X operator syntax)
    const tag = argv[1]
    const query = argv.slice(2).join(' ')
    if (!tag || !query) {
      throw new Error('Usage: twitter-api.ts stream-rules add <tag> <query>')
    }
    const r = await apiPost(
      '/tweets/search/stream/rules',
      { add: [{ value: query, tag }] },
      creds,
      'bearer',
    )
    emit(r, undefined)
    return
  }
  if (action === 'delete') {
    // twitter-api.ts stream-rules delete <rule_id> [<rule_id> ...]
    const ids = argv.slice(1)
    if (ids.length === 0) {
      throw new Error('Usage: twitter-api.ts stream-rules delete <rule_id> [<rule_id> ...]')
    }
    const r = await apiPost(
      '/tweets/search/stream/rules',
      { delete: { ids } },
      creds,
      'bearer',
    )
    emit(r, undefined)
    return
  }
  if (action === 'delete-all') {
    // Convenience: nuke every active rule (asks for confirmation via flag).
    const flags = parse_flags(argv.slice(1), { yes: { type: 'boolean' } })
    if (!flagBool(flags, 'yes')) {
      console.error('Refusing without --yes. This will delete ALL active stream rules.')
      process.exit(1)
    }
    const list = await apiGet('/tweets/search/stream/rules', {}, creds, 'bearer')
    const ids = (list?.data ?? []).map((r: any) => r.id)
    if (ids.length === 0) {
      console.error('No rules to delete.')
      return
    }
    const r = await apiPost(
      '/tweets/search/stream/rules',
      { delete: { ids } },
      creds,
      'bearer',
    )
    emit(r, undefined)
    return
  }
  throw new Error(`Unknown stream-rules action: ${action}. Try list | add | delete | delete-all`)
}

async function cmdTrends(argv: string[], creds: Creds): Promise<void> {
  const flags = parse_flags(argv, { out: { type: 'string' } })
  // /2/users/personalized_trends — returns trends tailored to the
  // authenticated user. Tier: Premium User subscription. Endpoint controls
  // its own page size; we just ask for all available fields.
  const r = await apiGet(
    '/users/personalized_trends',
    { 'personalized_trend.fields': 'category,post_count,trend_name,trending_since' },
    creds,
    'user',
  )
  emit(r, flagString(flags, 'out'))
}

function cmdEnvCheck(creds: Creds): void {
  const mask = (v?: string) =>
    !v ? '(missing)' : v.length <= 8 ? '****' : `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`
  const lines = [
    `X_API_CONSUMER_KEY        : ${mask(creds.consumerKey)}`,
    `X_API_CONSUMER_SECRET     : ${mask(creds.consumerSecret)}`,
    `X_API_BEARER_TOKEN        : ${mask(creds.bearerToken)}`,
    `X_API_ACCESS_TOKEN        : ${mask(creds.accessToken)}`,
    `X_API_ACCESS_TOKEN_SECRET : ${mask(creds.accessTokenSecret)}`,
    '',
    `App-only (Bearer)      auth available : ${hasBearer(creds) ? 'yes' : 'no'}`,
    `User-context (OAuth 1) auth available : ${hasUserContext(creds) ? 'yes' : 'no'}`,
  ]
  if (!hasUserContext(creds)) {
    lines.push('')
    lines.push('To enable user-context endpoints (whoami, liked-tweets):')
    lines.push('  1. Open https://developer.x.com/en/portal/dashboard')
    lines.push('  2. Pick your app → "Keys and tokens" tab')
    lines.push('  3. Under "Access Token and Secret", click Generate')
    lines.push('  4. Add to tools/.env:')
    lines.push('       X_API_ACCESS_TOKEN=...')
    lines.push('       X_API_ACCESS_TOKEN_SECRET=...')
    lines.push('  5. Ensure your app has "Read" permissions (or higher).')
  }
  console.log(lines.join('\n'))
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────────

const HELP = [
  'twitter-api.ts — Official X API v2 client (OAuth 1.0a + Bearer).',
  '',
  'USAGE',
  '  twitter-api.ts <subcommand> [args] [options]',
  '',
  'SUBCOMMANDS',
  '  whoami                              GET /2/users/me  (user context)',
  '  liked-tweets [opts]                 GET /2/users/:id/liked_tweets  (user context)',
  '    --user-id ID                      (default: authenticated user)',
  '    --username @handle',
  '  user-tweets [opts]                  GET /2/users/:id/tweets  (your own timeline)',
  '    --username @handle  --user-id ID  (default: authenticated user)',
  '    --limit N  --page-size N  --all  --pages N',
  '    --include-retweets                (default: retweets excluded)',
  '    --hours N                         only tweets posted within last N hours',
  '    --since ISO                       only tweets created on/after this UTC timestamp',
  '    --limit N                         total tweets to fetch (default 100, or 1000 when --hours/--since)',
  '    --page-size N                     per-page (max 100, default 100)',
  '    --all                             follow pagination until exhausted (implied by --hours/--since)',
  '    --pages N                         cap on pages fetched',
  '    --md                              render as Markdown instead of JSON',
  '    --out PATH                        write to file',
  '  tweet <id>                          GET /2/tweets/:id  (bearer OK)',
  '  user <username>                     GET /2/users/by/username/:u  (bearer OK)',
  '  post <text> [--reply-to ID] [--quote-of ID] [--dry-run]',
  '                                      POST /2/tweets  (user context, tweet.write)',
  '  delete-tweet <id>                   DELETE /2/tweets/:id  (user context)',
  '  dm <@handle|user_id> <text> [--dry-run]',
  '                                      POST /2/dm_conversations/with/:id/messages',
  '                                      (user context, dm.write)',
  '  trends [--out PATH]                 GET /2/users/personalized_trends',
  '                                      (Premium User tier; returns trend_name +',
  '                                      post_count + category)',
  '  stream-rules list                   List active filtered-stream rules',
  '  stream-rules add <tag> <query>      Add a rule (tag = short identifier)',
  '  stream-rules delete <id> [<id>...]  Delete rule(s) by id',
  '  stream-rules delete-all --yes       Delete every active rule',
  '  env-check                           Show configured auth modes',
  '',
  'AUTH (tools/.env)',
  '  X_API_CONSUMER_KEY, X_API_CONSUMER_SECRET    (app credentials)',
  '  X_API_BEARER_TOKEN                            (app-only bearer)',
  '  X_API_ACCESS_TOKEN, X_API_ACCESS_TOKEN_SECRET (user OAuth 1.0a — required',
  '                                                 for liked-tweets, whoami)',
].join('\n')

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    print_help('twitter-api.ts', HELP)
    return
  }
  const env = await load_env()
  const creds = loadCreds(env)

  switch (cmd) {
    case 'whoami':
      await cmdWhoami(rest, creds)
      break
    case 'liked-tweets':
    case 'likes':
      await cmdLikedTweets(rest, creds)
      break
    case 'user-tweets':
    case 'timeline':
      await cmdUserTweets(rest, creds)
      break
    case 'tweet':
      await cmdTweet(rest, creds)
      break
    case 'user':
      await cmdUser(rest, creds)
      break
    case 'post':
    case 'tweet-post':
      await cmdPost(rest, creds)
      break
    case 'delete-tweet':
      await cmdDeleteTweet(rest, creds)
      break
    case 'dm':
    case 'dm-send':
      await cmdDm(rest, creds)
      break
    case 'trends':
    case 'personalized-trends':
      await cmdTrends(rest, creds)
      break
    case 'stream-rules':
      await cmdStreamRules(rest, creds)
      break
    case 'env-check':
    case 'env_check':
      cmdEnvCheck(creds)
      break
    default:
      console.error(`Unknown subcommand: ${cmd}`)
      console.error('Run `twitter-api.ts help` for usage.')
      process.exit(1)
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
