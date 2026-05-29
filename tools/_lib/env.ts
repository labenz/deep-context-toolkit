#!/usr/bin/env bun

// prefer Bun.file over Node fs for env reads
import { existsSync } from 'node:fs'
import { dirname, join, parse, resolve } from 'node:path'

export type LoadedEnv = Record<string, string>

// `import.meta` isn't supported under TypeScript's default compiler settings
// (which is what `bunx tsc --noEmit tools/<tool>.ts` uses). Use the entrypoint
// path instead.
const DISTRIBUTION_ROOT = resolve(dirname(Bun.main), '..')

function hasMarker(dir: string): boolean {
  const markers = [
    '.git',
    '.hg',
    'context',
    'prompts',
    'schemas',
    'workflows',
    'package.json',
    'bun.lock',
    'bun.lockb',
    'pnpm-lock.yaml',
    'yarn.lock'
  ]
  for (const marker of markers) {
    const candidate = join(dir, marker)
    try {
      if (existsSync(candidate)) return true
    } catch {
      // ignore permission issues and continue upward
    }
  }
  return false
}

function ascendToMarker(startDir: string): string | null {
  if (!startDir) return null
  let current = resolve(startDir)
  const root = parse(current).root
  const visited = new Set<string>()
  while (!visited.has(current)) {
    if (hasMarker(current)) return current
    visited.add(current)
    if (current === root) break
    current = dirname(current)
  }
  return null
}

export function resolve_project_root(): string {
  const envCandidate = (process.env.AI_CLI_PROJECT_ROOT || process.env.PROJECT_ROOT || process.env.PROJECT_ROOT_DIR || '').trim()
  if (envCandidate) return resolve(envCandidate)

  const startDir = process.cwd()
  const detected = ascendToMarker(startDir)
  if (detected) return detected
  if (startDir && startDir.trim()) return resolve(startDir)
  return DISTRIBUTION_ROOT
}

export const PROJECT_ROOT = resolve_project_root()

/** Resolved path to the first existing .env file (for writes). */
export const WRITABLE_ENV_PATH: string = (() => {
  const candidates = [
    join(DISTRIBUTION_ROOT, 'tools/.env'),
    join(DISTRIBUTION_ROOT, '.env'),
    join(PROJECT_ROOT, 'tools/.env'),
    join(PROJECT_ROOT, '.env'),
  ]
  for (const p of candidates) {
    try { if (existsSync(p)) return p } catch {}
  }
  // Fallback: canonical location
  return join(DISTRIBUTION_ROOT, 'tools/.env')
})()

const ENV_LOCATIONS_IN_PRECEDENCE: string[] = [
  join(PROJECT_ROOT, '.env'),
  join(PROJECT_ROOT, 'tools/.env'),
  // fall back to the bundled ai_cli distribution
  join(DISTRIBUTION_ROOT, '.env'),
  join(DISTRIBUTION_ROOT, 'tools/.env'),
  join(dirname(DISTRIBUTION_ROOT), 'ai_cli/.env'),
  join(process.env.HOME ?? '', '.ai_cli/.env'),
  join(process.env.HOME ?? '', '.config/ai_cli/.env'),
  join(process.env.HOME ?? '', '.env'),
]

function safeSplitKeyValue(line: string): [string, string] | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  if (trimmed.startsWith('#')) return null
  const eqIndex = trimmed.indexOf('=')
  let key = ''
  let value = ''
  if (eqIndex > 0) {
    key = trimmed.slice(0, eqIndex).trim()
    value = trimmed.slice(eqIndex + 1)
  } else {
    // Fallback: support YAML-like KEY: value lines
    const colonIndex = trimmed.indexOf(':')
    if (colonIndex > 0) {
      const k = trimmed.slice(0, colonIndex).trim()
      // Allow only env-like keys to avoid parsing generic YAML
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
        key = k
        value = trimmed.slice(colonIndex + 1).trim()
      } else {
        return null
      }
    } else {
      return null
    }
  }
  // Support "export KEY=VALUE" style
  if (key.startsWith('export ')) key = key.slice('export '.length).trim()
  // Remove surrounding quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1)
  }
  if (key === '') return null
  return [key, value]
}

async function readEnvFile(path: string): Promise<LoadedEnv> {
  try {
    const raw = await Bun.file(path).text()
    const out: LoadedEnv = {}
    for (const line of raw.split(/\r?\n/)) {
      const pair = safeSplitKeyValue(line)
      if (!pair) continue
      const [key, value] = pair
      if (!(key in out)) {
        out[key] = value
      }
    }
    return out
  } catch {
    return {}
  }
}

export async function load_env(options?: { required?: string[] }): Promise<LoadedEnv> {
  const merged: LoadedEnv = {}
  // Start with existing process.env; do NOT overwrite later
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') merged[k] = v
  }

  for (const loc of ENV_LOCATIONS_IN_PRECEDENCE) {
    if (!loc || loc.includes('//')) continue
    const envFromFile = await readEnvFile(loc)
    for (const [k, v] of Object.entries(envFromFile)) {
      // Overwrite if key missing or existing value is empty string
      if (!(k in merged) || merged[k] === '') merged[k] = v
    }
  }

  if (options?.required?.length) {
    const missing = options.required.filter((k) => !merged[k] || merged[k].length === 0)
    if (missing.length) {
      const msg = `Missing required env keys: ${missing.join(', ')}`
      // Write to stderr so callers can decide exit code policy
      console.error(msg)
      const error: Error & { code?: number } = new Error(msg)
      error.code = 64
      throw error
    }
  }
  return merged
}


