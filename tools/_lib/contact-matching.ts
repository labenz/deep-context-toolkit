// Phone-number normalization for Beeper sender IDs.
// (The contact-unification matcher that used to live here was removed in the 2026-10
// simplification along with the `contacts` subcommand.)

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
