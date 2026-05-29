#!/usr/bin/env bun

// Calls CSV CLI - Structured search, update, and analysis for calls.csv
// Manages Fireflies meeting transcripts and AI-generated summaries

import { parse } from 'csv-parse/sync'
import { stringify } from 'csv-stringify/sync'
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs'
import { parse_flags, print_help, type ParsedArgs } from './_lib/cli'
import { dirname, join, basename } from 'path'
import { resolvePathOrThrow } from './_lib/paths'

const USAGE = `
calls — Fireflies meeting transcripts and summaries CLI

USAGE:
  # List calls with filters
  calls list [--limit N] [--from DATE] [--to DATE] [--has-summary] [--missing FIELD] [--json]

  # Get single call by identifier (fireflies_id, title fragment, or date)
  calls get <identifier> [--json]

  # Search calls
  calls search <query> [--fields FIELD1,FIELD2,...] [--json]

  # Update call field(s)
  calls update <identifier> --set FIELD=VALUE [--set FIELD2=VALUE2] [--dry-run]

  # Batch update from JSON file
  calls batch-update --file updates.json [--dry-run]

  # Show statistics
  calls stats [--json]

  # Find calls missing a field
  calls missing <field> [--limit N] [--from DATE] [--json]

  # Export filtered calls
  calls export --output FILE [--has-summary] [--from DATE] [--to DATE]

  # Generate AI summary for a call
  calls summarize <identifier> [--dry-run] [--force]

  # Summarize multiple calls
  calls batch-summarize [--limit N] [--from DATE] [--to DATE] [--dry-run]

  # Import/download a Fireflies transcript
  calls import <fireflies_id> [--force]

  # Sync recent Fireflies transcripts
  calls sync [--days N] [--dry-run]

  # Re-transcribe empty call via Deepgram (preserves original metadata)
  calls retranscribe <identifier> [--dry-run] [--force]

  # Batch re-transcribe empty calls via Deepgram
  calls batch-retranscribe [--limit N] [--dry-run] [--check-only]

  # Refresh transcript for a call (re-download from Fireflies)
  calls refresh <identifier> [--force]

FIELDS (for --set, --missing, search --field):
  fireflies_id, title, date, duration, duration_seconds, organizer,
  participants, speakers, transcript_url, meeting_link, summary_status,
  notes, transcript_file, summary_file, downloaded_at, summarized_at,
  tags, meeting_type

OPTIONS:
  --limit, -l N        Max results (default: all)
  --from DATE          Filter by start date (YYYY-MM-DD)
  --to DATE            Filter by end date (YYYY-MM-DD)
  --has-summary        Only calls with summary_file set
  --no-summary         Only calls without summary_file
  --missing FIELD      Only calls where FIELD is empty
  --set FIELD=VALUE    Set a field value (can be repeated)
  --fields, -f LIST    Search within specific fields (comma-separated)
                       Default: title,participants,speakers,tags
  --dry-run            Preview changes without writing
  --json               Output as JSON
  --output, -o FILE    Output file path
  --file FILE          Input file for batch operations
  --force              Overwrite existing summary/transcript
  --days N             Number of days to look back (default: 7)
  --check-only         Only check for audio availability (batch-retranscribe)

EXAMPLES:
  # Find call by title fragment
  calls get "Acme sync"

  # Search for calls with specific participant
  calls search "anthropic" --fields participants,speakers

  # List recent calls without summaries
  calls missing summary_file --limit 20

  # Update tags for a call
  calls update "01KFVCXF" --set tags="ai-safety,formal-verification,podcast-prep"

  # Generate summary for a call
  calls summarize "01KFVCXF"

  # Batch summarize recent calls
  calls batch-summarize --limit 5 --from 2026-01-01

  # Get statistics
  calls stats
`

// CSV file path
const PROJECT_ROOT = dirname(import.meta.dir)
const CSV_PATH = join(PROJECT_ROOT, 'data/calls/calls.csv')
const BACKUP_DIR = join(PROJECT_ROOT, 'data/calls/backups')
const TRANSCRIPT_DIR = join(PROJECT_ROOT, 'data/calls/transcripts')
const SUMMARY_DIR = join(PROJECT_ROOT, 'data/calls/summaries')
const SCHEMA_PATH = join(PROJECT_ROOT, 'data/calls/call-summary-schema.json')
const PROMPT_PATH = join(PROJECT_ROOT, 'data/calls/call-summary-prompt.md')

// Column definitions (order matters for writing)
const COLUMNS = [
  'fireflies_id', 'title', 'date', 'duration', 'duration_seconds', 'organizer',
  'participants', 'speakers', 'transcript_url', 'meeting_link', 'summary_status',
  'notes', 'transcript_file', 'summary_file', 'downloaded_at', 'summarized_at',
  'tags', 'meeting_type'
]

type Call = Record<string, string>

function loadCalls(): Call[] {
  if (!existsSync(CSV_PATH)) {
    console.error(`Error: calls.csv not found at ${CSV_PATH}`)
    process.exit(1)
  }
  const csv = readFileSync(CSV_PATH, 'utf8')
  return parse(csv, { columns: true, skip_empty_lines: true, relax_column_count: true })
}

// Check if a transcript file has actual content
// Returns estimated speaker turns based on file size and content patterns
function countTranscriptTurns(call: Call): number {
  const transcriptPath = call.transcript_file
    ? join(PROJECT_ROOT, 'data/calls', call.transcript_file)
    : null

  if (!transcriptPath || !existsSync(transcriptPath)) {
    return 0
  }

  // Use file size as primary indicator - files < 1KB are likely empty
  const stats = Bun.file(transcriptPath).size
  if (stats < 1000) {
    return 0
  }

  const content = readFileSync(transcriptPath, 'utf8')

  // Count speaker turns - handle both formats:
  // - Deepgram: "S0 (1:23)" or "S1 (2:34)"
  // - Fireflies: "**Speaker Name**" on its own line
  const deepgramTurns = content.split('\n').filter(line =>
    /^S\d+\s*\(/.test(line.trim())
  ).length

  const firefliesTurns = content.split('\n').filter(line =>
    /^\*\*[^*]+\*\*$/.test(line.trim())
  ).length

  return Math.max(deepgramTurns, firefliesTurns)
}

function saveCalls(calls: Call[], dryRun: boolean = false): void {
  if (dryRun) {
    console.log('[DRY RUN] Would save changes to calls.csv')
    return
  }

  // Create backup
  if (!existsSync(BACKUP_DIR)) {
    mkdirSync(BACKUP_DIR, { recursive: true })
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const backupPath = join(BACKUP_DIR, `calls_${timestamp}.csv`)
  copyFileSync(CSV_PATH, backupPath)
  console.log(`Backup created: ${backupPath}`)

  // Ensure all calls have all columns
  const normalized = calls.map(call => {
    const row: Call = {}
    for (const col of COLUMNS) {
      row[col] = call[col] || ''
    }
    return row
  })

  const output = stringify(normalized, { header: true, columns: COLUMNS })
  writeFileSync(CSV_PATH, output)
  console.log(`Saved ${calls.length} calls to calls.csv`)
}

function findCall(calls: Call[], identifier: string): Call | undefined {
  const lower = identifier.toLowerCase()
  return calls.find(call =>
    call.fireflies_id?.toLowerCase().includes(lower) ||
    call.title?.toLowerCase().includes(lower) ||
    call.date === identifier
  )
}

// Default fields to search when no --fields specified
const DEFAULT_SEARCH_FIELDS = ['title', 'participants', 'speakers', 'tags', 'notes']

function searchCalls(calls: Call[], query: string, fields?: string[]): Call[] {
  const lower = query.toLowerCase()
  const searchFields = fields && fields.length > 0 ? fields : DEFAULT_SEARCH_FIELDS
  return calls.filter(call =>
    searchFields.some(f => call[f]?.toLowerCase().includes(lower))
  )
}

function formatCall(call: Call, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(call, null, 2))
    return
  }
  console.log(`Title: ${call.title}`)
  console.log(`ID: ${call.fireflies_id}`)
  console.log(`Date: ${call.date}`)
  console.log(`Duration: ${call.duration || '(unknown)'}`)
  console.log(`Organizer: ${call.organizer || '(none)'}`)
  console.log(`Participants: ${call.participants || '(none)'}`)
  console.log(`Speakers: ${call.speakers || '(none)'}`)
  console.log(`---`)
  console.log(`Transcript: ${call.transcript_file || '(none)'}`)
  console.log(`Summary: ${call.summary_file || '(none)'}`)
  console.log(`Status: ${call.summary_status || '(none)'}`)
  console.log(`Type: ${call.meeting_type || '(none)'}`)
  console.log(`Tags: ${call.tags || '(none)'}`)
  console.log(`Notes: ${call.notes || '(none)'}`)
  if (call.transcript_url) {
    console.log(`\nFireflies: ${call.transcript_url}`)
  }
}

function formatCallList(calls: Call[], json: boolean, limit?: number): void {
  const subset = limit ? calls.slice(0, limit) : calls

  if (json) {
    console.log(JSON.stringify(subset, null, 2))
    return
  }

  for (const call of subset) {
    const speakers = call.speakers ? ` | ${call.speakers.slice(0, 40)}` : ''
    const status = call.summary_status ? ` [${call.summary_status}]` : ''
    const tags = call.tags ? ` {${call.tags.slice(0, 30)}}` : ''
    console.log(`${call.date} | ${call.title.slice(0, 50)}${speakers}${status}${tags}`)
  }

  if (limit && calls.length > limit) {
    console.log(`\n... and ${calls.length - limit} more (use --limit to show more)`)
  }
  console.log(`\nTotal: ${calls.length} calls`)
}

function getStats(calls: Call[]): Record<string, unknown> {
  const stats: Record<string, unknown> = {
    total: calls.length,
    byStatus: {} as Record<string, number>,
    withSummary: 0,
    withTranscript: 0,
    missingSummary: 0,
    missingTranscript: 0,
    totalDurationMinutes: 0,
    byMonth: {} as Record<string, number>,
  }

  for (const call of calls) {
    // By status
    const status = call.summary_status || 'unknown'
    ;(stats.byStatus as Record<string, number>)[status] = ((stats.byStatus as Record<string, number>)[status] || 0) + 1

    // Summary/transcript counts
    if (call.summary_file) (stats.withSummary as number)++
    else (stats.missingSummary as number)++

    if (call.transcript_file) (stats.withTranscript as number)++
    else (stats.missingTranscript as number)++

    // Duration
    const secs = parseInt(call.duration_seconds) || 0
    ;(stats.totalDurationMinutes as number) += Math.round(secs / 60)

    // By month
    const month = call.date?.slice(0, 7) || 'unknown'
    ;(stats.byMonth as Record<string, number>)[month] = ((stats.byMonth as Record<string, number>)[month] || 0) + 1
  }

  return stats
}

// Parse --set FIELD=VALUE arguments
function parseSetArgs(args: ParsedArgs): Map<string, string> {
  const sets = new Map<string, string>()
  const setVal = args.set
  if (!setVal) return sets

  const values = Array.isArray(setVal) ? setVal : [setVal]
  for (const v of values) {
    if (typeof v !== 'string') continue
    const idx = v.indexOf('=')
    if (idx === -1) {
      console.error(`Invalid --set format: ${v} (expected FIELD=VALUE)`)
      process.exit(1)
    }
    const field = v.slice(0, idx)
    const value = v.slice(idx + 1)
    if (!COLUMNS.includes(field)) {
      console.error(`Unknown field: ${field}`)
      console.error(`Valid fields: ${COLUMNS.join(', ')}`)
      process.exit(1)
    }
    sets.set(field, value)
  }
  return sets
}

type SummarizeResult = 'success' | 'empty' | 'error'

async function summarizeCall(call: Call, dryRun: boolean = false): Promise<SummarizeResult> {
  const transcriptPath = call.transcript_file
    ? join(PROJECT_ROOT, 'data/calls', call.transcript_file)
    : null

  if (!transcriptPath || !existsSync(transcriptPath)) {
    console.error(`No transcript file found for: ${call.title}`)
    return 'error'
  }

  // Check for empty transcript before proceeding
  const transcriptContent = readFileSync(transcriptPath, 'utf8')
  const speakerTurns = countTranscriptTurns(call)

  // Empty if explicit marker OR fewer than 5 speaker turns
  if (transcriptContent.includes('*No transcript content available.*') ||
      transcriptContent.includes('No transcript content available') ||
      speakerTurns < 5) {
    console.log(`Empty transcript (${speakerTurns} speaker turns): ${call.title}`)
    return 'empty'
  }

  // Use transcript filename (without extension) for summary files
  const transcriptBasename = basename(call.transcript_file || '', '.md')
  const jsonPath = join(SUMMARY_DIR, `${transcriptBasename}.json`)
  const mdPath = join(SUMMARY_DIR, `${transcriptBasename}.md`)

  if (dryRun) {
    console.log(`[DRY RUN] Would generate summary for: ${call.title}`)
    console.log(`  Input: ${transcriptPath}`)
    console.log(`  Output: ${jsonPath}`)
    return 'success'
  }

  // Ensure summary directory exists
  if (!existsSync(SUMMARY_DIR)) {
    mkdirSync(SUMMARY_DIR, { recursive: true })
  }

  // Load prompt (transcript already loaded above for empty check)
  const prompt = readFileSync(PROMPT_PATH, 'utf8')
  const fullPrompt = `${prompt}\n\n${transcriptContent}`

  console.log(`Generating summary for: ${call.title}`)
  console.log(`  Duration: ${call.duration}`)

  // Call Gemini with schema using Bun.spawn
  const geminiPath = join(PROJECT_ROOT, 'tools/gemini.ts')

  const proc = Bun.spawn({
    cmd: [process.execPath, geminiPath, '', '--schema', SCHEMA_PATH, '--max-tokens', '65536', '-t', '0.3'],
    stdin: new Blob([fullPrompt]),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Collect output
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    console.error(`Gemini error: ${stderr}`)
    return 'error'
  }

  // Parse JSON output (skip stderr lines)
  const jsonStart = stdout.indexOf('{')
  const jsonEnd = stdout.lastIndexOf('}')
  if (jsonStart === -1 || jsonEnd === -1) {
    console.error(`Invalid JSON response - no JSON object found`)
    console.error(`  stdout length: ${stdout.length}`)
    console.error(`  stdout preview: ${stdout.slice(0, 500)}...`)
    return 'error'
  }

  const jsonStr = stdout.slice(jsonStart, jsonEnd + 1)
  let summary: Record<string, unknown>
  try {
    summary = JSON.parse(jsonStr)
  } catch (e) {
    console.error(`Failed to parse JSON: ${(e as Error).message}`)
    console.error(`  JSON preview: ${jsonStr.slice(0, 500)}...`)
    return 'error'
  }

  // Extract metadata from summary to populate CSV
  const suggestedTags = summary.suggested_tags as string[] | undefined
  const meetingType = summary.meeting_type as string | undefined

  if (suggestedTags?.length) {
    call.tags = suggestedTags.join(', ')
  }
  if (meetingType) {
    call.meeting_type = meetingType
  }

  // Save JSON
  writeFileSync(jsonPath, JSON.stringify(summary, null, 2))

  // Generate markdown
  const md = renderSummaryMarkdown(call, summary)
  writeFileSync(mdPath, md)

  console.log(`  Saved: ${jsonPath}`)
  console.log(`  Saved: ${mdPath}`)
  if (meetingType) console.log(`  Type: ${meetingType}`)
  if (suggestedTags?.length) console.log(`  Tags: ${suggestedTags.join(', ')}`)

  return 'success'
}

function renderSummaryMarkdown(call: Call, summary: Record<string, unknown>): string {
  const lines: string[] = []

  // Header
  lines.push(`# ${call.title}`)
  lines.push('')
  lines.push(`**Date:** ${call.date}`)
  lines.push(`**Duration:** ${call.duration}`)
  if (call.speakers) lines.push(`**Speakers:** ${call.speakers}`)
  if (call.tags) lines.push(`**Tags:** ${call.tags}`)
  lines.push('')

  // Executive summary
  if (summary.executive_summary) {
    lines.push('## Executive Summary')
    lines.push('')
    lines.push(String(summary.executive_summary))
    lines.push('')
  }

  // Participants
  const participants = summary.participants as Array<{ name: string; context: string }> | undefined
  if (participants?.length) {
    lines.push('## Participants')
    lines.push('')
    for (const p of participants) {
      lines.push(`- **${p.name}**: ${p.context}`)
    }
    lines.push('')
  }

  // Topics
  const topics = summary.topics_discussed as Array<{ topic: string; summary: string; subtopics?: string[] }> | undefined
  if (topics?.length) {
    lines.push('## Topics Discussed')
    lines.push('')
    for (const t of topics) {
      lines.push(`### ${t.topic}`)
      lines.push('')
      lines.push(t.summary)
      if (t.subtopics?.length) {
        lines.push('')
        lines.push(`*Subtopics: ${t.subtopics.join(', ')}*`)
      }
      lines.push('')
    }
  }

  // Key insights
  const insights = summary.key_insights as string[] | undefined
  if (insights?.length) {
    lines.push('## Key Insights')
    lines.push('')
    for (const i of insights) {
      lines.push(`- ${i}`)
    }
    lines.push('')
  }

  // Decisions
  const decisions = summary.decisions_and_agreements as string[] | undefined
  if (decisions?.length) {
    lines.push('## Decisions & Agreements')
    lines.push('')
    for (const d of decisions) {
      lines.push(`- ${d}`)
    }
    lines.push('')
  }

  // Action items
  const actions = summary.action_items as Array<{ owner: string; task: string; deadline?: string }> | undefined
  if (actions?.length) {
    lines.push('## Action Items')
    lines.push('')
    for (const a of actions) {
      const deadline = a.deadline && a.deadline !== 'null' ? ` (by ${a.deadline})` : ''
      lines.push(`- **${a.owner}**: ${a.task}${deadline}`)
    }
    lines.push('')
  }

  // Open questions
  const questions = summary.open_questions as string[] | undefined
  if (questions?.length) {
    lines.push('## Open Questions')
    lines.push('')
    for (const q of questions) {
      lines.push(`- ${q}`)
    }
    lines.push('')
  }

  // Notable quotes
  const quotes = summary.notable_quotes as Array<{ text: string; speaker: string; context: string }> | undefined
  if (quotes?.length) {
    lines.push('## Notable Quotes')
    lines.push('')
    for (const q of quotes) {
      lines.push(`> "${q.text}"`)
      lines.push(`> — **${q.speaker}** (${q.context})`)
      lines.push('')
    }
  }

  // Footer
  lines.push('---')
  lines.push(`*Summary generated by Gemini 3 Flash on ${new Date().toISOString().split('T')[0]}*`)
  lines.push(`*Fireflies: ${call.transcript_url}*`)

  return lines.join('\n')
}

async function main() {
  const schema = {
    help: { type: 'boolean' as const, alias: 'h' },
    json: { type: 'boolean' as const },
    limit: { type: 'string' as const, alias: 'l' },
    from: { type: 'string' as const },
    to: { type: 'string' as const },
    'has-summary': { type: 'boolean' as const },
    'no-summary': { type: 'boolean' as const },
    missing: { type: 'string' as const },
    set: { type: 'string' as const, multi: true },
    fields: { type: 'string' as const, alias: 'f' },
    'dry-run': { type: 'boolean' as const },
    output: { type: 'string' as const, alias: 'o' },
    file: { type: 'string' as const },
    force: { type: 'boolean' as const },
    days: { type: 'string' as const },
    'check-only': { type: 'boolean' as const },
  }

  let args: ParsedArgs
  try {
    args = parse_flags(process.argv.slice(2), schema)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }

  if (args.help || args._.length === 0) {
    print_help('calls', USAGE)
    process.exit(args.help ? 0 : 1)
  }

  const command = args._[0]
  const calls = loadCalls()
  const limit = args.limit ? parseInt(args.limit as string, 10) : undefined
  const json = args.json as boolean
  const dryRun = args['dry-run'] as boolean

  // Apply common filters
  let filtered = calls
  if (args.from) {
    filtered = filtered.filter(call => call.date >= (args.from as string))
  }
  if (args.to) {
    filtered = filtered.filter(call => call.date <= (args.to as string))
  }
  if (args['has-summary']) {
    filtered = filtered.filter(call => call.summary_file)
  }
  if (args['no-summary']) {
    filtered = filtered.filter(call => !call.summary_file)
  }

  // Sort by date descending (most recent first)
  filtered = filtered.sort((a, b) => (b.date || '').localeCompare(a.date || ''))

  switch (command) {
    case 'list': {
      formatCallList(filtered, json, limit)
      break
    }

    case 'get': {
      const identifier = args._[1]
      if (!identifier) {
        console.error('Usage: calls get <identifier>')
        process.exit(1)
      }
      const call = findCall(calls, identifier)
      if (!call) {
        console.error(`Call not found: ${identifier}`)
        process.exit(1)
      }
      formatCall(call, json)
      break
    }

    case 'search': {
      const query = args._[1]
      if (!query) {
        console.error('Usage: calls search <query>')
        process.exit(1)
      }
      const fieldsArg = args.fields as string | undefined
      const fields = fieldsArg ? fieldsArg.split(',').map(f => f.trim()) : undefined
      if (fields) {
        for (const f of fields) {
          if (!COLUMNS.includes(f)) {
            console.error(`Unknown field: ${f}`)
            console.error(`Valid fields: ${COLUMNS.join(', ')}`)
            process.exit(1)
          }
        }
      }
      const results = searchCalls(filtered, query, fields)
      formatCallList(results, json, limit)
      break
    }

    case 'update': {
      const identifier = args._[1]
      if (!identifier) {
        console.error('Usage: calls update <identifier> --set FIELD=VALUE')
        process.exit(1)
      }
      const sets = parseSetArgs(args)
      if (sets.size === 0) {
        console.error('No --set arguments provided')
        process.exit(1)
      }

      const call = findCall(calls, identifier)
      if (!call) {
        console.error(`Call not found: ${identifier}`)
        process.exit(1)
      }

      console.log(`Updating: ${call.title}`)
      for (const [field, value] of sets) {
        console.log(`  ${field}: "${call[field] || '(empty)'}" -> "${value}"`)
        call[field] = value
      }

      saveCalls(calls, dryRun)
      break
    }

    case 'batch-update': {
      const filePath = args.file as string
      if (!filePath) {
        console.error('Usage: calls batch-update --file updates.json')
        process.exit(1)
      }
      if (!existsSync(filePath)) {
        console.error(`File not found: ${filePath}`)
        process.exit(1)
      }

      const updates = JSON.parse(readFileSync(filePath, 'utf8')) as Array<{
        identifier: string
        updates: Record<string, string>
      }>

      let updated = 0
      for (const { identifier, updates: fields } of updates) {
        const call = findCall(calls, identifier)
        if (!call) {
          console.error(`Call not found: ${identifier}`)
          continue
        }
        console.log(`Updating: ${call.title.slice(0, 60)}`)
        for (const [field, value] of Object.entries(fields)) {
          if (!COLUMNS.includes(field)) {
            console.error(`  Unknown field: ${field}`)
            continue
          }
          console.log(`  ${field}: "${call[field] || '(empty)'}" -> "${value}"`)
          call[field] = value
        }
        updated++
      }

      console.log(`\nUpdated ${updated} calls`)
      saveCalls(calls, dryRun)
      break
    }

    case 'stats': {
      const stats = getStats(filtered)
      if (json) {
        console.log(JSON.stringify(stats, null, 2))
      } else {
        console.log(`Total calls: ${stats.total}`)
        const totalHours = Math.round((stats.totalDurationMinutes as number) / 60)
        console.log(`Total duration: ${totalHours} hours`)
        console.log(`\nBy status:`)
        for (const [status, count] of Object.entries(stats.byStatus as Record<string, number>).sort((a, b) => b[1] - a[1])) {
          console.log(`  ${status}: ${count}`)
        }
        console.log(`\nContent status:`)
        console.log(`  With summary: ${stats.withSummary}`)
        console.log(`  With transcript: ${stats.withTranscript}`)
        console.log(`\nMissing:`)
        console.log(`  Missing summary: ${stats.missingSummary}`)
        console.log(`  Missing transcript: ${stats.missingTranscript}`)

        // Show recent months
        const months = Object.entries(stats.byMonth as Record<string, number>)
          .sort((a, b) => b[0].localeCompare(a[0]))
          .slice(0, 6)
        console.log(`\nRecent months:`)
        for (const [month, count] of months) {
          console.log(`  ${month}: ${count}`)
        }
      }
      break
    }

    case 'missing': {
      const field = args._[1]
      if (!field) {
        console.error('Usage: calls missing <field>')
        console.error(`Valid fields: ${COLUMNS.join(', ')}`)
        process.exit(1)
      }
      if (!COLUMNS.includes(field)) {
        console.error(`Unknown field: ${field}`)
        console.error(`Valid fields: ${COLUMNS.join(', ')}`)
        process.exit(1)
      }

      const missing = filtered.filter(call => !call[field])
      formatCallList(missing, json, limit)
      break
    }

    case 'export': {
      const outputPath = args.output as string
      if (!outputPath) {
        console.error('Usage: calls export --output FILE')
        process.exit(1)
      }

      const output = stringify(filtered, { header: true, columns: COLUMNS })
      writeFileSync(outputPath, output)
      console.log(`Exported ${filtered.length} calls to ${outputPath}`)
      break
    }

    case 'summarize': {
      const identifier = args._[1]
      if (!identifier) {
        console.error('Usage: calls summarize <identifier>')
        process.exit(1)
      }

      const call = findCall(calls, identifier)
      if (!call) {
        console.error(`Call not found: ${identifier}`)
        process.exit(1)
      }

      // Check if already summarized
      if (call.summary_file && !args.force) {
        console.log(`Call already has summary: ${call.summary_file}`)
        console.log('Use --force to regenerate')
        process.exit(0)
      }

      const result = await summarizeCall(call, dryRun)
      if (!dryRun) {
        if (result === 'success') {
          // Update CSV - use transcript filename for summary
          const transcriptBasename = basename(call.transcript_file || '', '.md')
          call.summary_file = `summaries/${transcriptBasename}.md`
          call.summary_status = 'completed'
          call.summarized_at = new Date().toISOString()
          saveCalls(calls, false)
        } else if (result === 'empty') {
          call.summary_status = 'empty'
          saveCalls(calls, false)
        }
      }
      break
    }

    case 'batch-summarize': {
      // Find calls that need summarization (skip completed, empty, and confirmed-empty)
      let candidates = filtered.filter(call =>
        call.transcript_file &&
        call.summary_status !== 'completed' &&
        call.summary_status !== 'empty' &&
        call.summary_status !== 'confirmed-empty'
      )

      // Pre-filter to only calls with actual transcript content (>= 5 speaker turns)
      // This avoids wasting Gemini calls on empty transcripts
      console.log(`Checking ${candidates.length} candidates for transcript content...`)
      const withContent: Call[] = []
      const noContent: Call[] = []

      for (const call of candidates) {
        const turns = countTranscriptTurns(call)
        if (turns >= 5) {
          withContent.push(call)
        } else {
          noContent.push(call)
        }
      }

      // Mark empty transcripts as confirmed-empty
      if (noContent.length > 0) {
        console.log(`Marking ${noContent.length} calls as confirmed-empty (no transcript content)`)
        for (const call of noContent) {
          call.summary_status = 'confirmed-empty'
        }
        saveCalls(calls, dryRun)
      }

      let toSummarize = withContent
      if (limit) {
        toSummarize = toSummarize.slice(0, limit)
      }

      if (toSummarize.length === 0) {
        console.log('No calls with transcript content need summarization')
        break
      }

      console.log(`Found ${toSummarize.length} calls with content to summarize\n`)

      let successCount = 0
      let emptyCount = 0
      for (const call of toSummarize) {
        const result = await summarizeCall(call, dryRun)
        if (!dryRun) {
          if (result === 'success') {
            // Use transcript filename for summary
            const transcriptBasename = basename(call.transcript_file || '', '.md')
            call.summary_file = `summaries/${transcriptBasename}.md`
            call.summary_status = 'completed'
            call.summarized_at = new Date().toISOString()
            successCount++
          } else if (result === 'empty') {
            call.summary_status = 'empty'
            emptyCount++
          }
        }
        console.log('')
      }

      if (!dryRun && (successCount > 0 || emptyCount > 0)) {
        saveCalls(calls, false)
        const parts = []
        if (successCount > 0) parts.push(`${successCount} summarized`)
        if (emptyCount > 0) parts.push(`${emptyCount} marked empty`)
        console.log(`\nCompleted: ${parts.join(', ')}`)
      }
      break
    }

    case 'import': {
      const ffId = args._[1]
      if (!ffId) {
        console.error('Usage: calls import <fireflies_id>')
        process.exit(1)
      }

      // Check if already exists
      const existing = calls.find(c => c.fireflies_id === ffId || c.fireflies_id.startsWith(ffId))
      if (existing && !args.force) {
        console.log(`Call already exists: ${existing.title}`)
        console.log('Use --force to re-download')
        process.exit(0)
      }

      console.log(`Downloading transcript: ${ffId}`)
      // Use fireflies tool to download to temp location
      const firefliesPath = join(PROJECT_ROOT, 'tools/fireflies.ts')
      const tempPath = join(TRANSCRIPT_DIR, `temp_${ffId}.md`)

      const proc1 = Bun.spawn({
        cmd: [process.execPath, firefliesPath, 'download', ffId, '-o', tempPath],
        stdout: 'pipe',
        stderr: 'inherit',
      })
      const exitCode = await proc1.exited

      if (exitCode !== 0) {
        console.error('Failed to download transcript')
        process.exit(1)
      }

      // Parse YAML frontmatter from downloaded file
      const content = readFileSync(tempPath, 'utf8')
      const yamlMatch = content.match(/^---\n([\s\S]*?)\n---/)
      if (!yamlMatch) {
        console.error('No YAML frontmatter found in transcript')
        process.exit(1)
      }

      // Extract metadata from YAML
      const yaml = yamlMatch[1]
      const getValue = (key: string): string => {
        const match = yaml.match(new RegExp(`^${key}:\\s*['"]?(.+?)['"]?$`, 'm'))
        return match ? match[1].trim() : ''
      }

      const fireflies_id = getValue('fireflies_id')
      const title = getValue('title').replace(/^'|'$/g, '')
      const dateStr = getValue('date').split('T')[0]
      const duration = getValue('duration')
      const organizer = getValue('organizer')
      const transcript_url = getValue('transcript_url')
      const meeting_link = getValue('meeting_link')
      const participants = getValue('participants')
      const speakers = getValue('speakers')

      // Create standard filename
      const safeTitle = title.replace(/[^a-zA-Z0-9 &-]/g, '').trim()
      const shortId = fireflies_id.slice(0, 8)
      const newFilename = `${dateStr}_${safeTitle}_${shortId}.md`
      const newPath = join(TRANSCRIPT_DIR, newFilename)

      // Rename file
      const { renameSync } = await import('fs')
      renameSync(tempPath, newPath)

      // Add or update CSV entry
      if (existing) {
        // Update existing entry
        existing.transcript_file = `transcripts/${newFilename}`
        existing.downloaded_at = new Date().toISOString()
        console.log(`Updated existing entry: ${title}`)
      } else {
        // Create new entry
        const newCall: Call = {
          fireflies_id,
          title,
          date: dateStr,
          duration,
          duration_seconds: '',
          organizer,
          participants,
          speakers,
          transcript_url,
          meeting_link,
          summary_status: 'pending',
          notes: '',
          transcript_file: `transcripts/${newFilename}`,
          summary_file: '',
          downloaded_at: new Date().toISOString(),
          summarized_at: '',
          tags: '',
        }
        // Add at beginning (most recent first)
        calls.unshift(newCall)
        console.log(`Added new entry: ${title}`)
      }

      saveCalls(calls, dryRun)
      console.log(`\nTranscript: ${newPath}`)
      console.log(`Status: pending (ready for summarization)`)
      console.log(`\nNext: calls summarize "${shortId}"`)
      break
    }

    case 'sync': {
      const days = parseInt(args.days as string) || 7
      console.log(`Syncing Fireflies transcripts from last ${days} days...`)

      // Use fireflies tool to list recent
      const firefliesPath2 = join(PROJECT_ROOT, 'tools/fireflies.ts')

      const fromDate = new Date()
      fromDate.setDate(fromDate.getDate() - days)
      const fromStr = fromDate.toISOString().split('T')[0]

      const proc2 = Bun.spawn({
        cmd: [process.execPath, firefliesPath2, 'list', '--from', fromStr, '--limit', '50'],
        stdout: 'pipe',
        stderr: 'inherit',
      })

      const output = await new Response(proc2.stdout).text()
      console.log(output)

      console.log('\nTo import specific transcripts, use: calls import <fireflies_id>')
      break
    }

    case 'retranscribe': {
      const identifier = args._[1]
      if (!identifier) {
        console.error('Usage: calls retranscribe <identifier>')
        process.exit(1)
      }

      const call = findCall(calls, identifier)
      if (!call) {
        console.error(`Call not found: ${identifier}`)
        process.exit(1)
      }

      // Check if it's an empty transcript (unless --force)
      if (call.summary_status !== 'empty' && !args.force) {
        console.log(`Call status is "${call.summary_status}", not "empty"`)
        console.log('Use --force to retranscribe anyway')
        process.exit(0)
      }

      console.log(`Fetching audio URL for: ${call.title}`)
      console.log(`Fireflies ID: ${call.fireflies_id}`)

      // Get audio URL from Fireflies
      const firefliesPath3 = join(PROJECT_ROOT, 'tools/fireflies.ts')
      const proc3 = Bun.spawn({
        cmd: [process.execPath, firefliesPath3, 'get', call.fireflies_id, '--json'],
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const ffOutput = await new Response(proc3.stdout).text()
      const ffExitCode = await proc3.exited

      if (ffExitCode !== 0) {
        console.error('Failed to get call info from Fireflies')
        process.exit(1)
      }

      let ffData: { audio_url?: string; title?: string; date?: number; dateString?: string; duration?: number; organizer_email?: string; participants?: string[]; speakers?: Array<{ name: string }>; transcript_url?: string; meeting_link?: string }
      try {
        ffData = JSON.parse(ffOutput)
      } catch {
        console.error('Failed to parse Fireflies response')
        process.exit(1)
      }

      if (!ffData.audio_url) {
        console.error('No audio URL available for this call')
        console.error('The audio may have been deleted or never recorded')
        process.exit(1)
      }

      console.log(`Found audio URL (expires in ~24h)`)

      if (dryRun) {
        console.log(`[DRY RUN] Would transcribe with Deepgram:`)
        console.log(`  Title: ${call.title}`)
        console.log(`  Audio URL: ${ffData.audio_url.slice(0, 80)}...`)
        console.log(`  Output: ${call.transcript_file}`)
        break
      }

      // Transcribe with Deepgram
      console.log(`\nTranscribing with Deepgram...`)
      const deepgramPath = join(PROJECT_ROOT, 'tools/deepgram.ts')
      const transcriptPath = call.transcript_file
        ? join(PROJECT_ROOT, 'data/calls', call.transcript_file)
        : join(TRANSCRIPT_DIR, `${call.date}_${call.title.replace(/[^a-zA-Z0-9 ]/g, '')}_${call.fireflies_id.slice(0, 8)}.md`)

      // Build speaker hints from Fireflies metadata
      const speakerNames = ffData.speakers?.map(s => s.name).filter(Boolean) || []

      const deepgramArgs = [
        process.execPath, deepgramPath,
        ffData.audio_url,
        '-o', transcriptPath,
        '--no-name-speakers',  // Don't use OpenAI naming, we have Fireflies metadata
      ]

      // Add speaker hints if available
      if (speakerNames.length > 0) {
        deepgramArgs.push('--hosts', speakerNames.join(';'))
      }

      const proc4 = Bun.spawn({
        cmd: deepgramArgs,
        stdout: 'pipe',
        stderr: 'inherit',
      })
      const deepgramOutput = await new Response(proc4.stdout).text()
      const deepgramExitCode = await proc4.exited

      if (deepgramExitCode !== 0) {
        console.error('Deepgram transcription failed')
        process.exit(1)
      }

      // Now we need to add Fireflies metadata to the transcript
      // Read the Deepgram output and prepend Fireflies YAML frontmatter
      const deepgramContent = readFileSync(transcriptPath, 'utf8')

      // Extract just the transcript content (after Deepgram's frontmatter)
      const transcriptStart = deepgramContent.indexOf('## Transcript')
      const transcriptBody = transcriptStart >= 0
        ? deepgramContent.slice(transcriptStart)
        : deepgramContent.replace(/^---[\s\S]*?---\s*/, '')

      // Build Fireflies-compatible YAML frontmatter
      const dateStr = call.date || (ffData.dateString || new Date(ffData.date || 0).toISOString().split('T')[0])
      const durationMin = ffData.duration ? Math.round(ffData.duration) : parseInt(call.duration_seconds) / 60 || 0
      const durationStr = durationMin > 60
        ? `${Math.floor(durationMin / 60)}h ${Math.round(durationMin % 60)}m`
        : `${Math.round(durationMin)}m`

      const lines: string[] = []
      lines.push('---')
      lines.push(`fireflies_id: ${call.fireflies_id}`)
      lines.push(`title: '${(call.title || 'Untitled').replace(/'/g, "''")}'`)
      lines.push(`date: ${dateStr}`)
      lines.push(`duration: ${durationStr}`)
      if (call.organizer || ffData.organizer_email) lines.push(`organizer: ${call.organizer || ffData.organizer_email}`)
      if (call.participants || ffData.participants?.length) {
        const parts = call.participants || ffData.participants?.join(', ') || ''
        if (parts) lines.push(`participants: [${parts.split(', ').map(p => `'${p}'`).join(', ')}]`)
      }
      if (call.speakers || speakerNames.length) {
        const spks = call.speakers || speakerNames.join('; ')
        if (spks) lines.push(`speakers: [${spks.split(/[;,]/).map(s => `'${s.trim()}'`).filter(Boolean).join(', ')}]`)
      }
      lines.push(`transcript_url: ${call.transcript_url || ffData.transcript_url || ''}`)
      if (call.meeting_link || ffData.meeting_link) lines.push(`meeting_link: ${call.meeting_link || ffData.meeting_link}`)
      lines.push(`downloaded_at: ${new Date().toISOString()}`)
      lines.push(`transcription_source: deepgram`)
      lines.push('---')
      lines.push('')
      lines.push(`# ${call.title || 'Untitled Meeting'}`)
      lines.push('')

      const finalContent = lines.join('\n') + transcriptBody

      // Write the final transcript
      writeFileSync(transcriptPath, finalContent)

      // Update CSV
      call.transcript_file = `transcripts/${basename(transcriptPath)}`
      call.summary_status = 'pending'
      call.downloaded_at = new Date().toISOString()
      call.notes = `Re-transcribed via Deepgram ${new Date().toISOString().split('T')[0]}`
      saveCalls(calls, false)

      console.log(`\nTranscription complete!`)
      console.log(`  Output: ${transcriptPath}`)
      console.log(`  Status: pending (ready for summarization)`)
      console.log(`\nNext: calls summarize "${call.fireflies_id.slice(0, 8)}"`)
      break
    }

    case 'batch-retranscribe': {
      const checkOnly = args['check-only'] as boolean

      // Find empty calls
      let emptyCalls = calls.filter(c => c.summary_status === 'empty')

      // Apply date filters
      if (args.from) {
        emptyCalls = emptyCalls.filter(c => c.date >= (args.from as string))
      }
      if (args.to) {
        emptyCalls = emptyCalls.filter(c => c.date <= (args.to as string))
      }

      if (limit) {
        emptyCalls = emptyCalls.slice(0, limit)
      }

      if (emptyCalls.length === 0) {
        console.log('No empty calls found to retranscribe')
        break
      }

      console.log(`Found ${emptyCalls.length} empty calls to check for audio\n`)

      const firefliesPath = join(PROJECT_ROOT, 'tools/fireflies.ts')
      const deepgramPath = join(PROJECT_ROOT, 'tools/deepgram.ts')

      const results = {
        hasAudio: [] as Call[],
        noAudio: [] as Call[],
        transcribed: [] as Call[],
        failed: [] as Call[],
      }

      for (const call of emptyCalls) {
        process.stdout.write(`Checking: ${call.title.slice(0, 50)}... `)

        // Get audio URL from Fireflies
        const proc = Bun.spawn({
          cmd: [process.execPath, firefliesPath, 'get', call.fireflies_id, '--json'],
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const ffOutput = await new Response(proc.stdout).text()
        await proc.exited

        let ffData: { audio_url?: string }
        try {
          ffData = JSON.parse(ffOutput)
        } catch {
          console.log('error parsing')
          results.noAudio.push(call)
          continue
        }

        if (!ffData.audio_url) {
          console.log('no audio')
          results.noAudio.push(call)
          continue
        }

        console.log('has audio!')
        results.hasAudio.push(call)

        if (checkOnly || dryRun) {
          continue
        }

        // Transcribe with Deepgram
        console.log(`  Transcribing with Deepgram...`)
        const transcriptPath = call.transcript_file
          ? join(PROJECT_ROOT, 'data/calls', call.transcript_file)
          : join(TRANSCRIPT_DIR, `${call.date}_${call.title.replace(/[^a-zA-Z0-9 ]/g, '')}_${call.fireflies_id.slice(0, 8)}.md`)

        const deepgramProc = Bun.spawn({
          cmd: [process.execPath, deepgramPath, ffData.audio_url, '-o', transcriptPath, '--no-name-speakers'],
          stdout: 'pipe',
          stderr: 'pipe',
        })
        await new Response(deepgramProc.stdout).text()
        const exitCode = await deepgramProc.exited

        if (exitCode !== 0) {
          console.log(`  Failed!`)
          results.failed.push(call)
          continue
        }

        // Read Deepgram output and add Fireflies metadata
        const deepgramContent = readFileSync(transcriptPath, 'utf8')
        const transcriptStart = deepgramContent.indexOf('## Transcript')
        const transcriptBody = transcriptStart >= 0
          ? deepgramContent.slice(transcriptStart)
          : deepgramContent.replace(/^---[\s\S]*?---\s*/, '')

        const lines: string[] = []
        lines.push('---')
        lines.push(`fireflies_id: ${call.fireflies_id}`)
        lines.push(`title: '${(call.title || 'Untitled').replace(/'/g, "''")}'`)
        lines.push(`date: ${call.date}`)
        if (call.duration) lines.push(`duration: ${call.duration}`)
        if (call.organizer) lines.push(`organizer: ${call.organizer}`)
        lines.push(`transcript_url: ${call.transcript_url || ''}`)
        lines.push(`downloaded_at: ${new Date().toISOString()}`)
        lines.push(`transcription_source: deepgram`)
        lines.push('---')
        lines.push('')
        lines.push(`# ${call.title || 'Untitled Meeting'}`)
        lines.push('')

        const finalContent = lines.join('\n') + transcriptBody
        writeFileSync(transcriptPath, finalContent)

        // Update CSV
        call.transcript_file = `transcripts/${basename(transcriptPath)}`
        call.summary_status = 'pending'
        call.downloaded_at = new Date().toISOString()
        call.notes = `Re-transcribed via Deepgram ${new Date().toISOString().split('T')[0]}`

        results.transcribed.push(call)
        console.log(`  Done!`)
      }

      // Save if we made changes
      if (results.transcribed.length > 0) {
        saveCalls(calls, false)
      }

      // Summary
      console.log(`\n--- Summary ---`)
      console.log(`Checked: ${emptyCalls.length}`)
      console.log(`Has audio: ${results.hasAudio.length}`)
      console.log(`No audio: ${results.noAudio.length}`)
      if (!checkOnly && !dryRun) {
        console.log(`Transcribed: ${results.transcribed.length}`)
        if (results.failed.length > 0) {
          console.log(`Failed: ${results.failed.length}`)
        }
      }

      if (checkOnly && results.hasAudio.length > 0) {
        console.log(`\nCalls with audio available:`)
        for (const c of results.hasAudio.slice(0, 10)) {
          console.log(`  ${c.date} | ${c.title.slice(0, 50)} | ${c.fireflies_id}`)
        }
        if (results.hasAudio.length > 10) {
          console.log(`  ... and ${results.hasAudio.length - 10} more`)
        }
        console.log(`\nTo retranscribe, run: calls batch-retranscribe --limit N`)
      }
      break
    }

    case 'refresh': {
      const identifier = args._[1]
      if (!identifier) {
        console.error('Usage: calls refresh <identifier>')
        process.exit(1)
      }

      const call = findCall(calls, identifier)
      if (!call) {
        console.error(`Call not found: ${identifier}`)
        process.exit(1)
      }

      console.log(`Refreshing transcript for: ${call.title}`)

      const firefliesPath4 = join(PROJECT_ROOT, 'tools/fireflies.ts')
      const transcriptPath = call.transcript_file
        ? join(PROJECT_ROOT, 'data/calls', call.transcript_file)
        : join(TRANSCRIPT_DIR, `${call.date}_${call.title.replace(/[^a-zA-Z0-9 ]/g, '')}_${call.fireflies_id.slice(0, 8)}.md`)

      const proc5 = Bun.spawn({
        cmd: [process.execPath, firefliesPath4, 'download', call.fireflies_id, '-o', transcriptPath],
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const exitCode5 = await proc5.exited

      if (exitCode5 !== 0) {
        console.error('Failed to download transcript')
        process.exit(1)
      }

      // Check if the new transcript has content
      const content = readFileSync(transcriptPath, 'utf8')
      const isEmpty = content.includes('No transcript content available')

      if (isEmpty) {
        console.log('\nTranscript still empty (no content available)')
        call.summary_status = 'empty'
      } else {
        console.log('\nTranscript has content!')
        call.summary_status = 'pending'
        call.transcript_file = `transcripts/${basename(transcriptPath)}`
      }

      call.downloaded_at = new Date().toISOString()
      saveCalls(calls, false)
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      print_help('calls', USAGE)
      process.exit(1)
  }
}

main().catch(err => {
  console.error(err.message || err)
  process.exit(1)
})
