#!/usr/bin/env bun

import { parse_flags, print_help } from './_lib/cli'
import { fatal, handleError, UsageError, EXIT } from './_lib/errors'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'summarize'
export const description = 'Summarization pipeline for deep-context monthly exports. Shells out to anthropic.ts, openai.ts, gemini.ts.'

const PROJECT_ROOT = dirname(import.meta.dir)
const BASE_DIR = resolve(PROJECT_ROOT, 'data/deep_context/summaries')
const BUN = resolve(process.env.HOME ?? '', '.bun/bin/bun')
const TOOLS_DIR = import.meta.dir

const USAGE = `${name} — Summarization pipeline for deep-context monthly exports

USAGE
  summarize run [options]         Run a summarization prompt against an export
  summarize compare [options]     Compare multiple outputs with scoring
  summarize list-prompts          List available prompt files
  summarize list-models           List available models from each provider

RUN OPTIONS
  --prompt FILE         Prompt file (relative to summaries/ or absolute)
  --system FILE         System prompt file (default: prompts/system.md in same dir as prompt)
  --export FILE         Export file to summarize (relative to summaries/ or absolute)
  --model MODEL         Model name (auto-detects provider from prefix)
  --method direct|condense  Synthesis method (default: direct)
  --output FILE         Output file path
  --intermediates-dir DIR  Directory for condense intermediates
  --sections JSON       Custom section split config (JSON array of header patterns)
  --max-tokens NUM      Max output tokens (default: provider default — omit unless needed)
  --temperature NUM     Temperature (default: 1.0)
  --thinking            Enable extended thinking (Anthropic only)
  --thinking-budget NUM Thinking token budget (default: let model decide)
  --effort LEVEL        Effort level: low, medium, high (4.6 models only)
  --beta HEADER         Beta feature header (e.g. context-1m-2025-08-07)

COMPARE OPTIONS
  --files FILE,FILE,... Comma-separated output files to compare
  --model MODEL         Model for comparison (default: claude-sonnet-4-5-20250929)
  --output FILE         Comparison output file
  --max-tokens NUM      Max output tokens (default: provider default — omit unless needed)

MODELS (auto-detected from name prefix)
  claude-*              → anthropic.ts (default: claude-sonnet-4-5-20250929)
  gpt-*, o3*, o4*       → openai.ts (default: gpt-5)
  gemini-*              → gemini.ts (default: gemini-3-flash)

EXAMPLES
  # Direct mode with 1M context + thinking (Sonnet 4.5)
  summarize run --prompt experiments/v6/prompts/02-narrative-briefing.md \\
    --export january-2026-v4.md --model claude-sonnet-4-5-20250929 \\
    --thinking --beta context-1m-2025-08-07

  # Direct mode with Gemini (large context)
  summarize run --prompt experiments/v6/prompts/02-narrative-briefing.md \\
    --export january-2026-v4.md --model gemini-2.5-pro

  # Condense mode with Sonnet (split → condense → synthesize)
  summarize run --prompt experiments/v6/prompts/02-narrative-briefing.md \\
    --export january-2026-v4.md --model claude-sonnet-4-5-20250929 \\
    --method condense --intermediates-dir experiments/v6/intermediates/

  # Compare outputs
  summarize compare --files output-a.md,output-b.md --output comparison.md`

// --- Provider detection ---

type Provider = 'anthropic' | 'openai' | 'gemini'

function detectProvider(model: string): Provider {
  if (model.startsWith('claude-')) return 'anthropic'
  if (model.startsWith('gpt-') || model.startsWith('o3') || model.startsWith('o4')) return 'openai'
  if (model.startsWith('gemini-')) return 'gemini'
  fatal(`Cannot detect provider for model "${model}". Expected prefix: claude-*, gpt-*, o3*, o4*, gemini-*`, EXIT.USAGE)
}

function providerTool(provider: Provider): string {
  return join(TOOLS_DIR, `${provider}.ts`)
}

// --- Path resolution ---

function resolvePath(p: string): string {
  if (isAbsolute(p)) return p
  return join(BASE_DIR, p)
}

function ensureFile(p: string, label: string): string {
  const resolved = resolvePath(p)
  if (!existsSync(resolved)) {
    fatal(`${label} not found: ${resolved}`, EXIT.MISSING)
  }
  return resolved
}

function ensureDir(p: string): string {
  const resolved = resolvePath(p)
  if (!existsSync(resolved)) {
    mkdirSync(resolved, { recursive: true })
  }
  return resolved
}

function ensureParentDir(p: string): string {
  const resolved = resolvePath(p)
  const parent = dirname(resolved)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }
  return resolved
}

// --- LLM calling ---

interface CallOptions {
  thinking?: boolean
  thinkingBudget?: number
  effort?: string
  beta?: string
}

interface CallResult {
  tokensIn?: number
  tokensOut?: number
  elapsedMs: number
}

async function callLLM(
  model: string,
  systemPrompt: string,
  userMessage: string,
  outputFile: string,
  maxTokens: number | undefined,
  temperature: number,
  opts: CallOptions = {},
): Promise<CallResult> {
  const provider = detectProvider(model)
  const tool = providerTool(provider)
  const resolvedOutput = ensureParentDir(outputFile)

  // Write user message to a temp file to pipe via stdin
  const tmpFile = join(BASE_DIR, `.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}.md`)
  await Bun.write(tmpFile, userMessage)

  // Build args — use streaming by default (needed for large outputs to avoid HTTP timeouts)
  // Only pass --max-tokens when explicitly specified; otherwise let each provider use its own default
  const args = [BUN, tool, '-m', model, '-s', systemPrompt, '-o', resolvedOutput]
  if (maxTokens !== undefined) {
    args.push('--max-tokens', String(maxTokens))
  }
  if (temperature !== 1.0 && !opts.thinking) {
    // Temperature not compatible with extended thinking
    args.push('-t', String(temperature))
  }
  if (opts.thinking) {
    args.push('--thinking')
    if (opts.thinkingBudget) {
      args.push('--thinking-budget', String(opts.thinkingBudget))
    }
  }
  if (opts.effort) {
    args.push('--effort', opts.effort)
  }
  if (opts.beta) {
    args.push('--beta', opts.beta)
  }

  const start = Date.now()

  try {
    const proc = Bun.spawn(args, {
      stdin: Bun.file(tmpFile),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      console.error(`[summarize] Provider exited with code ${exitCode}`)
      if (stderr.trim()) console.error(stderr.trim())
      if (stdout.trim()) console.error(stdout.trim())
      fatal(`Provider ${provider} failed for model ${model}`, EXIT.NETWORK)
    }

    // Parse token usage from stderr
    const result: CallResult = { elapsedMs: Date.now() - start }
    const tokenMatch = stderr.match(/\[Tokens:\s*(\d+)\s*in,\s*(\d+)\s*out/)
    if (tokenMatch) {
      result.tokensIn = parseInt(tokenMatch[1])
      result.tokensOut = parseInt(tokenMatch[2])
    }

    // Log any non-token stderr (warnings, etc)
    const stderrLines = stderr.split('\n')
    for (const line of stderrLines) {
      if (line.trim() && !line.includes('[Tokens:') && !line.startsWith('✅')) {
        console.error(`  ${line.trim()}`)
      }
    }

    return result
  } finally {
    // Clean up temp file
    try {
      const f = Bun.file(tmpFile)
      if (await f.exists()) {
        const { unlinkSync } = await import('node:fs')
        unlinkSync(tmpFile)
      }
    } catch { /* ignore */ }
  }
}

// --- Section splitting for condense mode ---

const DEFAULT_SECTION_HEADERS = [
  'Public Writing (Twitter)',
  'Twitter Direct Messages',
  'Email Conversations',
  'Slack',
  'Messaging (iMessage/Beeper)',
  'Calls & Meetings',
]

interface Section {
  name: string
  content: string
}

function splitExport(exportContent: string, sectionHeaders?: string[]): Section[] {
  const headers = sectionHeaders ?? DEFAULT_SECTION_HEADERS
  const sections: Section[] = []
  const lines = exportContent.split('\n')

  let currentName = 'preamble'
  let currentLines: string[] = []

  for (const line of lines) {
    // Check if this line matches a section header (## Header Name)
    if (line.startsWith('## ')) {
      const headerText = line.slice(3).trim()
      const matchedHeader = headers.find(h =>
        headerText.toLowerCase().startsWith(h.toLowerCase())
      )
      if (matchedHeader) {
        // Save previous section if it has content
        if (currentLines.length > 0) {
          const content = currentLines.join('\n').trim()
          if (content.length > 100) { // Skip tiny sections
            sections.push({ name: currentName, content })
          }
        }
        currentName = slugify(matchedHeader)
        currentLines = [line]
        continue
      }
    }
    currentLines.push(line)
  }

  // Don't forget the last section
  if (currentLines.length > 0) {
    const content = currentLines.join('\n').trim()
    if (content.length > 100) {
      sections.push({ name: currentName, content })
    }
  }

  return sections
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

// --- Condense instructions ---

const CONDENSE_SYSTEM = `You are a precise information compressor. Your job is to condense source material while preserving ALL substantive information.

RULES:
- Preserve ALL names, dates, dollar amounts, specific numbers
- Preserve ALL direct quotes (keep verbatim)
- Preserve ALL commitments (who committed to what by when)
- Preserve ALL relationship signals (new contact, deepening, tension)
- Remove pleasantries, metadata noise, repeated information, generic filler
- Keep retrieval-relevant details (subject lines, channel names, timestamps)
- Target 25-35% of original length
- Maintain the chronological/topological structure of the original
- Do NOT editorialize or interpret — just compress`

const CONDENSE_USER_PREFIX = `Condense the following section of a monthly knowledge base export. Preserve all substantive information — names, dates, quotes, commitments, relationships — while removing noise and redundancy.\n\n`

// --- Commands ---

async function cmdRun(argv: string[]) {
  const flags = parse_flags(argv, {
    prompt: { type: 'string', alias: 'p' },
    system: { type: 'string', alias: 's' },
    export: { type: 'string', alias: 'e' },
    model: { type: 'string', alias: 'm' },
    method: { type: 'string' },
    output: { type: 'string', alias: 'o' },
    'intermediates-dir': { type: 'string' },
    sections: { type: 'string' },
    'max-tokens': { type: 'string' },
    temperature: { type: 'string', alias: 't' },
    thinking: { type: 'boolean' },
    'thinking-budget': { type: 'string' },
    effort: { type: 'string' },
    beta: { type: 'string' },
  })

  const promptFile = flags.prompt as string
  const exportFile = flags.export as string
  const outputFile = flags.output as string
  const model = (flags.model as string) || 'claude-sonnet-4-5-20250929'
  const method = (flags.method as string) || 'direct'
  const temperature = parseFloat((flags.temperature as string) || '1.0')
  const thinking = Boolean(flags.thinking)
  const thinkingBudget = flags['thinking-budget'] ? parseInt(flags['thinking-budget'] as string, 10) : undefined
  const effort = flags.effort as string | undefined
  const beta = flags.beta as string | undefined

  // Only set max-tokens when explicitly specified; otherwise let each provider use its own default
  const maxTokens = flags['max-tokens'] ? parseInt(flags['max-tokens'] as string, 10) : undefined

  if (!promptFile) fatal('--prompt is required', EXIT.USAGE)
  if (!exportFile) fatal('--export is required', EXIT.USAGE)
  if (!outputFile) fatal('--output is required', EXIT.USAGE)
  if (!['direct', 'condense'].includes(method)) fatal('--method must be "direct" or "condense"', EXIT.USAGE)

  const resolvedPrompt = ensureFile(promptFile, 'Prompt file')
  const resolvedExport = ensureFile(exportFile, 'Export file')

  // Auto-detect system prompt: look in same directory as prompt
  let systemFile = flags.system as string | undefined
  if (!systemFile) {
    const promptDir = dirname(resolvedPrompt)
    const autoSystem = join(promptDir, 'system.md')
    if (existsSync(autoSystem)) {
      systemFile = autoSystem
    }
  }

  const systemPrompt = systemFile
    ? await Bun.file(ensureFile(systemFile, 'System prompt')).text()
    : ''
  const promptText = await Bun.file(resolvedPrompt).text()
  const exportContent = await Bun.file(resolvedExport).text()

  const provider = detectProvider(model)
  console.error(`[summarize] Model: ${model} (${provider})`)
  console.error(`[summarize] Method: ${method}`)
  const thinkingDesc = thinking ? ` (thinking enabled${thinkingBudget ? `, budget: ${thinkingBudget}` : ''})` : ''
  const effortDesc = effort ? ` [effort: ${effort}]` : ''
  const maxTokensDesc = maxTokens !== undefined ? `Max tokens: ${maxTokens}` : 'Max tokens: provider default'
  console.error(`[summarize] ${maxTokensDesc}${thinkingDesc}${effortDesc}`)
  if (beta) console.error(`[summarize] Beta: ${beta}`)
  console.error(`[summarize] Export: ${basename(resolvedExport)} (${(exportContent.length / 1024).toFixed(0)}KB)`)

  const callOpts: CallOptions = { thinking, thinkingBudget, effort, beta }

  if (method === 'direct') {
    // Direct mode: send everything in one call
    // Export first, prompt last — avoids recency bias where model processes last-seen content
    const userMessage = `Here is the content to summarize:\n\n${exportContent}\n\n---\n\nNow, based on the above content, complete the following task:\n\n${promptText}`
    console.error(`[summarize] User message: ${(userMessage.length / 1024).toFixed(0)}KB`)
    console.error(`[summarize] Running direct synthesis...`)

    const result = await callLLM(model, systemPrompt, userMessage, outputFile, maxTokens, temperature, callOpts)
    logResult(outputFile, result)

  } else {
    // Condense mode: split → condense in parallel → synthesize
    const intermediatesDir = flags['intermediates-dir'] as string
    if (!intermediatesDir) fatal('--intermediates-dir is required for condense method', EXIT.USAGE)
    const resolvedIntDir = ensureDir(intermediatesDir)

    // Parse custom sections if provided
    let sectionHeaders: string[] | undefined
    if (flags.sections) {
      try {
        sectionHeaders = JSON.parse(flags.sections as string)
      } catch {
        fatal('--sections must be valid JSON array', EXIT.USAGE)
      }
    }

    // Split
    const sections = splitExport(exportContent, sectionHeaders)
    console.error(`[summarize] Split into ${sections.length} sections: ${sections.map(s => s.name).join(', ')}`)

    // Condense each section in parallel
    console.error(`[summarize] Condensing ${sections.length} sections in parallel...`)
    const condenseStart = Date.now()

    const condenseResults = await Promise.all(
      sections.map(async (section) => {
        const intFile = join(resolvedIntDir, `${section.name}.md`)
        const userMsg = CONDENSE_USER_PREFIX + section.content
        // For condensation, estimate a reasonable token limit based on section size (target ~25% compression)
        const estimatedTokens = Math.max(4000, Math.ceil(section.content.length / 10))
        const sectionTokens = maxTokens !== undefined ? Math.min(maxTokens, estimatedTokens) : estimatedTokens

        console.error(`[summarize]   Condensing ${section.name} (${(section.content.length / 1024).toFixed(0)}KB)...`)
        const result = await callLLM(model, CONDENSE_SYSTEM, userMsg, intFile, sectionTokens, temperature, callOpts)
        console.error(`[summarize]   done ${section.name} (${result.elapsedMs}ms${result.tokensIn ? `, ${result.tokensIn}→${result.tokensOut} tokens` : ''})`)

        return { section, intFile, result }
      })
    )

    const condenseElapsed = Date.now() - condenseStart
    console.error(`[summarize] All condensations complete in ${(condenseElapsed / 1000).toFixed(1)}s`)

    // Read all intermediates and concatenate
    const condensedParts: string[] = []
    for (const { section, intFile } of condenseResults) {
      const content = await Bun.file(intFile).text()
      condensedParts.push(`## ${section.name}\n\n${content}`)
    }
    const condensedExport = condensedParts.join('\n\n---\n\n')
    console.error(`[summarize] Condensed export: ${(condensedExport.length / 1024).toFixed(0)}KB (${((condensedExport.length / exportContent.length) * 100).toFixed(0)}% of original)`)

    // Synthesize
    console.error(`[summarize] Running final synthesis...`)
    // Export first, prompt last — avoids recency bias where model processes last-seen content
    const userMessage = `Here is the condensed content to summarize:\n\n${condensedExport}\n\n---\n\nNow, based on the above content, complete the following task:\n\n${promptText}`

    const synthResult = await callLLM(model, systemPrompt, userMessage, outputFile, maxTokens, temperature, callOpts)
    logResult(outputFile, synthResult)

    // Log totals
    const totalTokensIn = condenseResults.reduce((sum, r) => sum + (r.result.tokensIn ?? 0), 0) + (synthResult.tokensIn ?? 0)
    const totalTokensOut = condenseResults.reduce((sum, r) => sum + (r.result.tokensOut ?? 0), 0) + (synthResult.tokensOut ?? 0)
    const totalElapsed = condenseResults.reduce((sum, r) => sum + r.result.elapsedMs, 0) + synthResult.elapsedMs
    console.error(`[summarize] Total pipeline: ${totalTokensIn} tokens in, ${totalTokensOut} tokens out, ${(totalElapsed / 1000).toFixed(1)}s elapsed`)
  }
}

function logResult(outputFile: string, result: CallResult) {
  const resolvedOutput = resolvePath(outputFile)
  try {
    const content = require('fs').readFileSync(resolvedOutput, 'utf-8')
    const wordCount = content.split(/\s+/).filter(Boolean).length
    console.error(`[summarize] Output: ${basename(resolvedOutput)} (${wordCount} words, ${(content.length / 1024).toFixed(0)}KB)`)
  } catch { /* output might not exist if failed */ }

  if (result.tokensIn) {
    console.error(`[summarize] Tokens: ${result.tokensIn} in, ${result.tokensOut} out`)
  }
  console.error(`[summarize] Elapsed: ${(result.elapsedMs / 1000).toFixed(1)}s`)
}

// --- Compare command ---

const COMPARE_PROMPT = `You are evaluating multiple AI-generated summaries of the same source material. Score each output on these 9 dimensions (1-5 scale):

1. **Information Density** — Facts per word. Every sentence should earn its place.
2. **People Coverage** — Did the summary mention every person from the source? Zero people dropped.
3. **Retrieval Pointer Quality** — Are pointers precise (query + source + date + person)?
4. **Voice & Style** — Does it sound like the owner's voice? Third-person chronicler, not academic.
5. **Operational Lessons** — Are friction points documented with generalizable principles?
6. **Cross-Channel Synthesis** — Same person merged across email/Slack/calls/messages?
7. **Structural Organization** — Clear thematic sections, scannable, well-ordered?
8. **Actionable Forward-Looking** — Monitoring questions, next steps, strategic tensions?
9. **LLM Utility** — Would a future AI assistant find this useful as starting context?

For each output:
1. Score each dimension (1-5)
2. Provide specific evidence (quotes, examples) for scores
3. Note what this output does better/worse than others

End with:
- **Scoring table** (all outputs × 9 dimensions + total)
- **Winner declaration** with rationale
- **Recommendations** for what to keep/merge from each output`

async function cmdCompare(argv: string[]) {
  const flags = parse_flags(argv, {
    files: { type: 'string', alias: 'f' },
    model: { type: 'string', alias: 'm' },
    output: { type: 'string', alias: 'o' },
    'max-tokens': { type: 'string' },
    temperature: { type: 'string', alias: 't' },
    thinking: { type: 'boolean' },
    effort: { type: 'string' },
    beta: { type: 'string' },
  })

  const filesStr = flags.files as string
  const outputFile = flags.output as string
  const model = (flags.model as string) || 'claude-sonnet-4-5-20250929'
  const maxTokens = flags['max-tokens'] ? parseInt(flags['max-tokens'] as string, 10) : undefined
  const temperature = parseFloat((flags.temperature as string) || '1.0')
  const thinking = Boolean(flags.thinking)
  const effort = flags.effort as string | undefined
  const beta = flags.beta as string | undefined

  if (!filesStr) fatal('--files is required (comma-separated paths)', EXIT.USAGE)
  if (!outputFile) fatal('--output is required', EXIT.USAGE)

  const filePaths = filesStr.split(',').map(f => f.trim())
  if (filePaths.length < 2) fatal('--files must contain at least 2 files', EXIT.USAGE)

  // Read all files
  const outputs: { name: string; content: string }[] = []
  for (const fp of filePaths) {
    const resolved = ensureFile(fp, 'Comparison file')
    const content = await Bun.file(resolved).text()
    outputs.push({ name: basename(resolved), content })
    console.error(`[summarize] Loaded ${basename(resolved)} (${content.split(/\s+/).filter(Boolean).length} words)`)
  }

  // Build comparison message
  const userMessage = `${COMPARE_PROMPT}\n\n---\n\n${outputs.map((o, i) => {
    return `## Output ${i + 1}: ${o.name}\n\n${o.content}`
  }).join('\n\n---\n\n')}`

  const provider = detectProvider(model)
  console.error(`[summarize] Comparing ${outputs.length} outputs with ${model} (${provider})`)

  const callOpts: CallOptions = { thinking, effort, beta }
  const result = await callLLM(model, '', userMessage, outputFile, maxTokens, temperature, callOpts)
  logResult(outputFile, result)
}

// --- List commands ---

async function cmdListPrompts() {
  const experimentsDir = join(BASE_DIR, 'experiments')
  if (!existsSync(experimentsDir)) {
    console.log('No experiments directory found.')
    return
  }

  const experiments = readdirSync(experimentsDir).filter(d => {
    const full = join(experimentsDir, d)
    return statSync(full).isDirectory()
  }).sort()

  for (const exp of experiments) {
    const promptsDir = join(experimentsDir, exp, 'prompts')
    if (!existsSync(promptsDir)) continue

    const prompts = readdirSync(promptsDir).filter(f => f.endsWith('.md')).sort()
    if (prompts.length === 0) continue

    console.log(`\n${exp}/`)
    for (const p of prompts) {
      const fullPath = join(promptsDir, p)
      const content = await Bun.file(fullPath).text()
      const firstLine = content.split('\n').find(l => l.trim().length > 0)?.trim() ?? ''
      const preview = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine
      console.log(`  prompts/${p}  — ${preview}`)
    }
  }
}

async function cmdListModels() {
  const providers: { name: string; tool: string; flag: string }[] = [
    { name: 'Anthropic', tool: 'anthropic.ts', flag: 'models' },
    { name: 'OpenAI', tool: 'openai.ts', flag: 'models' },
    { name: 'Gemini', tool: 'gemini.ts', flag: 'models' },
  ]

  for (const p of providers) {
    console.log(`\n--- ${p.name} ---`)
    try {
      const proc = Bun.spawn([BUN, join(TOOLS_DIR, p.tool), p.flag], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const stdout = await new Response(proc.stdout).text()
      const exitCode = await proc.exited
      if (exitCode === 0) {
        console.log(stdout.trim())
      } else {
        console.log(`(failed to list models — exit code ${exitCode})`)
      }
    } catch (err) {
      console.log(`(error: ${err})`)
    }
  }
}

// --- Main ---

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    print_help(name, USAGE)
    process.exit(0)
  }

  const command = argv[0]
  const rest = argv.slice(1)

  try {
    switch (command) {
      case 'run':
        await cmdRun(rest)
        break
      case 'compare':
        await cmdCompare(rest)
        break
      case 'list-prompts':
        await cmdListPrompts()
        break
      case 'list-models':
        await cmdListModels()
        break
      default:
        fatal(`Unknown command: ${command}\nRun 'summarize --help' for usage.`, EXIT.USAGE)
    }
  } catch (err) {
    handleError(name, err)
  }
}

main()
