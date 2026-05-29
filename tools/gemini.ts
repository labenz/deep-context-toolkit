#!/usr/bin/env bun

import { parse_flags, print_help } from './_lib/cli'
import { fatal, handleError, UsageError, MissingError, NetworkError, EXIT } from './_lib/errors'
import { load_env, PROJECT_ROOT } from './_lib/env'
import { request } from './_lib/http'
import { resolvePathOrThrow } from './_lib/paths'
import { join, extname, basename } from 'node:path'
import { mkdir } from 'node:fs/promises'

export const name = 'gemini'
export const description = 'Interact with Google Gemini API for text generation, chat, vision, audio, and more.'

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

function usage() {
  return `
USAGE:
    gemini <command> [options] [prompt]

COMMANDS:
    chat           Send a message and get a response (default)
    image          Generate or edit images
    models         List available models
    count          Count tokens in text/media
    embed          Generate embeddings for text

CHAT OPTIONS:
    -m, --model MODEL       Model to use (default: gemini-3-flash-preview)
    -s, --system PROMPT     System instruction
    -t, --temperature NUM   Temperature 0.0-2.0 (default: 1.0)
    --max-tokens NUM        Max output tokens (default: model default — omit unless needed)
    --json                  Output raw JSON response
    --no-stream             Disable streaming (streams by default)
    -o, --output FILE       Save response to file
    --schema FILE           JSON schema file for structured output (forces JSON mode)
    --schema-inline JSON    Inline JSON schema string for structured output
    --thinking-budget NUM   Thinking token budget (2.5 models: -1=dynamic, 0=off)
    --thinking-level LEVEL  Thinking level (3.x models: minimal, low, medium, high)

MULTI-MODAL OPTIONS (can be used multiple times):
    -i, --image PATH/URL    Add image (jpg, png, gif, webp)
    -a, --audio PATH        Add audio (mp3, wav, ogg, flac, m4a)
    -v, --video PATH        Add video (mp4, mov, avi, webm, mkv)
    -p, --pdf PATH          Add PDF document
    --files-api             Force Files API upload (auto for files >20MB)

MODELS OPTIONS:
    --json                  Output raw JSON

COUNT OPTIONS:
    -m, --model MODEL       Model for counting (default: gemini-3-flash-preview)
    --json                  Output raw JSON

IMAGE OPTIONS:
    -m, --model MODEL       Model for generation (default: gemini-3-pro-image-preview)
                            Also available: nano-banana-pro-preview (better at preserving text)
    --aspect-ratio RATIO    Aspect ratio: 1:1, 3:4, 4:3, 9:16, 16:9
    --size SIZE             Image size: 256, 512, 1K, 2K
    -i, --image PATH/URL    Input image for editing
    -o, --output FILE       Save image to file (default: outputs/gemini-image-*.png)
    --json                  Output raw JSON response

EMBED OPTIONS:
    -m, --model MODEL       Model for embeddings (default: text-embedding-004)
    --json                  Output raw JSON
    -o, --output FILE       Save embeddings to file

GENERAL:
    -h, --help              Show help

EXAMPLES:
    # Text only
    gemini "What is the capital of France?"
    gemini chat "Explain quantum computing" -m gemini-2.5-pro

    # Image analysis
    gemini "What's in this image?" -i photo.jpg
    gemini "Compare these images" -i img1.png -i img2.png
    gemini "Describe this" -i https://example.com/image.jpg

    # Audio transcription/analysis
    gemini "Transcribe this audio" -a recording.mp3
    gemini "What language is spoken?" -a speech.wav

    # Video analysis
    gemini "Summarize this video" -v clip.mp4
    gemini "What happens at 2:30?" -v video.mov

    # PDF analysis
    gemini "Summarize this document" -p report.pdf
    gemini "Extract key points" -p paper.pdf -p appendix.pdf

    # Combined
    gemini "Explain the chart in the context of the audio" -i chart.png -a narration.mp3

    # Structured JSON output
    gemini "Extract name and email" --schema schema.json < input.txt
    gemini "List the key points" --schema-inline '{"type":"object","properties":{"points":{"type":"array","items":{"type":"string"}}}}'

    # Image generation
    gemini image "A cat astronaut on Mars"
    gemini image "Mountain landscape" --aspect-ratio 16:9 --size 2K

    # Image editing (reuses existing -i flag)
    gemini image "Make this a watercolor" -i photo.jpg
    gemini image "Remove the background" -i portrait.png -o portrait-nobg.png

    # Other commands
    gemini models
    gemini count "How many tokens?"
    gemini count -i image.jpg  # Count tokens for image
    echo "Piped input" | gemini

SUPPORTED FORMATS:
    Images: jpg, jpeg, png, gif, webp, heic, heif
    Audio:  mp3, wav, ogg, flac, m4a, aac, wma
    Video:  mp4, mov, avi, webm, mkv, wmv, flv
    Docs:   pdf

ENV:
    GEMINI_API_KEY          Google AI API key (required)
                            Get from: https://aistudio.google.com/apikey

EXIT CODES:
    0   Success
    2   Usage error
    64  Missing configuration
    65  Invalid input
    70  Network/API error
`
}

// MIME type mappings
const MIME_TYPES: Record<string, string> = {
  // Images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wma': 'audio/x-ms-wma',
  // Video
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  // Documents
  '.pdf': 'application/pdf',
}

function getMimeType(pathOrUrl: string): string {
  const ext = extname(pathOrUrl).toLowerCase()
  return MIME_TYPES[ext] || 'application/octet-stream'
}

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value)
}

type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } }

type GeminiContent = {
  parts: GeminiPart[]
  role?: 'user' | 'model'
}

type GeminiRequest = {
  contents: GeminiContent[]
  systemInstruction?: { parts: { text: string }[] }
  generationConfig?: {
    temperature?: number
    maxOutputTokens?: number
    topP?: number
    topK?: number
    responseMimeType?: string
    responseSchema?: Record<string, unknown>
    responseModalities?: string[]
    imageConfig?: {
      aspectRatio?: string
      imageSize?: string
    }
    thinkingConfig?: {
      thinkingBudget?: number
      thinkingLevel?: string
      includeThoughts?: boolean
    }
  }
}

type GeminiCandidate = {
  content: { parts: Array<{ text?: string; thought?: boolean; inlineData?: { mimeType: string; data: string } }>; role: string }
  finishReason: string
}

type GeminiResponse = {
  candidates?: GeminiCandidate[]
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
    totalTokenCount: number
  }
  error?: { message: string; code: number }
}

type GeminiModel = {
  name: string
  displayName: string
  description: string
  inputTokenLimit: number
  outputTokenLimit: number
  supportedGenerationMethods: string[]
}

type GeminiModelsResponse = {
  models: GeminiModel[]
}

type GeminiCountResponse = {
  totalTokens: number
}

type GeminiEmbedResponse = {
  embedding: { values: number[] }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks)).trim()
}

async function loadMediaAsBase64(pathOrUrl: string): Promise<{ data: string; mimeType: string }> {
  let bytes: Uint8Array
  let mimeType: string

  if (isUrl(pathOrUrl)) {
    // Fetch from URL
    console.error(`→ Fetching: ${pathOrUrl}`)
    const res = await fetch(pathOrUrl)
    if (!res.ok) {
      throw new NetworkError(`Failed to fetch ${pathOrUrl}: ${res.status}`)
    }
    const contentType = res.headers.get('content-type') || getMimeType(pathOrUrl)
    mimeType = contentType.split(';')[0].trim()
    bytes = new Uint8Array(await res.arrayBuffer())
  } else {
    // Load local file (with fuzzy Unicode matching)
    const absPath = resolvePathOrThrow(pathOrUrl)
    console.error(`→ Loading: ${absPath}`)
    bytes = await Bun.file(absPath).bytes()
    mimeType = getMimeType(pathOrUrl)
  }

  // Convert to base64
  const data = Buffer.from(bytes).toString('base64')
  return { data, mimeType }
}

// Files API for large media (>20MB) — resumable upload, up to 2GB
const FILES_API_UPLOAD_URL = 'https://generativelanguage.googleapis.com/upload/v1beta/files'
const FILES_API_METADATA_URL = 'https://generativelanguage.googleapis.com/v1beta/files'
const FILE_SIZE_THRESHOLD = 20 * 1024 * 1024 // 20MB

async function uploadFileToGemini(
  apiKey: string,
  filePath: string,
  mimeType: string
): Promise<{ fileUri: string; mimeType: string }> {
  const file = Bun.file(filePath)
  const fileSize = file.size
  const displayName = basename(filePath)

  console.error(`→ Uploading via Files API: ${displayName} (${(fileSize / 1024 / 1024).toFixed(1)} MB)`)

  // Step 1: Initiate resumable upload
  const initRes = await fetch(`${FILES_API_UPLOAD_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(fileSize),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { displayName } }),
  })

  if (!initRes.ok) {
    throw new NetworkError(`Files API init failed: ${initRes.status} ${await initRes.text()}`)
  }

  const uploadUrl = initRes.headers.get('x-goog-upload-url')
  if (!uploadUrl) throw new NetworkError('No upload URL returned from Files API')

  // Step 2: Upload file bytes (single chunk)
  console.error(`→ Uploading ${(fileSize / 1024 / 1024).toFixed(0)} MB...`)
  const bytes = await file.arrayBuffer()

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Type': mimeType,
    },
    body: bytes,
    signal: AbortSignal.timeout(600_000), // 10 min for large uploads
  })

  if (!uploadRes.ok) {
    throw new NetworkError(`Files API upload failed: ${uploadRes.status} ${await uploadRes.text()}`)
  }

  const result = (await uploadRes.json()) as { file: { name: string; uri: string; state: string; error?: { message: string } } }
  const fileMeta = result.file

  console.error(`→ Upload complete: ${fileMeta.name} (state: ${fileMeta.state})`)

  // Step 3: Poll for ACTIVE state (video processing takes 1-3 min)
  if (fileMeta.state === 'PROCESSING') {
    console.error(`→ Waiting for server-side processing...`)
    const maxWaitMs = 600_000 // 10 min max for very long videos
    const pollIntervalMs = 5_000
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      await new Promise(r => setTimeout(r, pollIntervalMs))
      const statusRes = await fetch(
        `${BASE_URL}/${fileMeta.name}?key=${apiKey}`
      )
      if (!statusRes.ok) {
        console.error(`→ Poll failed (${statusRes.status}), retrying...`)
        continue
      }
      const status = (await statusRes.json()) as { name: string; uri: string; state: string; error?: { message: string } }
      if (status.state === 'ACTIVE') {
        console.error(`→ File ready: ${status.uri}`)
        return { fileUri: status.uri, mimeType }
      }
      if (status.state === 'FAILED') {
        throw new NetworkError(`File processing failed: ${status.error?.message || 'unknown error'}`)
      }
      const elapsed = Math.round((Date.now() - startTime) / 1000)
      console.error(`→ Still processing... (${elapsed}s)`)
    }
    throw new NetworkError('File processing timed out after 10 minutes')
  }

  return { fileUri: fileMeta.uri, mimeType }
}

// Smart media loader: Files API for large files, inline base64 for small ones
async function loadMedia(
  pathOrUrl: string,
  apiKey: string,
  forceFilesApi = false
): Promise<GeminiPart> {
  if (isUrl(pathOrUrl)) {
    const { data, mimeType } = await loadMediaAsBase64(pathOrUrl)
    return { inlineData: { mimeType, data } }
  }

  const absPath = resolvePathOrThrow(pathOrUrl)
  const fileSize = Bun.file(absPath).size
  const mimeType = getMimeType(pathOrUrl)

  if (forceFilesApi || fileSize > FILE_SIZE_THRESHOLD) {
    const { fileUri, mimeType: mt } = await uploadFileToGemini(apiKey, absPath, mimeType)
    return { fileData: { fileUri, mimeType: mt } }
  } else {
    const { data, mimeType: mt } = await loadMediaAsBase64(pathOrUrl)
    return { inlineData: { mimeType: mt, data } }
  }
}

async function buildParts(
  textPrompt: string,
  mediaFiles: { images: string[]; audio: string[]; video: string[]; pdfs: string[] },
  apiKey: string,
  forceFilesApi = false
): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = []

  // Add media first (Gemini prefers media before text)
  const allMedia = [
    ...mediaFiles.images,
    ...mediaFiles.audio,
    ...mediaFiles.video,
    ...mediaFiles.pdfs,
  ]

  for (const path of allMedia) {
    const part = await loadMedia(path, apiKey, forceFilesApi)
    parts.push(part)
  }

  // Add text prompt
  if (textPrompt) {
    parts.push({ text: textPrompt })
  }

  return parts
}

async function chatCommand(
  apiKey: string,
  prompt: string,
  mediaFiles: { images: string[]; audio: string[]; video: string[]; pdfs: string[] },
  opts: {
    model: string
    system?: string
    temperature: number
    maxTokens?: number
    json: boolean
    stream: boolean
    output?: string
    schema?: Record<string, unknown>
    thinkingBudget?: number
    thinkingLevel?: string
    forceFilesApi?: boolean
  }
) {
  const parts = await buildParts(prompt, mediaFiles, apiKey, opts.forceFilesApi)

  if (parts.length === 0) {
    throw new UsageError('No input provided. Pass text as argument, media files, or pipe from stdin.')
  }

  const contents: GeminiContent[] = [{ parts, role: 'user' }]

  const generationConfig: Record<string, unknown> = {
    temperature: opts.temperature,
  }
  if (opts.maxTokens !== undefined) {
    generationConfig.maxOutputTokens = opts.maxTokens
  }
  if (opts.thinkingBudget !== undefined || opts.thinkingLevel) {
    const thinkingConfig: Record<string, unknown> = {}
    if (opts.thinkingLevel) thinkingConfig.thinkingLevel = opts.thinkingLevel
    if (opts.thinkingBudget !== undefined) thinkingConfig.thinkingBudget = opts.thinkingBudget
    generationConfig.thinkingConfig = thinkingConfig
  }

  const body: GeminiRequest = {
    contents,
    generationConfig: generationConfig as GeminiRequest['generationConfig'],
  }

  // Add schema for structured output
  if (opts.schema) {
    body.generationConfig!.responseMimeType = 'application/json'
    body.generationConfig!.responseSchema = opts.schema
  }

  if (opts.system) {
    body.systemInstruction = { parts: [{ text: opts.system }] }
  }

  // Log what we're sending
  const mediaCount = mediaFiles.images.length + mediaFiles.audio.length + mediaFiles.video.length + mediaFiles.pdfs.length
  if (mediaCount > 0) {
    const summary: string[] = []
    if (mediaFiles.images.length) summary.push(`${mediaFiles.images.length} image(s)`)
    if (mediaFiles.audio.length) summary.push(`${mediaFiles.audio.length} audio`)
    if (mediaFiles.video.length) summary.push(`${mediaFiles.video.length} video`)
    if (mediaFiles.pdfs.length) summary.push(`${mediaFiles.pdfs.length} PDF(s)`)
    console.error(`→ Sending: ${summary.join(', ')}${prompt ? ' + text prompt' : ''}`)
  }

  // Structured output requires non-streaming mode
  if (opts.stream && !opts.json && !opts.schema) {
    // Streaming response
    const url = `${BASE_URL}/models/${opts.model}:streamGenerateContent?alt=sse&key=${apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errorText = await res.text()
      throw new NetworkError(`API error ${res.status}: ${errorText}`)
    }

    let fullText = ''
    const reader = res.body?.getReader()
    if (!reader) throw new NetworkError('No response body')

    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const jsonStr = line.slice(6).trim()
          if (!jsonStr || jsonStr === '[DONE]') continue
          try {
            const chunk = JSON.parse(jsonStr) as GeminiResponse
            const chunkParts = chunk.candidates?.[0]?.content?.parts || []
            for (const part of chunkParts) {
              if (part.thought || !part.text) continue
              process.stdout.write(part.text)
              fullText += part.text
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
    }

    process.stdout.write('\n')

    if (opts.output) {
      await mkdir(join(PROJECT_ROOT, 'outputs'), { recursive: true })
      const outPath = opts.output.startsWith('/') ? opts.output : join(PROJECT_ROOT, 'outputs', opts.output)
      await Bun.write(outPath, fullText)
      console.error(`\nSaved to: ${outPath}`)
    }

    return
  }

  // Non-streaming response
  const url = `${BASE_URL}/models/${opts.model}:generateContent?key=${apiKey}`
  const { data } = await request<GeminiResponse>({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: 600_000, // 10 min for large media / thinking
    retries: 2,
  })

  if (data.error) {
    throw new NetworkError(`API error: ${data.error.message}`)
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const textParts = data.candidates?.[0]?.content?.parts?.filter(p => !p.thought) || []
  const text = textParts.map(p => p.text).filter(Boolean).join('')
  console.log(text)

  if (data.usageMetadata) {
    const { promptTokenCount, candidatesTokenCount, totalTokenCount } = data.usageMetadata
    console.error(`\n[Tokens: ${promptTokenCount} in, ${candidatesTokenCount} out, ${totalTokenCount} total]`)
  }

  if (opts.output) {
    await mkdir(join(PROJECT_ROOT, 'outputs'), { recursive: true })
    const outPath = opts.output.startsWith('/') ? opts.output : join(PROJECT_ROOT, 'outputs', opts.output)
    await Bun.write(outPath, text)
    console.error(`Saved to: ${outPath}`)
  }
}

async function modelsCommand(apiKey: string, json: boolean) {
  const url = `${BASE_URL}/models?key=${apiKey}`
  const { data } = await request<GeminiModelsResponse>({
    method: 'GET',
    url,
    timeoutMs: 30_000,
    retries: 2,
  })

  if (json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const models = data.models || []
  const geminiModels = models.filter((m) => m.supportedGenerationMethods?.includes('generateContent'))

  console.log('Available Gemini Models:\n')
  for (const model of geminiModels) {
    const shortName = model.name.replace('models/', '')
    console.log(`  ${shortName}`)
    console.log(`    ${model.description || 'No description'}`)
    console.log(`    Input: ${model.inputTokenLimit?.toLocaleString() || '?'} tokens, Output: ${model.outputTokenLimit?.toLocaleString() || '?'} tokens`)
    console.log()
  }
}

async function countCommand(
  apiKey: string,
  text: string,
  mediaFiles: { images: string[]; audio: string[]; video: string[]; pdfs: string[] },
  model: string,
  json: boolean
) {
  const parts = await buildParts(text, mediaFiles, apiKey)

  if (parts.length === 0) {
    throw new UsageError('No content provided for token counting.')
  }

  const url = `${BASE_URL}/models/${model}:countTokens?key=${apiKey}`
  const body = {
    contents: [{ parts }],
  }

  const { data } = await request<GeminiCountResponse>({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: 60_000,
    retries: 2,
  })

  if (json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  console.log(`Tokens: ${data.totalTokens}`)
}

async function embedCommand(
  apiKey: string,
  text: string,
  opts: { model: string; json: boolean; output?: string }
) {
  if (!text) {
    throw new UsageError('No text provided for embedding. Note: embeddings only support text input.')
  }

  const url = `${BASE_URL}/models/${opts.model}:embedContent?key=${apiKey}`
  const body = {
    model: `models/${opts.model}`,
    content: { parts: [{ text }] },
  }

  const { data } = await request<GeminiEmbedResponse>({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: 30_000,
    retries: 2,
  })

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    const values = data.embedding?.values || []
    console.log(`Embedding dimensions: ${values.length}`)
    console.log(`First 5 values: [${values.slice(0, 5).map((v) => v.toFixed(6)).join(', ')}...]`)
  }

  if (opts.output) {
    await mkdir(join(PROJECT_ROOT, 'outputs'), { recursive: true })
    const outPath = opts.output.startsWith('/') ? opts.output : join(PROJECT_ROOT, 'outputs', opts.output)
    await Bun.write(outPath, JSON.stringify(data, null, 2))
    console.error(`Saved to: ${outPath}`)
  }
}

async function imageCommand(
  apiKey: string,
  text: string,
  mediaFiles: { images: string[]; audio: string[]; video: string[]; pdfs: string[] },
  opts: { model: string; aspectRatio?: string; imageSize?: string; output?: string; json: boolean }
) {
  if (!text && mediaFiles.images.length === 0) {
    throw new UsageError('Provide a text prompt and/or input image(s) for image generation.')
  }

  const parts = await buildParts(text, mediaFiles, apiKey)

  const generationConfig: GeminiRequest['generationConfig'] = {
    responseModalities: ['TEXT', 'IMAGE'],
  }
  const imageConfig: NonNullable<NonNullable<GeminiRequest['generationConfig']>['imageConfig']> = {}
  if (opts.aspectRatio) imageConfig.aspectRatio = opts.aspectRatio
  if (opts.imageSize) imageConfig.imageSize = opts.imageSize
  if (Object.keys(imageConfig).length > 0) generationConfig.imageConfig = imageConfig

  const body: GeminiRequest = {
    contents: [{ parts, role: 'user' }],
    generationConfig,
  }

  const url = `${BASE_URL}/models/${opts.model}:generateContent?key=${apiKey}`
  const { data } = await request<GeminiResponse>({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: 300_000, // 5 min — image generation is slow
    retries: 2,
  })

  if (data.error) {
    throw new NetworkError(`API error: ${data.error.message}`)
  }

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
    return
  }

  const responseParts = data.candidates?.[0]?.content?.parts || []
  let imageIndex = 0

  for (const part of responseParts) {
    if (part.text) {
      console.log(part.text)
    } else if (part.inlineData) {
      const mimeType = part.inlineData.mimeType
      const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg'
      const imageData = Buffer.from(part.inlineData.data, 'base64')

      let outPath: string
      if (opts.output && imageIndex === 0) {
        outPath = opts.output.startsWith('/') ? opts.output : join(PROJECT_ROOT, 'outputs', opts.output)
      } else {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const filename = `gemini-image-${timestamp}-${imageIndex}.${ext}`
        outPath = join(PROJECT_ROOT, 'outputs', filename)
      }

      await mkdir(join(PROJECT_ROOT, 'outputs'), { recursive: true })
      await Bun.write(outPath, imageData)
      console.error(`Saved image: ${outPath}`)
      imageIndex++
    }
  }

  if (imageIndex === 0) {
    console.error('Warning: No images were returned in the response.')
  }

  if (data.usageMetadata) {
    const { promptTokenCount, candidatesTokenCount, totalTokenCount } = data.usageMetadata
    console.error(`\n[Tokens: ${promptTokenCount} in, ${candidatesTokenCount} out, ${totalTokenCount} total]`)
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
    print_help('gemini - Google Gemini API CLI', usage())
    return
  }

  let flags: ReturnType<typeof parse_flags>
  try {
    flags = parse_flags(argv, {
      model: { type: 'string', alias: 'm' },
      system: { type: 'string', alias: 's' },
      temperature: { type: 'string', alias: 't' },
      'max-tokens': { type: 'string' },
      json: { type: 'boolean' },
      'no-stream': { type: 'boolean' },
      output: { type: 'string', alias: 'o' },
      schema: { type: 'string' },
      'schema-inline': { type: 'string' },
      // Multi-modal inputs (multi flag support)
      image: { type: 'string', alias: 'i', multi: true },
      audio: { type: 'string', alias: 'a', multi: true },
      video: { type: 'string', alias: 'v', multi: true },
      pdf: { type: 'string', alias: 'p', multi: true },
      // Thinking config
      'thinking-budget': { type: 'string' },
      'thinking-level': { type: 'string' },
      // Files API
      'files-api': { type: 'boolean' },
      // Image generation options
      'aspect-ratio': { type: 'string' },
      size: { type: 'string' },
    })
  } catch (err) {
    print_help('gemini', usage())
    throw new UsageError((err as Error)?.message || 'Invalid arguments')
  }

  const env = await load_env({ required: ['GEMINI_API_KEY'] })
  const apiKey = env.GEMINI_API_KEY

  // Collect media files
  const mediaFiles = {
    images: toStringArray(flags.image),
    audio: toStringArray(flags.audio),
    video: toStringArray(flags.video),
    pdfs: toStringArray(flags.pdf),
  }

  // Determine command
  const positional = flags._ as string[]
  let command = 'chat'
  let textInput = ''

  if (positional.length > 0) {
    const first = positional[0]
    if (['chat', 'image', 'models', 'count', 'embed'].includes(first)) {
      command = first
      textInput = positional.slice(1).join(' ')
    } else {
      textInput = positional.join(' ')
    }
  }

  // Read from stdin if no text input and not models command
  const hasMedia = mediaFiles.images.length + mediaFiles.audio.length + mediaFiles.video.length + mediaFiles.pdfs.length > 0
  if (!textInput && command !== 'models' && !hasMedia) {
    const isTTY = process.stdin.isTTY
    if (!isTTY) {
      textInput = await readStdin()
    }
  }

  // Load schema if provided
  let schema: Record<string, unknown> | undefined
  if (flags.schema) {
    const schemaPath = resolvePathOrThrow(String(flags.schema))
    const schemaContent = await Bun.file(schemaPath).text()
    try {
      schema = JSON.parse(schemaContent)
      console.error(`→ Using schema from: ${schemaPath}`)
    } catch (e) {
      throw new UsageError(`Invalid JSON in schema file: ${schemaPath}`)
    }
  } else if (flags['schema-inline']) {
    try {
      schema = JSON.parse(String(flags['schema-inline']))
      console.error(`→ Using inline schema`)
    } catch (e) {
      throw new UsageError(`Invalid JSON in --schema-inline`)
    }
  }

  // Execute command
  switch (command) {
    case 'chat': {
      await chatCommand(apiKey, textInput, mediaFiles, {
        model: String(flags.model || 'gemini-3-flash-preview'),
        system: flags.system ? String(flags.system) : undefined,
        temperature: Number(flags.temperature || 1.0),
        maxTokens: flags['max-tokens'] ? Number(flags['max-tokens']) : undefined,
        json: Boolean(flags.json),
        stream: !flags['no-stream'],
        output: flags.output ? String(flags.output) : undefined,
        schema,
        thinkingBudget: flags['thinking-budget'] !== undefined ? Number(flags['thinking-budget']) : undefined,
        thinkingLevel: flags['thinking-level'] ? String(flags['thinking-level']) : undefined,
        forceFilesApi: Boolean(flags['files-api']),
      })
      break
    }

    case 'image': {
      await imageCommand(apiKey, textInput, mediaFiles, {
        model: String(flags.model || 'gemini-3-pro-image-preview'),
        aspectRatio: flags['aspect-ratio'] ? String(flags['aspect-ratio']) : undefined,
        imageSize: flags.size ? String(flags.size) : undefined,
        output: flags.output ? String(flags.output) : undefined,
        json: Boolean(flags.json),
      })
      break
    }

    case 'models': {
      await modelsCommand(apiKey, Boolean(flags.json))
      break
    }

    case 'count': {
      await countCommand(apiKey, textInput, mediaFiles, String(flags.model || 'gemini-3-flash-preview'), Boolean(flags.json))
      break
    }

    case 'embed': {
      await embedCommand(apiKey, textInput, {
        model: String(flags.model || 'text-embedding-004'),
        json: Boolean(flags.json),
        output: flags.output ? String(flags.output) : undefined,
      })
      break
    }

    default:
      throw new UsageError(`Unknown command: ${command}`)
  }
}

main().catch((err) => handleError('gemini', err))
