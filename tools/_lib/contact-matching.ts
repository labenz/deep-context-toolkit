// Contact Matching Library
// Heuristic matching algorithms for contact unification

import Database from 'bun:sqlite'

// ============================================================
// TYPES
// ============================================================

export interface PersonRecord {
  id: string
  display_name: string
  identifiers: string | null  // JSON array
  organization: string | null
  title: string | null
  thread_count: number
  message_count: number
  first_seen: string | null
  last_seen: string | null
}

export interface MatchSignal {
  type: 'email' | 'phone' | 'twitter' | 'name' | 'organization' | 'domain' | 'cross_channel'
  value1: string
  value2: string
  confidence: number
  description: string
}

export interface MatchCandidate {
  person1: PersonRecord
  person2: PersonRecord
  confidence: number
  signals: MatchSignal[]
  isAutomatedSender: boolean
}

// ============================================================
// NORMALIZATION FUNCTIONS
// ============================================================

/**
 * Normalize an email address for comparison
 */
export function normalizeEmail(email: string): string {
  return email.toLowerCase().trim()
}

/**
 * Normalize a phone number to digits only
 */
export function normalizePhone(phone: string): string {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, '')
  // Handle US numbers: if 11 digits starting with 1, remove the 1
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1)
  }
  return digits
}

/**
 * Extract and normalize phone number from Beeper sender ID
 * Handles formats like:
 * - "imessage:+15551234567"
 * - "whatsapp:15551234567"
 * - "@sms_15551234567:beeper.local"
 * - "+15551234567@s.whatsapp.net"
 * - "signal:+15551234567"
 */
export function normalizePhoneFromBeeperId(senderId: string): string | null {
  if (!senderId) return null

  // Pattern 1: protocol:+phone (imessage, signal, whatsapp, sms)
  const protocolMatch = senderId.match(/^(?:imessage|signal|whatsapp|sms|tel):\+?(\d{10,15})/)
  if (protocolMatch) {
    return normalizePhone(protocolMatch[1])
  }

  // Pattern 2: @sms_phone:beeper.local or similar matrix format
  const matrixSmsMatch = senderId.match(/@sms_\+?(\d{10,15}):/)
  if (matrixSmsMatch) {
    return normalizePhone(matrixSmsMatch[1])
  }

  // Pattern 3: phone@s.whatsapp.net
  const whatsappMatch = senderId.match(/^(\d{10,15})@s\.whatsapp\.net/)
  if (whatsappMatch) {
    return normalizePhone(whatsappMatch[1])
  }

  // Pattern 4: Generic phone extraction (if sender ID contains a 10+ digit number)
  const genericMatch = senderId.match(/\+?1?(\d{10})(?:\D|$)/)
  if (genericMatch) {
    return normalizePhone(genericMatch[1])
  }

  return null
}

/**
 * Normalize a name for comparison
 * - Lowercase
 * - Remove common prefixes (Dr., Prof., Mr., Mrs., etc.)
 * - Remove common suffixes (Jr., III, PhD, etc.)
 * - Handle "Last, First" format
 * - Collapse whitespace
 */
export function normalizeName(name: string): string {
  let normalized = name
    .toLowerCase()
    // Remove prefixes
    .replace(/^(dr\.?|prof\.?|professor|mr\.?|mrs\.?|ms\.?|miss|sir|dame)\s+/i, '')
    // Remove suffixes
    .replace(/,?\s*(jr\.?|sr\.?|iii?|iv|v|ph\.?d\.?|phd|m\.?d\.?|md|esq\.?|mba|cpa|jd|dds|dvm)$/i, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim()

  // Handle "Last, First" format (convert to "First Last")
  if (normalized.includes(',')) {
    const parts = normalized.split(',').map(p => p.trim())
    if (parts.length === 2 && parts[0].length > 0 && parts[1].length > 0) {
      normalized = `${parts[1]} ${parts[0]}`
    }
  }

  return normalized
}

/**
 * Soundex phonetic encoding for name matching
 * Standard American Soundex algorithm
 */
export function soundex(name: string): string {
  const s = name.toUpperCase()
  if (!s) return ''

  // Keep the first letter
  let result = s[0]

  // Map of letter -> code
  const codes: Record<string, string> = {
    B: '1', F: '1', P: '1', V: '1',
    C: '2', G: '2', J: '2', K: '2', Q: '2', S: '2', X: '2', Z: '2',
    D: '3', T: '3',
    L: '4',
    M: '5', N: '5',
    R: '6'
  }

  let prevCode = codes[s[0]] || ''

  for (let i = 1; i < s.length && result.length < 4; i++) {
    const char = s[i]
    const code = codes[char]

    if (code && code !== prevCode) {
      result += code
      prevCode = code
    } else if (!code) {
      // Reset prev code for vowels/H/W (allow double letters separated by these)
      if ('AEIOUYHW'.includes(char)) {
        prevCode = ''
      }
    }
  }

  // Pad with zeros to ensure length of 4
  return (result + '000').slice(0, 4)
}

/**
 * Token-based name matching
 * Returns similarity score for partial name matches
 * Handles cases like "J. Smith" matching "John Smith"
 */
export function tokenBasedNameMatch(name1: string, name2: string): number {
  const tokens1 = normalizeName(name1).split(' ').filter(t => t.length > 0)
  const tokens2 = normalizeName(name2).split(' ').filter(t => t.length > 0)

  if (tokens1.length === 0 || tokens2.length === 0) return 0

  // Check for initials matching full names
  const matchScore = (shorter: string[], longer: string[]): number => {
    let matches = 0
    let initialMatches = 0

    for (const shortTok of shorter) {
      for (const longTok of longer) {
        // Exact match
        if (shortTok === longTok) {
          matches++
          break
        }
        // Initial match (e.g., "j" or "j." matching "john")
        if (shortTok.length <= 2 && (shortTok[0] === longTok[0])) {
          initialMatches++
          break
        }
        // Nickname match
        if (areNamesRelated(shortTok, longTok)) {
          matches++
          break
        }
        // Soundex match (phonetic similarity)
        if (shortTok.length > 2 && longTok.length > 2 && soundex(shortTok) === soundex(longTok)) {
          matches += 0.7  // Partial credit for phonetic match
          break
        }
      }
    }

    const totalTokens = Math.max(shorter.length, longer.length)
    return (matches + initialMatches * 0.5) / totalTokens
  }

  // Try both directions and take the better score
  const score1 = matchScore(tokens1, tokens2)
  const score2 = matchScore(tokens2, tokens1)

  return Math.max(score1, score2)
}

/**
 * Extract first name from full name
 */
export function extractFirstName(name: string): string {
  return normalizeName(name).split(' ')[0]
}

/**
 * Extract last name from full name
 */
export function extractLastName(name: string): string {
  const parts = normalizeName(name).split(' ')
  return parts[parts.length - 1]
}

/**
 * Get the domain from an email address
 */
export function extractDomain(email: string): string | null {
  const match = email.match(/@([^@]+)$/)
  return match ? match[1].toLowerCase() : null
}

/**
 * Parse identifiers JSON into structured data
 */
export function parseIdentifiers(identifiersJson: string | null): {
  emails: string[]
  phones: string[]
  twitterIds: string[]
  other: string[]
} {
  const result = { emails: [], phones: [], twitterIds: [], other: [] } as {
    emails: string[]
    phones: string[]
    twitterIds: string[]
    other: string[]
  }

  if (!identifiersJson) return result

  try {
    const identifiers = JSON.parse(identifiersJson) as string[]
    for (const id of identifiers) {
      if (!id) continue
      const lower = id.toLowerCase()

      // Email pattern
      if (id.includes('@') && !id.startsWith('@')) {
        result.emails.push(normalizeEmail(id))
      }
      // Twitter handle or ID
      else if (id.startsWith('@') || /^\d{5,}$/.test(id)) {
        result.twitterIds.push(lower.replace(/^@/, ''))
      }
      // Phone pattern (has digits and common phone chars)
      else if (/^\+?[\d\s\-\(\)\.]+$/.test(id) && /\d{7,}/.test(id.replace(/\D/g, ''))) {
        result.phones.push(normalizePhone(id))
      }
      else {
        result.other.push(id)
      }
    }
  } catch {
    // Invalid JSON, return empty
  }

  return result
}

// ============================================================
// SHARED/DISTRIBUTION EMAIL DETECTION
// ============================================================

const SHARED_EMAIL_PATTERNS = [
  /^forddirect@/i,
  /^team@/i,
  /^info@/i,
  /^contact@/i,
  /^support@/i,
  /^hello@/i,
  /^sales@/i,
  /^admin@/i,
  /^help@/i,
  /^billing@/i,
  /^feedback@/i,
  /^press@/i,
  /^media@/i,
  /^partners?@/i,
  /^investors?@/i,
  /^jobs@/i,
  /^careers@/i,
  /^hr@/i,
  /^office@/i,
  /^general@/i,
  /-noreply@/i,
  /noreply-/i,
]

/**
 * Check if an email address is likely a shared/distribution address
 * (used by multiple people, not suitable for identity matching)
 */
export function isSharedEmail(email: string): boolean {
  for (const pattern of SHARED_EMAIL_PATTERNS) {
    if (pattern.test(email)) return true
  }
  return false
}

// ============================================================
// AUTOMATED SENDER DETECTION
// ============================================================

const AUTOMATED_EMAIL_PATTERNS = [
  /^noreply@/i,
  /^no-reply@/i,
  /^donotreply@/i,
  /^do-not-reply@/i,
  /^notifications?@/i,
  /^alerts?@/i,
  /^mailer@/i,
  /^bounce@/i,
  /^postmaster@/i,
  /^support@/i,
  /^team@/i,
  /^info@/i,
  /^hello@/i,
  /^contact@/i,
  /^newsletter@/i,
  /^marketing@/i,
  /^updates?@/i,
]

const AUTOMATED_DOMAIN_PATTERNS = [
  /amazon\.com$/i,
  /notifications\./i,
  /^mail\./i,
  /^email\./i,
  /marketing\./i,
  /newsletter\./i,
]

/**
 * Check if a person record appears to be an automated sender
 */
export function isAutomatedSender(person: PersonRecord): boolean {
  const ids = parseIdentifiers(person.identifiers)

  for (const email of ids.emails) {
    // Check email prefix patterns
    for (const pattern of AUTOMATED_EMAIL_PATTERNS) {
      if (pattern.test(email)) return true
    }

    // Check domain patterns
    const domain = extractDomain(email)
    if (domain) {
      for (const pattern of AUTOMATED_DOMAIN_PATTERNS) {
        if (pattern.test(domain)) return true
      }
    }
  }

  // Check name patterns
  const nameLower = person.display_name.toLowerCase()
  if (
    nameLower.includes('noreply') ||
    nameLower.includes('newsletter') ||
    nameLower.includes('notifications') ||
    nameLower.includes('automated') ||
    nameLower.includes('mailer-daemon')
  ) {
    return true
  }

  return false
}

// ============================================================
// MATCHING FUNCTIONS
// ============================================================

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = []

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i]
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }

  return matrix[b.length][a.length]
}

/**
 * Calculate string similarity (0-1)
 */
export function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0
  if (!a || !b) return 0.0

  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1.0

  const distance = levenshtein(a, b)
  return 1 - (distance / maxLen)
}

/**
 * Common nickname mappings
 */
const NICKNAME_MAP: Record<string, string[]> = {
  william: ['will', 'bill', 'billy', 'willy', 'liam'],
  robert: ['rob', 'bob', 'bobby', 'robbie'],
  richard: ['rich', 'rick', 'dick', 'ricky'],
  michael: ['mike', 'mikey', 'mick'],
  james: ['jim', 'jimmy', 'jamie'],
  john: ['johnny', 'jack', 'jon'],
  joseph: ['joe', 'joey'],
  thomas: ['tom', 'tommy'],
  christopher: ['chris', 'kit'],
  daniel: ['dan', 'danny'],
  matthew: ['matt', 'matty'],
  david: ['dave', 'davey'],
  andrew: ['andy', 'drew'],
  steven: ['steve', 'stevie'],
  stephen: ['steve', 'stevie'],
  edward: ['ed', 'eddie', 'ted', 'teddy'],
  jonathan: ['jon', 'johnny'],
  benjamin: ['ben', 'benny'],
  nicholas: ['nick', 'nicky'],
  alexander: ['alex', 'xander'],
  elizabeth: ['liz', 'lizzy', 'beth', 'betty', 'eliza'],
  katherine: ['kate', 'katie', 'kathy', 'kat'],
  catherine: ['kate', 'katie', 'cathy', 'cat'],
  margaret: ['maggie', 'meg', 'peggy', 'marge'],
  jennifer: ['jen', 'jenny'],
  jessica: ['jess', 'jessie'],
  patricia: ['pat', 'patty', 'trish'],
  rebecca: ['becca', 'becky'],
  samantha: ['sam', 'sammy'],
  alexandra: ['alex', 'alexis', 'lexi'],
  anthony: ['tony'],
  timothy: ['tim', 'timmy'],
  gregory: ['greg'],
  phillip: ['phil'],
  raymond: ['ray'],
  ronald: ['ron', 'ronnie'],
  nathaniel: ['nathan', 'nate'],
  nathan: ['nate', 'nathaniel'],
}

/**
 * Check if two first names might be the same (considering nicknames)
 */
export function areNamesRelated(name1: string, name2: string): boolean {
  const n1 = name1.toLowerCase()
  const n2 = name2.toLowerCase()

  if (n1 === n2) return true

  // Check nickname mappings
  for (const [full, nicks] of Object.entries(NICKNAME_MAP)) {
    const allVariants = [full, ...nicks]
    if (allVariants.includes(n1) && allVariants.includes(n2)) {
      return true
    }
  }

  return false
}

/**
 * Compare two person records and return match signals
 */
export function comparePersons(p1: PersonRecord, p2: PersonRecord): MatchSignal[] {
  const signals: MatchSignal[] = []

  const ids1 = parseIdentifiers(p1.identifiers)
  const ids2 = parseIdentifiers(p2.identifiers)

  // Check exact email matches (highest confidence)
  // Skip shared/distribution emails that multiple people use
  for (const email1 of ids1.emails) {
    if (isSharedEmail(email1)) continue  // Skip shared emails
    for (const email2 of ids2.emails) {
      if (isSharedEmail(email2)) continue  // Skip shared emails
      if (email1 === email2) {
        signals.push({
          type: 'email',
          value1: email1,
          value2: email2,
          confidence: 0.95,
          description: `Exact email match: ${email1}`
        })
      }
    }
  }

  // Check exact phone matches
  for (const phone1 of ids1.phones) {
    for (const phone2 of ids2.phones) {
      if (phone1 === phone2 && phone1.length >= 7) {
        signals.push({
          type: 'phone',
          value1: phone1,
          value2: phone2,
          confidence: 0.90,
          description: `Exact phone match: ${phone1}`
        })
      }
    }
  }

  // Check Twitter ID matches
  for (const tw1 of ids1.twitterIds) {
    for (const tw2 of ids2.twitterIds) {
      if (tw1 === tw2) {
        signals.push({
          type: 'twitter',
          value1: tw1,
          value2: tw2,
          confidence: 0.85,
          description: `Twitter ID match: ${tw1}`
        })
      }
    }
  }

  // Check email domain + exact name match
  const domains1 = new Set(ids1.emails.map(e => extractDomain(e)).filter(Boolean))
  const domains2 = new Set(ids2.emails.map(e => extractDomain(e)).filter(Boolean))
  const sharedDomains = [...domains1].filter(d => domains2.has(d))

  if (sharedDomains.length > 0) {
    const name1Norm = normalizeName(p1.display_name)
    const name2Norm = normalizeName(p2.display_name)

    if (name1Norm === name2Norm) {
      signals.push({
        type: 'domain',
        value1: `${p1.display_name} @ ${sharedDomains[0]}`,
        value2: `${p2.display_name} @ ${sharedDomains[0]}`,
        confidence: 0.80,
        description: `Same name "${p1.display_name}" at same domain ${sharedDomains[0]}`
      })
    }
  }

  // Check name similarity with same domain
  if (sharedDomains.length > 0) {
    const first1 = extractFirstName(p1.display_name)
    const first2 = extractFirstName(p2.display_name)
    const last1 = extractLastName(p1.display_name)
    const last2 = extractLastName(p2.display_name)

    // Same last name + related first names at same domain
    if (last1 === last2 && last1.length >= 2 && areNamesRelated(first1, first2)) {
      signals.push({
        type: 'name',
        value1: p1.display_name,
        value2: p2.display_name,
        confidence: 0.75,
        description: `Related names at same domain: ${first1}/${first2} ${last1}`
      })
    }
  }

  // Check organization match with similar names
  if (p1.organization && p2.organization) {
    const org1 = p1.organization.toLowerCase()
    const org2 = p2.organization.toLowerCase()

    if (org1 === org2 || stringSimilarity(org1, org2) > 0.85) {
      const nameSim = stringSimilarity(
        normalizeName(p1.display_name),
        normalizeName(p2.display_name)
      )

      if (nameSim > 0.7) {
        signals.push({
          type: 'organization',
          value1: `${p1.display_name} @ ${p1.organization}`,
          value2: `${p2.display_name} @ ${p2.organization}`,
          confidence: nameSim * 0.6,
          description: `Similar names at same org: ${p1.organization}`
        })
      }
    }
  }

  // Check strong name similarity alone (for unlinked records)
  const name1 = normalizeName(p1.display_name)
  const name2 = normalizeName(p2.display_name)
  const nameSim = stringSimilarity(name1, name2)

  if (nameSim >= 0.85 && name1.length >= 5) {
    // Only add if we don't already have a higher confidence signal
    if (!signals.some(s => s.confidence >= 0.50)) {
      signals.push({
        type: 'name',
        value1: p1.display_name,
        value2: p2.display_name,
        confidence: nameSim * 0.5,
        description: `Name similarity ${Math.round(nameSim * 100)}%: "${p1.display_name}" ↔ "${p2.display_name}"`
      })
    }
  }

  // Check token-based name matching (handles partial names, initials)
  // Only add if we don't have a strong signal already
  if (!signals.some(s => s.confidence >= 0.50) && name1.length >= 3 && name2.length >= 3) {
    const tokenScore = tokenBasedNameMatch(p1.display_name, p2.display_name)
    if (tokenScore >= 0.7) {
      signals.push({
        type: 'name',
        value1: p1.display_name,
        value2: p2.display_name,
        confidence: tokenScore * 0.45,
        description: `Token-based name match ${Math.round(tokenScore * 100)}%: "${p1.display_name}" ↔ "${p2.display_name}"`
      })
    }
  }

  // Check Soundex phonetic matching for similar-sounding names
  // Only for single-word names or last names that don't match exactly
  if (!signals.some(s => s.confidence >= 0.40)) {
    const last1 = extractLastName(p1.display_name)
    const last2 = extractLastName(p2.display_name)
    if (last1.length >= 3 && last2.length >= 3 && last1 !== last2) {
      const soundex1 = soundex(last1)
      const soundex2 = soundex(last2)
      if (soundex1 === soundex2) {
        const first1 = extractFirstName(p1.display_name)
        const first2 = extractFirstName(p2.display_name)
        // Also check first names are similar
        if (areNamesRelated(first1, first2) || soundex(first1) === soundex(first2)) {
          signals.push({
            type: 'name',
            value1: p1.display_name,
            value2: p2.display_name,
            confidence: 0.35,
            description: `Phonetic name match (Soundex): "${p1.display_name}" sounds like "${p2.display_name}"`
          })
        }
      }
    }
  }

  return signals
}

/**
 * Calculate overall confidence from signals
 */
export function calculateConfidence(signals: MatchSignal[]): number {
  if (signals.length === 0) return 0

  // Use a combined approach: max signal + small boost from additional signals
  const sorted = signals.sort((a, b) => b.confidence - a.confidence)
  let confidence = sorted[0].confidence

  // Add diminishing returns from additional signals
  for (let i = 1; i < sorted.length && i < 3; i++) {
    const boost = sorted[i].confidence * 0.1 * (1 - confidence)
    confidence += boost
  }

  return Math.min(confidence, 0.99)
}

// ============================================================
// BATCH MATCHING
// ============================================================

/**
 * Find all potential match candidates above a minimum confidence threshold
 */
export function findMatchCandidates(
  db: Database,
  opts: {
    minConfidence?: number
    limit?: number
    excludeAutoSenders?: boolean
    highInteractionOnly?: boolean  // Only people with 5+ threads
  } = {}
): MatchCandidate[] {
  const minConf = opts.minConfidence ?? 0.40
  const limit = opts.limit ?? 10000
  const excludeAuto = opts.excludeAutoSenders ?? true
  const highInteraction = opts.highInteractionOnly ?? false

  // Get all people records
  let query = `SELECT id, display_name, identifiers, organization, title,
                      thread_count, message_count, first_seen, last_seen
               FROM people
               WHERE 1=1`

  if (highInteraction) {
    query += ` AND thread_count >= 5`
  }

  query += ` ORDER BY thread_count DESC`

  const people = db.query(query).all() as PersonRecord[]
  console.log(`Comparing ${people.length} people records...`)

  // Get already linked person IDs
  const linkedIds = new Set(
    (db.query(`SELECT person_id FROM contact_links`).all() as { person_id: string }[])
      .map(r => r.person_id)
  )

  // Get rejected pairs
  const rejectedPairs = new Set(
    (db.query(`SELECT person_id_1, person_id_2 FROM contact_rejections`).all() as { person_id_1: string; person_id_2: string }[])
      .flatMap(r => [`${r.person_id_1}|${r.person_id_2}`, `${r.person_id_2}|${r.person_id_1}`])
  )

  // Get existing pending suggestions
  const existingSuggestions = new Set(
    (db.query(`SELECT person_id_1, person_id_2 FROM contact_suggestions`).all() as { person_id_1: string; person_id_2: string }[])
      .flatMap(r => [`${r.person_id_1}|${r.person_id_2}`, `${r.person_id_2}|${r.person_id_1}`])
  )

  const candidates: MatchCandidate[] = []

  // Build email index for fast lookups
  const emailIndex = new Map<string, PersonRecord[]>()
  const phoneIndex = new Map<string, PersonRecord[]>()

  for (const person of people) {
    // Skip already-linked records
    if (linkedIds.has(person.id)) continue

    const ids = parseIdentifiers(person.identifiers)

    for (const email of ids.emails) {
      const existing = emailIndex.get(email) || []
      existing.push(person)
      emailIndex.set(email, existing)
    }

    for (const phone of ids.phones) {
      const existing = phoneIndex.get(phone) || []
      existing.push(person)
      phoneIndex.set(phone, existing)
    }
  }

  // Find duplicates via email index (most reliable)
  const seenPairs = new Set<string>()

  for (const [email, persons] of emailIndex) {
    if (persons.length < 2) continue

    for (let i = 0; i < persons.length; i++) {
      for (let j = i + 1; j < persons.length; j++) {
        const p1 = persons[i]
        const p2 = persons[j]

        // Sort IDs for consistent pair key
        const [id1, id2] = [p1.id, p2.id].sort()
        const pairKey = `${id1}|${id2}`

        if (seenPairs.has(pairKey)) continue
        if (rejectedPairs.has(pairKey)) continue
        if (existingSuggestions.has(pairKey)) continue

        seenPairs.add(pairKey)

        const signals = comparePersons(p1, p2)
        const confidence = calculateConfidence(signals)

        if (confidence >= minConf) {
          const isAuto = isAutomatedSender(p1) || isAutomatedSender(p2)
          if (excludeAuto && isAuto && confidence < 0.99) continue

          candidates.push({
            person1: p1,
            person2: p2,
            confidence,
            signals,
            isAutomatedSender: isAuto
          })
        }
      }
    }
  }

  // Also check phone index
  for (const [phone, persons] of phoneIndex) {
    if (persons.length < 2) continue

    for (let i = 0; i < persons.length; i++) {
      for (let j = i + 1; j < persons.length; j++) {
        const p1 = persons[i]
        const p2 = persons[j]

        const [id1, id2] = [p1.id, p2.id].sort()
        const pairKey = `${id1}|${id2}`

        if (seenPairs.has(pairKey)) continue
        if (rejectedPairs.has(pairKey)) continue
        if (existingSuggestions.has(pairKey)) continue

        seenPairs.add(pairKey)

        const signals = comparePersons(p1, p2)
        const confidence = calculateConfidence(signals)

        if (confidence >= minConf) {
          const isAuto = isAutomatedSender(p1) || isAutomatedSender(p2)
          if (excludeAuto && isAuto && confidence < 0.99) continue

          candidates.push({
            person1: p1,
            person2: p2,
            confidence,
            signals,
            isAutomatedSender: isAuto
          })
        }
      }
    }
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence)

  return candidates.slice(0, limit)
}

/**
 * Group candidates by target unified contact
 * (finds transitive matches: if A matches B and B matches C, group all together)
 */
export function groupCandidates(candidates: MatchCandidate[]): Map<string, Set<string>> {
  const groups = new Map<string, Set<string>>()
  const personToGroup = new Map<string, string>()

  for (const candidate of candidates) {
    const id1 = candidate.person1.id
    const id2 = candidate.person2.id

    const group1 = personToGroup.get(id1)
    const group2 = personToGroup.get(id2)

    if (!group1 && !group2) {
      // Neither in a group, create new group
      const newGroup = new Set([id1, id2])
      groups.set(id1, newGroup)
      personToGroup.set(id1, id1)
      personToGroup.set(id2, id1)
    } else if (group1 && !group2) {
      // Add id2 to id1's group
      groups.get(group1)!.add(id2)
      personToGroup.set(id2, group1)
    } else if (!group1 && group2) {
      // Add id1 to id2's group
      groups.get(group2)!.add(id1)
      personToGroup.set(id1, group2)
    } else if (group1 !== group2) {
      // Merge groups
      const targetGroup = groups.get(group1)!
      const sourceGroup = groups.get(group2)!

      for (const id of sourceGroup) {
        targetGroup.add(id)
        personToGroup.set(id, group1)
      }

      groups.delete(group2)
    }
    // else: both already in same group, nothing to do
  }

  return groups
}

// ============================================================
// CROSS-CHANNEL MATCHING
// ============================================================

/**
 * Extract the source channel from a person ID
 * Returns source like 'gmail', 'slack', 'beeper', 'twitter', 'calls', 'podcast'
 */
export function getSourceFromPersonId(personId: string): string | null {
  // Pattern: source-specific IDs
  if (personId.startsWith('gmail-')) return 'gmail'
  if (personId.startsWith('slack-')) return 'slack'
  if (personId.startsWith('beeper-')) return 'beeper'
  if (personId.startsWith('twitter-user-')) return 'twitter'
  if (personId.startsWith('twitter-dm:')) return 'twitter'
  if (personId.startsWith('calls-')) return 'calls'
  if (personId.startsWith('podcast-')) return 'podcast'

  // Legacy patterns: name-based IDs may come from any source
  // These need database lookup to determine source
  return null
}

/**
 * Get all sources a person appears in (requires database)
 */
export function getSourcesForPerson(db: Database, personId: string): string[] {
  // Check messages table for this sender
  const messageSources = db.query(`
    SELECT DISTINCT source FROM messages WHERE sender_id = ?
  `).all(personId) as Array<{ source: string }>

  // Check threads table for participation
  const threadSources = db.query(`
    SELECT DISTINCT source FROM threads
    WHERE participant_ids LIKE ? OR participant_ids LIKE ?
  `).all(`%"${personId}"%`, `%${personId}%`) as Array<{ source: string }>

  const sources = new Set<string>()
  for (const { source } of messageSources) sources.add(source)
  for (const { source } of threadSources) sources.add(source)

  // Also infer from person ID prefix
  const idSource = getSourceFromPersonId(personId)
  if (idSource) sources.add(idSource)

  return [...sources]
}

/**
 * Check for cross-channel corroboration
 * Boosts confidence when similar names appear across different sources with no overlap
 */
export function findCrossChannelCorroboration(
  db: Database,
  p1: PersonRecord,
  p2: PersonRecord
): MatchSignal | null {
  const sources1 = getSourcesForPerson(db, p1.id)
  const sources2 = getSourcesForPerson(db, p2.id)

  // Check for source overlap
  const sourceOverlap = sources1.filter(s => sources2.includes(s))

  // If there IS overlap, this isn't cross-channel corroboration
  if (sourceOverlap.length > 0) return null

  // Calculate name similarity
  const name1 = normalizeName(p1.display_name)
  const name2 = normalizeName(p2.display_name)

  // Need reasonably similar names
  const nameSim = stringSimilarity(name1, name2)
  const tokenSim = tokenBasedNameMatch(p1.display_name, p2.display_name)
  const bestSim = Math.max(nameSim, tokenSim)

  if (bestSim < 0.75) return null

  // Both must have at least one source
  if (sources1.length === 0 || sources2.length === 0) return null

  // Cross-channel match found!
  const confidence = Math.min(0.70, bestSim * 0.75)  // Cap at 0.70, scale by name similarity

  return {
    type: 'cross_channel',
    value1: `${p1.display_name} (${sources1.join(', ')})`,
    value2: `${p2.display_name} (${sources2.join(', ')})`,
    confidence,
    description: `Cross-channel match: "${p1.display_name}" in ${sources1.join('/')} ↔ "${p2.display_name}" in ${sources2.join('/')}`
  }
}

/**
 * Extended version of comparePersons that includes cross-channel corroboration
 * Requires database access for source lookup
 */
export function comparePersonsWithCrossChannel(
  db: Database,
  p1: PersonRecord,
  p2: PersonRecord
): MatchSignal[] {
  // Start with standard comparison
  const signals = comparePersons(p1, p2)

  // Add cross-channel corroboration if applicable
  // Only check if we don't already have strong signals
  if (!signals.some(s => s.confidence >= 0.70)) {
    const crossChannelSignal = findCrossChannelCorroboration(db, p1, p2)
    if (crossChannelSignal) {
      signals.push(crossChannelSignal)
    }
  }

  return signals
}
