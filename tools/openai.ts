#!/usr/bin/env bun

import { parse_flags, print_help } from './_lib/cli'
import { fatal, handleError, UsageError, EXIT } from './_lib/errors'
import { load_env } from './_lib/env'
import { request } from './_lib/http'
import { resolve } from 'node:path'
import { resolvePathOrThrow } from './_lib/paths'

export const name = 'openai'
export const description = 'Call OpenAI APIs with multi-modal support (text, images, audio). Supports GPT-5.x, o-series reasoning, embeddings, image gen, TTS.'

function usage() {
  return `
USAGE:
    openai [command] [options] [prompt]

COMMANDS:
    chat              Chat completions API (default)
    responses         Responses API (newer, simpler)
    embed             Generate embeddings
    image             Generate images (gpt-image-2, dall-e-3)
    tts               Text-to-speech
    transcribe        Transcribe audio (Whisper)
    models            List available models

MODELS (current recommendations):
    gpt-4o            Fast, multimodal, good default
    gpt-5             Flagship model for complex tasks
    gpt-5-mini        Fast + capable, great value
    gpt-5.2           Latest flagship (Dec 2025)
    o3, o3-pro        Deep reasoning
    o4-mini           Fast reasoning

CHAT/RESPONSES OPTIONS:
    -m, --model MODEL      Model (default: gpt-4o)
    -s, --system TEXT      System prompt
    -t, --temperature N    Temperature 0-2 (default: 1)
    --max-tokens N         Max tokens in response
    --stream               Stream response (default for chat)
    --no-stream            Disable streaming
    -o, --output FILE      Write response to file
    --json                 Request JSON output mode

MULTI-MODAL INPUT:
    -i, --image FILE/URL   Attach image(s) - can use multiple times
    --audio-in FILE        Attach audio file for models with audio input
    --detail LEVEL         Image detail: auto, low, high (default: auto)

REASONING (o-series, gpt-5.x):
    --reasoning            Enable reasoning mode
    --reasoning-effort L   Effort: none, low, medium, high (default: medium)

EMBEDDING OPTIONS:
    -m, --model MODEL      Model (default: text-embedding-3-small)
    --dimensions N         Output dimensions

IMAGE GENERATION:
    -m, --model MODEL      Model (default: gpt-image-2)
                           Also: dall-e-3, gpt-image-1
    --size SIZE            gpt-image-2: e.g. 1024x1024, 1536x1024, 1024x1536, 2048x2048
                           dall-e-3: 1024x1024, 1792x1024, 1024x1792
    --aspect-ratio AR      gpt-image-2 convenience: 1:1, 3:2, 2:3, 16:9, 9:16, 3:1, 1:3
                           (maps to --size; ignored if --size is set)
    --quality Q            gpt-image-2: low, medium, high, auto (default: auto)
                           dall-e-3: standard, hd
    --style S              dall-e-3 only: natural, vivid
    -n, --count N          Number of images (gpt-image-2 supports up to 10)
    -o, --output FILE      Save to file

TTS OPTIONS:
    -m, --model MODEL      Model (default: gpt-4o-mini-tts)
    --voice VOICE          alloy, echo, fable, onyx, nova, shimmer
    -o, --output FILE      Output file (default: speech.mp3)

TRANSCRIBE OPTIONS:
    -m, --model MODEL      Model (default: gpt-4o-transcribe)
    -l, --language LANG    Language code
    --prompt TEXT          Context prompt

GENERAL:
    -h, --help             Show help
    --debug                Show request details

EXAMPLES:
    # Basic chat
    openai "Explain recursion"
    openai -m gpt-5 "Complex analysis task"

    # Multi-modal (vision)
    openai -i photo.jpg "What's in this image?"
    openai -i https://example.com/img.png "Describe this"
    openai -i img1.jpg -i img2.jpg "Compare these images"

    # Audio input (gpt-4o-audio models)
    openai --audio-in recording.mp3 "Summarize this audio"

    # Reasoning models
    openai -m o3 --reasoning "Solve this math problem"
    openai -m gpt-5.2 --reasoning --reasoning-effort high "Complex proof"

    # Other APIs
    openai image "A cat on the moon" -o cat.png
    openai image "Wide mural scene" --aspect-ratio 16:9 --quality high -o thumb.png
    openai tts "Hello world" --voice nova -o hello.mp3
    openai transcribe meeting.mp3
    openai embed "Hello world"
`
}

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }

type ChatMessage = { role: string; content: string | ContentPart[] }

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  const reader = Bun.stdin.stream().getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || ''
  const mimes: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', flac: 'audio/flac',
  }
  return mimes[ext] || 'application/octet-stream'
}

async function loadImageAsDataUrl(pathOrUrl: string): Promise<string> {
  if (isUrl(pathOrUrl)) {
    // Download and encode as base64 (more reliable than passing URL to API)
    const res = await fetch(pathOrUrl)
    if (!res.ok) {
      throw new Error(`Failed to fetch image: ${res.status} ${pathOrUrl}`)
    }
    const buffer = await res.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')
    // Infer mime from URL or content-type
    const contentType = res.headers.get('content-type') || getMimeType(pathOrUrl)
    return `data:${contentType};base64,${base64}`
  }
  // Use fuzzy path resolution to handle Unicode filenames
  const absPath = resolvePathOrThrow(pathOrUrl)
  const file = Bun.file(absPath)
  const buffer = await file.arrayBuffer()
  const base64 = Buffer.from(buffer).toString('base64')
  const mime = getMimeType(absPath)
  return `data:${mime};base64,${base64}`
}

async function loadAudioAsBase64(filePath: string): Promise<{ data: string; format: string }> {
  // Use fuzzy path resolution to handle Unicode filenames
  const absPath = resolvePathOrThrow(filePath)
  const file = Bun.file(absPath)
  const buffer = await file.arrayBuffer()
  const base64 = Buffer.from(buffer).toString('base64')
  const ext = absPath.split('.').pop()?.toLowerCase() || 'mp3'
  return { data: base64, format: ext }
}

async function buildContentArray(
  text: string,
  images: string[],
  audioFile: string | null,
  imageDetail: string
): Promise<ContentPart[]> {
  const parts: ContentPart[] = []

  // Add text first
  if (text) {
    parts.push({ type: 'text', text })
  }

  // Add images
  for (const img of images) {
    const url = await loadImageAsDataUrl(img)
    parts.push({
      type: 'image_url',
      image_url: { url, detail: imageDetail || 'auto' }
    })
  }

  // Add audio
  if (audioFile) {
    const audio = await loadAudioAsBase64(audioFile)
    parts.push({
      type: 'input_audio',
      input_audio: audio
    })
  }

  return parts
}

async function streamChat(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  options: {
    temperature?: number
    maxTokens?: number
    jsonMode?: boolean
    reasoning?: boolean
    reasoningEffort?: string
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens) body.max_tokens = options.maxTokens
  if (options.jsonMode) body.response_format = { type: 'json_object' }
  if (options.reasoning && options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    fatal(`OpenAI API error: ${res.status} ${err}`, EXIT.NETWORK)
  }

  const reader = res.body?.getReader()
  if (!reader) fatal('No response body', EXIT.NETWORK)

  const decoder = new TextDecoder()
  let fullContent = ''
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const data = line.slice(6).trim()
      if (data === '[DONE]') continue
      try {
        const parsed = JSON.parse(data)
        const content = parsed.choices?.[0]?.delta?.content || ''
        if (content) {
          process.stdout.write(content)
          fullContent += content
        }
      } catch {}
    }
  }

  process.stdout.write('\n')
  return fullContent
}

async function chatCompletions(
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  options: {
    temperature?: number
    maxTokens?: number
    jsonMode?: boolean
    reasoning?: boolean
    reasoningEffort?: string
    stream?: boolean
  }
): Promise<string> {
  if (options.stream !== false) {
    return streamChat(apiKey, model, messages, options)
  }

  const body: Record<string, unknown> = {
    model,
    messages,
  }
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens) body.max_tokens = options.maxTokens
  if (options.jsonMode) body.response_format = { type: 'json_object' }
  if (options.reasoning && options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort
  }

  const { data } = await request<{ choices: Array<{ message: { content: string } }> }>({
    method: 'POST',
    url: 'https://api.openai.com/v1/chat/completions',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeoutMs: 300_000,
  })

  const content = data.choices?.[0]?.message?.content || ''
  console.log(content)
  return content
}

async function responsesApi(
  apiKey: string,
  model: string,
  input: string | ContentPart[],
  options: {
    instructions?: string
    temperature?: number
    maxTokens?: number
    reasoning?: boolean
    reasoningEffort?: string
  }
): Promise<string> {
  const body: Record<string, unknown> = {
    model,
    input,
  }
  if (options.instructions) body.instructions = options.instructions
  if (options.temperature !== undefined) body.temperature = options.temperature
  if (options.maxTokens) body.max_output_tokens = options.maxTokens
  if (options.reasoning && options.reasoningEffort) {
    body.reasoning = { effort: options.reasoningEffort }
  }

  const { data } = await request<{ output_text?: string; output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }> }>({
    method: 'POST',
    url: 'https://api.openai.com/v1/responses',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeoutMs: 300_000,
  })

  let text = ''
  if (data.output_text) {
    text = data.output_text
  } else if (data.output) {
    for (const item of data.output) {
      if (item.type === 'message' && item.content) {
        for (const c of item.content) {
          if (c.type === 'output_text' && c.text) text += c.text
        }
      }
    }
  }

  console.log(text)
  return text
}

async function embeddings(
  apiKey: string,
  model: string,
  input: string | string[],
  dimensions?: number
): Promise<number[][]> {
  const body: Record<string, unknown> = {
    model,
    input,
  }
  if (dimensions) body.dimensions = dimensions

  const { data } = await request<{ data: Array<{ embedding: number[] }> }>({
    method: 'POST',
    url: 'https://api.openai.com/v1/embeddings',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeoutMs: 60_000,
  })

  const embeddings = data.data.map((d) => d.embedding)
  console.log(JSON.stringify(embeddings, null, 2))
  return embeddings
}

const ASPECT_RATIO_TO_SIZE: Record<string, string> = {
  '1:1': '1024x1024',
  '3:2': '1536x1024',
  '2:3': '1024x1536',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '3:1': '2304x768',
  '1:3': '768x2304',
}

async function generateImage(
  apiKey: string,
  prompt: string,
  options: {
    model?: string
    size?: string
    aspectRatio?: string
    quality?: string
    style?: string
    n?: number
    output?: string
    images?: string[]
  }
): Promise<void> {
  const modelName = options.model || 'gpt-image-2'
  const hasRefImages = options.images && options.images.length > 0
  const isGptImage = modelName.startsWith('gpt-image')

  // Resolve aspect-ratio convenience → size (only when --size isn't explicitly set)
  let resolvedSize = options.size
  if (!resolvedSize && options.aspectRatio) {
    const mapped = ASPECT_RATIO_TO_SIZE[options.aspectRatio]
    if (!mapped) {
      throw new Error(`Unknown --aspect-ratio: ${options.aspectRatio}. Valid: ${Object.keys(ASPECT_RATIO_TO_SIZE).join(', ')}`)
    }
    resolvedSize = mapped
  }

  // Use /images/edits endpoint when reference images are provided with gpt-image models
  if (hasRefImages && isGptImage) {
    console.error(`→ Editing image with ${modelName} (${options.images!.length} reference image(s))...`)

    // Build images array with base64 data URLs
    const imageRefs: Array<{ image_url: string }> = []
    for (const imgPath of options.images!) {
      const absPath = resolvePathOrThrow(imgPath)
      const file = Bun.file(absPath)
      const buffer = await file.arrayBuffer()
      const base64 = Buffer.from(buffer).toString('base64')
      const mime = getMimeType(absPath)
      const dataUrl = `data:${mime};base64,${base64}`
      const filename = absPath.split('/').pop() || 'image.png'
      imageRefs.push({ image_url: dataUrl })
      console.error(`   📎 Attached: ${filename} (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB)`)
    }

    const body: Record<string, unknown> = {
      model: modelName,
      prompt,
      n: options.n || 1,
      images: imageRefs,
    }
    if (resolvedSize) body.size = resolvedSize
    if (options.quality) body.quality = options.quality

    const res = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`OpenAI API error ${res.status}: ${errText}`)
    }

    const data = await res.json() as { data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> }

    for (let i = 0; i < data.data.length; i++) {
      const item = data.data[i]
      if (!item) continue

      let imgBuffer: Buffer
      if (item.b64_json) {
        imgBuffer = Buffer.from(item.b64_json, 'base64')
      } else if (item.url) {
        const dlRes = await fetch(item.url)
        imgBuffer = Buffer.from(await dlRes.arrayBuffer())
      } else {
        console.error(`⚠️ No image data in response item ${i}`)
        continue
      }

      const filename = options.output
        ? (data.data.length > 1 ? options.output.replace(/\.png$/, `_${i + 1}.png`) : options.output)
        : `image_${Date.now()}_${i + 1}.png`
      await Bun.write(filename, imgBuffer)
      console.error(`✅ Saved: ${filename}`)
      if (item.revised_prompt) {
        console.error(`   Revised prompt: ${item.revised_prompt}`)
      }
    }
    return
  }

  // Standard generation (no reference images)
  const body: Record<string, unknown> = {
    model: modelName,
    prompt,
    n: options.n || 1,
    size: resolvedSize || '1024x1024',
  }
  // dall-e-3 needs response_format to return base64; gpt-image-* always return b64
  if (!isGptImage) body.response_format = 'b64_json'
  if (options.quality) body.quality = options.quality
  if (options.style) body.style = options.style

  console.error(`→ Generating image with ${body.model}...`)

  const { data } = await request<{ data: Array<{ b64_json: string; revised_prompt?: string }> }>({
    method: 'POST',
    url: 'https://api.openai.com/v1/images/generations',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
    timeoutMs: 300_000,
  })

  for (let i = 0; i < data.data.length; i++) {
    const item = data.data[i]
    if (!item) continue
    const buffer = Buffer.from(item.b64_json, 'base64')
    const filename = options.output
      ? (data.data.length > 1 ? options.output.replace(/\.png$/, `_${i + 1}.png`) : options.output)
      : `image_${Date.now()}_${i + 1}.png`
    await Bun.write(filename, buffer)
    console.error(`✅ Saved: ${filename}`)
    if (item.revised_prompt) {
      console.error(`   Revised prompt: ${item.revised_prompt}`)
    }
  }
}

async function textToSpeech(
  apiKey: string,
  input: string,
  options: {
    model?: string
    voice?: string
    output?: string
  }
): Promise<void> {
  const body = {
    model: options.model || 'gpt-4o-mini-tts',
    voice: options.voice || 'alloy',
    input,
  }

  console.error(`→ Generating speech with ${body.model}...`)

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    fatal(`OpenAI API error: ${res.status} ${err}`, EXIT.NETWORK)
  }

  const buffer = await res.arrayBuffer()
  const filename = options.output || 'speech.mp3'
  await Bun.write(filename, new Uint8Array(buffer))
  console.error(`✅ Saved: ${filename}`)
}

async function transcribeAudio(
  apiKey: string,
  filePath: string,
  options: {
    model?: string
    language?: string
    prompt?: string
  }
): Promise<string> {
  // Use fuzzy path resolution to handle Unicode filenames
  const resolvedPath = resolvePathOrThrow(filePath)
  const file = Bun.file(resolvedPath)
  const formData = new FormData()
  formData.append('file', file)
  formData.append('model', options.model || 'gpt-4o-transcribe')
  if (options.language) formData.append('language', options.language)
  if (options.prompt) formData.append('prompt', options.prompt)

  console.error(`→ Transcribing with ${options.model || 'gpt-4o-transcribe'}...`)

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
  })

  if (!res.ok) {
    const err = await res.text()
    fatal(`OpenAI API error: ${res.status} ${err}`, EXIT.NETWORK)
  }

  const data = await res.json() as { text: string }
  console.log(data.text)
  return data.text
}

async function listModels(apiKey: string): Promise<void> {
  const { data } = await request<{ data: Array<{ id: string; created: number; owned_by: string }> }>({
    method: 'GET',
    url: 'https://api.openai.com/v1/models',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    timeoutMs: 30_000,
  })

  const models = data.data
    .filter((m) => !m.id.includes(':ft-') && !m.id.startsWith('ft:'))
    .sort((a, b) => a.id.localeCompare(b.id))

  console.log('Available models:\n')
  for (const m of models) {
    console.log(`  ${m.id}`)
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    print_help('openai - Call OpenAI APIs', usage())
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
      reasoning: { type: 'boolean' },
      'reasoning-effort': { type: 'string' },
      // Multi-modal
      image: { type: 'string', alias: 'i', multi: true },
      'audio-in': { type: 'string' },
      detail: { type: 'string' },
      // Embeddings
      dimensions: { type: 'string' },
      // Image gen
      size: { type: 'string' },
      'aspect-ratio': { type: 'string' },
      quality: { type: 'string' },
      style: { type: 'string' },
      count: { type: 'string', alias: 'n' },
      // TTS
      voice: { type: 'string' },
      // Transcribe
      language: { type: 'string', alias: 'l' },
      prompt: { type: 'string' },
      // Debug
      debug: { type: 'boolean' },
    })
  } catch (err) {
    print_help('openai', usage())
    throw new UsageError((err as Error)?.message || 'Invalid arguments')
  }

  const env = await load_env({ required: ['OPENAI_API_KEY'] })
  const apiKey = env.OPENAI_API_KEY

  const positionals = flags._
  let command = 'chat'
  let inputArgs: string[] = positionals

  const commands = ['chat', 'responses', 'embed', 'image', 'tts', 'transcribe', 'models']
  if (positionals.length > 0 && commands.includes(positionals[0]!)) {
    command = positionals[0]!
    inputArgs = positionals.slice(1)
  }

  // Get input from args or stdin
  let input = inputArgs.join(' ').trim()
  if (!input && !process.stdin.isTTY) {
    input = (await readStdin()).trim()
  }

  const model = String(flags.model || '')
  const temperature = flags.temperature ? parseFloat(String(flags.temperature)) : undefined
  const maxTokens = flags['max-tokens'] ? parseInt(String(flags['max-tokens']), 10) : undefined
  const stream = flags['no-stream'] ? false : (flags.stream ?? true)
  const outputFile = String(flags.output || '')
  const jsonMode = Boolean(flags.json)
  const reasoning = Boolean(flags.reasoning)
  const reasoningEffort = String(flags['reasoning-effort'] || 'medium')

  // Multi-modal inputs
  const imageInputs: string[] = Array.isArray(flags.image)
    ? flags.image as string[]
    : (flags.image ? [String(flags.image)] : [])
  const audioInput = flags['audio-in'] ? String(flags['audio-in']) : null
  const imageDetail = String(flags.detail || 'auto')
  const hasMultiModal = imageInputs.length > 0 || audioInput !== null

  if (flags.debug) {
    process.env.AI_CLI_DEBUG_HTTP = '1'
  }

  switch (command) {
    case 'chat': {
      if (!input && !hasMultiModal) throw new UsageError('No prompt provided')

      const messages: ChatMessage[] = []
      if (flags.system) {
        messages.push({ role: 'system', content: String(flags.system) })
      }

      // Build user message - simple string or content array for multi-modal
      if (hasMultiModal) {
        const content = await buildContentArray(input, imageInputs, audioInput, imageDetail)
        messages.push({ role: 'user', content })
        if (imageInputs.length > 0) {
          console.error(`→ Attached ${imageInputs.length} image(s)`)
        }
        if (audioInput) {
          console.error(`→ Attached audio: ${audioInput}`)
        }
      } else {
        messages.push({ role: 'user', content: input })
      }

      const result = await chatCompletions(apiKey, model || 'gpt-4o', messages, {
        temperature,
        maxTokens,
        jsonMode,
        reasoning,
        reasoningEffort,
        stream,
      })

      if (outputFile) {
        await Bun.write(outputFile, result)
        console.error(`✅ Saved to: ${outputFile}`)
      }
      break
    }

    case 'responses': {
      if (!input && !hasMultiModal) throw new UsageError('No prompt provided')

      let responseInput: string | ContentPart[]
      if (hasMultiModal) {
        responseInput = await buildContentArray(input, imageInputs, audioInput, imageDetail)
        if (imageInputs.length > 0) {
          console.error(`→ Attached ${imageInputs.length} image(s)`)
        }
        if (audioInput) {
          console.error(`→ Attached audio: ${audioInput}`)
        }
      } else {
        responseInput = input
      }

      const result = await responsesApi(apiKey, model || 'gpt-4o', responseInput, {
        instructions: flags.system ? String(flags.system) : undefined,
        temperature,
        maxTokens,
        reasoning,
        reasoningEffort,
      })

      if (outputFile) {
        await Bun.write(outputFile, result)
        console.error(`✅ Saved to: ${outputFile}`)
      }
      break
    }

    case 'embed': {
      if (!input) throw new UsageError('No text provided for embedding')
      const dimensions = flags.dimensions ? parseInt(String(flags.dimensions), 10) : undefined
      await embeddings(apiKey, model || 'text-embedding-3-small', input, dimensions)
      break
    }

    case 'image': {
      if (!input) throw new UsageError('No prompt provided for image generation')
      await generateImage(apiKey, input, {
        model: model || 'gpt-image-2',
        size: String(flags.size || ''),
        aspectRatio: String(flags['aspect-ratio'] || ''),
        quality: String(flags.quality || ''),
        style: String(flags.style || ''),
        n: flags.count ? parseInt(String(flags.count), 10) : 1,
        output: outputFile,
        images: imageInputs.length > 0 ? imageInputs : undefined,
      })
      break
    }

    case 'tts': {
      if (!input) throw new UsageError('No text provided for speech synthesis')
      await textToSpeech(apiKey, input, {
        model: model || 'gpt-4o-mini-tts',
        voice: String(flags.voice || 'alloy'),
        output: outputFile,
      })
      break
    }

    case 'transcribe': {
      if (!input) throw new UsageError('No audio file provided')
      await transcribeAudio(apiKey, input, {
        model: model || 'gpt-4o-transcribe',
        language: String(flags.language || ''),
        prompt: String(flags.prompt || ''),
      })
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

main().catch((err) => handleError('openai', err))
