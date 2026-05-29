#!/usr/bin/env bun

/**
 * macOS Contacts CLI Tool
 *
 * Extract contact names from macOS Contacts app for phone → name resolution.
 * Primary use case: Resolving phone numbers to names in Beeper/iMessage messages.
 *
 * Architecture:
 *   - Primary: SQLite database export (fast, ~1ms lookups)
 *   - Fallback: AppleScript direct lookup (slow, ~1-2s per lookup)
 *
 * Performance Notes:
 *   - JXA (JavaScript for Automation) is ~100x faster than AppleScript for bulk export
 *   - AppleScript iterates all contacts per lookup; JXA exports all at once
 *   - Re-run `export` after adding new contacts to macOS Contacts app
 *
 * Usage:
 *   bun contacts.ts lookup <phone-number>     Look up single phone → name
 *   bun contacts.ts lookup-batch              Read phone numbers from stdin, output JSON map
 *   bun contacts.ts export [--output FILE]    Export all contacts to SQLite
 *   bun contacts.ts stats                     Show contact database stats
 *
 * Examples:
 *   bun contacts.ts lookup "+1-503-929-4312"
 *   echo -e "+15551234567\n+15559876543" | bun contacts.ts lookup-batch
 *   bun contacts.ts export
 *   bun contacts.ts export --output ~/my-contacts.db
 */

import { spawnSync } from 'bun'
import { existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { Database } from 'bun:sqlite'

// ============================================================================
// Configuration
// ============================================================================

const HOME = process.env.HOME!
// Toolkit-relative: contacts.ts lives in tools/, so the toolkit root is its parent.
const DEFAULT_DB_PATH = join(dirname(import.meta.dir), 'data/contacts.db')

// ============================================================================
// Phone Number Utilities
// ============================================================================

/**
 * Normalize phone to 10-digit US format.
 * Strips all non-digits, removes leading country code (1) if present.
 *
 * Examples:
 *   "+1-503-929-4312" → "5039294312"
 *   "15039294312"     → "5039294312"
 *   "(503) 929-4312"  → "5039294312"
 */
function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1)
  }
  return digits
}

/**
 * Format phone number for human-readable display.
 * Converts 10-digit numbers to +1 XXX-XXX-XXXX format.
 */
function formatPhone(phone: string): string {
  const digits = normalizePhone(phone)
  if (digits.length === 10) {
    return `+1 ${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  }
  return phone
}

// ============================================================================
// Lookup Methods
// ============================================================================

/**
 * Look up contact by phone via AppleScript (slow fallback).
 *
 * Performance: ~1-2 seconds per lookup (iterates all contacts)
 * Use case: When contact was just added and DB not yet re-exported
 *
 * Note: This is intentionally slow - use SQLite DB for production lookups.
 * The DB should be re-exported after adding new contacts.
 */
function lookupByPhoneDirect(phone: string): string | null {
  const normalized = normalizePhone(phone)

  const script = `
on normalizePhone(phoneStr)
  try
    set digits to do shell script "echo '" & phoneStr & "' | sed 's/[^0-9]//g'"
    if (length of digits) = 11 and (text 1 of digits) = "1" then
      return text 2 thru -1 of digits
    end if
    return digits
  on error
    return ""
  end try
end normalizePhone

tell application "Contacts"
  set targetPhone to "${normalized}"

  repeat with onePerson in people
    repeat with thisPhone in phones of onePerson
      try
        set phoneValue to value of thisPhone
        set normalizedValue to my normalizePhone(phoneValue)

        if normalizedValue = targetPhone then
          return name of onePerson
        end if
      on error
        -- Skip inaccessible contacts
      end try
    end repeat
  end repeat

  return ""
end tell
  `

  const proc = spawnSync(['osascript'], {
    stdin: Buffer.from(script),
  })

  if (proc.exitCode === 0) {
    const result = proc.stdout.toString().trim()
    return result || null
  }

  // Don't log errors - AppleScript fallback is expected to fail sometimes
  // (e.g., app not running, connection timeout)
  return null
}

/**
 * Look up contact by phone via SQLite database (fast, preferred).
 *
 * Performance: ~1ms per lookup
 * Requires: Run `contacts export` first to populate the database
 */
function lookupByPhoneDb(phone: string, dbPath: string = DEFAULT_DB_PATH): string | null {
  if (!existsSync(dbPath)) {
    return null
  }

  const db = new Database(dbPath, { readonly: true })
  const normalized = normalizePhone(phone)

  try {
    const result = db.query<{ name: string }, [string]>(`
      SELECT c.name FROM contacts c
      JOIN phones p ON p.contact_id = c.id
      WHERE p.phone_normalized = ?
    `).get(normalized)

    return result?.name || null
  } finally {
    db.close()
  }
}

/**
 * Look up contact by phone - tries DB first, falls back to AppleScript.
 *
 * Strategy:
 *   1. SQLite DB lookup (~1ms) - covers 99% of cases
 *   2. AppleScript fallback (~1-2s) - for newly added contacts
 *
 * For best performance, re-run `contacts export` after adding new contacts
 * rather than relying on the slow AppleScript fallback.
 */
function lookupByPhone(phone: string, dbPath: string = DEFAULT_DB_PATH): string | null {
  // Try SQLite first (fast)
  const dbResult = lookupByPhoneDb(phone, dbPath)
  if (dbResult) return dbResult

  // Fall back to AppleScript (slow but always current)
  return lookupByPhoneDirect(phone)
}

// ============================================================================
// Export Functions
// ============================================================================

/**
 * Export all contacts with phone numbers to SQLite database.
 *
 * Uses JXA (JavaScript for Automation) for bulk export:
 *   - JXA: ~10-30 seconds for 1700+ contacts
 *   - AppleScript equivalent: ~30+ minutes (too slow for practical use)
 *
 * The 100x speedup comes from JXA's ability to batch operations,
 * while AppleScript must iterate synchronously.
 *
 * Run this command after adding new contacts to your address book.
 */
async function exportContacts(outputPath: string = DEFAULT_DB_PATH): Promise<void> {
  // Ensure directory exists
  const dir = dirname(outputPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  console.log('Exporting contacts from macOS Contacts app...')
  console.log('(Using JXA for fast bulk export - typically 10-30 seconds)')

  // Use JXA (JavaScript for Automation) which is ~100x faster than AppleScript
  const script = `
    const app = Application('Contacts');
    app.includeStandardAdditions = true;

    const people = app.people();
    const results = [];

    for (let i = 0; i < people.length; i++) {
      try {
        const person = people[i];
        const phones = person.phones();

        if (phones.length === 0) continue;

        const name = person.name();
        const id = person.id();

        for (let j = 0; j < phones.length; j++) {
          try {
            const phone = phones[j];
            const value = phone.value();
            const label = phone.label() || 'unknown';
            results.push(id + '||' + name + '||' + label + '||' + value);
          } catch (e) {
            // Skip inaccessible phone
          }
        }
      } catch (e) {
        // Skip inaccessible contact
      }
    }

    results.join('|||');
  `

  const proc = spawnSync(['osascript', '-l', 'JavaScript'], {
    stdin: Buffer.from(script),
  })

  if (proc.exitCode !== 0) {
    console.error('JXA error:', proc.stderr.toString())
    process.exit(1)
  }

  const output = proc.stdout.toString()
  const entries = output.split('|||').filter(Boolean)

  // Create/recreate database
  if (existsSync(outputPath)) {
    // Remove existing DB to start fresh
    const db = new Database(outputPath)
    db.run('DROP TABLE IF EXISTS phones')
    db.run('DROP TABLE IF EXISTS contacts')
    db.close()
  }

  const db = new Database(outputPath)

  // Create schema
  db.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    )
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS phones (
      phone_normalized TEXT PRIMARY KEY,
      phone_raw TEXT,
      label TEXT,
      contact_id TEXT REFERENCES contacts(id)
    )
  `)

  db.run('CREATE INDEX IF NOT EXISTS idx_phones_contact ON phones(contact_id)')

  // Use transaction for faster inserts
  const insertContact = db.prepare('INSERT OR REPLACE INTO contacts (id, name) VALUES (?, ?)')
  const insertPhone = db.prepare('INSERT OR REPLACE INTO phones (phone_normalized, phone_raw, label, contact_id) VALUES (?, ?, ?, ?)')

  const contactIds = new Set<string>()
  let phoneCount = 0

  db.run('BEGIN TRANSACTION')

  for (const entry of entries) {
    const parts = entry.split('||')
    if (parts.length < 4) continue

    const [id, name, label, phone] = parts

    // Insert contact if not already done
    if (!contactIds.has(id)) {
      insertContact.run(id, name)
      contactIds.add(id)
    }

    // Insert phone
    const normalized = normalizePhone(phone)
    if (normalized) {
      insertPhone.run(normalized, phone, label || 'unknown', id)
      phoneCount++
    }
  }

  db.run('COMMIT')
  db.close()

  console.log(`Exported ${contactIds.size} contacts with ${phoneCount} phone numbers to ${outputPath}`)
}

// ============================================================================
// Statistics & Diagnostics
// ============================================================================

/**
 * Display database statistics and sample data.
 * Useful for verifying export success and checking data quality.
 */
function showStats(dbPath: string = DEFAULT_DB_PATH): void {
  if (!existsSync(dbPath)) {
    console.log('No contacts database found. Run "contacts export" first.')
    return
  }

  const db = new Database(dbPath, { readonly: true })

  const contactCount = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM contacts').get()
  const phoneCount = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM phones').get()

  // Get contacts with most phone numbers
  const topContacts = db.query<{ name: string; phone_count: number }, []>(`
    SELECT c.name, COUNT(p.phone_normalized) as phone_count
    FROM contacts c
    JOIN phones p ON p.contact_id = c.id
    GROUP BY c.id
    ORDER BY phone_count DESC
    LIMIT 5
  `).all()

  console.log('Contacts Database Statistics')
  console.log('============================')
  console.log(`Database path: ${dbPath}`)
  console.log(`Total contacts: ${contactCount?.count || 0}`)
  console.log(`Total phone numbers: ${phoneCount?.count || 0}`)
  console.log('')
  console.log('Contacts with most phone numbers:')
  for (const contact of topContacts) {
    console.log(`  ${contact.name}: ${contact.phone_count} numbers`)
  }

  db.close()
}

// ============================================================================
// Batch Operations
// ============================================================================

/**
 * Batch lookup: read phone numbers from stdin, output JSON map.
 * Useful for resolving multiple numbers in a single invocation.
 */
async function lookupBatch(dbPath: string = DEFAULT_DB_PATH): Promise<void> {
  const input = await Bun.stdin.text()
  const phones = input.trim().split('\n').filter(Boolean)

  const results: Record<string, string | null> = {}

  for (const phone of phones) {
    const name = lookupByPhone(phone.trim(), dbPath)
    results[phone.trim()] = name
  }

  console.log(JSON.stringify(results, null, 2))
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h') {
    console.log(`
macOS Contacts CLI Tool

Usage:
  bun contacts.ts lookup <phone-number>     Look up single phone → name
  bun contacts.ts lookup-batch              Read phone numbers from stdin, output JSON map
  bun contacts.ts export [--output FILE]    Export all contacts to SQLite
  bun contacts.ts stats                     Show contact database stats

Examples:
  bun contacts.ts lookup "+1-503-929-4312"
  echo -e "+15551234567\\n+15559876543" | bun contacts.ts lookup-batch
  bun contacts.ts export
  bun contacts.ts export --output ~/my-contacts.db

Options:
  --output, -o    Output path for SQLite database (default: <toolkit>/data/contacts.db)
  --help, -h      Show this help message
`)
    return
  }

  switch (command) {
    case 'lookup': {
      const phone = args[1]
      if (!phone) {
        console.error('Error: Phone number required')
        console.error('Usage: bun contacts.ts lookup <phone-number>')
        process.exit(1)
      }
      const name = lookupByPhone(phone)
      if (name) {
        console.log(name)
      } else {
        console.log(formatPhone(phone))
        process.exit(1) // Exit 1 to indicate no match found
      }
      break
    }

    case 'lookup-batch': {
      await lookupBatch()
      break
    }

    case 'export': {
      const outputIdx = args.findIndex(a => a === '--output' || a === '-o')
      const outputPath = outputIdx >= 0 ? args[outputIdx + 1] : DEFAULT_DB_PATH
      await exportContacts(outputPath)
      break
    }

    case 'stats': {
      showStats()
      break
    }

    default:
      console.error(`Unknown command: ${command}`)
      console.error('Run "bun contacts.ts --help" for usage')
      process.exit(1)
  }
}

main().catch(err => {
  console.error('Error:', err)
  process.exit(1)
})
