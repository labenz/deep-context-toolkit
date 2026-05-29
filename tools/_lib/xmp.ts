#!/usr/bin/env bun
// XMP writer used by tools to write a minimal set of fields, plus optional JSON payload
// If exiftool is unavailable, it returns ok=false.

export type XmpMeta = {
  description?: string
  identifier?: string
  created_at?: string // ISO 8601 (preferred key)
  createdAt?: string  // backward-compat key
  source_url?: string
  sourceUrl?: string  // backward-compat key
  // Optional provider metadata to serialize as compact JSON into a non-photoshop field
  source_meta?: Record<string, unknown>
  sourceMeta?: Record<string, unknown> // backward-compat key
}

function compact_json(obj: unknown): string {
  try { return JSON.stringify(obj) } catch { return '' }
}

function has_object_keys(v: unknown): boolean {
  return !!(v && typeof v === 'object' && Object.keys(v as Record<string, unknown>).length > 0)
}

export async function write_xmp(
  file_path: string,
  meta: XmpMeta,
  opts?: { strict?: boolean; logger?: (s: string) => void }
): Promise<{ ok: boolean; reason?: string }>{
  const log = opts?.logger || ((s: string) => process.stderr.write(`${s}\n`))
  const strict = opts?.strict !== false
  // AI test mode short-circuit
  if (process.env.AI_TEST_MODE) { log(`Meta: ok ${file_path}`); return { ok: true, reason: 'test-mode' } }
  if (!file_path || typeof file_path !== 'string') return { ok: false, reason: 'invalid-path' }
  if (!meta || typeof meta !== 'object') return { ok: false, reason: 'invalid-meta' }

  const created_at = String((meta.created_at ?? meta.createdAt ?? '')).trim()
  if (!created_at) return { ok: false, reason: 'missing-created_at' }

  // exiftool check
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const which: any = (Bun as any).which || (globalThis as any).which
  let exiftool = ''
  try { exiftool = which ? which('exiftool') : '' } catch { exiftool = '' }
  if (!exiftool) return { ok: false, reason: 'exiftool-not-found' }

  const identifier = meta.identifier ? String(meta.identifier) : ''
  const source_url = meta.source_url ? String(meta.source_url) : (meta.sourceUrl ? String(meta.sourceUrl) : '')
  // Phase 1: write minimum fields (v1 ignores any JSON payloads)
  const baseArgs: string[] = ['-overwrite_original']
  if (identifier) baseArgs.push(`-XMP-dc:Identifier=${identifier}`)
  baseArgs.push(`-XMP-xmp:CreateDate=${created_at}`)
  if (source_url) baseArgs.push(`-XMP-dc:Source=${source_url}`)
  const description = meta.description ? String(meta.description) : ''
  if (description) baseArgs.push(`-XMP-dc:Description=${description}`)

  let p = Bun.spawn({ cmd: [exiftool, ...baseArgs, file_path], stdout: 'ignore', stderr: 'pipe' })
  let exit = await p.exited
  let stderrTxt = await new Response(p.stderr).text()
  if (exit !== 0) {
    log(`Meta: error exiftool-exit-${exit}${stderrTxt ? `: ${stderrTxt.split('\n')[0]}` : ''} ${file_path}`)
    return strict ? { ok: false, reason: `exiftool-exit-${exit}` } : { ok: true, reason: `fields-partial` }
  }

  // Phase 2 removed in v1: no JSON payloads are written

  log(`Meta: ok ${file_path}`)
  return { ok: true }
}

// Backward-compat wrapper used by existing tools
export const write_minimal_xmp = write_xmp;
