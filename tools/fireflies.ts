#!/usr/bin/env bun

import { parse_flags, print_help } from './_lib/cli'
import { fatal, handleError, UsageError, NetworkError, EXIT } from './_lib/errors'
import { load_env, PROJECT_ROOT } from './_lib/env'
import { request } from './_lib/http'
import { resolvePathOrThrow } from './_lib/paths'
import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const name = 'fireflies'
export const description = 'Interact with Fireflies.ai meeting transcripts. List, search, download transcripts, and upload audio for transcription.'

const FIREFLIES_API = 'https://api.fireflies.ai/graphql'

function usage() {
  return `
USAGE:
    fireflies list [options]              List transcripts with optional filters
    fireflies get <transcript_id>         Get a specific transcript
    fireflies download <transcript_id> [options]  Download transcript as markdown
    fireflies upload <audio_url> [options]        Upload audio URL for transcription
    fireflies user                        Get current user info
    fireflies search <keyword> [options]  Search transcripts by keyword

LIST OPTIONS:
    --limit N              Max results (default: 20, max: 50)
    --skip N               Skip first N results for pagination
    --from DATE            Filter by start date (ISO 8601, e.g., 2024-01-01)
    --to DATE              Filter by end date (ISO 8601)
    --host EMAIL           Filter by host email
    --participants EMAILS  Filter by participant emails (comma-separated)
    --mine                 Only show meetings owned by API key owner

SEARCH OPTIONS:
    --scope SCOPE          Search scope: title, sentences, or all (default: all)
    --limit N              Max results (default: 20)
    --skip N               Skip first N results

GET OPTIONS:
    --json                 Output raw JSON instead of formatted text
    --include-sentences    Include full transcript sentences (verbose)

DOWNLOAD OPTIONS:
    -o, --output PATH      Output file path (default: outputs/fireflies/<title>.md)
    --include-summary      Include AI summary in output
    --include-analytics    Include meeting analytics (sentiment, speaker stats)
    --timestamps           Include timestamps for each sentence (default: off)
    --speaker-labels       Include speaker names (default: on)
    --no-speaker-labels    Disable speaker labels

UPLOAD OPTIONS:
    --title TEXT           Title for the transcription
    --webhook URL          Webhook URL for completion notification
    --language CODE        Language code (e.g., es, de, fr)
    --attendees JSON       Attendee list as JSON array [{name, email}]

GENERAL:
    -h, --help             Show help

ENVIRONMENT:
    FIREFLIES_API_KEY      Required. Get from fireflies.ai/integrations

EXAMPLES:
    # List recent transcripts
    fireflies list --limit 10

    # Search for meetings about "product roadmap"
    fireflies search "product roadmap" --limit 5

    # Download a specific transcript
    fireflies download abc123 -o ~/transcripts/meeting.md

    # Upload audio for transcription
    fireflies upload "https://example.com/meeting.mp3" --title "Team Standup"

NOTE:
    - API access requires a Fireflies Business plan
    - Rate limits: 50 calls/day (Free/Pro), 60 calls/minute (Business+)
    - Audio uploads must be publicly accessible HTTPS URLs
`
}

type GraphQLResponse<T> = {
  data?: T
  errors?: Array<{ message: string; extensions?: Record<string, unknown> }>
}

async function graphql<T>(apiKey: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const body = { query, variables }
  const { data } = await request<GraphQLResponse<T>>({
    method: 'POST',
    url: FIREFLIES_API,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeoutMs: 60_000,
    retries: 2,
    prefetchDNS: true,
    preconnect: true,
  })

  if (data.errors && data.errors.length > 0) {
    const msg = data.errors.map((e) => e.message).join('; ')
    throw new NetworkError(`Fireflies API error: ${msg}`)
  }

  if (!data.data) {
    throw new NetworkError('Empty response from Fireflies API')
  }

  return data.data
}

// GraphQL queries and mutations
const QUERIES = {
  user: `
    query {
      user {
        user_id
        email
        name
        integrations
        recent_meeting
        minutes_consumed
        is_admin
      }
    }
  `,

  transcripts: `
    query Transcripts(
      $limit: Int
      $skip: Int
      $fromDate: DateTime
      $toDate: DateTime
      $host_email: String
      $mine: Boolean
      $title: String
    ) {
      transcripts(
        limit: $limit
        skip: $skip
        fromDate: $fromDate
        toDate: $toDate
        host_email: $host_email
        mine: $mine
        title: $title
      ) {
        id
        title
        date
        duration
        organizer_email
        participants
        transcript_url
        meeting_link
      }
    }
  `,

  transcript: `
    query Transcript($id: String!, $includeSentences: Boolean!) {
      transcript(id: $id) {
        id
        title
        date
        dateString
        duration
        organizer_email
        participants
        fireflies_users
        transcript_url
        meeting_link
        audio_url
        video_url
        speakers {
          id
          name
        }
        summary {
          keywords
          action_items
          outline
          shorthand_bullet
          overview
          bullet_gist
        }
        meeting_info {
          fred_joined
          silent_meeting
          summary_status
        }
        sentences @include(if: $includeSentences) {
          index
          text
          raw_text
          start_time
          end_time
          speaker_id
          speaker_name
        }
      }
    }
  `,

  transcriptWithAnalytics: `
    query Transcript($id: String!) {
      transcript(id: $id) {
        id
        title
        date
        dateString
        duration
        organizer_email
        participants
        fireflies_users
        transcript_url
        meeting_link
        audio_url
        video_url
        speakers {
          id
          name
        }
        summary {
          keywords
          action_items
          outline
          shorthand_bullet
          overview
          bullet_gist
        }
        sentences {
          index
          text
          raw_text
          start_time
          end_time
          speaker_id
          speaker_name
        }
        analytics {
          sentiments {
            positive_percent
            negative_percent
            neutral_percent
          }
          speakers_stats {
            speaker_id
            speaker_name
            word_count
            monologue_duration
            longest_monologue
            filler_words
            questions_asked
          }
        }
      }
    }
  `,

  uploadAudio: `
    mutation UploadAudio(
      $url: String!
      $title: String
      $webhook: String
      $custom_language: String
    ) {
      uploadAudio(
        input: {
          url: $url
          title: $title
          webhook: $webhook
          custom_language: $custom_language
        }
      ) {
        success
        title
        message
      }
    }
  `,
}

type User = {
  user_id: string
  email: string
  name: string
  integrations: string[]
  recent_meeting: string
  minutes_consumed: number
  is_admin: boolean
}

type TranscriptListItem = {
  id: string
  title: string
  date: number
  duration: number
  organizer_email: string
  participants: string[]
  transcript_url: string
  meeting_link: string
}

type Speaker = {
  id: string
  name: string
}

type Sentence = {
  index: number
  text: string
  raw_text: string
  start_time: string
  end_time: string
  speaker_id: string
  speaker_name: string
}

type Summary = {
  keywords: string[]
  action_items: string[]
  outline: string
  shorthand_bullet: string
  overview: string
  bullet_gist: string
}

type MeetingInfo = {
  fred_joined: boolean
  silent_meeting: boolean
  summary_status: string
}

type Analytics = {
  sentiments: {
    positive_percent: number
    negative_percent: number
    neutral_percent: number
  }
  speakers_stats: Array<{
    speaker_id: string
    speaker_name: string
    word_count: number
    monologue_duration: number
    longest_monologue: number
    filler_words: number
    questions_asked: number
  }>
}

type Transcript = {
  id: string
  title: string
  date: number
  dateString: string
  duration: number
  organizer_email: string
  participants: string[]
  fireflies_users: string[]
  transcript_url: string
  meeting_link: string
  audio_url: string
  video_url: string
  speakers: Speaker[]
  summary: Summary
  meeting_info: MeetingInfo
  sentences?: Sentence[]
  analytics?: Analytics
}

type UploadResult = {
  success: boolean
  title: string
  message: string
}

function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return ''
  const h = Math.floor(minutes / 60)
  const m = Math.floor(minutes % 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

function formatDate(epochMs: number): string {
  if (!Number.isFinite(epochMs)) return ''
  return new Date(epochMs).toISOString().split('T')[0] || ''
}

function formatTimestamp(timeStr: string): string {
  const sec = parseFloat(timeStr)
  if (!Number.isFinite(sec) || sec < 0) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function sanitizeFilename(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'transcript'
}

async function cmd_user(apiKey: string) {
  const data = await graphql<{ user: User }>(apiKey, QUERIES.user)
  const u = data.user

  console.log(`## Fireflies User Info`)
  console.log('')
  console.log(`- **Name:** ${u.name || 'N/A'}`)
  console.log(`- **Email:** ${u.email || 'N/A'}`)
  console.log(`- **User ID:** ${u.user_id || 'N/A'}`)
  console.log(`- **Admin:** ${u.is_admin ? 'Yes' : 'No'}`)
  console.log(`- **Minutes Consumed:** ${u.minutes_consumed || 0}`)
  if (u.recent_meeting) {
    console.log(`- **Recent Meeting:** ${u.recent_meeting}`)
  }
  if (u.integrations?.length) {
    console.log(`- **Integrations:** ${u.integrations.join(', ')}`)
  }
}

async function cmd_list(apiKey: string, flags: Record<string, unknown>) {
  const limit = Math.min(50, Math.max(1, Number(flags.limit ?? 20)))
  const skip = Math.max(0, Number(flags.skip ?? 0))

  const variables: Record<string, unknown> = { limit, skip }

  if (flags.from) variables.fromDate = String(flags.from)
  if (flags.to) variables.toDate = String(flags.to)
  if (flags.host) variables.host_email = String(flags.host)
  if (flags.mine) variables.mine = true

  const data = await graphql<{ transcripts: TranscriptListItem[] }>(apiKey, QUERIES.transcripts, variables)
  const transcripts = data.transcripts || []

  console.log(`## Fireflies Transcripts (${transcripts.length} results)`)
  console.log('')

  if (transcripts.length === 0) {
    console.log('No transcripts found.')
    return
  }

  for (let i = 0; i < transcripts.length; i++) {
    const t = transcripts[i]!
    const date = formatDate(t.date)
    const dur = formatDuration(t.duration)
    console.log(`${i + 1}. **${t.title || 'Untitled'}** [ID: ${t.id}]`)
    if (date) console.log(`   - Date: ${date}`)
    if (dur) console.log(`   - Duration: ${dur}`)
    if (t.organizer_email) console.log(`   - Organizer: ${t.organizer_email}`)
    if (t.participants?.length) console.log(`   - Participants: ${t.participants.length}`)
    console.log(`   - URL: ${t.transcript_url}`)
    console.log(`   - Commands:`)
    console.log(`     - fireflies get ${t.id}`)
    console.log(`     - fireflies download ${t.id}`)
    console.log('')
  }

  if (transcripts.length === limit) {
    console.log('---')
    console.log(`### Next page: fireflies list --skip ${skip + limit} --limit ${limit}`)
  }
}

async function cmd_search(apiKey: string, keyword: string, flags: Record<string, unknown>) {
  const limit = Math.min(50, Math.max(1, Number(flags.limit ?? 20)))
  const skip = Math.max(0, Number(flags.skip ?? 0))

  // Use title filter for searching (API doesn't support full-text keyword search)
  const variables: Record<string, unknown> = {
    limit,
    skip,
    title: keyword,
  }

  const data = await graphql<{ transcripts: TranscriptListItem[] }>(apiKey, QUERIES.transcripts, variables)
  const transcripts = data.transcripts || []

  console.log(`## Search Results for "${keyword}" (${transcripts.length} results)`)
  console.log('')

  if (transcripts.length === 0) {
    console.log('No transcripts found.')
    return
  }

  for (let i = 0; i < transcripts.length; i++) {
    const t = transcripts[i]!
    const date = formatDate(t.date)
    const dur = formatDuration(t.duration)
    console.log(`${i + 1}. **${t.title || 'Untitled'}** [ID: ${t.id}]`)
    if (date) console.log(`   - Date: ${date}`)
    if (dur) console.log(`   - Duration: ${dur}`)
    console.log(`   - URL: ${t.transcript_url}`)
    console.log(`   - Commands:`)
    console.log(`     - fireflies get ${t.id}`)
    console.log(`     - fireflies download ${t.id}`)
    console.log('')
  }

  if (transcripts.length === limit) {
    console.log('---')
    console.log(`### Next page: fireflies search "${keyword}" --skip ${skip + limit} --limit ${limit}`)
  }
}

async function cmd_get(apiKey: string, id: string, flags: Record<string, unknown>) {
  const includeSentences = Boolean(flags['include-sentences'])
  const json = Boolean(flags.json)

  const data = await graphql<{ transcript: Transcript }>(
    apiKey,
    QUERIES.transcript,
    { id, includeSentences }
  )

  const t = data.transcript
  if (!t) {
    throw new NetworkError(`Transcript not found: ${id}`)
  }

  if (json) {
    console.log(JSON.stringify(t, null, 2))
    return
  }

  console.log(`## ${t.title || 'Untitled Meeting'}`)
  console.log('')
  console.log(`- **ID:** ${t.id}`)
  console.log(`- **Date:** ${t.dateString || formatDate(t.date)}`)
  console.log(`- **Duration:** ${formatDuration(t.duration)}`)
  if (t.organizer_email) console.log(`- **Organizer:** ${t.organizer_email}`)
  if (t.participants?.length) console.log(`- **Participants:** ${t.participants.join(', ')}`)
  if (t.speakers?.length) console.log(`- **Speakers:** ${t.speakers.map((s) => s.name).join(', ')}`)
  console.log(`- **Transcript URL:** ${t.transcript_url}`)
  if (t.meeting_link) console.log(`- **Meeting Link:** ${t.meeting_link}`)
  if (t.audio_url) console.log(`- **Audio URL:** ${t.audio_url} (expires in 24h)`)
  if (t.video_url) console.log(`- **Video URL:** ${t.video_url} (expires in 24h)`)

  if (t.summary) {
    console.log('')
    console.log('### Summary')
    if (t.summary.overview) console.log(`\n**Overview:** ${t.summary.overview}`)
    if (t.summary.keywords?.length) console.log(`\n**Keywords:** ${t.summary.keywords.join(', ')}`)
    if (t.summary.action_items) {
      console.log('\n**Action Items:**')
      const items = Array.isArray(t.summary.action_items) ? t.summary.action_items : [t.summary.action_items]
      items.forEach((item) => console.log(`- ${item}`))
    }
  }

  if (t.meeting_info) {
    console.log('')
    console.log('### Meeting Info')
    console.log(`- Bot Joined: ${t.meeting_info.fred_joined ? 'Yes' : 'No'}`)
    console.log(`- Silent Meeting: ${t.meeting_info.silent_meeting ? 'Yes' : 'No'}`)
    console.log(`- Summary Status: ${t.meeting_info.summary_status}`)
  }

  if (includeSentences && t.sentences?.length) {
    console.log('')
    console.log('### Transcript')
    console.log('')
    for (const s of t.sentences) {
      const ts = formatTimestamp(s.start_time)
      const speaker = s.speaker_name || `Speaker ${s.speaker_id}`
      console.log(`**${speaker}** (${ts}): ${s.text}`)
    }
  }

  console.log('')
  console.log('---')
  console.log('### Commands')
  console.log(`- Download: fireflies download ${t.id}`)
  console.log(`- Full transcript: fireflies get ${t.id} --include-sentences`)
  console.log(`- Raw JSON: fireflies get ${t.id} --json`)
}

async function cmd_download(apiKey: string, id: string, flags: Record<string, unknown>) {
  const includeAnalytics = Boolean(flags['include-analytics'])
  const includeSummary = Boolean(flags['include-summary'])
  const includeTimestamps = Boolean(flags.timestamps)
  const includeSpeakerLabels = flags['no-speaker-labels'] ? false : true

  const query = includeAnalytics ? QUERIES.transcriptWithAnalytics : QUERIES.transcript
  const data = await graphql<{ transcript: Transcript }>(
    apiKey,
    query,
    includeAnalytics ? { id } : { id, includeSentences: true }
  )

  const t = data.transcript
  if (!t) {
    throw new NetworkError(`Transcript not found: ${id}`)
  }

  // Build markdown content
  const lines: string[] = []

  // YAML frontmatter
  lines.push('---')
  lines.push(`fireflies_id: ${t.id}`)
  lines.push(`title: '${(t.title || 'Untitled').replace(/'/g, "''")}'`)
  lines.push(`date: ${t.dateString || formatDate(t.date)}`)
  lines.push(`duration: ${formatDuration(t.duration)}`)
  if (t.organizer_email) lines.push(`organizer: ${t.organizer_email}`)
  if (t.participants?.length) lines.push(`participants: [${t.participants.map((p) => `'${p}'`).join(', ')}]`)
  if (t.speakers?.length) lines.push(`speakers: [${t.speakers.map((s) => `'${s.name}'`).join(', ')}]`)
  lines.push(`transcript_url: ${t.transcript_url}`)
  if (t.meeting_link) lines.push(`meeting_link: ${t.meeting_link}`)
  lines.push(`downloaded_at: ${new Date().toISOString()}`)
  lines.push('---')
  lines.push('')

  // Title
  lines.push(`# ${t.title || 'Untitled Meeting'}`)
  lines.push('')

  // Summary section
  if (includeSummary && t.summary) {
    lines.push('## Summary')
    lines.push('')
    if (t.summary.overview) {
      lines.push('### Overview')
      lines.push(t.summary.overview)
      lines.push('')
    }
    if (t.summary.keywords?.length) {
      lines.push(`**Keywords:** ${t.summary.keywords.join(', ')}`)
      lines.push('')
    }
    if (t.summary.action_items) {
      lines.push('### Action Items')
      const items = Array.isArray(t.summary.action_items) ? t.summary.action_items : [t.summary.action_items]
      items.forEach((item) => lines.push(`- ${item}`))
      lines.push('')
    }
    if (t.summary.outline) {
      lines.push('### Outline')
      lines.push(t.summary.outline)
      lines.push('')
    }
  }

  // Analytics section
  if (includeAnalytics && t.analytics) {
    lines.push('## Analytics')
    lines.push('')
    if (t.analytics.sentiments) {
      const s = t.analytics.sentiments
      lines.push('### Sentiment')
      lines.push(`- Positive: ${s.positive_percent}%`)
      lines.push(`- Neutral: ${s.neutral_percent}%`)
      lines.push(`- Negative: ${s.negative_percent}%`)
      lines.push('')
    }
    if (t.analytics.speakers_stats?.length) {
      lines.push('### Speaker Stats')
      for (const stat of t.analytics.speakers_stats) {
        lines.push(`**${stat.speaker_name || `Speaker ${stat.speaker_id}`}:**`)
        lines.push(`- Words: ${stat.word_count}`)
        lines.push(`- Questions: ${stat.questions_asked}`)
        lines.push(`- Filler words: ${stat.filler_words}`)
        lines.push('')
      }
    }
  }

  // Transcript
  lines.push('## Transcript')
  lines.push('')

  if (t.sentences?.length) {
    // Group consecutive sentences by speaker
    let currentSpeaker: string | null = null
    let currentBlock: string[] = []
    let blockStart: string | null = null

    const flushBlock = () => {
      if (currentBlock.length === 0) return
      const speakerLabel = includeSpeakerLabels && currentSpeaker ? `**${currentSpeaker}**` : ''
      const timestamp = includeTimestamps && blockStart ? `(${formatTimestamp(blockStart)})` : ''
      const header = [speakerLabel, timestamp].filter(Boolean).join(' ')
      if (header) lines.push(header)
      lines.push(currentBlock.join(' '))
      lines.push('')
      currentBlock = []
    }

    for (const s of t.sentences) {
      const speaker = s.speaker_name || `Speaker ${s.speaker_id}`
      if (speaker !== currentSpeaker) {
        flushBlock()
        currentSpeaker = speaker
        blockStart = s.start_time
      }
      currentBlock.push(s.text || s.raw_text || '')
    }
    flushBlock()
  } else {
    lines.push('*No transcript content available.*')
    lines.push('')
  }

  const content = lines.join('\n')

  // Determine output path
  const outputArg = String(flags.output || flags.o || '').trim()
  let outPath: string

  if (outputArg) {
    outPath = resolve(outputArg)
  } else {
    const outputDir = join(PROJECT_ROOT, 'outputs', 'fireflies')
    await mkdir(outputDir, { recursive: true })
    const filename = `${sanitizeFilename(t.title || 'transcript')}_${t.id.slice(0, 8)}.md`
    outPath = join(outputDir, filename)
  }

  await mkdir(resolve(outPath, '..'), { recursive: true })
  await Bun.write(outPath, content)

  console.error(`✅ Transcript downloaded!`)
  console.error(`📄 Saved to: ${outPath}`)
  process.stdout.write(`${outPath}\n`)
}

async function cmd_upload(apiKey: string, url: string, flags: Record<string, unknown>) {
  if (!url.startsWith('https://')) {
    throw new UsageError('Audio URL must be HTTPS and publicly accessible')
  }

  const variables: Record<string, unknown> = { url }

  if (flags.title) variables.title = String(flags.title)
  if (flags.webhook) variables.webhook = String(flags.webhook)
  if (flags.language) variables.custom_language = String(flags.language)

  const data = await graphql<{ uploadAudio: UploadResult }>(apiKey, QUERIES.uploadAudio, variables)
  const result = data.uploadAudio

  if (result.success) {
    console.log('✅ Audio uploaded successfully!')
    console.log(`- Title: ${result.title || 'N/A'}`)
    console.log(`- Message: ${result.message}`)
    console.log('')
    console.log('The audio is queued for processing. Use `fireflies list` to check for the transcript once complete.')
  } else {
    throw new NetworkError(`Upload failed: ${result.message}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    print_help('fireflies', usage())
    return
  }

  const flags = parse_flags(argv, {
    // List/search options
    limit: { type: 'string' },
    skip: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    host: { type: 'string' },
    participants: { type: 'string' },
    mine: { type: 'boolean' },
    scope: { type: 'string' },
    // Get options
    json: { type: 'boolean' },
    'include-sentences': { type: 'boolean' },
    // Download options
    output: { type: 'string', alias: 'o' },
    'include-summary': { type: 'boolean' },
    'include-analytics': { type: 'boolean' },
    timestamps: { type: 'boolean' },
    'speaker-labels': { type: 'boolean' },
    'no-speaker-labels': { type: 'boolean' },
    // Upload options
    title: { type: 'string' },
    webhook: { type: 'string' },
    language: { type: 'string' },
    attendees: { type: 'string' },
  })

  const env = await load_env({ required: ['FIREFLIES_API_KEY'] })
  const apiKey = env.FIREFLIES_API_KEY

  const args = flags._
  const cmd = args[0]

  switch (cmd) {
    case 'user':
      await cmd_user(apiKey)
      break

    case 'list':
      await cmd_list(apiKey, flags)
      break

    case 'search': {
      const keyword = args.slice(1).join(' ')
      if (!keyword) {
        throw new UsageError('Search requires a keyword')
      }
      await cmd_search(apiKey, keyword, flags)
      break
    }

    case 'get': {
      const id = args[1]
      if (!id) {
        throw new UsageError('get requires a transcript ID')
      }
      await cmd_get(apiKey, id, flags)
      break
    }

    case 'download': {
      const id = args[1]
      if (!id) {
        throw new UsageError('download requires a transcript ID')
      }
      await cmd_download(apiKey, id, flags)
      break
    }

    case 'upload': {
      const url = args[1]
      if (!url) {
        throw new UsageError('upload requires an audio URL')
      }
      await cmd_upload(apiKey, url, flags)
      break
    }

    default:
      print_help('fireflies', usage())
      throw new UsageError(`Unknown command: ${cmd || '(none)'}`)
  }
}

main().catch((err) => handleError('fireflies', err))
