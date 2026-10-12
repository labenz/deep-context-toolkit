#!/usr/bin/env bun

// Beeper CLI tool for querying messages across all connected services.
// Uses the Beeper Desktop API (localhost:23373).
//
// IMPORTANT: Privacy rules are enforced - see beeper-config.json for excluded contacts.

export const name = 'beeper'
export const description = 'Query messages from Beeper Desktop across iMessage, WhatsApp, Signal, and other services'

import * as fs from 'node:fs'
import * as path from 'node:path'
import { print_help } from './_lib/cli'
import { type LoadedEnv, PROJECT_ROOT, load_env as shared_load_env } from './_lib/env'

const BEEPER_API_BASE = 'http://localhost:23373'

// Normalize chat IDs - shell may escape ! to \! due to history expansion
function normalizeChatId(chatId: string): string {
  return chatId.replace(/\\!/g, '!')
}

// Encode chat IDs for URL paths - encodeURIComponent doesn't encode ! but Beeper needs it encoded
function encodeChatId(chatId: string): string {
  const normalized = normalizeChatId(chatId)
  return encodeURIComponent(normalized).replace(/!/g, '%21')
}

type ExitCode = typeof ExitCode
const ExitCode = {
  SUCCESS: 0,
  GENERIC_UNKNOWN: 1,
  BAD_USAGE: 2,
  NOT_FOUND: 3,
  CONNECTION_ERROR: 4,
  AUTH_ERROR: 5,
} as const

function die(msg: string, code: number = ExitCode.GENERIC_UNKNOWN): never {
  console.error(msg)
  process.exit(code)
}

// --- Config loading -----------------------------------------------------------

interface ExclusionRule {
  identifiers: string[]
  service?: string
  mode?: 'entire_chat' | 'messages_only'
  reason?: string
}

interface BeeperConfig {
  excludedContacts: ExclusionRule[]
  writeWhitelist: Array<{ contact: string; services: string[] }>
}

// Get the directory where this script lives
const SCRIPT_DIR = path.dirname(Bun.main)

function loadConfig(): BeeperConfig {
  // Documented location is data/deep_context/beeper-config.json; tools/beeper-config.json (next to
  // this script) is still honored for older installs. Accepts both the template's
  // `excluded_contacts: [{ name }]` shape and the older `excludedContacts: [{ identifiers }]` shape.
  const candidates = [
    path.join(SCRIPT_DIR, '..', 'data', 'deep_context', 'beeper-config.json'),
    path.join(SCRIPT_DIR, 'beeper-config.json'),
  ]
  for (const configPath of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
      const rules = (raw.excludedContacts ?? raw.excluded_contacts ?? []) as Array<Record<string, any>>
      return {
        excludedContacts: rules
          .map(r => ({ ...r, identifiers: Array.isArray(r.identifiers) ? r.identifiers : (r.name ? [r.name] : []) }))
          .filter(r => r.identifiers.length > 0) as ExclusionRule[],
        writeWhitelist: raw.writeWhitelist ?? [],
      }
    } catch {
      // missing or unreadable; try the next location
    }
  }
  return { excludedContacts: [], writeWhitelist: [] }
}

const CONFIG = loadConfig()

// --- Privacy enforcement ------------------------------------------------------

// Check if a string matches any identifier in an exclusion rule
function matchesIdentifier(value: string | undefined | null, identifiers: string[]): boolean {
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

// Check if a chat matches any exclusion rule (returns the rule if matched)
function getExclusionRuleForChat(chat: Record<string, unknown>): ExclusionRule | null {
  const chatName = (chat.name || chat.title) as string | undefined
  const network = (chat.network as string | undefined) || ''

  // Get all text identifiers from the chat (title, participant names, phone numbers, emails)
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

  for (const rule of CONFIG.excludedContacts) {
    // Check service restriction
    if (rule.service && !network.toLowerCase().includes(rule.service.toLowerCase())) {
      continue
    }

    // Check if any chat identifier matches any rule identifier
    for (const chatId of chatIdentifiers) {
      if (matchesIdentifier(chatId, rule.identifiers)) {
        return rule
      }
    }
  }

  return null
}

// Filter chats based on exclusion rules
function filterExcludedChats<T extends Record<string, unknown>>(
  chats: T[],
  _service?: string
): T[] {
  return chats.filter(chat => {
    const rule = getExclusionRuleForChat(chat)
    return rule === null  // Keep chat if no exclusion rule matches
  })
}

// Check if a chat ID belongs to an excluded chat (for message filtering)
// This requires the chat info to be passed or fetched
function isChatExcluded(chatInfo: Record<string, unknown> | null): boolean {
  if (!chatInfo) return false
  return getExclusionRuleForChat(chatInfo) !== null
}

// --- Env loading --------------------------------------------------------------

let _cached_env: LoadedEnv | null = null

async function load_env(): Promise<LoadedEnv> {
  if (_cached_env) return _cached_env
  _cached_env = await shared_load_env().catch(() => ({} as LoadedEnv))
  return _cached_env
}

function env_get(name: string): string | undefined {
  if (_cached_env && _cached_env[name]) return _cached_env[name]
  return process.env[name] || Bun.env[name]
}

async function getToken(): Promise<string> {
  await load_env()
  const token = env_get('BEEPER_ACCESS_TOKEN') || env_get('BEEPER_TOKEN')
  if (!token) {
    die(`Error: Missing BEEPER_ACCESS_TOKEN. Create a token in Beeper Desktop:
  Settings → Developers → click '+' next to 'Approved connections'
Then add to tools/.env:
  BEEPER_ACCESS_TOKEN=your_token_here`, ExitCode.AUTH_ERROR)
  }
  return token
}

// --- API helpers --------------------------------------------------------------

async function beeperApi<T>(
  endpoint: string,
  options: { method?: string; body?: unknown; token: string }
): Promise<T> {
  const url = `${BEEPER_API_BASE}${endpoint}`

  try {
    const res = await fetch(url, {
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${options.token}`,
        'Content-Type': 'application/json',
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    })

    if (!res.ok) {
      if (res.status === 401) {
        die('Error: Beeper authentication failed. Check your BEEPER_ACCESS_TOKEN.', ExitCode.AUTH_ERROR)
      }
      const text = await res.text().catch(() => '')
      die(`Error: Beeper API error: HTTP ${res.status}${text ? ` - ${text}` : ''}`, ExitCode.GENERIC_UNKNOWN)
    }

    return await res.json() as T
  } catch (err) {
    if (err instanceof Error && err.message.includes('ECONNREFUSED')) {
      die(`Error: Cannot connect to Beeper Desktop API at ${BEEPER_API_BASE}.
Make sure Beeper Desktop is running and the API is enabled:
  Settings → Developers → Toggle "Beeper Desktop API" ON`, ExitCode.CONNECTION_ERROR)
    }
    throw err
  }
}

// --- Types --------------------------------------------------------------------

interface Account {
  accountID: string
  network: string
  user?: {
    id: string
    fullName?: string
    displayText?: string
    username?: string
    email?: string
    phoneNumber?: string
  }
}

interface ChatParticipant {
  id: string
  fullName?: string
  displayText?: string
  displayName?: string
}

interface Chat {
  id: string
  chatID?: string
  name?: string
  title?: string
  displayText?: string
  service?: string
  network?: string
  type?: string
  participants?: { items?: ChatParticipant[] } | ChatParticipant[]
  lastMessageAt?: string
  lastActivity?: string
  lastMessage?: { timestamp?: string }
  isGroup?: boolean
  isDM?: boolean
}

interface Message {
  id: string
  messageID?: string
  chatId?: string
  chatID?: string
  text?: string
  body?: string
  timestamp?: string
  sentAt?: string
  sender?: {
    id: string
    fullName?: string
    displayText?: string
    displayName?: string
  }
  service?: string
  network?: string
}

interface SearchResult {
  chats?: Chat[]
  messages?: Message[]
}

// --- CLI ----------------------------------------------------------------------

function usage(): string {
  return `
beeper - Query messages from Beeper Desktop

USAGE:
  beeper accounts                              List connected services
  beeper chats [--search <query>] [--service <name>] [--limit N]
                                               List or search chats
  beeper messages <chat-id> [--limit N] [--before <date>] [--after <date>]
                                               Get messages from a chat
  beeper search <query> [--service <name>] [--limit N]
                                               Search all messages
  beeper export <chat-id-or-name> [--format md|json] [--output PATH] [--since DATE]
                                               Export chat for context creation
  beeper export-batch --contacts "Name1,Name2" [--output-dir DIR]
                                               Batch export multiple contacts

OPTIONS:
  -h, --help              Show this help
  --json                  Output as JSON
  --limit, -l <n>         Limit results (default: 50)
  --search, -s <query>    Search query
  --service <name>        Filter by service (iMessage, WhatsApp, Signal, etc.)
  --before <date>         Messages before date (ISO format)
  --after <date>          Messages after date (ISO format)
  --since <date>          Alias for --after
  --format <md|json>      Export format (default: md)
  --output, -o <path>     Output file path
  --output-dir <dir>      Output directory for batch exports
  --contacts <names>      Comma-separated contact names for batch export

ENVIRONMENT:
  BEEPER_ACCESS_TOKEN     API token from Beeper Desktop (required)

SETUP:
  1. Open Beeper Desktop
  2. Go to Settings → Developers
  3. Toggle "Beeper Desktop API" ON
  4. Click '+' next to 'Approved connections' to create a token
  5. Add to tools/.env:
     BEEPER_ACCESS_TOKEN=your_token_here

PRIVACY:
  Certain contacts are excluded from all queries (see beeper-config.json).

NOTES:
  - Chat IDs containing '!' may be shell-escaped to '\\!' - the tool handles this automatically
  - The --service filter searches within network names (e.g., "Signal", "WhatsApp", "iMessage")
  - Use --json for programmatic output
`
}

interface Args {
  cmd: string
  chatId?: string
  query?: string
  search?: string
  service?: string
  limit?: number
  before?: string
  after?: string
  json?: boolean
  format?: 'md' | 'json'
  output?: string
  outputDir?: string
  contacts?: string[]
}

function parse_args(argv: string[]): Args {
  const cmd = argv[0]
  if (!cmd || cmd === '-h' || cmd === '--help') {
    print_help('beeper', usage())
    process.exit(cmd ? ExitCode.SUCCESS : ExitCode.BAD_USAGE)
  }

  const out: Partial<Args> = { cmd }
  let i = 1

  // Positional arguments based on command
  if (cmd === 'messages' || cmd === 'export') {
    if (argv[i] && !argv[i].startsWith('--')) {
      out.chatId = argv[i]
      i += 1
    }
  }

  if (cmd === 'search') {
    if (argv[i] && !argv[i].startsWith('--')) {
      out.query = argv[i]
      i += 1
    }
  }

  while (i < argv.length) {
    const a = argv[i]
    const next = () => (i + 1 < argv.length ? argv[i + 1] : undefined)

    if (a === '-h' || a === '--help') {
      print_help('beeper', usage())
      process.exit(ExitCode.SUCCESS)
    }

    if (a === '--json') {
      out.json = true
      i += 1
      continue
    }

    if (a === '--search' || a === '-s') {
      const v = next()
      if (!v) die('Error: --search requires a value', ExitCode.BAD_USAGE)
      out.search = v
      i += 2
      continue
    }

    if (a === '--service') {
      const v = next()
      if (!v) die('Error: --service requires a value', ExitCode.BAD_USAGE)
      out.service = v
      i += 2
      continue
    }

    if (a === '--limit' || a === '-l') {
      const v = next()
      if (!v) die('Error: --limit requires a value', ExitCode.BAD_USAGE)
      const n = Number(v)
      if (!Number.isFinite(n) || n <= 0) die('Error: --limit must be a positive number', ExitCode.BAD_USAGE)
      out.limit = Math.floor(n)
      i += 2
      continue
    }

    if (a === '--before') {
      const v = next()
      if (!v) die('Error: --before requires a value', ExitCode.BAD_USAGE)
      out.before = v
      i += 2
      continue
    }

    if (a === '--after' || a === '--since') {
      const v = next()
      if (!v) die(`Error: ${a} requires a value`, ExitCode.BAD_USAGE)
      out.after = v
      i += 2
      continue
    }

    if (a === '--format') {
      const v = next()
      if (!v || (v !== 'md' && v !== 'json')) die('Error: --format must be md or json', ExitCode.BAD_USAGE)
      out.format = v
      i += 2
      continue
    }

    if (a === '--output' || a === '-o') {
      const v = next()
      if (!v) die('Error: --output requires a value', ExitCode.BAD_USAGE)
      out.output = v
      i += 2
      continue
    }

    if (a === '--output-dir') {
      const v = next()
      if (!v) die('Error: --output-dir requires a value', ExitCode.BAD_USAGE)
      out.outputDir = v
      i += 2
      continue
    }

    if (a === '--contacts') {
      const v = next()
      if (!v) die('Error: --contacts requires a value', ExitCode.BAD_USAGE)
      out.contacts = v.split(',').map(s => s.trim()).filter(Boolean)
      i += 2
      continue
    }

    die(`Error: unknown argument: ${a}`, ExitCode.BAD_USAGE)
  }

  return out as Args
}

// --- Commands -----------------------------------------------------------------

async function cmd_accounts(a: Args) {
  const token = await getToken()
  const accounts = await beeperApi<Account[]>('/v1/accounts', { token })

  if (a.json) {
    console.log(JSON.stringify(accounts, null, 2))
    return
  }

  console.log(`# Connected Accounts (${accounts.length})`)
  for (const acc of accounts) {
    const name = acc.user?.displayText || acc.user?.fullName || acc.user?.username || acc.accountID
    console.log(`- ${acc.network}: ${name}`)
  }
}

async function cmd_chats(a: Args) {
  const token = await getToken()

  let endpoint = '/v1/chats'
  const params = new URLSearchParams()

  if (a.search) {
    endpoint = '/v1/chats/search'
    params.set('query', a.search)
  }
  if (a.service) params.set('network', a.service)
  if (a.limit) params.set('limit', String(a.limit))

  const url = params.toString() ? `${endpoint}?${params}` : endpoint
  const response = await beeperApi<{ items?: Chat[]; chats?: Chat[] } | Chat[]>(url, { token })

  // Handle various response formats
  const rawChats = Array.isArray(response)
    ? response
    : (response as { items?: Chat[]; chats?: Chat[] }).items || (response as { chats?: Chat[] }).chats || []

  // Apply privacy filter
  const chats = filterExcludedChats(rawChats, a.service)

  if (a.json) {
    console.log(JSON.stringify(chats, null, 2))
    return
  }

  console.log(`# Chats (${chats.length})`)
  for (const chat of chats as Array<Chat & { title?: string; type?: string; lastActivity?: string }>) {
    const name = chat.title || chat.name || chat.displayText || chat.id
    const meta: string[] = []
    if (chat.network || chat.service) meta.push(chat.network || chat.service || '')
    if (chat.type === 'group' || chat.isGroup) meta.push('group')
    const lastTime = chat.lastActivity || chat.lastMessageAt || chat.lastMessage?.timestamp
    if (lastTime) meta.push(`last: ${lastTime.slice(0, 10)}`)
    console.log(`- ${name} [${meta.join(', ')}] (ID: ${chat.id})`)
  }
}

async function cmd_messages(a: Args) {
  if (!a.chatId) die('Error: Usage: beeper messages <chat-id>', ExitCode.BAD_USAGE)

  const token = await getToken()

  // First, fetch chat info to check if it's excluded
  const encodedChatId = encodeChatId(a.chatId)
  try {
    const chatInfo = await beeperApi<Record<string, unknown>>(`/v1/chats/${encodedChatId}`, { token })
    if (isChatExcluded(chatInfo)) {
      if (a.json) {
        console.log(JSON.stringify([]))
      } else {
        console.log('# Messages (0)')
        console.log('(Chat excluded by privacy filter)')
      }
      return
    }
  } catch {
    // If we can't fetch chat info, proceed but filter messages individually
  }

  const params = new URLSearchParams()
  if (a.limit) params.set('limit', String(a.limit))
  // Numeric --before/--after = a message sortKey → Beeper's cursor pagination (date filters are ignored by the API)
  if (a.before && /^\d+$/.test(a.before)) { params.set('cursor', a.before); params.set('direction', 'before') }
  else if (a.before) params.set('before', a.before)
  if (a.after && /^\d+$/.test(a.after)) { params.set('cursor', a.after); params.set('direction', 'after') }
  else if (a.after) params.set('after', a.after)

  const url = `/v1/chats/${encodedChatId}/messages${params.toString() ? `?${params}` : ''}`
  const response = await beeperApi<{ items?: Message[] } | Message[]>(url, { token })

  const messages = Array.isArray(response) ? response : (response as { items?: Message[] }).items || []

  if (a.json) {
    console.log(JSON.stringify(messages, null, 2))
    return
  }

  console.log(`# Messages (${messages.length})`)
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    const sender = (m.senderName || 'unknown') as string
    const time = m.timestamp ? new Date(m.timestamp as string).toISOString() : ''
    const text = ((m.text || '') as string).slice(0, 200)
    console.log(`- [${time}] ${sender}: ${text}${text.length >= 200 ? '...' : ''}`)
  }
}

async function cmd_search(a: Args) {
  if (!a.query) die('Error: Usage: beeper search <query>', ExitCode.BAD_USAGE)

  const token = await getToken()

  const params = new URLSearchParams()
  params.set('query', a.query)
  if (a.service) params.set('network', a.service)
  if (a.limit) params.set('limit', String(a.limit))

  const url = `/v1/messages/search?${params}`
  const response = await beeperApi<{ items?: Message[]; chats?: Record<string, Record<string, unknown>> }>(url, { token })

  const rawMessages = (response as { items?: Message[] }).items || []
  const chatsMetadata = (response as { chats?: Record<string, Record<string, unknown>> }).chats || {}

  // Build set of excluded chat IDs using full chat metadata
  const excludedChatIds = new Set<string>()
  for (const [chatId, chatInfo] of Object.entries(chatsMetadata)) {
    if (isChatExcluded(chatInfo)) {
      excludedChatIds.add(chatId)
    }
  }

  // Filter messages from excluded chats
  const messages = rawMessages.filter(msg => {
    const m = msg as Record<string, unknown>
    const chatId = (m.chatID || m.chatId) as string | undefined
    return !chatId || !excludedChatIds.has(chatId)
  })

  if (a.json) {
    console.log(JSON.stringify(messages, null, 2))
    return
  }

  console.log(`# Search Results for "${a.query}" (${messages.length})`)
  for (const msg of messages) {
    const m = msg as Record<string, unknown>
    const chatId = (m.chatID || m.chatId) as string | undefined
    const chatInfo = chatId ? chatsMetadata[chatId] : null
    const senderName = (m.senderName || 'unknown') as string
    const time = m.timestamp ? new Date(m.timestamp as string).toISOString() : ''
    const network = (chatInfo?.network || m.network || '') as string
    const text = ((m.text || m.body || '') as string).slice(0, 150)
    console.log(`- [${time}] [${network}] ${senderName}: ${text}${text.length >= 150 ? '...' : ''}`)
  }
}

async function cmd_export(a: Args) {
  if (!a.chatId) die('Error: Usage: beeper export <chat-id-or-name>', ExitCode.BAD_USAGE)

  const token = await getToken()
  const format = a.format || 'md'

  // First, try to find the chat by ID or name
  let chatId = a.chatId
  let chatInfo: Chat | null = null

  // Try direct ID first
  try {
    const response = await beeperApi<{ messages: Message[] } | Message[]>(
      `/v1/chats/${encodeChatId(chatId)}/messages?limit=1`,
      { token }
    )
    // If we got here, the chat exists
    chatInfo = { id: chatId, name: a.chatId, service: 'unknown' }
  } catch {
    // Try searching by name
    const searchResponse = await beeperApi<{ chats: Chat[] } | Chat[]>(
      `/v1/chats/search?query=${encodeURIComponent(a.chatId)}`,
      { token }
    )
    const chats = Array.isArray(searchResponse) ? searchResponse : searchResponse.chats || []
    const filtered = filterExcludedChats(chats)

    if (filtered.length === 0) {
      die(`Error: Chat not found: ${a.chatId}`, ExitCode.NOT_FOUND)
    }

    chatInfo = filtered[0]
    chatId = chatInfo.id
  }

  // Get all messages
  const params = new URLSearchParams()
  params.set('limit', String(a.limit || 1000))
  if (a.after) params.set('after', a.after)

  const messagesResponse = await beeperApi<{ messages: Message[] } | Message[]>(
    `/v1/chats/${encodeChatId(chatId)}/messages?${params}`,
    { token }
  )

  const rawMessages = Array.isArray(messagesResponse) ? messagesResponse : messagesResponse.messages || []
  const messages = filterExcludedMessages(rawMessages)

  // Sort by timestamp (oldest first)
  messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())

  const chatName = chatInfo?.name || chatInfo?.participants?.map(p => p.displayName || p.id).join(', ') || chatId

  if (format === 'json') {
    const output = {
      chat: chatInfo,
      messages,
      exportedAt: new Date().toISOString(),
      totalMessages: messages.length,
    }

    if (a.output) {
      const dir = path.dirname(a.output)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(a.output, JSON.stringify(output, null, 2))
      console.log(`Exported ${messages.length} messages to ${a.output}`)
    } else {
      console.log(JSON.stringify(output, null, 2))
    }
    return
  }

  // Markdown format
  const lines: string[] = []
  lines.push(`# Relationship Context: ${chatName}`)
  lines.push('')
  lines.push('## Overview')
  lines.push(`- Service: ${chatInfo?.service || 'Unknown'}`)
  if (messages.length > 0) {
    lines.push(`- First message: ${new Date(messages[0].timestamp).toISOString().slice(0, 10)}`)
    lines.push(`- Last message: ${new Date(messages[messages.length - 1].timestamp).toISOString().slice(0, 10)}`)
  }
  lines.push(`- Total messages: ${messages.length}`)
  lines.push(`- Exported: ${new Date().toISOString()}`)
  lines.push('')
  lines.push('## Conversation')
  lines.push('')

  // Group by date
  const byDate = new Map<string, Message[]>()
  for (const msg of messages) {
    const date = new Date(msg.timestamp).toISOString().slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date)!.push(msg)
  }

  for (const [date, dateMessages] of byDate) {
    lines.push(`### ${date}`)
    lines.push('')
    for (const msg of dateMessages) {
      const sender = msg.sender?.displayName || msg.sender?.id || 'unknown'
      const time = new Date(msg.timestamp).toISOString().slice(11, 16)
      const text = msg.text || ''
      lines.push(`**${time} ${sender}:** ${text}`)
      lines.push('')
    }
  }

  const content = lines.join('\n')

  if (a.output) {
    const dir = path.dirname(a.output)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(a.output, content)
    console.log(`Exported ${messages.length} messages to ${a.output}`)
  } else {
    console.log(content)
  }
}

async function cmd_export_batch(a: Args) {
  if (!a.contacts || a.contacts.length === 0) {
    die('Error: Usage: beeper export-batch --contacts "Name1,Name2" [--output-dir DIR]', ExitCode.BAD_USAGE)
  }

  const token = await getToken()
  const outputDir = a.outputDir || path.join(PROJECT_ROOT, 'context', 'relationships')

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }

  console.log(`Exporting ${a.contacts.length} contacts to ${outputDir}...`)

  for (const contactName of a.contacts) {
    // Check privacy filter
    if (isExcludedContact(contactName)) {
      console.log(`Skipping ${contactName} (excluded by privacy rules)`)
      continue
    }

    console.log(`Searching for: ${contactName}`)

    try {
      const searchResponse = await beeperApi<{ chats: Chat[] } | Chat[]>(
        `/v1/chats/search?query=${encodeURIComponent(contactName)}`,
        { token }
      )
      const chats = Array.isArray(searchResponse) ? searchResponse : searchResponse.chats || []
      const filtered = filterExcludedChats(chats)

      if (filtered.length === 0) {
        console.log(`  No chats found for: ${contactName}`)
        continue
      }

      const chat = filtered[0]
      const safeName = contactName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
      const outputPath = path.join(outputDir, `${safeName}.md`)

      // Get messages
      const messagesResponse = await beeperApi<{ messages: Message[] } | Message[]>(
        `/v1/chats/${encodeChatId(chat.id)}/messages?limit=${a.limit || 500}`,
        { token }
      )
      const rawMessages = Array.isArray(messagesResponse) ? messagesResponse : messagesResponse.messages || []
      const messages = filterExcludedMessages(rawMessages)

      // Create export
      const a_export: Args = {
        cmd: 'export',
        chatId: chat.id,
        format: 'md',
        output: outputPath,
        limit: a.limit,
        after: a.after,
      }

      await cmd_export(a_export)

    } catch (err) {
      console.log(`  Error exporting ${contactName}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  console.log(`Done. Exports saved to: ${outputDir}`)
}

// --- Main ---------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    print_help('beeper', usage())
    if (argv.length === 0) process.exit(ExitCode.BAD_USAGE)
    process.exit(ExitCode.SUCCESS)
  }

  const a = parse_args(argv)

  switch (a.cmd) {
    case 'accounts':
      return await cmd_accounts(a)
    case 'chats':
      return await cmd_chats(a)
    case 'messages':
      return await cmd_messages(a)
    case 'search':
      return await cmd_search(a)
    case 'export':
      return await cmd_export(a)
    case 'export-batch':
      return await cmd_export_batch(a)
    default:
      print_help('beeper', usage())
      die(`Error: unknown command: ${a.cmd}`, ExitCode.BAD_USAGE)
  }
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
