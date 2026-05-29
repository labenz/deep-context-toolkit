#!/usr/bin/env bun

import { parse_flags, print_help } from './_lib/cli'
import { fatal, handleError, UsageError, NetworkError, EXIT } from './_lib/errors'
import { load_env } from './_lib/env'
import { request } from './_lib/http'
import { resolvePathOrThrow } from './_lib/paths'
import { extname } from 'node:path'

export const name = 'anthropic'
export const description = 'Call the Anthropic Messages API. For batch data-processing scripts only — use Claude Code sub-agents for normal tasks.'

const BASE_URL = 'https://api.anthropic.com'
const API_VERSION = '2023-06-01'

function usage() {
  return `
USAGE:
    anthropic <command> [options] [prompt]

COMMANDS:
    chat              Send a message via the Messages API (default)
    batch             Create a message batch for high-volume processing
    batch-status      Check status of a message batch
    batch-results     Retrieve results of a completed batch
    models            List available models
    count             Count tokens for a prompt

⚠️  NOTE: This tool is for batch data-processing scripts that call the
    Anthropic API directly. For normal Claude tasks, use Claude Code
    sub-agents instead (Task tool with subagent_type).

MODELS (current):
    claude-opus-4-8           Flagship, most capable (1M in, 128K out)
    claude-opus-4-7           Previous gen Opus (1M in, 128K out)
    claude-sonnet-4-6         Fast + very capable (1M in, 128K out)
    claude-sonnet-4-5-20250929  Previous gen Sonnet (200K in, 64K out)
    claude-haiku-4-5-20251001   Fastest, great value (200K in, 8K out)

CHAT OPTIONS:
    -m, --model MODEL       Model (default: claude-sonnet-4-5-20250929)
    -s, --system TEXT        System prompt
    -t, --temperature NUM    Temperature 0.0-1.0 (default: 1.0)
    --max-tokens NUM         Max output tokens (omit to use model max)
    --stream                 Stream response (default)
    --no-stream              Disable streaming
    -o, --output FILE        Save response to file
    --json                   Request JSON output (via system prompt)
    --thinking               Enable extended thinking
    --thinking-budget NUM    Max thinking tokens (default: 10000, ignored for 4.6 adaptive)
    --effort LEVEL           Effort level: low, medium, high (4.6 models only)

MULTI-MODAL INPUT:
    -i, --image FILE/URL     Attach image(s) - can use multiple times
    -p, --pdf FILE           Attach PDF(s) - can use multiple times

BATCH OPTIONS:
    --requests FILE          JSON file with array of batch requests
    -m, --model MODEL        Model for all requests
    -s, --system TEXT         System prompt for all requests

BATCH STATUS/RESULTS:
    --batch-id ID            Batch ID to check/retrieve

COUNT OPTIONS:
    -m, --model MODEL        Model for counting (default: claude-sonnet-4-5-20250929)
    -s, --system TEXT         System prompt to include in count

GENERAL:
    -h, --help               Show help
    --debug                  Show request details

EXAMPLES:
    # Basic chat
    anthropic "Summarize this text"
    anthropic -m claude-opus-4-7 "Analyze this complex problem"

    # With system prompt
    anthropic -s "You are a JSON extractor" "Extract entities from: ..."

    # Multi-modal
    anthropic -i photo.jpg "What's in this image?"
    anthropic -p document.pdf "Summarize this PDF"

    # Extended thinking
    anthropic --thinking "Work through this step by step"

    # Batch processing (high-volume)
    anthropic batch --requests items.json -m claude-haiku-4-5-20251001
    anthropic batch-status --batch-id batch_abc123
    anthropic batch-results --batch-id batch_abc123

    # Pipe from stdin
    echo "Explain this" | anthropic

    # Token counting
    anthropic count "How many tokens is this?"

ENV:
    ANTHROPIC_API_KEY         Anthropic API key (required)
`
}

// MIME types for supported media
const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
}

function getMimeType(pathOrUrl: string): string {
  const ext = extname(pathOrUrl).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

type ImageSource =
  | { type: 'base64'; media_type: string; data: string }
  | { type: 'url'; url: string }

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'document'; source: { type: 'base64'; media_type: 'application/pdf'; data: string } }

type Message = { role: 'user' | 'assistant'; content: string | ContentBlock[] }

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).trim()
}

async function loadMediaAsBase64(pathOrUrl: string): Promise<{ data: string; mimeType: string }> {
  if (isUrl(pathOrUrl)) {
    console.error(`→ Fetching: ${pathOrUrl}`)
    const res = await fetch(pathOrUrl)
    if (!res.ok) {
      throw new NetworkError(`Failed to fetch ${pathOrUrl}: ${res.status}`)
    }
    const contentType = res.headers.get('content-type') || getMimeType(pathOrUrl)
    const mimeType = contentType.split(';')[0].trim()
    const buffer = await res.arrayBuffer()
    return { data: Buffer.from(buffer).toString('base64'), mimeType }
  }

  const absPath = resolvePathOrThrow(pathOrUrl)
  console.error(`→ Loading: ${absPath}`)
  const bytes = await Bun.file(absPath).bytes()
  return { data: Buffer.from(bytes).toString('base64'), mimeType: getMimeType(pathOrUrl) }
}

async function buildContentBlocks(
  text: string,
  images: string[],
  pdfs: string[]
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []

  // Images
  for (const img of images) {
    if (isUrl(img)) {
      blocks.push({
        type: 'image',
        source: { type: 'url', url: img },
      })
    } else {
      const { data, mimeType } = await loadMediaAsBase64(img)
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: mimeType, data },
      })
    }
  }

  // PDFs
  for (const pdf of pdfs) {
    const { data } = await loadMediaAsBase64(pdf)
    blocks.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data },
    })
  }

  // Text
  if (text) {
    blocks.push({ type: 'text', text })
  }

  return blocks
}

function usesAdaptiveThinking(model: string): boolean {
  // Models that use adaptive thinking API (type: 'adaptive') instead of manual (type: 'enabled')
  // 4.6+ models: Opus 4.7/4.8, Sonnet 4.6, etc. Match any 4.6+ minor (4-6..4-9, 4.6..4.9)
  // so new releases don't silently fall back to manual thinking / lose --effort.
  return /4[-.]([6-9])\b/.test(model)
}

function modelMaxOutputTokens(model: string): number {
  if (model.includes('opus')) return 128000
  if (usesAdaptiveThinking(model) && model.includes('sonnet')) return 128000
  if (model.includes('sonnet')) return 64000
  if (model.includes('haiku')) return 8192
  return 8192
}

function apiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
  }
}

async function streamChat(
  apiKey: string,
  model: string,
  messages: Message[],
  options: {
    system?: string
    temperature?: number
    maxTokens: number
    thinking?: boolean
    thinkingBudget?: number
    effort?: string
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options.maxTokens,
    stream: true,
  }
  if (options.system) body.system = options.system
  if (options.temperature !== undefined && !options.thinking) {
    body.temperature = options.temperature
  }
  if (options.thinking) {
    if (usesAdaptiveThinking(model)) {
      // 4.6 models: use adaptive thinking (budget_tokens deprecated)
      body.thinking = { type: 'adaptive' }
    } else {
      // Pre-4.6 models: use manual thinking with budget
      body.thinking = {
        type: 'enabled',
        budget_tokens: options.thinkingBudget || 10000,
      }
    }
  }
  if (options.effort && usesAdaptiveThinking(model)) {
    body.output_config = { effort: options.effort }
  }

  const res = await fetch(`${BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: apiHeaders(apiKey),
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    fatal(`Anthropic API error: ${res.status} ${err}`, EXIT.NETWORK)
  }

  const reader = res.body?.getReader()
  if (!reader) fatal('No response body', EXIT.NETWORK)

  const decoder = new TextDecoder()
  let fullContent = ''
  let buffer = ''
  let inThinking = false

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (!data || data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)

        if (parsed.type === 'content_block_start') {
          if (parsed.content_block?.type === 'thinking') {
            inThinking = true
            process.stderr.write('💭 [thinking...]\n')
          } else if (parsed.content_block?.type === 'text') {
            inThinking = false
          }
        } else if (parsed.type === 'content_block_delta') {
          if (parsed.delta?.type === 'text_delta') {
            const text = parsed.delta.text || ''
            if (text && !inThinking) {
              process.stdout.write(text)
              fullContent += text
            }
          } else if (parsed.delta?.type === 'thinking_delta') {
            // Silently consume thinking output
          }
        } else if (parsed.type === 'message_delta' && parsed.usage) {
          const u = parsed.usage
          console.error(`\n[Tokens: ${u.input_tokens ?? '?'} in, ${u.output_tokens ?? '?'} out]`)
        }
      } catch {}
    }
  }

  process.stdout.write('\n')
  return fullContent
}

async function chatNonStreaming(
  apiKey: string,
  model: string,
  messages: Message[],
  options: {
    system?: string
    temperature?: number
    maxTokens: number
    thinking?: boolean
    thinkingBudget?: number
    effort?: string
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: options.maxTokens,
  }
  if (options.system) body.system = options.system
  if (options.temperature !== undefined && !options.thinking) {
    body.temperature = options.temperature
  }
  if (options.thinking) {
    if (usesAdaptiveThinking(model)) {
      body.thinking = { type: 'adaptive' }
    } else {
      body.thinking = {
        type: 'enabled',
        budget_tokens: options.thinkingBudget || 10000,
      }
    }
  }
  if (options.effort && usesAdaptiveThinking(model)) {
    body.output_config = { effort: options.effort }
  }

  const { data } = await request<{
    content: Array<{ type: string; text?: string }>
    usage?: { input_tokens: number; output_tokens: number }
  }>({
    method: 'POST',
    url: `${BASE_URL}/v1/messages`,
    headers: apiHeaders(apiKey),
    body,
    timeoutMs: 600_000,
  })

  let text = ''
  for (const block of data.content || []) {
    if (block.type === 'text' && block.text) {
      text += block.text
    }
  }

  console.log(text)

  if (data.usage) {
    console.error(`[Tokens: ${data.usage.input_tokens} in, ${data.usage.output_tokens} out]`)
  }

  return text
}

async function createBatch(
  apiKey: string,
  requestsFile: string,
  options: { model?: string; system?: string }
): Promise<void> {
  const absPath = resolvePathOrThrow(requestsFile)
  const raw = await Bun.file(absPath).text()
  let items: Array<{ custom_id: string; prompt: string }>

  try {
    items = JSON.parse(raw)
  } catch {
    throw new UsageError(`Invalid JSON in requests file: ${absPath}`)
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new UsageError('Requests file must be a non-empty JSON array')
  }

  const model = options.model || 'claude-sonnet-4-5-20250929'

  // Build batch requests
  const requests = items.map((item) => ({
    custom_id: item.custom_id,
    params: {
      model,
      max_tokens: modelMaxOutputTokens(model),
      ...(options.system ? { system: options.system } : {}),
      messages: [{ role: 'user', content: item.prompt }],
    },
  }))

  console.error(`→ Creating batch with ${requests.length} requests using ${model}...`)

  const { data } = await request<{ id: string; processing_status: string; request_counts: Record<string, number> }>({
    method: 'POST',
    url: `${BASE_URL}/v1/messages/batches`,
    headers: apiHeaders(apiKey),
    body: { requests },
    timeoutMs: 60_000,
  })

  console.log(`Batch created: ${data.id}`)
  console.log(`Status: ${data.processing_status}`)
  if (data.request_counts) {
    console.log(`Requests: ${JSON.stringify(data.request_counts)}`)
  }
}

async function batchStatus(apiKey: string, batchId: string): Promise<void> {
  const { data } = await request<{
    id: string
    processing_status: string
    request_counts: Record<string, number>
    created_at: string
    ended_at?: string
  }>({
    method: 'GET',
    url: `${BASE_URL}/v1/messages/batches/${batchId}`,
    headers: apiHeaders(apiKey),
    timeoutMs: 30_000,
  })

  console.log(`Batch: ${data.id}`)
  console.log(`Status: ${data.processing_status}`)
  console.log(`Created: ${data.created_at}`)
  if (data.ended_at) console.log(`Ended: ${data.ended_at}`)
  if (data.request_counts) {
    console.log(`Requests: ${JSON.stringify(data.request_counts)}`)
  }
}

async function batchResults(apiKey: string, batchId: string): Promise<void> {
  const { data } = await request<{
    id: string
    processing_status: string
    results_url?: string
  }>({
    method: 'GET',
    url: `${BASE_URL}/v1/messages/batches/${batchId}`,
    headers: apiHeaders(apiKey),
    timeoutMs: 30_000,
  })

  if (data.processing_status !== 'ended') {
    console.error(`Batch ${batchId} is still ${data.processing_status}. Wait for it to complete.`)
    return
  }

  if (!data.results_url) {
    console.error('No results URL available yet.')
    return
  }

  // Fetch the results
  const res = await fetch(data.results_url, {
    headers: apiHeaders(apiKey),
  })

  if (!res.ok) {
    throw new NetworkError(`Failed to fetch results: ${res.status}`)
  }

  // Results come as JSONL
  const text = await res.text()
  console.log(text)
}

async function countTokens(
  apiKey: string,
  model: string,
  text: string,
  system?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: text }],
  }
  if (system) body.system = system

  const { data } = await request<{ input_tokens: number }>({
    method: 'POST',
    url: `${BASE_URL}/v1/messages/count_tokens`,
    headers: apiHeaders(apiKey),
    body,
    timeoutMs: 30_000,
  })

  console.log(`Tokens: ${data.input_tokens}`)
}

async function listModels(apiKey: string): Promise<void> {
  const { data } = await request<{ data: Array<{ id: string; display_name: string; created_at: string }> }>({
    method: 'GET',
    url: `${BASE_URL}/v1/models`,
    headers: apiHeaders(apiKey),
    timeoutMs: 30_000,
  })

  const models = (data.data || []).sort((a, b) => a.id.localeCompare(b.id))
  console.log('Available Claude Models:\n')
  for (const m of models) {
    console.log(`  ${m.id}`)
    if (m.display_name) console.log(`    ${m.display_name}`)
  }
}

function toStringArray(value: unknown): string[] {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String)
  return [String(value)]
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    print_help('anthropic - Anthropic Messages API CLI', usage())
    return
  }

  let flags: ReturnType<typeof parse_flags>
  try {
    flags = parse_flags(argv, {
      model: { type: 'string', alias: 'm' },
      system: { type: 'string', alias: 's' },
      temperature: { type: 'string', alias: 't' },
      'max-tokens': { type: 'string' },
      stream: { type: 'boolean' },
      'no-stream': { type: 'boolean' },
      output: { type: 'string', alias: 'o' },
      json: { type: 'boolean' },
      thinking: { type: 'boolean' },
      'thinking-budget': { type: 'string' },
      effort: { type: 'string' },
      // Multi-modal
      image: { type: 'string', alias: 'i', multi: true },
      pdf: { type: 'string', alias: 'p', multi: true },
      // Batch
      requests: { type: 'string' },
      'batch-id': { type: 'string' },
      // Debug
      debug: { type: 'boolean' },
    })
  } catch (err) {
    print_help('anthropic', usage())
    throw new UsageError((err as Error)?.message || 'Invalid arguments')
  }

  const env = await load_env({ required: ['ANTHROPIC_API_KEY'] })
  const apiKey = env.ANTHROPIC_API_KEY

  const positionals = flags._ as string[]
  let command = 'chat'
  let inputArgs: string[] = positionals

  const commands = ['chat', 'batch', 'batch-status', 'batch-results', 'models', 'count']
  if (positionals.length > 0 && commands.includes(positionals[0]!)) {
    command = positionals[0]!
    inputArgs = positionals.slice(1)
  }

  // Get input from args or stdin
  let input = inputArgs.join(' ').trim()
  if (!input && !process.stdin.isTTY && command !== 'models' && command !== 'batch-status' && command !== 'batch-results') {
    input = await readStdin()
  }

  const model = String(flags.model || '')
  const resolvedModel = model || 'claude-sonnet-4-5-20250929'
  const temperature = flags.temperature ? parseFloat(String(flags.temperature)) : undefined
  const explicitMaxTokens = flags['max-tokens'] ? parseInt(String(flags['max-tokens']), 10) : undefined
  let maxTokens = explicitMaxTokens ?? modelMaxOutputTokens(resolvedModel)
  const stream = flags['no-stream'] ? false : (flags.stream ?? true)
  const outputFile = String(flags.output || '')
  const thinking = Boolean(flags.thinking)
  const thinkingBudget = flags['thinking-budget'] ? parseInt(String(flags['thinking-budget']), 10) : 10000
  const effort = flags.effort ? String(flags.effort) : undefined

  // Validate effort level
  if (effort && !['low', 'medium', 'high'].includes(effort)) {
    throw new UsageError(`--effort must be low, medium, or high (got: ${effort})`)
  }

  // Extended thinking requires max_tokens > budget_tokens (pre-4.6 models only)
  if (thinking && !usesAdaptiveThinking(resolvedModel) && maxTokens <= thinkingBudget) {
    maxTokens = thinkingBudget + 4096
  }

  const imageInputs = toStringArray(flags.image)
  const pdfInputs = toStringArray(flags.pdf)
  const hasMultiModal = imageInputs.length > 0 || pdfInputs.length > 0

  if (flags.debug) {
    process.env.AI_CLI_DEBUG_HTTP = '1'
  }

  switch (command) {
    case 'chat': {
      if (!input && !hasMultiModal) throw new UsageError('No prompt provided')

      let systemPrompt = flags.system ? String(flags.system) : undefined
      if (flags.json && !systemPrompt) {
        systemPrompt = 'Respond with valid JSON only.'
      } else if (flags.json && systemPrompt) {
        systemPrompt += '\n\nRespond with valid JSON only.'
      }

      const messages: Message[] = []

      if (hasMultiModal) {
        const content = await buildContentBlocks(input, imageInputs, pdfInputs)
        messages.push({ role: 'user', content })
        if (imageInputs.length > 0) {
          console.error(`→ Attached ${imageInputs.length} image(s)`)
        }
        if (pdfInputs.length > 0) {
          console.error(`→ Attached ${pdfInputs.length} PDF(s)`)
        }
      } else {
        messages.push({ role: 'user', content: input })
      }

      let result: string
      if (stream) {
        result = await streamChat(apiKey, model || 'claude-sonnet-4-5-20250929', messages, {
          system: systemPrompt,
          temperature,
          maxTokens,
          thinking,
          thinkingBudget,
          effort,
        })
      } else {
        result = await chatNonStreaming(apiKey, model || 'claude-sonnet-4-5-20250929', messages, {
          system: systemPrompt,
          temperature,
          maxTokens,
          thinking,
          thinkingBudget,
          effort,
        })
      }

      if (outputFile) {
        await Bun.write(outputFile, result)
        console.error(`✅ Saved to: ${outputFile}`)
      }
      break
    }

    case 'batch': {
      const requestsFile = String(flags.requests || '')
      if (!requestsFile) throw new UsageError('--requests FILE is required for batch command')
      await createBatch(apiKey, requestsFile, {
        model: model || undefined,
        system: flags.system ? String(flags.system) : undefined,
      })
      break
    }

    case 'batch-status': {
      const batchId = String(flags['batch-id'] || '')
      if (!batchId) throw new UsageError('--batch-id is required')
      await batchStatus(apiKey, batchId)
      break
    }

    case 'batch-results': {
      const batchId = String(flags['batch-id'] || '')
      if (!batchId) throw new UsageError('--batch-id is required')
      await batchResults(apiKey, batchId)
      break
    }

    case 'count': {
      if (!input) throw new UsageError('No text provided for token counting')
      await countTokens(
        apiKey,
        model || 'claude-sonnet-4-5-20250929',
        input,
        flags.system ? String(flags.system) : undefined
      )
      break
    }

    case 'models': {
      await listModels(apiKey)
      break
    }

    default:
      throw new UsageError(`Unknown command: ${command}`)
  }
}

main().catch((err) => handleError('anthropic', err))
