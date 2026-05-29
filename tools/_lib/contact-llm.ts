// Contact LLM Library
// Gemini integration for evaluating uncertain match candidates

import { load_env } from './env'
import { request } from './http'
import type { PersonRecord, MatchCandidate, MatchSignal } from './contact-matching'
import Database from 'bun:sqlite'

// ============================================================
// TYPES
// ============================================================

interface GeminiResponse {
  candidates?: Array<{
    content: { parts: Array<{ text?: string }> }
  }>
  usageMetadata?: {
    promptTokenCount: number
    candidatesTokenCount: number
  }
  error?: { message: string }
}

export interface LLMMatchResult {
  samePerson: boolean | 'uncertain'
  confidence: number
  reasoning: string
  promptTokens: number
  outputTokens: number
}

// ============================================================
// CONTEXT GATHERING
// ============================================================

/**
 * Get sample thread subjects for a person
 */
export function getSampleSubjects(db: Database, personId: string, limit = 5): string[] {
  const threads = db.query(`
    SELECT DISTINCT t.subject, t.title
    FROM threads t
    WHERE t.participant_ids LIKE ? OR t.participant_ids LIKE ?
    ORDER BY t.last_activity_at DESC
    LIMIT ?
  `).all(`%"${personId}"%`, `%${personId}%`, limit) as Array<{ subject: string | null; title: string | null }>

  return threads
    .map(t => t.subject || t.title)
    .filter((s): s is string => !!s && s.length > 0)
}

/**
 * Get sample messages for a person (both sent and received)
 */
export function getSampleMessages(
  db: Database,
  personId: string,
  limit = 3
): Array<{ content: string; timestamp: string; is_from_them: boolean }> {
  // Messages FROM this person
  const fromThem = db.query(`
    SELECT content, timestamp, 0 as is_from_me
    FROM messages
    WHERE sender_id = ?
      AND content IS NOT NULL
      AND LENGTH(content) > 20
      AND LENGTH(content) < 1000
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(personId, limit) as Array<{ content: string; timestamp: string; is_from_me: number }>

  // Messages TO this person (from threads they're in, where message is from the owner)
  const toThem = db.query(`
    SELECT m.content, m.timestamp, 1 as is_from_me
    FROM messages m
    JOIN threads t ON m.thread_id = t.id
    WHERE m.is_from_me = 1
      AND (t.participant_ids LIKE ? OR t.participant_ids LIKE ?)
      AND m.content IS NOT NULL
      AND LENGTH(m.content) > 20
      AND LENGTH(m.content) < 1000
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(`%"${personId}"%`, `%${personId}%`, limit) as Array<{ content: string; timestamp: string; is_from_me: number }>

  return [
    ...fromThem.map(m => ({ ...m, is_from_them: true })),
    ...toThem.map(m => ({ ...m, is_from_them: false }))
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit * 2)
}

/**
 * Get source channels for a person record
 */
function getSourceChannels(db: Database, personId: string): string[] {
  // Get sources from messages
  const messageSources = db.query(`
    SELECT DISTINCT source FROM messages WHERE sender_id = ?
  `).all(personId) as Array<{ source: string }>

  // Get sources from thread participation
  const threadSources = db.query(`
    SELECT DISTINCT source FROM threads
    WHERE participant_ids LIKE ? OR participant_ids LIKE ?
  `).all(`%"${personId}"%`, `%${personId}%`) as Array<{ source: string }>

  const sources = new Set<string>()
  for (const { source } of messageSources) sources.add(source)
  for (const { source } of threadSources) sources.add(source)

  // Also infer from person ID prefix
  if (personId.startsWith('gmail-')) sources.add('gmail')
  if (personId.startsWith('slack-')) sources.add('slack')
  if (personId.startsWith('beeper-')) sources.add('beeper')
  if (personId.startsWith('twitter-user-')) sources.add('twitter')
  if (personId.startsWith('calls-')) sources.add('calls')
  if (personId.startsWith('podcast-')) sources.add('podcast')

  return [...sources]
}

/**
 * Check if two people ever appear in the same thread (strong evidence they're different)
 */
function checkCoOccurrence(db: Database, personId1: string, personId2: string): boolean {
  const sharedThreads = db.query(`
    SELECT COUNT(*) as count FROM threads
    WHERE (participant_ids LIKE ? OR participant_ids LIKE ?)
      AND (participant_ids LIKE ? OR participant_ids LIKE ?)
  `).get(
    `%"${personId1}"%`, `%${personId1}%`,
    `%"${personId2}"%`, `%${personId2}%`
  ) as { count: number }

  return sharedThreads.count > 0
}

/**
 * Format a person record for LLM context
 * Enhanced with source channels, timeline analysis, and co-occurrence info
 */
function formatPersonForLLM(
  db: Database,
  person: PersonRecord,
  label: string,
  otherPersonId?: string
): string {
  const subjects = getSampleSubjects(db, person.id, 5)
  const messages = getSampleMessages(db, person.id, 3)
  const sources = getSourceChannels(db, person.id)

  let context = `## ${label}: ${person.display_name}\n`
  context += `- ID: ${person.id}\n`
  context += `- Identifiers: ${person.identifiers || 'none'}\n`
  context += `- Source channels: ${sources.length > 0 ? sources.join(', ') : 'unknown'}\n`

  if (person.organization) {
    context += `- Organization: ${person.organization}\n`
  }
  if (person.title) {
    context += `- Title: ${person.title}\n`
  }

  context += `- Thread count: ${person.thread_count}\n`
  context += `- Message count: ${person.message_count}\n`

  if (person.first_seen) {
    context += `- First seen: ${person.first_seen.split('T')[0]}\n`
  }
  if (person.last_seen) {
    context += `- Last seen: ${person.last_seen.split('T')[0]}\n`
  }

  // Add timeline context
  if (person.first_seen && person.last_seen) {
    const firstDate = new Date(person.first_seen)
    const lastDate = new Date(person.last_seen)
    const durationDays = Math.round((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24))
    context += `- Active period: ${durationDays} days\n`
  }

  if (subjects.length > 0) {
    context += `\n### Sample thread subjects:\n`
    for (const subj of subjects.slice(0, 5)) {
      context += `- ${subj.slice(0, 100)}${subj.length > 100 ? '...' : ''}\n`
    }
  }

  if (messages.length > 0) {
    context += `\n### Sample messages:\n`
    for (const msg of messages.slice(0, 4)) {
      const direction = msg.is_from_them ? 'FROM them' : 'TO them'
      const preview = msg.content.slice(0, 200).replace(/\n/g, ' ')
      context += `- [${direction}] ${preview}${msg.content.length > 200 ? '...' : ''}\n`
    }
  }

  return context
}

/**
 * Format heuristic signals for LLM context
 */
function formatSignalsForLLM(signals: MatchSignal[]): string {
  if (signals.length === 0) return 'No direct matching signals found.'

  let context = 'Matching signals detected:\n'
  for (const signal of signals) {
    context += `- ${signal.description} (confidence: ${Math.round(signal.confidence * 100)}%)\n`
  }
  return context
}

// ============================================================
// LLM EVALUATION
// ============================================================

const MATCH_EVALUATION_PROMPT = `You are helping deduplicate contact records in a personal knowledge base. Your task is to determine if two records represent the same real person.

IMPORTANT CONTEXT:
- These records come from different communication sources (email, Slack, messaging apps, Twitter, calls, etc.)
- The same person may have different display names across platforms (nicknames, formal vs informal)
- The same person may have multiple email addresses (personal, work, old/new)
- Phone numbers may appear in different formats

STRONG SIGNALS:
- If two records appear in the SAME conversation thread, they are DIFFERENT people (co-occurrence)
- If records share the exact same email or phone, they are likely the SAME person
- Cross-channel matches (same name in different platforms) suggest the same person

CONSIDER:
1. Name variations: Mike/Michael, Dan/Daniel, first-name-only vs full name
2. Email patterns: same domain suggests same organization
3. Organizational context: same company, similar role
4. Source channels: being in different channels doesn't mean different people
5. Timeline: do the date ranges overlap or make sense for the same person?
6. Message content/context: does the communication style and topics suggest the same person?

RESPOND WITH ONLY A JSON OBJECT (no markdown, no explanation outside JSON):
{
  "same_person": true | false | "uncertain",
  "confidence": 0.0 to 1.0,
  "reasoning": "Brief explanation of your determination"
}

Use "uncertain" if there's not enough information to decide with reasonable confidence.`

/**
 * Evaluate a match candidate using Gemini LLM
 */
export async function evaluateWithLLM(
  db: Database,
  candidate: MatchCandidate,
  opts: { model?: string; debug?: boolean } = {}
): Promise<LLMMatchResult> {
  const env = load_env()
  const apiKey = env.GEMINI_API_KEY

  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not configured in .env')
  }

  const model = opts.model || 'gemini-2.0-flash'

  // Build context
  const person1Context = formatPersonForLLM(db, candidate.person1, 'Record A', candidate.person2.id)
  const person2Context = formatPersonForLLM(db, candidate.person2, 'Record B', candidate.person1.id)
  const signalsContext = formatSignalsForLLM(candidate.signals)

  // Check for co-occurrence (strong evidence they're different people)
  const coOccurs = checkCoOccurrence(db, candidate.person1.id, candidate.person2.id)

  // Get source channels for cross-channel analysis
  const sources1 = getSourceChannels(db, candidate.person1.id)
  const sources2 = getSourceChannels(db, candidate.person2.id)
  const sourceOverlap = sources1.filter(s => sources2.includes(s))

  // Build additional context
  let additionalContext = ''

  if (coOccurs) {
    additionalContext += '\n**IMPORTANT:** These two records appear together in the same conversation thread. This is STRONG evidence they are DIFFERENT people.\n'
  }

  if (sourceOverlap.length === 0 && sources1.length > 0 && sources2.length > 0) {
    additionalContext += `\nNote: These records appear in completely different communication channels (${sources1.join('/')} vs ${sources2.join('/')}). This could mean they are separate identities for the same person across platforms.\n`
  }

  // Timeline overlap analysis
  if (candidate.person1.first_seen && candidate.person2.first_seen &&
      candidate.person1.last_seen && candidate.person2.last_seen) {
    const p1Start = new Date(candidate.person1.first_seen).getTime()
    const p1End = new Date(candidate.person1.last_seen).getTime()
    const p2Start = new Date(candidate.person2.first_seen).getTime()
    const p2End = new Date(candidate.person2.last_seen).getTime()

    const overlapStart = Math.max(p1Start, p2Start)
    const overlapEnd = Math.min(p1End, p2End)

    if (overlapStart < overlapEnd) {
      const overlapDays = Math.round((overlapEnd - overlapStart) / (1000 * 60 * 60 * 24))
      additionalContext += `\nTimeline overlap: ${overlapDays} days of concurrent activity.\n`
    } else {
      additionalContext += `\nNote: No timeline overlap - these records were active in different time periods.\n`
    }
  }

  const userPrompt = `${person1Context}

${person2Context}

${signalsContext}
${additionalContext}
Based on this information, determine if Record A and Record B represent the same person.`

  const body = {
    contents: [{ parts: [{ text: userPrompt }], role: 'user' }],
    systemInstruction: { parts: [{ text: MATCH_EVALUATION_PROMPT }] },
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 500,
      responseMimeType: 'application/json',
    }
  }

  if (opts.debug) {
    console.log('\n=== LLM PROMPT ===')
    console.log(MATCH_EVALUATION_PROMPT)
    console.log('\n=== USER MESSAGE ===')
    console.log(userPrompt)
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`

  const { data } = await request<GeminiResponse>({
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    body,
    timeoutMs: 60_000,
    retries: 2,
  })

  if (data.error) {
    throw new Error(`Gemini API error: ${data.error.message}`)
  }

  const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  const promptTokens = data.usageMetadata?.promptTokenCount || 0
  const outputTokens = data.usageMetadata?.candidatesTokenCount || 0

  if (opts.debug) {
    console.log('\n=== LLM RESPONSE ===')
    console.log(responseText)
  }

  // Parse JSON response
  try {
    const parsed = JSON.parse(responseText) as {
      same_person: boolean | 'uncertain'
      confidence: number
      reasoning: string
    }

    return {
      samePerson: parsed.same_person,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      promptTokens,
      outputTokens,
    }
  } catch (e) {
    // Try to extract JSON from response if it has extra text
    const jsonMatch = responseText.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as {
          same_person: boolean | 'uncertain'
          confidence: number
          reasoning: string
        }

        return {
          samePerson: parsed.same_person,
          confidence: parsed.confidence,
          reasoning: parsed.reasoning,
          promptTokens,
          outputTokens,
        }
      } catch {
        // Fall through to error
      }
    }

    console.error('Failed to parse LLM response:', responseText)
    return {
      samePerson: 'uncertain',
      confidence: 0,
      reasoning: `Failed to parse LLM response: ${responseText.slice(0, 100)}`,
      promptTokens,
      outputTokens,
    }
  }
}

/**
 * Batch evaluate candidates with LLM (with rate limiting)
 */
export async function batchEvaluateWithLLM(
  db: Database,
  candidates: MatchCandidate[],
  opts: {
    model?: string
    batchSize?: number
    delayMs?: number
    debug?: boolean
    onProgress?: (completed: number, total: number) => void
  } = {}
): Promise<Map<string, LLMMatchResult>> {
  const results = new Map<string, LLMMatchResult>()
  const batchSize = opts.batchSize || 5
  const delayMs = opts.delayMs || 1000

  let completed = 0

  for (let i = 0; i < candidates.length; i += batchSize) {
    const batch = candidates.slice(i, i + batchSize)

    // Process batch in parallel
    const batchPromises = batch.map(async (candidate) => {
      const key = `${candidate.person1.id}|${candidate.person2.id}`
      try {
        const result = await evaluateWithLLM(db, candidate, opts)
        return { key, result }
      } catch (e) {
        console.error(`Error evaluating ${key}: ${(e as Error).message}`)
        return {
          key,
          result: {
            samePerson: 'uncertain' as const,
            confidence: 0,
            reasoning: `Error: ${(e as Error).message}`,
            promptTokens: 0,
            outputTokens: 0,
          }
        }
      }
    })

    const batchResults = await Promise.all(batchPromises)

    for (const { key, result } of batchResults) {
      results.set(key, result)
      completed++
    }

    if (opts.onProgress) {
      opts.onProgress(completed, candidates.length)
    }

    // Rate limit between batches
    if (i + batchSize < candidates.length) {
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }

  return results
}
