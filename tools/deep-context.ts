#!/usr/bin/env bun

// Deep Context CLI - Personal knowledge base management
// Extracts communications, enriches with metadata, searches (keyword + semantic), tracks TODOs

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, unlinkSync } from 'fs'
import { parse_flags, print_help, type ParsedArgs, type FlagSchema } from './_lib/cli'
import { dirname, join } from 'path'
import Database from 'bun:sqlite'
import { load_env, PROJECT_ROOT } from './_lib/env'
import { request } from './_lib/http'
import { pick_existing_access_token, try_refresh_token, start_device_auth, update_project_env_vars } from './_lib/google_oauth'
import { normalizePhoneFromBeeperId } from './_lib/contact-matching'
import EmailReplyParser from 'email-reply-parser'
import { convertHtmlToText, extractGmail as extractGmailRaw, GMAIL_SOURCE } from './gmail-extractor'
import {
  openVectorDb,
  chunkThread,
  embedTexts,
  embedQuery,
  vecToBlob,
  estimateTokens as estimateEmbedTokens,
  embedConfig,
  vectorDbFileName,
  getEmbedApiKey,
  DEFAULT_BATCH_SIZE,
  fetchVoyageKey,
  rerank,
  RERANK_POOL,
  type Chunk
} from './deep-context-semantic'


// ══════════════════════════════════════════════════════════════
// OWNER CONFIGURATION — Fill in your details before first use
// ══════════════════════════════════════════════════════════════
export const OWNER_CONFIG = {
  personId: 'YOUR_PERSON_ID',           // e.g., 'jane-doe' — used as DB identifier
  displayName: 'YOUR_NAME',             // e.g., 'Jane Doe'
  emails: ['your@email.com'],           // All email addresses you use (first is primary)
  twitterHandle: '',                     // e.g., 'janedoe' (without @) — leave empty to skip Twitter
  twitterId: '',                         // Numeric Twitter ID — leave empty to skip
  phone: '',                             // Phone number for contact matching — leave empty to skip
  // Addresses your AI agents send email FROM (e.g. an assistant Gmail account) → the person ID
  // to file those messages under. Their messages get authored_by=<id>, so "my own writing"
  // queries and voice-matching can exclude agent-written text. Leave empty if none.
  // e.g. { 'assistant@example.com': 'my-assistant' }
  agentEmails: {} as Record<string, string>,
  slackIdentifiers: {
    // Per-workspace Slack info. Add one entry per workspace (key = workspace flag).
    // 'workspace_flag': { userId: 'UXXXXXXXX', searchQuery: 'from:@yourname', mentionQueries: ['@yourname'] }
  } as Record<string, { userId: string; searchQuery: string; mentionQueries: string[] }>,
};

const USAGE = `
deep-context — Personal knowledge base for your AI agent

USAGE:
  # Set up and check
  deep-context init [--force]
  deep-context status [--source SOURCE] [--json]

  # Pull in data
  deep-context extract <source> [--from DATE] [--to DATE] [--limit N] [--dry-run] [--backfill] [--account NAME]
    Sources: gmail, slack, slack-mentions, slack-channel-full, slack-dm, beeper, groupme, twitter, twitter-live, calls, podcast
  deep-context backfill slack <mentions|channel-full> [--from DATE] [--to DATE] [--restart] [--channel ID] [--chunk-months N]
    Checkpointed, resumable multi-year Slack history load (use once at setup).

  # Search (keyword LIKE search by default — no API key needed)
  deep-context query <search_term> [--source SOURCE] [--from DATE] [--to DATE] [--limit N] [--json]
    --semantic   Vector search over embedded conversation chunks (meaning, not keywords)
    --hybrid     Combine keyword + semantic results (reranked together; RRF by thread if rerank off)
    --no-rerank  Skip the optional Voyage rerank-3 pass (used automatically for --semantic/--hybrid
                 when VOYAGE_API_KEY is set; also off via DEEP_CONTEXT_RERANK=0).
    Embedding provider: Gemini (GEMINI_API_KEY) by default, or local Ollama with
    DEEP_CONTEXT_EMBED_PROVIDER=ollama (free, private; ollama pull nomic-embed-text).
  deep-context recent [--hours N] [--source SOURCE] [--limit N]    Browse recent threads

  # Semantic index (sidecar DB: deep_context_vectors_<provider>.db; never writes deep_context.db)
  deep-context embed-backfill [--source S] [--from DATE] [--to DATE] [--limit N] [--dry-run] [--max-cost DOLLARS]
    Resumable: safe to interrupt and rerun. --dry-run reports chunk count + cost.
  deep-context embed-update            Embed anything new (same as embed-backfill)
  deep-context embed-status            Vector index coverage and estimated spend

  # Optional AI metadata on your own messages (needs GEMINI_API_KEY; skips cleanly without)
  deep-context enrich [--limit N] [--source SOURCE] [--from DATE] [--to DATE] [--dry-run]
    Writes quality / authorship / originality scores + topics + entities to message_metadata.

  # Action items
  deep-context todo list [--status S] [--category C] [--limit N]
  deep-context todo add --title "..." --category committed|incoming --source SOURCE
                        [--context "..."] [--related-person NAME] [--priority P] [--due DATE] [--tags T]
  deep-context todo update <id-prefix> --status accepted|dismissed|completed [--reason "..."]
  deep-context todo expire [--days N] [--dry-run]  Soft-expire stale incoming items (reversible)
  deep-context todo recap [--since HOURS]       What's new for a daily briefing
  deep-context todo strategic                   Birds-eye organizational view

  # Exports
  deep-context extract-for-summary --from DATE --to DATE [--output FILE] [--token-budget N] [--include-low-quality]
    Thread-centric markdown for monthly summaries (feeds /summarize-monthly and the wiki).
  deep-context export-public [--output FILE] [--push USER@HOST:DIR]
    Slim FTS5 DB of ONLY public sources (config.json "public_sources", default
    ["podcast", "twitter"]) — safe to hand to low-access agents.

EXAMPLES:
  deep-context init
  deep-context extract gmail --from 2026-01-01
  deep-context query "project-name" --source gmail --limit 20
  deep-context query "frustrated with the vendor's turnaround time" --semantic
  deep-context recent --hours 24
  deep-context embed-backfill --from 2026-05-01 --max-cost 0.50
  deep-context todo recap --since 24
`

// Paths
const PROJECT_ROOT = dirname(import.meta.dir)
const DATA_DIR = join(PROJECT_ROOT, 'data/deep_context')
const DB_PATH = join(DATA_DIR, 'deep_context.db')
// Semantic-search sidecar. One file per embedding provider — vector spaces from different
// models are incompatible. Override with DEEP_CONTEXT_VECTOR_DB.
// Resolved lazily so DEEP_CONTEXT_* settings in tools/.env (applied in main()) take effect.
function vectorDbPath(): string {
  return process.env.DEEP_CONTEXT_VECTOR_DB || join(DATA_DIR, vectorDbFileName())
}
const SCHEMA_PATH = join(DATA_DIR, 'schema.sql')
const CONFIG_PATH = join(DATA_DIR, 'config.json')

// Directory structure
const DIRECTORIES = [
  'summaries/monthly-exports',
  'summaries/monthly-summaries',
  'summaries/annual-summaries',
]

// Valid sources
const VALID_SOURCES = ['gmail', 'slack', 'slack-mentions', 'slack-channel-full', 'slack-dm', 'beeper', 'groupme', 'twitter', 'twitter-live', 'calls', 'podcast'] as const
type Source = typeof VALID_SOURCES[number]

function getDb(): Database {
  if (!existsSync(DB_PATH)) {
    console.error(`Error: Database not found at ${DB_PATH}`)
    console.error('Run "deep-context init" first')
    process.exit(1)
  }
  const db = new Database(DB_PATH)
  // Enable WAL mode for better concurrency (allows readers during writes)
  db.exec('PRAGMA journal_mode = WAL')
  // Wait up to 30 seconds for locks to clear before failing
  db.exec('PRAGMA busy_timeout = 30000')

  // Migrate: ensure todo_items table exists
  const hasTodos = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='todo_items'").get()
  if (!hasTodos) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS todo_items (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        context TEXT,
        source TEXT NOT NULL,
        source_message_id TEXT,
        source_thread_id TEXT,
        source_url TEXT,
        detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        due_date TEXT,
        priority TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'pending',
        related_person TEXT,
        dismissed_reason TEXT,
        completed_at DATETIME,
        last_seen_at DATETIME,
        tags TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_todo_status ON todo_items(status);
      CREATE INDEX IF NOT EXISTS idx_todo_category ON todo_items(category);
      CREATE INDEX IF NOT EXISTS idx_todo_detected ON todo_items(detected_at);
    `)
    console.log('Created todo_items table')
  }

  const hasWatermarks = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='extraction_watermarks'").get()
  if (!hasWatermarks) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS extraction_watermarks (
        source TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        last_extracted_at TEXT,
        last_seen_ts TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (source, scope)
      );
    `)
    console.log('Created extraction_watermarks table')
  }

  // Migrate: authorship columns on messages (additive). is_from_me answers "whose
  // account sent it"; authored_by answers "whose words" — an AI agent sending from your
  // account is is_from_me=1, authored_by='<agent>'. NULL = not judged.
  const msgCols = new Set((db.query(`PRAGMA table_info(messages)`).all() as Array<{ name: string }>).map(c => c.name))
  if (msgCols.size > 0 && !msgCols.has('authored_by')) {
    db.exec(`ALTER TABLE messages ADD COLUMN authored_by TEXT`)
    console.log('Added messages.authored_by column')
  }
  if (msgCols.size > 0 && !msgCols.has('authorship_evidence')) {
    db.exec(`ALTER TABLE messages ADD COLUMN authorship_evidence TEXT`)
  }
  // Migrate: threads.network (messaging network label read by extract-for-summary;
  // older schema.sql never declared it, so that command failed with "no such column").
  const threadCols = new Set((db.query(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>).map(c => c.name))
  if (threadCols.size > 0 && !threadCols.has('network')) {
    db.exec(`ALTER TABLE threads ADD COLUMN network TEXT`)
  }

  return db
}

function getWatermark(db: Database, source: string, scope = ''): { last_extracted_at: string | null; last_seen_ts: string | null } | null {
  return db.query(`
    SELECT last_extracted_at, last_seen_ts FROM extraction_watermarks
    WHERE source = ? AND scope = ?
  `).get(source, scope) as { last_extracted_at: string | null; last_seen_ts: string | null } | null
}

function setWatermark(db: Database, source: string, scope: string, lastSeenTs: string | null): void {
  db.query(`
    INSERT INTO extraction_watermarks (source, scope, last_extracted_at, last_seen_ts, updated_at)
    VALUES (?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT (source, scope) DO UPDATE SET
      last_extracted_at = datetime('now'),
      last_seen_ts = CASE
        WHEN excluded.last_seen_ts IS NULL THEN extraction_watermarks.last_seen_ts
        WHEN extraction_watermarks.last_seen_ts IS NULL THEN excluded.last_seen_ts
        WHEN excluded.last_seen_ts > extraction_watermarks.last_seen_ts THEN excluded.last_seen_ts
        ELSE extraction_watermarks.last_seen_ts
      END,
      updated_at = datetime('now')
  `).run(source, scope, lastSeenTs)
}

function setBackfillCheckpoint(db: Database, source: string, scope: string, oldestBoundaryTs: string): void {
  db.query(`
    INSERT INTO extraction_watermarks (source, scope, last_extracted_at, last_seen_ts, updated_at)
    VALUES (?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT (source, scope) DO UPDATE SET
      last_extracted_at = datetime('now'),
      last_seen_ts = excluded.last_seen_ts,
      updated_at = datetime('now')
  `).run(source, scope, oldestBoundaryTs)
}

// Helper to retry database operations on lock errors
async function withDbRetry<T>(fn: () => T, maxRetries = 10, baseWaitMs = 2000): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn()
    } catch (e) {
      const msg = String(e)
      if (msg.includes('database is locked') && attempt < maxRetries) {
        const waitMs = Math.min(baseWaitMs * Math.pow(2, attempt), 60000) // cap at 60s
        console.log(`    Database locked, retrying in ${waitMs/1000}s (attempt ${attempt + 1}/${maxRetries})...`)
        await new Promise(resolve => setTimeout(resolve, waitMs))
      } else {
        throw e
      }
    }
  }
  throw new Error('withDbRetry: exceeded max retries')
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

function formatDate(d: string | null): string {
  if (!d) return 'never'
  const date = new Date(d)
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ============================================================
// COMMANDS
// ============================================================

async function cmdInit(args: ParsedArgs): Promise<void> {
  const force = args.flags.force

  // Check if already initialized
  if (existsSync(DB_PATH) && !force) {
    console.log('Deep Context system already initialized.')
    console.log(`Database: ${DB_PATH}`)
    console.log('\nUse --force to reinitialize (will NOT delete existing data)')
    return
  }

  console.log('Initializing Deep Context system...\n')

  // Create directories
  for (const dir of DIRECTORIES) {
    const fullPath = join(DATA_DIR, dir)
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true })
      console.log(`  Created: ${dir}/`)
    }
  }

  // Initialize database
  if (!existsSync(DB_PATH)) {
    if (!existsSync(SCHEMA_PATH)) {
      console.error(`Error: Schema file not found at ${SCHEMA_PATH}`)
      process.exit(1)
    }
    const schema = readFileSync(SCHEMA_PATH, 'utf8')
    const db = new Database(DB_PATH)
    db.exec(schema)
    // Enable WAL mode for better concurrency
    db.exec('PRAGMA journal_mode = WAL')
    db.close()
    console.log(`  Created: deep_context.db`)
  }

  // Create default config if not exists
  if (!existsSync(CONFIG_PATH)) {
    const defaultConfig = {
      version: 1,
      created_at: new Date().toISOString(),
      privacy: {
        excluded_emails: [],
        excluded_phone_patterns: [],
        excluded_names: []
      },
      extraction: {
        gmail: { newer_than_years: 5 },
        slack: { workspaces: Object.keys(OWNER_CONFIG.slackIdentifiers) },
        beeper: { skip_twitter: true },
        twitter: { archive_path: '' }
      },
      // enrichment.model is optional; leave unset to use DEFAULT_ENRICH_MODEL
      enrichment: {}
    }
    await Bun.write(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2))
    console.log(`  Created: config.json`)
  }

  console.log('\nDeep Context system initialized successfully!')
  console.log(`\nNext steps:`)
  console.log(`  1. Review config: ${CONFIG_PATH}`)
  console.log(`  2. Run: deep-context extract <source>`)
  console.log(`  3. Run: deep-context status`)
}

async function cmdStatus(args: ParsedArgs): Promise<void> {
  const db = getDb()
  const sourceFilter = args.flags.source as string | undefined
  const jsonOutput = args.flags.json

  // Get counts per source
  const threadCounts = db.query(`
    SELECT source, COUNT(*) as count FROM threads GROUP BY source
  `).all() as { source: string; count: number }[]

  const messageCounts = db.query(`
    SELECT source,
           COUNT(*) as total,
           SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as my_messages
    FROM messages GROUP BY source
  `).all() as { source: string; total: number; my_messages: number }[]

  const peopleCounts = db.query(`SELECT COUNT(*) as count FROM people`).get() as { count: number }

  const enrichedCount = db.query(`SELECT COUNT(*) as count FROM message_metadata`).get() as { count: number }
  const totalMyMessages = db.query(`SELECT COUNT(*) as count FROM messages WHERE is_from_me = 1`).get() as { count: number }

  // Get extraction log
  const extractions = db.query(`
    SELECT source,
           MAX(completed_at) as last_extraction,
           MAX(newest_item_timestamp) as newest_item,
           SUM(items_extracted) as total_items
    FROM extraction_log
    WHERE status = 'completed'
    GROUP BY source
  `).all() as { source: string; last_extraction: string; newest_item: string; total_items: number }[]

  db.close()

  if (jsonOutput) {
    console.log(JSON.stringify({
      threads: threadCounts,
      messages: messageCounts,
      people: peopleCounts.count,
      enrichment: {
        enriched: enrichedCount.count,
        total_my_messages: totalMyMessages.count,
        percentage: totalMyMessages.count > 0
          ? Math.round(enrichedCount.count / totalMyMessages.count * 100)
          : 0
      },
      extractions
    }, null, 2))
    return
  }

  console.log('═══════════════════════════════════════════════════════════════')
  console.log('                    DEEP CONTEXT STATUS')
  console.log('═══════════════════════════════════════════════════════════════\n')

  // Data Summary
  console.log('DATA SUMMARY')
  console.log('───────────────────────────────────────────────────────────────')

  const sourceMap = new Map<string, { threads: number; messages: number; my_messages: number }>()
  for (const source of VALID_SOURCES) {
    sourceMap.set(source, { threads: 0, messages: 0, my_messages: 0 })
  }
  for (const t of threadCounts) {
    const existing = sourceMap.get(t.source) || { threads: 0, messages: 0, my_messages: 0 }
    existing.threads = t.count
    sourceMap.set(t.source, existing)
  }
  for (const m of messageCounts) {
    const existing = sourceMap.get(m.source) || { threads: 0, messages: 0, my_messages: 0 }
    existing.messages = m.total
    existing.my_messages = m.my_messages
    sourceMap.set(m.source, existing)
  }

  console.log(`${'Source'.padEnd(12)} ${'Threads'.padStart(10)} ${'Messages'.padStart(12)} ${'My Messages'.padStart(14)}`)
  console.log('─'.repeat(50))

  let totalThreads = 0, totalMessages = 0, totalMy = 0
  for (const [source, counts] of sourceMap) {
    if (sourceFilter && source !== sourceFilter) continue
    console.log(`${source.padEnd(12)} ${formatNumber(counts.threads).padStart(10)} ${formatNumber(counts.messages).padStart(12)} ${formatNumber(counts.my_messages).padStart(14)}`)
    totalThreads += counts.threads
    totalMessages += counts.messages
    totalMy += counts.my_messages
  }
  console.log('─'.repeat(50))
  console.log(`${'TOTAL'.padEnd(12)} ${formatNumber(totalThreads).padStart(10)} ${formatNumber(totalMessages).padStart(12)} ${formatNumber(totalMy).padStart(14)}`)

  console.log(`\nPeople in database: ${formatNumber(peopleCounts.count)}`)

  // Enrichment Progress
  console.log('\n\nENRICHMENT PROGRESS')
  console.log('───────────────────────────────────────────────────────────────')
  const enrichPct = totalMyMessages.count > 0
    ? Math.round(enrichedCount.count / totalMyMessages.count * 100)
    : 0
  const progressBar = '█'.repeat(Math.floor(enrichPct / 5)) + '░'.repeat(20 - Math.floor(enrichPct / 5))
  console.log(`[${progressBar}] ${enrichPct}%`)
  console.log(`${formatNumber(enrichedCount.count)} / ${formatNumber(totalMyMessages.count)} messages enriched`)

  // Extraction History
  console.log('\n\nEXTRACTION HISTORY')
  console.log('───────────────────────────────────────────────────────────────')
  if (extractions.length === 0) {
    console.log('No extractions completed yet.')
  } else {
    console.log(`${'Source'.padEnd(12)} ${'Last Run'.padEnd(22)} ${'Newest Item'.padEnd(22)} ${'Items'.padStart(8)}`)
    console.log('─'.repeat(65))
    for (const e of extractions) {
      if (sourceFilter && e.source !== sourceFilter) continue
      console.log(`${e.source.padEnd(12)} ${formatDate(e.last_extraction).padEnd(22)} ${formatDate(e.newest_item).padEnd(22)} ${formatNumber(e.total_items).padStart(8)}`)
    }
  }

  console.log('\n═══════════════════════════════════════════════════════════════')
}

async function cmdExtract(args: ParsedArgs): Promise<void> {
  const source = args.positional[0] as Source

  if (!source) {
    console.error('Error: Source required')
    console.error('Usage: deep-context extract <source>')
    console.error(`Valid sources: ${VALID_SOURCES.join(', ')}`)
    process.exit(1)
  }

  if (!VALID_SOURCES.includes(source as Source)) {
    console.error(`Error: Invalid source "${source}"`)
    console.error(`Valid sources: ${VALID_SOURCES.join(', ')}`)
    process.exit(1)
  }

  let fromDate = args.flags.from as string | undefined
  const toDate = args.flags.to as string | undefined
  const limit = args.flags.limit as number | undefined
  const dryRun = args.flags['dry-run']
  const backfill = args.flags.backfill

  console.log(`Extracting from: ${source}`)
  if (fromDate) console.log(`  From: ${fromDate}`)
  if (toDate) console.log(`  To: ${toDate}`)
  if (limit) console.log(`  Limit: ${limit}`)
  if (backfill) console.log(`  [BACKFILL MODE — full history scan]`)
  if (dryRun) console.log(`  [DRY RUN]`)

  const db = getDb()

  // Log extraction start
  let extractionId: number | null = null
  if (!dryRun) {
    extractionId = await withDbRetry(() => {
      const result = db.query(`
        INSERT INTO extraction_log (source, extraction_type, started_at, parameters, status)
        VALUES (?, 'full', datetime('now'), ?, 'running')
        RETURNING id
      `).get(source, JSON.stringify({ fromDate, toDate, limit })) as { id: number } | null
      return result?.id ?? null
    })
  }

  try {
    let itemsExtracted = 0
    let newestTimestamp: string | null = null
    let oldestTimestamp: string | null = null

    switch (source) {
      case 'twitter': {
        const twitterResult = await extractTwitter(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        const dmResult = await extractTwitterDMs(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        const liveResult = await extractTwitterLive(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = twitterResult.count + dmResult.count + liveResult.count
        const allTimestamps = [twitterResult, dmResult, liveResult]
        newestTimestamp = allTimestamps.reduce((acc, r) => {
          if (!r.newest) return acc
          return !acc || r.newest > acc ? r.newest : acc
        }, null as string | null)
        oldestTimestamp = allTimestamps.reduce((acc, r) => {
          if (!r.oldest) return acc
          return !acc || r.oldest < acc ? r.oldest : acc
        }, null as string | null)
        break
      }
      case 'twitter-live': {
        const twitterLiveResult = await extractTwitterLive(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = twitterLiveResult.count
        newestTimestamp = twitterLiveResult.newest
        oldestTimestamp = twitterLiveResult.oldest
        break
      }
      case 'calls':
        const callsResult = await extractCalls(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = callsResult.count
        newestTimestamp = callsResult.newest
        oldestTimestamp = callsResult.oldest
        break
      case 'gmail':
        const gmailResult = await extractGmail(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = gmailResult.count
        newestTimestamp = gmailResult.newest
        oldestTimestamp = gmailResult.oldest
        break
      case 'slack': {
        if (!fromDate) {
          const newestSlack = db.query(`
            SELECT MAX(last_activity_at) as newest FROM threads WHERE source = 'slack'
          `).get() as { newest: string | null } | null
          if (newestSlack?.newest) {
            const d = new Date(newestSlack.newest)
            d.setDate(d.getDate() - 7)
            fromDate = d.toISOString().split('T')[0]
            console.log(`  Slack: auto-detected --from ${fromDate} (7 days before newest thread)`)
          }
        }
        const slackChannelsResult = await extractSlackChannels(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        console.log(`\n=== Slack channel (from:) pass done: ${slackChannelsResult.count} items ===`)
        console.log(`=== Starting Slack mentions pass ===`)
        const slackMentionsResult = await extractSlackMentions(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        console.log(`\n=== Slack mentions pass done: ${slackMentionsResult.count} items ===`)
        console.log(`=== Starting Slack full-capture pass (configured channels) ===`)
        const slackFullResult = await extractSlackChannelFull(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = slackChannelsResult.count + slackMentionsResult.count + slackFullResult.count
        newestTimestamp = [slackChannelsResult.newest, slackMentionsResult.newest, slackFullResult.newest].filter(Boolean).sort().pop() || null
        oldestTimestamp = [slackChannelsResult.oldest, slackMentionsResult.oldest, slackFullResult.oldest].filter(Boolean).sort().shift() || null
        break
      }
      case 'slack-mentions': {
        if (!fromDate) {
          const wm = db.query(`
            SELECT MIN(last_seen_ts) as oldest_wm FROM extraction_watermarks
            WHERE source = 'slack-mentions'
          `).get() as { oldest_wm: string | null } | null
          if (wm?.oldest_wm) {
            const d = new Date(wm.oldest_wm)
            d.setDate(d.getDate() - 7)
            fromDate = d.toISOString().split('T')[0]
            console.log(`  Slack-mentions: auto-detected --from ${fromDate} (7 days before oldest watermark)`)
          }
        }
        const slackMentionsResult = await extractSlackMentions(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = slackMentionsResult.count
        newestTimestamp = slackMentionsResult.newest
        oldestTimestamp = slackMentionsResult.oldest
        break
      }
      case 'slack-channel-full': {
        const channelFilter = args.flags.channel as string | undefined
        const slackFullResult = await extractSlackChannelFull(db, { fromDate, toDate, limit, dryRun: !!dryRun, channelFilter })
        itemsExtracted = slackFullResult.count
        newestTimestamp = slackFullResult.newest
        oldestTimestamp = slackFullResult.oldest
        break
      }
      case 'slack-dm':
        if (!fromDate) {
          const newestSlackDM = db.query(`
            SELECT MAX(last_activity_at) as newest FROM threads WHERE source = 'slack-dm'
          `).get() as { newest: string | null } | null
          if (newestSlackDM?.newest) {
            const d = new Date(newestSlackDM.newest)
            d.setDate(d.getDate() - 7)
            fromDate = d.toISOString().split('T')[0]
            console.log(`  Slack-DM: auto-detected --from ${fromDate} (7 days before newest thread)`)
          }
        }
        const slackDMsResult = await extractSlackDMs(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = slackDMsResult.count
        newestTimestamp = slackDMsResult.newest
        oldestTimestamp = slackDMsResult.oldest
        break
      case 'beeper':
        const beeperResult = await extractBeeper(db, { fromDate, toDate, limit, dryRun: !!dryRun, backfill: !!backfill })
        itemsExtracted = beeperResult.count
        newestTimestamp = beeperResult.newest
        oldestTimestamp = beeperResult.oldest
        break
      case 'groupme':
        const groupmeResult = await extractGroupMe(db, { fromDate, toDate, limit, dryRun: !!dryRun, backfill: !!backfill })
        itemsExtracted = groupmeResult.count
        newestTimestamp = groupmeResult.newest
        oldestTimestamp = groupmeResult.oldest
        break
      case 'podcast':
        const podcastResult = await extractPodcast(db, { fromDate, toDate, limit, dryRun: !!dryRun })
        itemsExtracted = podcastResult.count
        newestTimestamp = podcastResult.newest
        oldestTimestamp = podcastResult.oldest
        break
    }

    // Update extraction log
    if (!dryRun && extractionId) {
      await withDbRetry(() => {
        db.query(`
          UPDATE extraction_log
          SET completed_at = datetime('now'),
              items_extracted = ?,
              newest_item_timestamp = ?,
              oldest_item_timestamp = ?,
              status = 'completed'
          WHERE id = ?
        `).run(itemsExtracted, newestTimestamp, oldestTimestamp, extractionId)
      })
    }

    if (itemsExtracted > 0) {
      console.log(`\nExtraction complete: ${formatNumber(itemsExtracted)} items`)
    }

  } catch (err) {
    if (!dryRun && extractionId) {
      await withDbRetry(() => {
        db.query(`
          UPDATE extraction_log
          SET completed_at = datetime('now'), status = 'failed', error_message = ?
          WHERE id = ?
        `).run((err as Error).message, extractionId)
      })
    }
    throw err
  } finally {
    db.close()
  }
}

// ============================================================
// TWITTER EXTRACTION
// ============================================================

interface ExtractionResult {
  count: number
  newest: string | null
  oldest: string | null
}

// Build a targeted Gmail query for inbound threads from known contacts
function buildContactInboundQuery(db: Database): { query: string; contactCount: number; firstRun: boolean } | null {
  // Check if we've ever done an inbound pass before
  const hasInbound = db.query(`
    SELECT count(*) as cnt FROM threads WHERE source = 'gmail' AND my_message_count = 0
  `).get() as { cnt: number }
  const firstRun = hasInbound.cnt === 0

  // Get emails from people the owner has emailed (via gmail thread participants)
  // Top 100 most recent + top 100 most frequent, deduplicated
  const recentContacts = db.query(`
    SELECT p.id, p.identifiers, MAX(t.last_activity_at) as last_activity
    FROM threads t, json_each(t.participant_ids) je
    JOIN people p ON p.id = je.value
    WHERE t.source = 'gmail' AND t.my_message_count > 0 AND je.value != '${OWNER_CONFIG.personId}'
    GROUP BY p.id
    ORDER BY last_activity DESC
    LIMIT 100
  `).all() as { id: string; identifiers: string; last_activity: string }[]

  const frequentContacts = db.query(`
    SELECT p.id, p.identifiers, COUNT(DISTINCT t.id) as shared_threads
    FROM threads t, json_each(t.participant_ids) je
    JOIN people p ON p.id = je.value
    WHERE t.source = 'gmail' AND t.my_message_count > 0 AND je.value != '${OWNER_CONFIG.personId}'
    GROUP BY p.id
    ORDER BY shared_threads DESC
    LIMIT 100
  `).all() as { id: string; identifiers: string; shared_threads: number }[]

  // Extract unique email addresses
  const emailSet = new Set<string>()
  for (const contact of [...recentContacts, ...frequentContacts]) {
    try {
      const ids = JSON.parse(contact.identifiers) as string[]
      for (const id of ids) {
        if (id.includes('@') && !id.startsWith('slack:') && !id.includes('noreply') && !id.includes('no-reply')) {
          emailSet.add(id.toLowerCase())
        }
      }
    } catch {}
  }

  const emails = [...emailSet]
  if (emails.length === 0) return null

  // Gmail search supports long OR queries
  const orClause = emails.map(e => e).join(' OR ')
  return {
    query: `from:(${orClause}) -category:promotions -category:updates -category:social`,
    contactCount: emails.length,
    firstRun,
  }
}

// Wrapper: adapts gmail-extractor's standalone function to the (db, opts) pattern
async function extractGmail(
  _db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  // Each mailbox carries its own source value ('gmail', 'gmail-travel', …), so
  // the auto-detected start date must be scoped to the one we're reading —
  // otherwise a busy stretch in the primary account would advance the travel
  // account's window past mail it never fetched.
  if (GMAIL_SOURCE !== 'gmail') console.log(`  Gmail: reading peer account → source '${GMAIL_SOURCE}'`)

  let fromDate = opts.fromDate
  if (!fromDate) {
    const newest = _db.query(`
      SELECT MAX(last_activity_at) as newest FROM threads WHERE source = ?
    `).get(GMAIL_SOURCE) as { newest: string | null } | null
    if (newest?.newest) {
      const d = new Date(newest.newest)
      d.setDate(d.getDate() - 7)
      fromDate = d.toISOString().split('T')[0]
      console.log(`  Gmail: auto-detected --from ${fromDate} (7 days before newest ${GMAIL_SOURCE} thread)`)
    } else if (GMAIL_SOURCE !== 'gmail') {
      console.log(`  Gmail: no prior ${GMAIL_SOURCE} threads — pass --from to bound the first run`)
    }
  }

  // Pass 1: the owner's sent messages (existing behavior)
  console.log('  Gmail Pass 1: Outbound (from:me)')
  const sentResult = await extractGmailRaw({
    query: 'from:me -category:promotions -category:updates -category:social',
    fromDate,
    toDate: opts.toDate,
    limit: opts.limit,
    dryRun: opts.dryRun,
  })

  // Pass 2: Inbound from known contacts (people the owner has emailed)
  const inboundQuery = buildContactInboundQuery(_db)
  if (inboundQuery) {
    console.log(`\n  Gmail Pass 2: Inbound from ${inboundQuery.contactCount} known contacts`)
    const inboundResult = await extractGmailRaw({
      query: inboundQuery.query,
      fromDate: inboundQuery.firstRun ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] : fromDate,
      toDate: opts.toDate,
      limit: opts.limit ? Math.floor(opts.limit / 2) : undefined,
      dryRun: opts.dryRun,
    })
    return {
      count: sentResult.count + inboundResult.count,
      newest: [sentResult.newest, inboundResult.newest].filter(Boolean).sort().pop() ?? null,
      oldest: [sentResult.oldest, inboundResult.oldest].filter(Boolean).sort().shift() ?? null,
    }
  }

  return sentResult
}

async function extractTwitter(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  // Load config for archive path
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const archivePath = config.extraction?.twitter?.archive_path

  if (!archivePath) {
    console.error('Error: Twitter archive path not configured')
    console.error('Add to config.json: extraction.twitter.archive_path')
    return { count: 0, newest: null, oldest: null }
  }

  if (!existsSync(archivePath)) {
    // Archives are one-shot imports: once absorbed into the DB they're usually
    // deleted from Downloads. Not an error — the live API pass covers ongoing
    // tweets. Only matters if you've just downloaded a fresh archive.
    console.log(`  Skipping archive pass (not present at ${archivePath}) — live API pass covers recent tweets`)
    return { count: 0, newest: null, oldest: null }
  }

  console.log(`\nReading Twitter archive from: ${archivePath}`)

  // Parse tweets.js
  const tweetsPath = join(archivePath, 'data/tweets.js')
  if (!existsSync(tweetsPath)) {
    console.error(`Error: tweets.js not found at: ${tweetsPath}`)
    return { count: 0, newest: null, oldest: null }
  }

  let tweetsContent = readFileSync(tweetsPath, 'utf8')
  // Remove JS assignment prefix: window.YTD.tweets.part0 = [...]
  tweetsContent = tweetsContent.replace(/^window\.YTD\.tweets\.part\d+\s*=\s*/, '')
  const tweets = JSON.parse(tweetsContent) as Array<{ tweet: Record<string, unknown> }>

  console.log(`Found ${formatNumber(tweets.length)} tweets in archive`)

  // Load note tweets if available (long-form tweets)
  const noteTweetsPath = join(archivePath, 'data/note-tweet.js')
  const noteMap = new Map<string, string>()
  if (existsSync(noteTweetsPath)) {
    let notesContent = readFileSync(noteTweetsPath, 'utf8')
    notesContent = notesContent.replace(/^window\.YTD\.note_tweet\.part\d+\s*=\s*/, '')
    try {
      const notes = JSON.parse(notesContent) as Array<{
        noteTweet?: {
          noteTweetResults?: {
            result?: { text?: string; createdAt?: string }
          }
        }
      }>
      for (const note of notes) {
        const text = note.noteTweet?.noteTweetResults?.result?.text
        if (text) {
          // Use first 100 chars as key for matching
          noteMap.set(text.slice(0, 100), text)
        }
      }
      console.log(`Found ${noteMap.size} note tweets`)
    } catch {
      console.log('Could not parse note tweets')
    }
  }

  // Ensure the owner's person record exists
  const ownerId = OWNER_CONFIG.personId
  const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
  if (!existingOwner && !opts.dryRun) {
    db.query(`
      INSERT INTO people (id, display_name, identifiers, first_seen)
      VALUES (?, ?, ?, datetime('now'))
    `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], OWNER_CONFIG.twitterHandle]))
  }

  let extracted = 0
  let skipped = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null

  // Sort by date descending (newest first)
  const sortedTweets = tweets.sort((a, b) => {
    const dateA = new Date(a.tweet.created_at as string).getTime()
    const dateB = new Date(b.tweet.created_at as string).getTime()
    return dateB - dateA
  })

  for (const item of sortedTweets) {
    const tweet = item.tweet

    // Parse timestamp
    const createdAt = tweet.created_at as string
    const timestamp = new Date(createdAt).toISOString()
    const dateOnly = timestamp.split('T')[0]

    // Apply date filters
    if (opts.fromDate && dateOnly < opts.fromDate) continue
    if (opts.toDate && dateOnly > opts.toDate) continue

    // Apply limit
    if (opts.limit && extracted >= opts.limit) break

    const tweetId = (tweet.id_str as string) || String(tweet.id)
    const threadId = `twitter:${tweetId}`
    const messageId = `twitter:${tweetId}`

    // Check if already exists
    const existing = db.query(`SELECT id FROM messages WHERE id = ?`).get(messageId)
    if (existing) {
      skipped++
      continue
    }

    // Get tweet content
    let content = (tweet.full_text as string) || (tweet.text as string) || ''

    // Check for note tweet match (long-form)
    const noteKey = content.slice(0, 100)
    const noteContent = noteMap.get(noteKey)
    if (noteContent) {
      content = noteContent
    }

    // Determine content type
    let contentType = 'tweet'
    const inReplyTo = tweet.in_reply_to_status_id_str as string | undefined
    const quotedId = (tweet.quoted_status_id_str as string | undefined)

    if (inReplyTo) {
      contentType = 'reply'
    } else if (quotedId) {
      contentType = 'quote_tweet'
    }

    // Extract quoted content if available
    let quotedContent: string | null = null
    if (tweet.quoted_status) {
      quotedContent = (tweet.quoted_status as Record<string, unknown>).full_text as string ||
        (tweet.quoted_status as Record<string, unknown>).text as string || null
    }

    const tweetUrl = `https://twitter.com/${OWNER_CONFIG.twitterHandle}/status/${tweetId}`

    // Track timestamps
    if (!newestTimestamp || timestamp > newestTimestamp) newestTimestamp = timestamp
    if (!oldestTimestamp || timestamp < oldestTimestamp) oldestTimestamp = timestamp

    if (!opts.dryRun) {
      // Create thread
      db.query(`
        INSERT OR IGNORE INTO threads (id, source, source_thread_id, source_url, started_at, last_activity_at, message_count, my_message_count, thread_type)
        VALUES (?, 'twitter', ?, ?, ?, ?, 1, 1, 'standalone')
      `).run(threadId, tweetId, tweetUrl, timestamp, timestamp)

      // Create message
      db.query(`
        INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, reply_to_message_id, quoted_content, word_count, raw_json)
        VALUES (?, ?, 'twitter', ?, ?, 1, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        threadId,
        tweetId,
        timestamp,
        ownerId,
        content,
        contentType,
        inReplyTo ? `twitter:${inReplyTo}` : null,
        quotedContent,
        content.split(/\s+/).length,
        JSON.stringify(tweet)
      )
    }

    extracted++

    if (extracted % 500 === 0) {
      console.log(`  Processed ${formatNumber(extracted)} tweets...`)
    }
  }

  console.log(`Extracted: ${formatNumber(extracted)}, Skipped (already exists): ${formatNumber(skipped)}`)

  // Post-processing: group self-reply chains and add parent stubs
  if (extracted > 0 && !opts.dryRun) {
    console.log('\nPost-processing: grouping self-reply chains...')
    const phase1 = groupTwitterSelfReplies(db, { dryRun: false })
    if (phase1.chainsFound > 0) {
      console.log(`  Merged ${formatNumber(phase1.chainsFound)} chains (${formatNumber(phase1.messagesMoved)} messages moved)`)
    }

    console.log('Post-processing: adding parent tweet stubs...')
    const likeIndex = loadLikeIndex(archivePath)
    const phase2 = addParentTweetStubs(db, { dryRun: false, likeIndex })
    if (phase2.stubsCreated > 0) {
      console.log(`  Created ${formatNumber(phase2.stubsCreated)} stubs, ${formatNumber(phase2.peopleCreated)} people records`)
    }
  }

  return { count: extracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// TWITTER LIVE EXTRACTION (via the official X API — tools/twitter-api.ts)
// ============================================================

async function extractTwitterLive(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  console.log('\n--- Twitter Live Extraction ---')

  const fetchLimit = opts.limit || 200
  if (!OWNER_CONFIG.twitterHandle) {
    console.log('  No twitterHandle in OWNER_CONFIG — skipping live extraction')
    return { count: 0, newest: null, oldest: null }
  }
  console.log(`  Fetching up to ${fetchLimit} recent tweets from @${OWNER_CONFIG.twitterHandle} via the X API...`)

  // Fetch via the official X API (twitter-api.ts). Requires X_API_* credentials in tools/.env.
  // Normalize the API payload into the minimal shape the insert logic below expects.
  type LiveTweet = { id: string; text: string; created_at?: string; conversation_id?: string; quoted_tweet?: { text: string } }
  let tweets: LiveTweet[]
  try {
    const proc = await Bun.$`~/.bun/bin/bun ${join(import.meta.dir, 'twitter-api.ts')} user-tweets --username ${OWNER_CONFIG.twitterHandle} --limit ${fetchLimit}`.quiet()
    const payload = JSON.parse(proc.stdout.toString())
    const includesTweets = new Map<string, any>((payload?.includes?.tweets ?? []).map((t: any) => [t.id, t]))
    tweets = (payload?.data ?? []).map((t: any): LiveTweet => {
      let quoted_tweet: { text: string } | undefined
      const quotedRef = (t.referenced_tweets ?? []).find((r: any) => r.type === 'quoted')
      if (quotedRef) {
        const qt = includesTweets.get(quotedRef.id)
        if (qt?.text) quoted_tweet = { text: qt.text }
      }
      return { id: t.id, text: t.text, created_at: t.created_at, conversation_id: t.conversation_id, quoted_tweet }
    })
    console.log(`  Fetched ${formatNumber(tweets.length)} tweets from the X API`)
  } catch (e) {
    console.log(`  Twitter live fetch skipped: ${((e as Error).message || '').split('\n')[0] || 'X API not configured'}`)
    console.log('  (Set X_API_* credentials in tools/.env to enable live Twitter extraction — see .env.example.)')
    return { count: 0, newest: null, oldest: null }
  }

  if (tweets.length === 0) {
    console.log('  No tweets returned')
    return { count: 0, newest: null, oldest: null }
  }

  // Ensure the owner's person record exists
  const ownerId = OWNER_CONFIG.personId
  const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
  if (!existingOwner && !opts.dryRun) {
    db.query(`
      INSERT INTO people (id, display_name, identifiers, first_seen)
      VALUES (?, ?, ?, datetime('now'))
    `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], OWNER_CONFIG.twitterHandle]))
  }

  let extracted = 0
  let skipped = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null

  for (const tweet of tweets) {
    if (!tweet.created_at) continue

    const timestamp = new Date(tweet.created_at).toISOString()
    const dateOnly = timestamp.split('T')[0]

    // Apply date filters
    if (opts.fromDate && dateOnly < opts.fromDate) continue
    if (opts.toDate && dateOnly > opts.toDate) continue

    // Apply limit
    if (opts.limit && extracted >= opts.limit) break

    const tweetId = tweet.id
    const threadId = `twitter:${tweetId}`
    const messageId = `twitter:${tweetId}`

    // Check if already exists (dedup with archive)
    const existing = db.query(`SELECT id FROM messages WHERE id = ?`).get(messageId)
    if (existing) {
      skipped++
      continue
    }

    // Determine content type
    let contentType = 'tweet'
    if (tweet.conversation_id && tweet.conversation_id !== tweet.id) {
      contentType = 'reply'
    }
    if (tweet.quoted_tweet) {
      contentType = 'quote_tweet'
    }

    // Extract quoted content
    let quotedContent: string | null = null
    if (tweet.quoted_tweet) {
      quotedContent = tweet.quoted_tweet.text || null
    }

    const content = tweet.text
    const tweetUrl = `https://twitter.com/${OWNER_CONFIG.twitterHandle}/status/${tweetId}`

    // Track timestamps
    if (!newestTimestamp || timestamp > newestTimestamp) newestTimestamp = timestamp
    if (!oldestTimestamp || timestamp < oldestTimestamp) oldestTimestamp = timestamp

    if (!opts.dryRun) {
      // Create thread
      db.query(`
        INSERT OR IGNORE INTO threads (id, source, source_thread_id, source_url, started_at, last_activity_at, message_count, my_message_count, thread_type)
        VALUES (?, 'twitter', ?, ?, ?, ?, 1, 1, 'standalone')
      `).run(threadId, tweetId, tweetUrl, timestamp, timestamp)

      // Create message (reply_to_message_id is null — live API lacks in_reply_to_status_id)
      db.query(`
        INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, reply_to_message_id, quoted_content, word_count, raw_json)
        VALUES (?, ?, 'twitter', ?, ?, 1, ?, 1, ?, ?, NULL, ?, ?, ?)
      `).run(
        messageId,
        threadId,
        tweetId,
        timestamp,
        ownerId,
        content,
        contentType,
        quotedContent,
        content.split(/\s+/).length,
        JSON.stringify(tweet)
      )
    }

    extracted++
  }

  console.log(`  Live: Extracted ${formatNumber(extracted)}, Skipped (already exists): ${formatNumber(skipped)}`)

  // Post-processing: group self-reply chains and add parent stubs
  if (extracted > 0 && !opts.dryRun) {
    console.log('  Post-processing: grouping self-reply chains...')
    const phase1 = groupTwitterSelfReplies(db, { dryRun: false })
    if (phase1.chainsFound > 0) {
      console.log(`    Merged ${formatNumber(phase1.chainsFound)} chains (${formatNumber(phase1.messagesMoved)} messages moved)`)
    }

    // For parent stubs, try to load like index from archive if available
    const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    const archivePath = config.extraction?.twitter?.archive_path
    const likeIndex = archivePath ? loadLikeIndex(archivePath) : new Map<string, string>()

    console.log('  Post-processing: adding parent tweet stubs...')
    const phase2 = addParentTweetStubs(db, { dryRun: false, likeIndex })
    if (phase2.stubsCreated > 0) {
      console.log(`    Created ${formatNumber(phase2.stubsCreated)} stubs, ${formatNumber(phase2.peopleCreated)} people records`)
    }
  }

  return { count: extracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// TWITTER THREAD GROUPING & PARENT STUBS
// ============================================================

// Phase 1: Group self-reply chains into proper threads
// A chain root is a tweet whose reply_to_message_id is NULL or points to a message NOT in the DB
function groupTwitterSelfReplies(db: Database, opts: { dryRun: boolean }): { chainsFound: number; messagesMoved: number } {
  // Find all chain roots: tweets where reply_to_message_id IS NULL
  // OR reply_to_message_id does not exist in the messages table
  const roots = db.query(`
    SELECT m.id, m.thread_id, m.timestamp
    FROM messages m
    WHERE m.source = 'twitter'
      AND m.content_type != 'dm'
      AND (
        m.reply_to_message_id IS NULL
        OR m.reply_to_message_id NOT IN (SELECT id FROM messages)
      )
  `).all() as Array<{ id: string; thread_id: string; timestamp: string }>

  let chainsFound = 0
  let messagesMoved = 0

  for (const root of roots) {
    // Walk descendants using recursive CTE, then order by timestamp
    // (handles branching trees where multiple tweets reply to the same parent)
    const chain = db.query(`
      WITH RECURSIVE chain AS (
        SELECT id, timestamp FROM messages WHERE id = ?
        UNION ALL
        SELECT m.id, m.timestamp
        FROM messages m JOIN chain c ON m.reply_to_message_id = c.id
        WHERE m.source = 'twitter' AND m.content_type != 'dm'
      )
      SELECT id FROM chain ORDER BY timestamp ASC
    `).all(root.id) as Array<{ id: string }>

    if (chain.length <= 1) continue // Not a multi-tweet thread

    chainsFound++

    if (opts.dryRun) {
      console.log(`  [DRY RUN] Would merge chain of ${chain.length} tweets rooted at ${root.id}`)
      messagesMoved += chain.length - 1
      continue
    }

    const rootThreadId = root.thread_id

    // Update position_in_thread for all messages in the chain (1-indexed, ordered by timestamp)
    for (let i = 0; i < chain.length; i++) {
      db.query(`UPDATE messages SET position_in_thread = ?, thread_id = ? WHERE id = ?`).run(i + 1, rootThreadId, chain[i].id)
    }

    // Get the last timestamp for last_activity_at
    const lastTimestamp = db.query(`
      SELECT MAX(timestamp) as last_ts FROM messages WHERE thread_id = ?
    `).get(rootThreadId) as { last_ts: string }

    // Update the root's thread record
    db.query(`
      UPDATE threads SET
        message_count = ?,
        my_message_count = ?,
        last_activity_at = ?,
        thread_type = 'thread'
      WHERE id = ?
    `).run(chain.length, chain.length, lastTimestamp.last_ts, rootThreadId)

    // Collect orphaned thread IDs (non-root threads in this chain)
    const nonRootIds = chain.filter(c => c.id !== root.id).map(c => `twitter:${c.id.replace('twitter:', '')}`)
    for (const orphanThreadId of nonRootIds) {
      // Only delete if no messages still point to it
      const remaining = db.query(`SELECT COUNT(*) as cnt FROM messages WHERE thread_id = ?`).get(orphanThreadId) as { cnt: number }
      if (remaining.cnt === 0) {
        db.query(`DELETE FROM threads WHERE id = ?`).run(orphanThreadId)
      }
    }

    messagesMoved += chain.length - 1
  }

  return { chainsFound, messagesMoved }
}

// Phase 2: Add parent tweet stubs for replies to others
// Creates a stub message for the tweet the owner was replying to, giving context
function addParentTweetStubs(db: Database, opts: { dryRun: boolean; likeIndex?: Map<string, string> }): { stubsCreated: number; peopleCreated: number } {
  // Find reply tweets where the parent tweet is NOT in the DB
  const replies = db.query(`
    SELECT m.id, m.reply_to_message_id, m.thread_id, m.timestamp, m.raw_json
    FROM messages m
    WHERE m.source = 'twitter'
      AND m.content_type = 'reply'
      AND m.reply_to_message_id IS NOT NULL
      AND m.reply_to_message_id NOT IN (SELECT id FROM messages)
  `).all() as Array<{
    id: string
    reply_to_message_id: string
    thread_id: string
    timestamp: string
    raw_json: string | null
  }>

  let stubsCreated = 0
  let peopleCreated = 0

  for (const reply of replies) {
    let screenName = ''
    let userId = ''

    if (reply.raw_json) {
      try {
        const raw = JSON.parse(reply.raw_json)
        screenName = raw.in_reply_to_screen_name || ''
        userId = raw.in_reply_to_user_id_str || ''
      } catch { /* ignore parse errors */ }
    }

    if (!screenName && !userId) continue // Can't create a useful stub without identity info

    const stubId = reply.reply_to_message_id // Already formatted as twitter:{id}
    const tweetIdRaw = stubId.replace('twitter:', '')
    const personId = userId ? `twitter-user-${userId}` : `twitter-user-${screenName}`
    const displayName = screenName ? `@${screenName}` : `@[${userId}]`
    const likedText = opts.likeIndex?.get(tweetIdRaw)
    const stubContent = likedText || `[Tweet by ${displayName} — content not available from archive]`
    const stubWordCount = likedText ? likedText.split(/\s+/).length : 0

    // Approximate timestamp: 1 second before the owner's reply
    const replyDate = new Date(reply.timestamp)
    replyDate.setSeconds(replyDate.getSeconds() - 1)
    const stubTimestamp = replyDate.toISOString()

    if (opts.dryRun) {
      stubsCreated++
      continue
    }

    // Insert stub message (OR IGNORE if already exists, e.g., from a previous run)
    const inserted = db.query(`
      INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp,
        position_in_thread, sender_id, is_from_me, content, content_type, word_count)
      VALUES (?, ?, 'twitter', ?, ?, 0, ?, 0, ?, 'tweet', ?)
    `).run(
      stubId,
      reply.thread_id,
      tweetIdRaw,
      stubTimestamp,
      personId,
      stubContent,
      stubWordCount
    )

    if (inserted.changes > 0) {
      stubsCreated++

      // Update thread: increment message_count, add participant
      db.query(`UPDATE threads SET message_count = message_count + 1 WHERE id = ?`).run(reply.thread_id)

      // Update participant_ids on the thread
      const thread = db.query(`SELECT participant_ids FROM threads WHERE id = ?`).get(reply.thread_id) as { participant_ids: string | null }
      let participants: string[] = []
      if (thread.participant_ids) {
        try { participants = JSON.parse(thread.participant_ids) } catch {}
      }
      if (!participants.includes(personId)) {
        participants.push(personId)
        db.query(`UPDATE threads SET participant_ids = ? WHERE id = ?`).run(JSON.stringify(participants), reply.thread_id)
      }
    }

    // Insert person record if not exists
    const existingPerson = db.query(`SELECT id FROM people WHERE id = ?`).get(personId)
    if (!existingPerson) {
      const identifiers = [userId, screenName ? `@${screenName}` : ''].filter(Boolean)
      db.query(`
        INSERT OR IGNORE INTO people (id, display_name, identifiers, first_seen)
        VALUES (?, ?, ?, ?)
      `).run(personId, displayName, JSON.stringify(identifiers), stubTimestamp)
      peopleCreated++
    }
  }

  return { stubsCreated, peopleCreated }
}

// Load Twitter like.js from archive → Map<tweetId, fullText>
function loadLikeIndex(archivePath: string): Map<string, string> {
  const likePath = join(archivePath, 'data/like.js')
  if (!existsSync(likePath)) {
    console.log('  like.js not found in archive, skipping like index')
    return new Map()
  }
  let content = readFileSync(likePath, 'utf8')
  content = content.replace(/^window\.YTD\.like\.part\d+\s*=\s*/, '')
  const likes = JSON.parse(content) as Array<{ like: { tweetId: string; fullText: string } }>
  const index = new Map<string, string>()
  for (const entry of likes) {
    index.set(entry.like.tweetId, entry.like.fullText)
  }
  console.log(`  Loaded ${formatNumber(index.size)} liked tweets from archive`)
  return index
}

// ============================================================
// TWITTER DM EXTRACTION
// ============================================================

const OWNER_TWITTER_ID = OWNER_CONFIG.twitterId

async function extractTwitterDMs(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const archivePath = config.extraction?.twitter?.archive_path

  if (!archivePath || !existsSync(archivePath)) {
    return { count: 0, newest: null, oldest: null }
  }

  // Load 1:1 DMs
  const dmsPath = join(archivePath, 'data/direct-messages.js')
  if (!existsSync(dmsPath)) {
    console.log('No direct-messages.js found')
    return { count: 0, newest: null, oldest: null }
  }

  let dmsContent = readFileSync(dmsPath, 'utf8')
  dmsContent = dmsContent.replace(/^window\.YTD\.direct_messages\.part\d+\s*=\s*/, '')
  const dms = JSON.parse(dmsContent) as Array<{
    dmConversation: {
      conversationId: string
      messages: Array<{
        messageCreate?: {
          id: string
          senderId: string
          recipientId: string
          text: string
          createdAt: string
          mediaUrls?: string[]
          urls?: Array<{ url: string; expanded: string }>
        }
      }>
    }
  }>

  console.log(`\nFound ${formatNumber(dms.length)} DM conversations`)

  // Also load group DMs
  const groupDmsPath = join(archivePath, 'data/direct-messages-group.js')
  let groupDms: typeof dms = []
  if (existsSync(groupDmsPath)) {
    let groupContent = readFileSync(groupDmsPath, 'utf8')
    groupContent = groupContent.replace(/^window\.YTD\.direct_messages_group\.part\d+\s*=\s*/, '')
    groupDms = JSON.parse(groupContent)
    console.log(`Found ${formatNumber(groupDms.length)} group DM conversations`)
  }

  const allConversations = [...dms, ...groupDms]

  // Ensure the owner's person record exists
  const ownerId = OWNER_CONFIG.personId
  const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
  if (!existingOwner && !opts.dryRun) {
    db.query(`
      INSERT INTO people (id, display_name, identifiers, first_seen)
      VALUES (?, ?, ?, datetime('now'))
    `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], OWNER_CONFIG.twitterHandle, OWNER_TWITTER_ID]))
  }

  let extracted = 0
  let skippedConvos = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null

  for (const convo of allConversations) {
    const conversationId = convo.dmConversation.conversationId
    const threadId = `twitter-dm:${conversationId}`

    // Check if thread already exists
    const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId)
    if (existingThread) {
      skippedConvos++
      continue
    }

    const messages = convo.dmConversation.messages
      .filter(m => m.messageCreate)
      .map(m => m.messageCreate!)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())

    if (messages.length === 0) continue

    // Check date filters on conversation range
    const firstMsgDate = new Date(messages[0].createdAt).toISOString().split('T')[0]
    const lastMsgDate = new Date(messages[messages.length - 1].createdAt).toISOString().split('T')[0]

    if (opts.toDate && firstMsgDate > opts.toDate) continue
    if (opts.fromDate && lastMsgDate < opts.fromDate) continue

    // Apply limit on conversations
    if (opts.limit && extracted >= opts.limit) break

    // Determine thread type and participants
    const participantTwitterIds = new Set<string>()
    for (const msg of messages) {
      participantTwitterIds.add(msg.senderId)
      participantTwitterIds.add(msg.recipientId)
    }
    participantTwitterIds.delete(OWNER_TWITTER_ID) // Remove the owner from "other participants"

    const isGroup = conversationId.includes(',') || participantTwitterIds.size > 1
    const threadType = isGroup ? 'group' : '1:1'

    // Count the owner's messages
    const myMessageCount = messages.filter(m => m.senderId === OWNER_TWITTER_ID).length
    const startedAt = new Date(messages[0].createdAt).toISOString()
    const lastActivityAt = new Date(messages[messages.length - 1].createdAt).toISOString()

    // Track timestamps
    if (!newestTimestamp || lastActivityAt > newestTimestamp) newestTimestamp = lastActivityAt
    if (!oldestTimestamp || startedAt < oldestTimestamp) oldestTimestamp = startedAt

    // Create people records for other participants (use Twitter IDs as names for now)
    const participantIds = [ownerId]
    for (const twitterId of participantTwitterIds) {
      const personId = `twitter-user-${twitterId}`
      participantIds.push(personId)

      if (!opts.dryRun) {
        const existing = db.query(`SELECT id FROM people WHERE id = ?`).get(personId)
        if (!existing) {
          db.query(`
            INSERT INTO people (id, display_name, identifiers, first_seen, last_seen, thread_count, message_count)
            VALUES (?, ?, ?, ?, ?, 1, ?)
          `).run(
            personId,
            `Twitter User ${twitterId}`,
            JSON.stringify([twitterId]),
            startedAt,
            lastActivityAt,
            messages.filter(m => m.senderId === twitterId).length
          )
        }
      }
    }

    if (!opts.dryRun) {
      // Create thread
      db.query(`
        INSERT INTO threads (id, source, source_thread_id, source_url, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type)
        VALUES (?, 'twitter-dm', ?, NULL, ?, ?, ?, ?, ?, ?)
      `).run(
        threadId,
        conversationId,
        startedAt,
        lastActivityAt,
        messages.length,
        myMessageCount,
        JSON.stringify(participantIds),
        threadType
      )

      // Create messages
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const messageId = `twitter-dm:${msg.id}`
        const timestamp = new Date(msg.createdAt).toISOString()
        const isFromMe = msg.senderId === OWNER_TWITTER_ID
        const senderId = isFromMe ? ownerId : `twitter-user-${msg.senderId}`

        // Expand URLs in text
        let content = msg.text
        if (msg.urls && msg.urls.length > 0) {
          for (const u of msg.urls) {
            content = content.replace(u.url, u.expanded)
          }
        }

        db.query(`
          INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count)
          VALUES (?, ?, 'twitter-dm', ?, ?, ?, ?, ?, ?, 'dm', ?)
        `).run(
          messageId,
          threadId,
          msg.id,
          timestamp,
          i + 1,
          senderId,
          isFromMe ? 1 : 0,
          content,
          content.split(/\s+/).length
        )
      }
    }

    extracted++

    if (extracted % 100 === 0) {
      console.log(`  Processed ${formatNumber(extracted)} DM conversations...`)
    }
  }

  console.log(`DMs extracted: ${formatNumber(extracted)} conversations, Skipped: ${formatNumber(skippedConvos)}`)
  return { count: extracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// CALLS EXTRACTION
// ============================================================

async function extractCalls(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  const callsCsvPath = join(PROJECT_ROOT, 'data/calls/calls.csv')
  const transcriptsDir = join(PROJECT_ROOT, 'data/calls/transcripts')

  if (!existsSync(callsCsvPath)) {
    console.error(`Error: calls.csv not found at: ${callsCsvPath}`)
    return { count: 0, newest: null, oldest: null }
  }

  // Parse CSV
  const { parse } = await import('csv-parse/sync')
  const csvContent = readFileSync(callsCsvPath, 'utf8')
  const calls = parse(csvContent, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>

  console.log(`\nFound ${formatNumber(calls.length)} calls in CSV`)

  // Ensure the owner's person record exists
  const ownerId = OWNER_CONFIG.personId
  const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
  if (!existingOwner && !opts.dryRun) {
    db.query(`
      INSERT INTO people (id, display_name, identifiers, first_seen)
      VALUES (?, ?, ?, datetime('now'))
    `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0]]))
  }

  let extracted = 0
  let skipped = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null

  // Sort by date descending (newest first)
  const sortedCalls = [...calls].sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  for (const call of sortedCalls) {
    const date = call.date
    if (!date) continue

    // Apply date filters
    if (opts.fromDate && date < opts.fromDate) continue
    if (opts.toDate && date > opts.toDate) continue

    // Apply limit
    if (opts.limit && extracted >= opts.limit) break

    const callId = call.fireflies_id
    if (!callId) continue

    const threadId = `calls:${callId}`

    // Check if thread already exists
    const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId)
    if (existingThread) {
      skipped++
      continue
    }

    const title = call.title || 'Untitled Call'
    const speakers = call.speakers || ''
    const transcriptUrl = call.transcript_url
    const timestamp = `${date}T12:00:00Z`

    // Track timestamps
    if (!newestTimestamp || timestamp > newestTimestamp) newestTimestamp = timestamp
    if (!oldestTimestamp || timestamp < oldestTimestamp) oldestTimestamp = timestamp

    // Try to load and parse transcript for speaker turns
    const transcriptFile = call.transcript_file
    const transcriptPath = transcriptFile ? join(PROJECT_ROOT, 'data/calls', transcriptFile) : null
    let speakerTurns: Array<{ speaker: string; text: string }> = []

    if (transcriptPath && existsSync(transcriptPath)) {
      const transcriptContent = readFileSync(transcriptPath, 'utf8')
      speakerTurns = parseTranscriptTurns(transcriptContent)
    }

    const messageCount = Math.max(speakerTurns.length, 1)
    const myMessageCount = speakerTurns.filter(t =>
      t.speaker.toLowerCase().includes(OWNER_CONFIG.displayName.split(' ')[0].toLowerCase()) || t.speaker === 'S0'
    ).length

    // Parse speakers for people records
    const speakerList = speakers.split(/[;,]/).map(s => s.trim()).filter(Boolean)
    const participantIds: string[] = [ownerId]

    for (const speakerName of speakerList) {
      if (speakerName.toLowerCase().includes(OWNER_CONFIG.displayName.split(' ')[0].toLowerCase())) continue
      if (speakerName.toLowerCase() === 'iphone') continue  // Skip device names

      // Use createSourcePersonId to prevent single-word name collisions
      const personId = createSourcePersonId(speakerName, 'calls', callId)
      if (!personId) continue
      participantIds.push(personId)

      if (!opts.dryRun) {
        const existing = db.query(`SELECT id FROM people WHERE id = ?`).get(personId)
        if (!existing) {
          db.query(`
            INSERT INTO people (id, display_name, identifiers, first_seen, last_seen, thread_count, message_count)
            VALUES (?, ?, ?, ?, ?, 1, ?)
          `).run(
            personId,
            speakerName,
            JSON.stringify([speakerName]),
            timestamp,
            timestamp,
            speakerTurns.filter(t => t.speaker === speakerName).length
          )
        } else {
          db.query(`
            UPDATE people
            SET last_seen = MAX(last_seen, ?), thread_count = thread_count + 1
            WHERE id = ?
          `).run(timestamp, personId)
        }
      }
    }

    if (!opts.dryRun) {
      // Create thread
      db.query(`
        INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
        VALUES (?, 'calls', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        threadId,
        callId,
        transcriptUrl || null,
        title,
        timestamp,
        timestamp,
        messageCount,
        myMessageCount,
        JSON.stringify(participantIds),
        speakerList.length > 2 ? 'group' : '1:1',
        JSON.stringify(call)
      )

      // Create messages for speaker turns
      if (speakerTurns.length > 0) {
        for (let i = 0; i < speakerTurns.length; i++) {
          const turn = speakerTurns[i]
          const messageId = `calls:${callId}:${i + 1}`
          const speakerName = turn.speaker

          // Determine if this is the owner
          const isFromMe = speakerName.toLowerCase().includes(OWNER_CONFIG.displayName.split(' ')[0].toLowerCase()) || speakerName === 'S0'
          const senderId = isFromMe ? ownerId : createSourcePersonId(speakerName, 'calls', callId)

          db.query(`
            INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count)
            VALUES (?, ?, 'calls', ?, ?, ?, ?, ?, ?, 'speaker_turn', ?)
          `).run(
            messageId,
            threadId,
            `${callId}:${i + 1}`,
            timestamp,
            i + 1,
            senderId || ownerId,
            isFromMe ? 1 : 0,
            turn.text,
            turn.text.split(/\s+/).length
          )
        }
      } else {
        // No transcript content - create placeholder
        db.query(`
          INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count)
          VALUES (?, ?, 'calls', ?, ?, 1, ?, 1, ?, 'speaker_turn', ?)
        `).run(
          `calls:${callId}:1`,
          threadId,
          `${callId}:1`,
          timestamp,
          ownerId,
          `[Call: ${title}]`,
          2
        )
      }
    }

    extracted++

    if (extracted % 50 === 0) {
      console.log(`  Processed ${formatNumber(extracted)} calls...`)
    }
  }

  console.log(`Extracted: ${formatNumber(extracted)}, Skipped (already exists): ${formatNumber(skipped)}`)
  return { count: extracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// Parse transcript file into speaker turns
function parseTranscriptTurns(content: string): Array<{ speaker: string; text: string }> {
  const turns: Array<{ speaker: string; text: string }> = []
  const lines = content.split('\n')

  let currentSpeaker = ''
  let currentText: string[] = []
  let inFrontmatter = false

  for (const line of lines) {
    // Skip YAML frontmatter
    if (line.trim() === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter) continue

    // Skip headers
    if (line.startsWith('#')) continue

    // Check for speaker turn markers
    // Deepgram format: "S0 (1:23)" or "Jane Doe (1:23)"
    // Fireflies format: "**Speaker Name**"
    const deepgramMatch = line.match(/^(\w+(?:\s+\w+)?)\s*\((\d+:\d+)\)\s*$/)
    const firefliesMatch = line.match(/^\*\*([^*]+)\*\*$/)

    if (deepgramMatch) {
      // Save previous turn
      if (currentSpeaker && currentText.length > 0) {
        turns.push({ speaker: currentSpeaker, text: currentText.join(' ').trim() })
      }
      currentSpeaker = deepgramMatch[1]
      currentText = []
    } else if (firefliesMatch) {
      // Save previous turn
      if (currentSpeaker && currentText.length > 0) {
        turns.push({ speaker: currentSpeaker, text: currentText.join(' ').trim() })
      }
      currentSpeaker = firefliesMatch[1]
      currentText = []
    } else if (currentSpeaker && line.trim()) {
      currentText.push(line.trim())
    }
  }

  // Don't forget the last turn
  if (currentSpeaker && currentText.length > 0) {
    turns.push({ speaker: currentSpeaker, text: currentText.join(' ').trim() })
  }

  return turns
}

// ============================================================
// SLACK EXTRACTION
// ============================================================

interface SlackWorkspace {
  name: string
  flag: string
  userId: string
  searchQuery: string
  mentionQueries: string[]
}

const SLACK_WORKSPACES: SlackWorkspace[] = Object.entries(OWNER_CONFIG.slackIdentifiers).map(([flag, info]) => ({
  name: flag,
  flag,
  userId: info.userId,
  searchQuery: info.searchQuery,
  mentionQueries: info.mentionQueries ?? [],
}))

interface SlackMessage {
  channel_id: string
  channel_name: string
  ts: string
  ts_sec: number
  user: string
  user_id?: string
  text: string
  url: string
  thread_ts?: string
}

interface SlackChannelMessage {
  ts: string
  ts_sec: number
  user: string
  user_id: string
  text: string
  url: string
  thread_ts?: string
  reply_count?: number
}

// Helper: sleep for exponential backoff
const slackSleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Fetch Slack user email from cache or API
 * Uses slack_user_cache table for caching
 */
async function fetchSlackUserEmail(
  db: Database,
  slackToolPath: string,
  workspace: string,
  userId: string,
  dryRun: boolean
): Promise<{ email: string | null; displayName: string | null }> {
  // Check cache first
  const cached = db.query(`
    SELECT email, display_name, real_name FROM slack_user_cache
    WHERE workspace = ? AND user_id = ?
  `).get(workspace, userId) as { email: string | null; display_name: string | null; real_name: string | null } | null

  if (cached) {
    return { email: cached.email, displayName: cached.real_name || cached.display_name }
  }

  // Fetch from Slack API using users.info
  try {
    const proc = Bun.spawnSync([
      'bun', slackToolPath, 'people', 'get', userId,
      '-w', workspace, '--json'
    ], { cwd: PROJECT_ROOT, env: process.env })

    if (proc.exitCode !== 0) {
      // Rate limited or error - cache null to avoid repeated failures
      if (!dryRun) {
        db.query(`
          INSERT OR REPLACE INTO slack_user_cache (workspace, user_id, email, display_name, fetched_at)
          VALUES (?, ?, NULL, NULL, datetime('now'))
        `).run(workspace, userId)
      }
      return { email: null, displayName: null }
    }

    const output = proc.stdout.toString().trim()
    const lastLine = output.split('\n').pop() || ''

    const userData = JSON.parse(lastLine) as {
      id?: string
      email?: string
      display_name?: string
      real_name?: string
      name?: string
    }

    const email = userData.email || null
    const displayName = userData.real_name || userData.display_name || userData.name || null

    // Cache the result
    if (!dryRun) {
      db.query(`
        INSERT OR REPLACE INTO slack_user_cache (workspace, user_id, email, display_name, real_name, fetched_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
      `).run(workspace, userId, email, userData.display_name || null, userData.real_name || null)
    }

    return { email, displayName }
  } catch (err) {
    // Cache null on error
    if (!dryRun) {
      db.query(`
        INSERT OR REPLACE INTO slack_user_cache (workspace, user_id, email, display_name, fetched_at)
        VALUES (?, ?, NULL, NULL, datetime('now'))
      `).run(workspace, userId)
    }
    return { email: null, displayName: null }
  }
}

/**
 * Resolve Slack user mentions (<@U12345>) to @DisplayName using the cache.
 * Also resolves channel mentions (<#C12345|channel-name>) to #channel-name.
 * Falls back to the raw user ID if not in cache.
 */
function resolveSlackMentions(
  db: Database,
  text: string,
  workspace: string
): string {
  if (!text || !text.includes('<@')) return text

  // Build a lookup map from the cache for this workspace (lazy, per-call)
  // This is fast since the cache is small (~135 entries)
  const cacheRows = db.query(`
    SELECT user_id, display_name, real_name FROM slack_user_cache
    WHERE workspace = ?
  `).all(workspace) as Array<{ user_id: string; display_name: string | null; real_name: string | null }>

  const nameMap = new Map<string, string>()
  for (const row of cacheRows) {
    const name = row.real_name || row.display_name
    if (name) nameMap.set(row.user_id, name)
  }

  // Replace <@U12345> or <@U12345|displayname> with @DisplayName
  // Slack uses both formats: newer is <@U12345>, older includes <@U12345|name>
  let resolved = text.replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*?))?>/gi, (_match, userId: string, pipeName: string | undefined) => {
    const name = nameMap.get(userId) || pipeName
    return name ? `@${name}` : `@${userId}`
  })

  // Replace <#C12345|channel-name> with #channel-name
  resolved = resolved.replace(/<#[CG][A-Z0-9]+\|([^>]+)>/gi, (_match, channelName: string) => {
    return `#${channelName}`
  })

  return resolved
}

// ============================================================
// SLACK DM EXTRACTION (slack-dm source)
// One thread per DM conversation, all messages flattened chronologically
// ============================================================

async function extractSlackDMs(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  const slackToolPath = join(PROJECT_ROOT, 'tools/slack.ts')

  if (!existsSync(slackToolPath)) {
    console.error('Error: slack.ts tool not found')
    return { count: 0, newest: null, oldest: null }
  }

  // Ensure the owner's person record exists
  const ownerId = OWNER_CONFIG.personId
  if (!opts.dryRun) {
    await withDbRetry(() => {
      const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
      if (!existingOwner) {
        db.query(`
          INSERT INTO people (id, display_name, identifiers, first_seen)
          VALUES (?, ?, ?, datetime('now'))
        `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], (OWNER_CONFIG.emails[1] || '')]))
      }
    })
  }

  let totalNew = 0
  let totalUpdated = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null
  const maxRetries = 5

  for (const workspace of SLACK_WORKSPACES) {
    console.log(`\n--- Processing ${workspace.name} DMs ---`)

    // Step 1: Use search to discover active DM channels (instead of listing all 543)
    // This reduces API calls from ~543 to only the channels with recent activity
    const searchQuery = `${workspace.searchQuery}${opts.fromDate ? ` after:${opts.fromDate}` : ''}${opts.toDate ? ` before:${opts.toDate}` : ''}`
    console.log(`  Search: ${searchQuery}`)

    const activeDMChannels = new Map<string, { name: string; isMpim: boolean }>()
    let searchPage = 1
    const maxSearchPages = 50

    while (searchPage <= maxSearchPages) {
      let retryCount = 0
      let searchProc = Bun.spawnSync([
        'bun', slackToolPath, 'search', 'messages', searchQuery,
        '-w', workspace.flag, '--limit', '100', '--page', String(searchPage), '--json'
      ], { cwd: PROJECT_ROOT, env: process.env })

      while (searchProc.exitCode !== 0 && searchProc.stderr.toString().includes('ratelimited') && retryCount < maxRetries) {
        retryCount++
        const waitTime = Math.pow(2, retryCount) * 1000
        console.log(`  Rate limited on search, waiting ${waitTime / 1000}s...`)
        await slackSleep(waitTime)
        searchProc = Bun.spawnSync([
          'bun', slackToolPath, 'search', 'messages', searchQuery,
          '-w', workspace.flag, '--limit', '100', '--page', String(searchPage), '--json'
        ], { cwd: PROJECT_ROOT, env: process.env })
      }

      if (searchProc.exitCode !== 0) {
        console.error(`  Search failed: ${searchProc.stderr.toString().substring(0, 200)}`)
        break
      }

      const searchOutput = searchProc.stdout.toString().trim()
      const searchLastLine = searchOutput.split('\n').pop() || ''

      try {
        const searchResult = JSON.parse(searchLastLine) as {
          items: Array<{ channel_id: string; channel_name: string; ts: string; text: string }>
          paging?: { pages: number; page: number; total: number }
        }

        if (!searchResult.items || searchResult.items.length === 0) break

        for (const msg of searchResult.items) {
          // Only include DM channels: D-prefix (1:1) or mpdm- (group DMs)
          const isDM = msg.channel_id.startsWith('D')
          const isMpim = (msg.channel_name || '').startsWith('mpdm-')
          if (isDM || isMpim) {
            if (!activeDMChannels.has(msg.channel_id)) {
              activeDMChannels.set(msg.channel_id, { name: msg.channel_name, isMpim })
            }
          }
        }

        // Check if there are more pages
        const totalPages = searchResult.paging?.pages || 1
        if (searchPage >= totalPages) break
        searchPage++
        await slackSleep(1500)
      } catch (e) { break }
    }

    console.log(`  Found ${activeDMChannels.size} active DM channels via search`)

    // Apply limit across all workspaces
    let workspaceNew = 0
    let workspaceUpdated = 0
    const workspaceLimit = opts.limit ? Math.ceil(opts.limit / SLACK_WORKSPACES.length) : undefined

    for (const [channelId, channelInfo] of activeDMChannels) {
      if (workspaceLimit && (workspaceNew + workspaceUpdated) >= workspaceLimit) break

      const threadId = `slack-dm:${workspace.flag}:${channelId}`

      // Check if thread already exists — if so, find latest message for incremental fetch
      const existingThread = db.query(`SELECT id, message_count FROM threads WHERE id = ?`).get(threadId) as { id: string; message_count: number } | null
      const latestMsgTs = existingThread
        ? (db.query(`SELECT MAX(source_message_id) as latest FROM messages WHERE thread_id = ?`).get(threadId) as { latest: string | null })?.latest?.split(':').pop() || null
        : null

      // Step 2: Fetch messages for this DM channel
      let historyRetryCount = 0
      let allMessages: SlackChannelMessage[] = []
      let cursor: string | null = null
      let pageNum = 0
      const maxPages = 50

      while (pageNum < maxPages) {
        pageNum++
        const getCmd = channelId.startsWith('D') ? 'chat' : 'channel'
        const args = ['bun', slackToolPath, 'get', getCmd, channelId, '-w', workspace.flag, '--limit', '500', '--json']
        if (cursor) args.push('--cursor', cursor)

        let historyProc = Bun.spawnSync(args, { cwd: PROJECT_ROOT, env: process.env })

        while (historyProc.exitCode !== 0 && historyProc.stderr.toString().includes('ratelimited') && historyRetryCount < maxRetries) {
          historyRetryCount++
          const waitTime = Math.pow(2, historyRetryCount) * 1000
          console.log(`    Rate limited on ${channelInfo.name}, waiting ${waitTime / 1000}s...`)
          await slackSleep(waitTime)
          historyProc = Bun.spawnSync(args, { cwd: PROJECT_ROOT, env: process.env })
        }

        if (historyProc.exitCode !== 0) break
        historyRetryCount = 0

        const historyOutput = historyProc.stdout.toString().trim()
        const historyLastLine = historyOutput.split('\n').pop() || ''

        try {
          const result = JSON.parse(historyLastLine) as {
            items: SlackChannelMessage[]
            next_cursor?: string
          }

          if (!result.items || result.items.length === 0) break
          allMessages.push(...result.items)

          // For existing threads: stop paginating once we reach messages already in DB
          if (latestMsgTs) {
            const oldestFetched = result.items[result.items.length - 1]
            if (oldestFetched && oldestFetched.ts <= latestMsgTs) break
          }

          if (result.next_cursor && result.next_cursor.length > 0) {
            cursor = result.next_cursor
            await slackSleep(1500)
          } else {
            break
          }
        } catch (e) { break }
      }

      if (allMessages.length === 0) continue

      // For existing threads: filter to only new messages
      if (latestMsgTs) {
        allMessages = allMessages.filter(m => m.ts > latestMsgTs)
        if (allMessages.length === 0) continue
      }

      // Fetch thread replies for messages with threads
      const threadsToFetch = new Set<string>()
      for (const msg of allMessages) {
        if (msg.thread_ts && msg.thread_ts !== msg.ts) {
          threadsToFetch.add(msg.thread_ts)
        }
        if (msg.reply_count && msg.reply_count > 0) {
          threadsToFetch.add(msg.ts)
        }
      }

      const threadMessages = new Map<string, SlackChannelMessage[]>()
      for (const threadTs of threadsToFetch) {
        let threadRetryCount = 0
        let threadProc = Bun.spawnSync([
          'bun', slackToolPath, 'get', 'thread',
          '--channel', channelId, '--ts', threadTs,
          '-w', workspace.flag, '--limit', '200', '--json'
        ], { cwd: PROJECT_ROOT, env: process.env })

        while (threadProc.exitCode !== 0 && threadProc.stderr.toString().includes('ratelimited') && threadRetryCount < maxRetries) {
          threadRetryCount++
          const waitTime = Math.pow(2, threadRetryCount) * 1000
          console.log(`    Rate limited fetching thread, waiting ${waitTime / 1000}s...`)
          await slackSleep(waitTime)
          threadProc = Bun.spawnSync([
            'bun', slackToolPath, 'get', 'thread', '--channel', channelId, '--ts', threadTs,
            '-w', workspace.flag, '--limit', '200', '--json'
          ], { cwd: PROJECT_ROOT, env: process.env })
        }

        if (threadProc.exitCode === 0) {
          const threadOutput = threadProc.stdout.toString().trim()
          const threadLastLine = threadOutput.split('\n').pop() || ''
          try {
            const threadResult = JSON.parse(threadLastLine) as { items: SlackChannelMessage[] }
            if (threadResult.items) {
              threadMessages.set(threadTs, threadResult.items)
            }
          } catch (e) { /* ignore */ }
        }
        await slackSleep(1500)
      }

      // Merge and deduplicate
      const messageMap = new Map<string, SlackChannelMessage>()
      for (const msg of allMessages) {
        messageMap.set(msg.ts, msg)
      }
      for (const [_, replies] of threadMessages) {
        for (const reply of replies) {
          if (!messageMap.has(reply.ts)) {
            messageMap.set(reply.ts, reply)
          }
        }
      }

      // For existing threads, filter out messages already in DB
      if (latestMsgTs) {
        for (const [ts] of messageMap) {
          if (ts <= latestMsgTs) messageMap.delete(ts)
        }
      }

      const newMessages = Array.from(messageMap.values()).sort((a, b) => a.ts_sec - b.ts_sec)
      if (newMessages.length === 0) continue

      const firstMsg = newMessages[0]
      const lastMsg = newMessages[newMessages.length - 1]
      const firstTimestamp = new Date(firstMsg.ts_sec * 1000).toISOString()
      const lastTimestamp = new Date(lastMsg.ts_sec * 1000).toISOString()

      // Track timestamps
      if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
      if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp

      const threadType = channelInfo.isMpim ? 'group' : '1:1'

      const myMessageCount = newMessages.filter(m =>
        m.user_id === workspace.userId || m.user === workspace.userId
      ).length

      if (!opts.dryRun) {
        await withDbRetry(() => {
          if (existingThread) {
            // Update existing thread: append new messages, update counts
            const currentCount = existingThread.message_count
            for (let i = 0; i < newMessages.length; i++) {
              const msg = newMessages[i]
              const messageId = `slack-dm:${workspace.flag}:${channelId}:${msg.ts}`
              const timestamp = new Date(msg.ts_sec * 1000).toISOString()
              const isFromMe = msg.user_id === workspace.userId || msg.user === workspace.userId
              const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)

              db.query(`
                INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
                VALUES (?, ?, 'slack-dm', ?, ?, ?, ?, ?, ?, 'slack_message', ?, ?)
              `).run(
                messageId, threadId,
                `${workspace.flag}:${channelId}:${msg.ts}`,
                timestamp, currentCount + i + 1,
                isFromMe ? ownerId : (msg.user_id || msg.user || 'unknown'),
                isFromMe ? 1 : 0,
                resolvedText, resolvedText.split(/\s+/).length,
                JSON.stringify(msg)
              )
            }

            // Update thread metadata
            db.query(`
              UPDATE threads SET
                last_activity_at = MAX(last_activity_at, ?),
                message_count = message_count + ?,
                my_message_count = my_message_count + ?
              WHERE id = ?
            `).run(lastTimestamp, newMessages.length, myMessageCount, threadId)

            workspaceUpdated++
          } else {
            // Create new thread
            db.query(`
              INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
              VALUES (?, 'slack-dm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
              threadId,
              `${workspace.flag}:${channelId}`,
              firstMsg.url?.split('?')[0] || '',
              `${workspace.name}: ${channelInfo.name}`,
              firstTimestamp, lastTimestamp,
              newMessages.length, myMessageCount,
              JSON.stringify([ownerId]), threadType,
              JSON.stringify({ workspace: workspace.flag, channel_id: channelId, channel_name: channelInfo.name })
            )

            for (let i = 0; i < newMessages.length; i++) {
              const msg = newMessages[i]
              const messageId = `slack-dm:${workspace.flag}:${channelId}:${msg.ts}`
              const timestamp = new Date(msg.ts_sec * 1000).toISOString()
              const isFromMe = msg.user_id === workspace.userId || msg.user === workspace.userId
              const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)

              db.query(`
                INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
                VALUES (?, ?, 'slack-dm', ?, ?, ?, ?, ?, ?, 'slack_message', ?, ?)
              `).run(
                messageId, threadId,
                `${workspace.flag}:${channelId}:${msg.ts}`,
                timestamp, i + 1,
                isFromMe ? ownerId : (msg.user_id || msg.user || 'unknown'),
                isFromMe ? 1 : 0,
                resolvedText, resolvedText.split(/\s+/).length,
                JSON.stringify(msg)
              )
            }

            workspaceNew++
          }
        })
      } else {
        if (existingThread) workspaceUpdated++
        else workspaceNew++
      }
    }

    console.log(`  ${workspace.name}: ${workspaceNew} new, ${workspaceUpdated} updated DM conversations`)
    totalNew += workspaceNew
    totalUpdated += workspaceUpdated
  }

  console.log(`\nTotal: ${totalNew} new, ${totalUpdated} updated DM conversations`)
  return { count: totalNew + totalUpdated, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// SLACK CHANNEL EXTRACTION (slack source)
// One thread per Slack thread (where the owner participated) OR context window
// ============================================================

async function extractSlackChannels(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  const slackToolPath = join(PROJECT_ROOT, 'tools/slack.ts')

  if (!existsSync(slackToolPath)) {
    console.error('Error: slack.ts tool not found')
    return { count: 0, newest: null, oldest: null }
  }

  // Ensure the owner's person record exists
  const ownerId = OWNER_CONFIG.personId
  if (!opts.dryRun) {
    await withDbRetry(() => {
      const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
      if (!existingOwner) {
        db.query(`
          INSERT INTO people (id, display_name, identifiers, first_seen)
          VALUES (?, ?, ?, datetime('now'))
        `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], (OWNER_CONFIG.emails[1] || '')]))
      }
    })
  }

  // NOTE: Extraction is additive-only. Existing threads are skipped, new ones are added.
  // A previous destructive migration was removed after it caused data loss.

  let totalExtracted = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null
  const maxRetries = 5

  for (const workspace of SLACK_WORKSPACES) {
    console.log(`\n--- Processing ${workspace.name} public channels ---`)

    // Step 1: Search for all the owner's messages to find which channels he's active in
    // IMPORTANT: Slack's search API only applies sort order to the first 100 pages (5,000 results).
    // Beyond that, results revert to relevance sorting, which causes gaps in chronological data.
    // To work around this, we search in 6-month date chunks to stay under the 100-page limit per chunk.
    const allOwnerMessages: SlackMessage[] = []
    const seenTimestamps = new Set<string>()

    // Generate date chunks (6-month periods) from start date to today
    const defaultFromDate = new Date()
    defaultFromDate.setFullYear(defaultFromDate.getFullYear() - 5)
    const startDate = opts.fromDate ? new Date(opts.fromDate) : defaultFromDate
    const endDate = opts.toDate ? new Date(opts.toDate) : new Date()

    interface DateChunk { from: string; to: string }
    const dateChunks: DateChunk[] = []
    let chunkStart = new Date(startDate)
    while (chunkStart < endDate) {
      const chunkEnd = new Date(chunkStart)
      chunkEnd.setMonth(chunkEnd.getMonth() + 6)
      if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime())

      dateChunks.push({
        from: chunkStart.toISOString().split('T')[0],
        to: chunkEnd.toISOString().split('T')[0]
      })
      chunkStart = new Date(chunkEnd)
      chunkStart.setDate(chunkStart.getDate() + 1) // Start next chunk day after
    }

    console.log(`  Searching in ${dateChunks.length} date chunks (6-month periods) to work around Slack API 100-page sort limit`)

    for (let chunkIdx = 0; chunkIdx < dateChunks.length; chunkIdx++) {
      const chunk = dateChunks[chunkIdx]
      console.log(`\n  [Chunk ${chunkIdx + 1}/${dateChunks.length}] ${chunk.from} to ${chunk.to}`)

      let currentPage = 1
      let totalPages = 1
      let retryCount = 0
      const maxPages = 100  // Stay under 100 pages per chunk to maintain sort order

      while (currentPage <= totalPages && currentPage <= maxPages) {
        const searchQuery = `${workspace.searchQuery} after:${chunk.from} before:${chunk.to}`

        const args = [
          slackToolPath,
          'search', 'messages',
          searchQuery,
          '-w', workspace.flag,
          '--limit', '50',
          '--page', String(currentPage),
          '--sort-dir', 'asc',  // oldest first for complete coverage
          '--json'
        ]

        const proc = Bun.spawnSync(['bun', ...args], { cwd: PROJECT_ROOT, env: process.env })

        if (proc.exitCode !== 0) {
          const stderr = proc.stderr.toString()
          if (stderr.includes('ratelimited')) {
            retryCount++
            if (retryCount > maxRetries) {
              console.error(`  Rate limit exceeded after ${maxRetries} retries, stopping chunk`)
              break
            }
            const waitTime = Math.pow(2, retryCount) * 1000
            console.log(`  Rate limited, waiting ${waitTime/1000}s before retry...`)
            await slackSleep(waitTime)
            continue
          }
          console.error(`  Search failed: ${stderr}`)
          break
        }

        retryCount = 0
        const output = proc.stdout.toString().trim()
        if (!output) break

        try {
          const result = JSON.parse(output) as { items: SlackMessage[]; total: number; page: number; pages: number }

          if (currentPage === 1) {
            totalPages = Math.min(result.pages || 1, maxPages)
            if (result.pages > 100) {
              console.log(`    WARNING: Chunk has ${result.pages} pages but will only fetch 100 (sort limit). Consider smaller date ranges.`)
            }
            console.log(`    Found ${result.total} messages in this chunk (${Math.min(result.pages, 100)} pages to fetch)`)
          }

          if (!result.items || result.items.length === 0) break

          for (const msg of result.items) {
            const key = `${msg.channel_id}:${msg.ts}`
            if (!seenTimestamps.has(key)) {
              seenTimestamps.add(key)
              // Only include public channel messages (not DMs)
              if (!msg.channel_name.startsWith('D') && !msg.channel_name.startsWith('mpdm-') && !msg.channel_name.match(/^U[A-Z0-9]+$/)) {
                allOwnerMessages.push(msg)
              }
            }
          }

          if (currentPage % 20 === 0 || currentPage === totalPages) {
            console.log(`    Page ${currentPage}/${totalPages}: ${allOwnerMessages.length} total messages so far`)
          }
          currentPage++

          if (opts.limit && allOwnerMessages.length >= opts.limit) break
          if (currentPage <= totalPages) await slackSleep(1500)
        } catch (e) {
          console.error(`  Failed to parse search results: ${e}`)
          break
        }
      }

      if (opts.limit && allOwnerMessages.length >= opts.limit) {
        console.log(`  Reached limit of ${opts.limit} messages`)
        break
      }
    }

    console.log(`  Found ${allOwnerMessages.length} messages from the owner in public channels`)
    if (allOwnerMessages.length === 0) continue

    // Step 2: Group messages by whether they're in a Slack thread or standalone
    // Thread messages: have thread_ts different from ts (they're replies)
    // Root messages with replies: have thread_ts === ts AND reply_count > 0
    // Standalone: no thread_ts or thread_ts === ts with no replies

    interface OwnerMsgGroup {
      channelId: string
      channelName: string
      threadTs: string | null
      messages: SlackMessage[]
      isThread: boolean
    }

    const threadGroups = new Map<string, OwnerMsgGroup>()
    const standaloneMessages: SlackMessage[] = []

    for (const msg of allOwnerMessages) {
      if (msg.thread_ts && msg.thread_ts !== msg.ts) {
        // This is a reply in a thread
        const key = `${msg.channel_id}:${msg.thread_ts}`
        if (!threadGroups.has(key)) {
          threadGroups.set(key, {
            channelId: msg.channel_id,
            channelName: msg.channel_name,
            threadTs: msg.thread_ts,
            messages: [],
            isThread: true
          })
        }
        threadGroups.get(key)!.messages.push(msg)
      } else if (msg.thread_ts === msg.ts) {
        // This is a thread root - the owner started a thread
        const key = `${msg.channel_id}:${msg.ts}`
        if (!threadGroups.has(key)) {
          threadGroups.set(key, {
            channelId: msg.channel_id,
            channelName: msg.channel_name,
            threadTs: msg.ts,
            messages: [],
            isThread: true
          })
        }
        threadGroups.get(key)!.messages.push(msg)
      } else {
        // Standalone message - no threading
        standaloneMessages.push(msg)
      }
    }

    console.log(`  Found ${threadGroups.size} threads and ${standaloneMessages.length} standalone messages`)

    // Step 3: Process thread groups - fetch full thread for each
    let workspaceExtracted = 0

    for (const [key, group] of threadGroups) {
      const threadId = `slack:${workspace.flag}:${group.channelId}:${group.threadTs}`

      // Check if thread already exists
      const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId)
      if (existingThread) continue

      // Fetch full thread
      let threadRetryCount = 0
      let threadProc = Bun.spawnSync([
        'bun', slackToolPath, 'get', 'thread',
        '--channel', group.channelId,
        '--ts', group.threadTs!,
        '-w', workspace.flag,
        '--limit', '200',
        '--json'
      ], { cwd: PROJECT_ROOT, env: process.env })

      while (threadProc.exitCode !== 0 && threadProc.stderr.toString().includes('ratelimited') && threadRetryCount < maxRetries) {
        threadRetryCount++
        const waitTime = Math.pow(2, threadRetryCount) * 1000
        console.log(`    Rate limited fetching thread, waiting ${waitTime/1000}s...`)
        await slackSleep(waitTime)
        threadProc = Bun.spawnSync([
          'bun', slackToolPath, 'get', 'thread', '--channel', group.channelId, '--ts', group.threadTs!,
          '-w', workspace.flag, '--limit', '200', '--json'
        ], { cwd: PROJECT_ROOT, env: process.env })
      }

      if (threadProc.exitCode !== 0) {
        await slackSleep(1500)
        continue
      }

      const threadOutput = threadProc.stdout.toString().trim()
      const threadLastLine = threadOutput.split('\n').pop() || ''

      let threadMessages: SlackChannelMessage[] = []
      try {
        const threadResult = JSON.parse(threadLastLine) as { items: SlackChannelMessage[] }
        threadMessages = threadResult.items || []
      } catch (e) {
        await slackSleep(1500)
        continue
      }

      if (threadMessages.length === 0) {
        await slackSleep(1500)
        continue
      }

      // Sort by timestamp
      threadMessages.sort((a, b) => a.ts_sec - b.ts_sec)

      const firstMsg = threadMessages[0]
      const lastMsg = threadMessages[threadMessages.length - 1]
      const firstTimestamp = new Date(firstMsg.ts_sec * 1000).toISOString()
      const lastTimestamp = new Date(lastMsg.ts_sec * 1000).toISOString()

      // Apply date filters
      if (opts.fromDate && lastTimestamp < opts.fromDate + 'T00:00:00.000Z') {
        await slackSleep(1500)
        continue
      }
      if (opts.toDate && firstTimestamp > opts.toDate + 'T23:59:59.999Z') {
        await slackSleep(1500)
        continue
      }

      // Track timestamps
      if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
      if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp

      // Get thread title from root message
      const rootMsg = threadMessages[0]
      const titlePreview = rootMsg.text.slice(0, 50) + (rootMsg.text.length > 50 ? '...' : '')

      // Count the owner's messages
      const myMessageCount = threadMessages.filter(m =>
        m.user_id === workspace.userId || m.user === workspace.userId
      ).length

      if (!opts.dryRun) {
        await withDbRetry(() => {
          db.query(`
            INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
            VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, 'channel-thread', ?)
          `).run(
            threadId,
            `${workspace.flag}:${group.channelId}:${group.threadTs}`,
            rootMsg.url?.split('?')[0] || '',
            `${workspace.name}: #${group.channelName} - ${titlePreview}`,
            firstTimestamp,
            lastTimestamp,
            threadMessages.length,
            myMessageCount,
            JSON.stringify([ownerId]),
            JSON.stringify({ workspace: workspace.flag, channel_id: group.channelId, channel_name: group.channelName, thread_ts: group.threadTs })
          )

          for (let i = 0; i < threadMessages.length; i++) {
            const msg = threadMessages[i]
            const messageId = `slack:${workspace.flag}:${group.channelId}:${msg.ts}`
            const timestamp = new Date(msg.ts_sec * 1000).toISOString()
            const isFromMe = msg.user_id === workspace.userId || msg.user === workspace.userId
            const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)

            db.query(`
              INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
              VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?, 'slack_message', ?, ?)
            `).run(
              messageId,
              threadId,
              `${workspace.flag}:${group.channelId}:${msg.ts}`,
              timestamp,
              i + 1,
              isFromMe ? ownerId : (msg.user_id || msg.user || 'unknown'),
              isFromMe ? 1 : 0,
              resolvedText,
              resolvedText.split(/\s+/).length,
              JSON.stringify(msg)
            )
          }
        })
      }

      workspaceExtracted++
      if (workspaceExtracted % 10 === 0) {
        console.log(`    Processed ${workspaceExtracted} threads...`)
      }

      await slackSleep(1500)
    }

    console.log(`  Extracted ${workspaceExtracted} thread conversations`)

    // Step 4: Process standalone messages - create context windows
    // Group nearby standalone messages to avoid creating many tiny threads
    console.log(`  Processing ${standaloneMessages.length} standalone messages with context windows...`)

    // Sort by channel and timestamp
    standaloneMessages.sort((a, b) => {
      if (a.channel_id !== b.channel_id) return a.channel_id.localeCompare(b.channel_id)
      return a.ts_sec - b.ts_sec
    })

    // Cluster messages that are within 24 hours of each other in the same channel
    interface ContextCluster {
      channelId: string
      channelName: string
      messages: SlackMessage[]
    }

    const clusters: ContextCluster[] = []
    let currentCluster: ContextCluster | null = null
    const GAP_HOURS = 24

    for (const msg of standaloneMessages) {
      if (!currentCluster || currentCluster.channelId !== msg.channel_id) {
        // New channel
        if (currentCluster) clusters.push(currentCluster)
        currentCluster = { channelId: msg.channel_id, channelName: msg.channel_name, messages: [msg] }
      } else {
        // Same channel - check time gap
        const lastMsg = currentCluster.messages[currentCluster.messages.length - 1]
        const gapSeconds = msg.ts_sec - lastMsg.ts_sec
        if (gapSeconds <= GAP_HOURS * 3600) {
          // Within gap - add to current cluster
          currentCluster.messages.push(msg)
        } else {
          // Gap too large - start new cluster
          clusters.push(currentCluster)
          currentCluster = { channelId: msg.channel_id, channelName: msg.channel_name, messages: [msg] }
        }
      }
    }
    if (currentCluster) clusters.push(currentCluster)

    console.log(`    Grouped into ${clusters.length} context clusters`)

    // For each cluster, fetch context around the messages
    let contextExtracted = 0

    for (const cluster of clusters) {
      // Use the first message's timestamp as the context anchor
      const anchorMsg = cluster.messages[0]
      const threadId = `slack:${workspace.flag}:${cluster.channelId}:ctx:${anchorMsg.ts}`

      // Check if thread already exists
      const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId)
      if (existingThread) continue

      // Fetch channel history around this time
      // We'll fetch messages before and after the anchor
      let contextRetryCount = 0
      const beforeCount = 5
      const afterCount = 10

      // Calculate time window: 1 hour before anchor to capture context
      const sinceTimestamp = anchorMsg.ts_sec - 3600  // 1 hour before
      const sinceISO = new Date(sinceTimestamp * 1000).toISOString()

      // Fetch messages starting from before the anchor timestamp
      let historyProc = Bun.spawnSync([
        'bun', slackToolPath, 'get', 'channel', cluster.channelId,
        '-w', workspace.flag,
        '--since', sinceISO,
        '--limit', '50', // Enough to capture context window
        '--json'
      ], { cwd: PROJECT_ROOT, env: process.env })

      while (historyProc.exitCode !== 0 && historyProc.stderr.toString().includes('ratelimited') && contextRetryCount < maxRetries) {
        contextRetryCount++
        const waitTime = Math.pow(2, contextRetryCount) * 1000
        console.log(`    Rate limited fetching context, waiting ${waitTime/1000}s...`)
        await slackSleep(waitTime)
        historyProc = Bun.spawnSync([
          'bun', slackToolPath, 'get', 'channel', cluster.channelId, '-w', workspace.flag,
          '--since', sinceISO, '--limit', '50', '--json'
        ], { cwd: PROJECT_ROOT, env: process.env })
      }

      if (historyProc.exitCode !== 0) {
        await slackSleep(1500)
        continue
      }

      const historyOutput = historyProc.stdout.toString().trim()
      const historyLastLine = historyOutput.split('\n').pop() || ''

      let channelMessages: SlackChannelMessage[] = []
      try {
        const historyResult = JSON.parse(historyLastLine) as { items: SlackChannelMessage[] }
        channelMessages = historyResult.items || []
      } catch (e) {
        await slackSleep(1500)
        continue
      }

      if (channelMessages.length === 0) {
        await slackSleep(1500)
        continue
      }

      // Sort by timestamp
      channelMessages.sort((a, b) => a.ts_sec - b.ts_sec)

      // Find the anchor message index
      const anchorIndex = channelMessages.findIndex(m => m.ts === anchorMsg.ts)
      if (anchorIndex === -1) {
        // Anchor not found - create context from just the owner's cluster messages
        // This can happen if the channel history doesn't go back far enough
        const fallbackWindow: SlackChannelMessage[] = cluster.messages.map(m => ({
          ts: m.ts,
          ts_sec: m.ts_sec,
          user: m.user,
          user_id: '',
          text: m.text,
          url: m.url
        }))
        fallbackWindow.sort((a, b) => a.ts_sec - b.ts_sec)

        if (fallbackWindow.length > 0) {
          const firstMsg = fallbackWindow[0]
          const lastMsg = fallbackWindow[fallbackWindow.length - 1]
          const firstTimestamp = new Date(firstMsg.ts_sec * 1000).toISOString()
          const lastTimestamp = new Date(lastMsg.ts_sec * 1000).toISOString()
          const anchorDate = new Date(anchorMsg.ts_sec * 1000).toISOString().split('T')[0]

          if (!opts.dryRun) {
            await withDbRetry(() => {
              db.query(`
                INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
                VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, 'channel-context', ?)
              `).run(
                threadId,
                `${workspace.flag}:${cluster.channelId}:ctx:${anchorMsg.ts}`,
                anchorMsg.url?.split('?')[0] || '',
                `${workspace.name}: #${cluster.channelName} - ${anchorDate}`,
                firstTimestamp,
                lastTimestamp,
                fallbackWindow.length,
                fallbackWindow.length,  // All are the owner's messages
                JSON.stringify([ownerId]),
                JSON.stringify({
                  workspace: workspace.flag,
                  channel_id: cluster.channelId,
                  channel_name: cluster.channelName,
                  anchor_ts: anchorMsg.ts,
                  owner_messages_in_cluster: cluster.messages.length,
                  fallback: true
                })
              )

              for (let i = 0; i < fallbackWindow.length; i++) {
                const msg = fallbackWindow[i]
                const messageId = `slack:${workspace.flag}:${cluster.channelId}:${msg.ts}`
                const timestamp = new Date(msg.ts_sec * 1000).toISOString()
                const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)
                const existingMsg = db.query(`SELECT id FROM messages WHERE id = ?`).get(messageId)
                if (!existingMsg) {
                  db.query(`
                    INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
                    VALUES (?, ?, 'slack', ?, ?, ?, ?, 1, ?, 'slack_message', ?, ?)
                  `).run(
                    messageId, threadId, `${workspace.flag}:${cluster.channelId}:${msg.ts}`,
                    timestamp, i + 1, ownerId, resolvedText, resolvedText.split(/\s+/).length, JSON.stringify(msg)
                  )
                }
              }
            })
          }
          contextExtracted++
        }

        await slackSleep(1500)
        continue
      }

      // Extract context window
      const startIndex = Math.max(0, anchorIndex - beforeCount)
      const endIndex = Math.min(channelMessages.length, anchorIndex + afterCount + 1)

      // Also include all the owner's messages from this cluster that fall within the window
      const contextWindow = channelMessages.slice(startIndex, endIndex)

      // Add any cluster messages that might not be in the window
      const contextSet = new Set(contextWindow.map(m => m.ts))
      for (const clusterMsg of cluster.messages) {
        if (!contextSet.has(clusterMsg.ts)) {
          // Find appropriate position to insert
          const insertPos = contextWindow.findIndex(m => m.ts_sec > clusterMsg.ts_sec)
          if (insertPos === -1) {
            contextWindow.push({
              ts: clusterMsg.ts,
              ts_sec: clusterMsg.ts_sec,
              user: clusterMsg.user,
              user_id: '',
              text: clusterMsg.text,
              url: clusterMsg.url
            })
          } else {
            contextWindow.splice(insertPos, 0, {
              ts: clusterMsg.ts,
              ts_sec: clusterMsg.ts_sec,
              user: clusterMsg.user,
              user_id: '',
              text: clusterMsg.text,
              url: clusterMsg.url
            })
          }
        }
      }

      // Sort again after potential insertions
      contextWindow.sort((a, b) => a.ts_sec - b.ts_sec)

      if (contextWindow.length === 0) {
        await slackSleep(1500)
        continue
      }

      const firstMsg = contextWindow[0]
      const lastMsg = contextWindow[contextWindow.length - 1]
      const firstTimestamp = new Date(firstMsg.ts_sec * 1000).toISOString()
      const lastTimestamp = new Date(lastMsg.ts_sec * 1000).toISOString()

      // Apply date filters
      if (opts.fromDate && lastTimestamp < opts.fromDate + 'T00:00:00.000Z') {
        await slackSleep(1500)
        continue
      }
      if (opts.toDate && firstTimestamp > opts.toDate + 'T23:59:59.999Z') {
        await slackSleep(1500)
        continue
      }

      // Track timestamps
      if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
      if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp

      // Format date for title
      const anchorDate = new Date(anchorMsg.ts_sec * 1000).toISOString().split('T')[0]

      // Count the owner's messages
      const myMessageCount = contextWindow.filter(m =>
        m.user_id === workspace.userId || m.user === workspace.userId
      ).length

      if (!opts.dryRun) {
        await withDbRetry(() => {
          db.query(`
            INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
            VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, 'channel-context', ?)
          `).run(
            threadId,
            `${workspace.flag}:${cluster.channelId}:ctx:${anchorMsg.ts}`,
            anchorMsg.url?.split('?')[0] || '',
            `${workspace.name}: #${cluster.channelName} - context around ${anchorDate}`,
            firstTimestamp,
            lastTimestamp,
            contextWindow.length,
            myMessageCount,
            JSON.stringify([ownerId]),
            JSON.stringify({
              workspace: workspace.flag,
              channel_id: cluster.channelId,
              channel_name: cluster.channelName,
              anchor_ts: anchorMsg.ts,
              owner_messages_in_cluster: cluster.messages.length
            })
          )

          for (let i = 0; i < contextWindow.length; i++) {
            const msg = contextWindow[i]
            const messageId = `slack:${workspace.flag}:${cluster.channelId}:${msg.ts}`
            const timestamp = new Date(msg.ts_sec * 1000).toISOString()
            const isFromMe = msg.user_id === workspace.userId || msg.user === workspace.userId
            const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)

            // Check if message already exists (might be shared between context windows)
            const existingMsg = db.query(`SELECT id FROM messages WHERE id = ?`).get(messageId)
            if (!existingMsg) {
              db.query(`
                INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
                VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?, 'slack_message', ?, ?)
              `).run(
                messageId,
                threadId,
                `${workspace.flag}:${cluster.channelId}:${msg.ts}`,
                timestamp,
                i + 1,
                isFromMe ? ownerId : (msg.user_id || msg.user || 'unknown'),
                isFromMe ? 1 : 0,
                resolvedText,
                resolvedText.split(/\s+/).length,
                JSON.stringify(msg)
              )
            }
          }
        })
      }

      contextExtracted++
      if (contextExtracted % 10 === 0) {
        console.log(`    Processed ${contextExtracted} context windows...`)
      }

      await slackSleep(1500)
    }

    console.log(`  Extracted ${contextExtracted} context windows`)

    totalExtracted += workspaceExtracted + contextExtracted
  }

  console.log(`\nTotal: Extracted ${formatNumber(totalExtracted)} channel conversations`)
  return { count: totalExtracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// SLACK MENTIONS EXTRACTION (captures threads where the owner is @-mentioned
// but hasn't necessarily authored any message). Runs against the same
// `slack` source and uses identical thread/message ID formats, so rows
// merge cleanly with extractSlackChannels via INSERT OR IGNORE dedup.
// ============================================================

async function extractSlackMentions(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  const slackToolPath = join(PROJECT_ROOT, 'tools/slack.ts')

  if (!existsSync(slackToolPath)) {
    console.error('Error: slack.ts tool not found')
    return { count: 0, newest: null, oldest: null }
  }

  const ownerId = OWNER_CONFIG.personId
  if (!opts.dryRun) {
    await withDbRetry(() => {
      const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
      if (!existingOwner) {
        db.query(`
          INSERT INTO people (id, display_name, identifiers, first_seen)
          VALUES (?, ?, ?, datetime('now'))
        `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], (OWNER_CONFIG.emails[1] || '')]))
      }
    })
  }

  let totalExtracted = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null
  const maxRetries = 5

  for (const workspace of SLACK_WORKSPACES) {
    console.log(`\n--- Processing ${workspace.name} mentions ---`)

    const allMentionMessages: SlackMessage[] = []
    const seenTimestamps = new Set<string>()

    const defaultFromDate = new Date()
    defaultFromDate.setFullYear(defaultFromDate.getFullYear() - 5)
    const startDate = opts.fromDate ? new Date(opts.fromDate) : defaultFromDate
    const endDate = opts.toDate ? new Date(opts.toDate) : new Date()

    interface DateChunk { from: string; to: string }
    const dateChunks: DateChunk[] = []
    let chunkStart = new Date(startDate)
    while (chunkStart < endDate) {
      const chunkEnd = new Date(chunkStart)
      chunkEnd.setMonth(chunkEnd.getMonth() + 6)
      if (chunkEnd > endDate) chunkEnd.setTime(endDate.getTime())
      dateChunks.push({
        from: chunkStart.toISOString().split('T')[0],
        to: chunkEnd.toISOString().split('T')[0]
      })
      chunkStart = new Date(chunkEnd)
      chunkStart.setDate(chunkStart.getDate() + 1)
    }

    for (const mentionQuery of workspace.mentionQueries) {
      console.log(`  Searching for mentions of "${mentionQuery}" across ${dateChunks.length} date chunks`)

      for (let chunkIdx = 0; chunkIdx < dateChunks.length; chunkIdx++) {
        const chunk = dateChunks[chunkIdx]
        console.log(`\n  [${mentionQuery} ${chunkIdx + 1}/${dateChunks.length}] ${chunk.from} to ${chunk.to}`)

        let currentPage = 1
        let totalPages = 1
        let retryCount = 0
        const maxPages = 100

        while (currentPage <= totalPages && currentPage <= maxPages) {
          // NOTE: No `from:` operator — we want messages FROM anyone mentioning the owner.
          // Filter out the owner's own authored messages client-side (via user_id check below).
          const searchQuery = `${mentionQuery} after:${chunk.from} before:${chunk.to}`

          const args = [
            slackToolPath, 'search', 'messages', searchQuery,
            '-w', workspace.flag, '--limit', '50',
            '--page', String(currentPage),
            '--sort-dir', 'asc', '--json'
          ]

          const proc = Bun.spawnSync(['bun', ...args], { cwd: PROJECT_ROOT, env: process.env })

          if (proc.exitCode !== 0) {
            const stderr = proc.stderr.toString()
            if (stderr.includes('ratelimited')) {
              retryCount++
              if (retryCount > maxRetries) {
                console.error(`  Rate limit exceeded after ${maxRetries} retries, stopping chunk`)
                break
              }
              const waitTime = Math.pow(2, retryCount) * 1000
              console.log(`  Rate limited, waiting ${waitTime/1000}s before retry...`)
              await slackSleep(waitTime)
              continue
            }
            console.error(`  Search failed: ${stderr}`)
            break
          }

          retryCount = 0
          const output = proc.stdout.toString().trim()
          if (!output) break

          try {
            const result = JSON.parse(output) as { items: SlackMessage[]; total: number; page: number; pages: number }

            if (currentPage === 1) {
              totalPages = Math.min(result.pages || 1, maxPages)
              if (result.pages > 100) {
                console.log(`    WARNING: Chunk has ${result.pages} pages but will only fetch 100 (sort limit)`)
              }
              console.log(`    Found ${result.total} matching messages in this chunk (${Math.min(result.pages, 100)} pages to fetch)`)
            }

            if (!result.items || result.items.length === 0) break

            for (const msg of result.items) {
              // Public channels only — DMs are handled by extractSlackDMs
              if (msg.channel_name.startsWith('D') || msg.channel_name.startsWith('mpdm-') || msg.channel_name.match(/^U[A-Z0-9]+$/)) continue
              // Skip messages the owner authored (already captured by from:-based extraction)
              if (msg.user_id === workspace.userId || msg.user === workspace.userId) continue
              const key = `${msg.channel_id}:${msg.ts}`
              if (!seenTimestamps.has(key)) {
                seenTimestamps.add(key)
                allMentionMessages.push(msg)
              }
            }

            if (currentPage % 20 === 0 || currentPage === totalPages) {
              console.log(`    Page ${currentPage}/${totalPages}: ${allMentionMessages.length} mention messages so far`)
            }
            currentPage++

            if (opts.limit && allMentionMessages.length >= opts.limit) break
            if (currentPage <= totalPages) await slackSleep(1500)
          } catch (e) {
            console.error(`  Failed to parse search results: ${e}`)
            break
          }
        }

        if (opts.limit && allMentionMessages.length >= opts.limit) {
          console.log(`  Reached limit of ${opts.limit} messages`)
          break
        }
      }
      if (opts.limit && allMentionMessages.length >= opts.limit) break
    }

    console.log(`  Found ${allMentionMessages.length} mention messages in public channels`)
    if (allMentionMessages.length === 0) continue

    // Group by thread
    interface MentionMsgGroup {
      channelId: string
      channelName: string
      threadTs: string | null
      messages: SlackMessage[]
      isThread: boolean
    }

    const threadGroups = new Map<string, MentionMsgGroup>()
    const standaloneMessages: SlackMessage[] = []

    for (const msg of allMentionMessages) {
      if (msg.thread_ts && msg.thread_ts !== msg.ts) {
        const key = `${msg.channel_id}:${msg.thread_ts}`
        if (!threadGroups.has(key)) {
          threadGroups.set(key, { channelId: msg.channel_id, channelName: msg.channel_name, threadTs: msg.thread_ts, messages: [], isThread: true })
        }
        threadGroups.get(key)!.messages.push(msg)
      } else if (msg.thread_ts === msg.ts) {
        const key = `${msg.channel_id}:${msg.ts}`
        if (!threadGroups.has(key)) {
          threadGroups.set(key, { channelId: msg.channel_id, channelName: msg.channel_name, threadTs: msg.ts, messages: [], isThread: true })
        }
        threadGroups.get(key)!.messages.push(msg)
      } else {
        standaloneMessages.push(msg)
      }
    }

    console.log(`  Grouped into ${threadGroups.size} threads and ${standaloneMessages.length} standalone mentions`)

    let workspaceExtracted = 0

    for (const [, group] of threadGroups) {
      const threadId = `slack:${workspace.flag}:${group.channelId}:${group.threadTs}`

      // Skip if thread already captured by from: pass
      const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId)
      if (existingThread) continue

      let threadRetryCount = 0
      let threadProc = Bun.spawnSync([
        'bun', slackToolPath, 'get', 'thread',
        '--channel', group.channelId, '--ts', group.threadTs!,
        '-w', workspace.flag, '--limit', '200', '--json'
      ], { cwd: PROJECT_ROOT, env: process.env })

      while (threadProc.exitCode !== 0 && threadProc.stderr.toString().includes('ratelimited') && threadRetryCount < maxRetries) {
        threadRetryCount++
        const waitTime = Math.pow(2, threadRetryCount) * 1000
        console.log(`    Rate limited fetching thread, waiting ${waitTime/1000}s...`)
        await slackSleep(waitTime)
        threadProc = Bun.spawnSync([
          'bun', slackToolPath, 'get', 'thread', '--channel', group.channelId, '--ts', group.threadTs!,
          '-w', workspace.flag, '--limit', '200', '--json'
        ], { cwd: PROJECT_ROOT, env: process.env })
      }

      if (threadProc.exitCode !== 0) { await slackSleep(1500); continue }

      const threadOutput = threadProc.stdout.toString().trim()
      const threadLastLine = threadOutput.split('\n').pop() || ''

      let threadMessages: SlackChannelMessage[] = []
      try {
        const threadResult = JSON.parse(threadLastLine) as { items: SlackChannelMessage[] }
        threadMessages = threadResult.items || []
      } catch (e) { await slackSleep(1500); continue }

      if (threadMessages.length === 0) { await slackSleep(1500); continue }

      threadMessages.sort((a, b) => a.ts_sec - b.ts_sec)

      const firstMsg = threadMessages[0]
      const lastMsg = threadMessages[threadMessages.length - 1]
      const firstTimestamp = new Date(firstMsg.ts_sec * 1000).toISOString()
      const lastTimestamp = new Date(lastMsg.ts_sec * 1000).toISOString()

      if (opts.fromDate && lastTimestamp < opts.fromDate + 'T00:00:00.000Z') { await slackSleep(1500); continue }
      if (opts.toDate && firstTimestamp > opts.toDate + 'T23:59:59.999Z') { await slackSleep(1500); continue }

      if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
      if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp

      const rootMsg = threadMessages[0]
      const titlePreview = rootMsg.text.slice(0, 50) + (rootMsg.text.length > 50 ? '...' : '')

      const myMessageCount = threadMessages.filter(m =>
        m.user_id === workspace.userId || m.user === workspace.userId
      ).length

      if (!opts.dryRun) {
        await withDbRetry(() => {
          db.query(`
            INSERT OR IGNORE INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
            VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, 'channel-thread', ?)
          `).run(
            threadId,
            `${workspace.flag}:${group.channelId}:${group.threadTs}`,
            rootMsg.url?.split('?')[0] || '',
            `${workspace.name}: #${group.channelName} - ${titlePreview}`,
            firstTimestamp, lastTimestamp,
            threadMessages.length, myMessageCount,
            JSON.stringify([ownerId]),
            JSON.stringify({ workspace: workspace.flag, channel_id: group.channelId, channel_name: group.channelName, thread_ts: group.threadTs, via: 'mentions' })
          )

          for (let i = 0; i < threadMessages.length; i++) {
            const msg = threadMessages[i]
            const messageId = `slack:${workspace.flag}:${group.channelId}:${msg.ts}`
            const timestamp = new Date(msg.ts_sec * 1000).toISOString()
            const isFromMe = msg.user_id === workspace.userId || msg.user === workspace.userId
            const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)

            db.query(`
              INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
              VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?, 'slack_message', ?, ?)
            `).run(
              messageId, threadId,
              `${workspace.flag}:${group.channelId}:${msg.ts}`,
              timestamp, i + 1,
              isFromMe ? ownerId : (msg.user_id || msg.user || 'unknown'),
              isFromMe ? 1 : 0,
              resolvedText,
              resolvedText.split(/\s+/).length,
              JSON.stringify(msg)
            )
          }
        })
      }

      workspaceExtracted++
      if (workspaceExtracted % 10 === 0) {
        console.log(`    Processed ${workspaceExtracted} mention threads...`)
      }
      await slackSleep(1500)
    }

    console.log(`  Extracted ${workspaceExtracted} mention threads`)

    // Standalone mentions: context-window clustering
    console.log(`  Processing ${standaloneMessages.length} standalone mentions with context windows...`)

    standaloneMessages.sort((a, b) => {
      if (a.channel_id !== b.channel_id) return a.channel_id.localeCompare(b.channel_id)
      return a.ts_sec - b.ts_sec
    })

    interface ContextCluster {
      channelId: string
      channelName: string
      messages: SlackMessage[]
    }

    const clusters: ContextCluster[] = []
    let currentCluster: ContextCluster | null = null
    const GAP_HOURS = 24

    for (const msg of standaloneMessages) {
      if (!currentCluster || currentCluster.channelId !== msg.channel_id) {
        if (currentCluster) clusters.push(currentCluster)
        currentCluster = { channelId: msg.channel_id, channelName: msg.channel_name, messages: [msg] }
      } else {
        const lastMsg = currentCluster.messages[currentCluster.messages.length - 1]
        const gapSeconds = msg.ts_sec - lastMsg.ts_sec
        if (gapSeconds <= GAP_HOURS * 3600) {
          currentCluster.messages.push(msg)
        } else {
          clusters.push(currentCluster)
          currentCluster = { channelId: msg.channel_id, channelName: msg.channel_name, messages: [msg] }
        }
      }
    }
    if (currentCluster) clusters.push(currentCluster)

    console.log(`    Grouped into ${clusters.length} context clusters`)

    let contextExtracted = 0
    for (const cluster of clusters) {
      const anchorMsg = cluster.messages[0]
      const threadId = `slack:${workspace.flag}:${cluster.channelId}:ctx:${anchorMsg.ts}`

      const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId)
      if (existingThread) continue

      let contextRetryCount = 0
      const sinceTimestamp = anchorMsg.ts_sec - 3600
      const sinceISO = new Date(sinceTimestamp * 1000).toISOString()

      let historyProc = Bun.spawnSync([
        'bun', slackToolPath, 'get', 'channel', cluster.channelId,
        '-w', workspace.flag, '--since', sinceISO, '--limit', '50', '--json'
      ], { cwd: PROJECT_ROOT, env: process.env })

      while (historyProc.exitCode !== 0 && historyProc.stderr.toString().includes('ratelimited') && contextRetryCount < maxRetries) {
        contextRetryCount++
        const waitTime = Math.pow(2, contextRetryCount) * 1000
        console.log(`    Rate limited fetching context, waiting ${waitTime/1000}s...`)
        await slackSleep(waitTime)
        historyProc = Bun.spawnSync([
          'bun', slackToolPath, 'get', 'channel', cluster.channelId, '-w', workspace.flag,
          '--since', sinceISO, '--limit', '50', '--json'
        ], { cwd: PROJECT_ROOT, env: process.env })
      }

      if (historyProc.exitCode !== 0) { await slackSleep(1500); continue }

      const historyOutput = historyProc.stdout.toString().trim()
      const historyLastLine = historyOutput.split('\n').pop() || ''

      let channelMessages: SlackChannelMessage[] = []
      try {
        const historyResult = JSON.parse(historyLastLine) as { items: SlackChannelMessage[] }
        channelMessages = historyResult.items || []
      } catch (e) { await slackSleep(1500); continue }

      if (channelMessages.length === 0) { await slackSleep(1500); continue }

      channelMessages.sort((a, b) => a.ts_sec - b.ts_sec)

      const beforeCount = 5
      const afterCount = 10
      const anchorIndex = channelMessages.findIndex(m => m.ts === anchorMsg.ts)

      let contextWindow: SlackChannelMessage[]
      if (anchorIndex === -1) {
        contextWindow = cluster.messages.map(m => ({
          ts: m.ts, ts_sec: m.ts_sec, user: m.user, user_id: m.user_id || '',
          text: m.text, url: m.url
        }))
        contextWindow.sort((a, b) => a.ts_sec - b.ts_sec)
      } else {
        const startIndex = Math.max(0, anchorIndex - beforeCount)
        const endIndex = Math.min(channelMessages.length, anchorIndex + afterCount + 1)
        contextWindow = channelMessages.slice(startIndex, endIndex)

        const contextSet = new Set(contextWindow.map(m => m.ts))
        for (const clusterMsg of cluster.messages) {
          if (!contextSet.has(clusterMsg.ts)) {
            const entry: SlackChannelMessage = {
              ts: clusterMsg.ts, ts_sec: clusterMsg.ts_sec,
              user: clusterMsg.user, user_id: clusterMsg.user_id || '',
              text: clusterMsg.text, url: clusterMsg.url
            }
            const insertPos = contextWindow.findIndex(m => m.ts_sec > clusterMsg.ts_sec)
            if (insertPos === -1) contextWindow.push(entry)
            else contextWindow.splice(insertPos, 0, entry)
          }
        }
        contextWindow.sort((a, b) => a.ts_sec - b.ts_sec)
      }

      if (contextWindow.length === 0) { await slackSleep(1500); continue }

      const firstMsg = contextWindow[0]
      const lastMsg = contextWindow[contextWindow.length - 1]
      const firstTimestamp = new Date(firstMsg.ts_sec * 1000).toISOString()
      const lastTimestamp = new Date(lastMsg.ts_sec * 1000).toISOString()

      if (opts.fromDate && lastTimestamp < opts.fromDate + 'T00:00:00.000Z') { await slackSleep(1500); continue }
      if (opts.toDate && firstTimestamp > opts.toDate + 'T23:59:59.999Z') { await slackSleep(1500); continue }

      if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
      if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp

      const anchorDate = new Date(anchorMsg.ts_sec * 1000).toISOString().split('T')[0]
      const myMessageCount = contextWindow.filter(m =>
        m.user_id === workspace.userId || m.user === workspace.userId
      ).length

      if (!opts.dryRun) {
        await withDbRetry(() => {
          db.query(`
            INSERT OR IGNORE INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
            VALUES (?, 'slack', ?, ?, ?, ?, ?, ?, ?, ?, 'channel-context', ?)
          `).run(
            threadId,
            `${workspace.flag}:${cluster.channelId}:ctx:${anchorMsg.ts}`,
            anchorMsg.url?.split('?')[0] || '',
            `${workspace.name}: #${cluster.channelName} - mention context ${anchorDate}`,
            firstTimestamp, lastTimestamp,
            contextWindow.length, myMessageCount,
            JSON.stringify([ownerId]),
            JSON.stringify({
              workspace: workspace.flag, channel_id: cluster.channelId, channel_name: cluster.channelName,
              anchor_ts: anchorMsg.ts, mentions_in_cluster: cluster.messages.length, via: 'mentions'
            })
          )

          for (let i = 0; i < contextWindow.length; i++) {
            const msg = contextWindow[i]
            const messageId = `slack:${workspace.flag}:${cluster.channelId}:${msg.ts}`
            const timestamp = new Date(msg.ts_sec * 1000).toISOString()
            const isFromMe = msg.user_id === workspace.userId || msg.user === workspace.userId
            const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)

            db.query(`
              INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
              VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?, 'slack_message', ?, ?)
            `).run(
              messageId, threadId,
              `${workspace.flag}:${cluster.channelId}:${msg.ts}`,
              timestamp, i + 1,
              isFromMe ? ownerId : (msg.user_id || msg.user || 'unknown'),
              isFromMe ? 1 : 0,
              resolvedText,
              resolvedText.split(/\s+/).length,
              JSON.stringify(msg)
            )
          }
        })
      }

      contextExtracted++
      if (contextExtracted % 10 === 0) {
        console.log(`    Processed ${contextExtracted} mention-context windows...`)
      }
      await slackSleep(1500)
    }

    console.log(`  Extracted ${contextExtracted} mention-context windows`)

    // Update per-workspace watermark
    if (!opts.dryRun && newestTimestamp) {
      await withDbRetry(() => setWatermark(db, 'slack-mentions', workspace.flag, newestTimestamp))
    }

    totalExtracted += workspaceExtracted + contextExtracted
  }

  console.log(`\nTotal: Extracted ${formatNumber(totalExtracted)} mention-derived conversations`)
  return { count: totalExtracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// SLACK CHANNEL FULL-CAPTURE (slack source, full-capture config)
// Captures ALL messages in configured channels (not just the owner-authored
// or the owner-mentioned). Threaded messages dedup with existing extraction
// via identical `slack:<ws>:<ch>:<thread_ts>` IDs. Standalone non-thread
// messages cluster into daily buckets: `slack:<ws>:<ch>:full:<YYYY-MM-DD>`.
// ============================================================

interface SlackFullCaptureChannel {
  workspace: string
  channel_id: string
  channel_name: string
  backfill_from?: string
}

interface SlackCaptureConfig {
  full_capture_channels: SlackFullCaptureChannel[]
  full_capture_users: unknown[]
}

function loadSlackCaptureConfig(): SlackCaptureConfig {
  const path = join(PROJECT_ROOT, 'tools/slack-capture-config.json')
  if (!existsSync(path)) return { full_capture_channels: [], full_capture_users: [] }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<SlackCaptureConfig>
    return {
      full_capture_channels: raw.full_capture_channels || [],
      full_capture_users: raw.full_capture_users || []
    }
  } catch (e) {
    console.error(`Failed to parse slack-capture-config.json: ${e}`)
    return { full_capture_channels: [], full_capture_users: [] }
  }
}

async function extractSlackChannelFull(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean; channelFilter?: string }
): Promise<ExtractionResult> {
  const slackToolPath = join(PROJECT_ROOT, 'tools/slack.ts')
  if (!existsSync(slackToolPath)) {
    console.error('Error: slack.ts tool not found')
    return { count: 0, newest: null, oldest: null }
  }

  const config = loadSlackCaptureConfig()
  const channels = opts.channelFilter
    ? config.full_capture_channels.filter(c => c.channel_id === opts.channelFilter || c.channel_name === opts.channelFilter)
    : config.full_capture_channels

  if (channels.length === 0) {
    if (opts.channelFilter) {
      console.log(`  No full-capture channel matching "${opts.channelFilter}". Configure at tools/slack-capture-config.json`)
    } else {
      console.log(`  No full-capture channels configured. Skipping.`)
    }
    return { count: 0, newest: null, oldest: null }
  }

  const ownerId = OWNER_CONFIG.personId
  if (!opts.dryRun) {
    await withDbRetry(() => {
      const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
      if (!existingOwner) {
        db.query(`
          INSERT INTO people (id, display_name, identifiers, first_seen)
          VALUES (?, ?, ?, datetime('now'))
        `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], (OWNER_CONFIG.emails[1] || '')]))
      }
    })
  }

  let totalExtracted = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null
  const maxRetries = 5

  for (const ch of channels) {
    const workspace = SLACK_WORKSPACES.find(w => w.flag === ch.workspace)
    if (!workspace) {
      console.error(`  Unknown workspace "${ch.workspace}" for channel #${ch.channel_name}, skipping`)
      continue
    }

    console.log(`\n--- Full-capture: ${workspace.name} #${ch.channel_name} (${ch.channel_id}) ---`)

    const wmScope = `${workspace.flag}:${ch.channel_id}`
    const watermark = getWatermark(db, 'slack-channel-full', wmScope)

    // Determine --since. Priority: explicit fromDate > watermark > config backfill_from > 6 months ago
    let sinceISO: string
    if (opts.fromDate) {
      sinceISO = opts.fromDate + 'T00:00:00.000Z'
    } else if (watermark?.last_seen_ts) {
      sinceISO = watermark.last_seen_ts
    } else if (ch.backfill_from) {
      sinceISO = ch.backfill_from + 'T00:00:00.000Z'
    } else {
      const d = new Date()
      d.setMonth(d.getMonth() - 6)
      sinceISO = d.toISOString()
    }
    const untilISO = opts.toDate ? opts.toDate + 'T23:59:59.999Z' : null

    console.log(`  --since ${sinceISO}${untilISO ? ` --until ${untilISO}` : ''}`)

    // Paginate conversations.history
    const allMessages: SlackChannelMessage[] = []
    let cursor: string | null = null
    let pageNum = 0
    const maxPages = 500

    while (pageNum < maxPages) {
      pageNum++
      const args = ['bun', slackToolPath, 'get', 'channel', ch.channel_id,
                    '-w', workspace.flag, '--limit', '200', '--since', sinceISO, '--json']
      if (untilISO) args.push('--until', untilISO)
      if (cursor) args.push('--cursor', cursor)

      let retryCount = 0
      let proc = Bun.spawnSync(args, { cwd: PROJECT_ROOT, env: process.env })
      while (proc.exitCode !== 0 && proc.stderr.toString().includes('ratelimited') && retryCount < maxRetries) {
        retryCount++
        const waitTime = Math.pow(2, retryCount) * 1000
        console.log(`    Rate limited on page ${pageNum}, waiting ${waitTime/1000}s...`)
        await slackSleep(waitTime)
        proc = Bun.spawnSync(args, { cwd: PROJECT_ROOT, env: process.env })
      }

      if (proc.exitCode !== 0) {
        console.error(`    History fetch failed: ${proc.stderr.toString().substring(0, 200)}`)
        break
      }

      try {
        const result = JSON.parse(proc.stdout.toString().trim().split('\n').pop() || '') as {
          items: SlackChannelMessage[]; next_cursor?: string
        }
        if (!result.items || result.items.length === 0) break
        allMessages.push(...result.items)

        if (pageNum % 5 === 0 || !result.next_cursor) {
          console.log(`    Page ${pageNum}: ${allMessages.length} parent messages so far`)
        }

        if (result.next_cursor && result.next_cursor.length > 0) {
          cursor = result.next_cursor
          await slackSleep(1500)
        } else {
          break
        }
      } catch (e) {
        console.error(`    Failed to parse history: ${e}`)
        break
      }

      if (opts.limit && allMessages.length >= opts.limit) break
    }

    if (allMessages.length === 0) {
      console.log(`  No new messages since ${sinceISO}`)
      continue
    }

    console.log(`  Fetched ${allMessages.length} parent messages across ${pageNum} pages`)

    // Identify thread parents needing reply expansion
    const threadsToFetch = new Set<string>()
    for (const msg of allMessages) {
      if (msg.reply_count && msg.reply_count > 0) threadsToFetch.add(msg.ts)
      if (msg.thread_ts && msg.thread_ts !== msg.ts) threadsToFetch.add(msg.thread_ts)
    }

    console.log(`  Fetching replies for ${threadsToFetch.size} threads...`)
    const threadReplies = new Map<string, SlackChannelMessage[]>()
    let threadsFetched = 0
    for (const threadTs of threadsToFetch) {
      let retryCount = 0
      let proc = Bun.spawnSync([
        'bun', slackToolPath, 'get', 'thread',
        '--channel', ch.channel_id, '--ts', threadTs,
        '-w', workspace.flag, '--limit', '500', '--json'
      ], { cwd: PROJECT_ROOT, env: process.env })
      while (proc.exitCode !== 0 && proc.stderr.toString().includes('ratelimited') && retryCount < maxRetries) {
        retryCount++
        const waitTime = Math.pow(2, retryCount) * 1000
        console.log(`    Rate limited fetching thread ${threadTs}, waiting ${waitTime/1000}s...`)
        await slackSleep(waitTime)
        proc = Bun.spawnSync([
          'bun', slackToolPath, 'get', 'thread',
          '--channel', ch.channel_id, '--ts', threadTs,
          '-w', workspace.flag, '--limit', '500', '--json'
        ], { cwd: PROJECT_ROOT, env: process.env })
      }
      if (proc.exitCode === 0) {
        try {
          const result = JSON.parse(proc.stdout.toString().trim().split('\n').pop() || '') as { items: SlackChannelMessage[] }
          if (result.items) threadReplies.set(threadTs, result.items)
        } catch (e) { /* ignore */ }
      }
      threadsFetched++
      if (threadsFetched % 10 === 0) {
        console.log(`    Fetched replies for ${threadsFetched}/${threadsToFetch.size} threads`)
      }
      await slackSleep(1500)
    }

    // Merge and dedup by ts
    const messageMap = new Map<string, SlackChannelMessage>()
    for (const msg of allMessages) messageMap.set(msg.ts, msg)
    for (const [, replies] of threadReplies) {
      for (const reply of replies) {
        if (!messageMap.has(reply.ts)) messageMap.set(reply.ts, reply)
      }
    }

    // Partition threaded vs standalone (daily buckets)
    const threadGroups = new Map<string, SlackChannelMessage[]>()
    const standaloneByDay = new Map<string, SlackChannelMessage[]>()
    for (const msg of messageMap.values()) {
      const isThreaded =
        (msg.thread_ts && msg.thread_ts !== msg.ts) ||
        (!!msg.reply_count && msg.reply_count > 0)
      if (isThreaded) {
        const key = msg.thread_ts || msg.ts
        if (!threadGroups.has(key)) threadGroups.set(key, [])
        threadGroups.get(key)!.push(msg)
      } else {
        const day = new Date(msg.ts_sec * 1000).toISOString().split('T')[0]
        if (!standaloneByDay.has(day)) standaloneByDay.set(day, [])
        standaloneByDay.get(day)!.push(msg)
      }
    }

    console.log(`  Partitioned: ${threadGroups.size} thread(s), ${standaloneByDay.size} day-bucket(s)`)

    let channelMessagesWritten = 0
    let newestTs: string | null = watermark?.last_seen_ts || null

    const writeGroup = async (
      threadId: string,
      threadType: 'channel' | 'channel-full-day',
      title: string,
      sourceThreadId: string,
      extraRawJson: Record<string, unknown>,
      msgs: SlackChannelMessage[]
    ) => {
      msgs.sort((a, b) => a.ts_sec - b.ts_sec)
      const firstMsg = msgs[0]
      const lastMsg = msgs[msgs.length - 1]
      const firstTimestamp = new Date(firstMsg.ts_sec * 1000).toISOString()
      const lastTimestamp = new Date(lastMsg.ts_sec * 1000).toISOString()

      if (!opts.dryRun) {
        await withDbRetry(() => {
          db.query(`
            INSERT OR IGNORE INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
            VALUES (?, 'slack', ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)
          `).run(
            threadId, sourceThreadId,
            firstMsg.url?.split('?')[0] || '',
            title,
            firstTimestamp, lastTimestamp,
            JSON.stringify([ownerId]),
            threadType,
            JSON.stringify({
              workspace: workspace.flag, channel_id: ch.channel_id, channel_name: ch.channel_name,
              via: 'channel-full', ...extraRawJson
            })
          )

          for (let i = 0; i < msgs.length; i++) {
            const msg = msgs[i]
            const messageId = `slack:${workspace.flag}:${ch.channel_id}:${msg.ts}`
            const timestamp = new Date(msg.ts_sec * 1000).toISOString()
            const isFromMe = msg.user_id === workspace.userId || msg.user === workspace.userId
            const resolvedText = resolveSlackMentions(db, msg.text, workspace.flag)
            db.query(`
              INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
              VALUES (?, ?, 'slack', ?, ?, ?, ?, ?, ?, 'slack_message', ?, ?)
            `).run(
              messageId, threadId,
              `${workspace.flag}:${ch.channel_id}:${msg.ts}`,
              timestamp, i + 1,
              isFromMe ? ownerId : (msg.user_id || msg.user || 'unknown'),
              isFromMe ? 1 : 0,
              resolvedText, resolvedText.split(/\s+/).length,
              JSON.stringify(msg)
            )
          }

          // Recompute authoritative counts from messages (handles existing threads)
          db.query(`
            UPDATE threads SET
              message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ?),
              my_message_count = (SELECT COUNT(*) FROM messages WHERE thread_id = ? AND is_from_me = 1),
              last_activity_at = (SELECT MAX(timestamp) FROM messages WHERE thread_id = ?)
            WHERE id = ?
          `).run(threadId, threadId, threadId, threadId)

          // If all msgs were already attached to a different thread (from mentions/from: passes),
          // this thread ends up with 0 messages — delete it to avoid clutter.
          db.query(`DELETE FROM threads WHERE id = ? AND message_count = 0`).run(threadId)
        })
      }

      channelMessagesWritten += msgs.length
      if (!newestTs || lastTimestamp > newestTs) newestTs = lastTimestamp
      if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
      if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp
    }

    for (const [threadTs, msgs] of threadGroups) {
      const threadId = `slack:${workspace.flag}:${ch.channel_id}:${threadTs}`
      await writeGroup(
        threadId, 'channel',
        `${workspace.name}: #${ch.channel_name} - thread ${new Date(parseFloat(threadTs) * 1000).toISOString().split('T')[0]}`,
        `${workspace.flag}:${ch.channel_id}:${threadTs}`,
        { thread_ts: threadTs },
        msgs
      )
    }

    for (const [day, msgs] of standaloneByDay) {
      const threadId = `slack:${workspace.flag}:${ch.channel_id}:full:${day}`
      await writeGroup(
        threadId, 'channel-full-day',
        `${workspace.name}: #${ch.channel_name} - activity ${day}`,
        `${workspace.flag}:${ch.channel_id}:full:${day}`,
        { day },
        msgs
      )
    }

    console.log(`  Wrote ${channelMessagesWritten} messages across ${threadGroups.size + standaloneByDay.size} threads`)

    if (!opts.dryRun && newestTs) {
      await withDbRetry(() => setWatermark(db, 'slack-channel-full', wmScope, newestTs))
      console.log(`  Watermark updated: ${newestTs}`)
    }

    totalExtracted += channelMessagesWritten
  }

  console.log(`\nTotal: Extracted ${formatNumber(totalExtracted)} messages from full-capture channels`)
  return { count: totalExtracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// BEEPER EXTRACTION (iMessage, WhatsApp, Signal, Facebook, LinkedIn)
// ============================================================

const BEEPER_API_BASE = 'http://localhost:23373'

interface BeeperExclusionRule {
  identifiers: string[]
  service?: string
  mode?: 'entire_chat' | 'messages_only'
  reason?: string
}

function loadBeeperConfig(): { excludedContacts: BeeperExclusionRule[] } {
  const configPath = join(PROJECT_ROOT, 'tools/beeper-config.json')
  try {
    const raw = readFileSync(configPath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return { excludedContacts: [] }
  }
}

function matchesBeeperIdentifier(value: string | undefined | null, identifiers: string[]): boolean {
  if (!value) return false
  const normalized = value.toLowerCase().trim()
  for (const id of identifiers) {
    const normId = id.toLowerCase().trim()
    if (normalized.includes(normId) || normId.includes(normalized)) {
      return true
    }
  }
  return false
}

function isBeeperChatExcluded(chat: Record<string, unknown>, config: { excludedContacts: BeeperExclusionRule[] }): boolean {
  const chatName = (chat.name || chat.title) as string | undefined
  const network = (chat.network || chat.networkName || '') as string
  const chatIdentifiers: string[] = []
  if (chatName) chatIdentifiers.push(chatName)

  const participants = chat.participants as { items?: Array<Record<string, unknown>> } | Array<Record<string, unknown>> | undefined
  const participantsList = participants
    ? (Array.isArray(participants) ? participants : participants.items || [])
    : []

  for (const p of participantsList) {
    if (p.fullName) chatIdentifiers.push(p.fullName as string)
    if (p.displayText) chatIdentifiers.push(p.displayText as string)
    if (p.displayName) chatIdentifiers.push(p.displayName as string)
    if (p.phoneNumber) chatIdentifiers.push(p.phoneNumber as string)
    if (p.email) chatIdentifiers.push(p.email as string)
  }

  for (const rule of config.excludedContacts) {
    if (rule.service && !network.toLowerCase().includes(rule.service.toLowerCase())) {
      continue
    }
    for (const chatId of chatIdentifiers) {
      if (matchesBeeperIdentifier(chatId, rule.identifiers)) {
        return true
      }
    }
  }
  return false
}

async function extractBeeper(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean; backfill?: boolean }
): Promise<ExtractionResult> {
  const envVars = await load_env()
  const token = envVars.BEEPER_ACCESS_TOKEN || envVars.BEEPER_TOKEN
  if (!token) {
    console.error('Error: BEEPER_ACCESS_TOKEN not set')
    console.error('Create token in Beeper Desktop: Settings → Developers → click "+"')
    return { count: 0, newest: null, oldest: null }
  }

  const beeperConfig = loadBeeperConfig()
  console.log(`Privacy exclusions loaded: ${beeperConfig.excludedContacts.length} rules`)

  const ownerId = OWNER_CONFIG.personId
  const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
  if (!existingOwner && !opts.dryRun) {
    db.query(`
      INSERT INTO people (id, display_name, identifiers, first_seen)
      VALUES (?, ?, ?, datetime('now'))
    `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], OWNER_CONFIG.phone]))
  }

  let totalExtracted = 0
  let totalUpdated = 0
  let totalSkipped = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null

  // Build set of native imessage source_message_ids for cross-source dedup
  const nativeImsgIds = new Set<string>()
  const nativeRows = db.query(`SELECT source_message_id FROM messages WHERE source = 'imessage'`).all() as Array<{ source_message_id: string }>
  for (const r of nativeRows) nativeImsgIds.add(r.source_message_id)
  if (nativeImsgIds.size > 0) {
    console.log(`Loaded ${formatNumber(nativeImsgIds.size)} native iMessage UUIDs for cross-source dedup`)
  }

  // Auto-detect --from date if not specified (same pattern as Gmail/Slack)
  if (!opts.fromDate) {
    const newest = db.query(`SELECT MAX(last_activity_at) as newest FROM threads WHERE source = 'beeper' OR (source = 'twitter-dm' AND id LIKE 'twitter-dm:beeper:%')`).get() as { newest: string | null } | null
    if (newest?.newest) {
      const d = new Date(newest.newest)
      d.setDate(d.getDate() - 7)
      opts.fromDate = d.toISOString().split('T')[0]
      console.log(`Auto-detected --from: ${opts.fromDate} (7 days before newest beeper thread)`)
    }
  }

  console.log('\n--- Fetching chats from Beeper ---')

  const allChats: Array<Record<string, unknown>> = []
  let cursor: string | null = null
  let pageCount = 0
  const maxPages = 50

  // Fetch chats via search endpoint with activity filter (listChats /v1/chats is broken in recent Beeper Desktop versions)
  console.log(`Fetching chats${opts.fromDate ? ` with activity after ${opts.fromDate}` : ' (all)'}...`)
  while (pageCount < maxPages) {
    pageCount++
    try {
      let searchParams = `limit=100`
      if (opts.fromDate) searchParams += `&lastActivityAfter=${opts.fromDate}T00:00:00Z`
      if (cursor) searchParams += `&cursor=${encodeURIComponent(cursor)}&direction=before`
      const url = `${BEEPER_API_BASE}/v1/chats/search?${searchParams}`
      const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
      if (!res.ok) {
        if (res.status === 401) {
          console.error('Error: Beeper authentication failed')
          return { count: 0, newest: null, oldest: null }
        }
        console.error(`Error: Beeper API returned ${res.status}`)
        break
      }
      const data = await res.json() as { items?: Array<Record<string, unknown>>; hasMore?: boolean; oldestCursor?: string }
      const chats = data.items || []
      if (chats.length === 0) break
      allChats.push(...chats)
      console.log(`  Page ${pageCount}: ${chats.length} chats (total: ${allChats.length})`)
      if (data.hasMore && data.oldestCursor) {
        cursor = data.oldestCursor
      } else {
        break
      }
    } catch (err) {
      console.error(`Error fetching chats: ${(err as Error).message}`)
      break
    }
  }

  console.log(`\nTotal chats found: ${allChats.length}`)

  // Filter chats
  const filteredChats: Array<Record<string, unknown>> = []
  let twitterIncluded = 0
  let privacySkipped = 0
  let groupSkipped = 0

  for (const chat of allChats) {
    const chatId = (chat.id || chat.chatID) as string
    const network = (chat.network || chat.networkName || '') as string
    const chatType = (chat.type) as string | undefined

    // Tag Twitter DMs — these get source='twitter-dm' instead of 'beeper'
    const isTwitterDM = network.toLowerCase().includes('twitter') || chatId.includes('local-twitter')
    if (isTwitterDM) {
      ;(chat as Record<string, unknown>).__isTwitterDM = true
      twitterIncluded++
    }

    // Skip excluded contacts (privacy)
    if (isBeeperChatExcluded(chat, beeperConfig)) {
      privacySkipped++
      continue
    }

    // Skip large group chats (higher limit for Twitter DM groups)
    const participantCount = (chat.participantCount as number) ||
      ((chat.participants as { items?: unknown[] })?.items?.length) || 0
    const groupLimit = isTwitterDM ? 30 : 10
    if (chatType === 'group' && participantCount > groupLimit) {
      groupSkipped++
      continue
    }

    filteredChats.push(chat)
  }

  console.log(`Filtered: ${filteredChats.length} chats to process`)
  console.log(`  Twitter DMs included: ${twitterIncluded}`)
  console.log(`  Skipped privacy: ${privacySkipped}`)
  console.log(`  Skipped large groups: ${groupSkipped}`)

  let chatsToProcess = filteredChats
  if (opts.limit && filteredChats.length > opts.limit) {
    chatsToProcess = filteredChats.slice(0, opts.limit)
    console.log(`  Limited to: ${opts.limit} chats`)
  }

  console.log('\n--- Processing chats ---')
  let chatIndex = 0

  for (const chat of chatsToProcess) {
    chatIndex++
    const chatId = (chat.id || chat.chatID) as string
    const network = (chat.network || chat.networkName || '') as string
    const chatType = (chat.type || 'single') as string
    const title = (chat.title || chat.name || chat.displayText || chatId) as string

    const isTwitterDM = !!(chat as Record<string, unknown>).__isTwitterDM
    const threadId = isTwitterDM ? `twitter-dm:beeper:${chatId}` : `beeper:${chatId}`
    const existingThread = db.query(`SELECT id, message_count FROM threads WHERE id = ?`).get(threadId) as { id: string; message_count: number } | null
    const isImessage = network.toLowerCase() === 'imessage' || chatId.includes('imsg')
    const sourceLabel = isTwitterDM ? 'twitter-dm' : 'beeper'

    console.log(`[${chatIndex}/${chatsToProcess.length}] ${title} (${network})${existingThread ? ' [update]' : ''}`)

    // Skip unchanged threads: compare chat's lastActivity against DB
    // Skip this check in backfill mode — we want to scan full history for gaps even in "unchanged" threads
    if (existingThread && !opts.backfill) {
      const chatLastActivity = (chat.lastActivity || chat.lastMessageAt || (chat.lastMessage as Record<string, unknown>)?.timestamp) as string | undefined
      const dbRow = db.query(`SELECT last_activity_at FROM threads WHERE id = ?`).get(threadId) as { last_activity_at: string | null } | null
      if (chatLastActivity && dbRow?.last_activity_at && chatLastActivity <= dbRow.last_activity_at) {
        totalSkipped++
        continue
      }
    }

    // For existing threads, get newest known message timestamp for early-stop
    let newestKnownMsgTs: string | null = null
    if (existingThread) {
      const row = db.query(`SELECT MAX(timestamp) as ts FROM messages WHERE thread_id = ?`).get(threadId) as { ts: string | null } | null
      newestKnownMsgTs = row?.ts || null
    }

    // Fetch messages with pagination
    // Normal mode: 50 pages (5000 msgs) with early-stop when we reach known messages
    // Backfill mode: unlimited pages, no early-stop — fetches full history, relies on ID dedup
    const allMessages: Array<Record<string, unknown>> = []
    let msgPageCount = 0
    // Beeper API returns 20 msgs/page (limit param ignored), uses cursor= for pagination (before= ignored)
    const maxMsgPages = opts.backfill ? 1000 : 100  // Backfill: ~20K msgs/chat; Normal: ~2K msgs/chat
    let beforeSortKey: string | null = null

    while (msgPageCount < maxMsgPages) {
      msgPageCount++
      try {
        const encodedChatId = encodeURIComponent(chatId).replace(/!/g, '%21')
        const url = `${BEEPER_API_BASE}/v1/chats/${encodedChatId}/messages?limit=100${beforeSortKey ? `&cursor=${beforeSortKey}` : ''}`
        const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } })
        if (!res.ok) {
          console.log(`  Error fetching messages: ${res.status}`)
          break
        }
        const data = await res.json() as { items?: Array<Record<string, unknown>>; hasMore?: boolean }
        const messages = data.items || []
        if (messages.length === 0) break
        allMessages.push(...messages)

        // Early-stop: if we've reached messages older than what's already stored, stop
        // Skip in backfill mode — we want to scan the full history for gaps
        if (!opts.backfill && newestKnownMsgTs && messages.length > 0) {
          const oldestFetched = messages[messages.length - 1].timestamp as string | undefined
          if (oldestFetched && oldestFetched <= newestKnownMsgTs) break
        }

        // Use sortKey of last message for pagination
        if (data.hasMore && messages.length > 0) {
          const lastMsg = messages[messages.length - 1]
          beforeSortKey = lastMsg.sortKey as string
        } else {
          break
        }
      } catch {
        break
      }
    }

    if (msgPageCount >= maxMsgPages) {
      console.log(`  [WARNING] Hit page limit (${maxMsgPages}) — chat may have more messages`)
    }

    // For existing threads, filter to only messages newer than what we already have
    // Skip in backfill mode — we want ALL messages so ID-based dedup can find gaps
    if (newestKnownMsgTs && !opts.backfill) {
      const beforeCount = allMessages.length
      const filtered = allMessages.filter(m => {
        const ts = m.timestamp as string | undefined
        return ts && ts > newestKnownMsgTs!
      })
      // Replace allMessages content (keep reference for downstream code)
      allMessages.length = 0
      allMessages.push(...filtered)
    }

    if (allMessages.length === 0) {
      console.log(`  No messages found, skipping`)
      continue
    }

    const myMessages = allMessages.filter(m => m.isSender === true || (m.senderID as string)?.includes(OWNER_CONFIG.personId.replace('-', '')))

    // For new threads, skip if the owner has no messages (no context-only captures)
    // For existing threads, we already know the owner participated — accept all new messages
    if (myMessages.length === 0 && !existingThread) {
      console.log(`  ${allMessages.length} messages but none from me, skipping`)
      totalSkipped++
      continue
    }

    const sortedMessages = allMessages.sort((a, b) => {
      const ta = new Date(a.timestamp as string).getTime()
      const tb = new Date(b.timestamp as string).getTime()
      return ta - tb
    })

    const firstTimestamp = (sortedMessages[0].timestamp as string) || new Date().toISOString()
    const lastTimestamp = (sortedMessages[sortedMessages.length - 1].timestamp as string) || new Date().toISOString()

    if (opts.fromDate && lastTimestamp < opts.fromDate + 'T00:00:00.000Z') continue
    if (opts.toDate && firstTimestamp > opts.toDate + 'T23:59:59.999Z') continue

    if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
    if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp

    // For existing threads, build set of already-stored message IDs to skip
    const existingMsgIds = new Set<string>()
    if (existingThread) {
      const stored = db.query(`SELECT id FROM messages WHERE thread_id = ?`).all(threadId) as Array<{ id: string }>
      for (const r of stored) existingMsgIds.add(r.id)
    }

    const participantIds: string[] = [ownerId]
    const seenParticipants = new Set<string>()

    for (const msg of allMessages) {
      const isFromMe = msg.isSender === true || (msg.senderID as string)?.includes(OWNER_CONFIG.personId.replace('-', ''))
      if (isFromMe) continue

      const senderId = msg.senderID as string | undefined
      if (!senderId || seenParticipants.has(senderId)) continue
      seenParticipants.add(senderId)

      const senderName = (msg.senderName || senderId) as string
      // Use network as context to prevent single-word name collisions across networks
      const personSourceCtx = isTwitterDM ? 'twitter-dm' : 'beeper'
      const personId = createSourcePersonId(senderName, personSourceCtx, network) || `${personSourceCtx}-${senderId.slice(0, 20)}`

      const existingPerson = db.query(`SELECT id FROM people WHERE id = ?`).get(personId)
      if (!existingPerson && !opts.dryRun) {
        const identifiers: string[] = [senderId]

        // Extract Twitter handle from Beeper sender ID for Twitter DMs
        if (isTwitterDM && senderId.includes(':local-twitter')) {
          // Beeper Twitter sender IDs are matrix-style; extract handle from senderName if available
          if (senderName && senderName !== senderId) {
            identifiers.push(`twitter:${senderName}`)
          }
        }

        // Extract and add normalized phone number for cross-channel matching
        const normalizedPhone = normalizePhoneFromBeeperId(senderId)
        if (normalizedPhone && normalizedPhone.length >= 10) {
          identifiers.push(normalizedPhone)
        }

        db.query(`
          INSERT INTO people (id, display_name, identifiers, first_seen)
          VALUES (?, ?, ?, ?)
        `).run(personId, senderName, JSON.stringify(identifiers), firstTimestamp)
      }
      participantIds.push(personId)
    }

    if (!opts.dryRun) {
      if (!existingThread) {
        // New thread: insert thread record
        db.query(`
          INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          threadId,
          sourceLabel,
          chatId,
          null,
          title,
          firstTimestamp,
          lastTimestamp,
          allMessages.length,
          myMessages.length,
          JSON.stringify([...new Set(participantIds)]),
          chatType === 'group' ? 'group' : '1:1',
          JSON.stringify({ network, chatType })
        )
      }

      // Get current max position for incremental inserts
      let nextPosition = 1
      if (existingThread) {
        const maxPos = db.query(`SELECT MAX(position_in_thread) as mp FROM messages WHERE thread_id = ?`).get(threadId) as { mp: number | null }
        nextPosition = (maxPos.mp || 0) + 1
      }

      let newMsgCount = 0
      for (let i = 0; i < sortedMessages.length; i++) {
        const msg = sortedMessages[i]
        const msgId = (msg.id || msg.messageID) as string
        const messageId = `beeper:${chatId}:${msgId}`
        const timestamp = (msg.timestamp as string) || new Date().toISOString()
        const text = (msg.text || msg.body || '') as string
        const isFromMe = msg.isSender === true || (msg.senderID as string)?.includes(OWNER_CONFIG.personId.replace('-', ''))

        // Skip if already stored in this beeper thread
        if (existingMsgIds.has(messageId)) continue

        // Cross-source dedup: skip iMessage messages that exist in native imessage source
        if (isImessage && nativeImsgIds.has(msgId)) continue

        let senderId = ownerId
        if (!isFromMe) {
          const senderName = (msg.senderName || msg.senderID || 'unknown') as string
          // Use network as context to prevent single-word name collisions across networks
          const msgPersonCtx = isTwitterDM ? 'twitter-dm' : 'beeper'
          senderId = createSourcePersonId(senderName, msgPersonCtx, network) || `${msgPersonCtx}-${(msg.senderID as string || '').slice(0, 20)}`
        }

        // Content-based dedup: skip if same thread + timestamp + content already exists
        const existingMsg = db.query(`
          SELECT id FROM messages WHERE thread_id = ? AND timestamp = ? AND content = ?
        `).get(threadId, timestamp, text)
        if (existingMsg) continue

        const position = existingThread ? nextPosition++ : i + 1

        db.query(`
          INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dm', ?, ?)
        `).run(
          messageId,
          threadId,
          sourceLabel,
          msgId,
          timestamp,
          position,
          senderId,
          isFromMe ? 1 : 0,
          text,
          text.split(/\s+/).filter(Boolean).length,
          JSON.stringify(msg)
        )
        newMsgCount++
      }

      // For existing threads with new messages, update thread metadata
      if (existingThread && newMsgCount > 0) {
        const counts = db.query(`
          SELECT COUNT(*) as total, SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as mine
          FROM messages WHERE thread_id = ?
        `).get(threadId) as { total: number; mine: number }

        db.query(`
          UPDATE threads SET
            last_activity_at = MAX(last_activity_at, ?),
            message_count = ?,
            my_message_count = ?
          WHERE id = ?
        `).run(lastTimestamp, counts.total, counts.mine, threadId)

        console.log(`  +${newMsgCount} new messages (total: ${counts.total})`)
        totalUpdated++
      } else if (!existingThread) {
        console.log(`  ${allMessages.length} messages, ${myMessages.length} from me`)
        totalExtracted++
      } else {
        totalSkipped++
      }
    } else {
      // Dry run — just count
      if (existingThread) {
        totalSkipped++
      } else {
        console.log(`  ${allMessages.length} messages, ${myMessages.length} from me`)
        totalExtracted++
      }
    }

    if ((totalExtracted + totalUpdated) % 10 === 0 && (totalExtracted + totalUpdated) > 0) {
      console.log(`  Progress: ${totalExtracted} new, ${totalUpdated} updated`)
    }
  }

  console.log(`\n--- Beeper Extraction Complete ---`)
  console.log(`New chats: ${formatNumber(totalExtracted)}`)
  console.log(`Updated chats: ${formatNumber(totalUpdated)}`)
  console.log(`Skipped (unchanged or no participation): ${formatNumber(totalSkipped)}`)

  return { count: totalExtracted + totalUpdated, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// GROUPME EXTRACTION
// ============================================================

const GROUPME_API_BASE = 'https://api.groupme.com/v3'

// Group-capture policy (matched case-insensitively on group name).
// Default rule: capture a group only if the owner has posted in it (over all-time on backfill).
//   - EXCLUDE: never capture, skipped before any message fetch (saves API calls).
//   - FORCE_INCLUDE: capture even if the owner hasn't posted (valuable read-only context).
// DMs are always captured regardless of participation (see gate below).
const GROUPME_EXCLUDE_GROUPS = new Set(['morning run'])          // basketball group — high noise, no recent participation
const GROUPME_FORCE_INCLUDE_GROUPS = new Set(['u.d. neighbors']) // neighborhood info (contractor lists, etc.) worth keeping even when lurking

async function extractGroupMe(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean; backfill?: boolean }
): Promise<ExtractionResult> {
  const envVars = await load_env()
  const token = envVars.GROUPME_ACCESS_TOKEN
  if (!token) {
    console.error('Error: GROUPME_ACCESS_TOKEN not set')
    console.error('Get your token at https://dev.groupme.com → "Access Token" link (top-right)')
    return { count: 0, newest: null, oldest: null }
  }

  // GroupMe GET helper: token query param + 429 backoff. Returns the `response` payload,
  // or { __notModified: true } on HTTP 304 (end of `before_id` pagination), or null on error.
  async function gmGet(path: string, params: Record<string, string | number> = {}): Promise<any> {
    const qs = new URLSearchParams({ token })
    for (const [k, v] of Object.entries(params)) qs.set(k, String(v))
    const url = `${GROUPME_API_BASE}${path}?${qs}`
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(url)
      if (res.status === 304) return { __notModified: true }
      if (res.status === 429) {
        const wait = 2000 * (attempt + 1)
        console.log(`  Rate limited (429), waiting ${wait}ms...`)
        await new Promise(r => setTimeout(r, wait))
        continue
      }
      if (res.status === 401) {
        console.error('Error: GroupMe authentication failed (401) — check GROUPME_ACCESS_TOKEN')
        return null
      }
      if (!res.ok) {
        console.error(`Error: GroupMe API ${path} returned ${res.status}`)
        return null
      }
      const data = await res.json() as { response?: any }
      return data.response ?? null
    }
    console.error(`Error: GroupMe API ${path} kept returning 429`)
    return null
  }

  // Identify the owner's GroupMe user id — needed to compute is_from_me
  const me = await gmGet('/users/me')
  if (!me || !me.id) {
    console.error('Error: could not fetch GroupMe /users/me')
    return { count: 0, newest: null, oldest: null }
  }
  const myUserId = String(me.id)
  console.log(`GroupMe user: ${me.name} (${myUserId})`)

  const ownerId = OWNER_CONFIG.personId
  const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
  if (!existingOwner && !opts.dryRun) {
    db.query(`
      INSERT INTO people (id, display_name, identifiers, first_seen)
      VALUES (?, ?, ?, datetime('now'))
    `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], OWNER_CONFIG.phone]))
  }

  // Auto-detect --from (7 days before newest groupme thread) unless doing a full backfill
  if (!opts.fromDate && !opts.backfill) {
    const newest = db.query(`SELECT MAX(last_activity_at) as newest FROM threads WHERE source = 'groupme'`).get() as { newest: string | null } | null
    if (newest?.newest) {
      const d = new Date(newest.newest)
      d.setDate(d.getDate() - 7)
      opts.fromDate = d.toISOString().split('T')[0]
      console.log(`Auto-detected --from: ${opts.fromDate} (7 days before newest groupme thread)`)
    }
  }
  const fromMs = opts.fromDate ? new Date(opts.fromDate + 'T00:00:00.000Z').getTime() : null
  const toMs = opts.toDate ? new Date(opts.toDate + 'T23:59:59.999Z').getTime() : null

  let totalExtracted = 0
  let totalUpdated = 0
  let totalSkipped = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null

  // --- Enumerate conversations: groups + DMs ---
  type Convo = { kind: 'group' | 'dm'; convoId: string; title: string; otherUserId?: string }
  const convos: Convo[] = []

  console.log('\n--- Listing GroupMe groups ---')
  for (let page = 1; page <= 50; page++) {
    const groups = await gmGet('/groups', { page, per_page: 100, omit: 'memberships' })
    if (!groups || groups.length === 0) break
    for (const g of groups) {
      const name = (g.name as string) || `group ${g.id}`
      if (GROUPME_EXCLUDE_GROUPS.has(name.trim().toLowerCase())) {
        console.log(`  Excluding group: ${name}`)
        continue
      }
      convos.push({ kind: 'group', convoId: String(g.id), title: name })
    }
    if (groups.length < 100) break
  }
  console.log(`  ${convos.filter(c => c.kind === 'group').length} groups`)

  console.log('--- Listing GroupMe DMs ---')
  for (let page = 1; page <= 50; page++) {
    const chats = await gmGet('/chats', { page, per_page: 100 })
    if (!chats || chats.length === 0) break
    for (const c of chats) {
      const other = c.other_user || {}
      convos.push({ kind: 'dm', convoId: String(other.id), title: (other.name as string) || `dm ${other.id}`, otherUserId: String(other.id) })
    }
    if (chats.length < 100) break
  }
  console.log(`  ${convos.filter(c => c.kind === 'dm').length} DMs`)

  // --- Per-conversation message fetch ---
  let processed = 0
  for (const convo of convos) {
    processed++
    if (opts.limit && processed > opts.limit) break

    const threadId = convo.kind === 'group' ? `groupme:group:${convo.convoId}` : `groupme:dm:${convo.convoId}`
    const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId)

    // Already-stored message IDs for dedup
    const existingMsgIds = new Set<string>()
    if (existingThread) {
      const stored = db.query(`SELECT id FROM messages WHERE thread_id = ?`).all(threadId) as Array<{ id: string }>
      for (const r of stored) existingMsgIds.add(r.id)
    }

    // Page backward via before_id (newest-first). Stop once older than fromMs (unless backfill).
    const collected: any[] = []
    let beforeId: string | null = null
    const maxPages = opts.backfill ? 1000 : 100
    let stop = false
    for (let p = 0; p < maxPages && !stop; p++) {
      const params: Record<string, string | number> = { limit: 100 }
      if (beforeId) params.before_id = beforeId
      let resp: any
      if (convo.kind === 'group') {
        resp = await gmGet(`/groups/${convo.convoId}/messages`, params)
      } else {
        params.other_user_id = convo.otherUserId!
        resp = await gmGet('/direct_messages', params)
      }
      if (!resp || resp.__notModified) break
      const msgs = convo.kind === 'group' ? (resp.messages || []) : (resp.direct_messages || [])
      if (msgs.length === 0) break
      for (const m of msgs) {
        const tsMs = Number(m.created_at) * 1000
        if (fromMs && tsMs < fromMs && !opts.backfill) { stop = true; break }
        collected.push(m)
      }
      beforeId = String(msgs[msgs.length - 1].id)
      if (msgs.length < 100) break
    }

    if (collected.length === 0) { totalSkipped++; continue }

    // Filter to window; drop system messages (joins/renames/etc.)
    const allMessages = collected.filter(m => {
      if (m.sender_type === 'system') return false
      const tsMs = Number(m.created_at) * 1000
      if (fromMs && tsMs < fromMs) return false
      if (toMs && tsMs > toMs) return false
      return true
    })
    if (allMessages.length === 0) { totalSkipped++; continue }

    const myMessages = allMessages.filter(m => String(m.user_id) === myUserId)
    // Participation gate for NEW threads. DMs and force-included groups bypass it;
    // other groups are captured only if the owner has posted in them. Existing threads always accept new messages.
    const bypassParticipation = convo.kind === 'dm' || GROUPME_FORCE_INCLUDE_GROUPS.has(convo.title.trim().toLowerCase())
    if (myMessages.length === 0 && !existingThread && !bypassParticipation) { totalSkipped++; continue }

    allMessages.sort((a, b) => Number(a.created_at) - Number(b.created_at))
    const firstTimestamp = new Date(Number(allMessages[0].created_at) * 1000).toISOString()
    const lastTimestamp = new Date(Number(allMessages[allMessages.length - 1].created_at) * 1000).toISOString()

    if (!newestTimestamp || lastTimestamp > newestTimestamp) newestTimestamp = lastTimestamp
    if (!oldestTimestamp || firstTimestamp < oldestTimestamp) oldestTimestamp = firstTimestamp

    // Build participants (and register new people)
    const participantIds: string[] = [ownerId]
    const seen = new Set<string>()
    for (const m of allMessages) {
      const senderUid = String(m.user_id)
      if (senderUid === myUserId || seen.has(senderUid)) continue
      seen.add(senderUid)
      const senderName = (m.name as string) || senderUid
      const personId = createSourcePersonId(senderName, 'groupme', convo.convoId) || `groupme-${senderUid}`
      const existingPerson = db.query(`SELECT id FROM people WHERE id = ?`).get(personId)
      if (!existingPerson && !opts.dryRun) {
        db.query(`
          INSERT INTO people (id, display_name, identifiers, first_seen)
          VALUES (?, ?, ?, ?)
        `).run(personId, senderName, JSON.stringify([`groupme:${senderUid}`]), firstTimestamp)
      }
      participantIds.push(personId)
    }

    if (!opts.dryRun) {
      if (!existingThread) {
        db.query(`
          INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
          VALUES (?, 'groupme', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          threadId,
          convo.convoId,
          null,
          convo.title,
          firstTimestamp,
          lastTimestamp,
          allMessages.length,
          myMessages.length,
          JSON.stringify([...new Set(participantIds)]),
          convo.kind === 'group' ? 'group' : '1:1',
          JSON.stringify({ kind: convo.kind })
        )
      }

      let nextPosition = 1
      if (existingThread) {
        const maxPos = db.query(`SELECT MAX(position_in_thread) as mp FROM messages WHERE thread_id = ?`).get(threadId) as { mp: number | null }
        nextPosition = (maxPos.mp || 0) + 1
      }

      let newMsgCount = 0
      for (let i = 0; i < allMessages.length; i++) {
        const m = allMessages[i]
        const msgId = String(m.id)
        const messageId = `${threadId}:${msgId}`
        if (existingMsgIds.has(messageId)) continue

        const timestamp = new Date(Number(m.created_at) * 1000).toISOString()
        const text = (m.text as string) || ''
        const isFromMe = String(m.user_id) === myUserId

        let senderId = ownerId
        if (!isFromMe) {
          const senderName = (m.name as string) || String(m.user_id)
          senderId = createSourcePersonId(senderName, 'groupme', convo.convoId) || `groupme-${m.user_id}`
        }

        // Content-based dedup
        const existingMsg = db.query(`SELECT id FROM messages WHERE thread_id = ? AND timestamp = ? AND content = ?`).get(threadId, timestamp, text)
        if (existingMsg) continue

        const hasAttachments = Array.isArray(m.attachments) && m.attachments.length > 0
        const position = existingThread ? nextPosition++ : i + 1

        db.query(`
          INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, has_attachments, word_count, raw_json)
          VALUES (?, ?, 'groupme', ?, ?, ?, ?, ?, ?, 'dm', ?, ?, ?)
        `).run(
          messageId,
          threadId,
          msgId,
          timestamp,
          position,
          senderId,
          isFromMe ? 1 : 0,
          text,
          hasAttachments ? 1 : 0,
          text.split(/\s+/).filter(Boolean).length,
          JSON.stringify(m)
        )
        newMsgCount++
      }

      if (existingThread && newMsgCount > 0) {
        const counts = db.query(`
          SELECT COUNT(*) as total, SUM(CASE WHEN is_from_me = 1 THEN 1 ELSE 0 END) as mine
          FROM messages WHERE thread_id = ?
        `).get(threadId) as { total: number; mine: number }
        db.query(`
          UPDATE threads SET last_activity_at = MAX(last_activity_at, ?), message_count = ?, my_message_count = ? WHERE id = ?
        `).run(lastTimestamp, counts.total, counts.mine, threadId)
        console.log(`  [${convo.kind}] ${convo.title}: +${newMsgCount} new (total ${counts.total})`)
        totalUpdated++
      } else if (!existingThread) {
        console.log(`  [${convo.kind}] ${convo.title}: ${allMessages.length} messages, ${myMessages.length} from me`)
        totalExtracted++
      } else {
        totalSkipped++
      }
    } else {
      // Dry run — just count
      if (existingThread) {
        totalSkipped++
      } else {
        console.log(`  [${convo.kind}] ${convo.title}: ${allMessages.length} messages, ${myMessages.length} from me`)
        totalExtracted++
      }
    }
  }

  console.log(`\n--- GroupMe Extraction Complete ---`)
  console.log(`New conversations: ${formatNumber(totalExtracted)}`)
  console.log(`Updated conversations: ${formatNumber(totalUpdated)}`)
  console.log(`Skipped (unchanged or no participation): ${formatNumber(totalSkipped)}`)

  return { count: totalExtracted + totalUpdated, newest: newestTimestamp, oldest: oldestTimestamp }
}

// ============================================================
// PODCAST EXTRACTION
// ============================================================

async function extractPodcast(
  db: Database,
  opts: { fromDate?: string; toDate?: string; limit?: number; dryRun: boolean }
): Promise<ExtractionResult> {
  // Podcast is an optional, owner-specific source. It reads an episodes CSV whose
  // transcript/intro/questions/commentary columns hold paths relative to the podcast repo root.
  // Configure extraction.podcast.episodes_csv in config.json to enable it; otherwise skip cleanly.
  const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  const episodesCsvPath = config.extraction?.podcast?.episodes_csv
  if (!episodesCsvPath) {
    console.log('Podcast source not configured (set extraction.podcast.episodes_csv in config.json). Skipping.')
    return { count: 0, newest: null, oldest: null }
  }
  if (!existsSync(episodesCsvPath)) {
    console.error(`Error: episodes.csv not found at: ${episodesCsvPath}`)
    return { count: 0, newest: null, oldest: null }
  }
  // Convention: episodes.csv lives at <podcastDir>/data/episodes.csv; sponsor ad-reads at <podcastDir>/data/sponsors.
  const podcastDir = dirname(dirname(episodesCsvPath))
  const sponsorsDir = join(podcastDir, 'data', 'sponsors')

  // Parse CSV
  const { parse } = await import('csv-parse/sync')
  const csvContent = readFileSync(episodesCsvPath, 'utf8')
  const episodes = parse(csvContent, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>

  console.log(`\nFound ${formatNumber(episodes.length)} episodes in CSV`)

  // Ensure the owner's person record exists
  const ownerId = OWNER_CONFIG.personId
  const existingOwner = db.query(`SELECT id FROM people WHERE id = ?`).get(ownerId)
  if (!existingOwner && !opts.dryRun) {
    db.query(`
      INSERT INTO people (id, display_name, identifiers, first_seen)
      VALUES (?, ?, ?, datetime('now'))
    `).run(ownerId, OWNER_CONFIG.displayName, JSON.stringify([OWNER_CONFIG.emails[0], OWNER_CONFIG.twitterHandle]))
  }

  let extracted = 0
  let skipped = 0
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null

  // Sort by date descending (newest first)
  const sortedEpisodes = [...episodes].sort((a, b) => (b.publish_date || '').localeCompare(a.publish_date || ''))

  for (const episode of sortedEpisodes) {
    const publishDate = episode.publish_date
    if (!publishDate) continue

    // Apply date filters
    if (opts.fromDate && publishDate < opts.fromDate) continue
    if (opts.toDate && publishDate > opts.toDate) continue

    // Apply limit
    if (opts.limit && extracted >= opts.limit) break

    // Use ghost_id as unique identifier (most reliable)
    const episodeId = episode.ghost_id
    if (!episodeId) continue

    const threadId = `podcast:${episodeId}`

    // Check if thread already exists — allow backfilling missing speaker turns or ad reads
    const existingThread = db.query(`SELECT id FROM threads WHERE id = ?`).get(threadId) as { id: string } | null
    let backfillMode = false
    if (existingThread) {
      const speakerTurnStats = db.query(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(content)), 0) AS chars FROM messages WHERE thread_id = ? AND content_type = 'speaker_turn'`
      ).get(threadId) as { cnt: number; chars: number }
      const hasSpeakerTurns = speakerTurnStats.cnt > 0
      const hasAdReads = db.query(
        `SELECT 1 FROM messages WHERE thread_id = ? AND content_type = 'ad_read' LIMIT 1`
      ).get(threadId)
      const hasSponsoredEpisode = (episode.sponsors || '').trim().length > 0

      // Editorial commentary is written AFTER the interview, so commentary_file is
      // routinely populated only after the episode was first extracted. The skip
      // condition used to consider speaker turns + ad reads only, and the commentary
      // import below was hard-skipped in backfill mode — so a commentary file added
      // later could never be picked up by any run. That is why editorial_commentary
      // had stalled at 2026-06-10 while every other podcast content type stayed current.
      const hasCommentary = db.query(
        `SELECT 1 FROM messages WHERE thread_id = ? AND content_type = 'editorial_commentary' LIMIT 1`
      ).get(threadId)
      let commentaryPending = false
      if (!hasCommentary && episode.commentary_file) {
        try {
          commentaryPending = existsSync(join(podcastDir, episode.commentary_file))
        } catch { /* ignore stat errors */ }
      }

      // Detect transcript expansion: if the on-disk file is much larger than what's
      // already in the DB, the transcript was probably expanded (e.g., a stub was
      // backfilled with a real transcription) and we should re-import speaker turns.
      // Threshold: file > 2x existing speaker_turn content AND file > 10KB.
      let transcriptExpanded = false
      if (episode.transcript_file) {
        try {
          const transcriptPath = join(podcastDir, episode.transcript_file)
          if (existsSync(transcriptPath)) {
            const fileSize = statSync(transcriptPath).size
            if (fileSize > 10_000 && fileSize > speakerTurnStats.chars * 2) {
              transcriptExpanded = true
            }
          }
        } catch {
          // ignore stat errors
        }
      }

      if (hasSpeakerTurns && (hasAdReads || !hasSponsoredEpisode) && !transcriptExpanded && !commentaryPending) {
        skipped++
        continue
      }
      // Thread exists but missing speaker turns/ad reads, or transcript was expanded — backfill
      backfillMode = true
    }

    const title = episode.title || 'Untitled Episode'
    const guestNames = episode.guest_names || ''
    const websiteUrl = episode.website_url
    const timestamp = `${publishDate}T12:00:00Z`

    // Track timestamps
    if (!newestTimestamp || timestamp > newestTimestamp) newestTimestamp = timestamp
    if (!oldestTimestamp || timestamp < oldestTimestamp) oldestTimestamp = timestamp

    // Parse guests for people records
    const guestList = guestNames.split(/[;]/).map(s => s.trim()).filter(Boolean)
    const participantIds: string[] = [ownerId]

    for (const guestName of guestList) {
      if (guestName.toLowerCase().includes(OWNER_CONFIG.displayName.split(' ')[0].toLowerCase())) continue
      if (guestName === 'N/A' || guestName === '') continue

      // Use createSourcePersonId - podcast guests usually have full names, but this
      // handles edge cases with single-word names (e.g., "Lex", "Demis")
      const personId = createSourcePersonId(guestName, 'podcast', episodeId)
      if (!personId) continue
      participantIds.push(personId)

      if (!opts.dryRun) {
        const existing = db.query(`SELECT id FROM people WHERE id = ?`).get(personId)
        if (!existing) {
          db.query(`
            INSERT INTO people (id, display_name, identifiers, first_seen, last_seen, thread_count)
            VALUES (?, ?, ?, ?, ?, 1)
          `).run(
            personId,
            guestName,
            JSON.stringify([guestName]),
            timestamp,
            timestamp
          )
        } else {
          db.query(`
            UPDATE people
            SET last_seen = MAX(last_seen, ?), thread_count = thread_count + 1
            WHERE id = ?
          `).run(timestamp, personId)
        }
      }
    }

    // Count messages we'll create
    let messageCount = 0
    let myMessageCount = 0
    let messagePosition = 0
    const messageInserts: Array<{
      id: string
      threadId: string
      sourceMessageId: string
      timestamp: string
      position: number
      senderId: string
      isFromMe: boolean
      content: string
      contentType: string
      wordCount: number
      rawJson: string
    }> = []

    // 1. Import Questions (written first, before interview) — skip in backfill mode
    if (!backfillMode) {
    const questionsFile = episode.questions_file
    if (questionsFile) {
      const questionsPath = join(podcastDir, questionsFile)
      if (existsSync(questionsPath)) {
        const questionsContent = readFileSync(questionsPath, 'utf8')
        // Remove YAML frontmatter if present
        const cleanedQuestions = questionsContent.replace(/^---[\s\S]*?---\n*/m, '').trim()
        if (cleanedQuestions) {
          messagePosition++
          messageCount++
          myMessageCount++
          messageInserts.push({
            id: `podcast:${episodeId}:questions`,
            threadId,
            sourceMessageId: `${episodeId}:questions`,
            timestamp: `${publishDate}T08:00:00Z`, // Questions written before interview
            position: messagePosition,
            senderId: ownerId,
            isFromMe: true,
            content: cleanedQuestions,
            contentType: 'questions',
            wordCount: cleanedQuestions.split(/\s+/).length,
            rawJson: JSON.stringify({ type: 'questions', file: questionsFile })
          })
        }
      }
    }
    } // end commentary block

    // 2. Import Transcript Speaker Turns (the interview itself)
    const transcriptFile = episode.transcript_file
    if (transcriptFile) {
      const transcriptPath = join(podcastDir, transcriptFile)
      if (existsSync(transcriptPath)) {
        const transcriptContent = readFileSync(transcriptPath, 'utf8')
        const speakerTurns = parsePodcastTranscript(transcriptContent)

        for (let i = 0; i < speakerTurns.length; i++) {
          const turn = speakerTurns[i]
          messagePosition++
          messageCount++

          // Determine if this is the owner speaking
          const isFromMe = turn.speaker.toLowerCase().includes(OWNER_CONFIG.displayName.split(' ')[0].toLowerCase())
          if (isFromMe) myMessageCount++

          // Determine sender ID
          let senderId = ownerId
          if (!isFromMe) {
            // Try to match with guest names
            const matchingGuest = guestList.find(g =>
              turn.speaker.toLowerCase().includes(g.toLowerCase().split(' ')[0])
            )
            // Use createSourcePersonId for consistency with person records created above
            const speakerToUse = matchingGuest || turn.speaker
            senderId = createSourcePersonId(speakerToUse, 'podcast', episodeId)
          }

          messageInserts.push({
            id: `podcast:${episodeId}:turn:${i + 1}`,
            threadId,
            sourceMessageId: `${episodeId}:turn:${i + 1}`,
            timestamp: `${publishDate}T10:00:00Z`, // Interview during day
            position: messagePosition,
            senderId,
            isFromMe,
            content: turn.text,
            contentType: 'speaker_turn',
            wordCount: turn.text.split(/\s+/).length,
            rawJson: JSON.stringify({ type: 'speaker_turn', speaker: turn.speaker, timestamp: turn.timestamp })
          })
        }
      }
    }

    // 3. Import Editorial Commentary (written after the interview).
    //    Runs in backfill mode too — backfill drops ids that already exist and inserts
    //    with OR IGNORE, so a re-run cannot duplicate the single commentary message.
    {
    const commentaryFile = episode.commentary_file
    if (commentaryFile) {
      const commentaryPath = join(podcastDir, commentaryFile)
      if (existsSync(commentaryPath)) {
        const commentaryContent = readFileSync(commentaryPath, 'utf8')
        // Remove YAML frontmatter if present
        const cleanedCommentary = commentaryContent.replace(/^---[\s\S]*?---\n*/m, '').trim()
        if (cleanedCommentary) {
          messagePosition++
          messageCount++
          myMessageCount++
          messageInserts.push({
            id: `podcast:${episodeId}:commentary`,
            threadId,
            sourceMessageId: `${episodeId}:commentary`,
            timestamp: `${publishDate}T14:00:00Z`, // Commentary written after
            position: messagePosition,
            senderId: ownerId,
            isFromMe: true,
            content: cleanedCommentary,
            contentType: 'editorial_commentary',
            wordCount: cleanedCommentary.split(/\s+/).length,
            rawJson: JSON.stringify({ type: 'editorial_commentary', file: commentaryFile })
          })
        }
      }
    }
    } // end !backfillMode

    // 4. Import Intro (written last, even though presented first) — skip in backfill mode
    if (!backfillMode) {
    const introFile = episode.intro_file
    if (introFile) {
      const introPath = join(podcastDir, introFile)
      if (existsSync(introPath)) {
        const introContent = readFileSync(introPath, 'utf8')
        // Remove YAML frontmatter if present
        const cleanedIntro = introContent.replace(/^---[\s\S]*?---\n*/m, '').trim()
        if (cleanedIntro) {
          messagePosition++
          messageCount++
          myMessageCount++
          messageInserts.push({
            id: `podcast:${episodeId}:intro`,
            threadId,
            sourceMessageId: `${episodeId}:intro`,
            timestamp: `${publishDate}T16:00:00Z`, // Intro written last
            position: messagePosition,
            senderId: ownerId,
            isFromMe: true,
            content: cleanedIntro,
            contentType: 'intro',
            wordCount: cleanedIntro.split(/\s+/).length,
            rawJson: JSON.stringify({ type: 'intro', file: introFile })
          })
        }
      }
    }
    } // end !backfillMode

    // Ad reads — always extract (both new threads and backfill)
    // Find ad reads from sponsors directory for this episode
    const episodeSlug = (episode.website_url || '').replace(/\/$/, '').split('/').pop() || ''
    const sponsorNames = (episode.sponsors || '').split(';').map((s: string) => s.trim()).filter(Boolean)
    if (episodeSlug && sponsorNames.length > 0 && existsSync(sponsorsDir)) {
      for (const sponsorName of sponsorNames) {
        // Derive sponsor slug (same logic as extract-ad-reads.ts)
        const SPONSOR_SLUG_MAP: Record<string, string> = {
          'Claude': 'anthropic', 'Oracle': 'oracle', 'Oracle Cloud Infrastructure': 'oracle',
          'Oracle Cloud Infrastructure (OCI)': 'oracle', 'NetSuite': 'netsuite', 'NetSuite by Oracle': 'netsuite',
          'Google AI Studio': 'google', 'Google Gemini': 'google', 'Google Gemini 2.5 Flash': 'google',
          'Google Gemini Notebook LM': 'google', 'Gemini CLI': 'google',
          'AGNTCY': 'agntcy', 'The AGNTCY': 'agntcy',
          'Weights & Biases RAG++': 'weights-and-biases', 'Weights & Biases Weave': 'weights-and-biases',
          'Agents of Scale': 'agents-of-scale', '80,000 Hours': '80000-hours',
        }
        const sponsorSlug = SPONSOR_SLUG_MAP[sponsorName] || sponsorName.toLowerCase()
          .replace(/[&,]/g, '').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')

        const adReadsDir = join(sponsorsDir, sponsorSlug, 'ad_reads')
        if (!existsSync(adReadsDir)) continue

        // Scan canonical ad read files for ones that include this episode
        for (const file of readdirSync(adReadsDir).filter((f: string) => f.endsWith('.md'))) {
          const filePath = join(adReadsDir, file)
          const raw = readFileSync(filePath, 'utf8')

          // Quick check: does this file reference our episode slug?
          if (!raw.includes(episodeSlug)) continue

          // Parse frontmatter and body
          const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/)
          if (!fmMatch) continue

          const fm = fmMatch[1]
          const adText = fmMatch[2].trim()

          // Skip stubs
          if (adText.startsWith('(Ad read not found') || adText.startsWith('(Placeholder episode')) continue

          // Verify this episode is actually in the episodes list
          if (!fm.includes(`slug: ${episodeSlug}`)) continue

          // Extract read_name for a unique message ID
          const readNameMatch = fm.match(/^read_name:\s*"?([^"\n]*)"?/m)
          const readName = readNameMatch ? readNameMatch[1].trim() : file.replace('.md', '')

          const adReadId = `podcast:${episodeId}:ad_read:${sponsorSlug}:${readName}`

          messagePosition++
          messageCount++
          myMessageCount++
          messageInserts.push({
            id: adReadId,
            threadId,
            sourceMessageId: `${episodeId}:ad_read:${sponsorSlug}`,
            timestamp: `${publishDate}T11:30:00Z`, // Before interview starts
            position: messagePosition,
            senderId: ownerId,
            isFromMe: true,
            content: adText,
            contentType: 'ad_read',
            wordCount: adText.split(/\s+/).length,
            rawJson: JSON.stringify({ type: 'ad_read', sponsor: sponsorName, sponsor_slug: sponsorSlug, read_name: readName, file })
          })
        }
      }
    }

    if (!opts.dryRun) {
      if (backfillMode) {
        // Backfill the content types that can legitimately arrive AFTER a thread was
        // first extracted: speaker turns / ad reads (re-transcription, ad extraction) and
        // editorial_commentary / questions (files written post-interview). Restricting
        // this to speaker_turn + ad_read is what stranded editorial_commentary at
        // 2026-06-10 — commentary_file gets populated later, and no run would look again.
        // Pre-filter against existing message IDs so we don't double-count when re-running
        // backfill on threads that already have some of these messages.
        const BACKFILLABLE = new Set(['speaker_turn', 'ad_read', 'editorial_commentary', 'questions'])
        const candidateInserts = messageInserts.filter(m => BACKFILLABLE.has(m.contentType))
        if (candidateInserts.length === 0) {
          skipped++
          continue
        }
        const existingIds = new Set<string>()
        for (const row of db.query(
          `SELECT id FROM messages WHERE thread_id = ? AND content_type IN ('speaker_turn','ad_read','editorial_commentary','questions')`
        ).all(threadId) as Array<{ id: string }>) {
          existingIds.add(row.id)
        }
        const backfillInserts = candidateInserts.filter(m => !existingIds.has(m.id))
        if (backfillInserts.length === 0) {
          skipped++
          continue
        }
        for (const msg of backfillInserts) {
          db.query(`
            INSERT OR IGNORE INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
            VALUES (?, ?, 'podcast', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            msg.id, msg.threadId, msg.sourceMessageId, msg.timestamp, msg.position,
            msg.senderId, msg.isFromMe ? 1 : 0, msg.content, msg.contentType, msg.wordCount, msg.rawJson
          )
        }
        // Update thread message counts (only the actually-new rows)
        const newCount = backfillInserts.length
        const newMyCount = backfillInserts.filter(m => m.isFromMe).length
        db.query(`
          UPDATE threads SET message_count = message_count + ?, my_message_count = my_message_count + ?
          WHERE id = ?
        `).run(newCount, newMyCount, threadId)
        const speakerCount = backfillInserts.filter(m => m.contentType === 'speaker_turn').length
        const adReadCount = backfillInserts.filter(m => m.contentType === 'ad_read').length
        const parts = []
        if (speakerCount > 0) parts.push(`${speakerCount} speaker turns`)
        if (adReadCount > 0) parts.push(`${adReadCount} ad reads`)
        console.log(`  Backfilled ${parts.join(' + ')} for: ${title}`)
      } else {
        // New thread: create thread + all messages
        db.query(`
          INSERT INTO threads (id, source, source_thread_id, source_url, title, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type, raw_json)
          VALUES (?, 'podcast', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          threadId,
          episodeId,
          websiteUrl || null,
          title,
          timestamp,
          timestamp,
          messageCount,
          myMessageCount,
          JSON.stringify(participantIds),
          guestList.length > 1 ? 'group' : (guestList.length === 1 ? '1:1' : 'broadcast'),
          JSON.stringify(episode)
        )

        for (const msg of messageInserts) {
          db.query(`
            INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, word_count, raw_json)
            VALUES (?, ?, 'podcast', ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            msg.id, msg.threadId, msg.sourceMessageId, msg.timestamp, msg.position,
            msg.senderId, msg.isFromMe ? 1 : 0, msg.content, msg.contentType, msg.wordCount, msg.rawJson
          )
        }
      }
    }

    extracted++

    if (extracted % 20 === 0) {
      console.log(`  Processed ${formatNumber(extracted)} episodes...`)
    }
  }

  console.log(`Extracted: ${formatNumber(extracted)}, Skipped (already exists): ${formatNumber(skipped)}`)
  return { count: extracted, newest: newestTimestamp, oldest: oldestTimestamp }
}

// Parse podcast transcript into speaker turns
// Supports many transcript formats found in the wild:
// Format 1: **[00:00] Speaker Name:** text
// Format 2: **Speaker Name:** [(00:00)](url) text
// Format 3: **[(00:00)](url) Speaker Name:** text
// Format 4: **Speaker Name:** [00:00](url) text  (no inner parens around timestamp)
// Format 5: **Speaker Name** [(00:00)](url) text  (no colon in bold)
// Format 6: **Speaker Name:** text  (no timestamp at all)
// Format 7: **Speaker Name:** (00:00) text  (bare parens timestamp, no link)
// Format 8: **[[00:00](url)] Speaker Name:** text  (link inside brackets)
// Format 9: **[00:00](url) Speaker Name:** text  (timestamp link without extra brackets)
// Format 10: **Speaker Name** [00:00](url) text  (no colon, no inner parens)
// Format 19: **Speaker Name**: text  (colon outside bold, no timestamp)
// Format 20: **Speaker Name** ([00:00](url)) text  (paren-wrapped timestamp link)
function parsePodcastTranscript(content: string): Array<{ speaker: string; text: string; timestamp: string }> {
  const turns: Array<{ speaker: string; text: string; timestamp: string }> = []
  const lines = content.split('\n')

  let currentSpeaker = ''
  let currentTimestamp = ''
  let currentText: string[] = []
  let inFrontmatter = false
  let frontmatterDone = false // once we've exited frontmatter, don't re-enter on later --- separators
  let seenNonBlankLine = false // track whether we've seen content before first ---
  let inLooseMetadata = true // track non-YAML metadata at start of file (url:, title:, etc.)

  for (const line of lines) {
    // Skip YAML frontmatter (--- delimited) — only valid at start of file
    // Many transcripts use --- as section separators between intro and main episode;
    // those should NOT be treated as frontmatter delimiters
    if (line.trim() === '---') {
      if (!frontmatterDone) {
        if (!seenNonBlankLine || inFrontmatter) {
          // Valid frontmatter: either opening --- at file start, or closing ---
          inFrontmatter = !inFrontmatter
          if (!inFrontmatter) frontmatterDone = true
          inLooseMetadata = false
        } else {
          // --- after content has started = section separator, not frontmatter
          frontmatterDone = true
        }
      }
      continue // always skip --- lines (they're separators either way)
    }
    if (inFrontmatter) continue

    if (line.trim()) seenNonBlankLine = true

    // Skip loose metadata lines at start of file (url:, title:, youtube_url:, etc.)
    if (inLooseMetadata) {
      if (line.match(/^(url|title|youtube_url|youtube_id|ghost_slug|description|audio_url):/)) continue
      if (line.trim() === '') continue
      inLooseMetadata = false // first non-metadata line ends the metadata section
    }

    // Skip headers and empty transcript markers
    if (line.startsWith('#')) continue
    if (line.trim() === '## Transcript') continue
    if (line.trim() === '## Full Transcript') continue
    // Skip auto-generated disclaimer lines
    if (line.trim().startsWith('*This transcript is automatically generated')) continue

    // Try all speaker turn formats, ordered from most specific to least
    let match: { speaker: string; timestamp: string; rest: string } | null = null

    // Format 1: **[00:00] Speaker Name:** text
    const f1 = line.match(/^\*\*\[(\d+:\d+(?::\d+)?)\]\s*([^:*]+):\*\*\s*(.*)$/)
    if (f1) match = { timestamp: f1[1], speaker: f1[2].trim(), rest: f1[3] }

    // Format 2: **Speaker Name:** [(00:00)](url) text
    if (!match) {
      const f2 = line.match(/^\*\*([^*:]+):\*\*\s*\[\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\s*(.*)$/)
      if (f2) match = { speaker: f2[1].trim(), timestamp: f2[2], rest: f2[3] }
    }

    // Format 3: **[(00:00)](url) Speaker Name:** text
    if (!match) {
      const f3 = line.match(/^\*\*\[\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\s*([^:*]+):\*\*\s*(.*)$/)
      if (f3) match = { timestamp: f3[1], speaker: f3[2].trim(), rest: f3[3] }
    }

    // Format 4: **Speaker Name:** [00:00](url) text  (no inner parens around timestamp)
    if (!match) {
      const f4 = line.match(/^\*\*([^*:]+):\*\*\s*\[(\d+:\d+(?::\d+)?)\]\([^)]+\)\s*(.*)$/)
      if (f4) match = { speaker: f4[1].trim(), timestamp: f4[2], rest: f4[3] }
    }

    // Format 5: **Speaker Name** [(00:00)](url) text  (no colon in bold)
    if (!match) {
      const f5 = line.match(/^\*\*([^*]+)\*\*\s*\[\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\s*(.*)$/)
      if (f5) match = { speaker: f5[1].trim(), timestamp: f5[2], rest: f5[3] }
    }

    // Format 8: **[[00:00](url)] Speaker Name:** text
    if (!match) {
      const f8 = line.match(/^\*\*\[\[(\d+:\d+(?::\d+)?)\]\([^)]+\)\]\s*([^:*]+):\*\*\s*(.*)$/)
      if (f8) match = { timestamp: f8[1], speaker: f8[2].trim(), rest: f8[3] }
    }

    // Format 9: **[00:00](url) Speaker Name:** text  (timestamp link without extra brackets)
    if (!match) {
      const f9 = line.match(/^\*\*\[(\d+:\d+(?::\d+)?)\]\([^)]+\)\s*([^:*]+):\*\*\s*(.*)$/)
      if (f9) match = { timestamp: f9[1], speaker: f9[2].trim(), rest: f9[3] }
    }

    // Format 10: **Speaker Name** [00:00](url) text  (no colon, no inner parens)
    if (!match) {
      const f10 = line.match(/^\*\*([^*]+)\*\*\s*\[(\d+:\d+(?::\d+)?)\]\([^)]+\)\s*(.*)$/)
      if (f10) match = { speaker: f10[1].trim(), timestamp: f10[2], rest: f10[3] }
    }

    // Format 7: **Speaker Name:** (00:00) text  (bare parens timestamp, no link)
    if (!match) {
      const f7 = line.match(/^\*\*([^*:]+):\*\*\s*\((\d+:\d+(?::\d+)?)\)\s*(.*)$/)
      if (f7) match = { speaker: f7[1].trim(), timestamp: f7[2], rest: f7[3] }
    }

    // Format 11: **[00:00]** text  (solo episode — timestamp only, no speaker name)
    if (!match) {
      const f11 = line.match(/^\*\*\[(\d+:\d+(?::\d+)?)\]\*\*\s*(.*)$/)
      if (f11) match = { speaker: OWNER_CONFIG.displayName, timestamp: f11[1], rest: f11[2] }
    }

    // Format 12: **[(00:00)](url)** text  (solo episode with linked timestamp)
    if (!match) {
      const f12 = line.match(/^\*\*\[\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\*\*\s*(.*)$/)
      if (f12) match = { speaker: OWNER_CONFIG.displayName, timestamp: f12[1], rest: f12[2] }
    }

    // Format 13: **Speaker Name [(00:00)](url)** text  (bold wraps name + timestamp link)
    if (!match) {
      const f13 = line.match(/^\*\*([^[*]+)\s*\[\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\*\*\s*(.*)$/)
      if (f13) match = { speaker: f13[1].trim(), timestamp: f13[2], rest: f13[3] }
    }

    // Format 14: **Speaker Name [00:00](url)** text  (bold wraps name + timestamp, no inner parens)
    if (!match) {
      const f14 = line.match(/^\*\*([^[*]+)\s*\[(\d+:\d+(?::\d+)?)\]\([^)]+\)\*\*\s*(.*)$/)
      if (f14) match = { speaker: f14[1].trim(), timestamp: f14[2], rest: f14[3] }
    }

    // Format 15: [Speaker Name](url) text  (plain link with speaker name, no bold)
    if (!match) {
      const f15 = line.match(/^\[([A-Z][a-zA-Zé' -]+)\]\([^)]+\)\s*(.*)$/)
      if (f15) match = { speaker: f15[1].trim(), timestamp: '', rest: f15[2] }
    }

    // Format 16: **[Speaker Name](url):** text  (bold link with colon)
    if (!match) {
      const f16 = line.match(/^\*\*\[([A-Z][a-zA-Zé' -]+)\]\([^)]+\):\*\*\s*(.*)$/)
      if (f16) match = { speaker: f16[1].trim(), timestamp: '', rest: f16[2] }
    }

    // Format 17: **[Speaker Name](url) (ts)** text  (bold link with parens timestamp)
    if (!match) {
      const f17 = line.match(/^\*\*\[([A-Z][a-zA-Zé' -]+)\]\([^)]+\)\s*\((\d+:\d+(?::\d+)?)\)\*\*\s*(.*)$/)
      if (f17) match = { speaker: f17[1].trim(), timestamp: f17[2], rest: f17[3] }
    }

    // Format 18: **[Speaker Name](url)**  (bold link, no timestamp, text on next line)
    if (!match) {
      const f18 = line.match(/^\*\*\[([A-Z][a-zA-Zé' -]+)\]\([^)]+\)\*\*\s*$/)
      if (f18) match = { speaker: f18[1].trim(), timestamp: '', rest: '' }
    }

    // Format 19: **Speaker Name**: text  (colon OUTSIDE bold, no timestamp)
    // e.g. **Jane Doe**: Some text here...
    if (!match) {
      const f19 = line.match(/^\*\*([^*]+)\*\*:\s+(.+)$/)
      if (f19) {
        const name = f19[1].trim()
        if (name.match(/^(speaker_?\d+|[A-Z][a-zA-Zé'-]+(\s+[A-Za-zé'-]+){0,4}(\s*[-–]\s*\w+)?)$/)) {
          match = { speaker: name, timestamp: '', rest: f19[2] }
        }
      }
    }

    // Format 20: **Speaker Name** ([00:00](url)) text  (paren-wrapped timestamp link, no colon)
    // e.g. **Jane Doe** ([0:00](https://youtube.com/watch?v=xxx&t=0))
    if (!match) {
      const f20 = line.match(/^\*\*([^*]+)\*\*\s*\(\[(\d+:\d+(?::\d+)?)\]\([^)]+\)\)\s*(.*)$/)
      if (f20) match = { speaker: f20[1].trim(), timestamp: f20[2], rest: f20[3] }
    }

    // Format 21: Speaker Name [(00:00)](url) text  (unbolded name + linked timestamp)
    // e.g. Yoko Li [(0:00)](https://www.youtube.com/watch?v=uxbfIgBpCAE&t=0s)
    if (!match) {
      const f21 = line.match(/^([A-Z][a-zA-Zé' .-]+?)\s+\[\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\s*(.*)$/)
      if (f21) {
        const name = f21[1].trim()
        // Same name validation as Format 6 to avoid false positives on prose lines
        if (name.match(/^(speaker_?\d+|[A-Z][a-zA-Zé'-]+(\s+[A-Za-zé'-]+){0,4}(\s*[-–]\s*\w+)?)$/)) {
          match = { speaker: name, timestamp: f21[2], rest: f21[3] }
        }
      }
    }

    // Format 22: [**Speaker Name** (00:00)](url) text  (bold name inside link brackets)
    // e.g. [**Jane Doe** (0:00)](https://www.youtube.com/watch?v=395Aa3otZe8&t=0s)
    if (!match) {
      const f22 = line.match(/^\[\*\*([^*]+)\*\*\s*\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\s*(.*)$/)
      if (f22) match = { speaker: f22[1].trim(), timestamp: f22[2], rest: f22[3] }
    }

    // Format 23: Speaker Name (00:00)  (bare name + paren timestamp, text on next line)
    // e.g. Jungwon Byun (0:00)
    if (!match) {
      const f23 = line.match(/^([A-Z][a-zA-Zé' .-]+?)\s+\((\d+:\d+(?::\d+)?)\)\s*$/)
      if (f23) {
        const name = f23[1].trim()
        if (name.match(/^(speaker_?\d+|[A-Z][a-zA-Zé'-]+(\s+[A-Za-zé'-]+){0,4}(\s*[-–]\s*\w+)?)$/)) {
          match = { speaker: name, timestamp: f23[2], rest: '' }
        }
      }
    }

    // Format 24: [Speaker Name (00:00)](url) text  (name+timestamp inside link brackets, no bold)
    // e.g. [Jane Doe (0:00)](https://www.youtube.com/watch?v=Kr3vNRHE-Fo&t=0s)
    if (!match) {
      const f24 = line.match(/^\[([A-Z][a-zA-Zé' .-]+?)\s+\((\d+:\d+(?::\d+)?)\)\]\([^)]+\)\s*(.*)$/)
      if (f24) {
        const name = f24[1].trim()
        if (name.match(/^(speaker_?\d+|[A-Z][a-zA-Zé'-]+(\s+[A-Za-zé'-]+){0,4}(\s*[-–]\s*\w+)?)$/)) {
          match = { speaker: name, timestamp: f24[2], rest: f24[3] }
        }
      }
    }

    // Format 25: **[Speaker Name](url)**: text  (bold link with colon OUTSIDE bold, no displayed timestamp)
    // e.g. **[Jane Doe](https://www.youtube.com/watch?v=-2NpyIkDuAc&t=0s)**:
    if (!match) {
      const f25 = line.match(/^\*\*\[([A-Z][a-zA-Zé' -]+)\]\([^)]+\)\*\*:\s*(.*)$/)
      if (f25) match = { speaker: f25[1].trim(), timestamp: '', rest: f25[2] }
    }

    // Format 6: **Speaker Name:** text  (no timestamp — must be last to avoid false positives)
    // Only match if speaker name looks like a person name (1-4 capitalized words, or speaker_N)
    if (!match) {
      const f6 = line.match(/^\*\*([^*:]+):\*\*\s+(.+)$/)
      if (f6) {
        const name = f6[1].trim()
        // Accept: "Jane Doe", "John Smith", "speaker_0", "Sponsor", "Sponsor - Google"
        if (name.match(/^(speaker_?\d+|[A-Z][a-zA-Zé'-]+(\s+[A-Za-zé'-]+){0,4}(\s*[-–]\s*\w+)?)$/)) {
          match = { speaker: name, timestamp: '', rest: f6[2] }
        }
      }
    }

    if (match) {
      // Save previous turn
      if (currentSpeaker && currentText.length > 0) {
        turns.push({
          speaker: currentSpeaker,
          text: currentText.join(' ').trim(),
          timestamp: currentTimestamp
        })
      }
      currentSpeaker = match.speaker
      currentTimestamp = match.timestamp
      currentText = match.rest ? [match.rest] : []
    } else if (currentSpeaker && line.trim()) {
      // Continue adding text to current speaker's turn
      currentText.push(line.trim())
    }
  }

  // Don't forget the last turn
  if (currentSpeaker && currentText.length > 0) {
    turns.push({
      speaker: currentSpeaker,
      text: currentText.join(' ').trim(),
      timestamp: currentTimestamp
    })
  }

  // Narrative fallback: if no speaker labels were found at all, treat the
  // entire body as a single the owner monologue. Solo episodes (keynotes, AMAs,
  // personal updates, scouting reports) often have no speaker labels because
  // there's only one speaker. Without this fallback the body is dropped.
  if (turns.length === 0) {
    const body: string[] = []
    let inFm = false
    let fmDone = false
    let seen = false
    let inLoose = true
    for (const line of lines) {
      if (line.trim() === '---') {
        if (!fmDone) {
          if (!seen || inFm) { inFm = !inFm; if (!inFm) fmDone = true; inLoose = false }
          else { fmDone = true }
        }
        continue
      }
      if (inFm) continue
      if (line.trim()) seen = true
      if (inLoose) {
        if (line.match(/^(url|title|youtube_url|youtube_id|ghost_slug|description|audio_url|hosts|guests|transcription_date|source|deepgram_id|diarized|timestamps):/)) continue
        if (line.trim() === '') continue
        inLoose = false
      }
      if (line.startsWith('#')) continue
      if (line.trim().startsWith('*This transcript is automatically generated')) continue
      body.push(line)
    }
    const narrativeText = body.join('\n').trim()
    if (narrativeText.length >= 1000) {
      turns.push({
        speaker: OWNER_CONFIG.displayName,
        text: narrativeText,
        timestamp: '0:00'
      })
    }
  }

  return turns
}

// Utility: slugify a name for use as ID
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Create a person ID that prevents contamination from single-word names.
 *
 * The problem: "John <john@acme.com>" and "John <john@gmail.com>" both
 * created the same person ID "john", causing 10+ different people to merge.
 *
 * Solution: Include domain for single-word names to ensure uniqueness.
 * - "John Smith <js@acme.com>" → "john-smith" (full names are unique enough)
 * - "John <john@acme.com>" → "john-acme" (single-word needs domain)
 * - "<john@bigcorp.com>" (no display name) → "john-bigcorp"
 */
function createPersonId(displayName: string | undefined, email: string): string {
  const hasFullName = displayName && displayName.trim().includes(' ')

  if (hasFullName) {
    // Full names are unique enough: "John Smith" → "john-smith"
    return slugify(displayName.trim())
  }

  // Single-word name or no display name: include domain for uniqueness
  const localPart = email.split('@')[0] || 'unknown'
  const domain = email.split('@')[1] || 'unknown'
  const domainSlug = domain.split('.')[0]  // "acme" from "acme.com"

  const name = displayName?.trim() || localPart
  return slugify(`${name}-${domainSlug}`)
}

/**
 * Create a person ID for sources without email (calls, beeper, podcast).
 * Uses source-specific suffixes to prevent name collisions across sources.
 */
function createSourcePersonId(displayName: string, source: 'calls' | 'beeper' | 'podcast' | 'groupme', contextId: string): string {
  const hasFullName = displayName && displayName.trim().includes(' ')

  if (hasFullName) {
    // Full names are unique enough across sources
    return slugify(displayName.trim())
  }

  // Single-word name: add source-specific suffix
  // For calls: use a hash of the Fireflies ID or 'calls' marker
  // For beeper: use network abbreviation
  // For podcast: use 'podcast' marker (guests are usually unique)
  const suffix = contextId ? slugify(contextId).slice(0, 10) : source
  return slugify(`${displayName.trim()}-${suffix}`)
}

async function cmdEnrich(args: ParsedArgs): Promise<void> {
  const limit = args.flags.limit as number | undefined
  const sourceFilter = args.flags.source as string | undefined
  // --extracted-since is a deprecated alias for --from. It used to filter on threads.extracted_at,
  // which is only set on insert, so new replies in existing threads were silently skipped.
  const extractedSince = args.flags['extracted-since'] as string | undefined
  const fromDate = (args.flags.from as string | undefined)
    ?? extractedSince?.replace('T', ' ').replace('Z', '').replace(/\.\d+$/, '')
  const toDate = args.flags.to as string | undefined
  const dryRun = args.flags['dry-run']
  const debug = args.flags.debug

  // Enrichment is optional: everything else (extract, keyword query, todo, export)
  // works without it. Skip cleanly instead of failing every batch when no key is set.
  if (!dryRun) {
    const env = await load_env()
    if (!(env.GEMINI_API_KEY || process.env.GEMINI_API_KEY)) {
      console.log('Enrichment skipped: no GEMINI_API_KEY in tools/.env (enrichment is optional).')
      console.log('Add one from https://aistudio.google.com/apikey to enable quality/authorship/topic metadata.')
      return
    }
  }
  if (extractedSince && !args.flags.from) {
    console.warn('Note: --extracted-since is deprecated; treating it as --from (threads active since that date).')
  }

  const db = getDb()

  // First, get list of already-enriched message IDs for efficient filtering
  const enrichedIds = new Set(
    (db.query(`SELECT message_id FROM message_metadata`).all() as { message_id: string }[])
      .map(r => r.message_id)
  )
  console.log(`Already enriched: ${formatNumber(enrichedIds.size)} messages`)

  // Find threads where the owner has at least one unenriched message.
  // Optimized: Use a single SQL query to find threads with unenriched messages
  // This avoids O(n) queries by joining with messages and checking enrichment status in SQL
  let optimizedQuery = `
    SELECT t.id as thread_id, t.source, t.title, t.subject,
           t.message_count as total_messages,
           t.my_message_count,
           t.last_activity_at,
           COUNT(m.id) as unenriched_count
    FROM threads t
    JOIN messages m ON m.thread_id = t.id AND m.is_from_me = 1
    LEFT JOIN message_metadata mm ON m.id = mm.message_id
    WHERE t.my_message_count > 0
      AND mm.message_id IS NULL
  `
  const optimizedParams: any[] = []

  if (sourceFilter) {
    optimizedQuery += ` AND t.source = ?`
    optimizedParams.push(sourceFilter)
  }

  if (fromDate) {
    optimizedQuery += ` AND t.last_activity_at >= ?`
    optimizedParams.push(fromDate)
  }

  if (toDate) {
    optimizedQuery += ` AND t.last_activity_at < ?`
    optimizedParams.push(toDate)
  }

  optimizedQuery += ` GROUP BY t.id ORDER BY t.last_activity_at DESC`

  if (limit) {
    optimizedQuery += ` LIMIT ?`
    optimizedParams.push(limit)
  }

  const threadsToEnrich = db.query(optimizedQuery).all(...optimizedParams) as Array<{
    thread_id: string
    source: string
    title: string | null
    subject: string | null
    total_messages: number
    my_message_count: number
    last_activity_at: string
    unenriched_count: number
  }>

  if (threadsToEnrich.length === 0) {
    console.log('All threads are already enriched!')
    db.close()
    return
  }

  const totalUnenriched = threadsToEnrich.reduce((sum, t) => sum + t.unenriched_count, 0)
  console.log(`Found ${formatNumber(threadsToEnrich.length)} threads with ${formatNumber(totalUnenriched)} messages to enrich`)
  if (sourceFilter) console.log(`  Source filter: ${sourceFilter}`)
  if (dryRun) console.log(`  [DRY RUN]`)
  if (debug) console.log(`  [DEBUG MODE - saving prompts/responses]`)

  // Process threads
  let threadsProcessed = 0
  let messagesEnriched = 0
  let totalPromptTokens = 0
  let totalOutputTokens = 0

  // Rate limiting: 700K tokens/min (70% of Gemini 1M limit)
  const TOKEN_BUDGET_PER_MIN = 700_000
  let windowStart = Date.now()
  let windowTokens = 0

  for (const thread of threadsToEnrich) {
    console.log(`\nProcessing: ${thread.title || thread.subject || thread.thread_id}`)
    console.log(`  ${thread.total_messages} messages, ${thread.unenriched_count} to enrich`)

    try {
      const result = await enrichThread(db, thread.thread_id, { dryRun: !!dryRun, debug: !!debug })
      messagesEnriched += result.messagesEnriched
      totalPromptTokens += result.promptTokens
      totalOutputTokens += result.outputTokens
      threadsProcessed++

      // Rate limiting
      const callTokens = result.promptTokens + result.outputTokens
      windowTokens += callTokens
      const elapsed = Date.now() - windowStart
      if (elapsed >= 60_000) {
        windowStart = Date.now()
        windowTokens = callTokens
      } else if (windowTokens >= TOKEN_BUDGET_PER_MIN) {
        const waitMs = 60_000 - elapsed + 2_000
        console.log(`  Rate limit: ${formatNumber(windowTokens)} tokens in ${(elapsed / 1000).toFixed(0)}s, pausing ${(waitMs / 1000).toFixed(0)}s...`)
        await Bun.sleep(waitMs)
        windowStart = Date.now()
        windowTokens = 0
      }
    } catch (err) {
      console.error(`  Error: ${(err as Error).message}`)
    }
  }

  db.close()

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`ENRICHMENT COMPLETE`)
  console.log(`${'═'.repeat(60)}`)
  console.log(`Threads processed: ${formatNumber(threadsProcessed)}`)
  console.log(`Messages enriched: ${formatNumber(messagesEnriched)}`)
  console.log(`Tokens used: ${formatNumber(totalPromptTokens)} in, ${formatNumber(totalOutputTokens)} out`)
}

// ============================================================
// THREAD-BASED ENRICHMENT
// ============================================================

interface EnrichmentResult {
  messagesEnriched: number
  promptTokens: number
  outputTokens: number
}

async function enrichThread(
  db: Database,
  threadId: string,
  opts: { dryRun: boolean; debug: boolean }
): Promise<EnrichmentResult> {
  // Get thread info first to check source
  const thread = db.query(`
    SELECT source, title, subject, thread_type, participant_ids
    FROM threads WHERE id = ?
  `).get(threadId) as { source: string; title: string | null; subject: string | null; thread_type: string; participant_ids: string | null }

  // Get participant names for context (helps with entity recognition)
  let participantNames: string[] = []
  if (thread.participant_ids) {
    try {
      const participantIds = JSON.parse(thread.participant_ids) as string[]
      const names = db.query(`
        SELECT display_name FROM people WHERE id IN (${participantIds.map(() => '?').join(',')})
      `).all(...participantIds) as Array<{ display_name: string }>
      participantNames = names.map(n => n.display_name).filter(n => n && n !== OWNER_CONFIG.displayName)
    } catch {}
  }
  // Fallback: extract from title (e.g., "Owner Name / Guest Name" -> "Guest Name")
  if (participantNames.length === 0 && thread.title) {
    const titleParts = thread.title.split(/\s*[-\/]\s*/).filter(p => !p.toLowerCase().includes(OWNER_CONFIG.displayName.split(' ')[0].toLowerCase()))
    participantNames = titleParts.map(p => p.trim()).filter(p => p.length > 0)
  }

  let allMessages: Array<{
    id: string
    content: string
    timestamp: string
    is_from_me: number
    position_in_thread: number
    content_type: string
    word_count: number
    sender_name: string | null
  }>

  // Get all messages in the thread (Twitter threads are now properly grouped)
  allMessages = db.query(`
    SELECT m.id, m.content, m.timestamp, m.is_from_me, m.position_in_thread,
           m.content_type, m.word_count,
           p.display_name as sender_name
    FROM messages m
    LEFT JOIN people p ON m.sender_id = p.id
    WHERE m.thread_id = ?
    ORDER BY m.position_in_thread ASC, m.timestamp ASC
  `).all(threadId) as typeof allMessages

  // Find the owner's messages that need enrichment. Skip rows already enriched by the
  // current model — without this every run restarted the thread at batch 1, so an
  // interrupted pass over a big thread re-did the same early batches forever.
  // Rows from older models are still redone.
  const currentModelIds = new Set(
    (db.query(`
      SELECT mm.message_id FROM message_metadata mm
      JOIN messages m ON m.id = mm.message_id
      WHERE m.thread_id = ? AND mm.processor_model = ?
    `).all(threadId, enrichModel()) as { message_id: string }[]).map(r => r.message_id)
  )
  const ownerMessages = allMessages.filter(m => m.is_from_me === 1 && !currentModelIds.has(m.id))
  const unenrichedIds = ownerMessages.map(m => m.id)

  if (unenrichedIds.length === 0) {
    return { messagesEnriched: 0, promptTokens: 0, outputTokens: 0 }
  }

  // Build the prompt with full thread context. Only the current batch's messages get
  // [MSG n] markers (short indexes — long IDs were frequently mis-transcribed by models);
  // everything else is context.
  const renderMessage = (m: typeof allMessages[number], batchIndex: Map<string, number>) => {
    let sender: string
    if (m.is_from_me) {
      sender = OWNER_CONFIG.displayName.split(' ')[0]
    } else if (m.sender_name) {
      // Clean up generic names
      if (m.sender_name.startsWith('Twitter User ')) {
        const userId = m.sender_name.replace('Twitter User ', '')
        sender = `@[${userId}]`  // Format as @[id] to indicate unknown handle
      } else {
        sender = m.sender_name
      }
    } else {
      sender = 'Other'
    }
    const prefix = batchIndex.has(m.id) ? `[MSG ${batchIndex.get(m.id)}]\n` : ''
    return `${prefix}${sender} (${m.timestamp.split('T')[0]}):\n${m.content}`
  }

  // Very large threads (25K+ messages) blew past Gemini's 1,048,576-token input cap when
  // the whole thread was sent as context for every batch — every batch 400'd, so the thread
  // never enriched and permanently blocked the head of the enrichment queue. Above a char
  // budget we send a window centred on the batch instead: the batch's own messages always,
  // plus as much surrounding conversation as fits. Below the budget, behaviour is unchanged.
  const CONTEXT_CHAR_BUDGET = 400_000 // ~100K tokens: hundreds of surrounding messages, far under the 1M cap
  const msgChars = (m: typeof allMessages[number]) => (m.content?.length ?? 0) + 60
  const totalContextChars = allMessages.reduce((n, m) => n + msgChars(m), 0)

  const buildContext = (batchIndex: Map<string, number>) => {
    let window = allMessages
    if (totalContextChars > CONTEXT_CHAR_BUDGET) {
      const batchPositions = allMessages.reduce<number[]>((acc, m, i) => {
        if (batchIndex.has(m.id)) acc.push(i)
        return acc
      }, [])
      let lo = batchPositions.length > 0 ? batchPositions[0] : 0
      let hi = batchPositions.length > 0 ? batchPositions[batchPositions.length - 1] : 0
      let used = allMessages.slice(lo, hi + 1).reduce((n, m) => n + msgChars(m), 0)
      while (used < CONTEXT_CHAR_BUDGET && (lo > 0 || hi < allMessages.length - 1)) {
        if (lo > 0) {
          const next = msgChars(allMessages[lo - 1])
          if (used + next > CONTEXT_CHAR_BUDGET) break
          used += next
          lo--
        }
        if (hi < allMessages.length - 1) {
          const next = msgChars(allMessages[hi + 1])
          if (used + next > CONTEXT_CHAR_BUDGET) break
          used += next
          hi++
        }
      }
      window = allMessages.slice(lo, hi + 1)
      console.log(`      Context windowed: ${window.length}/${allMessages.length} messages (thread exceeds token budget)`)
    }
    return window.map(m => renderMessage(m, batchIndex)).join('\n\n---\n\n')
  }

  // Batch size: consolidated schema (~100 tokens/msg output) allows large batches
  // Gemini 3 Flash supports large outputs, 100 messages should fit easily
  const MAX_MESSAGES_PER_BATCH = 100
  const batches: string[][] = []
  for (let i = 0; i < unenrichedIds.length; i += MAX_MESSAGES_PER_BATCH) {
    batches.push(unenrichedIds.slice(i, i + MAX_MESSAGES_PER_BATCH))
  }

  if (opts.dryRun) {
    console.log(`  [DRY RUN] Would enrich ${unenrichedIds.length} messages in ${batches.length} batch(es)`)
    return { messagesEnriched: 0, promptTokens: 0, outputTokens: 0 }
  }

  let totalPromptTokens = 0
  let totalOutputTokens = 0
  let enriched = 0

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batchIds = batches[batchIdx]
    if (batches.length > 1) {
      console.log(`    Batch ${batchIdx + 1}/${batches.length} (${batchIds.length} messages)`)
    }

    const batchIndex = new Map(batchIds.map((id, i) => [id, i + 1]))
    const threadContext = buildContext(batchIndex)
    const schema = buildThreadEnrichmentSchema(batchIds)
    const prompt = buildEnrichmentPrompt(thread, threadContext, batchIds, participantNames)

    if (opts.debug) {
      const debugDir = join(DATA_DIR, 'debug')
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      await Bun.write(join(debugDir, `enrich_${timestamp}_prompt.txt`), prompt)
      await Bun.write(join(debugDir, `enrich_${timestamp}_schema.json`), JSON.stringify(schema, null, 2))
    }

    // Call Gemini with structured output
    const geminiPath = join(PROJECT_ROOT, 'tools/gemini.ts')
    // Per-process + per-batch path: a fixed shared filename meant two concurrent
    // enrich runs (e.g. the 3x-daily cron overlapping a manual backlog pass) would
    // overwrite each other's schema mid-flight and silently mis-enrich.
    const schemaPath = join(DATA_DIR, 'debug', `_temp_schema.${process.pid}.${batchIdx}.json`)
    await Bun.write(schemaPath, JSON.stringify(schema))

    // Retry loop: Gemini Flash models intermittently truncate structured output
    // mid-object (a hard cut well under --max-tokens, not a natural stop); the identical
    // prompt succeeds on retry. Without this a single bad batch threw and discarded the
    // whole thread's work, so scheduled runs reported "0 enriched" while still exiting 0.
    const MAX_ATTEMPTS = 3
    let batchResponse: any = null
    let lastErr = ''
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const proc = Bun.spawn({
        cmd: [process.execPath, geminiPath, '-m', enrichModel(), '--schema', schemaPath, '--max-tokens', '65536', '-t', '0.3', '--no-stream'],
        stdin: new Blob([prompt]),
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        lastErr = `Gemini error (batch ${batchIdx + 1}): ${stderr}`
        if (attempt < MAX_ATTEMPTS) {
          console.log(`      Attempt ${attempt}/${MAX_ATTEMPTS} failed (exit ${exitCode}), retrying...`)
          continue
        }
        try { unlinkSync(schemaPath) } catch { /* already gone — fine */ }
        throw new Error(lastErr)
      }

      if (opts.debug) {
        const debugDir = join(DATA_DIR, 'debug')
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        await Bun.write(join(debugDir, `enrich_${timestamp}_response.txt`), stdout)
      }

      // Parse JSON response
      const jsonStart = stdout.indexOf('{')
      const jsonEnd = stdout.lastIndexOf('}')
      try {
        if (jsonStart === -1 || jsonEnd === -1) throw new Error('No JSON found in response')
        batchResponse = JSON.parse(stdout.slice(jsonStart, jsonEnd + 1))
      } catch (e) {
        batchResponse = null
        lastErr = `Batch ${batchIdx + 1} parse failure: ${e instanceof Error ? e.message : String(e)}`
        if (attempt < MAX_ATTEMPTS) {
          console.log(`      Attempt ${attempt}/${MAX_ATTEMPTS} returned truncated/invalid JSON, retrying...`)
          continue
        }
        try { unlinkSync(schemaPath) } catch { /* already gone — fine */ }
        throw new Error(lastErr)
      }

      // v2 schema returns msg_index (1-based within this batch); map back to the real ID.
      for (const mm of batchResponse.messages ?? []) {
        const idx = Number(mm.msg_index)
        mm.message_id = batchIds[idx - 1] ?? `bad-index:${mm.msg_index}`
      }

      // Only count tokens for the attempt whose output we actually keep.
      const tokenMatch = stderr.match(/Tokens:\s*(\d+)\s*in,\s*(\d+)\s*out/)
      if (tokenMatch) {
        totalPromptTokens += parseInt(tokenMatch[1], 10)
        totalOutputTokens += parseInt(tokenMatch[2], 10)
      }
      break
    }

    // Unique-per-batch schema files would otherwise pile up in debug/.
    try { unlinkSync(schemaPath) } catch { /* already gone — fine */ }

    // Write this batch's rows now. A 66-batch thread used to hold everything in memory
    // and write once at the end — an OOM kill at batch 39 (2026-09-10) lost all of it.
    enriched += storeBatch(batchResponse)
  }

  // Use token counts from batches
  const promptTokens = totalPromptTokens
  const outputTokens = totalOutputTokens

  function storeBatch(response: { messages: any[] }): number {
    let n = 0
    for (const msgMeta of response.messages ?? []) {
    if (!unenrichedIds.includes(msgMeta.message_id)) {
      console.warn(`  Warning: Unexpected message_id ${msgMeta.message_id}`)
      continue
    }

    // Explicit column list: works on both new (slim) and older (wider) message_metadata tables.
    db.query(`
      INSERT OR REPLACE INTO message_metadata (
        message_id, quality_score, authorship_score, originality_score,
        topics, entities, processed_at, processor_model
      ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `).run(
      msgMeta.message_id,
      msgMeta.quality_score ?? null,
      msgMeta.authorship_score ?? null,
      msgMeta.originality_score ?? null,
      msgMeta.topics ? JSON.stringify(msgMeta.topics) : null,
      msgMeta.entities ? JSON.stringify(msgMeta.entities) : null,
      enrichModel()
    )

    n++
    }
    return n
  }

  console.log(`  Enriched ${enriched} messages (${promptTokens} in, ${outputTokens} out tokens)`)
  return { messagesEnriched: enriched, promptTokens, outputTokens }
}

// Enrichment model + prompt/schema v2 (2026-09). The default was chosen by a two-round
// blind bake-off of several fast models on entity grounding, calibration and coverage.
// v2 changes vs v1: [MSG n] indexes instead of raw IDs, explicit entity-grounding rule,
// integer 1-7 scores with a "use the full range" instruction, topic-tag consistency.
// Override with DEEP_CONTEXT_ENRICH_MODEL or config.json "enrichment.model" (any Gemini model
// id tools/gemini.ts accepts). Rows carry the model in message_metadata.processor_model, so
// switching models makes previously-enriched messages eligible again.
const DEFAULT_ENRICH_MODEL = 'gemini-3.7-flash'
function enrichModel(): string {
  return ENRICH_MODEL_RESOLVED ??= resolveEnrichModel()
}
let ENRICH_MODEL_RESOLVED: string | undefined
function resolveEnrichModel(): string {
  if (process.env.DEEP_CONTEXT_ENRICH_MODEL) return process.env.DEEP_CONTEXT_ENRICH_MODEL
  try {
    if (existsSync(CONFIG_PATH)) {
      const m = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))?.enrichment?.model
      // 'gemini-3-flash' was the original template placeholder (never a callable id) — ignore it.
      if (typeof m === 'string' && m && m !== 'gemini-3-flash') return m
    }
  } catch { /* fall through */ }
  return DEFAULT_ENRICH_MODEL
}

// Enrichment schema (2026-10 slim): only the fields something actually reads.
//   quality/originality -> extract-for-summary's low-quality + AI-written filters
//   authorship          -> "did the owner write this" (writing-sample curation, ad-hoc SQL)
//   topics/entities     -> the most-queried descriptive fields
// Older DBs may still carry domain/sentiment/engagement/actionability/style_tags/
// thread_role/relationship_dynamic (and threads.enriched_*). They are left in place
// and simply no longer written.
function buildThreadEnrichmentSchema(_messageIds: string[]): object {
  return {
    type: "object",
    required: ["messages"],
    properties: {
      messages: {
        type: "array",
        description: "One entry per [MSG n] marker, in order",
        items: {
          type: "object",
          required: ["msg_index", "quality_score", "authorship_score", "originality_score", "topics", "entities"],
          properties: {
            msg_index: { type: "integer", description: "The n from the [MSG n] marker" },
            quality_score: { type: "integer", description: "Overall quality 1-7 (whole number): voice, insight, craft. 1=filler, 4=solid, 7=exceptional" },
            authorship_score: { type: "number", description: "Confidence 0-1 that the owner wrote this themselves (vs quoted/forwarded/pasted/LLM-generated text)" },
            originality_score: { type: "integer", description: "Intellectual originality 1-7 (whole number): 1=common wisdom, 4=thoughtful, 7=unique insight" },
            topics: { type: "array", items: { type: "string" }, description: "1-3 lowercase topic tags; reuse the same tag for the same concept across messages" },
            entities: { type: "array", items: { type: "string" }, description: "Named people, companies, products that appear in THIS message's own text. Empty array if none." }
          }
        }
      }
    }
  }
}

function buildEnrichmentPrompt(
  thread: { source: string; title: string | null; subject: string | null; thread_type: string },
  threadContext: string,
  messageIds: string[],
  participantNames: string[] = []
): string {
  const n = messageIds.length
  const owner = OWNER_CONFIG.displayName.split(' ')[0]
  const participantContext = participantNames.length > 0
    ? `\nParticipants (other than the owner): ${participantNames.join(', ')}\nNOTE: The transcript may have spelling errors for names. Use the participant names above for entity extraction.`
    : ''

  return `You are analyzing a ${thread.source} conversation to generate metadata about the owner's messages.

THREAD CONTEXT:
Source: ${thread.source}
Title/Subject: ${thread.title || thread.subject || '(none)'}
Type: ${thread.thread_type}${participantContext}

The conversation is shown below. The owner (${owner}) has messages to analyze marked [MSG n] at the start; other messages (from other people, or the owner's messages outside the analysis window) have no marker and are context only.
Return one metadata entry per [MSG n] marker, using that n as msg_index. Return exactly ${n} entries.

SCORING GUIDELINES:
1. quality_score (1-7, whole number): overall quality — voice, insight, craft. 1=filler ("ok", "thanks"), 4=solid, 7=exceptional. Use the full range: the thread's best message should earn a 6 or 7 and pure filler a 1 or 2.
2. authorship_score (0-1): confidence the owner wrote this themselves. Lower it for quoted text, forwarded content, pasted links/articles, boilerplate, or LLM-sounding prose.
3. originality_score (1-7, whole number): intellectual uniqueness. 1=common wisdom, 4=thoughtful, 7=few would say this.
4. topics: 1-3 lowercase tags, specific but not granular. REUSE the same tag for the same concept across messages (e.g. always "project scheduling", not "scheduling"/"project booking"/"scheduling confirmation"). Do not put names of people/companies/products in topics — those go in entities.
5. entities: ONLY named people, companies, products, or organizations that appear in THIS message's own text (or an explicit @-mention / obvious nickname for a participant). Do NOT carry over entities from the thread title, from other people's messages, or from the owner's other messages. Do NOT list generic concepts ("AI", "agents", "startups"). An empty array is the correct answer for a message that names nothing.

CONVERSATION:
---
${threadContext}
---

Analyze the ${n} message(s) marked [MSG n] and return the structured metadata.`
}

async function cmdQuery(args: ParsedArgs): Promise<void> {
  const searchTerm = args.positional[0]

  if (!searchTerm) {
    console.error('Error: Search term required')
    console.error('Usage: deep-context query <search_term>')
    process.exit(1)
  }

  // Semantic / hybrid vector search takes a separate path (must open the
  // vector sidecar BEFORE the main DB — custom SQLite ordering requirement)
  if (args.flags.semantic || args.flags.hybrid) {
    await runSemanticQuery(searchTerm, args)
    return
  }

  const sourceFilter = args.flags.source as string | undefined
  const fromDate = args.flags.from as string | undefined
  const toDate = args.flags.to as string | undefined
  const limit = (args.flags.limit as number) || 20

  const db = getDb()

  let query = `
    SELECT m.id, m.source, m.content, m.timestamp, m.is_from_me,
           t.subject, t.title
    FROM messages m
    JOIN threads t ON m.thread_id = t.id
    WHERE m.content LIKE ?
  `
  const params: any[] = [`%${searchTerm}%`]

  if (sourceFilter) {
    query += ` AND m.source = ?`
    params.push(sourceFilter)
  }
  if (fromDate) {
    query += ` AND m.timestamp >= ?`
    params.push(fromDate)
  }
  if (toDate) {
    query += ` AND m.timestamp <= ?`
    params.push(toDate)
  }

  query += ` ORDER BY m.timestamp DESC LIMIT ?`
  params.push(limit)

  const results = db.query(query).all(...params) as any[]
  db.close()

  console.log(`Found ${results.length} messages matching "${searchTerm}":\n`)

  for (const r of results) {
    const direction = r.is_from_me ? '→' : '←'
    const context = r.subject || r.title || ''
    console.log(`${direction} [${r.source}] ${r.timestamp}`)
    if (context) console.log(`  ${context}`)
    const preview = r.content.substring(0, 200).replace(/\n/g, ' ')
    console.log(`  ${preview}${r.content.length > 200 ? '...' : ''}`)
    console.log()
  }
}

async function cmdRecent(args: ParsedArgs): Promise<void> {
  const hours = args.flags.hours ? parseInt(args.flags.hours as string, 10) : 24
  const sourceFilter = args.flags.source as string | undefined
  const limit = (args.flags.limit as number) || 30

  const db = getDb()
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()

  let query = `
    SELECT t.id, t.source, t.subject, t.title, t.last_activity_at,
           t.message_count, t.my_message_count, t.participant_ids, t.source_url
    FROM threads t
    WHERE t.last_activity_at >= ?
  `
  const params: any[] = [cutoff]

  if (sourceFilter) {
    query += ` AND t.source = ?`
    params.push(sourceFilter)
  }

  query += ` ORDER BY t.last_activity_at DESC LIMIT ?`
  params.push(limit)

  const results = db.query(query).all(...params) as any[]
  db.close()

  console.log(`Recent threads (last ${hours}h): ${results.length} found\n`)

  for (const t of results) {
    const title = resolvePhonesInText(t.subject || t.title || '(no subject)')
    const participants = t.participant_ids ? JSON.parse(t.participant_ids).filter((p: string) => p !== OWNER_CONFIG.personId).map((p: string) => resolvePhonesInText(p, { compact: true })).join(', ') : ''
    const myMsgs = t.my_message_count > 0 ? ` (${t.my_message_count} from me)` : ' (inbound only)'
    console.log(`[${t.source}] ${t.last_activity_at}`)
    console.log(`  ${title}`)
    console.log(`  ${t.message_count} messages${myMsgs}${participants ? ` — with: ${participants}` : ''}`)
    if (t.source_url) console.log(`  ${t.source_url}`)
    console.log()
  }
}

async function cmdTodo(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[0]

  if (!subcommand) {
    console.error('Usage: deep-context todo <list|add|update|expire|recap|strategic>')
    process.exit(1)
  }

  const db = getDb()

  switch (subcommand) {
    case 'list': {
      const statusFilter = (args.flags.status as string) || 'pending,accepted'
      const categoryFilter = args.flags.category as string | undefined
      const limit = (args.flags.limit as number) || 50

      const statuses = statusFilter.split(',').map(s => s.trim())
      const placeholders = statuses.map(() => '?').join(',')

      let query = `SELECT * FROM todo_items WHERE status IN (${placeholders})`
      const params: any[] = [...statuses]

      if (categoryFilter) {
        query += ` AND category = ?`
        params.push(categoryFilter)
      }

      query += ` ORDER BY detected_at DESC LIMIT ?`
      params.push(limit)

      const items = db.query(query).all(...params) as any[]
      db.close()

      if (items.length === 0) {
        console.log('No TODO items found.')
        return
      }

      console.log(`TODO items (${items.length}):\n`)
      for (const item of items) {
        const age = Math.floor((Date.now() - new Date(item.detected_at).getTime()) / (1000 * 60 * 60 * 24))
        const dueStr = item.due_date ? ` (due: ${item.due_date})` : ''
        const personStr = item.related_person ? ` — ${resolvePhonesInText(item.related_person)}` : ''
        const statusIcon = item.status === 'accepted' ? '★' : item.status === 'pending' ? '○' : '✓'
        console.log(`${statusIcon} [${item.category}] ${resolvePhonesInText(item.title)}${dueStr}${personStr}`)
        console.log(`  ${item.source} | ${age}d ago | ${item.priority} | id: ${item.id.substring(0, 12)}`)
        if (item.context) console.log(`  ${item.context.substring(0, 150)}`)
        console.log()
      }
      break
    }

    case 'add': {
      const title = args.flags.title as string
      const category = args.flags.category as string
      const source = args.flags.source as string

      if (!title || !category || !source) {
        console.error('Usage: deep-context todo add --title "..." --category committed|incoming --source <source>')
        process.exit(1)
      }

      const normalizedTitle = title.toLowerCase().replace(/\s+/g, ' ').trim().substring(0, 100)

      // Use Bun's built-in hashing for deterministic ID
      const hasher = new Bun.CryptoHasher('sha256')
      hasher.update(`manual|${normalizedTitle}|${new Date().toISOString().split('T')[0]}`)
      const id = hasher.digest('hex').substring(0, 16)

      const result = db.query(`INSERT OR IGNORE INTO todo_items (id, category, title, context, source, source_message_id, source_thread_id, source_url, due_date, priority, related_person, tags, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
        id,
        category,
        title,
        (args.flags.context as string) || null,
        source,
        null, null, null,  // source_message_id/thread_id/url: kept in the schema, no longer set
        (args.flags.due as string) || null,
        (args.flags.priority as string) || 'normal',
        (args.flags['related-person'] as string) || null,
        (args.flags.tags as string) || null,
      )

      db.close()

      if (result.changes > 0) {
        console.log(`Added: [${category}] ${title} (id: ${id})`)
      } else {
        console.log(`Skipped (duplicate): ${title}`)
      }
      break
    }

    case 'update': {
      const id = args.positional[1]
      const status = args.flags.status as string

      if (!id || !status) {
        console.error('Usage: deep-context todo update <id> --status accepted|dismissed|completed')
        process.exit(1)
      }

      const updates: string[] = ['status = ?']
      const params: any[] = [status]
      if (status === 'completed') updates.push(`completed_at = datetime('now')`)
      if (status === 'dismissed' && args.flags.reason) {
        updates.push('dismissed_reason = ?')
        params.push(args.flags.reason as string)
      }

      // Support partial ID matching
      const result = db.query(`UPDATE todo_items SET ${updates.join(', ')} WHERE id LIKE ?`).run(...params, `${id}%`)
      db.close()

      if (result.changes > 0) {
        console.log(`Updated ${result.changes} item(s) to status: ${status}`)
      } else {
        console.log(`No items found matching id: ${id}`)
      }
      break
    }

    case 'expire': {
      // Soft auto-expiry for stale machine-detected INCOMING requests (never deletes rows).
      // An `incoming` item still `pending` after N days with no re-sighting (last_seen_at,
      // falling back to detected_at) and no future due date is flipped to status='expired'
      // with a dismissed_reason stamp. Reversible: `todo update <id> --status pending`.
      // `committed` items are never expired — those are the owner's own promises.
      const days = args.flags.days ? parseInt(String(args.flags.days), 10) : 30
      if (!Number.isFinite(days) || days < 1) {
        console.error('Usage: deep-context todo expire [--days N (default 30)] [--dry-run]')
        process.exit(1)
      }
      const where = `status = 'pending' AND category = 'incoming'
        AND COALESCE(last_seen_at, detected_at) < datetime('now', ?)
        AND (due_date IS NULL OR due_date = '' OR due_date < date('now'))`
      const cutoffArg = `-${days} days`
      const stale = db.query(`SELECT id, title, detected_at, related_person FROM todo_items WHERE ${where} ORDER BY detected_at ASC`).all(cutoffArg) as any[]
      if (args.flags['dry-run']) {
        console.log(`[dry-run] ${stale.length} pending incoming item(s) older than ${days}d would be marked expired:`)
        for (const i of stale.slice(0, 40)) console.log(`  ${String(i.detected_at).slice(0, 10)}  ${i.title}${i.related_person ? ' — ' + i.related_person : ''}  (${i.id.slice(0, 12)})`)
        if (stale.length > 40) console.log(`  … and ${stale.length - 40} more`)
        db.close()
        break
      }
      const res = db.query(`UPDATE todo_items SET status = 'expired',
          dismissed_reason = 'auto-expired ' || date('now') || ': incoming, no activity for ${days}d'
        WHERE ${where}`).run(cutoffArg)
      db.close()
      console.log(`Expired ${res.changes} stale incoming item(s) (>${days}d, no activity). Undo one: todo update <id> --status pending`)
      break
    }

    case 'recap': {
      const sinceHours = args.flags.since ? parseInt(args.flags.since as string, 10) : 24
      const cutoff = new Date(Date.now() - sinceHours * 60 * 60 * 1000).toISOString()

      const newItems = db.query(`
        SELECT * FROM todo_items WHERE detected_at >= ? ORDER BY category, detected_at DESC
      `).all(cutoff) as any[]

      const activeItems = db.query(`
        SELECT * FROM todo_items WHERE status = 'accepted' ORDER BY priority DESC, detected_at ASC
      `).all() as any[]

      db.close()

      const committed = newItems.filter(i => i.category === 'committed')
      const incoming = newItems.filter(i => i.category === 'incoming')

      console.log(`=== TODO Recap (last ${sinceHours}h) ===\n`)

      if (committed.length > 0) {
        console.log(`Committed (${committed.length}):`)
        for (const item of committed) {
          console.log(`  ○ ${resolvePhonesInText(item.title)} (${item.source}${item.related_person ? ', ' + resolvePhonesInText(item.related_person) : ''})`)
        }
        console.log()
      }

      if (incoming.length > 0) {
        console.log(`Incoming (${incoming.length}):`)
        for (const item of incoming) {
          console.log(`  ○ ${resolvePhonesInText(item.title)} (${item.source}${item.related_person ? ', from ' + resolvePhonesInText(item.related_person) : ''})`)
        }
        console.log()
      }

      if (newItems.length === 0) {
        console.log('No new items detected.\n')
      }

      if (activeItems.length > 0) {
        console.log(`Active accepted items (${activeItems.length}):`)
        for (const item of activeItems) {
          const age = Math.floor((Date.now() - new Date(item.detected_at).getTime()) / (1000 * 60 * 60 * 24))
          console.log(`  ★ [${age}d] ${resolvePhonesInText(item.title)}${item.related_person ? ' — ' + resolvePhonesInText(item.related_person) : ''}`)
        }
        console.log()
      }
      break
    }

    case 'strategic': {
      // Birds-eye analysis of TODO landscape
      const pending = db.query(`SELECT * FROM todo_items WHERE status = 'pending' ORDER BY detected_at ASC`).all() as any[]
      const accepted = db.query(`SELECT * FROM todo_items WHERE status = 'accepted' ORDER BY detected_at ASC`).all() as any[]
      const recentDismissed = db.query(`SELECT * FROM todo_items WHERE status = 'dismissed' ORDER BY detected_at DESC LIMIT 10`).all() as any[]
      const recentCompleted = db.query(`SELECT * FROM todo_items WHERE status = 'completed' ORDER BY completed_at DESC LIMIT 10`).all() as any[]

      db.close()

      console.log('=== Strategic TODO Overview ===\n')

      // Summary counts
      console.log(`Pending: ${pending.length} | Accepted: ${accepted.length} | Recent completed: ${recentCompleted.length}\n`)

      // Group by source
      const bySource: Record<string, any[]> = {}
      for (const item of [...pending, ...accepted]) {
        const src = item.source || 'unknown'
        if (!bySource[src]) bySource[src] = []
        bySource[src].push(item)
      }
      console.log('By source:')
      for (const [src, items] of Object.entries(bySource)) {
        console.log(`  ${src}: ${items.length} active items`)
      }
      console.log()

      // Group by related_person
      const byPerson: Record<string, any[]> = {}
      for (const item of [...pending, ...accepted]) {
        const person = item.related_person || '(unattributed)'
        if (!byPerson[person]) byPerson[person] = []
        byPerson[person].push(item)
      }
      if (Object.keys(byPerson).length > 1) {
        console.log('By person:')
        const sorted = Object.entries(byPerson).sort((a, b) => b[1].length - a[1].length)
        for (const [person, items] of sorted.slice(0, 10)) {
          console.log(`  ${person}: ${items.length} items`)
        }
        console.log()
      }

      // Stale items (pending > 7 days)
      const staleItems = pending.filter(i => {
        const age = (Date.now() - new Date(i.detected_at).getTime()) / (1000 * 60 * 60 * 24)
        return age > 7
      })
      if (staleItems.length > 0) {
        console.log(`Stale pending items (>7 days, need review): ${staleItems.length}`)
        for (const item of staleItems.slice(0, 5)) {
          const age = Math.floor((Date.now() - new Date(item.detected_at).getTime()) / (1000 * 60 * 60 * 24))
          console.log(`  [${age}d] ${item.title}`)
        }
        console.log()
      }

      // Category breakdown
      const committedCount = [...pending, ...accepted].filter(i => i.category === 'committed').length
      const incomingCount = [...pending, ...accepted].filter(i => i.category === 'incoming').length
      console.log(`Category split: ${committedCount} committed, ${incomingCount} incoming`)

      if (recentDismissed.length > 0) {
        console.log(`\nRecent dismissals (calibration):`)
        for (const item of recentDismissed.slice(0, 3)) {
          console.log(`  ✕ ${item.title}${item.dismissed_reason ? ' — reason: ' + item.dismissed_reason : ''}`)
        }
      }
      console.log()
      break
    }

    default:
      console.error(`Unknown todo subcommand: ${subcommand}`)
      console.error('Usage: deep-context todo <list|add|update|expire|recap|strategic>')
      process.exit(1)
  }
}

// ============================================================
// EXPORT-PUBLIC - Build a public-only DB (default: podcast + own tweets) with
// FTS5, and optionally scp it to another machine for low-access agents.
// ============================================================

// Public sources are the ONLY thing that leaves this machine. Keep this list
// tight — anything not here is private and must never be exported. Override in
// config.json: { "public_sources": ["twitter"] }
const DEFAULT_PUBLIC_SOURCES = ['podcast', 'twitter']

function publicSources(): string[] {
  try {
    if (existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      if (Array.isArray(cfg.public_sources) && cfg.public_sources.length > 0) return cfg.public_sources.map(String)
    }
  } catch { /* fall through to default */ }
  return DEFAULT_PUBLIC_SOURCES
}

async function cmdExportPublic(args: ParsedArgs): Promise<void> {
  const pushDest = typeof args.flags.push === 'string' ? (args.flags.push as string) : ''
  const PUBLIC_SOURCES = publicSources()
  const finalPath = (args.flags.output as string | undefined) || join(DATA_DIR, 'public_deep_context.db')
  const buildPath = `${finalPath}.building`

  if (!existsSync(DB_PATH)) {
    console.error(`Error: source DB not found at ${DB_PATH}`)
    process.exit(1)
  }

  console.log('=== Build public-only deep-context DB ===')
  console.log(`Sources: ${PUBLIC_SOURCES.join(', ')}`)

  // Build into a temp file, then atomically rename over the real one so a
  // half-built file is never shipped. No WAL on the build DB → the result is a
  // single self-contained .db file (no -wal/-shm sidecars to ship).
  const out = new Database(buildPath, { create: true })
  try {
    out.exec('PRAGMA busy_timeout = 30000')
    // Defensive: a stale build file from a crashed run may have old tables.
    out.exec(`
      DROP TABLE IF EXISTS messages_fts;
      DROP TABLE IF EXISTS messages;
      DROP TABLE IF EXISTS threads;
      DROP TABLE IF EXISTS meta;
    `)
    out.exec(`
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        source TEXT NOT NULL,
        content_type TEXT,
        timestamp DATETIME,
        position_in_thread INTEGER,
        sender TEXT,              -- denormalized display name (or sender_id fallback)
        is_from_me BOOLEAN,
        content TEXT NOT NULL,
        reply_to_message_id TEXT,
        quoted_content TEXT,
        word_count INTEGER
      );
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        source TEXT,
        title TEXT,
        source_url TEXT,
        thread_type TEXT,
        started_at DATETIME,
        last_activity_at DATETIME,
        message_count INTEGER
      );
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE INDEX idx_pub_msg_source ON messages(source);
      CREATE INDEX idx_pub_msg_thread ON messages(thread_id);
      CREATE INDEX idx_pub_msg_type ON messages(content_type);
      CREATE INDEX idx_pub_msg_time ON messages(timestamp DESC);
    `)

    // Pull public rows from the live DB. Parameterized IN-list keeps the source
    // allow-list explicit. Denormalize sender via people so the reader needs no join.
    out.exec(`ATTACH DATABASE '${DB_PATH.replace(/'/g, "''")}' AS src`)
    const placeholders = PUBLIC_SOURCES.map(() => '?').join(', ')

    out.run(
      `INSERT INTO messages (id, thread_id, source, content_type, timestamp,
                             position_in_thread, sender, is_from_me, content,
                             reply_to_message_id, quoted_content, word_count)
       SELECT m.id, m.thread_id, m.source, m.content_type, m.timestamp,
              m.position_in_thread, COALESCE(p.display_name, m.sender_id),
              m.is_from_me, m.content, m.reply_to_message_id, m.quoted_content, m.word_count
       FROM src.messages m
       LEFT JOIN src.people p ON m.sender_id = p.id
       WHERE m.source IN (${placeholders})`,
      [...PUBLIC_SOURCES]
    )

    out.run(
      `INSERT INTO threads (id, source, title, source_url, thread_type,
                            started_at, last_activity_at, message_count)
       SELECT DISTINCT t.id, t.source, t.title, t.source_url, t.thread_type,
              t.started_at, t.last_activity_at, t.message_count
       FROM src.threads t
       WHERE t.id IN (SELECT DISTINCT thread_id FROM messages)`
    )

    // Full-text index over content + thread title. content_id maps back to messages.id.
    out.exec(`
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        content,
        title,
        content_id UNINDEXED,
        tokenize = 'porter unicode61'
      );
      INSERT INTO messages_fts (content, title, content_id)
      SELECT m.content, COALESCE(t.title, ''), m.id
      FROM messages m
      LEFT JOIN threads t ON m.thread_id = t.id;
    `)
    out.exec(`INSERT INTO messages_fts(messages_fts) VALUES('optimize')`)

    // Metadata so an agent can see freshness + scope.
    const builtAt = new Date().toISOString()
    const counts = out
      .query(`SELECT source, content_type, COUNT(*) AS c FROM messages GROUP BY source, content_type ORDER BY source, content_type`)
      .all() as Array<{ source: string; content_type: string; c: number }>
    const totalMsg = (out.query(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }).c
    const totalThreads = (out.query(`SELECT COUNT(*) AS c FROM threads`).get() as { c: number }).c
    const insertMeta = out.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`)
    insertMeta.run('built_at', builtAt)
    insertMeta.run('sources', PUBLIC_SOURCES.join(','))
    insertMeta.run('message_count', String(totalMsg))
    insertMeta.run('thread_count', String(totalThreads))
    insertMeta.run('counts', JSON.stringify(counts))

    out.exec('DETACH DATABASE src')
    out.close()

    // Atomic replace.
    renameSync(buildPath, finalPath)

    const sizeMB = (statSync(finalPath).size / (1024 * 1024)).toFixed(1)
    console.log(`\nBuilt ${totalMsg.toLocaleString()} messages across ${totalThreads.toLocaleString()} threads (${sizeMB} MB)`)
    for (const row of counts) {
      console.log(`  ${row.source.padEnd(8)} ${(row.content_type || '(none)').padEnd(22)} ${row.c.toLocaleString()}`)
    }
    console.log(`\nfile://${encodeURI(finalPath)}`)
  } catch (e) {
    try { out.close() } catch {}
    throw e
  }

  if (pushDest) {
    // USER@HOST:DIR — uses your normal ssh config/keys.
    const m = pushDest.match(/^([^:]+):(.+)$/)
    if (!m) {
      console.error('Error: --push expects USER@HOST:DIR (e.g. agent@my-other-mac:~/.agent-data)')
      process.exit(1)
    }
    const [, host, dir] = m
    console.log(`\n=== Pushing to ${host} ===`)
    const mkdir = Bun.spawnSync(['ssh', host, `mkdir -p ${dir}`])
    if (mkdir.exitCode !== 0) {
      console.error('Error: remote mkdir failed:', new TextDecoder().decode(mkdir.stderr))
      process.exit(1)
    }
    const dest = `${host}:${dir.replace(/\/$/, '')}/public_deep_context.db`
    const scp = Bun.spawnSync(['scp', finalPath, dest])
    if (scp.exitCode !== 0) {
      console.error('Error: scp failed:', new TextDecoder().decode(scp.stderr))
      process.exit(1)
    }
    console.log(`Pushed → ${dest}`)
  }
}

// ============================================================
// BACKFILL - Checkpointed historical backfill for Slack sources
// ============================================================

async function cmdBackfill(args: ParsedArgs): Promise<void> {
  const target = args.positional[0]
  const subsource = args.positional[1]

  const usage = `Usage: deep-context backfill slack <mentions|channel-full> [--from DATE] [--to DATE] [--restart] [--channel ID] [--chunk-months N]`

  if (target !== 'slack') {
    console.error(`Error: backfill target must be "slack" (got "${target || '<missing>'}")`)
    console.error(usage)
    process.exit(1)
  }

  if (subsource !== 'mentions' && subsource !== 'channel-full') {
    console.error(`Error: subsource must be "mentions" or "channel-full" (got "${subsource || '<missing>'}")`)
    console.error(usage)
    process.exit(1)
  }

  const fromDateRaw = args.flags.from as string | undefined
  const toDateRaw = args.flags.to as string | undefined
  const restart = !!args.flags.restart
  const channel = args.flags.channel as string | undefined
  const dryRun = !!args.flags['dry-run']
  const chunkMonthsRaw = args.flags['chunk-months'] as string | undefined
  const chunkMonths = chunkMonthsRaw ? parseInt(chunkMonthsRaw, 10) : 6
  if (isNaN(chunkMonths) || chunkMonths < 1 || chunkMonths > 12) {
    console.error(`Error: --chunk-months must be between 1 and 12 (got ${chunkMonthsRaw})`)
    process.exit(1)
  }

  const overallFromDate = fromDateRaw || '2021-01-01'
  const overallToDate = toDateRaw || new Date().toISOString().split('T')[0]

  const checkpointSource = subsource === 'mentions' ? 'backfill-slack-mentions' : 'backfill-slack-channel-full'
  const checkpointScope = subsource === 'channel-full' ? (channel || 'all-configured') : 'all'

  const db = getDb()

  // Resume from checkpoint unless --restart
  let effectiveToDate = overallToDate
  if (!restart) {
    const wm = db.query(`
      SELECT last_seen_ts FROM extraction_watermarks
      WHERE source = ? AND scope = ?
    `).get(checkpointSource, checkpointScope) as { last_seen_ts: string | null } | null
    if (wm?.last_seen_ts) {
      effectiveToDate = wm.last_seen_ts.split('T')[0]
      console.log(`  Resuming from checkpoint: ${effectiveToDate}`)
    }
  }

  console.log(`\n=== Backfill: slack ${subsource} ===`)
  console.log(`  Range: ${overallFromDate} .. ${effectiveToDate} (working newest → oldest)`)
  console.log(`  Chunk size: ${chunkMonths} month(s)`)
  if (channel) console.log(`  Channel: ${channel}`)
  if (restart) console.log(`  [RESTART — ignoring checkpoint]`)
  if (dryRun) console.log(`  [DRY RUN]`)

  const overallFromMs = new Date(overallFromDate).getTime()
  let chunkEndMs = new Date(effectiveToDate).getTime()
  const chunkSizeMs = chunkMonths * 30 * 24 * 60 * 60 * 1000  // ~N months (approximate)

  if (chunkEndMs <= overallFromMs) {
    console.log(`\nNothing to backfill — checkpoint has already reached ${overallFromDate}.`)
    return
  }

  let chunkNum = 0
  let totalMessages = 0

  while (chunkEndMs > overallFromMs) {
    chunkNum++
    const chunkStartMs = Math.max(chunkEndMs - chunkSizeMs, overallFromMs)
    const chunkStart = new Date(chunkStartMs).toISOString().split('T')[0]
    const chunkEnd = new Date(chunkEndMs).toISOString().split('T')[0]

    console.log(`\n--- Chunk ${chunkNum}: ${chunkStart} .. ${chunkEnd} ---`)
    const chunkStartTime = Date.now()

    try {
      let result: ExtractionResult
      if (subsource === 'mentions') {
        result = await extractSlackMentions(db, { fromDate: chunkStart, toDate: chunkEnd, dryRun })
      } else {
        result = await extractSlackChannelFull(db, { fromDate: chunkStart, toDate: chunkEnd, dryRun, channelFilter: channel })
      }
      totalMessages += result.count
      const elapsed = Math.round((Date.now() - chunkStartTime) / 1000)
      console.log(`Chunk ${chunkNum} done: +${result.count} messages in ${elapsed}s (running total: ${totalMessages})`)
    } catch (e) {
      console.error(`\nChunk ${chunkNum} FAILED: ${(e as Error).message}`)
      console.error(`Checkpoint preserved. Re-run to retry from ${chunkEnd}.`)
      process.exit(1)
    }

    // Checkpoint: record the oldest boundary reached so next run resumes here
    if (!dryRun) {
      await withDbRetry(() => setBackfillCheckpoint(db, checkpointSource, checkpointScope, new Date(chunkStartMs).toISOString()))
    }

    chunkEndMs = chunkStartMs
  }

  console.log(`\n=== Backfill complete ===`)
  console.log(`  Chunks: ${chunkNum}`)
  console.log(`  Messages added: ${totalMessages}`)
  console.log(`  Range covered: ${overallFromDate} .. ${overallToDate}`)
}

// ============================================================
// EXTRACT FOR SUMMARY - Thread-centric extraction for LLM summarization
// ============================================================

interface ExtractConfig {
  fromDate: string
  toDate: string
  tokenBudget: number
  overlapMessages: number
  includeLowQuality: boolean
  outputPath?: string
}

interface ThreadData {
  id: string
  source: string
  subject?: string
  title?: string
  started_at: string
  last_activity_at: string
  message_count: number
  my_message_count: number
  participant_ids: string | null
  thread_type: string
  network?: string
}

interface MessageData {
  id: string
  thread_id: string
  source: string
  timestamp: string
  position_in_thread: number
  sender_id: string
  is_from_me: number
  content: string
  content_type: string
  reply_to_message_id?: string
  quoted_content?: string
  word_count: number
}

interface PersonData {
  id: string
  display_name: string
}

// Token estimation: ~1.3 tokens per word for English text
function estimateTokens(text: string): number {
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length
  return Math.ceil(wordCount * 1.3)
}

function formatTimestamp(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function formatDateOnly(ts: string): string {
  const d = new Date(ts)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric'
  })
}

async function cmdExtractForSummary(args: ParsedArgs): Promise<void> {
  const fromDate = args.flags.from as string | undefined
  const toDate = args.flags.to as string | undefined

  if (!fromDate || !toDate) {
    console.error('Error: Both --from and --to dates are required')
    console.error('Usage: deep-context extract-for-summary --from 2026-01-20 --to 2026-01-26')
    process.exit(1)
  }

  const config: ExtractConfig = {
    fromDate,
    toDate,
    tokenBudget: parseInt(args.flags['token-budget'] as string, 10) || 300000,
    overlapMessages: 0,  // windowed-thread overlap (the --overlap flag was never used)
    includeLowQuality: !!args.flags['include-low-quality'],
    outputPath: args.flags.output as string | undefined
  }

  console.log(`\nExtracting content for summarization`)
  console.log(`  Date range: ${config.fromDate} to ${config.toDate}`)
  console.log(`  Token budget: ${formatNumber(config.tokenBudget)}`)
  console.log(`  Overlap messages: ${config.overlapMessages}`)
  console.log(`  Include low quality: ${config.includeLowQuality}`)
  if (config.outputPath) console.log(`  Output: ${config.outputPath}`)

  const db = getDb()

  // Build the markdown document
  const sections: string[] = []
  let totalTokens = 0

  // Header
  sections.push(`# Activity Summary: ${formatDateOnly(config.fromDate)} - ${formatDateOnly(config.toDate)}, ${new Date(config.fromDate).getFullYear()}\n`)

  // Section 1: Public Writing (Twitter)
  const twitterSection = await extractTwitterSection(db, config)
  if (twitterSection.content) {
    sections.push(twitterSection.content)
    totalTokens += twitterSection.tokens
    console.log(`  Twitter: ${formatNumber(twitterSection.tokens)} tokens (${twitterSection.count} items)`)
  }

  // Section 2: Twitter DMs
  const twitterDmSection = await extractTwitterDMSection(db, config)
  if (twitterDmSection.content) {
    sections.push(twitterDmSection.content)
    totalTokens += twitterDmSection.tokens
    console.log(`  Twitter DMs: ${formatNumber(twitterDmSection.tokens)} tokens (${twitterDmSection.count} threads)`)
  }

  // Section 3: Email (Gmail - engaged threads only)
  const gmailSection = await extractGmailSection(db, config)
  if (gmailSection.content) {
    sections.push(gmailSection.content)
    totalTokens += gmailSection.tokens
    console.log(`  Gmail: ${formatNumber(gmailSection.tokens)} tokens (${gmailSection.count} threads)`)
  }

  // Section 4: Slack (DMs + Channels, grouped by workspace)
  const slackSection = await extractSlackSection(db, config)
  if (slackSection.content) {
    sections.push(slackSection.content)
    totalTokens += slackSection.tokens
    console.log(`  Slack: ${formatNumber(slackSection.tokens)} tokens (${slackSection.count} threads)`)
  }

  // Section 5: iMessage/Beeper (windowed with overlap)
  const messagingSection = await extractMessagingSection(db, config)
  if (messagingSection.content) {
    sections.push(messagingSection.content)
    totalTokens += messagingSection.tokens
    console.log(`  iMessage/Beeper: ${formatNumber(messagingSection.tokens)} tokens (${messagingSection.count} threads)`)
  }

  // Section 6: Calls (use summaries)
  const callsSection = await extractCallsSection(db, config)
  if (callsSection.content) {
    sections.push(callsSection.content)
    totalTokens += callsSection.tokens
    console.log(`  Calls: ${formatNumber(callsSection.tokens)} tokens (${callsSection.count} calls)`)
  }

  // Section 7: Podcast work (questions/intros/editorial only)
  const podcastSection = await extractPodcastSection(db, config)
  if (podcastSection.content) {
    sections.push(podcastSection.content)
    totalTokens += podcastSection.tokens
    console.log(`  Podcast: ${formatNumber(podcastSection.tokens)} tokens (${podcastSection.count} episodes)`)
  }

  db.close()

  // Combine all sections
  const markdown = sections.join('\n---\n\n')

  console.log(`\n═══════════════════════════════════════════════════════════════`)
  console.log(`Total estimated tokens: ${formatNumber(totalTokens)}`)
  console.log(`Budget utilization: ${Math.round(totalTokens / config.tokenBudget * 100)}%`)
  if (totalTokens > config.tokenBudget) {
    console.log(`⚠️  WARNING: Over budget by ${formatNumber(totalTokens - config.tokenBudget)} tokens`)
  }
  console.log(`═══════════════════════════════════════════════════════════════`)

  // Output
  if (config.outputPath) {
    await Bun.write(config.outputPath, markdown)
    console.log(`\nWritten to: ${config.outputPath}`)
  } else {
    console.log(`\n${markdown}`)
  }
}

// Helper to get person display name
function getPersonName(db: Database, personId: string | null): string {
  if (!personId) return 'Unknown'
  const person = db.query(`SELECT display_name FROM people WHERE id = ?`).get(personId) as PersonData | null
  return person?.display_name || personId
}

// Helper to get all participants in a thread
function getParticipantNames(db: Database, participantIds: string | null): string[] {
  if (!participantIds) return []
  try {
    const ids = JSON.parse(participantIds) as string[]
    return ids.map(id => {
      if (id === OWNER_CONFIG.personId) return OWNER_CONFIG.displayName.split(' ')[0]
      return getPersonName(db, id)
    })
  } catch {
    return []
  }
}

// Cache for Slack user lookups (persists across function calls)
const slackUserCache = new Map<string, string>()

// Resolve Slack user IDs to display names via the Slack API
// Tries all configured workspaces since DMs can come from either
async function resolveSlackUserId(userId: string): Promise<string> {
  if (slackUserCache.has(userId)) return slackUserCache.get(userId)!
  if (!userId.startsWith('U')) {
    slackUserCache.set(userId, userId)
    return userId
  }

  // Try all configured workspaces
  const workspaces = Object.keys(OWNER_CONFIG.slackIdentifiers)
  for (const workspace of workspaces) {
    try {
      const result = await Bun.$`~/.bun/bin/bun ${join(import.meta.dir, 'slack.ts')} people get ${userId} -w ${workspace} --json`.quiet()
      const user = JSON.parse(result.stdout.toString())
      const name = user.real_name || user.display_name || user.name || userId
      slackUserCache.set(userId, name)
      return name
    } catch {
      // Try next workspace
    }
  }

  // Fallback to raw ID if not found in any workspace
  slackUserCache.set(userId, userId)
  return userId
}

// ============================================================================
// Beeper Contact Resolution
// ============================================================================
//
// Problem: Beeper API returns phone numbers (e.g., "+15039294312") as sender
// IDs for iMessage/SMS, not contact names. This makes extract-for-summary
// output hard to read.
//
// Solution: Look up phone numbers in the macOS Contacts database (exported
// to SQLite) and resolve to human-readable names.
//
// Setup:
//   bun tools/contacts.ts export   # Run once, then after adding contacts
//   bun tools/contacts.ts stats    # Verify export
//
// Architecture:
//   1. contacts.ts exports macOS Contacts → data/contacts.db
//   2. This code opens that DB (read-only) and caches lookups
//   3. Phones normalized to 10-digit US format for matching
//   4. Falls back to formatted phone number if not in contacts
//
// Performance:
//   - DB lookup: ~1ms (via cache after first hit)
//   - Cache prevents repeated DB queries for same phone number
//
// Limitation: Only resolves contacts in your macOS Contacts app.
// Group chat participants not in your contacts will show as phone numbers.
// ============================================================================

/** Cache for Beeper contact lookups - prevents repeated DB queries */
const beeperContactCache = new Map<string, string>()

/** Path to contacts SQLite database (exported from macOS Contacts) */
const CONTACTS_DB_PATH = join(PROJECT_ROOT, 'data/contacts.db')

/** Singleton DB connection - opened once, kept open for session */
let contactsDb: Database | null = null

/**
 * Get or open the contacts database connection.
 * Returns null if database doesn't exist (run `contacts export` first).
 */
function getContactsDb(): Database | null {
  if (contactsDb) return contactsDb
  if (!existsSync(CONTACTS_DB_PATH)) return null
  try {
    contactsDb = new Database(CONTACTS_DB_PATH, { readonly: true })
    return contactsDb
  } catch {
    return null
  }
}

/**
 * Normalize phone to 10-digit US format for database lookup.
 * Strips all non-digits, removes leading country code (1) if present.
 */
function normalizePhoneForLookup(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1)
  }
  return digits
}

/**
 * Look up contact name by phone number in contacts.db.
 * Returns null if not found or database not available.
 */
function lookupContactByPhone(phone: string): string | null {
  const db = getContactsDb()
  if (!db) return null

  const normalized = normalizePhoneForLookup(phone)
  if (!normalized) return null

  try {
    const result = db.query<{ name: string }, [string]>(`
      SELECT c.name FROM contacts c
      JOIN phones p ON p.contact_id = c.id
      WHERE p.phone_normalized = ?
    `).get(normalized)
    return result?.name || null
  } catch {
    return null
  }
}

/**
 * Resolve a Beeper sender ID to a human-readable name.
 *
 * Strategy:
 *   1. If already a name (not digits), return as-is
 *   2. Check cache for previous lookup
 *   3. Query contacts.db for phone → name mapping
 *   4. Fall back to nicely formatted phone number
 *
 * @param chatId - The Beeper chat ID (unused, but kept for API consistency)
 * @param phoneOrId - Phone number or sender ID from Beeper API
 * @returns Human-readable name or formatted phone number
 */
async function resolveBeeperContact(chatId: string, phoneOrId: string): Promise<string> {
  // Skip if already a name (not a phone number pattern)
  if (!phoneOrId.match(/^[\d\-\+\s]+$/)) {
    return phoneOrId
  }

  const cacheKey = `phone:${phoneOrId}`
  if (beeperContactCache.has(cacheKey)) return beeperContactCache.get(cacheKey)!

  // Try contacts database first
  const contactName = lookupContactByPhone(phoneOrId)
  if (contactName) {
    beeperContactCache.set(cacheKey, contactName)
    return contactName
  }

  // Format phone number nicely (e.g., 15039294312 -> +1 503-929-4312)
  const digits = phoneOrId.replace(/\D/g, '')
  let formatted = phoneOrId
  if (digits.length === 11 && digits.startsWith('1')) {
    // US number: +1 XXX-XXX-XXXX
    formatted = `+1 ${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`
  } else if (digits.length === 10) {
    // US number without country code: XXX-XXX-XXXX
    formatted = `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  }

  beeperContactCache.set(cacheKey, formatted)
  return formatted
}

// ============================================================================
// Display-time phone → name resolution (read-only stopgap)
// ============================================================================
// Beeper/iMessage threads are often stored with titles like "+1 555-010-0001" or
// "+1 555-010-0002, +1 555-010-0003 & +1 555-010-0004", and participant IDs
// like "1-555-010-0001". Rather than rewriting stored data, resolve numbers
// against contacts.db when printing. Unknown numbers stay as-is.

/** Matches "+1 555-010-0001", "1-555-010-0001", "555-010-0001", "(555) 010-0001", "15550100001" */
const PHONE_IN_TEXT_RE = /(?<![\w+])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\d)|(?<![\w+])\+?1\d{10}(?!\d)/g

const phoneDisplayCache = new Map<string, string | null>()

function lookupContactByPhoneCached(phone: string): string | null {
  const key = normalizePhoneForLookup(phone)
  if (!phoneDisplayCache.has(key)) phoneDisplayCache.set(key, lookupContactByPhone(phone))
  return phoneDisplayCache.get(key)!
}

/**
 * Replace phone numbers embedded in display text with contact names.
 * Default: "Name (+1 555-010-0001)". compact: "Name". Unresolved numbers are left untouched.
 */
export function resolvePhonesInText(
  text: string,
  opts: { compact?: boolean; lookup?: (phone: string) => string | null } = {},
): string {
  if (!text) return text
  const lookup = opts.lookup ?? lookupContactByPhoneCached
  return text.replace(PHONE_IN_TEXT_RE, match => {
    const name = lookup(match)
    if (!name) return match
    return opts.compact ? name : `${name} (${match.trim()})`
  })
}

// Clean up iMessage binary artifacts (NSObject, NSData, bplist, attachment references)
function cleanMessageContent(content: string): string {
  if (!content) return content

  let cleaned = content

  // Remove NSData blocks with binary plist content
  // Pattern: "NSData [xxxc]bplist00..." until next message boundary or end
  cleaned = cleaned.replace(/NSData\s*\[\w+\]bplist[\s\S]*?(?=(?:\n[A-Z]|\n\*\*|$))/gi, '[Attachment]')

  // Remove standalone NSObject
  cleaned = cleaned.replace(/\bNSObject\b/g, '')

  // Remove binary plist data that may appear without NSData prefix
  cleaned = cleaned.replace(/bplist00[\s\S]*?DDScannerResult/gi, '')

  // Remove attachment reference patterns like ")at_1_GUID..."
  cleaned = cleaned.replace(/\)at_\d+_[A-F0-9-]+/gi, '')

  // Remove object replacement characters (U+FFFC) used for inline attachments
  cleaned = cleaned.replace(/\uFFFC+/g, '')

  // Remove [Loved]/[Liked] tapback reactions on quoted text (keep the actual text)
  cleaned = cleaned.replace(/\[(Loved|Liked|Laughed|Emphasized|Questioned|Disliked)\]\s*[""]([^""]+)[""]/gi, '$2')

  // Clean up multiple spaces/newlines left behind
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/  +/g, ' ').trim()

  // If content is now empty or just whitespace/punctuation, mark as attachment
  if (!cleaned || cleaned.match(/^[\s\p{P}]*$/u)) {
    return '[Attachment]'
  }

  return cleaned
}

interface SectionResult {
  content: string
  tokens: number
  count: number
}

// ============================================================
// TWITTER SECTION - Public tweets and replies
// Thread structure is pre-computed via groupTwitterSelfReplies()
// ============================================================

interface TweetWithMeta extends MessageData {
  subject?: string
  title?: string
  raw_json?: string
  sender_name?: string
}

async function extractTwitterSection(db: Database, config: ExtractConfig): Promise<SectionResult> {
  // Find all tweets in date range (excluding DMs)
  const tweetsInRange = db.query(`
    SELECT m.*, t.subject, t.title, t.message_count as thread_message_count, t.thread_type,
           p.display_name as sender_name
    FROM messages m
    JOIN threads t ON m.thread_id = t.id
    LEFT JOIN people p ON m.sender_id = p.id
    WHERE m.source = 'twitter'
      AND m.content_type != 'dm'
      AND date(m.timestamp) >= date(?)
      AND date(m.timestamp) <= date(?)
    ORDER BY m.timestamp ASC
  `).all(config.fromDate, config.toDate) as (TweetWithMeta & { thread_message_count: number; thread_type: string })[]

  if (tweetsInRange.length === 0) return { content: '', tokens: 0, count: 0 }

  const lines: string[] = ['## Public Writing (Twitter)\n']

  // Group tweets by thread_id
  const processedThreads = new Set<string>()
  const multiTweetThreads: TweetWithMeta[][] = []
  const standalones: TweetWithMeta[] = []
  const replyToOthers: TweetWithMeta[] = []
  const quoteTweets: TweetWithMeta[] = []

  for (const tweet of tweetsInRange) {
    if (processedThreads.has(tweet.thread_id)) continue
    processedThreads.add(tweet.thread_id)

    if (tweet.thread_type === 'thread' || tweet.thread_message_count > 1) {
      // Multi-tweet thread: fetch all messages in the thread
      const threadMessages = db.query(`
        SELECT m.*, p.display_name as sender_name
        FROM messages m
        LEFT JOIN people p ON m.sender_id = p.id
        WHERE m.thread_id = ?
        ORDER BY m.position_in_thread ASC, m.timestamp ASC
      `).all(tweet.thread_id) as TweetWithMeta[]
      multiTweetThreads.push(threadMessages)
    } else if (tweet.content_type === 'tweet') {
      standalones.push(tweet)
    } else if (tweet.content_type === 'reply') {
      // Check if there's a stub message (parent tweet) in the same thread
      const stubMessage = db.query(`
        SELECT m.*, p.display_name as sender_name
        FROM messages m
        LEFT JOIN people p ON m.sender_id = p.id
        WHERE m.thread_id = ? AND m.is_from_me = 0
        ORDER BY m.position_in_thread ASC
        LIMIT 1
      `).get(tweet.thread_id) as TweetWithMeta | null

      if (stubMessage) {
        // We have a stub - show both for context
        replyToOthers.push({ ...tweet, _stubMessage: stubMessage } as any)
      } else {
        replyToOthers.push(tweet)
      }
    } else if (tweet.content_type === 'quote_tweet') {
      quoteTweets.push(tweet)
    }
  }

  // Format multi-tweet threads
  if (multiTweetThreads.length > 0) {
    lines.push('### Tweet Threads\n')
    for (const thread of multiTweetThreads) {
      // Only count the owner's tweets (not stubs) for display
      const ownerTweets = thread.filter(t => t.is_from_me === 1)
      const firstInRange = thread.find(t => {
        const d = t.timestamp.split('T')[0]
        return d >= config.fromDate && d <= config.toDate
      })
      const dateStr = firstInRange ? formatDateOnly(firstInRange.timestamp) : formatDateOnly(thread[0].timestamp)

      lines.push(`Tweet Thread (${dateStr}, ${ownerTweets.length} tweets):`)

      let tweetNum = 0
      for (const t of thread) {
        if (t.is_from_me === 0) {
          // This is a stub (parent tweet from someone else)
          const name = t.sender_name || 'someone'
          lines.push(`[replying to ${name}]`)
          continue
        }
        tweetNum++
        const prefix = `${tweetNum}.`
        const d = t.timestamp.split('T')[0]
        const inRange = d >= config.fromDate && d <= config.toDate

        if (inRange) {
          lines.push(`${prefix} ${t.content}`)
        } else {
          const preview = t.content.substring(0, 150)
          lines.push(`${prefix} [earlier] ${preview}${t.content.length > 150 ? '...' : ''}`)
        }
      }
      lines.push('')
    }
  }

  // Format standalone tweets
  if (standalones.length > 0) {
    lines.push('### Standalone Tweets\n')
    for (const tweet of standalones) {
      lines.push(`Tweet (${formatDateOnly(tweet.timestamp)}): ${tweet.content}`)
      lines.push('')
    }
  }

  // Format replies to others (with context from stub messages or raw_json)
  if (replyToOthers.length > 0) {
    lines.push('### Replies to Others\n')
    for (const tweet of replyToOthers) {
      const stub = (tweet as any)._stubMessage as TweetWithMeta | undefined

      if (stub) {
        // We have a stub message showing who the owner was replying to
        const name = stub.sender_name || 'someone'
        lines.push(`Tweet Reply (${formatDateOnly(tweet.timestamp)}, replying to ${name}):`)
        if (!stub.content.includes('content not available')) {
          lines.push(`> ${stub.content}`)
        }
      } else {
        // Fallback: try raw_json for screen name
        let replyToUser = ''
        if (tweet.raw_json) {
          try {
            const raw = JSON.parse(tweet.raw_json)
            replyToUser = raw.in_reply_to_screen_name || ''
          } catch { /* ignore */ }
        }

        if (replyToUser) {
          lines.push(`Tweet Reply (${formatDateOnly(tweet.timestamp)}, replying to @${replyToUser}):`)
        } else {
          lines.push(`Tweet Reply (${formatDateOnly(tweet.timestamp)}):`)
        }
      }

      lines.push(tweet.content)
      lines.push('')
    }
  }

  // Format quote tweets
  if (quoteTweets.length > 0) {
    lines.push('### Quote Tweets\n')
    for (const tweet of quoteTweets) {
      lines.push(`Quote Tweet (${formatDateOnly(tweet.timestamp)}):`)
      if (tweet.quoted_content) {
        lines.push(`> Quoted: ${tweet.quoted_content}`)
      }
      lines.push('')
      lines.push(`Owner's comment: ${tweet.content}`)
      lines.push('')
    }
  }

  const content = lines.join('\n')
  const totalTweets = tweetsInRange.filter(t => t.is_from_me === 1).length

  return { content, tokens: estimateTokens(content), count: totalTweets }
}

// ============================================================
// TWITTER DM SECTION - Direct message conversations
// Filters to engaged threads only (my_message_count > 0) to skip spam
// Uses screen name mapping built from tweet mentions
// ============================================================

// Build a mapping of Twitter user IDs to screen names from tweet mentions
function buildTwitterUserMapping(db: Database): Map<string, string> {
  const mapping = new Map<string, string>()

  const results = db.query(`
    SELECT DISTINCT
      json_extract(value, '$.id_str') as user_id,
      json_extract(value, '$.screen_name') as screen_name
    FROM messages, json_each(json_extract(raw_json, '$.entities.user_mentions'))
    WHERE source = 'twitter' AND raw_json IS NOT NULL
  `).all() as { user_id: string; screen_name: string }[]

  for (const r of results) {
    if (r.user_id && r.screen_name) {
      mapping.set(r.user_id, r.screen_name)
    }
  }

  return mapping
}

// Resolve Twitter user display name using screen name mapping
function resolveTwitterUserName(db: Database, personId: string, userMapping: Map<string, string>): string {
  // personId is like "twitter-user-12345"
  const twitterId = personId.replace('twitter-user-', '')

  // Check mapping first
  const screenName = userMapping.get(twitterId)
  if (screenName) {
    return `@${screenName}`
  }

  // Fall back to stored display name
  const person = db.query(`SELECT display_name FROM people WHERE id = ?`).get(personId) as PersonData | null
  if (person && !person.display_name.startsWith('Twitter User ')) {
    return person.display_name
  }

  // Last resort: show truncated ID
  return `@user_${twitterId.slice(-6)}`
}

async function extractTwitterDMSection(db: Database, config: ExtractConfig): Promise<SectionResult> {
  // Build user ID to screen name mapping from tweets
  const userMapping = buildTwitterUserMapping(db)

  // Get ENGAGED threads only (my_message_count > 0) - skip spam DMs
  const threads = db.query(`
    SELECT DISTINCT t.*
    FROM threads t
    WHERE t.source = 'twitter-dm'
      AND t.my_message_count > 0
      AND (
        (date(t.started_at) >= date(?) AND date(t.started_at) <= date(?))
        OR (date(t.last_activity_at) >= date(?) AND date(t.last_activity_at) <= date(?))
        OR (date(t.started_at) <= date(?) AND date(t.last_activity_at) >= date(?))
      )
    ORDER BY t.last_activity_at ASC
  `).all(config.fromDate, config.toDate, config.fromDate, config.toDate, config.fromDate, config.toDate) as ThreadData[]

  if (threads.length === 0) return { content: '', tokens: 0, count: 0 }

  const lines: string[] = ['## Twitter Direct Messages\n']

  for (const thread of threads) {
    // Get participant IDs and resolve to screen names
    let participantNames: string[] = []
    if (thread.participant_ids) {
      try {
        const ids = JSON.parse(thread.participant_ids) as string[]
        participantNames = ids
          .filter(id => id !== OWNER_CONFIG.personId)
          .map(id => resolveTwitterUserName(db, id, userMapping))
      } catch { /* ignore */ }
    }
    const participantStr = participantNames.join(', ') || 'Unknown'

    // Get messages in window
    const messages = db.query(`
      SELECT * FROM messages
      WHERE thread_id = ?
        AND date(timestamp) >= date(?)
        AND date(timestamp) <= date(?)
      ORDER BY timestamp ASC
    `).all(thread.id, config.fromDate, config.toDate) as MessageData[]

    if (messages.length === 0) continue

    const dateRange = messages.length > 1
      ? `${formatDateOnly(messages[0].timestamp)} - ${formatDateOnly(messages[messages.length - 1].timestamp)}`
      : formatDateOnly(messages[0].timestamp)

    lines.push(`### Twitter DM with ${participantStr} (${dateRange})`)
    lines.push('')

    let lastDate = ''
    for (const msg of messages) {
      const msgDate = msg.timestamp.split('T')[0]
      if (msgDate !== lastDate) {
        lastDate = msgDate
        lines.push(`\n--- ${formatDateOnly(msg.timestamp)} ---\n`)
      }
      let sender: string
      if (msg.is_from_me) {
        sender = OWNER_CONFIG.displayName.split(' ')[0]
      } else {
        sender = resolveTwitterUserName(db, msg.sender_id, userMapping)
      }
      lines.push(`${sender}: ${msg.content}`)
    }
    lines.push('')
  }

  const content = lines.join('\n')
  return { content, tokens: estimateTokens(content), count: threads.length }
}

// ============================================================
// EMAIL QUOTE STRIPPING - Remove quoted replies from Gmail content
// ============================================================

/**
 * Strip quoted content from email replies using email-reply-parser.
 * Falls back to regex-based stripping if the parser returns empty.
 */
function stripEmailQuotes(content: string): string {
  if (!content || content.trim().length === 0) return content

  try {
    const email = new EmailReplyParser().read(content)
    const visibleText = email.getVisibleText()

    // Only use parser result if it's substantial (>30% of original or >100 chars)
    // This prevents over-aggressive stripping on emails starting with "Hi the owner,"
    const originalLen = content.trim().length
    const visibleLen = visibleText?.trim().length || 0

    if (visibleLen > 100 || visibleLen > originalLen * 0.3) {
      return visibleText.trim()
    }
  } catch {
    // Fall through to regex fallback
  }

  // Regex fallback - strip quote patterns
  let cleaned = content

  // FIRST: Normalize line endings (CRLF to LF) so regexes work consistently
  cleaned = cleaned.replace(/\r\n/g, '\n')

  // Gmail inline quote pattern - match "On DATE at TIME ... wrote:"
  // and remove everything from there to end (regardless of position)
  // This catches: "On Tue, Jan 27, 2026 at 8:56 AM the owner <email>\nwrote:"
  // Uses [\s\S]+? to match across newlines (Gmail wraps long lines)
  cleaned = cleaned.replace(
    /\n\n\s*On\s+.+?\d{1,2}:\d{2}\s*(?:AM|PM)?[\s\S]+?wrote:\s*\n[\s\S]*$/i,
    ''
  ).trim()

  // Also handle Shortwave/Yahoo format: "On Mon Jan 26, 2026, 05:37 PM GMT, Steve Newman wrote:"
  cleaned = cleaned.replace(
    /\n\n\s*On\s+\w+\s+\w+\s+\d{1,2},\s+\d{4},?\s+\d{1,2}:\d{2}\s*(?:AM|PM|GMT|UTC)?[\s\S]+?wrote:\s*\n[\s\S]*$/i,
    ''
  ).trim()

  // Remove trailing quoted blocks (3+ lines starting with > or |)
  cleaned = cleaned.replace(/((?:\n\s*(?:>|\|).*){3,})\s*$/, '').trim()

  // Remove orphaned "On ... wrote:" at end only (for cases not caught above)
  cleaned = cleaned.replace(/\n\s*(On\s.+?wrote:)\s*$/i, '').trim()

  // Strip "Sent with Shortwave" signatures
  cleaned = cleaned.replace(/\n*Sent with Shortwave\s*(?:\(https?:\/\/[^\)]+\))?\s*$/i, '').trim()

  // Clean remaining MIME artifacts (CRLF already normalized above)
  cleaned = cleaned.replace(/=\n/g, '').replace(/\n{3,}/g, '\n\n').trim()

  return cleaned
}

// ============================================================
// GMAIL SECTION - Engaged threads only (where the owner replied)
// ============================================================

async function extractGmailSection(db: Database, config: ExtractConfig): Promise<SectionResult> {
  // Get engaged threads (my_message_count > 0) with activity in date range
  const threads = db.query(`
    SELECT t.*
    FROM threads t
    WHERE t.source = 'gmail'
      AND t.my_message_count > 0
      AND (
        (date(t.started_at) >= date(?) AND date(t.started_at) <= date(?))
        OR (date(t.last_activity_at) >= date(?) AND date(t.last_activity_at) <= date(?))
        OR (date(t.started_at) <= date(?) AND date(t.last_activity_at) >= date(?))
      )
    ORDER BY t.last_activity_at ASC
  `).all(config.fromDate, config.toDate, config.fromDate, config.toDate, config.fromDate, config.toDate) as ThreadData[]

  if (threads.length === 0) return { content: '', tokens: 0, count: 0 }

  const lines: string[] = ['## Email Conversations\n']

  for (const thread of threads) {
    const subject = thread.subject || thread.title || 'No Subject'
    const participants = getParticipantNames(db, thread.participant_ids)
      .filter(n => n !== OWNER_CONFIG.displayName.split(' ')[0])
    const participantStr = participants.slice(0, 20).join(', ') +
      (participants.length > 20 ? ` +${participants.length - 20}` : '')

    // Get messages in the date range (windowed)
    const messages = db.query(`
      SELECT * FROM messages
      WHERE thread_id = ?
        AND date(timestamp) >= date(?)
        AND date(timestamp) <= date(?)
      ORDER BY timestamp ASC
    `).all(thread.id, config.fromDate, config.toDate) as MessageData[]

    if (messages.length === 0) continue

    // Apply quality filter if metadata exists and not including low quality
    let filteredMessages = messages
    if (!config.includeLowQuality) {
      const messageIds = messages.map(m => m.id)
      const lowQualityIds = new Set<string>()

      for (const msgId of messageIds) {
        const metadata = db.query(`
          SELECT quality_score, originality_score FROM message_metadata WHERE message_id = ?
        `).get(msgId) as { quality_score?: number; originality_score?: number } | null

        if (metadata && (metadata.quality_score !== null || metadata.originality_score !== null)) {
          const qScore = metadata.quality_score ?? 5
          const oScore = metadata.originality_score ?? 5
          if (qScore <= 3 && oScore <= 3) {
            lowQualityIds.add(msgId)
          }
        }
      }

      filteredMessages = messages.filter(m => !lowQualityIds.has(m.id))

      // Filter out AI-automated emails from the owner
      // These have low originality scores (AI-generated content)
      const automatedIds = new Set<string>()
      for (const msg of filteredMessages) {
        if (!msg.is_from_me) continue

        const metadata = db.query(`
          SELECT originality_score FROM message_metadata WHERE message_id = ?
        `).get(msg.id) as { originality_score?: number } | null

        // Low originality = likely AI-generated
        if (metadata?.originality_score && metadata.originality_score <= 2) {
          automatedIds.add(msg.id)
          continue
        }

        // Fallback: subject pattern matching for known automated reports
        if (/^Daily Conference Prospects/i.test(subject) ||
            /^📝.*Guest Prep/i.test(subject) ||
            /^Weekly.*Summary/i.test(subject)) {
          automatedIds.add(msg.id)
        }
      }

      filteredMessages = filteredMessages.filter(m => !automatedIds.has(m.id))
    }

    if (filteredMessages.length === 0) continue

    const dateRange = filteredMessages.length > 1
      ? `${formatDateOnly(filteredMessages[0].timestamp)} - ${formatDateOnly(filteredMessages[filteredMessages.length - 1].timestamp)}`
      : formatDateOnly(filteredMessages[0].timestamp)

    lines.push(`### Email: ${subject}`)
    lines.push(`With: ${participantStr || 'Unknown'} | ${dateRange}\n`)

    for (const msg of filteredMessages) {
      const sender = msg.is_from_me ? OWNER_CONFIG.displayName.split(' ')[0] : getPersonName(db, msg.sender_id)
      const direction = msg.is_from_me ? '→' : '←'

      // Detect forwarded emails
      const isForward = /^[-—]+\s*Forwarded message\s*[-—]+/im.test(msg.content) ||
                        /^Begin forwarded message:/im.test(msg.content) ||
                        /^Fwd:/i.test(subject) || /^Fw:/i.test(subject)

      if (isForward) {
        lines.push(`${direction} ${sender} (${formatDateOnly(msg.timestamp)}) [forwarded]:`)
      } else {
        lines.push(`${direction} ${sender} (${formatDateOnly(msg.timestamp)}):`)
      }

      // Strip quoted content from email replies before outputting
      const cleanedContent = stripEmailQuotes(msg.content)

      const contentLines = cleanedContent.split('\n')
      for (const line of contentLines) {
        lines.push(line)
      }
      lines.push('')
    }
    lines.push('')
  }

  const content = lines.join('\n')
  return { content, tokens: estimateTokens(content), count: threads.length }
}

// ============================================================
// SLACK SECTION - Channels + DMs grouped by workspace
// ============================================================

async function extractSlackSection(db: Database, config: ExtractConfig): Promise<SectionResult> {
  // Query both channel threads and DM threads
  const allThreads = db.query(`
    SELECT t.*
    FROM threads t
    WHERE t.source IN ('slack', 'slack-dm')
      AND (
        (date(t.started_at) >= date(?) AND date(t.started_at) <= date(?))
        OR (date(t.last_activity_at) >= date(?) AND date(t.last_activity_at) <= date(?))
        OR (date(t.started_at) <= date(?) AND date(t.last_activity_at) >= date(?))
      )
    ORDER BY t.last_activity_at ASC
  `).all(config.fromDate, config.toDate, config.fromDate, config.toDate, config.fromDate, config.toDate) as ThreadData[]

  if (allThreads.length === 0) return { content: '', tokens: 0, count: 0 }

  // Group threads by workspace
  const workspaceGroups = new Map<string, { channels: ThreadData[], dms: ThreadData[] }>()

  for (const thread of allThreads) {
    // Parse workspace from raw_json (most reliable) or title prefix
    const rawData = thread.raw_json ? JSON.parse(thread.raw_json) : null
    let workspace = rawData?.workspace || ''
    if (!workspace && thread.title) {
      const match = thread.title.match(/^([^:]+):/)
      if (match) workspace = match[1].trim()
    }
    if (!workspace) workspace = 'Other'
    // Normalize workspace names for consistent display
    const workspaceDisplayNames: Record<string, string> = {
      // Add workspace display name mappings here, e.g.:
      // 'my_company': 'My Company',
    }
    workspace = workspaceDisplayNames[workspace.toLowerCase()] || workspace

    if (!workspaceGroups.has(workspace)) {
      workspaceGroups.set(workspace, { channels: [], dms: [] })
    }
    const group = workspaceGroups.get(workspace)!
    if (thread.source === 'slack') {
      group.channels.push(thread)
    } else {
      group.dms.push(thread)
    }
  }

  const lines: string[] = ['## Slack\n']

  for (const [workspace, group] of workspaceGroups) {
    lines.push(`### ${workspace}\n`)

    // --- Channels first ---
    for (const thread of group.channels) {
      // Get ALL messages in the thread (not date-filtered) since Slack channel threads
      // are short and the thread itself was already filtered by activity date range
      const messages = db.query(`
        SELECT * FROM messages
        WHERE thread_id = ?
        ORDER BY position_in_thread ASC
      `).all(thread.id) as MessageData[]

      if (messages.length === 0) continue

      // Parse channel name from raw_json (most reliable) or title
      const rawData = thread.raw_json ? JSON.parse(thread.raw_json) : null
      const channelName = rawData?.channel_name ? `#${rawData.channel_name}` : (() => {
        const titleMatch = thread.title?.match(/#(\S+)/)
        return titleMatch ? `#${titleMatch[1]}` : thread.title || 'Unknown Channel'
      })()

      const dateRange = messages.length > 1
        ? `${formatDateOnly(messages[0].timestamp)} - ${formatDateOnly(messages[messages.length - 1].timestamp)}`
        : formatDateOnly(messages[0].timestamp)

      lines.push(`#### Slack: ${workspace} ${channelName} (${dateRange})`)
      lines.push(`${messages.length} messages\n`)

      for (const msg of messages) {
        const sender = msg.is_from_me ? OWNER_CONFIG.displayName.split(' ')[0] : await resolveSlackUserId(msg.sender_id)
        lines.push(`${sender}: ${msg.content}`)
      }
      lines.push('')
    }

    // --- Then DMs ---
    for (const thread of group.dms) {
      // Get participant names from DB first
      let rawParticipants = getParticipantNames(db, thread.participant_ids)
        .filter(n => n !== OWNER_CONFIG.displayName.split(' ')[0])

      // For Slack DMs, participant_ids often only contains the owner
      // Parse the title for multi-party DMs (format: "Workspace: mpdm-user1--user2--user3-1")
      if (rawParticipants.length === 0 && thread.title) {
        const mpdmMatch = thread.title.match(/mpdm-(.+)-\d+$/)
        if (mpdmMatch) {
          const usernames = mpdmMatch[1].split('--')
            .filter(u => !u.includes(OWNER_CONFIG.personId.split('-')[0]))
            .map(u => u.replace(/\./g, ' '))
            .map(u => u.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
          rawParticipants = usernames
        }
      }

      // Resolve any raw user IDs via Slack API
      const resolvedParticipants: string[] = []
      for (const p of rawParticipants) {
        if (p.startsWith('U') && p.length > 8) {
          resolvedParticipants.push(await resolveSlackUserId(p))
        } else {
          resolvedParticipants.push(p)
        }
      }
      const participantStr = resolvedParticipants.join(', ') || 'Unknown'

      // Get messages in window
      const messagesInWindow = db.query(`
        SELECT * FROM messages
        WHERE thread_id = ?
          AND date(timestamp) >= date(?)
          AND date(timestamp) <= date(?)
        ORDER BY timestamp ASC
      `).all(thread.id, config.fromDate, config.toDate) as MessageData[]

      if (messagesInWindow.length === 0) continue

      // Check if we need overlap (thread started before window)
      const threadStartedBeforeWindow = new Date(thread.started_at) < new Date(config.fromDate)
      let overlapMessages: MessageData[] = []

      if (threadStartedBeforeWindow && config.overlapMessages > 0) {
        const firstWindowMsgPos = messagesInWindow[0].position_in_thread
        overlapMessages = db.query(`
          SELECT * FROM messages
          WHERE thread_id = ?
            AND position_in_thread < ?
          ORDER BY position_in_thread DESC
          LIMIT ?
        `).all(thread.id, firstWindowMsgPos, config.overlapMessages) as MessageData[]
        overlapMessages.reverse()
      }

      const dateRange = messagesInWindow.length > 1
        ? `${formatDateOnly(messagesInWindow[0].timestamp)} - ${formatDateOnly(messagesInWindow[messagesInWindow.length - 1].timestamp)}`
        : formatDateOnly(messagesInWindow[0].timestamp)

      lines.push(`#### Slack DM with ${participantStr} (${dateRange})`)
      if (threadStartedBeforeWindow) {
        lines.push(`Ongoing since ${formatDateOnly(thread.started_at)}\n`)
      } else {
        lines.push('')
      }

      // Show overlap context if present
      if (overlapMessages.length > 0) {
        lines.push(`[Earlier context: ${overlapMessages.length} messages]`)
        for (const msg of overlapMessages) {
          const sender = msg.is_from_me ? OWNER_CONFIG.displayName.split(' ')[0] : await resolveSlackUserId(msg.sender_id)
          const OVERLAP_CHAR_LIMIT = 1000
          lines.push(`> ${sender}: ${msg.content.substring(0, OVERLAP_CHAR_LIMIT)}${msg.content.length > OVERLAP_CHAR_LIMIT ? '...' : ''}`)
        }
        lines.push('[...]\n')
      }

      // Show window messages with date dividers
      let lastDate = ''
      for (const msg of messagesInWindow) {
        const msgDate = msg.timestamp.split('T')[0]
        if (msgDate !== lastDate) {
          lastDate = msgDate
          lines.push(`\n--- ${formatDateOnly(msg.timestamp)} ---\n`)
        }
        const sender = msg.is_from_me ? OWNER_CONFIG.displayName.split(' ')[0] : await resolveSlackUserId(msg.sender_id)
        lines.push(`${sender}: ${msg.content}`)
      }
      lines.push('')
    }
  }

  const content = lines.join('\n')
  return { content, tokens: estimateTokens(content), count: allThreads.length }
}

// ============================================================
// MESSAGING SECTION - iMessage and Beeper (windowed with overlap)
// ============================================================

async function extractMessagingSection(db: Database, config: ExtractConfig): Promise<SectionResult> {
  // Get threads from both imessage and beeper
  // Fix 7: Skip spam/2FA threads by requiring my_message_count > 0
  const threads = db.query(`
    SELECT t.*
    FROM threads t
    WHERE t.source IN ('imessage', 'beeper')
      AND t.my_message_count > 0
      AND COALESCE(t.network, '') NOT LIKE '%twitter%'
      AND (
        (date(t.started_at) >= date(?) AND date(t.started_at) <= date(?))
        OR (date(t.last_activity_at) >= date(?) AND date(t.last_activity_at) <= date(?))
        OR (date(t.started_at) <= date(?) AND date(t.last_activity_at) >= date(?))
      )
    ORDER BY t.source, t.last_activity_at ASC
  `).all(config.fromDate, config.toDate, config.fromDate, config.toDate, config.fromDate, config.toDate) as ThreadData[]

  if (threads.length === 0) return { content: '', tokens: 0, count: 0 }

  const lines: string[] = ['## Messaging (iMessage/Beeper)\n']
  let currentSource = ''

  // Proper display names for messaging networks
  const networkDisplayNames: Record<string, string> = {
    imessage: 'iMessage', whatsapp: 'WhatsApp', signal: 'Signal',
    linkedin: 'LinkedIn', facebook: 'Facebook', twitter: 'Twitter',
    instagram: 'Instagram', beeper: 'Beeper', googlechat: 'Google Chat',
  }
  const formatNetwork = (raw: string) => networkDisplayNames[raw.toLowerCase()] || raw.charAt(0).toUpperCase() + raw.slice(1)

  for (const thread of threads) {
    // Section header for source change
    if (thread.source !== currentSource) {
      currentSource = thread.source
      const network = thread.network || thread.source
      lines.push(`### ${formatNetwork(network)} Conversations\n`)
    }

    // Resolve participant names using Beeper API (handles phone numbers -> contact names)
    const rawParticipants = thread.participant_ids ? JSON.parse(thread.participant_ids) as string[] : []
    const resolvedParticipants: string[] = []
    for (const id of rawParticipants) {
      if (id === OWNER_CONFIG.personId) continue
      const name = await resolveBeeperContact(thread.id, id)
      resolvedParticipants.push(name)
    }
    const participantStr = resolvedParticipants.slice(0, 20).join(', ') +
      (resolvedParticipants.length > 20 ? ` +${resolvedParticipants.length - 20}` : '') || 'Unknown'

    // Get messages in window
    const messagesInWindow = db.query(`
      SELECT * FROM messages
      WHERE thread_id = ?
        AND date(timestamp) >= date(?)
        AND date(timestamp) <= date(?)
      ORDER BY timestamp ASC
    `).all(thread.id, config.fromDate, config.toDate) as MessageData[]

    if (messagesInWindow.length === 0) continue

    const isGroup = thread.thread_type === 'group'
    const networkName = formatNetwork(thread.network || thread.source || '')
    const chatType = isGroup ? `${networkName} Group` : `${networkName} Chat`

    // For large group chats (>=10 actual participants), only show context around the owner's messages
    // Use participant_ids count when available (accurate), fall back to distinct senders
    const LARGE_GROUP_THRESHOLD = 10
    if (isGroup) {
      const participantCount = rawParticipants.length + 1  // +1 for the owner (filtered out earlier)
      const distinctSenders = db.query(`
        SELECT COUNT(DISTINCT sender_id) as cnt FROM messages WHERE thread_id = ?
      `).get(thread.id) as { cnt: number }
      // Trust participant_ids when populated; otherwise use distinct senders as proxy
      const effectiveSize = participantCount > 2 ? participantCount : distinctSenders.cnt

      if (effectiveSize >= LARGE_GROUP_THRESHOLD) {
        const myMessages = messagesInWindow.filter(m => m.is_from_me)
        if (myMessages.length === 0) {
          // the owner lurked — emit a one-liner summary
          lines.push(`#### ${chatType} with ${participantStr} (${formatDateOnly(messagesInWindow[0].timestamp)} - ${formatDateOnly(messagesInWindow[messagesInWindow.length - 1].timestamp)})`)
          lines.push(`${messagesInWindow.length} messages from ${effectiveSize} participants — owner did not post\n`)
          continue
        }

        // Show 10 messages before and after each of the owner's messages, merging overlapping windows
        const CONTEXT_WINDOW = 10
        const includeIndices = new Set<number>()
        for (let i = 0; i < messagesInWindow.length; i++) {
          if (messagesInWindow[i].is_from_me) {
            for (let j = Math.max(0, i - CONTEXT_WINDOW); j <= Math.min(messagesInWindow.length - 1, i + CONTEXT_WINDOW); j++) {
              includeIndices.add(j)
            }
          }
        }
        const sortedIndices = Array.from(includeIndices).sort((a, b) => a - b)

        const dateRange = `${formatDateOnly(messagesInWindow[0].timestamp)} - ${formatDateOnly(messagesInWindow[messagesInWindow.length - 1].timestamp)}`
        lines.push(`#### ${chatType} with ${participantStr} (${dateRange})`)
        lines.push(`Large group (${effectiveSize} participants, ${messagesInWindow.length} messages) — showing context around the owner's ${myMessages.length} message${myMessages.length > 1 ? 's' : ''}\n`)

        let lastDate = ''
        let lastIdx = -2  // track gaps between shown messages
        for (const idx of sortedIndices) {
          // Insert gap marker if indices aren't contiguous
          if (lastIdx >= 0 && idx > lastIdx + 1) {
            lines.push(`\n[... ${idx - lastIdx - 1} messages skipped ...]\n`)
          }
          lastIdx = idx

          const msg = messagesInWindow[idx]
          const msgDate = msg.timestamp.split('T')[0]
          if (msgDate !== lastDate) {
            lastDate = msgDate
            lines.push(`\n--- ${formatDateOnly(msg.timestamp)} ---\n`)
          }
          const sender = msg.is_from_me ? OWNER_CONFIG.displayName.split(' ')[0] : await resolveBeeperContact(thread.id, msg.sender_id)
          const cleanContent = cleanMessageContent(msg.content)
          lines.push(`${sender}: ${cleanContent}`)
        }
        lines.push('')
        continue
      }
    }

    // Standard path for small groups and 1:1 chats
    const threadStartedBeforeWindow = new Date(thread.started_at) < new Date(config.fromDate)
    let overlapMessages: MessageData[] = []

    if (threadStartedBeforeWindow && config.overlapMessages > 0) {
      const firstWindowMsgPos = messagesInWindow[0].position_in_thread
      overlapMessages = db.query(`
        SELECT * FROM messages
        WHERE thread_id = ?
          AND position_in_thread < ?
        ORDER BY position_in_thread DESC
        LIMIT ?
      `).all(thread.id, firstWindowMsgPos, config.overlapMessages) as MessageData[]
      overlapMessages.reverse()
    }

    const dateRange = messagesInWindow.length > 1
      ? `${formatDateOnly(messagesInWindow[0].timestamp)} - ${formatDateOnly(messagesInWindow[messagesInWindow.length - 1].timestamp)}`
      : formatDateOnly(messagesInWindow[0].timestamp)

    lines.push(`#### ${chatType} with ${participantStr} (${dateRange})`)
    if (threadStartedBeforeWindow) {
      lines.push(`Ongoing since ${formatDateOnly(thread.started_at)}`)
    }
    lines.push('')

    // Show overlap context if present
    if (overlapMessages.length > 0) {
      lines.push(`[Earlier: ${overlapMessages.length} messages]`)
      const OVERLAP_CHAR_LIMIT = 1000
      for (const msg of overlapMessages) {
        const sender = msg.is_from_me ? OWNER_CONFIG.displayName.split(' ')[0] : await resolveBeeperContact(thread.id, msg.sender_id)
        const cleanContent = cleanMessageContent(msg.content)
        if (cleanContent === '[Attachment]') continue
        lines.push(`> ${sender}: ${cleanContent.substring(0, OVERLAP_CHAR_LIMIT)}${cleanContent.length > OVERLAP_CHAR_LIMIT ? '...' : ''}`)
      }
      lines.push('[...]\n')
    }

    // Show window messages (with date dividers for multi-day conversations)
    let lastDate = ''
    for (const msg of messagesInWindow) {
      const msgDate = msg.timestamp.split('T')[0]
      if (msgDate !== lastDate) {
        lastDate = msgDate
        lines.push(`\n--- ${formatDateOnly(msg.timestamp)} ---\n`)
      }
      const sender = msg.is_from_me ? OWNER_CONFIG.displayName.split(' ')[0] : await resolveBeeperContact(thread.id, msg.sender_id)
      const cleanContent = cleanMessageContent(msg.content)
      lines.push(`${sender}: ${cleanContent}`)
    }
    lines.push('')
  }

  const content = lines.join('\n')
  return { content, tokens: estimateTokens(content), count: threads.length }
}

// ============================================================
// CALLS SECTION - Use summaries instead of raw transcripts
// ============================================================

async function extractCallsSection(db: Database, config: ExtractConfig): Promise<SectionResult> {
  // Get calls in date range
  const threads = db.query(`
    SELECT t.*
    FROM threads t
    WHERE t.source = 'calls'
      AND date(t.started_at) >= date(?)
      AND date(t.started_at) <= date(?)
    ORDER BY t.started_at ASC
  `).all(config.fromDate, config.toDate) as ThreadData[]

  if (threads.length === 0) return { content: '', tokens: 0, count: 0 }

  const lines: string[] = ['## Calls & Meetings\n']
  const summariesDir = join(PROJECT_ROOT, 'data/calls/summaries')

  for (const thread of threads) {
    const title = thread.title || 'Untitled Call'
    const date = formatDateOnly(thread.started_at)

    // Extract fireflies ID from thread id to find summary file
    // Thread IDs are like "calls:01KFEQ7EFHJYWGDFXR61NEPF0G"
    // Summary files are like "2026-01-21_Guest Name and Owner Name_01KFEQ7E.md"
    // The summary file uses a truncated ID (first 8 chars)
    const fullId = thread.id.replace('calls:', '')
    const shortId = fullId.substring(0, 8)

    // Look for summary file matching the call (by date + short ID prefix)
    let summaryContent = ''
    const dateStr = thread.started_at.split('T')[0]  // 2026-01-21
    if (existsSync(summariesDir)) {
      const files = readdirSync(summariesDir)
      // Match by date and short ID prefix
      const summaryFile = files.find(f =>
        f.endsWith('.md') &&
        f.startsWith(dateStr) &&
        (f.includes(shortId) || f.includes(fullId))
      )

      if (summaryFile) {
        const fullPath = join(summariesDir, summaryFile)
        if (existsSync(fullPath)) {
          const raw = readFileSync(fullPath, 'utf8')
          // Fix 8: Include full summary content, not just excerpts
          // Remove header/metadata and footer but keep full content
          let cleanedSummary = raw
            .replace(/^#[^\n]+\n+/, '')  // Remove title
            .replace(/\*\*Date:\*\*[^\n]+\n/, '')  // Remove date
            .replace(/\*\*Duration:\*\*[^\n]+\n/, '')  // Remove duration
            .replace(/\*\*Speakers:\*\*[^\n]+\n+/, '')  // Remove speakers
            .replace(/---\n\*Summary generated[^*]+\*\n\*Fireflies:[^\n]+\n?$/, '')  // Remove footer
            .trim()

          summaryContent = cleanedSummary
        }
      }
    }

    // Fallback: If no summary, try to get a brief from the messages
    if (!summaryContent) {
      // Get participants from thread
      const participants = getParticipantNames(db, thread.participant_ids)
        .filter(n => n !== OWNER_CONFIG.displayName.split(' ')[0])
      summaryContent = `Call with ${participants.join(', ') || 'Unknown'}. No summary available.`
    }

    lines.push(`### Call: ${title} (${date})`)
    lines.push(summaryContent)
    lines.push('')
  }

  const content = lines.join('\n')
  return { content, tokens: estimateTokens(content), count: threads.length }
}

// ============================================================
// PODCAST SECTION - Questions, intros, and editorial only
// ============================================================

async function extractPodcastSection(db: Database, config: ExtractConfig): Promise<SectionResult> {
  // Get podcast threads (episodes) in date range
  const threads = db.query(`
    SELECT t.*
    FROM threads t
    WHERE t.source = 'podcast'
      AND date(t.started_at) >= date(?)
      AND date(t.started_at) <= date(?)
    ORDER BY t.started_at ASC
  `).all(config.fromDate, config.toDate) as ThreadData[]

  if (threads.length === 0) return { content: '', tokens: 0, count: 0 }

  const lines: string[] = ['## Podcast Work\n']

  for (const thread of threads) {
    const title = thread.title || 'Untitled Episode'
    const date = formatDateOnly(thread.started_at)

    // Get only non-speaker-turn content
    const messages = db.query(`
      SELECT * FROM messages
      WHERE thread_id = ?
        AND content_type IN ('questions', 'intro', 'editorial_commentary')
      ORDER BY position_in_thread ASC
    `).all(thread.id) as MessageData[]

    if (messages.length === 0) continue

    lines.push(`### Podcast Episode: ${title} (${date})\n`)

    // Group by content type
    const intro = messages.find(m => m.content_type === 'intro')
    const questions = messages.filter(m => m.content_type === 'questions')
    const editorial = messages.filter(m => m.content_type === 'editorial_commentary')

    // Fix 9: Reorder to Questions → Editorial (Highlights) → Intro
    if (questions.length > 0) {
      lines.push('**Key Questions:**')
      for (let i = 0; i < Math.min(questions.length, 10); i++) {
        const q = questions[i]
        lines.push(`${i + 1}. ${q.content}`)
      }
      if (questions.length > 10) {
        lines.push(`*...and ${questions.length - 10} more questions*`)
      }
      lines.push('')
    }

    if (editorial.length > 0) {
      lines.push('**Editorial Highlights:**')
      for (const e of editorial) {
        lines.push(`> ${e.content}`)
      }
      lines.push('')
    }

    if (intro) {
      lines.push('**Episode Intro:**')
      lines.push(intro.content)
      lines.push('')
    }
    lines.push('')
  }

  const content = lines.join('\n')
  return { content, tokens: estimateTokens(content), count: threads.length }
}

// ============================================================
// SEMANTIC EMBEDDINGS (sidecar vector DB — deep_context_vectors_<provider>.db)
// ============================================================
// Embeddings: Gemini gemini-embedding-2 (default) or local Ollama. Index: sqlite-vec vec0.
// Rerank (optional): Voyage rerank-3. See tools/deep-context-semantic.ts.
// The main deep_context.db is ONLY ever opened read-only by these commands —
// all writes go to the sidecar (additive by design).

async function requireEmbedApiKey(): Promise<string> {
  const key = await getEmbedApiKey()
  if (key === null) {
    console.error('Error: semantic search needs an embedding provider.')
    console.error('  Option A: add GEMINI_API_KEY to tools/.env (cheap; https://aistudio.google.com/apikey)')
    console.error('  Option B: run locally for free — install Ollama, `ollama pull nomic-embed-text`,')
    console.error('            and set DEEP_CONTEXT_EMBED_PROVIDER=ollama')
    console.error('Keyword search works without either: deep-context query "<term>"')
    process.exit(1)
  }
  return key
}

/** Parse the "[source] subject (date)" header out of a chunk's text. */
function splitChunkText(chunkText: string): { context: string; body: string } {
  const nl = chunkText.indexOf('\n')
  const header = nl >= 0 ? chunkText.substring(0, nl) : chunkText
  const body = nl >= 0 ? chunkText.substring(nl + 1) : ''
  // header looks like: [gmail] Subject line (2026-05-12)
  const context = header.replace(/^\[[^\]]*\]\s*/, '').replace(/\s*\(\d{4}-\d{2}-\d{2}\)$/, '')
  return { context: context === '(no subject)' ? '' : context, body: body.replace(/\n/g, ' ') }
}

async function runSemanticQuery(searchTerm: string, args: ParsedArgs): Promise<void> {
  const sourceFilter = args.flags.source as string | undefined
  const fromDate = args.flags.from as string | undefined
  const toDate = args.flags.to as string | undefined
  const limit = (args.flags.limit as number) || 20
  const hybrid = !!args.flags.hybrid
  const useRerank = !args.flags['no-rerank'] && process.env.DEEP_CONTEXT_RERANK !== '0'
  // Start the (optional) rerank key lookup now so it overlaps the embed + KNN
  const voyageKeyP = useRerank ? fetchVoyageKey() : Promise.resolve(null)

  if (!existsSync(vectorDbPath())) {
    console.error(`Error: No vector index at ${vectorDbPath()}`)
    console.error('Build one first: deep-context embed-backfill [--from DATE] [--max-cost N]')
    process.exit(1)
  }

  // IMPORTANT: open the vector sidecar before any other Database in this process
  const vdb = openVectorDb(vectorDbPath())
  const apiKey = await requireEmbedApiKey()

  const tEmbed = Date.now()
  const queryVec = await embedQuery(apiKey, searchTerm)
  const embedMs = Date.now() - tEmbed

  // Over-fetch so post-KNN source/date filters still leave enough results
  const k = Math.min(Math.max(limit * 10, 100), 500)
  const tSearch = Date.now()
  let sql = `
    SELECT c.id, c.thread_id, c.source, c.first_timestamp, c.last_timestamp,
           c.chunk_text, c.message_ids, knn.distance
    FROM (SELECT rowid, distance FROM vec_chunks WHERE embedding MATCH ? AND k = ?) AS knn
    JOIN embed_chunks c ON c.id = knn.rowid
    WHERE c.stale = 0
  `
  const params: any[] = [vecToBlob(queryVec), k]
  if (sourceFilter) {
    sql += ` AND c.source = ?`
    params.push(sourceFilter)
  }
  if (fromDate) {
    sql += ` AND c.last_timestamp >= ?`
    params.push(fromDate)
  }
  if (toDate) {
    sql += ` AND c.first_timestamp <= ?`
    params.push(toDate)
  }
  sql += ` ORDER BY knn.distance ASC LIMIT ?`
  params.push(useRerank ? Math.max(limit, RERANK_POOL) : limit)

  let semRows = vdb.query(sql).all(...params) as any[]
  const searchMs = Date.now() - tSearch
  vdb.close()
  const voyageKey = await voyageKeyP
  // No Voyage key is the normal, supported default: results stay in vector order.

  if (!hybrid) {
    let rerankMs = 0
    let reranked = false
    if (voyageKey && semRows.length) {
      const tR = Date.now()
      const order = await rerank(voyageKey, searchTerm, semRows.map(r => r.chunk_text), limit)
      rerankMs = Date.now() - tR
      if (order) {
        semRows = order.map(o => ({ ...semRows[o.index], relevance: o.score }))
        reranked = true
      }
    }
    semRows = semRows.slice(0, limit)
    console.log(`Found ${semRows.length} conversation chunks semantically matching "${searchTerm}" (embed ${embedMs}ms, search ${searchMs}ms${reranked ? `, rerank ${rerankMs}ms` : ''}):\n`)
    for (const r of semRows) {
      const sim = 1 - r.distance
      const { context, body } = splitChunkText(r.chunk_text)
      console.log(`→ [${r.source}] ${r.first_timestamp} (${r.relevance !== undefined ? `relevance ${r.relevance.toFixed(3)}, ` : ''}similarity ${sim.toFixed(3)})`)
      if (context) console.log(`  ${context}`)
      const preview = body.substring(0, 200)
      console.log(`  ${preview}${body.length > 200 ? '...' : ''}`)
      console.log()
    }
    return
  }

  // Hybrid: keyword results + semantic results, merged by reciprocal rank fusion on thread
  const db = getDb()
  let kwSql = `
    SELECT m.id, m.thread_id, m.source, m.content, m.timestamp, m.is_from_me,
           t.subject, t.title
    FROM messages m
    JOIN threads t ON m.thread_id = t.id
    WHERE m.content LIKE ?
  `
  const kwParams: any[] = [`%${searchTerm}%`]
  if (sourceFilter) {
    kwSql += ` AND m.source = ?`
    kwParams.push(sourceFilter)
  }
  if (fromDate) {
    kwSql += ` AND m.timestamp >= ?`
    kwParams.push(fromDate)
  }
  if (toDate) {
    kwSql += ` AND m.timestamp <= ?`
    kwParams.push(toDate)
  }
  kwSql += ` ORDER BY m.timestamp DESC LIMIT ?`
  kwParams.push(voyageKey ? Math.max(limit, 25) : limit) // wider keyword pool when the reranker sorts it
  let kwRows = db.query(kwSql).all(...kwParams) as any[]
  db.close()

  type Merged = { score: number; sem?: any; kw?: any }
  const byThread = new Map<string, Merged>()

  // Reranked hybrid: score semantic chunks + keyword messages together with rerank-3,
  // then keep each thread's best-scoring hit. Falls through to RRF if rerank fails.
  let rerankedHybrid = false
  if (voyageKey) {
    const cands = [
      ...semRows.map(r => ({ thread: r.thread_id, sem: r, kw: undefined as any, text: r.chunk_text as string })),
      ...kwRows.map(r => ({ thread: r.thread_id, sem: undefined as any, kw: r,
        text: `${r.subject || r.title || ''}\n${String(r.content).substring(0, 4000)}` })),
    ]
    const order = await rerank(voyageKey, searchTerm, cands.map(c => c.text), cands.length)
    if (order) {
      rerankedHybrid = true
      for (const o of order) {
        const c = cands[o.index]
        const e = byThread.get(c.thread) || { score: -1 }
        if (o.score > e.score) e.score = o.score
        if (c.sem && !e.sem) e.sem = c.sem
        if (c.kw && !e.kw) e.kw = c.kw
        byThread.set(c.thread, e)
      }
    }
  }
  if (!rerankedHybrid) {
    semRows = semRows.slice(0, limit)
    kwRows = kwRows.slice(0, limit)
  }

  const RRF_K = 60
  if (!rerankedHybrid) semRows.forEach((r, i) => {
    const e = byThread.get(r.thread_id) || { score: 0 }
    e.score += 1 / (RRF_K + i + 1)
    if (!e.sem) e.sem = r
    byThread.set(r.thread_id, e)
  })
  if (!rerankedHybrid) kwRows.forEach((r, i) => {
    const e = byThread.get(r.thread_id) || { score: 0 }
    e.score += 1 / (RRF_K + i + 1)
    if (!e.kw) e.kw = r
    byThread.set(r.thread_id, e)
  })

  const merged = [...byThread.values()].sort((a, b) => b.score - a.score).slice(0, limit)
  console.log(`Found ${merged.length} conversations matching "${searchTerm}" (hybrid: ${semRows.length} semantic + ${kwRows.length} keyword${rerankedHybrid ? ', reranked' : ''}):\n`)
  for (const e of merged) {
    const label = e.sem && e.kw ? 'both' : e.sem ? 'semantic' : 'keyword'
    if (e.sem) {
      const sim = 1 - e.sem.distance
      const { context, body } = splitChunkText(e.sem.chunk_text)
      console.log(`→ [${e.sem.source}] ${e.sem.first_timestamp} (${label}${rerankedHybrid ? `, relevance ${e.score.toFixed(3)}` : ''}, similarity ${sim.toFixed(3)})`)
      if (context) console.log(`  ${context}`)
      const preview = body.substring(0, 200)
      console.log(`  ${preview}${body.length > 200 ? '...' : ''}`)
    } else {
      const r = e.kw
      const direction = r.is_from_me ? '→' : '←'
      const context = r.subject || r.title || ''
      console.log(`${direction} [${r.source}] ${r.timestamp} (${label}${rerankedHybrid ? `, relevance ${e.score.toFixed(3)}` : ''})`)
      if (context) console.log(`  ${context}`)
      const preview = r.content.substring(0, 200).replace(/\n/g, ' ')
      console.log(`  ${preview}${r.content.length > 200 ? '...' : ''}`)
    }
    console.log()
  }
}

async function cmdEmbedBackfill(args: ParsedArgs): Promise<void> {
  const sourceFilter = args.flags.source as string | undefined
  const fromDate = args.flags.from as string | undefined
  const toDate = args.flags.to as string | undefined
  const chunkLimit = args.flags.limit as number | undefined
  const dryRun = !!args.flags['dry-run']
  const batchSize = DEFAULT_BATCH_SIZE
  const maxCost = args.flags['max-cost'] ? parseFloat(args.flags['max-cost'] as string) : undefined

  // Resolve the provider + key BEFORE creating any files, so an unconfigured install
  // exits cleanly without leaving an empty sidecar behind.
  const embedCfg = embedConfig()
  const apiKey = dryRun ? '' : await requireEmbedApiKey()

  // IMPORTANT: open the vector sidecar before the main DB (custom SQLite ordering)
  const vdb = openVectorDb(vectorDbPath())

  if (!existsSync(DB_PATH)) {
    console.error(`Error: Database not found at ${DB_PATH}`)
    process.exit(1)
  }
  // Read-only open: this command never writes to the main DB
  const db = new Database(DB_PATH, { readonly: true })
  db.exec('PRAGMA busy_timeout = 30000')

  // Candidate threads (with filter-scoped message counts)
  let threadSql = `
    SELECT t.id, t.source, t.subject, t.title, COUNT(m.id) as msg_count, MAX(m.timestamp) as last_ts
    FROM threads t
    JOIN messages m ON m.thread_id = t.id
    WHERE 1=1
  `
  const tParams: any[] = []
  if (sourceFilter) {
    threadSql += ` AND t.source = ?`
    tParams.push(sourceFilter)
  }
  if (fromDate) {
    threadSql += ` AND m.timestamp >= ?`
    tParams.push(fromDate)
  }
  if (toDate) {
    threadSql += ` AND m.timestamp <= ?`
    tParams.push(toDate)
  }
  threadSql += ` GROUP BY t.id ORDER BY last_ts DESC`
  const allThreads = db.query(threadSql).all(...tParams) as any[]

  const stateRows = vdb.query(`SELECT thread_id, message_count FROM embed_thread_state`).all() as any[]
  const stateMap = new Map(stateRows.map(r => [r.thread_id, r.message_count]))
  const candidates = allThreads.filter(t => stateMap.get(t.id) !== t.msg_count)

  console.log(`Semantic index backfill (${embedCfg.provider}: ${embedCfg.model}, ${embedCfg.dims} dims)`)
  console.log(`Threads in scope: ${allThreads.length} | up to date: ${allThreads.length - candidates.length} | to process: ${candidates.length}${dryRun ? ' [DRY RUN]' : ''}\n`)

  let msgSql = `
    SELECT m.id, m.timestamp, m.content, m.is_from_me,
           COALESCE(p.display_name, m.sender_id, 'Unknown') as sender_name
    FROM messages m
    LEFT JOIN people p ON p.id = m.sender_id
    WHERE m.thread_id = ?
  `
  if (fromDate) msgSql += ` AND m.timestamp >= ?`
  if (toDate) msgSql += ` AND m.timestamp <= ?`
  msgSql += ` ORDER BY m.timestamp ASC, m.position_in_thread ASC`
  const msgStmt = db.query(msgSql)

  const existingStmt = vdb.query(`SELECT id, content_hash FROM embed_chunks WHERE thread_id = ? AND stale = 0`)
  const insertChunkStmt = vdb.query(`
    INSERT INTO embed_chunks (content_hash, thread_id, source, message_ids, message_count,
                              first_timestamp, last_timestamp, chunk_text, char_count, model, dims)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertVecStmt = vdb.query(`INSERT INTO vec_chunks (rowid, embedding) VALUES (?, ?)`)
  const markStaleStmt = vdb.query(`UPDATE embed_chunks SET stale = 1 WHERE id = ?`)
  const deleteVecStmt = vdb.query(`DELETE FROM vec_chunks WHERE rowid = ?`)
  const upsertStateStmt = vdb.query(`
    INSERT INTO embed_thread_state (thread_id, message_count, last_message_timestamp, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(thread_id) DO UPDATE SET
      message_count = excluded.message_count,
      last_message_timestamp = excluded.last_message_timestamp,
      updated_at = excluded.updated_at
  `)

  type PendingThread = { pending: number; msgCount: number; lastTs: string; staleIds: number[] }
  const pendingThreads = new Map<string, PendingThread>()
  let buffer: Chunk[] = []
  let bufferChars = 0
  let embeddedChunks = 0
  let embeddedChars = 0
  let skippedExisting = 0
  let plannedChunks = 0
  let plannedChars = 0
  let threadsProcessed = 0
  let stopReason = ''

  // Soft-delete superseded chunks (rows preserved, removed from the vec index only)
  // and record thread state — done only once ALL of a thread's chunks are embedded,
  // so an interrupted run resumes cleanly.
  const finalizeThread = (threadId: string) => {
    const st = pendingThreads.get(threadId)
    if (!st) return
    for (const sid of st.staleIds) {
      markStaleStmt.run(sid)
      deleteVecStmt.run(sid)
    }
    upsertStateStmt.run(threadId, st.msgCount, st.lastTs)
    pendingThreads.delete(threadId)
  }

  const flushOne = async () => {
    const batch = buffer.slice(0, batchSize)
    if (batch.length === 0) return
    const vecs = await embedTexts(apiKey, batch.map(c => c.text), 'RETRIEVAL_DOCUMENT')
    vdb.exec('BEGIN')
    try {
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i]
        const res = insertChunkStmt.run(
          c.hash, c.threadId, c.source, JSON.stringify(c.messageIds), c.messageIds.length,
          c.firstTimestamp, c.lastTimestamp, c.text, c.text.length, embedCfg.model, embedCfg.dims
        )
        insertVecStmt.run(Number(res.lastInsertRowid), vecToBlob(vecs[i]))
      }
      vdb.exec('COMMIT')
    } catch (e) {
      vdb.exec('ROLLBACK')
      throw e
    }
    for (const c of batch) {
      embeddedChunks++
      embeddedChars += c.text.length
      const st = pendingThreads.get(c.threadId)
      if (st) {
        st.pending--
        if (st.pending === 0) finalizeThread(c.threadId)
      }
    }
    buffer = buffer.slice(batch.length)
    bufferChars = buffer.reduce((s, c) => s + c.text.length, 0)
    const tokens = estimateEmbedTokens(embeddedChars)
    const cost = (tokens / 1e6) * embedCfg.pricePerMTokens
    console.log(`  embedded ${embeddedChunks} chunks | ~${tokens.toLocaleString()} tokens | est $${cost.toFixed(4)}`)
  }

  for (const t of candidates) {
    const mParams: any[] = [t.id]
    if (fromDate) mParams.push(fromDate)
    if (toDate) mParams.push(toDate)
    const msgs = msgStmt.all(...mParams) as any[]

    const chunks = chunkThread({
      threadId: t.id,
      source: t.source,
      subject: t.subject || t.title,
      ownerName: OWNER_CONFIG.displayName,
      messages: msgs.map(m => ({
        id: m.id,
        timestamp: m.timestamp,
        content: m.content || '',
        senderName: m.sender_name || 'Unknown',
        isFromMe: !!m.is_from_me
      }))
    })

    const existing = new Map<string, number>(
      (existingStmt.all(t.id) as any[]).map(r => [r.content_hash, r.id])
    )
    const newHashes = new Set(chunks.map(c => c.hash))
    const newChunks = chunks.filter(c => !existing.has(c.hash))
    const staleIds = [...existing.entries()].filter(([h]) => !newHashes.has(h)).map(([, id]) => id)
    skippedExisting += chunks.length - newChunks.length
    plannedChunks += newChunks.length
    plannedChars += newChunks.reduce((s, c) => s + c.text.length, 0)
    threadsProcessed++

    if (dryRun) continue

    // Spend cap: stop before starting a thread that would exceed it
    if (maxCost !== undefined) {
      const projTokens = estimateEmbedTokens(embeddedChars + bufferChars + newChunks.reduce((s, c) => s + c.text.length, 0))
      if ((projTokens / 1e6) * embedCfg.pricePerMTokens > maxCost) {
        stopReason = `--max-cost $${maxCost} reached`
        break
      }
    }

    // Chunk-count cap: may take a partial thread (its state is intentionally NOT
    // recorded, so the next run picks it up; already-embedded hashes are skipped)
    if (chunkLimit !== undefined && embeddedChunks + buffer.length + newChunks.length > chunkLimit) {
      const room = chunkLimit - embeddedChunks - buffer.length
      if (room > 0) {
        buffer.push(...newChunks.slice(0, room))
        bufferChars += newChunks.slice(0, room).reduce((s, c) => s + c.text.length, 0)
      }
      stopReason = `--limit ${chunkLimit} chunks reached`
      break
    }

    pendingThreads.set(t.id, { pending: newChunks.length, msgCount: msgs.length, lastTs: t.last_ts, staleIds })
    if (newChunks.length === 0) {
      finalizeThread(t.id)
      continue
    }
    buffer.push(...newChunks)
    bufferChars += newChunks.reduce((s, c) => s + c.text.length, 0)
    while (buffer.length >= batchSize) await flushOne()
  }

  if (!dryRun) {
    while (buffer.length > 0) await flushOne()
  }

  db.close()

  if (dryRun) {
    const tokens = estimateEmbedTokens(plannedChars)
    const cost = (tokens / 1e6) * embedCfg.pricePerMTokens
    const apiCalls = Math.ceil(plannedChunks / batchSize)
    console.log(`\n[DRY RUN] Would embed ${plannedChunks.toLocaleString()} new chunks from ${threadsProcessed.toLocaleString()} threads (${skippedExisting} chunks already embedded)`)
    console.log(`  ~${tokens.toLocaleString()} tokens → est $${cost.toFixed(4)} | ~${apiCalls.toLocaleString()} API calls (batch size ${batchSize})`)
    console.log(`  Rough wall-clock at ~1.5s/call: ~${Math.ceil((apiCalls * 1.5) / 60)} min`)
  } else {
    const tokens = estimateEmbedTokens(embeddedChars)
    const cost = (tokens / 1e6) * embedCfg.pricePerMTokens
    console.log(`\nDone${stopReason ? ` (stopped: ${stopReason})` : ''}.`)
    console.log(`  Embedded ${embeddedChunks.toLocaleString()} chunks (${skippedExisting} already present, skipped)`)
    console.log(`  ~${tokens.toLocaleString()} tokens | est $${cost.toFixed(4)} spent`)
    console.log(`  Vector DB: ${vectorDbPath()}`)
  }

  vdb.close()
}

async function cmdEmbedStatus(_args: ParsedArgs): Promise<void> {
  if (!existsSync(vectorDbPath())) {
    console.log(`No vector index yet (${vectorDbPath()} does not exist).`)
    console.log('Build one with: deep-context embed-backfill')
    return
  }
  // Vector sidecar first (custom SQLite ordering), then main DB read-only
  const embedCfg = embedConfig()
  const vdb = openVectorDb(vectorDbPath())
  const db = new Database(DB_PATH, { readonly: true })

  const totals = vdb.query(`
    SELECT COUNT(*) as chunks, COALESCE(SUM(char_count), 0) as chars
    FROM embed_chunks WHERE stale = 0
  `).get() as any
  const staleCount = (vdb.query(`SELECT COUNT(*) as c FROM embed_chunks WHERE stale = 1`).get() as any).c
  const threadsEmbedded = (vdb.query(`SELECT COUNT(*) as c FROM embed_thread_state`).get() as any).c
  const bySource = vdb.query(`
    SELECT source, COUNT(*) as chunks, SUM(message_count) as messages
    FROM embed_chunks WHERE stale = 0 GROUP BY source ORDER BY chunks DESC
  `).all() as any[]

  const mainTotals = db.query(`SELECT COUNT(*) as messages, (SELECT COUNT(*) FROM threads) as threads FROM messages`).get() as any
  db.close()

  const embeddedMessages = bySource.reduce((s, r) => s + (r.messages || 0), 0)
  const tokens = estimateEmbedTokens(totals.chars)
  const cost = (tokens / 1e6) * embedCfg.pricePerMTokens

  console.log(`Semantic vector index (${vectorDbPath()})`)
  console.log(`  Provider: ${embedCfg.provider} — ${embedCfg.model} @ ${embedCfg.dims} dims`)
  console.log(`  Chunks: ${totals.chunks.toLocaleString()} active (${staleCount} stale)`)
  console.log(`  Threads covered: ${threadsEmbedded.toLocaleString()} / ${mainTotals.threads.toLocaleString()} (${((threadsEmbedded / mainTotals.threads) * 100).toFixed(1)}%)`)
  console.log(`  Messages covered: ~${embeddedMessages.toLocaleString()} / ${mainTotals.messages.toLocaleString()} (${((embeddedMessages / mainTotals.messages) * 100).toFixed(1)}%)`)
  console.log(`  Embedded text: ${(totals.chars / 1e6).toFixed(1)}M chars ≈ ${tokens.toLocaleString()} tokens ≈ $${cost.toFixed(4)} spent`)
  console.log(`\n  By source:`)
  for (const r of bySource) {
    console.log(`    ${r.source.padEnd(16)} ${String(r.chunks).padStart(8)} chunks  ${String(r.messages).padStart(9)} msgs`)
  }
  vdb.close()
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  // Let tool settings (not just secrets) live in tools/.env: copy DEEP_CONTEXT_* / OLLAMA_*
  // keys into process.env unless already set in the real environment.
  try {
    const env = await load_env()
    for (const [k, v] of Object.entries(env)) {
      if (/^(DEEP_CONTEXT_|OLLAMA_)/.test(k) && v && !process.env[k]) process.env[k] = v
    }
  } catch { /* no .env yet — fine */ }

  const schema = {
    help: { type: 'boolean' as const, alias: 'h' },
    json: { type: 'boolean' as const },
    source: { type: 'string' as const, alias: 's' },
    from: { type: 'string' as const },
    to: { type: 'string' as const },
    limit: { type: 'string' as const, alias: 'l' },
    output: { type: 'string' as const, alias: 'o' },
    'token-budget': { type: 'string' as const },
    'include-low-quality': { type: 'boolean' as const },
    force: { type: 'boolean' as const },
    'dry-run': { type: 'boolean' as const },
    backfill: { type: 'boolean' as const },
    debug: { type: 'boolean' as const },
    // Google account to extract as (gmail). Read straight from argv by
    // resolve_account() in _lib/google_oauth; declared here so the parser
    // accepts it. e.g. `extract gmail --account travel`
    account: { type: 'string' as const },
    as: { type: 'string' as const },  // alias of --account
    'extracted-since': { type: 'string' as const },
    // Recent command flags
    hours: { type: 'string' as const },
    // Todo command flags
    title: { type: 'string' as const },
    category: { type: 'string' as const },
    status: { type: 'string' as const },
    reason: { type: 'string' as const },
    'related-person': { type: 'string' as const },
    due: { type: 'string' as const },
    priority: { type: 'string' as const },
    tags: { type: 'string' as const },
    context: { type: 'string' as const },
    since: { type: 'string' as const },
    days: { type: 'string' as const },  // todo expire --days N (default 30)
    // Slack extraction flags
    channel: { type: 'string' as const },
    // Backfill flags
    restart: { type: 'boolean' as const },
    'chunk-months': { type: 'string' as const },
    // export-public flags
    push: { type: 'string' as const },
    // Semantic search / embedding flags
    semantic: { type: 'boolean' as const },
    hybrid: { type: 'boolean' as const },
    'no-rerank': { type: 'boolean' as const },
    'max-cost': { type: 'string' as const },
  }

  let args: ParsedArgs
  try {
    args = parse_flags(process.argv.slice(2), schema)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }

  const command = args._[0]

  if (args.help || !command) {
    print_help('deep-context', USAGE)
    process.exit(args.help ? 0 : 1)
  }

  // Adapt args for command handlers
  const cmdArgs = {
    positional: args._.slice(1),
    flags: {
      ...args,
      limit: args.limit ? parseInt(args.limit as string, 10) : undefined,
      hours: args.hours ? parseInt(args.hours as string, 10) : undefined,
      since: args.since ? parseInt(args.since as string, 10) : undefined,
    }
  }

  switch (command) {
    case 'init':
      await cmdInit(cmdArgs)
      break
    case 'status':
      await cmdStatus(cmdArgs)
      break
    case 'extract':
      await cmdExtract(cmdArgs)
      break
    case 'enrich':
      await cmdEnrich(cmdArgs)
      break
    case 'query':
      await cmdQuery(cmdArgs)
      break
    case 'recent':
      await cmdRecent(cmdArgs)
      break
    case 'todo':
      await cmdTodo(cmdArgs)
      break
    case 'export-public':
      await cmdExportPublic(cmdArgs)
      break
    case 'extract-for-summary':
      await cmdExtractForSummary(cmdArgs)
      break
    case 'backfill':
      await cmdBackfill(cmdArgs)
      break
    case 'embed-backfill':
    case 'embed-update':
      await cmdEmbedBackfill(cmdArgs)
      break
    case 'embed-status':
      await cmdEmbedStatus(cmdArgs)
      break
    default:
      console.error(`Unknown command: ${command}`)
      print_help('deep-context', USAGE)
      process.exit(1)
  }
}

if (import.meta.main) {
  main().catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}
