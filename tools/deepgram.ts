#!/usr/bin/env bun

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { parse_flags, print_help } from './_lib/cli'
import { fatal, handleError, UsageError, MissingError, NetworkError, EXIT } from './_lib/errors'
import { load_env, PROJECT_ROOT } from './_lib/env'
import { request } from './_lib/http'
import { resolvePathOrThrow } from './_lib/paths'

export const name = 'deepgram'
export const description = 'Transcribes audio and video from local files, URLs, or YouTube using Deepgram\'s Nova-3 model. Features speaker diarization with AI-powered name inference, smart formatting, and detailed metadata extraction.'

function usage() {
  return `
USAGE:
    deepgram [options] <audio_file_or_url>

INPUTS:
  - Local file path, http(s) URL, or YouTube URL (yt-dlp used automatically)

OPTIONS:
  -m, --model MODEL          Deepgram model (default: nova-3)
  -l, --language LANG        Language code (default: en-US)
  -o PATH or --output-dir DIR
                          Output file (.md) or output directory for markdown files
  --out-name NAME            Base filename (without extension) for the output markdown (optional; deprecated in favor of -o FILE.md)
  --save                     Save transcript to file (default)
  --no-save                  Print transcript to stdout only
  --description              Include extra description when available
  --add-description          Alias of --description
  --timestamps               Include timestamps (default; off when --no-diarize unless --timestamps)
  --no-timestamps            Disable timestamps
  --speaker-labels           Include speaker labels when diarization is enabled (default)
  --no-speaker-labels        Disable speaker labels
  --sentence-lines           Output one line per sentence
  --paragraph-lines          Output one block per paragraph (default)
  
  # Speaker naming (ON by default; uses OpenAI when available; falls back to heuristics for YouTube/preview)
  --no-diarize               Disable diarization
  --no-smart-format          Disable smart formatting
  --no-punctuate             Disable punctuation
  --no-paragraphs            Disable paragraph detection
  --keep-filler-words        Keep filler words
  --name-speakers            Enable name mapping (default: enabled)
  --no-name-speakers         Disable name mapping
  --speaker-lines N          Number of initial lines to send for naming (default: 100)
  --openai-model NAME        Model for speaker naming (default: gpt-5)
  
  # Optional metadata (improves naming and YAML)
  --show-title TEXT          Show/podcast title
  --episode-title TEXT       Episode/video title
  --hosts "A;B"              Known host names (semicolon/comma/pipe separated)
  --guests "X;Y"             Known guest names (semicolon/comma/pipe separated)
  --publication-date ISO     Publication date (e.g., 2025-08-11)

  # Keyterm prompting (Nova-3 only - improves recognition of domain vocabulary)
  --keyterms "term1;term2"   Domain-specific terms to boost (semicolon/comma separated, max 100)
                             Example: "GPT-4;Claude;RLHF;transformer;fine-tuning"

  # Debugging
  --debug-raw                Save raw Deepgram JSON next to the .md
  -h, --help                 Show help

 OUTPUT:
   - Markdown with YAML frontmatter. Default format merges contiguous words by speaker
     using per-word diarization into blocks like:
       Name (mm:ss)\nText...\n
   - For YouTube URLs, YAML includes title/channel/date/description when available.
 
 Tips:
   - For YouTube URLs, install yt-dlp so audio can be downloaded automatically.
   - To infer real speaker names, set OPENAI_API_KEY and use --name-speakers.
   - Default --openai-model is gpt-5; change with --openai-model NAME.
 `

}

function is_url(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function is_record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sanitize_filename_strict(value: string): string {
  const lower = value.toLowerCase()
  return lower.replace(/[^a-z0-9._]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
}

// reserved for future file naming variants
function to_snake_case(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

function humanize_duration(totalSeconds: number): string {
  const n = Number(totalSeconds)
  if (!Number.isFinite(n) || n < 0) return ''
  const hours = Math.floor(n / 3600)
  const minutes = Math.floor((n % 3600) / 60)
  const seconds = Math.floor(n % 60)
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

async function run(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; killSignal?: string }): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([cmd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs,
    killSignal: opts?.killSignal,
  })
  const out = await new Response(p.stdout).text()
  const err = await new Response(p.stderr).text()
  const code = await p.exited
  return { code, stdout: out, stderr: err }
}

// Stream child stdout/stderr directly to this process for real-time feedback
async function run_inherit(cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number; killSignal?: string }): Promise<{ code: number }> {
  const p = Bun.spawn([cmd, ...args], {
    stdout: 'inherit',
    stderr: 'inherit',
    cwd: opts?.cwd,
    timeout: opts?.timeoutMs,
    killSignal: opts?.killSignal,
  })
  const code = await p.exited
  return { code }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    print_help('deepgram - Transcribe audio/video to markdown using Deepgram', usage())
    return
  }

  let flags: ReturnType<typeof parse_flags>
  try {
    flags = parse_flags(argv, {
      model: { type: 'string', alias: 'm' },
      language: { type: 'string', alias: 'l' },
      'output-dir': { type: 'string', alias: 'o' },
      'out-name': { type: 'string' },
      'output-name': { type: 'string' },
      // Optional podcast metadata (used in YAML and naming prompt)
      'show-title': { type: 'string' },
      'episode-title': { type: 'string' },
      hosts: { type: 'string' },
      guests: { type: 'string' },
      'publication-date': { type: 'string' },
      keyterms: { type: 'string' },
      save: { type: 'boolean' },
      'no-save': { type: 'boolean' },
      description: { type: 'boolean' },
      'add-description': { type: 'boolean' },
      timestamps: { type: 'boolean' },
      'no-timestamps': { type: 'boolean' },
      'speaker-labels': { type: 'boolean' },
      'no-speaker-labels': { type: 'boolean' },
      'sentence-lines': { type: 'boolean' },
      'paragraph-lines': { type: 'boolean' },
      'name-speakers': { type: 'boolean' },
      'no-name-speakers': { type: 'boolean' },
      'speaker-lines': { type: 'string' },
      'openai-model': { type: 'string' },
      // debug: save raw Deepgram JSON next to output md
      'debug-raw': { type: 'boolean' },
      'no-diarize': { type: 'boolean' },
      'no-smart-format': { type: 'boolean' },
      'no-punctuate': { type: 'boolean' },
      'no-paragraphs': { type: 'boolean' },
      'keep-filler-words': { type: 'boolean' },
    })
  } catch (err) {
    print_help('deepgram', usage())
    throw new UsageError((err as Error)?.message || 'Invalid arguments')
  }

  if (flags._.length !== 1) {
    print_help('deepgram', usage())
    throw new UsageError('Exactly one input (file or URL) is required')
  }

  const env = await load_env({ required: ['DEEPGRAM_API_KEY'] })
  const apiKey = env.DEEPGRAM_API_KEY
  const openaiKey = env.OPENAI_API_KEY || ''

  const input = String(flags._[0])

  const model = (flags.model) || 'nova-3'
  const language = (flags.language) || 'en-US'
  const diarize = flags['no-diarize'] ? false : true
  const smartFormat = flags['no-smart-format'] ? false : true
  const punctuate = flags['no-punctuate'] ? false : true
  const paragraphs = flags['no-paragraphs'] ? false : true
  const fillerWords = flags['keep-filler-words'] ? true : false
  const utterances = true
  const measurements = true
  const numerals = true
  const includeDescription = Boolean(flags.description || flags['add-description'])
  const shouldSave = flags['no-save'] ? false : true
  const explicitTsOn = Boolean(flags['timestamps'])
  const explicitTsOff = Boolean(flags['no-timestamps'])
  let includeTimestamps: boolean
  if (explicitTsOn) includeTimestamps = true
  else if (explicitTsOff) includeTimestamps = false
  else includeTimestamps = diarize ? true : false
  const includeSpeakers = (flags['no-speaker-labels'] || flags['no-diarize']) ? false : true
  const sentenceLines = flags['sentence-lines'] ? true : false
  const wantNameSpeakers = Boolean(flags['name-speakers'])
  const speakerLinesSample = Math.max(1, Number(flags['speaker-lines'] || '100'))
  const openaiModel = String(flags['openai-model'] || 'gpt-5')
  const debugRaw = Boolean(flags['debug-raw'])

  // Optional metadata flags
  const metaShowTitle = String(flags['show-title'] || '').trim()
  const metaEpisodeTitle = String(flags['episode-title'] || '').trim()
  const metaPublicationDate = String(flags['publication-date'] || '').trim()
  const metaHosts = String(flags['hosts'] || '')
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const metaGuests = String(flags['guests'] || '')
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean)

  // Keyterms for Nova-3 (improves recognition of domain vocabulary)
  const keyterms = String(flags['keyterms'] || '')
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100) // Max 100 keyterms per Deepgram docs

  // Output selection: support -o FILE.md (explicit) or --output-dir DIR + optional --out-name
  const outArgRaw = String(flags['output-dir'] || '').trim()
  let explicitOutPath = ''
  let outputDir = ''
  if (outArgRaw) {
    if (/\.(?:md|markdown)$/i.test(outArgRaw)) {
      explicitOutPath = resolve(outArgRaw)
    } else {
      outputDir = outArgRaw
    }
  }
  if (!outputDir && !explicitOutPath) {
    outputDir = join(PROJECT_ROOT, 'outputs')
  }
  const outNameOverrideRaw = String(flags['out-name'] || flags['output-name'] || '').trim()
  const outNameOverride = outNameOverrideRaw ? sanitize_filename_strict(outNameOverrideRaw) : ''

  const query = new URLSearchParams({
    model: String(model),
    language: String(language),
    diarize: String(diarize),
    smart_format: String(smartFormat),
    punctuate: String(punctuate),
    paragraphs: String(paragraphs),
    numerals: String(numerals),
    filler_words: String(fillerWords),
    utterances: String(utterances),
    measurements: String(measurements),
  })

  // Add keyterms for Nova-3 (each as separate parameter)
  for (const term of keyterms) {
    query.append('keyterm', term)
  }
  if (keyterms.length > 0) {
    console.error(`→ Using ${keyterms.length} keyterms for improved recognition`)
  }

  const apiUrl = `https://api.deepgram.com/v1/listen?${query.toString()}`

  type DeepgramWord = { word?: string; punctuated_word?: string; start?: number; end?: number; speaker?: number }
  type DeepgramUtterance = { speaker?: number; transcript?: string; start?: number; end?: number }
  type DeepgramSentence = { text?: string; start?: number; end?: number }
  type DeepgramParagraph = { sentences?: DeepgramSentence[] }
  type DeepgramAlternative = { transcript?: string; words?: DeepgramWord[]; paragraphs?: { paragraphs?: DeepgramParagraph[] } }
  type DeepgramChannel = { alternatives?: DeepgramAlternative[] }
  type DeepgramResults = { channels?: DeepgramChannel[]; utterances?: DeepgramUtterance[] }
  type DeepgramMetadata = { request_id?: string }
  type DeepgramResponse = { results?: DeepgramResults; error?: string; metadata?: DeepgramMetadata; __yt_meta?: Record<string, unknown> }

  let dgRes: DeepgramResponse | string
  const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(input)

  if (is_url(input) && !isYouTube) {
    console.error('→ Uploading remote URL to Deepgram...')
    const body = { url: input }
    const { data } = await request({
      method: 'POST',
      url: apiUrl,
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
      body,
      timeoutMs: 600_000, // long-running fetch on Deepgram side
      retries: 2,
      prefetchDNS: true,
      preconnect: true,
      verbose: Bun.env.AI_CLI_DEBUG_HTTP === '1' ? 'curl' : undefined,
    })
    dgRes = data as DeepgramResponse | string
  } else if (!is_url(input)) {
    console.error('→ Uploading local file to Deepgram...')
    const absPath = resolvePathOrThrow(input)
    let mime = 'audio/mpeg'
    const ext = absPath.split('.').pop()?.toLowerCase()
    if (ext === 'wav') mime = 'audio/wav'
    else if (ext === 'mp3') mime = 'audio/mpeg'
    else if (ext === 'mp4') mime = 'video/mp4'
    else if (ext === 'm4a') mime = 'audio/mp4'
    else if (ext === 'mov') mime = 'video/quicktime'
    else if (ext === 'avi') mime = 'video/avi'
    else if (ext === 'opus' || ext === 'ogg') mime = 'audio/ogg'
    else if (ext === 'webm') mime = 'audio/webm'
    const bin = await Bun.file(absPath).bytes()
    const { data } = await request({
      method: 'POST',
      url: apiUrl,
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mime },
      body: bin,
      timeoutMs: 1_800_000, // 30 min for large uploads on slow connections
      retries: 2,
      prefetchDNS: true,
      preconnect: true,
      verbose: Bun.env.AI_CLI_DEBUG_HTTP === '1' ? 'curl' : undefined,
    })
    dgRes = data as DeepgramResponse | string
  } else {
    // YouTube mode: download audio with yt-dlp, extract metadata, then upload binary
    // 1) Ensure yt-dlp exists (spawn will error if missing)
    // 2) Try metadata fetch
    console.error('→ Resolving YouTube metadata...')
    let meta = {}
    try {
      const metaRun = await run('yt-dlp', ['-j', '--no-warnings', '--no-playlist', '--skip-download', input])
      if (metaRun.code === 0) {
        try { meta = JSON.parse(metaRun.stdout.split('\n')[0] || '{}') } catch {}
      }
    } catch {}

    const tmpDir = await mkdtemp(join(tmpdir(), 'deepgram_yt_'))
    const outTemplate = join(tmpDir, 'audio.%(ext)s')
    console.error('→ Downloading audio with yt-dlp (progress will be shown)...')
    const attempts = [
      ['-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outTemplate, input],
      ['--extractor-args', 'youtube:player_client=ios', '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outTemplate, input],
      ['--cookies-from-browser', 'safari', '--extractor-args', 'youtube:player_client=ios', '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outTemplate, input],
      ['--cookies-from-browser', 'chrome', '--extractor-args', 'youtube:player_client=ios', '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1', '-x', '--audio-format', 'mp3', '--audio-quality', '0', '-o', outTemplate, input],
    ]
    let downloadedPath = ''
    for (const args of attempts) {
      try {
        // Stream progress so users don't think it's hung; allow 15 minutes
        const r = await run_inherit('yt-dlp', args, { cwd: tmpDir, timeoutMs: 900_000, killSignal: 'SIGKILL' })
        // success means file should exist; find it without shelling out
        const files = await (await import('node:fs/promises')).readdir(tmpDir)
        const found = files.find((f) => /^audio\./.test(f))
        if (r.code === 0 && found) { downloadedPath = join(tmpDir, found); break }
      } catch {}
    }
    if (!downloadedPath) {
      await rm(tmpDir, { recursive: true, force: true })
      throw new NetworkError('yt-dlp could not download audio (check cookies/age/region).')
    }
    console.error('→ Uploading audio to Deepgram...')
    // Upload to Deepgram
    const ext = downloadedPath.split('.').pop()?.toLowerCase()
    let mime = 'audio/mpeg'
    if (ext === 'wav') mime = 'audio/wav'
    else if (ext === 'mp3') mime = 'audio/mpeg'
    else if (ext === 'm4a') mime = 'audio/mp4'
    const bin = await Bun.file(downloadedPath).bytes()
    const { data } = await request({
      method: 'POST',
      url: apiUrl,
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': mime },
      body: bin,
      timeoutMs: 600_000,
      retries: 2,
      prefetchDNS: true,
      preconnect: true,
      verbose: Bun.env.AI_CLI_DEBUG_HTTP === '1' ? 'curl' : undefined,
    })
    dgRes = data as DeepgramResponse | string
    // Clean up temp dir
    await rm(tmpDir, { recursive: true, force: true })
    // Attach some meta fields for YAML
    if (typeof dgRes === 'object') dgRes.__yt_meta = meta
  }

  if (!dgRes || dgRes === '') fatal('Empty response from Deepgram', EXIT.NETWORK)
  if (typeof dgRes === 'object' && dgRes.error) fatal(`Deepgram error: ${dgRes.error}`, EXIT.NETWORK)

  console.error('→ Processing transcript...')
  if (typeof dgRes === 'string') fatal('Invalid response from Deepgram', EXIT.NETWORK)
  const alt = dgRes?.results?.channels?.[0]?.alternatives?.[0]
  let transcript = ''
  // Prefer diarized utterances with timestamps when available
  const utter = Array.isArray(dgRes?.results?.utterances) ? dgRes.results.utterances : []
  const altWords = Array.isArray(alt?.words) ? alt.words : null
  function fmtTs(sec: number): string {
    const n = Number(sec || 0)
    if (!Number.isFinite(n) || n < 0) return ''
    const h = Math.floor(n / 3600)
    const m = Math.floor((n % 3600) / 60)
    const s = Math.floor(n % 60)
    const hh = h > 0 ? `${h}:` : ''
    const mm = (h > 0 ? String(m).padStart(2, '0') : String(m))
    const ss = String(s).padStart(2, '0')
    return `${hh}${mm}:${ss}`
  }
  const hasParagraphs = Boolean(alt?.paragraphs?.paragraphs && Array.isArray(alt.paragraphs.paragraphs))
  const hasUtterances = utter.length > 0
  const hasWordSpeakers = Array.isArray(altWords) && altWords.some((w) => w && w.speaker !== undefined)

  if (includeSpeakers && hasWordSpeakers) {
    // Highest precision diarization: per-word speakers with smart splitting
    const lines: string[] = []
    lines.push('## Transcript')
    lines.push('')
    let curSpeaker: number | null = null
    let curStart: number | null = null
    let lastStart: number | null = null
    let curParts: string[] = []
    const flush = () => {
      if (curSpeaker === null || curParts.length === 0) return
      const nameLabel = (includeSpeakers && Number.isFinite(curSpeaker)) ? `S${String(curSpeaker)}` : ''
      const tsRaw = (curStart !== null) ? fmtTs(curStart) : ''
      const ts = includeTimestamps && tsRaw ? `(${tsRaw})` : ''
      const header = [nameLabel, ts].filter(Boolean).join(' ')
      if (header) lines.push(header)
      lines.push(curParts.join(' ').replace(/\s+/g, ' ').trim())
      lines.push('')
    }
    const shouldFlushOnPunct = (token: string): boolean => sentenceLines && /[.!?]$/.test(token)
    const shouldFlushOnGap = (prev: number | null, now: number | null): boolean => {
      if (prev === null || now === null) return false
      return (now - prev) > 4 // seconds
    }
    for (const w of altWords) {
      const word = String(w?.punctuated_word || w?.word || '').trim()
      const spk = (w?.speaker !== undefined) ? w.speaker : null
      const start = (w?.start !== undefined) ? Number(w.start) : null
      if (!word) continue
      if (curSpeaker === null) {
        curSpeaker = spk
        curStart = start
        lastStart = start
        curParts = [word]
        continue
      }
      const gap = shouldFlushOnGap(lastStart, start)
      const changeSpeaker = (spk !== curSpeaker)
      if (gap || changeSpeaker) {
        flush()
        curSpeaker = spk
        curStart = start
        lastStart = start
        curParts = [word]
        continue
      }
      curParts.push(word)
      lastStart = start
      if (shouldFlushOnPunct(word)) {
        flush()
        // continue same speaker block after sentence
        curSpeaker = spk
        curStart = start
        lastStart = start
        curParts = []
      }
    }
    flush()
    transcript = lines.join('\n')
  } else if (includeSpeakers && hasUtterances) {
    // Diarized by utterances (fallback)
    const lines: string[] = []
    lines.push('## Transcript')
    lines.push('')
    let curSpeaker: number | null = null
    let curStart: number | null = null
    let curParts: string[] = []
    const flush = () => {
      if (curParts.length === 0) return
      const nameLabel = (includeSpeakers && Number.isFinite(curSpeaker)) ? `S${String(curSpeaker)}` : ''
      const tsRaw = (curStart !== null) ? fmtTs(curStart) : ''
      const ts = includeTimestamps && tsRaw ? `(${tsRaw})` : ''
      const header = [nameLabel, ts].filter(Boolean).join(' ')
      if (header) lines.push(header)
      lines.push(curParts.join(' ').replace(/\s+/g, ' ').trim())
      lines.push('')
    }
    const splitSentences = (t: string): string[] => sentenceLines ? String(t).split(/(?<=[.!?])\s+/).filter(Boolean) : [t]
    for (let i = 0; i < utter.length; i++) {
      const u = utter[i]
      const text = String(u?.transcript || '').trim()
      const spk = (u?.speaker !== undefined) ? u.speaker : null
      if (!text) continue
      const parts = splitSentences(text)
      if (curSpeaker === null) {
        curSpeaker = spk
        curStart = (u?.start !== undefined) ? u.start : null
        curParts = parts
        continue
      }
      if (spk === curSpeaker) {
        // prevent mega paragraphs: flush if block grows too large
        if ((curParts.join(' ').length + text.length) > 1200) {
          flush()
          curStart = (u?.start !== undefined) ? u.start : null
          curParts = parts
        } else {
          curParts.push(...parts)
        }
      } else {
        flush()
        curSpeaker = spk
        curStart = (u?.start !== undefined) ? u.start : null
        curParts = parts
      }
    }
    flush()
    transcript = lines.join('\n')
  } else if (hasParagraphs && alt?.paragraphs?.paragraphs) {
    const para = alt.paragraphs.paragraphs
    const lines: string[] = []
    lines.push('## Transcript')
    lines.push('')
    if (sentenceLines) {
      for (const p of para) {
        for (const s of (p.sentences || [])) {
          const tsRaw = s.start !== undefined ? fmtTs(s.start) : ''
          const ts = includeTimestamps && tsRaw ? `[${tsRaw}] ` : ''
          const text = String(s.text || '').trim()
          if (!text) continue
          lines.push(`${ts}${text}`)
        }
      }
    } else {
      for (const p of para) {
        const first = (p.sentences?.[0]) ? p.sentences[0] : null
        const tsRaw = (first?.start !== undefined) ? fmtTs(first.start) : ''
        const ts = includeTimestamps && tsRaw ? `[${tsRaw}] ` : ''
        const text = (p.sentences || []).map((s) => s.text || '').join(' ').trim()
        if (!text) continue
        lines.push(`${ts}${text}\n`)
      }
    }
    transcript = lines.join('\n')
  } else if (altWords && altWords.length > 0) {
    // Per-word without speakers (unlikely) or speakers not requested; keep readable splits
    const lines: string[] = []
    lines.push('## Transcript')
    lines.push('')
    let curParts: string[] = []
    let lastStart: number | null = null
    const flush = () => {
      if (!curParts.length) return
      lines.push(curParts.join(' ').replace(/\s+/g, ' ').trim())
      lines.push('')
    }
    const shouldFlushOnPunct = (token: string): boolean => sentenceLines && /[.!?]$/.test(token)
    for (const w of altWords) {
      const word = String(w?.punctuated_word || w?.word || '').trim()
      const start = (w?.start !== undefined) ? Number(w.start) : null
      if (!word) continue
      if (lastStart !== null && start !== null && (start - lastStart) > 6) {
        flush()
        curParts = []
      }
      curParts.push(word)
      lastStart = start
      if (shouldFlushOnPunct(word) || curParts.join(' ').length > 1200) {
        flush()
        curParts = []
      }
    }
    flush()
    transcript = lines.join('\n')
  } else if (alt?.transcript) {
    const t = String(alt?.transcript || '').trim()
    transcript = t ? `## Transcript\n${t}` : ''
  }

  if (!transcript || transcript === 'null') fatal('No transcript found in response', EXIT.NETWORK)

  const requestId = dgRes?.metadata?.request_id ?? ''

  if (!shouldSave) {
    process.stdout.write(`${transcript}\n`)
    return
  }

  // Ensure parent directory exists for explicit path or output directory
  await mkdir(explicitOutPath ? dirname(explicitOutPath) : outputDir, { recursive: true })

  let baseName = outNameOverride || ''
  if (is_url(input)) {
    // YouTube parity: prefer title___channel___youtube_transcript, else youtube_<id>
    const yt = dgRes?.__yt_meta ?? null
    if (!baseName && (yt?.title || yt?.channel || yt?.uploader)) {
      const titleSnake = to_snake_case(String(yt.title || ''))
      const channelSnake = to_snake_case(String(yt.channel || yt.uploader || ''))
      if (titleSnake && channelSnake) {
        baseName = sanitize_filename_strict(`${titleSnake}___${channelSnake}___youtube_transcript`)
      } else if (titleSnake) {
        baseName = sanitize_filename_strict(`${titleSnake}___youtube_transcript`)
      }
    }
    if (!baseName) {
      // Fallback to video id if present
      const vid = yt?.id ? String(yt.id) : ''
      if (vid) baseName = sanitize_filename_strict(`youtube_${vid}`)
    }
    if (!baseName) {
      // Final fallback: host + path
      try {
        const urlObj = new URL(input)
        const host = urlObj.host.replace(/^www\./, '')
        const pathPart = urlObj.pathname.replace(/\/+$/, '').replace(/\//g, '_')
        baseName = sanitize_filename_strict(pathPart ? `${host}_${pathPart}` : host)
      } catch {
        baseName = 'transcript'
      }
    }
  } else {
    if (!baseName) {
      const justName = basename(input).replace(/\.[^.]*$/, '')
      baseName = sanitize_filename_strict(justName)
    }
  }

  const outPath = explicitOutPath || join(outputDir, `${baseName}.md`)
  const rawPath = outPath.replace(/\.md$/i, '.raw.json')

  const nowIso = new Date().toISOString()
  const source = is_url(input) ? 'url' : 'local'

  let fm = `---\n`
  fm += `url: ${is_url(input) ? input : resolve(input)}\n`
  // YouTube enrichment
  if (dgRes.__yt_meta) {
    const m = dgRes.__yt_meta || {}
    const title = m.title ? String(m.title) : ''
    const channel = m.channel ? String(m.channel) : (m.uploader ? String(m.uploader) : '')
    const uploadDate = m.upload_date ? String(m.upload_date) : ''
    let pubDateIso = ''
    if (/^\d{8}$/.test(uploadDate)) {
      pubDateIso = `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}`
    }
    const durationSec = m.duration ? Number(m.duration) : undefined
    const durationHuman = durationSec ? humanize_duration(durationSec) : ''
    const videoId = m.id ? String(m.id) : ''
    const canonical = videoId ? `https://www.youtube.com/watch?v=${videoId}` : input
    if (title) fm += `title: '${title.replace(/'/g, "''")}'\n`
    if (channel) fm += `channel: '${channel.replace(/'/g, "''")}'\n`
    if (pubDateIso) fm += `publication_date: ${pubDateIso}\n`
    if (durationHuman) fm += `duration: ${durationHuman}\n`
    // override url to canonical if available
    if (canonical) fm = fm.replace(/^url: .*$/m, `url: ${canonical}`)
    if (includeDescription && m.description) {
      fm += `description: |\n`
      const desc = String(m.description)
      fm += desc.split('\n').map((line) => `  ${line}`).join('\n') + '\n'
    }
  }
  fm += `transcription_date: ${nowIso}\n`
  fm += `source: ${source}\n`
  if (requestId) fm += `deepgram_id: ${requestId}\n`
  fm += `diarized: ${String(diarize)}\n`
  fm += `timestamps: ${String(includeTimestamps)}\n`
  if (metaShowTitle) fm += `show_title: '${metaShowTitle.replace(/'/g, "''")}'\n`
  if (metaEpisodeTitle) fm += `episode_title: '${metaEpisodeTitle.replace(/'/g, "''")}'\n`
  if (metaPublicationDate) fm += `publication_date: ${metaPublicationDate}\n`
  if (metaHosts.length) fm += `hosts: [${metaHosts.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ')}]\n`
  if (metaGuests.length) fm += `guests: [${metaGuests.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ')}]\n`
  fm += `---\n\n`
  let finalText = `${fm}${transcript}`
  if (debugRaw) {
    try { await Bun.write(rawPath, JSON.stringify(dgRes, null, 2)) } catch {}
  }
  if (wantNameSpeakers) {
    try {
      const preview = transcript.split('\n').slice(0, speakerLinesSample).join('\n')
      const knownNames = [...metaHosts, ...metaGuests]
      const contextLines: string[] = []
      if (metaShowTitle) contextLines.push(`Show title: ${metaShowTitle}`)
      if (metaEpisodeTitle) contextLines.push(`Episode title: ${metaEpisodeTitle}`)
      if (knownNames.length) contextLines.push(`Known speaker names: ${knownNames.join(', ')}`)
      // YouTube-specific context (do not affect podcast/podchaser flow)
      // Also collect candidate names for heuristic mapping (used when OpenAI key is absent)
      let ytCandidateNames: string[] = []
      if (dgRes.__yt_meta) {
        const m = dgRes.__yt_meta || {}
        const ytChannel = String(m.channel || m.uploader || '').trim()
        const ytTitle = String(m.title || '').trim()
        const ytUploadDate = String(m.upload_date || '').trim()
        if (ytChannel) contextLines.push(`YouTube channel: ${ytChannel}`)
        if (ytTitle) contextLines.push(`YouTube video title: ${ytTitle}`)
        if (ytUploadDate) contextLines.push(`YouTube upload date: ${ytUploadDate}`)
        // Derive candidate names from title/description heuristics
        const candidateFromMeta = new Set<string>()
        const addCand = (s: string): void => {
          const v = String(s || '').trim()
          if (!v) return
          // Skip generic tokens
          if (/^(official|the|podcast|channel|clips|highlights)$/i.test(v)) return
          candidateFromMeta.add(v)
        }
        const scanTitleForNames = (t: string): string[] => {
          const names: string[] = []
          const txt = String(t || '')
          const patterns = [
            /w\/?\s+([^\-|–—()\[\]|]+)\b/i,
            /with\s+([^\-|–—()\[\]|]+)\b/i,
            /feat\.?\s+([^\-|–—()\[\]|]+)\b/i,
            /ft\.?\s+([^\-|–—()\[\]|]+)\b/i,
            /\bx\s+([^\-|–—()\[\]|]+)\b/i,
          ]
          for (const re of patterns) {
            const m = txt.match(re)
            if (m?.[1]) names.push(m[1].trim())
          }
          const pm = txt.match(/\((?:with|w\/)\s*([^)]+)\)/i)
          if (pm?.[1]) names.push(pm[1].trim())
          return names
        }
        if (ytTitle) {
          for (const n of scanTitleForNames(ytTitle)) addCand(n)
        }
        const desc = String(m.description || '')
        if (desc) {
          const first = desc.split('\n').slice(0, 8).join(' ')
          // crude Proper-Case multiword detector (e.g., "Teresa Torres", "Hamel Husain")
          const proper = first.match(/\b([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g) || []
          for (const n of proper) addCand(n)
        }
        const candList = Array.from(candidateFromMeta) as string[]
        ytCandidateNames = candList
        if (candList.length) contextLines.push(`Candidate names from YouTube metadata: ${candList.join(', ')}`)
      }
      const prompt = [
        'Task: Infer real PERSON names for diarized speakers S0, S1, S2… from the snippet below. Use world knowledge to correct misspellings and choose canonical spellings.',
        'Rules:',
        '- Output ONLY a JSON array of strings in order [S0, S1, S2, …]. No prose before or after.',
        '- Do NOT use roles like Host/Guest/Interviewer; use real names only.',
        '- If you cannot infer a real name with high confidence, return the original label (e.g., "S2").',
        '- Prefer widely-known spellings when show or person is recognizable (e.g., correct common transcription errors).',
        '',
        ...contextLines,
        '',
        'Snippet:',
        preview,
      ].join('\n')
      // Build present speaker indices and heuristic mapping before LLM
      const presentIdxFromTranscript: number[] = Array.from(new Set(Array.from(transcript.matchAll(/^S(\d+)\s*\(/gm)).map((m) => Number(m[1])))).sort((a, b) => a - b)
      const presentIdxFromUtter: number[] = Array.from(new Set((utter || []).map((u) => u?.speaker).filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))).sort((a, b) => a - b)
      const presentIdxAll: number[] = (presentIdxFromUtter.length ? presentIdxFromUtter : presentIdxFromTranscript)

      // Map first non-empty block text per speaker from preview
      const firstBlockBySpeaker = new Map<number, string>()
      {
        let cur: number | null = null
        const lines = preview.split('\n')
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? ''
          const hdr = line.match(/^S(\d+)\s*\(/)
          if (hdr) {
            cur = Number(hdr[1])
            let j = i + 1
            while (j < lines.length && !(lines[j]?.trim())) j++
            const nextLine = lines[j]
            if (j < lines.length && nextLine?.trim()) {
              if (!firstBlockBySpeaker.has(cur)) firstBlockBySpeaker.set(cur, nextLine.trim())
            }
          }
        }
      }

      // Heuristic mapping: match self-introductions and candidate name mentions
      const mappingHeuristic = new Map<number, string>()
      const candidateNames = Array.from(new Set([...knownNames, ...ytCandidateNames]))
      const containsSelfIntro = (text: string, name: string): boolean => {
        const t = ` ${String(text || '')} `.toLowerCase()
        const n = String(name || '').toLowerCase()
        return (/(^|\W)i['']m\s+/.test(t) && t.includes(n))
          || (/(^|\W)i am\s+/.test(t) && t.includes(n))
          || (/(^|\W)my name is\s+/.test(t) && t.includes(n))
          || (/(^|\W)this is\s+/.test(t) && t.includes(n))
      }
      for (const idx of presentIdxAll) {
        const block = firstBlockBySpeaker.get(Number(idx)) || ''
        for (const name of candidateNames) {
          if (!mappingHeuristic.has(idx) && containsSelfIntro(block, name)) {
            mappingHeuristic.set(idx, String(name).trim())
          }
        }
      }
      // If two speakers and two candidates and still unmapped, assign by order, preferring channel/uploader as first
      if (mappingHeuristic.size === 0 && presentIdxAll.length === 2 && candidateNames.length >= 2) {
        const ordered = candidateNames.slice(0, 2)
        const ytChannel = dgRes.__yt_meta ? String((dgRes.__yt_meta.channel || dgRes.__yt_meta.uploader || '')).trim() : ''
        if (ytChannel) {
          const ci = ordered.findIndex((n) => n.toLowerCase() === ytChannel.toLowerCase())
          if (ci > -1) {
            const removed = ordered.splice(ci, 1)
            const channelName = removed[0]
            if (channelName) ordered.unshift(channelName)
          }
        }

        const idx0 = presentIdxAll[0]
        const idx1 = presentIdxAll[1]
        const name0 = ordered[0]
        const name1 = ordered[1]
        if (typeof idx0 === 'number' && typeof idx1 === 'number' && typeof name0 === 'string' && typeof name1 === 'string') {
          mappingHeuristic.set(idx0, name0)
          mappingHeuristic.set(idx1, name1)
        }
      }

      let names: string[] = []
      if (openaiKey) {
        const res = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${openaiKey}` },
          body: JSON.stringify({ model: openaiModel, input: prompt })
        })
        const data: unknown = await res.json().catch(() => null)

        let text = ''
        if (is_record(data) && typeof data['output_text'] === 'string') {
          text = data['output_text']
        } else {
          const output = is_record(data) ? data['output'] : undefined
          const output_items = Array.isArray(output) ? output : []
          const message = output_items.find((item) => is_record(item) && item['type'] === 'message')
          const content = is_record(message) ? message['content'] : undefined
          const content_items = Array.isArray(content) ? content : []
          const output_text_item = content_items.find((item) => is_record(item) && item['type'] === 'output_text')
          const raw_text = is_record(output_text_item) ? output_text_item['text'] : undefined
          text = typeof raw_text === 'string' ? raw_text : ''
        }

        const jsonLine = (text.match(/\[[\s\S]*\]/) || [])[0] || ''
        try { names = JSON.parse(jsonLine) } catch {}
      }

      // Build robust mapping from S{idx} → name using LLM output and metadata fallbacks
      const presentIdx = presentIdxAll

      // Normalize names from LLM (skip placeholders like "S1")
      const llmMap = new Map<number, string>()
      if (Array.isArray(names)) {
        names.forEach((n, idx) => {
          const safe = String(n || '').trim()
          if (safe && !/^S\d+$/i.test(safe)) llmMap.set(idx, safe)
        })
      }
      const knownSet = new Set(knownNames)
      const usedKnown = new Set(Array.from(llmMap.values()).filter((v) => knownSet.has(v)))
      const unusedKnown = knownNames.filter((n) => !usedKnown.has(n))

      const mapping = new Map<number, string>(llmMap)
      for (const idx of presentIdx) {
        if (!mapping.has(idx)) {
          // Prefer heuristic mapping (YouTube) first
          const heuristicName = mappingHeuristic.get(idx)
          if (heuristicName) {
            mapping.set(idx, heuristicName)
          } else {
            const fallback = unusedKnown.shift()
            if (fallback) mapping.set(idx, fallback)
          }
        }
      }

      if (mapping.size > 0) {
        let body = `${fm}${transcript}`
        for (const [idx, name] of Array.from(mapping.entries())) {
          const safe = String(name || '').trim() || `Speaker ${idx}`
          const re = new RegExp(`^S${idx}(?=\\s\\()`, 'gm')
          body = body.replace(re, safe)
        }
        finalText = body
      }
    } catch {}
  }

  await Bun.write(outPath, finalText)
  console.error(`\n✅ Transcription completed!`)
  console.error(`📄 Output saved to: ${outPath}`)
  process.stdout.write(`${outPath}\n`)
}

main().catch((err) => handleError('deepgram', err))
