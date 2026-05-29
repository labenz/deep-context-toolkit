#!/usr/bin/env bun

// Gmail Extractor for Deep Context
// Extracts Gmail threads where the owner sent at least one message
// Based on patterns from write_as_me (github.com/sirajfarhan/write_as_me)

import Database from 'bun:sqlite'
import { load_env } from './_lib/env'
import { pick_existing_access_token, try_refresh_token, update_project_env_vars } from './_lib/google_oauth'
import { join, dirname } from 'path'
import { convert } from 'html-to-text'

const TOOLS_DIR = import.meta.dir
const PROJECT_ROOT = dirname(TOOLS_DIR)
const DB_PATH = join(PROJECT_ROOT, 'data/deep_context/deep_context.db')

// Import OWNER_CONFIG from deep-context.ts if available, otherwise use a minimal fallback.
// When run standalone, reads from the same OWNER_CONFIG block in deep-context.ts.
let OWNER_CONFIG: { personId: string; displayName: string; emails: string[]; twitterHandle: string; twitterId: string; phone: string; slackIdentifiers: Record<string, { userId: string; searchQuery: string }> }
try {
  OWNER_CONFIG = (await import('./deep-context')).OWNER_CONFIG
} catch {
  // Fallback: define inline if deep-context can't be imported
  OWNER_CONFIG = {
    personId: 'YOUR_PERSON_ID',
    displayName: 'YOUR_NAME',
    emails: ['your@email.com'],
    twitterHandle: '',
    twitterId: '',
    phone: '',
    slackIdentifiers: {},
  }
}

// ============================================================
// TYPE DEFINITIONS
// ============================================================

interface GmailSearchResponse {
  threads?: Array<{ id: string; historyId?: string }>
  nextPageToken?: string
  resultSizeEstimate?: number
}

interface GmailThreadResponse {
  id: string
  historyId: string
  messages: GmailMessage[]
}

interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload: {
    headers: Array<{ name: string; value: string }>
    mimeType?: string
    body?: { size: number; data?: string }
    parts?: GmailPart[]
  }
}

interface GmailPart {
  partId: string
  mimeType: string
  filename?: string
  body?: { size: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

interface ExtractionResult {
  count: number
  newest: string | null
  oldest: string | null
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

function formatNumber(n: number): string {
  return n.toLocaleString()
}

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

// Robust date parsing with multiple fallback formats (pattern from write_as_me)
function parseGmailDate(dateStr: string | undefined, internalDate?: string): string {
  if (!dateStr && !internalDate) return new Date().toISOString()

  if (dateStr) {
    try {
      const parsed = new Date(dateStr)
      if (!isNaN(parsed.getTime())) {
        return parsed.toISOString()
      }
    } catch {}
  }

  if (internalDate) {
    try {
      return new Date(parseInt(internalDate)).toISOString()
    } catch {}
  }

  return new Date().toISOString()
}

// Get header value from Gmail message (case-insensitive)
function getGmailHeader(headers: Array<{ name: string; value: string }>, name: string): string | undefined {
  const header = headers.find(h => h.name.toLowerCase() === name.toLowerCase())
  return header?.value
}

// Extract email address from "Name <email@example.com>" format
function extractEmailAddr(value: string): string {
  const match = value.match(/<([^>]+)>/)
  return match ? match[1].toLowerCase() : value.toLowerCase().trim()
}

// Extract display name from "Name <email@example.com>" format
function extractDispName(value: string): string {
  const match = value.match(/^"?([^"<]+)"?\s*</)
  if (match) return match[1].trim()
  if (!value.includes('<')) return value.split('@')[0]
  return value.split('@')[0]
}

// Decode URL-safe base64 with fallbacks (pattern from write_as_me)
function decodeGmailBase64(data: string): string {
  if (!data) return ''
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  try {
    const decoded = Buffer.from(base64, 'base64')
    try {
      return decoded.toString('utf8')
    } catch {
      return decoded.toString('latin1')
    }
  } catch {
    return ''
  }
}

// Convert HTML to plain text using html-to-text library
function convertHtmlToText(html: string): string {
  // First, remove tracking pixels and invisible images (1x1 images, tracking URLs)
  const cleanedHtml = html
    .replace(/<img[^>]*(?:width\s*=\s*["']?1["']?|height\s*=\s*["']?1["']?)[^>]*>/gi, '')
    .replace(/<img[^>]*src\s*=\s*["'][^"']*(?:track|pixel|beacon|open|click|mail\.)[^"']*["'][^>]*>/gi, '')

  return convert(cleanedHtml, {
    wordwrap: false,
    selectors: [
      { selector: 'a', options: { ignoreHref: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'style', format: 'skip' },
      { selector: 'script', format: 'skip' },
      { selector: 'head', format: 'skip' },
      { selector: 'meta', format: 'skip' },
      { selector: 'link', format: 'skip' },
    ],
    formatters: {
      // Skip empty table cells that often contain spacing
      'skipEmpty': function(elem, walk, builder) {
        // Just skip
      }
    }
  }).trim()
}

// Recursively search MIME parts for message body (pattern from write_as_me)
function extractGmailBody(message: GmailMessage): string {
  function searchParts(parts: GmailPart[] | undefined, preferredMimeType: string): string | undefined {
    if (!parts) return undefined
    for (const part of parts) {
      if (part.mimeType === preferredMimeType && part.body?.data) {
        return decodeGmailBase64(part.body.data)
      }
      if (part.mimeType?.startsWith('multipart/') && part.parts) {
        const result = searchParts(part.parts, preferredMimeType)
        if (result) return result
      }
    }
    return undefined
  }

  // First try: text/plain in parts
  let body = searchParts(message.payload.parts, 'text/plain')

  // Second try: text/html in parts (convert to text using html-to-text library)
  if (!body) {
    const html = searchParts(message.payload.parts, 'text/html')
    if (html) {
      body = convertHtmlToText(html)
    }
  }

  // Third try: payload body directly (may be HTML or plain text)
  if (!body && message.payload.body?.data) {
    const rawBody = decodeGmailBase64(message.payload.body.data)
    // Check if it's HTML and convert if necessary
    if (rawBody.trim().startsWith('<!DOCTYPE') || rawBody.trim().startsWith('<html') || rawBody.includes('<body')) {
      body = convertHtmlToText(rawBody)
    } else {
      body = rawBody
    }
  }

  return body || message.snippet || ''
}

// Strip quoted reply content (simplified EmailReplyParser pattern from write_as_me)
function stripQuotedContent(text: string): string {
  const lines = text.split('\n')
  const cleanLines: string[] = []

  for (const line of lines) {
    if (line.match(/^On .+ wrote:$/)) break
    if (line.match(/^>{3,}/)) break
    if (line.match(/^-{5,}\s*Original Message/i)) break
    if (line.match(/^_{5,}/)) break
    if (line.match(/^From:\s+.+@/i) && cleanLines.length > 3) break
    if (line.startsWith('>')) continue
    cleanLines.push(line)
  }

  return cleanLines.join('\n').trim()
}

// ============================================================
// API FUNCTIONS
// ============================================================

async function getGmailAccessToken(): Promise<string | null> {
  const env = await load_env()

  // Always try refresh first — access tokens expire after ~1 hour,
  // so the stored token is usually stale (especially for cron jobs).
  const refreshedToken = await try_refresh_token(env, 'GMAIL')
  if (refreshedToken) {
    await update_project_env_vars({
      GOOGLE_TOKEN: refreshedToken,
      GMAIL_TOKEN: refreshedToken,
      GDRIVE_TOKEN: refreshedToken,
      GCAL_TOKEN: refreshedToken,
    })
    return refreshedToken
  }

  // Fall back to existing token (might still be valid if recently refreshed)
  const currentToken = pick_existing_access_token(env, 'GMAIL_TOKEN')
  if (currentToken) return currentToken

  console.log('Gmail token expired and could not be refreshed. Re-run extraction to re-authenticate: bun tools/deep-context.ts extract gmail')
  return null
}

async function gmailSearchThreads(accessToken: string, query: string, pageToken?: string): Promise<GmailSearchResponse | null> {
  const params = new URLSearchParams({
    q: query,
    maxResults: '100',
    ...(pageToken && { pageToken })
  })

  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads?${params}`

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error(`Gmail search error: ${response.status} - ${errorText}`)
      return null
    }

    return await response.json() as GmailSearchResponse
  } catch (err) {
    console.error('Gmail search failed:', (err as Error).message)
    return null
  }
}

async function gmailGetThread(accessToken: string, threadId: string): Promise<GmailThreadResponse | null> {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    })

    if (!response.ok) {
      console.error(`Gmail thread fetch error: ${response.status} for ${threadId}`)
      return null
    }

    return await response.json() as GmailThreadResponse
  } catch (err) {
    console.error(`Error fetching thread ${threadId}:`, (err as Error).message)
    return null
  }
}

// ============================================================
// EXTRACTION LOGIC
// ============================================================

async function processGmailThread(
  db: Database,
  thread: GmailThreadResponse,
  ownerId: string,
  dryRun: boolean,
  isUpdate: boolean = false
): Promise<{ timestamp: string } | null> {
  const messages = thread.messages
  if (messages.length === 0) return null

  // Filter out drafts (pattern from write_as_me)
  const nonDraftMessages = messages.filter(m => !m.labelIds?.includes('DRAFT'))
  if (nonDraftMessages.length === 0) return null

  const firstMsg = nonDraftMessages[0]
  const subject = getGmailHeader(firstMsg.payload.headers, 'Subject') || '(No Subject)'

  // Parse timestamps
  const timestamps = nonDraftMessages.map(m => {
    const dateHeader = getGmailHeader(m.payload.headers, 'Date')
    return parseGmailDate(dateHeader, m.internalDate)
  })

  const startedAt = timestamps[0]
  const lastActivityAt = timestamps[timestamps.length - 1]

  // Track participants and the owner's messages
  let myMessageCount = 0
  const participantEmails = new Map<string, { displayName: string; email: string }>()

  for (const msg of nonDraftMessages) {
    const from = getGmailHeader(msg.payload.headers, 'From') || ''
    const fromEmail = extractEmailAddr(from)
    const isFromMe = OWNER_CONFIG.emails.some(e => fromEmail.includes(e.split('@')[0])) || false /* removed: surname check */

    if (isFromMe) {
      myMessageCount++
    } else {
      const displayName = extractDispName(from)
      if (!participantEmails.has(fromEmail)) {
        participantEmails.set(fromEmail, { displayName, email: fromEmail })
      }
    }

    const to = getGmailHeader(msg.payload.headers, 'To') || ''
    const cc = getGmailHeader(msg.payload.headers, 'Cc') || ''

    for (const recipientField of [to, cc]) {
      for (const recipient of recipientField.split(',')) {
        const email = extractEmailAddr(recipient.trim())
        if (email && !OWNER_CONFIG.emails.some(e => email.includes(e.split('@')[0])) && email.includes('@')) {
          const displayName = extractDispName(recipient.trim())
          if (!participantEmails.has(email)) {
            participantEmails.set(email, { displayName, email })
          }
        }
      }
    }
  }

  const dbThreadId = `gmail:${thread.id}`
  const threadUrl = `https://mail.google.com/mail/u/0/#inbox/${thread.id}`
  const participantIds: string[] = [ownerId]

  if (!dryRun) {
    // Create/update people records for participants
    for (const [email, info] of participantEmails) {
      const personId = createPersonId(info.displayName, email)
      if (!personId || personId === ownerId) continue

      participantIds.push(personId)

      const existing = db.query(`SELECT id, identifiers FROM people WHERE id = ?`).get(personId) as { id: string; identifiers: string } | null
      if (!existing) {
        db.query(`
          INSERT INTO people (id, display_name, identifiers, first_seen, last_seen, thread_count)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(
          personId,
          info.displayName || email.split('@')[0],
          JSON.stringify([email]),
          startedAt,
          lastActivityAt
        )
      } else {
        const existingIdentifiers = JSON.parse(existing.identifiers || '[]') as string[]
        if (!existingIdentifiers.includes(email)) {
          existingIdentifiers.push(email)
          db.query(`
            UPDATE people SET identifiers = ?, last_seen = MAX(last_seen, ?), thread_count = thread_count + 1
            WHERE id = ?
          `).run(JSON.stringify(existingIdentifiers), lastActivityAt, personId)
        } else {
          db.query(`
            UPDATE people SET last_seen = MAX(last_seen, ?), thread_count = thread_count + 1
            WHERE id = ?
          `).run(lastActivityAt, personId)
        }
      }
    }

    // Create or update thread
    if (isUpdate) {
      db.query(`
        UPDATE threads SET
          last_activity_at = ?,
          message_count = ?,
          my_message_count = ?,
          participant_ids = ?
        WHERE id = ?
      `).run(
        lastActivityAt,
        nonDraftMessages.length,
        myMessageCount,
        JSON.stringify(participantIds),
        dbThreadId
      )
    } else {
      db.query(`
        INSERT INTO threads (id, source, source_thread_id, source_url, subject, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type)
        VALUES (?, 'gmail', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        dbThreadId,
        thread.id,
        threadUrl,
        subject,
        startedAt,
        lastActivityAt,
        nonDraftMessages.length,
        myMessageCount,
        JSON.stringify(participantIds),
        participantIds.length > 2 ? 'group' : '1:1'
      )
    }

    // Create messages (skip existing ones for updates)
    for (let i = 0; i < nonDraftMessages.length; i++) {
      const msg = nonDraftMessages[i]
      const messageId = `gmail:${msg.id}`

      // For updates, skip messages that already exist
      if (isUpdate) {
        const existingMsg = db.query(`SELECT id FROM messages WHERE id = ?`).get(messageId)
        if (existingMsg) continue
      }

      const from = getGmailHeader(msg.payload.headers, 'From') || ''
      const fromEmail = extractEmailAddr(from)
      const isFromMe = OWNER_CONFIG.emails.some(e => fromEmail.includes(e.split('@')[0])) || false /* removed: surname check */
      const senderId = isFromMe ? ownerId : createPersonId(extractDispName(from), fromEmail)

      const to = getGmailHeader(msg.payload.headers, 'To') || ''
      const cc = getGmailHeader(msg.payload.headers, 'Cc') || ''
      const bcc = getGmailHeader(msg.payload.headers, 'Bcc') || ''

      let content = extractGmailBody(msg)
      if (isFromMe) {
        content = stripQuotedContent(content)
      }

      const timestamp = timestamps[i]

      const inReplyTo = getGmailHeader(msg.payload.headers, 'In-Reply-To')
      let replyToMessageId: string | null = null
      if (inReplyTo && i > 0) {
        for (let j = i - 1; j >= 0; j--) {
          const prevMsgId = getGmailHeader(nonDraftMessages[j].payload.headers, 'Message-ID')
          if (prevMsgId === inReplyTo) {
            replyToMessageId = `gmail:${nonDraftMessages[j].id}`
            break
          }
        }
      }

      db.query(`
        INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, reply_to_message_id, recipients, word_count, raw_json)
        VALUES (?, ?, 'gmail', ?, ?, ?, ?, ?, ?, 'email', ?, ?, ?, ?)
      `).run(
        messageId,
        dbThreadId,
        msg.id,
        timestamp,
        i + 1,
        senderId || ownerId,
        isFromMe ? 1 : 0,
        content,
        replyToMessageId,
        JSON.stringify({
          to: to.split(',').map(s => s.trim()).filter(Boolean),
          cc: cc.split(',').map(s => s.trim()).filter(Boolean),
          bcc: bcc.split(',').map(s => s.trim()).filter(Boolean)
        }),
        content.split(/\s+/).filter(Boolean).length,
        JSON.stringify({
          headers: msg.payload.headers.filter(h =>
            ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'In-Reply-To'].includes(h.name)
          ),
          snippet: msg.snippet,
          labelIds: msg.labelIds
        })
      )
    }
  }

  return { timestamp: lastActivityAt }
}

async function extractGmail(opts: {
  query: string
  fromDate?: string
  toDate?: string
  limit?: number
  dryRun: boolean
}): Promise<ExtractionResult> {
  await load_env()

  const accessToken = await getGmailAccessToken()
  if (!accessToken) {
    console.error('Error: Gmail authentication required')
    console.error('Re-run extraction to authenticate (triggers the device auth flow): bun tools/deep-context.ts extract gmail')
    return { count: 0, newest: null, oldest: null }
  }

  console.log('\n=== Gmail Extraction ===')

  // Build search query
  let searchQuery = opts.query
  if (opts.fromDate) {
    searchQuery += ` after:${opts.fromDate.replace(/-/g, '/')}`
  }
  if (opts.toDate) {
    searchQuery += ` before:${opts.toDate.replace(/-/g, '/')}`
  }

  console.log(`Search query: ${searchQuery}`)
  if (opts.limit) console.log(`Limit: ${opts.limit} threads`)
  if (opts.dryRun) console.log('[DRY RUN]')

  const db = new Database(DB_PATH)
  // Enable WAL mode and busy timeout for better concurrency
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000;')

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
  let updated = 0
  let consecutiveSkips = 0
  const MAX_CONSECUTIVE_SKIPS = 200
  let newestTimestamp: string | null = null
  let oldestTimestamp: string | null = null
  let pageToken: string | undefined
  let pageCount = 0
  const MAX_PAGES = 500

  try {
    do {
      pageCount++

      const searchResult = await gmailSearchThreads(accessToken, searchQuery, pageToken)
      if (!searchResult || !searchResult.threads || searchResult.threads.length === 0) {
        if (extracted === 0 && pageCount === 1) {
          console.log('No threads found matching search query')
        }
        break
      }

      if (pageCount === 1) {
        console.log(`Estimated total: ~${searchResult.resultSizeEstimate || 'unknown'} threads`)
      }
      console.log(`\nPage ${pageCount}: ${searchResult.threads.length} threads`)

      for (const threadStub of searchResult.threads) {
        if (opts.limit && extracted >= opts.limit) {
          pageToken = undefined
          break
        }

        const dbThreadId = `gmail:${threadStub.id}`
        const existing = db.query(`SELECT id, message_count FROM threads WHERE id = ?`).get(dbThreadId) as { id: string; message_count: number } | null

        const thread = await gmailGetThread(accessToken, threadStub.id)
        if (!thread || !thread.messages || thread.messages.length === 0) {
          console.log(`  Warning: Empty thread ${threadStub.id}`)
          continue
        }

        // Filter out drafts
        const nonDraftMessages = thread.messages.filter(m => !m.labelIds?.includes('DRAFT'))

        const isUpdate = existing !== null
        if (isUpdate) {
          // Thread exists - check if there are new messages
          if (nonDraftMessages.length <= existing.message_count) {
            skipped++
            consecutiveSkips++
            continue
          }
        }

        const result = await processGmailThread(db, thread, ownerId, opts.dryRun, isUpdate)

        if (result) {
          consecutiveSkips = 0
          if (isUpdate) {
            updated++
          } else {
            extracted++
          }
          if (!newestTimestamp || result.timestamp > newestTimestamp) newestTimestamp = result.timestamp
          if (!oldestTimestamp || result.timestamp < oldestTimestamp) oldestTimestamp = result.timestamp
        }

        const total = extracted + updated
        if (total % 100 === 0 && total > 0) {
          console.log(`  Progress: ${formatNumber(total)} threads processed`)
        }
      }

      pageToken = searchResult.nextPageToken

      // Early termination: if we've seen many consecutive unchanged threads, stop
      if (consecutiveSkips >= MAX_CONSECUTIVE_SKIPS) {
        console.log(`\n  Early stop: ${consecutiveSkips} consecutive unchanged threads — no more new activity`)
        break
      }

      // Rate limiting (pattern from write_as_me)
      if (pageToken) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    } while (pageToken && pageCount < MAX_PAGES && (!opts.limit || extracted < opts.limit))

    console.log(`\nNew: ${formatNumber(extracted)}, Updated: ${formatNumber(updated)}, Unchanged: ${formatNumber(skipped)}`)
    return { count: extracted, newest: newestTimestamp, oldest: oldestTimestamp }
  } finally {
    db.close()
  }
}

// ============================================================
// EXPORTS (for use by deep-context.ts patch-html-emails)
// ============================================================

export { convertHtmlToText, extractGmail }

// ============================================================
// CLI
// ============================================================

const USAGE = `
gmail-extractor — Extract Gmail threads for Deep Context

USAGE:
  gmail-extractor [options]

OPTIONS:
  --query, -q QUERY    Gmail search query (default: "from:me")
  --from DATE          Start date (YYYY-MM-DD)
  --to DATE            End date (YYYY-MM-DD)
  --limit, -l N        Maximum threads to extract
  --dry-run            Preview without writing to database
  --help, -h           Show this help

EXAMPLES:
  # Extract all sent emails (default)
  gmail-extractor

  # Extract sent emails from 2025
  gmail-extractor --from 2025-01-01 --to 2025-12-31

  # Extract flight reservations
  gmail-extractor -q "category:reservations subject:flight"

  # Extract purchase receipts
  gmail-extractor -q "category:purchases"

  # Preview first 10 threads
  gmail-extractor --limit 10 --dry-run
`

async function main() {
  const args = process.argv.slice(2)

  if (args.includes('--help') || args.includes('-h')) {
    console.log(USAGE)
    process.exit(0)
  }

  const getArg = (flags: string[]): string | undefined => {
    for (const flag of flags) {
      const idx = args.indexOf(flag)
      if (idx !== -1 && idx + 1 < args.length) {
        return args[idx + 1]
      }
    }
    return undefined
  }

  const query = getArg(['--query', '-q']) || 'from:me'
  const fromDate = getArg(['--from'])
  const toDate = getArg(['--to'])
  const limitStr = getArg(['--limit', '-l'])
  const limit = limitStr ? parseInt(limitStr, 10) : undefined
  const dryRun = args.includes('--dry-run')

  const result = await extractGmail({ query, fromDate, toDate, limit, dryRun })

  console.log('\n=== Summary ===')
  console.log(`Threads extracted: ${result.count}`)
  if (result.newest) console.log(`Newest: ${result.newest}`)
  if (result.oldest) console.log(`Oldest: ${result.oldest}`)
}

// Only run CLI if this file is executed directly (not imported as a module)
if (import.meta.main) {
  main().catch(err => {
    console.error('Error:', err.message)
    process.exit(1)
  })
}
