#!/usr/bin/env bun

/**
 * Robust path resolution that handles Unicode filename issues.
 *
 * macOS and Google Docs use "smart" Unicode characters that look identical
 * to ASCII but don't match when typed:
 *   - EN DASH (U+2013) vs hyphen (U+002D)
 *   - NO-BREAK SPACE (U+00A0) vs space (U+0020)
 *   - FULLWIDTH SOLIDUS (U+FF0F) vs slash
 *   - Narrow no-break space (U+202F) vs space (macOS screenshots)
 *   - Curly quotes (U+2019) vs apostrophe
 *
 * This module provides fuzzy path resolution so tools work even when
 * users type ASCII approximations of Unicode filenames.
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, basename, join, resolve } from 'node:path'

/**
 * Unicode -> ASCII normalization map for filename matching
 */
const NORMALIZE_MAP: Record<string, string> = {
  '\u2013': '-',    // EN DASH
  '\u2014': '-',    // EM DASH
  '\u2015': '-',    // HORIZONTAL BAR
  '\u2212': '-',    // MINUS SIGN
  '\u00A0': ' ',    // NO-BREAK SPACE
  '\u202F': ' ',    // NARROW NO-BREAK SPACE (macOS screenshots)
  '\u2019': "'",    // RIGHT SINGLE QUOTATION MARK
  '\u2018': "'",    // LEFT SINGLE QUOTATION MARK
  '\u201C': '"',    // LEFT DOUBLE QUOTATION MARK
  '\u201D': '"',    // RIGHT DOUBLE QUOTATION MARK
  '\uFF0F': '/',    // FULLWIDTH SOLIDUS
  '\uFF1A': ':',    // FULLWIDTH COLON
  '\u2026': '...',  // ELLIPSIS
}

/**
 * Normalize a string by replacing Unicode lookalikes with ASCII equivalents
 */
export function normalizeUnicode(str: string): string {
  let result = str
  for (const [unicode, ascii] of Object.entries(NORMALIZE_MAP)) {
    result = result.split(unicode).join(ascii)
  }
  return result
}

/**
 * Check if two strings match when both are normalized
 */
function fuzzyMatch(a: string, b: string): boolean {
  return normalizeUnicode(a).toLowerCase() === normalizeUnicode(b).toLowerCase()
}

/**
 * Resolve a file path, with fuzzy matching for Unicode filenames.
 *
 * @param inputPath - The path as typed by the user (may use ASCII approximations)
 * @param options - Optional settings
 * @returns The actual filesystem path, or null if not found
 *
 * @example
 * // User types ASCII hyphen, file has EN DASH
 * resolvePath('~/docs/AI - Overview.txt')
 * // Returns: '/Users/x/docs/AI – Overview.txt' (with actual EN DASH)
 */
export function resolvePath(
  inputPath: string,
  options: { mustExist?: boolean } = {}
): string | null {
  const { mustExist = true } = options

  // Expand ~ to home directory
  let expanded = inputPath
  if (expanded.startsWith('~/')) {
    expanded = join(process.env.HOME || '', expanded.slice(2))
  }

  const fullPath = resolve(expanded)

  // Try exact match first
  if (existsSync(fullPath)) {
    return fullPath
  }

  // If exact match fails and we need the file to exist, try fuzzy matching
  if (mustExist) {
    const dir = dirname(fullPath)
    const base = basename(fullPath)

    // Check if directory exists
    if (!existsSync(dir)) {
      // Try to resolve the directory recursively
      const resolvedDir = resolvePath(dir, { mustExist: true })
      if (!resolvedDir) return null
      return resolvePath(join(resolvedDir, base), { mustExist: true })
    }

    // Search directory for fuzzy match
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (fuzzyMatch(entry, base)) {
          return join(dir, entry)
        }
      }
    } catch {
      // Directory not readable
    }

    return null
  }

  return fullPath
}

/**
 * Resolve a path, throwing an error if not found
 */
export function resolvePathOrThrow(inputPath: string): string {
  const resolved = resolvePath(inputPath)
  if (!resolved) {
    throw new Error(`File not found: ${inputPath}`)
  }
  return resolved
}

/**
 * Find all files in a directory matching a pattern (with fuzzy Unicode matching)
 */
export function findFiles(
  dir: string,
  pattern: string | RegExp
): string[] {
  const resolvedDir = resolvePath(dir)
  if (!resolvedDir) return []

  try {
    const entries = readdirSync(resolvedDir)
    const regex = typeof pattern === 'string'
      ? new RegExp(normalizeUnicode(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
      : pattern

    return entries
      .filter(entry => {
        const normalized = normalizeUnicode(entry)
        return regex.test(normalized) || regex.test(entry)
      })
      .map(entry => join(resolvedDir, entry))
  } catch {
    return []
  }
}

// CLI for testing
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 0) {
    console.log('Usage: paths.ts <file_path>')
    console.log('       paths.ts --scan <directory>')
    process.exit(0)
  }

  if (args[0] === '--scan') {
    const dir = args[1] || '.'
    const resolved = resolvePath(dir)
    if (!resolved) {
      console.error(`Directory not found: ${dir}`)
      process.exit(1)
    }

    console.log(`Scanning: ${resolved}\n`)
    const entries = readdirSync(resolved)
    let issues = 0
    for (const entry of entries) {
      const normalized = normalizeUnicode(entry)
      if (entry !== normalized) {
        issues++
        console.log(`ISSUE: ${entry}`)
        console.log(`TYPED: ${normalized}`)
        console.log()
      }
    }
    console.log(`Found ${issues} files with Unicode characters out of ${entries.length} total`)
  } else {
    const input = args[0]
    const resolved = resolvePath(input)
    if (resolved) {
      console.log(`Input:    ${input}`)
      console.log(`Resolved: ${resolved}`)
      if (input !== resolved && normalizeUnicode(basename(input)) !== basename(input)) {
        console.log(`(fuzzy match applied)`)
      }
    } else {
      console.error(`Not found: ${input}`)
      process.exit(1)
    }
  }
}
