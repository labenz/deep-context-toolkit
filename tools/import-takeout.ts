#!/usr/bin/env bun

// import-takeout — load a Google Takeout export (Gmail mbox + Calendar .ics) into Deep Context.
//
// The "no-OAuth path": no Google Cloud project, no consent screen, no tokens. The user asks
// Google for an export at takeout.google.com, downloads the archive, and points this tool at it.
//
// HOW IT WORKS (two phases, both resumable)
//
//   1. SCAN  — stream the mbox byte-by-byte (multi-GB files never load into memory), parse each
//              message's headers + text body, and write it to a staging SQLite DB
//              (data/deep_context/takeout/staging-<account>.db). Spam, Trash, Drafts and Chats are
//              dropped here. The byte offset is checkpointed with every batch, so an interrupted
//              scan resumes where it stopped.
//   2. LOAD  — pick threads with the SAME policy the Gmail API extractor uses (threads you wrote
//              in, plus inbound threads from people you've emailed; Promotions/Updates/Social
//              excluded) and write them into threads/messages/people exactly as
//              gmail-extractor.ts would. Newest threads load first. Loaded threads are recorded,
//              so a re-run skips them.
//
// DEDUPE WITH THE API EXTRACTOR
//   Takeout's mbox separator line ("From 1781234567890123456@xxx ...") carries Gmail's message id
//   in decimal, and the X-GM-THRID header carries the thread id in decimal. The Gmail API uses the
//   same ids in hex. We store gmail:<hex> for both, so a later `extract gmail` sees the same rows
//   and skips/extends them instead of duplicating. As a second guard, messages whose RFC Message-ID
//   already exists in the thread are skipped.
//
// Calendar .ics files go to the calendar_events table (query with --source calendar).

import Database from 'bun:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, join, extname } from 'path'
import { createHash } from 'crypto'
import { gzipSync, gunzipSync } from 'zlib'
import { parse_flags, print_help, type ParsedArgs } from './_lib/cli'
import { normalize_account, DEFAULT_ACCOUNT } from './_lib/google_oauth'
import {
  convertHtmlToText,
  createPersonId,
  extractEmailAddr,
  extractDispName,
  stripQuotedContent,
} from './gmail-extractor'
import { OWNER_CONFIG } from './deep-context'
import { CALENDAR_SCHEMA } from './_lib/calendar-schema'

const TOOLS_DIR = import.meta.dir
const PROJECT_ROOT = dirname(TOOLS_DIR)
const DATA_DIR = join(PROJECT_ROOT, 'data/deep_context')
const SCHEMA_PATH = join(DATA_DIR, 'schema.sql')
const CONFIG_PATH = join(DATA_DIR, 'config.json')

const PLACEHOLDER_EMAIL = 'your@email.com'
const BULK_LABELS = new Set(['category promotions', 'category updates', 'category social'])
const DROP_LABELS: Record<string, string> = { spam: 'spam', trash: 'trash', chat: 'chat', chats: 'chat', draft: 'draft', drafts: 'draft' }
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024 // stop buffering a message's body beyond this (attachments)
const SCAN_BATCH = 2000 // messages per staging transaction (= checkpoint granularity)
const LOAD_BATCH = 200 // threads per main-DB transaction

// ============================================================
// CALENDAR TABLE (additive migration; mirrored in schema.sql)
// ============================================================

export function ensureCalendarTable(db: Database): void {
  db.exec(CALENDAR_SCHEMA)
}

// ============================================================
// SMALL HELPERS
// ============================================================

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)} KB`
  return `${n} B`
}

function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '?'
  if (sec < 90) return `${Math.round(sec)}s`
  if (sec < 5400) return `${Math.round(sec / 60)}m`
  return `${(sec / 3600).toFixed(1)}h`
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex')
}

/** Decimal Gmail id (Takeout) → hex id (Gmail API). Returns null if not a decimal number. */
export function gmailDecToHex(dec: string | undefined | null): string | null {
  if (!dec || !/^\d{6,25}$/.test(dec)) return null
  try {
    return BigInt(dec).toString(16)
  } catch {
    return null
  }
}

const decoderCache = new Map<string, TextDecoder | null>()
function decodeBytes(buf: Buffer, charset: string | undefined): string {
  let cs = (charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '').trim()
  if (cs === 'utf8') cs = 'utf-8'
  if (cs === 'us-ascii' || cs === 'ascii') cs = 'utf-8'
  let dec = decoderCache.get(cs)
  if (dec === undefined) {
    try {
      dec = new TextDecoder(cs)
    } catch {
      dec = null
    }
    decoderCache.set(cs, dec)
  }
  if (dec) {
    try {
      return dec.decode(buf)
    } catch {}
  }
  // Unknown charset: UTF-8 if it decodes cleanly, else Latin-1 (never throws)
  const utf = buf.toString('utf8')
  return utf.includes('�') ? buf.toString('latin1') : utf
}

/** A header value read as Latin-1 may really be raw UTF-8 (8-bit headers). Repair it. */
function fixRawHeaderBytes(v: string): string {
  if (!/[\x80-\xff]/.test(v)) return v
  const utf = Buffer.from(v, 'latin1').toString('utf8')
  return utf.includes('�') ? v : utf
}

function decodeQuotedPrintable(s: string): Buffer {
  const out: number[] = []
  const t = s.replace(/=\r?\n/g, '')
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c === 61 /* = */ && i + 2 < t.length + 0 && /^[0-9A-Fa-f]{2}$/.test(t.substr(i + 1, 2))) {
      out.push(parseInt(t.substr(i + 1, 2), 16))
      i += 2
    } else {
      out.push(c & 0xff)
    }
  }
  return Buffer.from(out)
}

/** RFC 2047 encoded-words: =?charset?B|Q?text?= */
export function decodeMimeWords(value: string): string {
  const v = fixRawHeaderBytes(value)
  if (!v.includes('=?')) return v
  return v
    .replace(/(=\?[^?]+\?[BbQq]\?[^?]*\?=)\s+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g, '$1') // whitespace between words is dropped
    .replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
      try {
        const cs = charset.split('*')[0] // RFC 2231 language suffix
        const buf = enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64')
          : decodeQuotedPrintable(text.replace(/_/g, ' '))
        return decodeBytes(buf, cs)
      } catch {
        return text
      }
    })
}

// ============================================================
// MIME PARSING (only what we need: text/plain + text/html, attachments skipped)
// ============================================================

type Headers = Map<string, string[]>

/** Parse an RFC 822 header block (Latin-1 string, CRLF or LF). Values are unfolded, not decoded. */
export function parseHeaderBlock(block: string): Headers {
  const headers: Headers = new Map()
  const lines = block.split(/\r?\n/)
  let name = ''
  let value = ''
  const flush = () => {
    if (!name) return
    const k = name.toLowerCase()
    const arr = headers.get(k)
    if (arr) arr.push(value.trim())
    else headers.set(k, [value.trim()])
  }
  for (const line of lines) {
    if (/^[ \t]/.test(line) && name) {
      value += ' ' + line.trim()
      continue
    }
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    flush()
    name = line.slice(0, idx).trim()
    value = line.slice(idx + 1)
  }
  flush()
  return headers
}

function hget(h: Headers, name: string): string | undefined {
  return h.get(name.toLowerCase())?.[0]
}

/** Split `type/sub; a=b; c="d"` into the type and lower-cased params. */
function parseParams(value: string | undefined): { value: string; params: Record<string, string> } {
  if (!value) return { value: '', params: {} }
  const parts = value.split(';')
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq < 0) continue
    const k = p.slice(0, eq).trim().toLowerCase()
    let v = p.slice(eq + 1).trim()
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
    params[k] = v
  }
  return { value: parts[0].trim().toLowerCase(), params }
}

function splitHeadBody(raw: string): { head: string; body: string } {
  const m = /\r?\n\r?\n/.exec(raw)
  if (!m) return { head: raw, body: '' }
  return { head: raw.slice(0, m.index), body: raw.slice(m.index + m[0].length) }
}

function decodeTransfer(body: string, encoding: string | undefined): Buffer {
  const enc = (encoding || '').toLowerCase().trim()
  if (enc === 'base64') return Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64')
  if (enc === 'quoted-printable') return decodeQuotedPrintable(body)
  return Buffer.from(body, 'latin1')
}

export interface MimeResult {
  text: string | null
  html: string | null
  hasAttachments: boolean
}

/**
 * Walk a MIME entity (head + body as a Latin-1 string — a lossless byte view) and return the first
 * text/plain and text/html bodies. Parts with a filename / attachment disposition are skipped and
 * only flagged. Depth-limited to stay safe on malformed mail.
 */
export function extractMimeBodies(headers: Headers, body: string, depth = 0, acc: MimeResult = { text: null, html: null, hasAttachments: false }): MimeResult {
  if (depth > 12) return acc
  const ct = parseParams(hget(headers, 'content-type') || 'text/plain')
  const disp = parseParams(hget(headers, 'content-disposition'))
  const isAttachment = disp.value === 'attachment' || !!disp.params.filename || !!disp.params['filename*'] || !!ct.params.name

  if (ct.value.startsWith('multipart/')) {
    const boundary = ct.params.boundary
    if (!boundary) return acc
    const delim = '--' + boundary
    const segments = body.split(delim)
    // segments[0] = preamble; last segment starts with "--" (closing delimiter)
    for (let i = 1; i < segments.length; i++) {
      let seg = segments[i]
      if (seg.startsWith('--')) break
      seg = seg.replace(/^[ \t]*\r?\n/, '')
      const { head, body: partBody } = splitHeadBody(seg)
      const partHeaders = parseHeaderBlock(head)
      extractMimeBodies(partHeaders, partBody.replace(/\r?\n$/, ''), depth + 1, acc)
    }
    return acc
  }

  if (ct.value === 'message/rfc822') {
    // Forwarded message as attachment — counts as an attachment, body not inlined.
    acc.hasAttachments = true
    return acc
  }

  if (isAttachment) {
    acc.hasAttachments = true
    return acc
  }

  if (ct.value === 'text/plain' || ct.value === 'text/html' || ct.value === '' ) {
    const buf = decodeTransfer(body, hget(headers, 'content-transfer-encoding'))
    const decoded = decodeBytes(buf, ct.params.charset)
    if (ct.value === 'text/html') {
      if (acc.html === null) acc.html = decoded
    } else if (acc.text === null) {
      acc.text = decoded
    }
    return acc
  }

  // Anything else (images, calendar invites, pdfs …) is attachment-like
  acc.hasAttachments = true
  return acc
}

// ============================================================
// INPUT DISCOVERY (zip / tgz / tar / directory / bare files)
// ============================================================

interface InputFile {
  kind: 'mbox' | 'ics'
  key: string // stable checkpoint key
  label: string // human-readable
  size: number | null
  open: () => ReadableStream<Uint8Array>
}

function escapeUnzipPattern(name: string): string {
  return name.replace(/([\\*?[\]])/g, '\\$1')
}

function classify(name: string): 'mbox' | 'ics' | null {
  const lower = name.toLowerCase()
  if (lower.endsWith('.mbox')) return 'mbox'
  if (lower.endsWith('.ics')) return 'ics'
  return null
}

function spawnStream(cmd: string[]): ReadableStream<Uint8Array> {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
  return proc.stdout as ReadableStream<Uint8Array>
}

function discoverInputs(paths: string[]): InputFile[] {
  const out: InputFile[] = []
  for (const p of paths) {
    if (!existsSync(p)) throw new Error(`Not found: ${p}`)
    const st = statSync(p)
    if (st.isDirectory()) {
      const walk = (dir: string) => {
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, ent.name)
          if (ent.isDirectory()) walk(full)
          else {
            const kind = classify(ent.name)
            if (kind) {
              const size = statSync(full).size
              out.push({ kind, key: `file:${full}:${size}`, label: full, size, open: () => Bun.file(full).stream() })
            }
          }
        }
      }
      walk(p)
      continue
    }
    const lower = p.toLowerCase()
    if (lower.endsWith('.zip')) {
      const listing = Bun.spawnSync(['unzip', '-l', p]).stdout.toString()
      for (const line of listing.split('\n')) {
        const m = /^\s*(\d+)\s+\S+\s+\S+\s+(.+)$/.exec(line)
        if (!m) continue
        const name = m[2]
        const kind = classify(name)
        if (!kind) continue
        const size = parseInt(m[1], 10)
        out.push({ kind, key: `zip:${basename(p)}:${name}:${size}`, label: `${basename(p)} → ${name}`, size, open: () => spawnStream(['unzip', '-p', p, escapeUnzipPattern(name)]) })
      }
      continue
    }
    if (/\.(tgz|tar\.gz|tar|tbz2?|tar\.bz2)$/.test(lower)) {
      const listing = Bun.spawnSync(['tar', '-tf', p]).stdout.toString()
      for (const name of listing.split('\n').map(s => s.trim()).filter(Boolean)) {
        const kind = classify(name)
        if (!kind) continue
        out.push({ kind, key: `tar:${basename(p)}:${name}`, label: `${basename(p)} → ${name}`, size: null, open: () => spawnStream(['tar', '-xOf', p, name]) })
      }
      continue
    }
    const kind = classify(p)
    if (kind) {
      out.push({ kind, key: `file:${p}:${st.size}`, label: p, size: st.size, open: () => Bun.file(p).stream() })
      continue
    }
    throw new Error(`Don't know how to read ${p} (expected a Takeout .zip/.tgz, a folder, or a .mbox/.ics file)`)
  }
  return out
}

// ============================================================
// STREAMING LINE READER (byte offsets, no full-file buffering)
// ============================================================

/**
 * Yields lines (without the trailing \n) as Latin-1 strings — a lossless 1:1 view of the bytes —
 * together with the byte offset at which each line starts. `skip` bytes are discarded first
 * (used to resume a checkpointed scan; works for pipes too).
 */
async function* readLines(stream: ReadableStream<Uint8Array>, skip = 0): AsyncGenerator<{ line: string; offset: number }> {
  let offset = 0
  let carry: Buffer = Buffer.alloc(0)
  let carryOffset = 0
  for await (const chunkRaw of stream as unknown as AsyncIterable<Uint8Array>) {
    let chunk = Buffer.from(chunkRaw.buffer, chunkRaw.byteOffset, chunkRaw.byteLength)
    if (offset < skip) {
      const need = skip - offset
      if (chunk.length <= need) {
        offset += chunk.length
        continue
      }
      chunk = chunk.subarray(need)
      offset = skip
      carryOffset = skip
    }
    const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk
    const base = carry.length ? carryOffset : offset
    let start = 0
    let nl = buf.indexOf(10, start)
    while (nl !== -1) {
      yield { line: buf.toString('latin1', start, nl), offset: base + start }
      start = nl + 1
      nl = buf.indexOf(10, start)
    }
    offset += chunk.length
    carry = start < buf.length ? Buffer.from(buf.subarray(start)) : Buffer.alloc(0)
    carryOffset = base + start
  }
  if (carry.length) yield { line: carry.toString('latin1'), offset: carryOffset }
}

// ============================================================
// STAGING DB
// ============================================================

const STAGING_SCHEMA = `
CREATE TABLE IF NOT EXISTS msgs (
  gmail_id TEXT PRIMARY KEY,      -- hex Gmail message id (= API id), or mid-<sha1(Message-ID)>
  thread_id TEXT NOT NULL,        -- hex Gmail thread id (= API id), or ref-<sha1(root Message-ID)>
  ts TEXT NOT NULL,
  from_raw TEXT,
  from_email TEXT,
  to_raw TEXT,
  cc_raw TEXT,
  bcc_raw TEXT,
  subject TEXT,
  message_id_hdr TEXT,
  in_reply_to TEXT,
  labels TEXT,                    -- JSON array of X-Gmail-Labels
  bulk INTEGER DEFAULT 0,         -- Promotions / Updates / Social
  body BLOB,                      -- gzip of the chosen body part
  body_is_html INTEGER DEFAULT 0,
  has_attachments INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_msgs_thread ON msgs(thread_id);
CREATE INDEX IF NOT EXISTS idx_msgs_from ON msgs(from_email);
CREATE TABLE IF NOT EXISTS scan_state (
  source_key TEXT PRIMARY KEY,
  byte_offset INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  messages INTEGER NOT NULL DEFAULT 0,
  dropped TEXT,                   -- JSON counts by reason
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS loaded (
  thread_id TEXT PRIMARY KEY,
  msg_count INTEGER NOT NULL,
  excluded INTEGER NOT NULL DEFAULT 0, -- skipped by the privacy list
  loaded_at TEXT
);
`

function openStaging(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 30000;')
  db.exec(STAGING_SCHEMA)
  return db
}

// ============================================================
// PHASE 1: SCAN MBOX → STAGING
// ============================================================

const FROM_LINE = /^From (\S+) +(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /

interface ScanStats {
  messages: number
  dropped: Record<string, number>
  paused?: boolean
}

function parseLabels(raw: string | undefined): string[] {
  if (!raw) return []
  return decodeMimeWords(raw).split(',').map(s => s.trim()).filter(Boolean)
}

/** Build the staging row for one raw message (Latin-1 string of its bytes). */
function stageMessage(fromLineId: string, fromLineDate: string, rawHead: string, rawBody: string | null): { row: any[] | null; dropReason?: string } {
  const headers = parseHeaderBlock(rawHead)
  const labels = parseLabels(hget(headers, 'x-gmail-labels'))
  for (const l of labels) {
    const reason = DROP_LABELS[l.toLowerCase()]
    if (reason) return { row: null, dropReason: reason }
  }
  const bulk = labels.some(l => BULK_LABELS.has(l.toLowerCase())) ? 1 : 0

  const messageIdHdr = (hget(headers, 'message-id') || '').trim() || null
  const inReplyTo = (hget(headers, 'in-reply-to') || '').trim() || null
  const references = (hget(headers, 'references') || '').match(/<[^>]+>/g) || []

  let gmailId = gmailDecToHex(fromLineId)
  if (!gmailId) {
    const basis = messageIdHdr || `${hget(headers, 'date')}|${hget(headers, 'from')}|${hget(headers, 'subject')}`
    gmailId = `mid-${sha1(basis).slice(0, 20)}`
  }
  let threadId = gmailDecToHex(hget(headers, 'x-gm-thrid'))
  if (!threadId) {
    const root = references[0] || inReplyTo || messageIdHdr || gmailId
    threadId = `ref-${sha1(root).slice(0, 20)}`
  }

  const dateHdr = hget(headers, 'date')
  let ts: string | null = null
  for (const candidate of [dateHdr, fromLineDate]) {
    if (!candidate) continue
    const d = new Date(candidate.replace(/\s*\([^)]*\)\s*$/, ''))
    if (!isNaN(d.getTime())) { ts = d.toISOString(); break }
  }
  if (!ts) ts = new Date(0).toISOString()

  const fromRaw = decodeMimeWords(hget(headers, 'from') || '')
  const toRaw = decodeMimeWords((headers.get('to') || []).join(', '))
  const ccRaw = decodeMimeWords((headers.get('cc') || []).join(', '))
  const bccRaw = decodeMimeWords((headers.get('bcc') || []).join(', '))
  const subject = decodeMimeWords(hget(headers, 'subject') || '')

  let body: Buffer | null = null
  let isHtml = 0
  let hasAttachments = 0
  if (rawBody !== null) {
    const mime = extractMimeBodies(headers, rawBody)
    hasAttachments = mime.hasAttachments ? 1 : 0
    const chosen = mime.text ?? mime.html
    isHtml = mime.text === null && mime.html !== null ? 1 : 0
    if (chosen) body = gzipSync(Buffer.from(chosen, 'utf8'), { level: 4 })
  }

  return {
    row: [
      gmailId, threadId, ts, fromRaw, extractEmailAddr(fromRaw), toRaw, ccRaw, bccRaw, subject,
      messageIdHdr, inReplyTo, JSON.stringify(labels), bulk, body, isHtml, hasAttachments,
    ],
  }
}

async function scanMbox(staging: Database, input: InputFile, opts: { rescan: boolean; quiet?: boolean; stopAfter?: number }): Promise<ScanStats> {
  const state = staging.query(`SELECT byte_offset, done, messages, dropped FROM scan_state WHERE source_key = ?`).get(input.key) as { byte_offset: number; done: number; messages: number; dropped: string | null } | null
  const stats: ScanStats = { messages: state?.messages ?? 0, dropped: state?.dropped ? JSON.parse(state.dropped) : {} }
  if (state?.done && !opts.rescan) {
    if (!opts.quiet) console.log(`  ✓ already scanned: ${input.label} (${stats.messages.toLocaleString()} messages staged)`)
    return stats
  }
  const startOffset = opts.rescan ? 0 : (state?.byte_offset ?? 0)
  if (opts.rescan) { stats.messages = 0; stats.dropped = {} }
  if (!opts.quiet) console.log(`  Scanning ${input.label}${input.size ? ` (${fmtBytes(input.size)})` : ''}${startOffset ? ` — resuming at ${fmtBytes(startOffset)}` : ''}`)

  const insert = staging.prepare(`INSERT OR REPLACE INTO msgs (gmail_id, thread_id, ts, from_raw, from_email, to_raw, cc_raw, bcc_raw, subject, message_id_hdr, in_reply_to, labels, bulk, body, body_is_html, has_attachments) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  const saveState = staging.prepare(`INSERT INTO scan_state (source_key, byte_offset, done, messages, dropped, updated_at) VALUES (?,?,?,?,?,datetime('now'))
    ON CONFLICT(source_key) DO UPDATE SET byte_offset=excluded.byte_offset, done=excluded.done, messages=excluded.messages, dropped=excluded.dropped, updated_at=excluded.updated_at`)

  let pending: any[][] = []
  const flush = (checkpoint: number, done: boolean) => {
    staging.transaction(() => {
      for (const r of pending) insert.run(...r)
      saveState.run(input.key, checkpoint, done ? 1 : 0, stats.messages, JSON.stringify(stats.dropped))
    })()
    pending = []
  }

  // Current message being assembled
  let cur: { id: string; date: string; offset: number; headLines: string[]; inHead: boolean; bodyParts: string[]; bodyBytes: number; skipBody: boolean; dropReason?: string } | null = null
  const finish = () => {
    if (!cur) return
    if (cur.dropReason) {
      stats.dropped[cur.dropReason] = (stats.dropped[cur.dropReason] || 0) + 1
    } else {
      const head = cur.headLines.join('\n')
      const body = cur.skipBody ? null : cur.bodyParts.join('\n')
      const res = stageMessage(cur.id, cur.date, head, body)
      if (res.row) { pending.push(res.row); stats.messages++ }
      else if (res.dropReason) stats.dropped[res.dropReason] = (stats.dropped[res.dropReason] || 0) + 1
    }
    cur = null
  }

  const t0 = Date.now()
  const startCount = stats.messages
  let lastReport = t0
  let prevBlank = true
  let lastOffset = startOffset
  for await (const { line: rawLine, offset } of readLines(input.open(), startOffset)) {
    lastOffset = offset
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (prevBlank || !cur) {
      const m = line.startsWith('From ') ? FROM_LINE.exec(line) : null
      if (m) {
        finish()
        // Checkpoint BEFORE starting a new message: everything before `offset` is fully staged.
        if (opts.stopAfter && stats.messages - startCount >= opts.stopAfter) {
          flush(offset, false)
          if (!opts.quiet) console.log(`  … paused at ${fmtBytes(offset)} (${stats.messages.toLocaleString()} staged) — re-run to continue`)
          return { ...stats, paused: true }
        }
        if (pending.length >= SCAN_BATCH) flush(offset, false)
        const sp = line.indexOf(' ', 5)
        const fromId = m[1].split('@')[0]
        cur = { id: fromId, date: line.slice(sp + 1), offset, headLines: [], inHead: true, bodyParts: [], bodyBytes: 0, skipBody: false }
        prevBlank = false
        continue
      }
    }
    prevBlank = line.length === 0
    if (!cur) continue
    if (cur.inHead) {
      if (line.length === 0) {
        cur.inHead = false
        // Decide early whether this message is dropped, so we never buffer its body.
        const labelsLine = cur.headLines.find(l => /^x-gmail-labels:/i.test(l))
        if (labelsLine) {
          const idx = cur.headLines.indexOf(labelsLine)
          let full = labelsLine
          for (let j = idx + 1; j < cur.headLines.length && /^[ \t]/.test(cur.headLines[j]); j++) full += ' ' + cur.headLines[j].trim()
          for (const l of parseLabels(full.slice(full.indexOf(':') + 1))) {
            const r = DROP_LABELS[l.toLowerCase()]
            if (r) { cur.dropReason = r; cur.skipBody = true; break }
          }
        }
      } else {
        cur.headLines.push(line)
      }
      continue
    }
    if (cur.skipBody) continue
    if (cur.bodyBytes > MAX_MESSAGE_BYTES) continue
    // mboxrd/mboxo un-escaping of ">From " lines
    const bodyLine = /^>+From /.test(line) ? line.slice(1) : line
    cur.bodyParts.push(bodyLine)
    cur.bodyBytes += bodyLine.length + 1

    if (!opts.quiet && Date.now() - lastReport > 5000) {
      lastReport = Date.now()
      const done = offset - startOffset
      const rate = done / ((Date.now() - t0) / 1000)
      const pct = input.size ? ` (${((offset / input.size) * 100).toFixed(1)}%)` : ''
      const eta = input.size ? ` · ETA ${fmtDuration((input.size - offset) / rate)}` : ''
      console.log(`    ${fmtBytes(offset)}${input.size ? ` / ${fmtBytes(input.size)}` : ''}${pct} · ${stats.messages.toLocaleString()} msgs · ${fmtBytes(rate)}/s${eta}`)
    }
  }
  finish()
  flush(lastOffset, true)
  const secs = (Date.now() - t0) / 1000
  if (!opts.quiet) {
    const droppedStr = Object.entries(stats.dropped).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(', ')
    console.log(`  ✓ scanned in ${fmtDuration(secs)}: ${stats.messages.toLocaleString()} messages staged${droppedStr ? ` · skipped ${droppedStr}` : ''}`)
  }
  return stats
}

// ============================================================
// PHASE 2: LOAD STAGING → DEEP CONTEXT
// ============================================================

interface LoadOpts {
  source: string
  ownerId: string
  ownerDisplayName: string
  owner: Set<string>
  agents: Map<string, string>
  excluded: Set<string>
  since?: string
  limit?: number
  dryRun: boolean
  quiet?: boolean
}

interface LoadStats {
  candidateThreads: number
  ownerThreads: number
  inboundThreads: number
  newThreads: number
  updatedThreads: number
  unchangedThreads: number
  newMessages: number
  skippedDuplicateMessages: number
  excludedThreads: number
  knownContacts: number
}

function splitRecipients(field: string): Array<{ email: string; displayName: string }> {
  // Same naive comma split as gmail-extractor.ts — deliberately, so person IDs match the API path.
  const out: Array<{ email: string; displayName: string }> = []
  for (const recipient of (field || '').split(',')) {
    const r = recipient.trim()
    if (!r) continue
    const email = extractEmailAddr(r)
    if (email && email.includes('@')) out.push({ email, displayName: extractDispName(r) })
  }
  return out
}

function isNoReply(email: string): boolean {
  return email.includes('noreply') || email.includes('no-reply')
}

interface Cand { thread_id: string; kind: string; last_ts: string; n: number; loaded_count: number | null; loaded_excluded: number | null }

interface StagedMsg {
  gmail_id: string
  thread_id: string
  ts: string
  from_raw: string
  from_email: string
  to_raw: string
  cc_raw: string
  bcc_raw: string
  subject: string
  message_id_hdr: string | null
  in_reply_to: string | null
  labels: string
  bulk: number
  body: Uint8Array | null
  body_is_html: number
  has_attachments: number
}

function bodyText(m: StagedMsg): string {
  if (!m.body) return ''
  const s = gunzipSync(Buffer.from(m.body)).toString('utf8')
  return m.body_is_html ? convertHtmlToText(s) : s
}

function loadIntoDb(db: Database, staging: Database, o: LoadOpts): LoadStats {
  const stats: LoadStats = { candidateThreads: 0, ownerThreads: 0, inboundThreads: 0, newThreads: 0, updatedThreads: 0, unchangedThreads: 0, newMessages: 0, skippedDuplicateMessages: 0, excludedThreads: 0, knownContacts: 0 }

  // --- 1. Owner threads: any non-bulk message FROM one of the owner's addresses
  //        (API pass 1: `from:me -category:promotions -category:updates -category:social`)
  staging.exec(`DROP TABLE IF EXISTS temp.owner_addr; CREATE TEMP TABLE owner_addr (email TEXT PRIMARY KEY)`)
  const insOwner = staging.prepare(`INSERT OR IGNORE INTO temp.owner_addr VALUES (?)`)
  for (const e of o.owner) insOwner.run(e)
  const ownerThreadIds = new Set((staging.query(`SELECT DISTINCT thread_id FROM msgs WHERE bulk = 0 AND from_email IN (SELECT email FROM temp.owner_addr)`).all() as { thread_id: string }[]).map(r => r.thread_id))

  // --- 2. Known contacts: everyone in From/To/Cc of the owner's threads (API pass 2 uses the
  //        participants of threads you wrote in). Plus contacts already in the DB from API runs.
  const known = new Set<string>()
  const partQ = staging.prepare(`SELECT from_email, to_raw, cc_raw FROM msgs WHERE thread_id = ?`)
  for (const tid of ownerThreadIds) {
    for (const r of partQ.all(tid) as { from_email: string; to_raw: string; cc_raw: string }[]) {
      if (r.from_email) known.add(r.from_email)
      for (const x of [...splitRecipients(r.to_raw), ...splitRecipients(r.cc_raw)]) known.add(x.email)
    }
  }
  try {
    const rows = db.query(`
      SELECT DISTINCT p.identifiers FROM threads t, json_each(t.participant_ids) je
      JOIN people p ON p.id = je.value
      WHERE t.source = ? AND t.my_message_count > 0 AND je.value != ?`).all(o.source, o.ownerId) as { identifiers: string }[]
    for (const r of rows) {
      try { for (const id of JSON.parse(r.identifiers) as string[]) if (id.includes('@')) known.add(id.toLowerCase()) } catch {}
    }
  } catch {}
  for (const e of o.owner) known.delete(e)
  for (const e of [...known]) if (isNoReply(e) || e.startsWith('slack:')) known.delete(e)
  stats.knownContacts = known.size

  staging.exec(`DROP TABLE IF EXISTS temp.known_addr; CREATE TEMP TABLE known_addr (email TEXT PRIMARY KEY)`)
  const insKnown = staging.prepare(`INSERT OR IGNORE INTO temp.known_addr VALUES (?)`)
  staging.transaction(() => { for (const e of known) insKnown.run(e) })()
  const inboundThreadIds = new Set((staging.query(`SELECT DISTINCT thread_id FROM msgs WHERE bulk = 0 AND from_email IN (SELECT email FROM temp.known_addr)`).all() as { thread_id: string }[]).map(r => r.thread_id))
  for (const t of ownerThreadIds) inboundThreadIds.delete(t)

  // --- 3. Order newest-first, apply --since / --limit
  staging.exec(`DROP TABLE IF EXISTS temp.cand; CREATE TEMP TABLE cand (thread_id TEXT PRIMARY KEY, kind TEXT)`)
  const insCand = staging.prepare(`INSERT OR IGNORE INTO temp.cand VALUES (?, ?)`)
  staging.transaction(() => {
    for (const t of ownerThreadIds) insCand.run(t, 'owner')
    for (const t of inboundThreadIds) insCand.run(t, 'inbound')
  })()
  let candSql = `
    SELECT c.thread_id, c.kind, MAX(m.ts) AS last_ts, COUNT(*) AS n, l.msg_count AS loaded_count, l.excluded AS loaded_excluded
    FROM temp.cand c JOIN msgs m ON m.thread_id = c.thread_id
    LEFT JOIN loaded l ON l.thread_id = c.thread_id
    GROUP BY c.thread_id`
  const params: any[] = []
  if (o.since) { candSql += ` HAVING MAX(m.ts) >= ?`; params.push(o.since) }
  candSql += ` ORDER BY last_ts DESC`
  if (o.limit) { candSql += ` LIMIT ?`; params.push(o.limit) }
  const candidates = staging.query(candSql).all(...params) as Cand[]
  stats.candidateThreads = candidates.length
  stats.ownerThreads = candidates.filter(c => c.kind === 'owner').length
  stats.inboundThreads = candidates.length - stats.ownerThreads

  if (!o.quiet) {
    console.log(`  Threads you wrote in: ${stats.ownerThreads.toLocaleString()} · inbound from ${known.size.toLocaleString()} known contacts: ${stats.inboundThreads.toLocaleString()}${o.since ? ` (active since ${o.since})` : ''}`)
  }
  if (o.dryRun) return stats

  // --- 4. Write, mirroring gmail-extractor.ts processGmailThread()
  if (!db.query(`SELECT id FROM people WHERE id = ?`).get(o.ownerId)) {
    db.query(`INSERT INTO people (id, display_name, identifiers, first_seen) VALUES (?, ?, ?, datetime('now'))`).run(o.ownerId, o.ownerDisplayName, JSON.stringify([[...o.owner][0] || '']))
  }

  const msgsQ = staging.prepare(`SELECT * FROM msgs WHERE thread_id = ? ORDER BY ts ASC, gmail_id ASC`)
  const markLoadedStmt = staging.prepare(`INSERT INTO loaded (thread_id, msg_count, excluded, loaded_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(thread_id) DO UPDATE SET msg_count = excluded.msg_count, excluded = excluded.excluded, loaded_at = excluded.loaded_at`)
  const markLoaded = (tid: string, n: number, excl = 0) => markLoadedStmt.run(tid, n, excl)
  const getThread = db.prepare(`SELECT id, participant_ids FROM threads WHERE id = ?`)
  const getPerson = db.prepare(`SELECT id, identifiers FROM people WHERE id = ?`)
  const insPerson = db.prepare(`INSERT INTO people (id, display_name, identifiers, first_seen, last_seen, thread_count) VALUES (?, ?, ?, ?, ?, 1)`)
  const updPersonIds = db.prepare(`UPDATE people SET identifiers = ?, last_seen = MAX(COALESCE(last_seen, ''), ?), thread_count = thread_count + ? WHERE id = ?`)
  const msgExists = db.prepare(`SELECT 1 FROM messages WHERE id = ?`)
  const threadMsgIds = db.prepare(`
    SELECT json_extract(h.value, '$.value') AS mid FROM messages m, json_each(m.raw_json, '$.headers') h
    WHERE m.thread_id = ? AND lower(json_extract(h.value, '$.name')) = 'message-id'`)
  const insThread = db.prepare(`INSERT INTO threads (id, source, source_thread_id, source_url, subject, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const updThread = db.prepare(`
    UPDATE threads SET
      started_at = MIN(COALESCE(started_at, ?), ?),
      last_activity_at = MAX(COALESCE(last_activity_at, ''), ?),
      message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ?),
      my_message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ? AND is_from_me = 1),
      participant_ids = ?
    WHERE id = ?`)
  const insMsg = db.prepare(`INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, reply_to_message_id, recipients, has_attachments, word_count, raw_json, authored_by, authorship_evidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, ?, ?, ?, ?, ?)`)

  const personIdFor = (displayName: string | undefined, email: string) => o.agents.get(email) ?? createPersonId(displayName, email)

  const t0 = Date.now()
  let lastReport = t0
  let processed = 0

  const processThread = (cand: Cand) => {
    const dbThreadId = `${o.source}:${cand.thread_id}`
    // Fast path for re-runs: already loaded with the same message count (and still in the DB —
    // if the DB was rebuilt, load again).
    if (cand.loaded_count !== null && cand.loaded_count >= cand.n && (cand.loaded_excluded || getThread.get(dbThreadId))) {
      stats.unchangedThreads++
      return
    }
    const msgs = msgsQ.all(cand.thread_id) as StagedMsg[]
    if (msgs.length === 0) return

    // Privacy: never-touch addresses from config.json privacy.excluded_emails
    if (o.excluded.size) {
      const touches = msgs.some(m => o.excluded.has(m.from_email) || [...splitRecipients(m.to_raw), ...splitRecipients(m.cc_raw)].some(r => o.excluded.has(r.email)))
      if (touches) { stats.excludedThreads++; markLoaded(cand.thread_id, cand.n, 1); return }
    }

    const startedAt = msgs[0].ts
    const lastActivityAt = msgs[msgs.length - 1].ts
    const subject = msgs[0].subject || '(No Subject)'

    // Participants, exactly as processGmailThread collects them
    let myMessageCount = 0
    const participantEmails = new Map<string, { displayName: string; email: string }>()
    for (const m of msgs) {
      const isFromMe = o.owner.has(m.from_email)
      if (isFromMe) myMessageCount++
      else if (!participantEmails.has(m.from_email)) participantEmails.set(m.from_email, { displayName: extractDispName(m.from_raw), email: m.from_email })
      for (const r of [...splitRecipients(m.to_raw), ...splitRecipients(m.cc_raw)]) {
        if (!o.owner.has(r.email) && !participantEmails.has(r.email)) participantEmails.set(r.email, r)
      }
    }

    const existing = getThread.get(dbThreadId) as { id: string; participant_ids: string | null } | null
    const priorParticipants = new Set<string>(existing?.participant_ids ? JSON.parse(existing.participant_ids) : [])
    const participantIds: string[] = existing ? [...priorParticipants] : [o.ownerId]
    if (!participantIds.includes(o.ownerId)) participantIds.unshift(o.ownerId)

    for (const [email, info] of participantEmails) {
      const personId = personIdFor(info.displayName, email)
      if (!personId || personId === o.ownerId) continue
      const newToThread = !priorParticipants.has(personId) && !participantIds.includes(personId)
      if (!participantIds.includes(personId)) participantIds.push(personId)
      const person = getPerson.get(personId) as { id: string; identifiers: string } | null
      if (!person) {
        insPerson.run(personId, info.displayName || email.split('@')[0], JSON.stringify([email]), startedAt, lastActivityAt)
      } else {
        const ids = JSON.parse(person.identifiers || '[]') as string[]
        if (!ids.includes(email)) ids.push(email)
        // thread_count only moves when this person is new to this thread (keeps re-imports idempotent)
        updPersonIds.run(JSON.stringify(ids), lastActivityAt, newToThread ? 1 : 0, personId)
      }
    }

    if (!existing) {
      insThread.run(dbThreadId, o.source, cand.thread_id, `https://mail.google.com/mail/u/0/#inbox/${cand.thread_id}`, subject, startedAt, lastActivityAt, msgs.length, myMessageCount, JSON.stringify(participantIds), participantIds.length > 2 ? 'group' : '1:1')
      stats.newThreads++
    }

    const knownMsgIds = existing ? new Set((threadMsgIds.all(dbThreadId) as { mid: string }[]).map(r => (r.mid || '').trim())) : new Set<string>()
    let added = 0
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]
      const messageId = `${o.source}:${m.gmail_id}`
      if (msgExists.get(messageId)) continue
      if (m.message_id_hdr && knownMsgIds.has(m.message_id_hdr)) { stats.skippedDuplicateMessages++; continue }

      const isFromMe = o.owner.has(m.from_email)
      const senderId = isFromMe ? o.ownerId : personIdFor(extractDispName(m.from_raw), m.from_email)
      let content = bodyText(m)
      if (isFromMe) content = stripQuotedContent(content)

      let replyTo: string | null = null
      if (m.in_reply_to && i > 0) {
        for (let j = i - 1; j >= 0; j--) {
          if (msgs[j].message_id_hdr === m.in_reply_to) { replyTo = `${o.source}:${msgs[j].gmail_id}`; break }
        }
      }

      let authoredBy: string | null = null
      let authorshipEvidence: string | null = null
      const agentId = o.agents.get(m.from_email)
      if (agentId) {
        authoredBy = agentId
        authorshipEvidence = `agent-address: ${m.from_email}`
      } else if (isFromMe && !m.message_id_hdr) {
        authorshipEvidence = 'api-sent (no Message-ID) — authorship unjudged'
      }

      const headers: Array<{ name: string; value: string }> = []
      const push = (name: string, value: string | null | undefined) => { if (value) headers.push({ name, value }) }
      push('From', m.from_raw); push('To', m.to_raw); push('Cc', m.cc_raw); push('Subject', m.subject)
      push('Date', m.ts); push('Message-ID', m.message_id_hdr); push('In-Reply-To', m.in_reply_to)

      insMsg.run(
        messageId, dbThreadId, o.source, m.gmail_id, m.ts, i + 1, senderId || o.ownerId, isFromMe ? 1 : 0,
        content, replyTo,
        JSON.stringify({
          to: (m.to_raw || '').split(',').map(s => s.trim()).filter(Boolean),
          cc: (m.cc_raw || '').split(',').map(s => s.trim()).filter(Boolean),
          bcc: (m.bcc_raw || '').split(',').map(s => s.trim()).filter(Boolean),
        }),
        m.has_attachments ? 1 : 0,
        content.split(/\s+/).filter(Boolean).length,
        JSON.stringify({ headers, labels: JSON.parse(m.labels || '[]'), imported_from: 'google-takeout' }),
        authoredBy, authorshipEvidence,
      )
      added++
      stats.newMessages++
    }

    if (existing) {
      if (added > 0 || participantIds.length !== priorParticipants.size) {
        updThread.run(startedAt, startedAt, lastActivityAt, dbThreadId, dbThreadId, JSON.stringify(participantIds), dbThreadId)
        stats.updatedThreads++
      } else {
        stats.unchangedThreads++
      }
    }
    markLoaded(cand.thread_id, cand.n)
  }

  for (let i = 0; i < candidates.length; i += LOAD_BATCH) {
    const batch = candidates.slice(i, i + LOAD_BATCH)
    db.transaction(() => { for (const c of batch) processThread(c) })()
    processed += batch.length
    if (!o.quiet && (Date.now() - lastReport > 5000 || processed === candidates.length)) {
      lastReport = Date.now()
      const rate = processed / ((Date.now() - t0) / 1000)
      console.log(`    ${processed.toLocaleString()} / ${candidates.length.toLocaleString()} threads · ${stats.newMessages.toLocaleString()} new messages · ETA ${fmtDuration((candidates.length - processed) / rate)}`)
    }
  }
  return stats
}

// ============================================================
// CALENDAR (.ics)
// ============================================================

interface IcsProp { name: string; params: Record<string, string>; value: string }

function parseIcsLine(line: string): IcsProp | null {
  // NAME;PARAM=VAL;PARAM="V:AL":VALUE — split on the first ':' outside quotes
  let inQ = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQ = !inQ
    else if (c === ':' && !inQ) { colon = i; break }
  }
  if (colon < 0) return null
  const left = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts = left.split(';')
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=')
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
  }
  return { name: parts[0].toUpperCase(), params, value }
}

function unescapeIcsText(v: string): string {
  return v.replace(/\\[nN]/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

/** Offset (ms) of `tz` from UTC at the given UTC instant. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map(p => [p.type, p.value]))
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second)
  return asUtc - utcMs
}

/** ICS date/date-time → { iso, allDay }. Converts TZID-local times to UTC when the zone is known. */
export function icsDate(prop: IcsProp | undefined): { iso: string | null; allDay: boolean; tz: string | null } {
  if (!prop) return { iso: null, allDay: false, tz: null }
  const v = prop.value.trim()
  const tz = prop.params.TZID || null
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (m || prop.params.VALUE === 'DATE') {
    m = m || /^(\d{4})(\d{2})(\d{2})/.exec(v)
    return { iso: m ? `${m[1]}-${m[2]}-${m[3]}` : v, allDay: true, tz }
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)
  if (!m) return { iso: v, allDay: false, tz }
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  const naive = Date.UTC(y, mo - 1, d, h, mi, s)
  if (m[7] === 'Z') return { iso: new Date(naive).toISOString(), allDay: false, tz }
  if (tz) {
    try {
      let guess = naive - tzOffsetMs(naive, tz)
      guess = naive - tzOffsetMs(guess, tz) // second pass handles DST edges
      return { iso: new Date(guess).toISOString(), allDay: false, tz }
    } catch {}
  }
  // Floating time or unknown zone: keep local wall-clock time without a Z
  return { iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, allDay: false, tz }
}

interface CalStats { events: number; inserted: number; updated: number; skippedOld: number }

async function importIcs(db: Database, input: InputFile, o: { owner: Set<string>; since?: string; dryRun: boolean; quiet?: boolean }): Promise<CalStats> {
  const stats: CalStats = { events: 0, inserted: 0, updated: 0, skippedOld: 0 }
  const calendarName = basename(input.label.split(' → ').pop() || input.label).replace(/\.ics$/i, '')
  // Takeout names your primary calendar after your address — use it if we don't know who you are.
  const owner = o.owner.size === 0 && /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(calendarName) ? new Set([calendarName.toLowerCase()]) : o.owner
  const exists = db.prepare(`SELECT 1 FROM calendar_events WHERE id = ?`)
  const upsert = db.prepare(`
    INSERT INTO calendar_events (id, source, calendar_name, uid, recurrence_id, summary, description, location, start_at, end_at, all_day, timezone, rrule, status, organizer, is_organizer, attendees, my_response, conference_url, created_at, updated_at, raw_json)
    VALUES (?, 'calendar', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET calendar_name=excluded.calendar_name, summary=excluded.summary, description=excluded.description, location=excluded.location,
      start_at=excluded.start_at, end_at=excluded.end_at, all_day=excluded.all_day, timezone=excluded.timezone, rrule=excluded.rrule, status=excluded.status,
      organizer=excluded.organizer, is_organizer=excluded.is_organizer, attendees=excluded.attendees, my_response=excluded.my_response,
      conference_url=excluded.conference_url, created_at=excluded.created_at, updated_at=excluded.updated_at, raw_json=excluded.raw_json`)

  const pending: any[][] = []
  const flush = () => {
    if (o.dryRun) { pending.length = 0; return }
    db.transaction(() => {
      for (const r of pending) {
        if (exists.get(r[0])) stats.updated++
        else stats.inserted++
        upsert.run(...r)
      }
    })()
    pending.length = 0
  }

  let props: IcsProp[] | null = null
  let depth = 0 // nesting inside VEVENT (VALARM etc.)
  let prevLine: string | null = null

  const handle = (line: string) => {
    if (line === 'BEGIN:VEVENT') { props = []; depth = 0; return }
    if (!props) return
    if (line.startsWith('BEGIN:')) { depth++; return }
    if (line.startsWith('END:') && depth > 0) { depth--; return }
    if (line === 'END:VEVENT') {
      const ev = props
      props = null
      stats.events++
      const get = (n: string) => ev.find(p => p.name === n)
      const uid = get('UID')?.value
      if (!uid) return
      const start = icsDate(get('DTSTART'))
      const end = icsDate(get('DTEND'))
      const rrule = get('RRULE')?.value || null
      const recur = get('RECURRENCE-ID') ? icsDate(get('RECURRENCE-ID')).iso : null
      if (o.since && !rrule && start.iso && start.iso.slice(0, 10) < o.since) { stats.skippedOld++; return }
      const organizerProp = get('ORGANIZER')
      const organizer = organizerProp ? organizerProp.value.replace(/^mailto:/i, '').toLowerCase() : null
      const attendees = ev.filter(p => p.name === 'ATTENDEE').map(p => ({
        email: p.value.replace(/^mailto:/i, '').toLowerCase(),
        name: p.params.CN || null,
        partstat: p.params.PARTSTAT || null,
        role: p.params.ROLE || null,
      }))
      const me = attendees.find(a => owner.has(a.email))
      const description = get('DESCRIPTION') ? unescapeIcsText(get('DESCRIPTION')!.value) : null
      const conf = get('X-GOOGLE-CONFERENCE')?.value || (description?.match(/https:\/\/(?:meet\.google\.com|[\w.-]*zoom\.us)\/[^\s<>"]+/)?.[0] ?? null)
      const extras: Record<string, string> = {}
      for (const p of ev) if (p.name.startsWith('X-') || p.name === 'TRANSP' || p.name === 'CLASS' || p.name === 'SEQUENCE') extras[p.name] = p.value
      pending.push([
        `calendar:${uid}${recur ? `:${recur}` : ''}`,
        calendarName, uid, recur,
        get('SUMMARY') ? unescapeIcsText(get('SUMMARY')!.value) : null,
        description,
        get('LOCATION') ? unescapeIcsText(get('LOCATION')!.value) : null,
        start.iso, end.iso, start.allDay ? 1 : 0, start.tz,
        rrule, get('STATUS')?.value || null,
        organizer, organizer && owner.has(organizer) ? 1 : 0,
        JSON.stringify(attendees), me?.partstat || null, conf,
        icsDate(get('CREATED')).iso, icsDate(get('LAST-MODIFIED')).iso,
        JSON.stringify(extras),
      ])
      if (pending.length >= 1000) flush()
      return
    }
    if (depth > 0) return
    const p = parseIcsLine(line)
    if (p) props.push(p)
  }

  // Unfold RFC 5545 continuation lines (leading space/tab) while streaming
  for await (const { line: raw } of readLines(input.open())) {
    const line = Buffer.from(raw.endsWith('\r') ? raw.slice(0, -1) : raw, 'latin1').toString('utf8')
    if ((line.startsWith(' ') || line.startsWith('\t')) && prevLine !== null) { prevLine += line.slice(1); continue }
    if (prevLine !== null) handle(prevLine)
    prevLine = line
  }
  if (prevLine !== null) handle(prevLine)
  flush()
  if (!o.quiet) console.log(`  ✓ ${calendarName}: ${stats.events.toLocaleString()} events (${stats.inserted.toLocaleString()} new, ${stats.updated.toLocaleString()} refreshed${stats.skippedOld ? `, ${stats.skippedOld.toLocaleString()} before --since` : ''})`)
  return stats
}

// ============================================================
// ENTRY POINT
// ============================================================

const USAGE = `
import-takeout — import a Google Takeout export (Gmail + Calendar) into Deep Context. No OAuth.

USAGE:
  bun tools/import-takeout.ts <takeout.zip|takeout.tgz|folder|file.mbox|file.ics> [...more] [options]
  bun tools/deep-context.ts import-takeout <...same...>

OPTIONS:
  --since YYYY-MM-DD   Only load threads active on/after this date (and events from it on).
                       Use for the fast first "seed" pass; run again without it for full history.
  --account NAME       Mailbox name for a second Google account (rows go to source gmail-NAME)
  --me EMAIL           An address that is yours (repeatable). Adds to OWNER_CONFIG.emails.
                       If OWNER_CONFIG is still the placeholder, your addresses are detected
                       from the messages labelled "Sent".
  --mail-only          Skip calendar files
  --calendar-only      Skip mail
  --limit N            Load at most N threads (newest first) — for a quick look
  --dry-run            Scan and report what would be imported; write nothing to the main DB
  --rescan             Ignore scan checkpoints and re-read the mbox from the start
  --db PATH            Database path (default data/deep_context/deep_context.db, or $DEEP_CONTEXT_DB)
  --staging PATH       Staging DB path (default data/deep_context/takeout/staging-<account>.db)
  --quiet              Less output
  --help               Show this help

WHAT GETS IMPORTED (same policy as the Gmail API extractor):
  • every thread you wrote in (Promotions/Updates/Social excluded)
  • inbound threads from people who appear in those threads ("known contacts")
  • Spam, Trash, Drafts and Chats are skipped; attachments are skipped (flagged only)
  • addresses in config.json privacy.excluded_emails are never imported
  • calendar events → calendar_events table (query with --source calendar)

RESUMABLE: interrupt any time and re-run the same command; it continues where it stopped.
Re-running is idempotent — no duplicates, and a later 'extract gmail' won't duplicate either.

EXAMPLES:
  # Seed: last 30 days (fast orientation), then the full history
  bun tools/import-takeout.ts ~/Downloads/takeout-20261012T000000Z-001.zip --since 2026-09-12
  bun tools/import-takeout.ts ~/Downloads/takeout-20261012T000000Z-001.zip
`

export interface ImportOptions {
  inputs: string[]
  since?: string
  account?: string
  me?: string[]
  mailOnly?: boolean
  calendarOnly?: boolean
  limit?: number
  dryRun?: boolean
  rescan?: boolean
  /** Stop the scan after N newly staged messages (checkpointed, resumable). Mostly for tests. */
  scanStopAfter?: number
  dbPath?: string
  stagingPath?: string
  quiet?: boolean
}

export interface ImportSummary {
  source: string
  owner: string[]
  scan: ScanStats
  load: LoadStats | null
  calendar: CalStats
}

function openMainDb(path: string): Database {
  const fresh = !existsSync(path)
  if (fresh) {
    mkdirSync(dirname(path), { recursive: true })
    if (!existsSync(SCHEMA_PATH)) throw new Error(`Schema not found at ${SCHEMA_PATH}`)
  }
  const db = new Database(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 30000;')
  if (fresh) db.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  // Same additive migrations deep-context.ts getDb() applies, so an import into an older DB works.
  const cols = new Set((db.query(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map(c => c.name))
  if (cols.size > 0 && !cols.has('authored_by')) db.exec(`ALTER TABLE messages ADD COLUMN authored_by TEXT`)
  if (cols.size > 0 && !cols.has('authorship_evidence')) db.exec(`ALTER TABLE messages ADD COLUMN authorship_evidence TEXT`)
  ensureCalendarTable(db)
  return db
}

export async function runImport(opts: ImportOptions): Promise<ImportSummary> {
  const account = normalize_account(opts.account)
  const source = account === DEFAULT_ACCOUNT ? 'gmail' : `gmail-${account}`
  const dbPath = opts.dbPath || process.env.DEEP_CONTEXT_DB || join(DATA_DIR, 'deep_context.db')
  const stagingPath = opts.stagingPath || join(DATA_DIR, 'takeout', `staging-${account}.db`)
  const log = (s: string) => { if (!opts.quiet) console.log(s) }

  const inputs = discoverInputs(opts.inputs)
  const mboxes = opts.calendarOnly ? [] : inputs.filter(i => i.kind === 'mbox')
  const icsFiles = opts.mailOnly ? [] : inputs.filter(i => i.kind === 'ics')
  if (mboxes.length === 0 && icsFiles.length === 0) {
    throw new Error('No Gmail .mbox or Calendar .ics files found in the input. In Takeout, select "Mail" and/or "Calendar".')
  }
  log(`\n=== Google Takeout import → source '${source}' ===`)
  log(`  Found ${mboxes.length} mbox file(s), ${icsFiles.length} calendar file(s)`)

  const owner = new Set<string>([...OWNER_CONFIG.emails, ...(opts.me || [])].map(e => e.toLowerCase().trim()).filter(e => e && e !== PLACEHOLDER_EMAIL))
  const agents = new Map<string, string>(Object.entries(OWNER_CONFIG.agentEmails ?? {}).map(([e, id]) => [e.toLowerCase().trim(), id]))
  let excluded = new Set<string>()
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    excluded = new Set(((cfg.privacy?.excluded_emails || []) as string[]).map(e => e.toLowerCase().trim()))
  } catch {}

  const db = opts.dryRun && !existsSync(dbPath) ? new Database(':memory:') : openMainDb(dbPath)
  if (opts.dryRun && !existsSync(dbPath)) { db.exec(readFileSync(SCHEMA_PATH, 'utf8')); ensureCalendarTable(db) }

  const summary: ImportSummary = { source, owner: [], scan: { messages: 0, dropped: {} }, load: null, calendar: { events: 0, inserted: 0, updated: 0, skippedOld: 0 } }

  try {
    // ---------- MAIL ----------
    if (mboxes.length) {
      const staging = openStaging(stagingPath)
      try {
        log(`\n[1/2] Scanning mail (staging: ${stagingPath})`)
        for (const mb of mboxes) {
          const s = await scanMbox(staging, mb, { rescan: !!opts.rescan, quiet: opts.quiet, stopAfter: opts.scanStopAfter })
          summary.scan.messages += s.messages
          for (const [k, v] of Object.entries(s.dropped)) summary.scan.dropped[k] = (summary.scan.dropped[k] || 0) + v
          if (s.paused) summary.scan.paused = true
        }
        if (summary.scan.paused) {
          log('  Scan paused before the end of the mailbox — nothing loaded yet. Re-run the same command to continue.')
          return summary
        }

        // Owner detection: Takeout labels your outgoing mail "Sent"
        const sentFrom = staging.query(`SELECT from_email, COUNT(*) AS n FROM msgs WHERE labels LIKE '%"Sent"%' AND from_email LIKE '%@%' GROUP BY from_email ORDER BY n DESC`).all() as { from_email: string; n: number }[]
        if (owner.size === 0) {
          for (const r of sentFrom) if (r.n >= 1) owner.add(r.from_email)
          if (owner.size === 0) throw new Error('Could not tell which addresses are yours: set OWNER_CONFIG.emails in tools/deep-context.ts or pass --me you@example.com')
          log(`  Your addresses (detected from Sent mail): ${[...owner].join(', ')}`)
          log(`  → add them to OWNER_CONFIG.emails in tools/deep-context.ts so every tool agrees`)
        } else {
          const missing = sentFrom.filter(r => !owner.has(r.from_email) && r.n >= 5).map(r => `${r.from_email} (${r.n} sent)`)
          if (missing.length) log(`  Note: you also send from ${missing.slice(0, 5).join(', ')} — add to OWNER_CONFIG.emails (or --me) if those are yours`)
        }
        summary.owner = [...owner]

        const ownerId = OWNER_CONFIG.personId && OWNER_CONFIG.personId !== 'YOUR_PERSON_ID' ? OWNER_CONFIG.personId : 'me'
        const ownerDisplayName = OWNER_CONFIG.displayName && OWNER_CONFIG.displayName !== 'YOUR_NAME' ? OWNER_CONFIG.displayName : 'Me'

        log(`\n[2/2] Loading threads${opts.dryRun ? ' (dry run — nothing written)' : ''}`)
        summary.load = loadIntoDb(db, staging, { source, ownerId, ownerDisplayName, owner, agents, excluded, since: opts.since, limit: opts.limit, dryRun: !!opts.dryRun, quiet: opts.quiet })
        const L = summary.load
        if (!opts.dryRun) log(`  ✓ ${L.newThreads.toLocaleString()} new threads, ${L.updatedThreads.toLocaleString()} extended, ${L.unchangedThreads.toLocaleString()} already present · ${L.newMessages.toLocaleString()} new messages${L.skippedDuplicateMessages ? ` · ${L.skippedDuplicateMessages} duplicate(s) skipped by Message-ID` : ''}${L.excludedThreads ? ` · ${L.excludedThreads} thread(s) excluded by privacy list` : ''}`)
      } finally {
        staging.close()
      }
    }

    // ---------- CALENDAR ----------
    if (icsFiles.length) {
      if (owner.size === 0) for (const e of opts.me || []) owner.add(e.toLowerCase())
      log(`\nCalendar${opts.dryRun ? ' (dry run)' : ''}`)
      for (const f of icsFiles) {
        const s = await importIcs(db, f, { owner, since: opts.since, dryRun: !!opts.dryRun, quiet: opts.quiet })
        summary.calendar.events += s.events
        summary.calendar.inserted += s.inserted
        summary.calendar.updated += s.updated
        summary.calendar.skippedOld += s.skippedOld
      }
    }
  } finally {
    db.close()
  }

  log(`\nDone.${mboxes.length && !opts.dryRun ? ` Next: 'bun tools/deep-context.ts recent --hours 720' to look around, then 'enrich' / 'embed-backfill' if you use them.` : ''}`)
  if (mboxes.length && !opts.dryRun) log(`The staging file can be deleted once you're happy: ${stagingPath} (keep it to re-run without re-scanning).`)
  return summary
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: ParsedArgs
  try {
    args = parse_flags(argv, {
      since: { type: 'string' },
      account: { type: 'string' },
      as: { type: 'string' },
      me: { type: 'string', multi: true },
      'mail-only': { type: 'boolean' },
      'calendar-only': { type: 'boolean' },
      limit: { type: 'string' },
      'dry-run': { type: 'boolean' },
      rescan: { type: 'boolean' },
      db: { type: 'string' },
      staging: { type: 'string' },
      quiet: { type: 'boolean' },
      help: { type: 'boolean', alias: 'h' },
    })
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }
  if (args.help || args._.length === 0) {
    print_help('import-takeout', USAGE)
    process.exit(args.help ? 0 : 1)
  }
  const since = args.since as string | undefined
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error('--since must be YYYY-MM-DD')
    process.exit(2)
  }
  const me = args.me ? (Array.isArray(args.me) ? args.me : [args.me]) as string[] : []
  await runImport({
    inputs: args._,
    since,
    account: (args.account || args.as) as string | undefined,
    me,
    mailOnly: !!args['mail-only'],
    calendarOnly: !!args['calendar-only'],
    limit: args.limit ? parseInt(args.limit as string, 10) : undefined,
    dryRun: !!args['dry-run'],
    rescan: !!args.rescan,
    dbPath: args.db as string | undefined,
    stagingPath: args.staging as string | undefined,
    quiet: !!args.quiet,
  })
}

if (import.meta.main) {
  main().catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}
