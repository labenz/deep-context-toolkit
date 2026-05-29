#!/usr/bin/env bun

// Slack CLI tool.
//
// This is a TypeScript migration of the AI CLI `tools/slack` tool.
// Key capabilities preserved:
// - Emit ALX-compatible Slack messages as NDJSON from:
//   - a Slack export directory (export-dir)
//   - the Slack Web API (fetch)
// - List/search/get Slack resources as Markdown or JSON
// - Download files by Slack file ID or URL
// - Refresh OAuth token (optional) and save SLACK_BOT_TOKEN into .env

export const name = 'slack'
export const description = 'Fetch Slack messages, channels, people, and files. Supports Slack export directories and Slack Web API fetch. Can emit ALX-compatible NDJSON for ingestion.'

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { print_help } from './_lib/cli'
import { type LoadedEnv, PROJECT_ROOT, load_env as shared_load_env } from './_lib/env'
import { read_stdin } from './_lib/io'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

type ExitCode = typeof ExitCode
const ExitCode = {
  SUCCESS: 0,
  GENERIC_UNKNOWN: 1,
  BAD_USAGE: 2,
  NOT_FOUND: 3,
  PERMISSION_DENIED: 4,
  DATA_VALIDATION: 6,
} as const

function die(msg: string, code: number = ExitCode.GENERIC_UNKNOWN): never {
  console.error(msg)
  process.exit(code)
}

function log_event(level: LogLevel, event: string, data: Record<string, unknown> = {}) {
  const cfg = String(Bun.env.AI_AST_LOG_LEVEL || process.env.AI_AST_LOG_LEVEL || 'info').toLowerCase()
  const ranks: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = (ranks[cfg as LogLevel] ?? 20)
  if (ranks[level] < min) return
  const payload = {
    ts: new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z'),
    level,
    event,
    ...data,
  }
  void Bun.write(Bun.stderr, `${JSON.stringify(payload)}\n`)
}

const ROOT_DIR = PROJECT_ROOT
const ENV_FILE = path.join(ROOT_DIR, '.env')
const BACKUP_DIR = path.join(ROOT_DIR, 'alx', 'backups', 'env')

// --- Env loading ------------------------------------------------------------

let _cached_env: LoadedEnv | null = null

function safe_split_key_value(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('#')) return null

  const eq_index = trimmed.indexOf('=')
  let key = ''
  let value = ''
  if (eq_index > 0) {
    key = trimmed.slice(0, eq_index).trim()
    value = trimmed.slice(eq_index + 1)
  } else {
    const colon_index = trimmed.indexOf(':')
    if (colon_index <= 0) return null
    const k = trimmed.slice(0, colon_index).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return null
    key = k
    value = trimmed.slice(colon_index + 1).trim()
  }

  if (key.startsWith('export ')) key = key.slice('export '.length).trim()

  const v = value.trim()
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    value = v.slice(1, -1)
  } else {
    value = v
  }

  if (!key) return null
  return [key, value]
}

async function read_env_file_optional(file_path: string): Promise<Record<string, string>> {
  try {
    const f = Bun.file(file_path)
    if (!(await f.exists())) return {}
    const raw = await f.text()
    const out: Record<string, string> = {}
    for (const line of raw.split(/\r?\n/)) {
      const pair = safe_split_key_value(line)
      if (!pair) continue
      const [k, v] = pair
      if (!(k in out)) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

async function load_env(): Promise<LoadedEnv> {
  if (_cached_env) return _cached_env

  const merged = await shared_load_env().catch(() => ({} as LoadedEnv))

  // Preserve AI CLI behavior: also consider cwd .env and cwd/alx/.env, but only
  // fill missing values (do not overwrite existing values).
  const cwd_env = await read_env_file_optional(path.resolve(process.cwd(), '.env'))
  const alx_env = await read_env_file_optional(path.resolve(process.cwd(), 'alx', '.env'))
  for (const extra of [cwd_env, alx_env]) {
    for (const [k, v] of Object.entries(extra)) {
      if (!(k in merged) || merged[k] === '') merged[k] = v
    }
  }

  _cached_env = merged
  return merged
}

function env_get(name: string): string | undefined {
  if (_cached_env && _cached_env[name]) return _cached_env[name]
  const from_process = process.env[name]
  if (typeof from_process === 'string' && from_process) return from_process
  const from_bun = (Bun.env as Record<string, string | undefined>)[name]
  if (typeof from_bun === 'string' && from_bun) return from_bun
  return 
}

// --- CLI -------------------------------------------------------------------

type ListTarget = 'channels' | 'chats' | 'people'

type GetTarget = 'channel' | 'chat' | 'thread'

type SearchTarget = 'channels' | 'chats' | 'people' | 'messages'

type ThreadsMode = 'full' | 'roots' | 'none'

type Args = {
  cmd: string

  dir?: string
  out?: string
  out_dir?: string

  channel?: string[]

  since?: string
  until?: string
  between?: string

  acl?: string
  acl_tag?: string[]

  token?: string
  do_refresh?: boolean

  list_target?: ListTarget
  types?: string[]
  limit?: number
  cursor?: string
  offset?: number
  json?: boolean

  get_target?: GetTarget
  name?: string
  thread_ts?: string

  search_target?: SearchTarget
  query?: string
  page?: number
  sort_dir?: 'asc' | 'desc'

  people_sub?: 'get'
  file_sub?: 'download'
  file_input?: string

  with_user?: string
  threads?: ThreadsMode
  workspace?: string

  send_to?: string
  send_text?: string
}

function usage(): string {
  return `
slack - Slack export and API helper

USAGE:
  slack export-dir --dir <path> [--since <ISO|epoch>] [--acl <hash>] [--acl-tag t]... [--out <file>]
  slack fetch --channel <name|id>... [--since <ISO|epoch>] [--acl <hash>] [--acl-tag t]... [--out <file>]
  slack auth --token <xoxb-...|xoxp-...>
  slack auth --refresh

  slack list channels|chats|people [--types t1,t2] [--limit N] [--cursor CUR] [--json]
  slack get channel <name|id> [--since ISO|epoch] [--until ISO|epoch] [--limit N] [--cursor CUR] [--offset N] [--json]
  slack get chat <@user|user_id|chat_id> [--since ISO|epoch] [--until ISO|epoch] [--limit N] [--cursor CUR] [--offset N] [--json]
  slack get thread --channel <name|id> --ts <thread_ts> [--limit N] [--cursor CUR] [--json]

  slack search channels|chats|people <query> [--limit N] [--cursor CUR] [--json]
  slack search messages <query> [--channel <name|id>...] [--limit N] [--cursor CUR] [--sort-dir asc|desc] [--json]

  slack people get <@user|user_id|email> [--json]
  slack file download <file_id|url> [--out PATH|--out-dir DIR] [--json]

  slack export messages [--channel <name|id> | --with <@user|user_id>] [--between YYYY-MM-DD..YYYY-MM-DD | --since ISO|epoch --until ISO|epoch]
                      [--threads full|roots|none] [--limit N] [--cursor CUR] [--json] [--out PATH]

  slack send (--to <@user|user_id|email> | --channel <name|id>) [--text MSG | <stdin>] [--workspace NAME] [--json]

OPTIONS:
  -h, --help
  --json
  --out, -o <file>
  --out-dir <dir>
  --limit, -l <n>
  --cursor <cursor>
  --since <ISO|epoch>
  --until <ISO|epoch>
  --between <YYYY-MM-DD..YYYY-MM-DD>
  --channel <name|id>...
  --types <t1,t2>
  --ts <thread_ts>
  --offset <n>
  --acl <hash>
  --acl-tag <tag>...
  --workspace, -w <name>     Select workspace (uses SLACK_BOT_TOKEN_<NAME>)

ENVIRONMENT:
  SLACK_BOT_TOKEN            Default token for API calls
  SLACK_BOT_TOKEN_<NAME>     Workspace-specific token (e.g., SLACK_BOT_TOKEN_MYWORKSPACE)
  SLACK_CLIENT_ID            Optional, for auth --refresh
  SLACK_CLIENT_SECRET        Optional, for auth --refresh
  SLACK_REFRESH_TOKEN        Optional, for auth --refresh

NOTES:
  - The NDJSON output is ALX-compatible: source=slack, object_type=slack_message.
  - For Slack export directories, pass the folder containing channels.json and channel subfolders.
`
}

function parse_args(argv: string[]): Args {
  const cmd = argv[0]
  if (!cmd || cmd === '-h' || cmd === '--help') {
    print_help('slack', usage())
    process.exit(ExitCode.SUCCESS)
  }

  const out: Partial<Args> = { cmd }

  let i = 1

  // Positional routing
  if (cmd === 'list') {
    const target = argv[i]
    if (target && !target.startsWith('--')) {
      out.list_target = target as ListTarget
      i += 1
    }
  }

  if (cmd === 'get') {
    const target = argv[i]
    if (target && !target.startsWith('--')) {
      out.get_target = target as GetTarget
      i += 1
      if ((out.get_target === 'channel' || out.get_target === 'chat') && argv[i] && !argv[i].startsWith('--')) {
        out.name = argv[i]
        i += 1
      }
    }
  }

  if (cmd === 'search') {
    const target = argv[i]
    if (target && !target.startsWith('--')) {
      out.search_target = target as SearchTarget
      i += 1
      if (argv[i] && !argv[i].startsWith('--')) {
        out.query = argv[i]
        i += 1
      }
    }
  }

  if (cmd === 'people') {
    const sub = argv[i]
    if (sub && !sub.startsWith('--')) {
      out.people_sub = sub as 'get'
      i += 1
    } else {
      out.people_sub = 'get'
    }
    if (argv[i] && !argv[i].startsWith('--')) {
      out.name = argv[i]
      i += 1
    }
  }

  if (cmd === 'file') {
    const sub = argv[i]
    if (sub && !sub.startsWith('--')) {
      out.file_sub = sub as 'download'
      i += 1
    } else {
      out.file_sub = 'download'
    }
    if (argv[i] && !argv[i].startsWith('--')) {
      out.file_input = argv[i]
      i += 1
    }
  }

  if (cmd === 'export') {
    // support: export messages ...
    const sub = argv[i]
    if (sub === 'messages') {
      i += 1
    }
  }

  while (i < argv.length) {
    const a = argv[i]
    const next = () => (i + 1 < argv.length ? argv[i + 1] : undefined)

    if (a === '-h' || a === '--help') {
      print_help('slack', usage())
      process.exit(ExitCode.SUCCESS)
    }

    if (a === '--dir') {
      const v = next()
      if (!v) die('Error: --dir requires a value', ExitCode.BAD_USAGE)
      out.dir = v
      i += 2
      continue
    }

    if (a === '--out' || a === '-o') {
      const v = next()
      if (!v) die('Error: --out requires a value', ExitCode.BAD_USAGE)
      out.out = v
      i += 2
      continue
    }

    if (a === '--out-dir') {
      const v = next()
      if (!v) die('Error: --out-dir requires a value', ExitCode.BAD_USAGE)
      out.out_dir = v
      i += 2
      continue
    }

    if (a === '--channel') {
      out.channel = out.channel ?? []
      // Consume following non-flag tokens to preserve AI CLI behavior.
      while (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) {
        out.channel.push(String(argv[i + 1]))
        i += 1
      }
      i += 1
      continue
    }

    if (a === '--since') {
      const v = next()
      if (!v) die('Error: --since requires a value', ExitCode.BAD_USAGE)
      out.since = v
      i += 2
      continue
    }

    if (a === '--until') {
      const v = next()
      if (!v) die('Error: --until requires a value', ExitCode.BAD_USAGE)
      out.until = v
      i += 2
      continue
    }

    if (a === '--between') {
      const v = next()
      if (!v) die('Error: --between requires a value', ExitCode.BAD_USAGE)
      out.between = v
      i += 2
      continue
    }

    if (a === '--acl') {
      const v = next()
      if (!v) die('Error: --acl requires a value', ExitCode.BAD_USAGE)
      out.acl = v
      i += 2
      continue
    }

    if (a === '--acl-tag') {
      out.acl_tag = out.acl_tag ?? []
      while (i + 1 < argv.length && !String(argv[i + 1]).startsWith('--')) {
        out.acl_tag.push(String(argv[i + 1]))
        i += 1
      }
      i += 1
      continue
    }

    if (a === '--token') {
      const v = next()
      if (!v) die('Error: --token requires a value', ExitCode.BAD_USAGE)
      out.token = v
      i += 2
      continue
    }

    if (a === '--refresh') {
      out.do_refresh = true
      i += 1
      continue
    }

    if (a === '--types') {
      const v = next()
      if (!v) die('Error: --types requires a value', ExitCode.BAD_USAGE)
      const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      out.types = [...(out.types ?? []), ...parts]
      i += 2
      continue
    }

    if (a === '--limit' || a === '-l' || a === '--per-page' || a === '-p') {
      const v = next()
      if (!v) die('Error: --limit requires a value', ExitCode.BAD_USAGE)
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) die('Error: --limit must be a positive number', ExitCode.BAD_USAGE)
      out.limit = Math.floor(n)
      i += 2
      continue
    }

    if (a === '--cursor') {
      const v = next()
      if (!v) die('Error: --cursor requires a value', ExitCode.BAD_USAGE)
      out.cursor = v
      i += 2
      continue
    }

    if (a === '--offset') {
      const v = next()
      if (!v) die('Error: --offset requires a value', ExitCode.BAD_USAGE)
      const n = Number(v)
      if (!Number.isFinite(n) || n < 0) die('Error: --offset must be a non-negative number', ExitCode.BAD_USAGE)
      out.offset = Math.floor(n)
      i += 2
      continue
    }

    if (a === '--json') {
      out.json = true
      i += 1
      continue
    }

    if (a === '--page') {
      const v = next()
      if (!v) die('Error: --page requires a value', ExitCode.BAD_USAGE)
      const n = Number(v)
      if (!Number.isFinite(n) || n < 1) die('Error: --page must be a positive number', ExitCode.BAD_USAGE)
      out.page = Math.floor(n)
      i += 2
      continue
    }

    if (a === '--sort-dir') {
      const v = next()
      if (!v) die('Error: --sort-dir requires a value (asc or desc)', ExitCode.BAD_USAGE)
      if (v !== 'asc' && v !== 'desc') die('Error: --sort-dir must be "asc" or "desc"', ExitCode.BAD_USAGE)
      out.sort_dir = v
      i += 2
      continue
    }

    if (a === '--ts') {
      const v = next()
      if (!v) die('Error: --ts requires a value', ExitCode.BAD_USAGE)
      out.thread_ts = v
      i += 2
      continue
    }

    if (a === '--with') {
      const v = next()
      if (!v) die('Error: --with requires a value', ExitCode.BAD_USAGE)
      out.with_user = v
      i += 2
      continue
    }

    if (a === '--threads') {
      const v = next()
      if (!v) die('Error: --threads requires a value', ExitCode.BAD_USAGE)
      out.threads = v as ThreadsMode
      i += 2
      continue
    }

    if (a === '--workspace' || a === '-w') {
      const v = next()
      if (!v) die('Error: --workspace requires a value', ExitCode.BAD_USAGE)
      out.workspace = v.toUpperCase()
      i += 2
      continue
    }

    if (a === '--to') {
      const v = next()
      if (!v) die('Error: --to requires a value', ExitCode.BAD_USAGE)
      out.send_to = v
      i += 2
      continue
    }

    if (a === '--text') {
      const v = next()
      if (v === undefined) die('Error: --text requires a value', ExitCode.BAD_USAGE)
      out.send_text = v
      i += 2
      continue
    }

    die(`Error: unknown argument: ${a}`, ExitCode.BAD_USAGE)
  }

  return out as Args
}

// --- Small helpers ----------------------------------------------------------

function ensure_dir(p: string) {
  const d = path.dirname(p)
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true })
}

function backup_env(): string {
  const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 15).replace('T', '_')
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })
  if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE, '')
  const bak = path.join(BACKUP_DIR, `.env.${stamp}.bak`)
  fs.copyFileSync(ENV_FILE, bak)
  return bak
}

function set_env_var(file_path: string, key: string, value: string) {
  const src = fs.existsSync(file_path) ? fs.readFileSync(file_path, 'utf8') : ''
  const lines = src.split(/\r?\n/)
  let updated = false
  const out_lines = lines.map((line) => {
    if (new RegExp(`^\\s*${key}=`).test(line)) {
      updated = true
      return `${key}="${value}"`
    }
    return line
  })
  if (!updated) out_lines.push(`${key}="${value}"`)
  const tmp = `${file_path}.tmp.${Date.now()}`
  fs.writeFileSync(tmp, out_lines.join('\n'))
  fs.renameSync(tmp, file_path)
}

function is_invalid_auth_error(err?: string): boolean {
  return Boolean(err) && ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked', 'access_denied'].includes(String(err))
}

function parse_slack_ts(ts: string): { seconds: number; micros: number; digits: string } {
  const m = ts.match(/^(\d{9,})(?:\.(\d{1,6}))?$/)
  if (!m) return { seconds: 0, micros: 0, digits: '0' }
  const secs = Number(m[1])
  const frac = String(m[2] || '').padEnd(6, '0').slice(0, 6)
  const micros = Number(frac)
  const digits = `${m[1]}${frac}`
  return { seconds: secs, micros, digits }
}

function crc32_digits(input: string): string {
  const c = createHash('sha256').update(input).digest()
  const n = (c[c.length - 2] << 8) | c[c.length - 1]
  return String(n).padStart(5, '0')
}

function since_cutoff(since?: string): number | null {
  if (!since) return null
  if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
    const p = Date.parse(since)
    return Number.isNaN(p) ? null : Math.floor(p / 1000)
  }
  if (/^\d{9,}$/.test(since)) return Number(since)
  return null
}

function to_iso(ts_sec: number): string {
  return new Date(ts_sec * 1000).toISOString()
}

function parse_between(b?: string): { since?: number; until?: number } {
  if (!b) return {}
  const m = b.match(/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/)
  if (!m) return {}
  const s = since_cutoff(m[1])
  const u = since_cutoff(m[2])
  const out: { since?: number; until?: number } = {}
  if (typeof s === 'number' && s > 0) out.since = s
  if (typeof u === 'number' && u > 0) out.until = u
  return out
}

function obj_get(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return 
  return (obj as Record<string, unknown>)[key]
}

function obj_get_string(obj: unknown, key: string): string | undefined {
  const v = obj_get(obj, key)
  return typeof v === 'string' ? v : undefined
}

function obj_get_boolean(obj: unknown, key: string): boolean | undefined {
  const v = obj_get(obj, key)
  return typeof v === 'boolean' ? v : undefined
}

// --- NDJSON (ALX schema) ----------------------------------------------------

type SlackNdjsonNode = {
  uid: string
  id: string
  source: 'slack'
  object_type: 'slack_message'
  ext_id: string
  parent_id: null
  parent_uid: string | null
  title: null
  text: string
  span: { kind: 'time'; start_ts: number; end_ts: number }
  url: string
  ts_start: number
  ts_end: number
  props: {
    channel_id: string
    channel_name: string
    author: string
    thread_ts: string | null
    acl_tags?: string[]
  }
  acl_hash: string
}

function build_uid(ext_id: string): string {
  return `slack:slack_message:${ext_id}`
}

function msg_to_node(message: Record<string, unknown>, channel_id: string, channel_name: string, acl: string | undefined, acl_tags: string[] | undefined): SlackNdjsonNode {
  const ts = String(message['ts'] ?? '0')
  const user = String(message['user'] ?? message['username'] ?? 'unknown')
  const text = String(message['text'] ?? '')
  const thread_ts_raw = message['thread_ts']
  const thread_ts = typeof thread_ts_raw === 'string' ? thread_ts_raw : undefined

  const { seconds, digits } = parse_slack_ts(ts)
  const id_digits = `${digits}${crc32_digits(channel_id).slice(0, 3)}`
  const uid = build_uid(ts)
  const parent_uid = thread_ts && thread_ts !== ts ? build_uid(thread_ts) : null
  const url = `https://slack.com/archives/${channel_id}/p${digits}`

  const props: SlackNdjsonNode['props'] = {
    channel_id,
    channel_name,
    author: user,
    thread_ts: thread_ts || null,
  }
  if (acl_tags && acl_tags.length) props.acl_tags = acl_tags

  return {
    uid,
    id: id_digits,
    source: 'slack',
    object_type: 'slack_message',
    ext_id: ts,
    parent_id: null,
    parent_uid,
    title: null,
    text,
    span: { kind: 'time', start_ts: seconds, end_ts: seconds },
    url,
    ts_start: seconds,
    ts_end: seconds,
    props,
    acl_hash: acl || 'public',
  }
}

async function ndjson_write(rows: SlackNdjsonNode[], out?: string) {
  if (!out) {
    for (const r of rows) process.stdout.write(`${JSON.stringify(r)}\n`)
    return
  }
  ensure_dir(out)
  const text = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  await Bun.write(out, text)
}

function read_json_file(file_path: string): unknown {
  try {
    const raw = fs.readFileSync(file_path, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function walk_dir_json(dir: string): string[] {
  const out: string[] = []
  const ents = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of ents) {
    if (e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk_dir_json(p))
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p)
  }
  return out
}

// --- Slack API --------------------------------------------------------------

type SlackApiResponse<T> = { ok: boolean; error?: string } & T

function ensure_object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    die('Error: Slack API returned non-object JSON', ExitCode.DATA_VALIDATION)
  }
  return value as Record<string, unknown>
}

async function curl_fallback<T>(method: string, params: Record<string, string | number | boolean | undefined>, token: string): Promise<SlackApiResponse<T> | null> {
  try {
    const body = new URLSearchParams(
      Object.fromEntries(
        Object.entries(params)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => [k, String(v)]),
      ),
    )

    const args: string[] = [
      '-sS',
      '-X',
      'POST',
      '-H',
      `Authorization: Bearer ${token}`,
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '--data',
      body.toString(),
      `https://slack.com/api/${method}`,
    ]

    const proc = Bun.spawn(['curl', ...args], { stdout: 'pipe', stderr: 'pipe' })
    const stdout = await new Response(proc.stdout).text()
    const parsed: unknown = JSON.parse(stdout)
    const obj = ensure_object(parsed)
    return obj as SlackApiResponse<T>
  } catch {
    return null
  }
}

async function slack_api<T>(method: string, params: Record<string, string | number | boolean | undefined>, token: string): Promise<SlackApiResponse<T>> {
  const url = new URL(`https://slack.com/api/${method}`)
  const body = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, String(v))

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const parsed: unknown = await res.json().catch(() => null)
    if (!parsed) throw new Error('invalid json')
    const obj = ensure_object(parsed)
    return obj as SlackApiResponse<T>
  } catch (err) {
    const fb = await curl_fallback<T>(method, params, token)
    if (fb) return fb
    throw err
  }
}

async function oauth_refresh_from_env(): Promise<string | null> {
  await load_env()
  const clientId = env_get('SLACK_CLIENT_ID') || ''
  const clientSecret = env_get('SLACK_CLIENT_SECRET') || ''
  const refreshToken = env_get('SLACK_REFRESH_TOKEN') || ''
  if (!((clientId && clientSecret ) && refreshToken)) return null

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const body = new URLSearchParams()
  body.set('grant_type', 'refresh_token')
  body.set('refresh_token', refreshToken)

  const res = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })

  const json_raw: unknown = await res.json().catch(() => ({}))
  const json = ensure_object(json_raw)
  if (json['ok'] !== true) return null
  const tok = json['access_token']
  return typeof tok === 'string' && tok ? tok : null
}

async function auth_set_token_and_save(tok: string, workspace?: string): Promise<string> {
  const bak = backup_env()
  const key = workspace ? `SLACK_BOT_TOKEN_${workspace}` : 'SLACK_BOT_TOKEN'
  set_env_var(ENV_FILE, key, tok)
  log_event('info', 'auth_set_token', { backup: bak, key })
  return key
}

async function auth_refresh_and_save(): Promise<string | null> {
  log_event('info', 'auth_refresh_start', {})
  const tok = await oauth_refresh_from_env()
  if (!tok) return null
  await auth_set_token_and_save(tok)
  log_event('info', 'auth_refresh_success', {})
  return tok
}

async function get_token_or_refresh(workspace?: string): Promise<string> {
  await load_env()
  // Try workspace-specific token first if workspace is specified
  // Prefer user tokens (xoxp-) over bot tokens (xoxb-) for better DM access
  let token: string | undefined
  if (workspace) {
    // Try user token first (has DM access), then bot token
    const userKey = `SLACK_USER_TOKEN_${workspace}`
    const botKey = `SLACK_BOT_TOKEN_${workspace}`
    token = env_get(userKey) || env_get(botKey)
    if (!token) die(`Error: Missing ${userKey} or ${botKey} for workspace "${workspace}"`, ExitCode.BAD_USAGE)
  } else {
    token = env_get('SLACK_USER_TOKEN') || env_get('SLACK_BOT_TOKEN')
    if (!token) token = (await auth_refresh_and_save()) || undefined
    if (!token) die('Error: Missing SLACK_USER_TOKEN/SLACK_BOT_TOKEN and no refresh credentials available', ExitCode.BAD_USAGE)
  }

  // Preflight auth; auto-refresh once if invalid
  const test = await slack_api<Record<string, unknown>>('auth.test', {}, token).catch(() => ({ ok: false, error: 'invalid_auth' } as SlackApiResponse<Record<string, unknown>>))
  if (!test.ok && is_invalid_auth_error(test.error)) {
    const nt = await auth_refresh_and_save()
    if (nt) {
      token = nt
      const re_test = await slack_api<Record<string, unknown>>('auth.test', {}, token).catch(() => ({ ok: false } as SlackApiResponse<Record<string, unknown>>))
      if (!re_test.ok) die(`Error: Slack auth failed: ${String(re_test.error || 'auth.test')}`)
    }
  }

  if (!(await slack_api<Record<string, unknown>>('auth.test', {}, token).then((r) => r.ok).catch(() => false))) {
    die("Error: Slack auth failed", ExitCode.GENERIC_UNKNOWN)
  }

  return token
}

// --- Name resolution and text beautification --------------------------------

const USER_NAME_CACHE = new Map<string, string>()

async function user_display_name(user_id: string, token: string): Promise<string> {
  if (!(user_id && /^[UW][A-Z0-9]+$/i.test(user_id))) return user_id
  const key = user_id.toUpperCase()
  const cached = USER_NAME_CACHE.get(key)
  if (cached) return cached

  try {
    const r = await slack_api<Record<string, unknown>>('users.info', { user: user_id }, token)
    if (r.ok && r['user'] && typeof r['user'] === 'object') {
      const u = r['user'] as Record<string, unknown>
      const profile = (u['profile'] && typeof u['profile'] === 'object') ? (u['profile'] as Record<string, unknown>) : null
      const name =
        (profile && typeof profile['display_name'] === 'string' && profile['display_name'])
          ? String(profile['display_name'])
          : (typeof u['real_name'] === 'string' && u['real_name'])
            ? String(u['real_name'])
            : (typeof u['name'] === 'string' && u['name'])
              ? String(u['name'])
              : user_id
      USER_NAME_CACHE.set(key, name)
      return name
    }
  } catch {
    // ignore
  }

  return user_id
}

async function format_user_label(user_id_or_name: string, token: string): Promise<string> {
  if (!user_id_or_name) return 'unknown'
  if (/^[UW][A-Z0-9]+$/i.test(user_id_or_name)) {
    const dn = await user_display_name(user_id_or_name, token)
    return `${dn} [ID: ${user_id_or_name}]`
  }
  return user_id_or_name
}

async function beautify_text(raw: string, token: string): Promise<string> {
  let text = raw || ''

  const userIds = new Set<string>()
  text.replace(/<@([UW][A-Z0-9]+)>/gi, (_m, uid: string) => {
    userIds.add(uid)
    return ''
  })

  const nameMap = new Map<string, string>()
  for (const uid of Array.from(userIds)) {
    const name = await user_display_name(uid, token)
    nameMap.set(uid, name)
  }

  text = text.replace(/<@([UW][A-Z0-9]+)>/gi, (_m, uid: string) => `@${nameMap.get(uid) || uid}`)
  text = text.replace(/<((https?:\/\/)[^|>]+)\|([^>]+)>/gi, (_m, url: string, _proto: string, label: string) => `${label} (${url})`)
  text = text.replace(/<((https?:\/\/)[^>]+)>/gi, (_m, url: string) => url)
  text = text.replace(/<#([CG][A-Z0-9]+)\|([^>]+)>/gi, (_m, _cid: string, name: string) => `#${name}`)
  text = text.replace(/<!(channel|here|everyone)>/gi, (_m, what: string) => `@${what.toLowerCase()}`)

  return text
}

// --- Channel/user resolution -------------------------------------------------

async function resolve_channels(input: string[] | undefined, token: string): Promise<Array<{ id: string; name: string }>> {
  const out: Array<{ id: string; name: string }> = []
  let cursor: string | undefined
  do {
    const r = await slack_api<{ channels?: unknown; response_metadata?: unknown }>('conversations.list', { types: 'public_channel,private_channel,mpim,im', limit: 1000, cursor }, token)
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'conversations.list')}`)

    const channels_raw = r['channels']
    const channels = Array.isArray(channels_raw) ? channels_raw : []
    for (const c of channels) {
      const id = obj_get_string(c, 'id')
      const name = obj_get_string(c, 'name')
      if (id && name) out.push({ id, name })
    }

    const md = r['response_metadata']
    cursor = obj_get_string(md, 'next_cursor') || undefined
  } while (cursor)

  if (!input || input.length === 0) return out
  const names = new Set(input.map((s) => s.toLowerCase()))
  return out.filter((c) => names.has(c.id.toLowerCase()) || names.has(c.name.toLowerCase()))
}

async function resolve_single_channel(name_or_id: string, token: string): Promise<{ id: string; name: string } | null> {
  const all = await resolve_channels(undefined, token)
  const q = name_or_id.toLowerCase()
  return all.find((c) => c.id.toLowerCase() === q || c.name.toLowerCase() === q) || null
}

async function resolve_user_id(query: string, token: string): Promise<string | null> {
  let needle = query.trim()
  if (needle.startsWith('@')) needle = needle.slice(1)
  if (/^[UW][A-Z0-9]+$/i.test(needle)) return needle

  let cursor: string | undefined
  do {
    const r = await slack_api<{ members?: unknown; response_metadata?: unknown }>('users.list', { limit: 1000, cursor }, token)
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'users.list')}`)

    const members_raw = r['members']
    const members = Array.isArray(members_raw) ? members_raw : []
    for (const m of members) {
      const name = String(obj_get_string(m, 'name') || '').toLowerCase()
      const profile = obj_get(m, 'profile')
      const disp = String(obj_get_string(profile, 'display_name') || '').toLowerCase()
      if (name === needle.toLowerCase() || (disp && disp === needle.toLowerCase())) return obj_get_string(m, 'id') || null
    }

    const md = r['response_metadata']
    cursor = obj_get_string(md, 'next_cursor') || undefined
  } while (cursor)

  return null
}

async function resolve_im_or_mpim_channel(name_or_id: string, token: string): Promise<{ id: string; name: string } | null> {
  if (/^[DG][A-Z0-9]+$/i.test(name_or_id)) return { id: name_or_id, name: name_or_id }

  const userId = await resolve_user_id(name_or_id, token)
  if (!userId) return null

  let cursor: string | undefined
  do {
    const r = await slack_api<{ channels?: unknown; response_metadata?: unknown }>('conversations.list', { types: 'im,mpim', limit: 1000, cursor }, token)
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'conversations.list')}`)

    const channels_raw = r['channels']
    const channels = Array.isArray(channels_raw) ? channels_raw : []
    for (const c of channels) {
      const is_im = obj_get_boolean(c, 'is_im')
      const user = obj_get_string(c, 'user')
      if (is_im && user && user === userId) {
        const id = obj_get_string(c, 'id')
        if (!id) continue
        const nm = obj_get_string(c, 'name') || id
        return { id, name: nm }
      }
    }

    const md = r['response_metadata']
    cursor = obj_get_string(md, 'next_cursor') || undefined
  } while (cursor)

  return null
}

async function attempt_join_channel(id: string, token: string) {
  try {
    const j = await slack_api<Record<string, unknown>>('conversations.join', { channel: id }, token)
    if (!j.ok && j.error && j.error !== 'method_not_supported_for_channel_type' && j.error !== 'is_archived') {
      log_event('warn', 'join_failed_get', { id, error: j.error })
    }
  } catch {
    log_event('warn', 'join_exception_get', { id })
  }
}

// --- Slack read operations ---------------------------------------------------

async function fetch_channel_page_simple(
  channel: { id: string; name: string },
  since_sec: number | null,
  until_sec: number | null,
  limit: number | undefined,
  cursor: string | undefined,
  token: string,
): Promise<{ items: Array<Record<string, unknown>>; next_cursor: string }> {
  const params: Record<string, string | number | boolean | undefined> = {
    channel: channel.id,
    limit: limit || 200,
    cursor,
    inclusive: true,
  }
  if (since_sec) params.oldest = since_sec
  if (until_sec) params.latest = until_sec

  const r = await slack_api<{ messages?: unknown; response_metadata?: unknown }>('conversations.history', params, token)
  if (!r.ok) die(`Error: Slack error: ${String(r.error || 'conversations.history')}`)

  const messages_raw = r['messages']
  const messages = Array.isArray(messages_raw) ? (messages_raw as Array<Record<string, unknown>>) : []
  const md = r['response_metadata']
  const next = obj_get_string(md, 'next_cursor') || ''

  return { items: messages, next_cursor: next }
}

async function fetch_channel_history(
  channel: { id: string; name: string },
  since_sec: number | null,
  token: string,
  acl: string | undefined,
  acl_tags: string[] | undefined,
): Promise<SlackNdjsonNode[]> {
  const by_uid = new Map<string, SlackNdjsonNode>()

  // Best-effort join (public channels) for better history access.
  try {
    const j = await slack_api<Record<string, unknown>>('conversations.join', { channel: channel.id }, token)
    if (!j.ok && j.error && j.error !== 'method_not_supported_for_channel_type' && j.error !== 'is_archived') {
      log_event('warn', 'join_failed', { channel: channel.name, id: channel.id, error: j.error })
    }
  } catch {
    log_event('warn', 'join_exception', { channel: channel.name, id: channel.id })
  }

  let cursor: string | undefined
  do {
    const r = await slack_api<{ messages?: unknown; response_metadata?: unknown; error?: string }>(
      'conversations.history',
      { channel: channel.id, limit: 1000, cursor, oldest: since_sec || undefined, inclusive: true },
      token,
    )

    if (!r.ok) {
      if (r.error === 'not_in_channel') {
        log_event('warn', 'not_in_channel', { channel: channel.name, id: channel.id })
        break
      }
      die(`Error: Slack error: ${String(r.error || 'conversations.history')}`)
    }

    const messages_raw = r['messages']
    const messages = Array.isArray(messages_raw) ? (messages_raw as Array<Record<string, unknown>>) : []

    for (const m of messages) {
      const t = obj_get_string(m, 'type')
      if (t && t !== 'message') continue

      const ts = obj_get_string(m, 'ts')
      if (!ts) continue

      const node = msg_to_node(m, channel.id, channel.name, acl, acl_tags)
      by_uid.set(node.uid, node)

      const thread_ts = obj_get_string(m, 'thread_ts')
      if (thread_ts && thread_ts !== ts) {
        let rcursor: string | undefined
        do {
          const rr = await slack_api<{ messages?: unknown; response_metadata?: unknown }>(
            'conversations.replies',
            { channel: channel.id, ts: thread_ts, limit: 200, cursor: rcursor },
            token,
          )
          if (!rr.ok) die(`Error: Slack error: ${String(rr.error || 'conversations.replies')}`)

          const replies_raw = rr['messages']
          const replies = Array.isArray(replies_raw) ? (replies_raw as Array<Record<string, unknown>>) : []
          for (const rm of replies) {
            const rms = obj_get_string(rm, 'ts')
            if (!rms || rms === thread_ts) continue
            const rnode = msg_to_node(rm, channel.id, channel.name, acl, acl_tags)
            by_uid.set(rnode.uid, rnode)
          }

          const md = rr['response_metadata']
          rcursor = obj_get_string(md, 'next_cursor') || undefined
        } while (rcursor)
      }
    }

    const md = r['response_metadata']
    cursor = obj_get_string(md, 'next_cursor') || undefined
  } while (cursor)

  return Array.from(by_uid.values())
}

// --- Commands ----------------------------------------------------------------

async function cmd_export_dir(a: Args) {
  const dir = a.dir
  if (!(dir && fs.existsSync(dir))) die('Error: export-dir requires --dir <path>', ExitCode.BAD_USAGE)

  const chans_path = path.join(dir, 'channels.json')
  const chan_meta_raw = read_json_file(chans_path)
  const chan_meta = Array.isArray(chan_meta_raw) ? (chan_meta_raw as Array<Record<string, unknown>>) : []

  const chan_name_to_id = new Map<string, string>()
  const chan_id_to_name = new Map<string, string>()
  for (const c of chan_meta) {
    const id = obj_get_string(c, 'id')
    const name = obj_get_string(c, 'name')
    if (id && name) {
      chan_name_to_id.set(name, id)
      chan_id_to_name.set(id, name)
    }
  }

  const cutoff = since_cutoff(a.since)
  const by_uid = new Map<string, SlackNdjsonNode>()

  const files = walk_dir_json(dir)
  for (const f of files) {
    const base = path.basename(f)
    if (base === 'channels.json' || base === 'users.json') continue

    const arr_raw = read_json_file(f)
    if (!Array.isArray(arr_raw)) continue

    const parts = path.relative(dir, f).split(path.sep)
    const channel_folder = parts.length > 1 ? parts[0] : ''

    let channel_id = chan_name_to_id.get(channel_folder) || ''
    const channel_name = chan_id_to_name.get(channel_id) || channel_folder || 'unknown'

    for (const msg_raw of arr_raw) {
      if (!msg_raw || typeof msg_raw !== 'object' || Array.isArray(msg_raw)) continue
      const m = msg_raw as Record<string, unknown>

      const t = obj_get_string(m, 'type')
      if (t && t !== 'message') continue

      const ts = obj_get_string(m, 'ts')
      if (!ts) continue

      const { seconds } = parse_slack_ts(ts)
      if (cutoff && seconds < cutoff) continue

      if (!channel_id) {
        const m_channel = obj_get_string(m, 'channel')
        if (m_channel) channel_id = m_channel
      }

      const node = msg_to_node(m, channel_id || 'unknown', channel_name, a.acl, a.acl_tag)
      by_uid.set(node.uid, node)

      const thread_ts = obj_get_string(m, 'thread_ts')
      if (thread_ts && thread_ts !== ts) {
        const root_raw = obj_get(m, 'root')
        const root_text = obj_get_string(root_raw, 'text') || ''
        const pm: Record<string, unknown> = { ts: thread_ts, user: obj_get_string(m, 'user') || obj_get_string(m, 'username') || 'unknown', text: root_text }
        const parent = msg_to_node(pm, channel_id || 'unknown', channel_name, a.acl, a.acl_tag)
        by_uid.set(parent.uid, parent)
      }
    }
  }

  const out_rows = Array.from(by_uid.values())
  await ndjson_write(out_rows, a.out)
  log_event('info', 'export_dir_done', { emitted: out_rows.length })
}

async function cmd_fetch(a: Args) {
  const token = await get_token_or_refresh(a.workspace)
  const since_sec = since_cutoff(a.since)

  const chans = await resolve_channels(a.channel, token)
  if (!chans.length) die('Error: No channels matched; specify --channel <name|id>', ExitCode.BAD_USAGE)

  const by_uid = new Map<string, SlackNdjsonNode>()

  for (const c of chans) {
    log_event('info', 'fetch_channel_start', { channel: c.name, id: c.id })
    const rows = await fetch_channel_history(c, since_sec, token, a.acl, a.acl_tag)
    for (const row of rows) by_uid.set(row.uid, row)
  }

  const out_rows = Array.from(by_uid.values())
  await ndjson_write(out_rows, a.out)
  log_event('info', 'fetch_done', { emitted: out_rows.length, channels: chans.length })
}

async function cmd_auth(a: Args) {
  await load_env()
  if (a.token && a.do_refresh) die('Error: Provide either --token or --refresh, not both', ExitCode.BAD_USAGE)

  if (a.token) {
    const key = await auth_set_token_and_save(a.token, a.workspace)
    console.log(`Saved ${key} to .env (backup created)`)
    return
  }

  if (a.do_refresh) {
    const tok = await auth_refresh_and_save()
    if (!tok) die('Error: Refresh failed: missing credentials or Slack error', ExitCode.GENERIC_UNKNOWN)
    console.log('Refreshed and saved SLACK_BOT_TOKEN to .env (backup created)')
    return
  }

  die('Error: auth requires --token <xoxb-...|xoxp-...> or --refresh', ExitCode.BAD_USAGE)
}

async function cmd_list(a: Args) {
  if (!a.list_target) die('Error: Usage: slack list channels|chats|people [--types t1,t2] [--limit N] [--cursor CUR] [--json]', ExitCode.BAD_USAGE)

  const token = await get_token_or_refresh(a.workspace)

  const limit = a.limit && a.limit > 0 ? a.limit : undefined
  const cursor = a.cursor

  if (a.list_target === 'channels' || a.list_target === 'chats') {
    const target = a.list_target
    const default_types = target === 'channels' ? ['public_channel', 'private_channel'] : ['im', 'mpim']
    const type_list = (a.types && a.types.length ? a.types : default_types).join(',')

    const r = await slack_api<{ channels?: unknown; response_metadata?: unknown }>('conversations.list', { types: type_list, limit: limit || 200, cursor }, token)
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'conversations.list')}`)

    const channels_raw = r['channels']
    const channels = Array.isArray(channels_raw) ? (channels_raw as Array<Record<string, unknown>>) : []

    const items = channels.map((c) => {
      const id = obj_get_string(c, 'id') || ''
      const nm = obj_get_string(c, 'name') || obj_get_string(c, 'user') || ''
      return { id, name: nm, is_private: Boolean(obj_get_boolean(c, 'is_private')), is_im: Boolean(obj_get_boolean(c, 'is_im')) }
    })

    const md = r['response_metadata']
    const next = obj_get_string(md, 'next_cursor') || ''

    if (a.json) {
      console.log(JSON.stringify({ items, next_cursor: next }))
    } else {
      const header = target === 'channels' ? 'Channels' : 'Chats'
      console.log(`# ${header} (${items.length})`)
      for (const it of items) {
        const meta: string[] = []
        if (it.is_private) meta.push('private')
        if (it.is_im) meta.push('im')
        const metaStr = meta.length ? ` [${meta.join(', ')}]` : ''
        console.log(`- ${it.name || '(no-name)'} [ID: ${it.id}]${metaStr}`)
      }
      if (next) console.error(`More: use --cursor ${next}`)
    }
    return
  }

  if (a.list_target === 'people') {
    const r = await slack_api<{ members?: unknown; response_metadata?: unknown }>('users.list', { limit: limit || 200, cursor }, token)
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'users.list')}`)

    const members_raw = r['members']
    const members = Array.isArray(members_raw) ? (members_raw as Array<Record<string, unknown>>) : []

    const items = members.map((m) => {
      const id = obj_get_string(m, 'id') || ''
      const nm = obj_get_string(m, 'name') || obj_get_string(m, 'real_name') || ''
      const profile = obj_get(m, 'profile')
      const disp = obj_get_string(profile, 'display_name') || ''
      const deleted = Boolean(obj_get_boolean(m, 'deleted'))
      return { id, name: nm, display_name: disp, deleted }
    })

    const md = r['response_metadata']
    const next = obj_get_string(md, 'next_cursor') || ''

    if (a.json) {
      console.log(JSON.stringify({ items, next_cursor: next }))
    } else {
      console.log(`# People (${items.length})`)
      for (const it of items) {
        const meta: string[] = []
        if (it.display_name && it.display_name !== it.name) meta.push(`display: ${it.display_name}`)
        if (it.deleted) meta.push('deleted')
        const metaStr = meta.length ? ` [${meta.join(', ')}]` : ''
        console.log(`- ${it.name || '(no-name)'} [ID: ${it.id}]${metaStr}`)
      }
      if (next) console.error(`More: use --cursor ${next}`)
    }
    return
  }

  die(`Error: Unknown list target: ${String(a.list_target)}`, ExitCode.BAD_USAGE)
}

async function render_messages_markdown(context_title: string, channel: { id: string; name: string }, msgs: Array<Record<string, unknown>>, token: string) {
  console.log(`# ${context_title}`)
  console.log(`Channel: ${channel.name} [ID: ${channel.id}]`)
  for (const m of msgs) {
    const ts = String(obj_get_string(m, 'ts') || '0')
    const { seconds, digits } = parse_slack_ts(ts)
    const uid = String(obj_get_string(m, 'user') || '')
    const user_label = await format_user_label(uid || String(obj_get_string(m, 'username') || ''), token)
    const raw = String(obj_get_string(m, 'text') || '')
    const text = await beautify_text(raw, token)
    const url = `https://slack.com/archives/${channel.id}/p${digits}`
    console.log(`- [${to_iso(seconds)}] @${user_label}: ${text}\n  <${url}>`)
  }
}

async function cmd_get(a: Args) {
  if (!a.get_target) die('Error: Usage: slack get channel|chat|thread ... (see --help)', ExitCode.BAD_USAGE)

  const token = await get_token_or_refresh(a.workspace)

  const since_sec = since_cutoff(a.since)
  const until_sec = since_cutoff(a.until)
  const limit = a.limit && a.limit > 0 ? a.limit : undefined
  const cursor = a.cursor

  if (a.get_target === 'channel') {
    if (!a.name) die('Error: slack get channel <name|id>', ExitCode.BAD_USAGE)

    const ch = await resolve_single_channel(a.name, token)
    if (!ch) die(`Error: Channel not found: ${a.name}`, ExitCode.NOT_FOUND)

    await attempt_join_channel(ch.id, token)

    const { items, next_cursor } = await fetch_channel_page_simple(ch, since_sec, until_sec, limit, cursor, token)
    const paged = a.offset && a.offset > 0 ? items.slice(a.offset) : items

    if (a.json) {
      const uids = Array.from(new Set(paged.map((m) => String(obj_get_string(m, 'user') || '')).filter(Boolean)))
      const name_map = new Map<string, string>()
      for (const uid of uids) name_map.set(uid, await user_display_name(uid, token))

      const mapped = paged.map((m) => {
        const ts = String(obj_get_string(m, 'ts') || '0')
        const { seconds, digits } = parse_slack_ts(ts)
        const uid = String(obj_get_string(m, 'user') || '')
        return {
          ts,
          ts_sec: seconds,
          user: obj_get_string(m, 'user') || obj_get_string(m, 'username') || 'unknown',
          user_id: uid || null,
          user_display_name: uid ? (name_map.get(uid) || null) : null,
          text: obj_get_string(m, 'text') || '',
          thread_ts: obj_get_string(m, 'thread_ts') || null,
          url: `https://slack.com/archives/${ch.id}/p${digits}`,
        }
      })

      console.log(JSON.stringify({ channel: ch, items: mapped, next_cursor }))
    } else {
      await render_messages_markdown(`Channel messages (limit=${limit || 200})`, ch, paged, token)
      if (next_cursor) console.error(`More: use --cursor ${next_cursor}`)
    }

    return
  }

  if (a.get_target === 'chat') {
    if (!a.name) die('Error: slack get chat <@user|user_id|chat_id>', ExitCode.BAD_USAGE)

    const ch = await resolve_im_or_mpim_channel(a.name, token)
    if (!ch) die(`Error: Chat/IM not found: ${a.name}`, ExitCode.NOT_FOUND)

    const { items, next_cursor } = await fetch_channel_page_simple(ch, since_sec, until_sec, limit, cursor, token)

    if (a.json) {
      const mapped = items.map((m) => {
        const ts = String(obj_get_string(m, 'ts') || '0')
        const { seconds, digits } = parse_slack_ts(ts)
        return {
          ts,
          ts_sec: seconds,
          user: obj_get_string(m, 'user') || obj_get_string(m, 'username') || 'unknown',
          text: obj_get_string(m, 'text') || '',
          thread_ts: obj_get_string(m, 'thread_ts') || null,
          url: `https://slack.com/archives/${ch.id}/p${digits}`,
        }
      })
      console.log(JSON.stringify({ chat: ch, items: mapped, next_cursor }))
    } else {
      await render_messages_markdown(`Chat messages (limit=${limit || 200})`, ch, items, token)
      if (next_cursor) console.error(`More: use --cursor ${next_cursor}`)
    }

    return
  }

  if (a.get_target === 'thread') {
    const chan_arg = a.channel && a.channel[0]
    if (!(chan_arg && a.thread_ts)) die('Error: slack get thread --channel <name|id> --ts <thread_ts>', ExitCode.BAD_USAGE)

    const ch = await resolve_single_channel(chan_arg, token)
    if (!ch) die(`Error: Channel not found: ${String(chan_arg)}`, ExitCode.NOT_FOUND)

    let rcursor: string | undefined = cursor
    const replies: Array<Record<string, unknown>> = []

    do {
      const rr = await slack_api<{ messages?: unknown; response_metadata?: unknown }>(
        'conversations.replies',
        { channel: ch.id, ts: a.thread_ts, limit: limit || 200, cursor: rcursor },
        token,
      )
      if (!rr.ok) die(`Error: Slack error: ${String(rr.error || 'conversations.replies')}`)

      const msgs_raw = rr['messages']
      const msgs = Array.isArray(msgs_raw) ? (msgs_raw as Array<Record<string, unknown>>) : []
      for (const rm of msgs) replies.push(rm)

      const md = rr['response_metadata']
      rcursor = obj_get_string(md, 'next_cursor') || undefined
    } while (rcursor && !limit)

    if (a.json) {
      const mapped = replies.map((m) => {
        const ts = String(obj_get_string(m, 'ts') || '0')
        const { seconds, digits } = parse_slack_ts(ts)
        return {
          ts,
          ts_sec: seconds,
          user: obj_get_string(m, 'user') || obj_get_string(m, 'username') || 'unknown',
          text: obj_get_string(m, 'text') || '',
          thread_ts: obj_get_string(m, 'thread_ts') || null,
          url: `https://slack.com/archives/${ch.id}/p${digits}`,
        }
      })
      console.log(JSON.stringify({ channel: ch, thread_ts: a.thread_ts, items: mapped, next_cursor: rcursor || '' }))
    } else {
      const root = replies.find((r) => String(obj_get_string(r, 'ts') || '') === String(a.thread_ts))
      const rootText = String(obj_get_string(root, 'text') || '')
      const title = rootText ? `${rootText.slice(0, 60)}${rootText.length > 60 ? '…' : ''}` : `ts=${a.thread_ts}`
      await render_messages_markdown(`Thread: ${title}`, ch, replies, token)
      if (rcursor) console.error(`More: use --cursor ${rcursor}`)
    }

    return
  }

  die(`Error: Unknown get target: ${String(a.get_target)}`, ExitCode.BAD_USAGE)
}

async function cmd_search(a: Args) {
  if (!(a.search_target && a.query)) die('Error: Usage: slack search channels|chats|people|messages <query>', ExitCode.BAD_USAGE)

  const token = await get_token_or_refresh(a.workspace)

  const q = a.query.toLowerCase()
  const limit = a.limit && a.limit > 0 ? a.limit : undefined
  const cursor = a.cursor

  if (a.search_target === 'channels') {
    const r = await slack_api<{ channels?: unknown; response_metadata?: unknown }>(
      'conversations.list',
      { types: 'public_channel,private_channel', limit: limit || 200, cursor },
      token,
    )
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'conversations.list')}`)

    const channels_raw = r['channels']
    const channels = Array.isArray(channels_raw) ? (channels_raw as Array<Record<string, unknown>>) : []
    const items = channels
      .filter((c) => String(obj_get_string(c, 'name') || '').toLowerCase().includes(q))
      .map((c) => ({ id: obj_get_string(c, 'id') || '', name: obj_get_string(c, 'name') || '' }))

    const md = r['response_metadata']
    const next = obj_get_string(md, 'next_cursor') || ''

    if (a.json) console.log(JSON.stringify({ items, next_cursor: next }))
    else {
      console.log(`# Channels matching "${a.query}" (${items.length})`)
      for (const it of items) console.log(`- ${it.name} [ID: ${it.id}]`)
      if (next) console.error(`More: use --cursor ${next}`)
    }
    return
  }

  if (a.search_target === 'messages') {
    // Prefer Slack search API; if missing scope, fallback requires --channel
    // Note: search.messages uses page-based pagination, not cursor
    try {
      const r = await slack_api<Record<string, unknown>>(
        'search.messages',
        { query: a.query, sort: 'timestamp', sort_dir: a.sort_dir || 'desc', count: a.limit || 20, page: a.page || 1 },
        token,
      )

      if (r.ok) {
        const messages_obj = ensure_object(r['messages'])
        const matches_raw = messages_obj['matches']
        const matches = Array.isArray(matches_raw) ? matches_raw : []
        // Page-based pagination info from search.messages
        const paging = messages_obj['paging'] as Record<string, unknown> | undefined
        const total = typeof paging?.['total'] === 'number' ? paging['total'] : 0
        const currentPage = typeof paging?.['page'] === 'number' ? paging['page'] : 1
        const pages = typeof paging?.['pages'] === 'number' ? paging['pages'] : 1

        if (a.json) {
          const items = matches.map((m) => {
            const ch_obj = ensure_object(obj_get(m, 'channel'))
            const ts = String(obj_get_string(m, 'ts') || obj_get_string(m, 'iid') || '0')
            const { seconds, digits } = parse_slack_ts(ts)
            const url =
              obj_get_string(m, 'permalink') ||
              (obj_get_string(ch_obj, 'id') ? `https://slack.com/archives/${String(obj_get_string(ch_obj, 'id'))}/p${digits}` : '')

            return {
              channel_id: obj_get_string(ch_obj, 'id') || '',
              channel_name: obj_get_string(ch_obj, 'name') || '',
              ts,
              ts_sec: seconds,
              user: obj_get_string(m, 'user') || obj_get_string(m, 'username') || '',
              text: obj_get_string(m, 'text') || obj_get_string(m, 'plain_text') || '',
              url,
            }
          })
          console.log(JSON.stringify({ items, total, page: currentPage, pages }))
        } else {
          console.log(`# Messages matching "${a.query}" (${matches.length} of ${total}, page ${currentPage}/${pages})`)
          for (const m of matches) {
            const ts = String(obj_get_string(m, 'ts') || obj_get_string(m, 'iid') || '0')
            const { seconds } = parse_slack_ts(ts)
            const ch_obj = ensure_object(obj_get(m, 'channel'))
            const user_label = await format_user_label(String(obj_get_string(m, 'user') || obj_get_string(m, 'username') || ''), token)
            const pretty = await beautify_text(String(obj_get_string(m, 'text') || obj_get_string(m, 'plain_text') || ''), token)
            const url = obj_get_string(m, 'permalink') || ''
            console.log(`- [${to_iso(seconds)}] #${obj_get_string(ch_obj, 'name') || obj_get_string(ch_obj, 'id') || ''} @${user_label}: ${pretty}${url ? `\n  <${url}>` : ''}`)
          }
          if (currentPage < pages) console.error(`More: use --page ${currentPage + 1}`)
        }
        return
      }

      if (r.error && String(r.error).includes('missing_scope')) {
        // fallthrough to fallback
      } else {
        die(`Error: Slack error: ${String(r.error || 'search.messages')}`)
      }
    } catch {
      // fallthrough to fallback
    }

    // Fallback: require --channel, scan limited history and filter
    const chans = a.channel && a.channel.length ? a.channel : []
    if (!chans.length) die('Error: search:read scope missing; provide --channel <name|id> to fallback scan', ExitCode.DATA_VALIDATION)

    const resolved = await resolve_channels(chans, token)
    const out_items: Array<{ channel_id: string; channel_name: string; ts: string; ts_sec: number; user: string; text: string; url: string }> = []

    for (const ch of resolved) {
      const { items } = await fetch_channel_page_simple(ch, null, null, a.limit || 200, undefined, token)
      for (const m of items) {
        const lower = String(obj_get_string(m, 'text') || '').toLowerCase()
        if (!lower.includes(q)) continue

        const ts = String(obj_get_string(m, 'ts') || '0')
        const { seconds, digits } = parse_slack_ts(ts)
        out_items.push({
          channel_id: ch.id,
          channel_name: ch.name,
          ts,
          ts_sec: seconds,
          user: String(obj_get_string(m, 'user') || obj_get_string(m, 'username') || ''),
          text: String(obj_get_string(m, 'text') || ''),
          url: `https://slack.com/archives/${ch.id}/p${digits}`,
        })
      }
    }

    if (a.json) console.log(JSON.stringify({ items: out_items, next_cursor: '' }))
    else {
      console.log(`# Messages matching "${a.query}" (${out_items.length})`)
      for (const it of out_items) {
        const label = await format_user_label(String(it.user || ''), token)
        const pretty = await beautify_text(String(it.text || ''), token)
        console.log(`- [${to_iso(it.ts_sec)}] #${it.channel_name || it.channel_id} @${label}: ${pretty}\n  <${it.url}>`)
      }
    }

    return
  }

  if (a.search_target === 'people') {
    const r = await slack_api<{ members?: unknown; response_metadata?: unknown }>('users.list', { limit: limit || 200, cursor }, token)
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'users.list')}`)

    const members_raw = r['members']
    const members = Array.isArray(members_raw) ? (members_raw as Array<Record<string, unknown>>) : []

    const items = members
      .filter((m) => {
        const name = String(obj_get_string(m, 'name') || '').toLowerCase()
        const profile = obj_get(m, 'profile')
        const disp = String(obj_get_string(profile, 'display_name') || '').toLowerCase()
        const email = String(obj_get_string(profile, 'email') || '').toLowerCase()
        return name.includes(q) || (disp && disp.includes(q)) || (email && email.includes(q))
      })
      .map((m) => {
        const profile = obj_get(m, 'profile')
        return {
          id: obj_get_string(m, 'id') || '',
          name: obj_get_string(m, 'name') || '',
          display_name: obj_get_string(profile, 'display_name') || '',
          email: obj_get_string(profile, 'email') || '',
        }
      })

    const md = r['response_metadata']
    const next = obj_get_string(md, 'next_cursor') || ''

    if (a.json) console.log(JSON.stringify({ items, next_cursor: next }))
    else {
      console.log(`# People matching "${a.query}" (${items.length})`)
      for (const it of items) {
        const meta = [it.display_name ? `display: ${it.display_name}` : '', it.email].filter(Boolean).join(', ')
        console.log(`- ${it.name} [ID: ${it.id}]${meta ? ` [${meta}]` : ''}`)
      }
      if (next) console.error(`More: use --cursor ${next}`)
    }

    return
  }

  if (a.search_target === 'chats') {
    const r = await slack_api<{ channels?: unknown; response_metadata?: unknown }>('conversations.list', { types: 'im,mpim', limit: limit || 200, cursor }, token)
    if (!r.ok) die(`Error: Slack error: ${String(r.error || 'conversations.list')}`)

    const channels_raw = r['channels']
    const channels = Array.isArray(channels_raw) ? (channels_raw as Array<Record<string, unknown>>) : []

    // Build a set of IM user IDs in this page
    const user_ids = Array.from(
      new Set(
        channels
          .filter((c) => Boolean(obj_get_boolean(c, 'is_im')) && obj_get_string(c, 'user'))
          .map((c) => String(obj_get_string(c, 'user') || ''))
          .filter(Boolean),
      ),
    )

    const user_map = new Map<string, { name: string; display_name: string }>()
    if (user_ids.length) {
      let ucursor: string | undefined
      do {
        const ur = await slack_api<{ members?: unknown; response_metadata?: unknown }>('users.list', { limit: 1000, cursor: ucursor }, token)
        if (!ur.ok) break

        const members_raw = ur['members']
        const members = Array.isArray(members_raw) ? (members_raw as Array<Record<string, unknown>>) : []
        for (const m of members) {
          const id = obj_get_string(m, 'id')
          if (!id) continue
          if (!user_ids.includes(id)) continue
          const profile = obj_get(m, 'profile')
          user_map.set(id, { name: obj_get_string(m, 'name') || '', display_name: obj_get_string(profile, 'display_name') || '' })
        }

        const md = ur['response_metadata']
        ucursor = obj_get_string(md, 'next_cursor') || undefined
        if (user_map.size === user_ids.length) break
      } while (ucursor)
    }

    const items = channels
      .filter((c) => {
        const is_im = Boolean(obj_get_boolean(c, 'is_im'))
        const user = obj_get_string(c, 'user')
        if (!(is_im && user)) return false
        const u = user_map.get(user)
        const name = String(u?.name || '').toLowerCase()
        const disp = String(u?.display_name || '').toLowerCase()
        return name.includes(q) || (disp && disp.includes(q))
      })
      .map((c) => ({ id: obj_get_string(c, 'id') || '', name: obj_get_string(c, 'name') || obj_get_string(c, 'id') || '', user: obj_get_string(c, 'user') || '' }))

    const md = r['response_metadata']
    const next = obj_get_string(md, 'next_cursor') || ''

    if (a.json) console.log(JSON.stringify({ items, next_cursor: next }))
    else {
      console.log(`# Chats matching "${a.query}" (${items.length})`)
      for (const it of items) console.log(`- ${it.name} [ID: ${it.id}] [user: ${it.user}]`)
      if (next) console.error(`More: use --cursor ${next}`)
    }

    return
  }

  die(`Error: Unknown search target: ${String(a.search_target)}`, ExitCode.BAD_USAGE)
}

async function cmd_people(a: Args) {
  if (a.people_sub !== 'get' || !a.name) die('Error: Usage: slack people get <@user|user_id|email> [--json]', ExitCode.BAD_USAGE)

  const token = await get_token_or_refresh(a.workspace)
  const q = a.name.trim()

  let user: Record<string, unknown> | null = null

  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) {
    const r = await slack_api<Record<string, unknown>>('users.lookupByEmail', { email: q }, token)
    if (r.ok && r['user'] && typeof r['user'] === 'object') user = r['user'] as Record<string, unknown>
  }

  if (!user) {
    const uid = await resolve_user_id(q, token)
    if (uid) {
      const r = await slack_api<Record<string, unknown>>('users.info', { user: uid }, token)
      if (r.ok && r['user'] && typeof r['user'] === 'object') user = r['user'] as Record<string, unknown>
    }
  }

  if (!user) die('Error: User not found', ExitCode.NOT_FOUND)

  const profile = obj_get(user, 'profile')
  const out = {
    id: obj_get_string(user, 'id') || '',
    name: obj_get_string(user, 'name') || '',
    real_name: obj_get_string(user, 'real_name') || '',
    display_name: obj_get_string(profile, 'display_name') || '',
    email: obj_get_string(profile, 'email') || '',
    title: obj_get_string(profile, 'title') || '',
    tz: obj_get_string(user, 'tz') || '',
    is_bot: Boolean(obj_get_boolean(user, 'is_bot')),
    deleted: Boolean(obj_get_boolean(user, 'deleted')),
  }

  if (a.json) console.log(JSON.stringify(out))
  else {
    console.log(`# Person: ${out.name || out.display_name || out.real_name || out.id}`)
    console.log(`- id: ${out.id}`)
    console.log(`- real_name: ${out.real_name}`)
    console.log(`- display_name: ${out.display_name}`)
    console.log(`- email: ${out.email}`)
    console.log(`- title: ${out.title}`)
    console.log(`- tz: ${out.tz}`)
    console.log(`- is_bot: ${out.is_bot}`)
    console.log(`- deleted: ${out.deleted}`)
  }
}

async function download_with_auth(url: string, out_path: string, token: string): Promise<string> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) die(`Error: Download failed: HTTP ${res.status}`)
  const buf = new Uint8Array(await res.arrayBuffer())
  ensure_dir(out_path)
  fs.writeFileSync(out_path, buf)
  return out_path
}

async function cmd_file(a: Args) {
  if (a.file_sub !== 'download' || !a.file_input) die('Error: Usage: slack file download <file_id|url> [--out PATH|--out-dir DIR] [--json]', ExitCode.BAD_USAGE)

  const token = await get_token_or_refresh(a.workspace)

  const input = a.file_input
  let download_url: string | null = null
  let filename: string | null = null

  if (/^https?:\/\//i.test(input)) {
    download_url = input
    filename = path.basename(new URL(input).pathname) || `slack_file_${Date.now()}`
  } else {
    const r = await slack_api<Record<string, unknown>>('files.info', { file: input }, token)
    if (!(r.ok && r['file'] ) || typeof r['file'] !== 'object') die(`Error: File not found: ${input}`, ExitCode.NOT_FOUND)
    const f = r['file'] as Record<string, unknown>
    const u = obj_get_string(f, 'url_private_download') || obj_get_string(f, 'url_private') || null
    download_url = u
    filename = obj_get_string(f, 'name') || `slack_file_${input}`
  }

  if (!download_url) die('Error: No download URL available for this file', ExitCode.GENERIC_UNKNOWN)

  const out_path =
    a.out ||
    (a.out_dir
      ? path.join(a.out_dir, filename as string)
      : path.join(ROOT_DIR, 'outputs', 'slack', filename as string))

  const saved = await download_with_auth(download_url, out_path, token)

  if (a.json) console.log(JSON.stringify({ path: saved, filename }))
  else console.log(`Saved: ${saved}`)
}

async function cmd_export_messages(a: Args) {
  const token = await get_token_or_refresh(a.workspace)

  let ch: { id: string; name: string } | null = null
  if (a.channel && a.channel.length) {
    ch = await resolve_single_channel(a.channel[0], token)
  } else if (a.with_user) {
    ch = await resolve_im_or_mpim_channel(a.with_user, token)
  }

  if (!ch) die('Error: Provide --channel <name|id> or --with <@user|user_id>', ExitCode.BAD_USAGE)

  const between = parse_between(a.between)
  const since_sec = between.since ?? since_cutoff(a.since)
  const until_sec = between.until ?? since_cutoff(a.until)
  const threads = a.threads || 'roots'

  let cursor = a.cursor
  const all: Array<Record<string, unknown>> = []

  do {
    const r = await fetch_channel_page_simple(ch, since_sec ?? null, until_sec ?? null, a.limit, cursor, token)
    const page = r.items

    let msgs = page
    if (threads === 'roots') {
      msgs = page.filter((m) => String(obj_get_string(m, 'thread_ts') || obj_get_string(m, 'ts') || '') === String(obj_get_string(m, 'ts') || ''))
    }
    if (threads === 'none') {
      msgs = page.filter((m) => !obj_get_string(m, 'thread_ts'))
    }

    all.push(...msgs)
    cursor = r.next_cursor || undefined
    if (!cursor) break
  } while (cursor)

  if (threads === 'full') {
    const roots = all.filter((m) => String(obj_get_string(m, 'thread_ts') || obj_get_string(m, 'ts') || '') === String(obj_get_string(m, 'ts') || ''))
    for (const root of roots) {
      const root_ts = obj_get_string(root, 'ts')
      if (!root_ts) continue

      let rcursor: string | undefined
      do {
        const rr = await slack_api<{ messages?: unknown; response_metadata?: unknown }>(
          'conversations.replies',
          { channel: ch.id, ts: root_ts, limit: 200, cursor: rcursor },
          token,
        )
        if (!rr.ok) break

        const msgs_raw = rr['messages']
        const replies = Array.isArray(msgs_raw) ? (msgs_raw as Array<Record<string, unknown>>) : []
        for (const rm of replies) {
          const ts = obj_get_string(rm, 'ts')
          if (!ts || ts === root_ts) continue
          all.push(rm)
        }

        const md = rr['response_metadata']
        rcursor = obj_get_string(md, 'next_cursor') || undefined
      } while (rcursor)
    }
  }

  if (a.json) {
    const mapped = all.map((m) => {
      const ts = String(obj_get_string(m, 'ts') || '0')
      const { seconds, digits } = parse_slack_ts(ts)
      return {
        ts,
        ts_sec: seconds,
        user: obj_get_string(m, 'user') || obj_get_string(m, 'username') || 'unknown',
        text: obj_get_string(m, 'text') || '',
        thread_ts: obj_get_string(m, 'thread_ts') || null,
        url: `https://slack.com/archives/${ch!.id}/p${digits}`,
      }
    })

    const payload = JSON.stringify({ channel: ch, items: mapped }, null, 2)
    if (a.out) {
      ensure_dir(a.out)
      fs.writeFileSync(a.out, payload)
    } else {
      process.stdout.write(payload + '\n')
    }

    return
  }

  const by_day = new Map<string, string[]>()
  for (const m of all) {
    const ts = String(obj_get_string(m, 'ts') || '0')
    const { seconds, digits } = parse_slack_ts(ts)
    const day = to_iso(seconds).slice(0, 10)
    const user = obj_get_string(m, 'user') || obj_get_string(m, 'username') || 'unknown'
    const raw = obj_get_string(m, 'text') || ''
    const text = await beautify_text(raw, token)
    const url = `https://slack.com/archives/${ch.id}/p${digits}`
    const line = `- [${to_iso(seconds)}] @${user}: ${text}\n  <${url}>`
    if (!by_day.has(day)) by_day.set(day, [])
    by_day.get(day)!.push(line)
  }

  const days = Array.from(by_day.keys()).sort()
  const lines: string[] = []
  lines.push(`# Export: ${ch.name} (${ch.id})`)
  for (const d of days) {
    lines.push(`\n## ${d}`)
    lines.push(...(by_day.get(d) || []))
  }

  const body = lines.join('\n') + '\n'
  if (a.out) {
    ensure_dir(a.out)
    fs.writeFileSync(a.out, body)
  } else {
    process.stdout.write(body)
  }
}

async function cmd_send(a: Args) {
  let text = a.send_text
  if (text === undefined && !process.stdin.isTTY) {
    text = await read_stdin()
  }
  if (text === undefined || text.trim() === '') {
    die('Error: slack send requires --text <message> or piped stdin', ExitCode.BAD_USAGE)
  }

  const has_to = Boolean(a.send_to && a.send_to.trim())
  const has_channel = Boolean(a.channel && a.channel.length > 0 && a.channel[0].trim())
  if (!has_to && !has_channel) {
    die('Error: slack send requires --to <user> or --channel <id>', ExitCode.BAD_USAGE)
  }
  if (has_to && has_channel) {
    die('Error: slack send: pass either --to or --channel, not both', ExitCode.BAD_USAGE)
  }

  // Send requires bot token (user token lacks chat:write); force it.
  await load_env()
  const bot_key = a.workspace ? `SLACK_BOT_TOKEN_${a.workspace}` : 'SLACK_BOT_TOKEN'
  const token = env_get(bot_key)
  if (!token) die(`Error: Missing ${bot_key} (bot token required for chat:write)`, ExitCode.BAD_USAGE)

  let channel_id: string | null = null
  let target_label = ''

  if (has_to) {
    const q = (a.send_to as string).trim()
    let user_id: string | null = null

    if (/^U[A-Z0-9]+$/.test(q)) {
      user_id = q
    } else if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(q)) {
      const r = await slack_api<Record<string, unknown>>('users.lookupByEmail', { email: q }, token)
      if (r.ok && r['user'] && typeof r['user'] === 'object') {
        user_id = obj_get_string(r['user'] as Record<string, unknown>, 'id') || null
      }
    } else {
      user_id = await resolve_user_id(q, token)
    }

    if (!user_id) die(`Error: could not resolve user: ${q}`, ExitCode.NOT_FOUND)

    const open = await slack_api<Record<string, unknown>>('conversations.open', { users: user_id }, token)
    if (!open.ok) {
      die(`Error: conversations.open failed for ${user_id}: ${open.error || 'unknown'}`, ExitCode.PERMISSION_DENIED)
    }
    const ch = open['channel']
    if (!ch || typeof ch !== 'object') die('Error: conversations.open did not return a channel', ExitCode.GENERIC_UNKNOWN)
    channel_id = obj_get_string(ch as Record<string, unknown>, 'id') || null
    if (!channel_id) die('Error: conversations.open did not return a channel id', ExitCode.GENERIC_UNKNOWN)
    target_label = `user ${user_id}`
  } else {
    const target = (a.channel as string[])[0].trim()
    if (/^[CDG][A-Z0-9]+$/.test(target)) {
      channel_id = target
    } else {
      const c = await resolve_single_channel(target, token)
      if (!c) die(`Error: could not resolve channel: ${target}`, ExitCode.NOT_FOUND)
      channel_id = c.id
    }
    target_label = `channel ${channel_id}`
  }

  const post = await slack_api<Record<string, unknown>>('chat.postMessage', { channel: channel_id, text }, token)
  if (!post.ok) {
    die(`Error: chat.postMessage failed: ${post.error || 'unknown'}`, ExitCode.GENERIC_UNKNOWN)
  }

  const ts = obj_get_string(post as unknown as Record<string, unknown>, 'ts') || ''
  const out = { ok: true, channel: channel_id, ts, target: target_label }

  if (a.json) console.log(JSON.stringify(out))
  else console.log(`Sent to ${target_label} (channel=${channel_id}, ts=${ts})`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    print_help('slack', usage())
    if (argv.length === 0) process.exit(ExitCode.BAD_USAGE)
    process.exit(ExitCode.SUCCESS)
  }

  const a = parse_args(argv)

  if (a.cmd === 'export-dir') return await cmd_export_dir(a)
  if (a.cmd === 'fetch') return await cmd_fetch(a)
  if (a.cmd === 'auth') return await cmd_auth(a)
  if (a.cmd === 'list') return await cmd_list(a)
  if (a.cmd === 'get') return await cmd_get(a)
  if (a.cmd === 'search') return await cmd_search(a)
  if (a.cmd === 'people') return await cmd_people(a)
  if (a.cmd === 'file') return await cmd_file(a)
  if (a.cmd === 'send') return await cmd_send(a)
  if (a.cmd === 'export' && argv.includes('messages')) return await cmd_export_messages(a)

  print_help('slack', usage())
  die(`Error: unknown command: ${a.cmd}`, ExitCode.BAD_USAGE)
}

;(async () => {
  try {
    await main()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`Error: ${msg}`)
    process.exit(1)
  }
})()
