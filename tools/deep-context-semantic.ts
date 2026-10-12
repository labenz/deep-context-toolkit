#!/usr/bin/env bun

// Semantic search support for deep-context — embeddings + sqlite-vec (+ optional rerank)
//
// Everything here is OPTIONAL. Keyword search (`deep-context query "term"`) never touches
// this module and works with zero API keys. Semantic / hybrid search needs one of:
//
//   1. Gemini (default) — GEMINI_API_KEY in tools/.env. Model gemini-embedding-2 at 768 dims.
//      Cheap: ~$0.20 per million tokens; a 100K-message archive is typically a few dollars.
//   2. Ollama (local, free, private) — DEEP_CONTEXT_EMBED_PROVIDER=ollama, with
//      `ollama pull nomic-embed-text` (768 dims) and the Ollama app running. Nothing leaves
//      your machine. Slower to backfill and somewhat lower recall than gemini-embedding-2.
//
// Reranking (optional): if VOYAGE_API_KEY is set, semantic/hybrid queries re-score the top
// 50 vector hits with Voyage rerank-3 (~$0.002/query). In our eval this lifted nDCG@10 by
// ~0.15 and put the right thread at #1 far more often. Without a key, results come back in
// vector order. Disable explicitly with --no-rerank or DEEP_CONTEXT_RERANK=0.
//
// Design notes:
// - Granularity: HYBRID THREAD-CHUNKS — consecutive messages within a thread are grouped into
//   chunks of <= MAX_CHUNK_CHARS and <= MAX_CHUNK_MESSAGES. Long single messages are split across
//   multiple chunks. Optimizes "find that conversation about X" recall at ~10x fewer vectors
//   than message-level embedding.
// - Storage: SIDECAR DB (data/deep_context/deep_context_vectors_<provider>.db) — the main
//   deep_context.db is NEVER written to. Each provider gets its own file because vectors from
//   different models are not comparable. Chunk metadata lives in `embed_chunks`, vectors in
//   `vec_chunks` (sqlite-vec vec0 virtual table; brute-force scan is ~100ms over 100K vectors).
// - macOS gotcha: Apple's system SQLite blocks extensions. We point bun:sqlite at Homebrew's
//   libsqlite3 via Database.setCustomSQLite — which MUST happen before ANY Database is opened
//   in the process. Callers must open the vector DB before the main DB. (`brew install sqlite`)
// - Resumability: chunking is deterministic from the start of each thread, chunks are keyed by
//   content hash. `embed_thread_state` records how many messages of a thread were covered; a
//   thread is re-chunked only when its (filter-scoped) message count changes, and only chunks
//   whose hash isn't already present get embedded. Superseded chunks are soft-deleted
//   (stale=1; their rows are kept) and removed from the vec index only.

import { Database } from 'bun:sqlite'
import { existsSync } from 'fs'
import * as sqliteVec from 'sqlite-vec'
import { request } from './_lib/http'
import { load_env } from './_lib/env'

export const MAX_CHUNK_CHARS = 5500 // ~1,400-1,800 tokens
export const MAX_CHUNK_MESSAGES = 25
export const DEFAULT_BATCH_SIZE = 100 // texts per embedding call (Gemini API max 250)

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

// ============================================================
// Provider configuration
// ============================================================

export type EmbedProvider = 'gemini' | 'ollama'

export type EmbedConfig = {
  provider: EmbedProvider
  model: string
  dims: number
  pricePerMTokens: number // USD; 0 for local
  needsApiKey: boolean
}

export function embedConfig(): EmbedConfig {
  const provider = (process.env.DEEP_CONTEXT_EMBED_PROVIDER || 'gemini').toLowerCase()
  const dimsOverride = process.env.DEEP_CONTEXT_EMBED_DIMS ? parseInt(process.env.DEEP_CONTEXT_EMBED_DIMS, 10) : undefined
  if (provider === 'ollama') {
    return {
      provider: 'ollama',
      model: process.env.DEEP_CONTEXT_OLLAMA_MODEL || 'nomic-embed-text',
      dims: dimsOverride || 768,
      pricePerMTokens: 0,
      needsApiKey: false,
    }
  }
  if (provider !== 'gemini') {
    throw new Error(`Unknown DEEP_CONTEXT_EMBED_PROVIDER "${provider}" (use gemini or ollama)`)
  }
  return {
    provider: 'gemini',
    model: 'gemini-embedding-2',
    dims: dimsOverride || 768,
    pricePerMTokens: 0.2, // synchronous endpoint
    needsApiKey: true,
  }
}

/** Sidecar file name for the active provider (vector spaces from different models don't mix). */
export function vectorDbFileName(cfg: EmbedConfig = embedConfig()): string {
  return `deep_context_vectors_${cfg.provider}.db`
}

// ============================================================
// SQLite + sqlite-vec
// ============================================================

let customSqliteSet = false

const SQLITE_CANDIDATES = [
  process.env.DEEP_CONTEXT_SQLITE_LIB || '',
  '/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', // Apple Silicon Homebrew
  '/usr/local/opt/sqlite/lib/libsqlite3.dylib',    // Intel Homebrew
].filter(Boolean)

/**
 * On macOS, point bun:sqlite at Homebrew's libsqlite3 so loadExtension works (Apple's system
 * SQLite blocks extensions). MUST be called before ANY Database is opened in this process.
 * On Linux the bundled SQLite already allows extensions, so this is a no-op.
 */
export function useCustomSqlite(): void {
  if (customSqliteSet) return
  customSqliteSet = true
  if (process.platform !== 'darwin' && !process.env.DEEP_CONTEXT_SQLITE_LIB) return
  const lib = SQLITE_CANDIDATES.find(p => existsSync(p))
  if (!lib) {
    throw new Error(
      'Homebrew SQLite not found — needed for sqlite-vec on macOS.\n' +
      'Install with: brew install sqlite   (or set DEEP_CONTEXT_SQLITE_LIB to a libsqlite3 path)'
    )
  }
  Database.setCustomSQLite(lib)
}

const VECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS embed_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,
  thread_id TEXT NOT NULL,
  source TEXT NOT NULL,
  message_ids TEXT NOT NULL,         -- JSON array of message ids covered by this chunk
  message_count INTEGER NOT NULL,
  first_timestamp TEXT NOT NULL,
  last_timestamp TEXT NOT NULL,
  chunk_text TEXT NOT NULL,          -- exact text that was embedded (incl. context header)
  char_count INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,  -- soft delete: superseded by re-chunking; row preserved
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_embed_chunks_thread ON embed_chunks(thread_id);
CREATE INDEX IF NOT EXISTS idx_embed_chunks_source ON embed_chunks(source);
CREATE TABLE IF NOT EXISTS embed_thread_state (
  thread_id TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL,    -- messages covered at last chunking (filter-scoped)
  last_message_timestamp TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

/** Open (creating if needed) the sidecar vector DB with sqlite-vec loaded. */
export function openVectorDb(path: string, cfg: EmbedConfig = embedConfig()): Database {
  useCustomSqlite()
  const db = new Database(path, { create: true })
  sqliteVec.load(db)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA busy_timeout = 30000')
  db.exec(VECTOR_SCHEMA)
  // vec0 virtual table can't use IF NOT EXISTS on some versions — guard manually
  const hasVec = db.query("SELECT name FROM sqlite_master WHERE name = 'vec_chunks'").get()
  if (!hasVec) {
    db.exec(`CREATE VIRTUAL TABLE vec_chunks USING vec0(embedding float[${cfg.dims}] distance_metric=cosine)`)
  }
  return db
}

// ============================================================
// Chunking
// ============================================================

export type ChunkMessage = {
  id: string
  timestamp: string
  content: string
  senderName: string
  isFromMe: boolean
}

export type ThreadInput = {
  threadId: string
  source: string
  subject: string | null // thread subject or title
  messages: ChunkMessage[] // MUST be in chronological order
  ownerName?: string // label for the owner's own messages (default "Me")
}

export type Chunk = {
  hash: string
  threadId: string
  source: string
  messageIds: string[]
  firstTimestamp: string
  lastTimestamp: string
  text: string
}

function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(text)
  return hasher.digest('hex')
}

/**
 * Deterministically split a thread's messages into embedding chunks.
 * Greedy from the start: appending new messages only changes/extends the tail,
 * so prefix chunks keep stable hashes across incremental runs.
 */
export function chunkThread(input: ThreadInput): Chunk[] {
  const chunks: Chunk[] = []
  type Piece = { msg: ChunkMessage; text: string }
  const pieces: Piece[] = []
  const ownerName = input.ownerName || 'Me'

  for (const msg of input.messages) {
    const content = msg.content.trim()
    if (!content) continue
    const line = `${msg.isFromMe ? ownerName : msg.senderName}: ${content}`
    if (line.length <= MAX_CHUNK_CHARS) {
      pieces.push({ msg, text: line })
    } else {
      // Split very long messages into multiple pieces, each its own chunk-sized unit
      for (let i = 0; i < line.length; i += MAX_CHUNK_CHARS) {
        pieces.push({ msg, text: line.substring(i, i + MAX_CHUNK_CHARS) })
      }
    }
  }
  if (pieces.length === 0) return chunks

  const header = `[${input.source}] ${input.subject ? input.subject : '(no subject)'}`

  let buf: Piece[] = []
  let bufChars = 0

  const flush = () => {
    if (buf.length === 0) return
    const msgIds: string[] = []
    for (const p of buf) {
      if (msgIds[msgIds.length - 1] !== p.msg.id) msgIds.push(p.msg.id)
    }
    const first = buf[0].msg
    const last = buf[buf.length - 1].msg
    const text = `${header} (${String(first.timestamp).substring(0, 10)})\n${buf.map(p => p.text).join('\n')}`
    chunks.push({
      hash: sha256(`${input.threadId}|${msgIds.join(',')}|${text}`),
      threadId: input.threadId,
      source: input.source,
      messageIds: msgIds,
      firstTimestamp: first.timestamp,
      lastTimestamp: last.timestamp,
      text,
    })
    buf = []
    bufChars = 0
  }

  for (const piece of pieces) {
    const distinctMsgs = new Set(buf.map(p => p.msg.id)).size
    if (buf.length > 0 && (bufChars + piece.text.length > MAX_CHUNK_CHARS || distinctMsgs >= MAX_CHUNK_MESSAGES)) {
      flush()
    }
    buf.push(piece)
    bufChars += piece.text.length + 1
  }
  flush()

  return chunks
}

/** Rough token estimate for cost reporting (~4 chars/token for English text). */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4)
}

// ============================================================
// Embedding APIs
// ============================================================

/** Normalize to unit length, truncating to `dims` first if the model returned more (MRL). */
function normalize(values: number[], dims: number): Float32Array {
  const v = values.length > dims ? values.slice(0, dims) : values
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm
  return out
}

/** Resolve the API key the active provider needs ('' for local providers). */
export async function getEmbedApiKey(cfg: EmbedConfig = embedConfig()): Promise<string | null> {
  if (!cfg.needsApiKey) return ''
  const env = await load_env()
  const key = (env.GEMINI_API_KEY as string) || process.env.GEMINI_API_KEY
  return key || null
}

/**
 * Embed a batch of texts (<= 250).
 * taskType: 'RETRIEVAL_DOCUMENT' for stored chunks, 'RETRIEVAL_QUERY' for search queries.
 * Both providers express the task as a text prefix (gemini-embedding-2 and nomic-embed-text
 * each document their own prefixes). Retries 429/5xx/network errors with backoff.
 */
export async function embedTexts(
  apiKey: string,
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  cfg: EmbedConfig = embedConfig()
): Promise<Float32Array[]> {
  let lastErr: Error | null = null
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const raw = cfg.provider === 'ollama'
        ? await embedOllama(texts, taskType, cfg)
        : await embedGemini(apiKey, texts, taskType, cfg)
      if (raw.length !== texts.length) {
        throw new Error(`Expected ${texts.length} embeddings, got ${raw.length}`)
      }
      return raw.map(v => normalize(v, cfg.dims))
    } catch (e) {
      lastErr = e as Error
      const status = (e as any)?.status
      if (status === 429 || (typeof status === 'number' && status >= 500) || status === undefined) {
        const waitMs = 5_000 * (attempt + 1)
        console.error(`  embed batch failed (${lastErr.message.substring(0, 120)}), retrying in ${waitMs / 1000}s...`)
        await new Promise(r => setTimeout(r, waitMs))
        continue
      }
      throw e
    }
  }
  throw lastErr ?? new Error('embedTexts: exhausted retries')
}

async function embedGemini(
  apiKey: string,
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  cfg: EmbedConfig
): Promise<number[][]> {
  const url = `${GEMINI_BASE}/models/${cfg.model}:batchEmbedContents?key=${apiKey}`
  const body = {
    requests: texts.map(text => ({
      model: `models/${cfg.model}`,
      content: { parts: [{ text: taskType === 'RETRIEVAL_QUERY' ? `task: search result | query: ${text}` : `title: none | text: ${text}` }] },
      outputDimensionality: cfg.dims,
    })),
  }
  const { data } = await request<{ embeddings?: { values: number[] }[] }>({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: 120_000,
    retries: 2,
    logOnError: false,
  })
  return (data.embeddings ?? []).map(e => e.values)
}

async function embedOllama(
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY',
  cfg: EmbedConfig
): Promise<number[][]> {
  const host = (process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/$/, '')
  const prefix = taskType === 'RETRIEVAL_QUERY' ? 'search_query: ' : 'search_document: '
  const r = await fetch(`${host}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, input: texts.map(t => prefix + t), truncate: true }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!r.ok) {
    const err = new Error(`Ollama embed HTTP ${r.status}: ${(await r.text()).substring(0, 200)}`)
    ;(err as any).status = r.status
    throw err
  }
  const d = (await r.json()) as { embeddings?: number[][] }
  return d.embeddings ?? []
}

/** Embed a single search query. */
export async function embedQuery(apiKey: string, query: string, cfg: EmbedConfig = embedConfig()): Promise<Float32Array> {
  const [vec] = await embedTexts(apiKey, [query.substring(0, MAX_CHUNK_CHARS)], 'RETRIEVAL_QUERY', cfg)
  return vec
}

/** Serialize a Float32Array for binding into sqlite-vec. */
export function vecToBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength)
}

// ============================================================
// Voyage rerank-3 (optional second-stage re-scoring of semantic/hybrid candidates)
// ============================================================

export const RERANK_MODEL = 'rerank-3'
export const RERANK_POOL = 50 // candidates re-scored per query

/** VOYAGE_API_KEY from the environment or tools/.env; null when not configured. */
export async function fetchVoyageKey(): Promise<string | null> {
  if (process.env.VOYAGE_API_KEY) return process.env.VOYAGE_API_KEY
  try {
    const env = await load_env()
    return (env.VOYAGE_API_KEY as string) || null
  } catch {
    return null
  }
}

/**
 * Re-score documents for a query. Returns [{index, score}] sorted best-first (top_k of them),
 * or null on any failure so callers can fall back to vector order.
 */
export async function rerank(
  apiKey: string,
  query: string,
  documents: string[],
  topK: number
): Promise<{ index: number; score: number }[] | null> {
  if (!documents.length) return []
  try {
    const r = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: RERANK_MODEL, query, documents, top_k: Math.min(topK, documents.length) }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) {
      console.error(`(rerank unavailable: HTTP ${r.status} — showing vector order)`)
      return null
    }
    const d = (await r.json()) as { data: { index: number; relevance_score: number }[] }
    return d.data.map(x => ({ index: x.index, score: x.relevance_score }))
  } catch (e) {
    console.error(`(rerank unavailable: ${(e as Error).message.substring(0, 80)} — showing vector order)`)
    return null
  }
}
