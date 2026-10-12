#!/usr/bin/env bun

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'

export type MimeMessageOptions = {
  from?: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  textBody?: string
  htmlBody?: string
  inReplyTo?: string
  references?: string
  threadId?: string
  attachments?: string[]
}

/** RFC 2047 encode a header value if it contains non-ASCII characters */
function encodeRfc2047(value: string): string {
  // Only encode if non-ASCII characters are present
  if (/^[\x00-\x7F]*$/.test(value)) return value
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  return `=?UTF-8?B?${b64}?=`
}

function encodeBase64Url(data: string | Uint8Array): string {
  const b64 = typeof data === 'string' 
    ? Buffer.from(data, 'utf8').toString('base64')
    : Buffer.from(data).toString('base64')
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function encodeBase64Mime(data: string): string {
  const b64 = Buffer.from(data, 'utf8').toString('base64')
  // Split into 76-char lines per RFC 2045
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.substring(i, i + 76))
  }
  return lines.join('\r\n')
}

function getMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.txt': 'text/plain',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.csv': 'text/csv',
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Plain-text-only messages get hard-wrapped at ~72 chars by Gmail in transit
 * (the SENT copy stays intact, but the delivered copy gains mid-sentence line
 * breaks — verified 2026-07-14). HTML parts are never re-wrapped, so every
 * text body ships with a minimal HTML twin mirroring Gmail's own composer
 * markup (<div> per paragraph, <br> for single newlines).
 */
function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(p => `<div dir="ltr">${escapeHtml(p).replace(/\n/g, '<br>')}</div>`)
    .join('<div><br></div>')
}

export function composeMimeMessage(options: MimeMessageOptions): string {
  const { from, to, cc, bcc, subject, textBody, inReplyTo, references, attachments } = options
  const htmlBody = options.htmlBody || (textBody ? plainTextToHtml(textBody) : undefined)

  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).substring(7)}`
  const lines: string[] = []
  
  // Headers
  if (from) lines.push(`From: ${from}`)
  lines.push(`To: ${to.join(', ')}`)
  if (cc && cc.length > 0) lines.push(`Cc: ${cc.join(', ')}`)
  if (bcc && bcc.length > 0) lines.push(`Bcc: ${bcc.join(', ')}`)
  lines.push(`Subject: ${encodeRfc2047(subject)}`)
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`)
  if (references) lines.push(`References: ${references}`)
  lines.push('MIME-Version: 1.0')
  
  const hasAttachments = attachments && attachments.length > 0
  const hasMultipleBodies = textBody && htmlBody

  if (hasAttachments) {
    // Mixed envelope for attachments
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    lines.push('')
    lines.push(`--${boundary}`)
  }

  // Body
  if (hasMultipleBodies) {
    const altBoundary = `----=_Part_Alt_${Date.now()}`
    if (hasAttachments) {
      // Nested alternative inside mixed
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`)
      lines.push('')
    } else {
      // Alternative is the top-level type (no attachments)
      lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`)
      lines.push('')
    }

    // Plain text part (base64 to avoid QP line-length issues)
    lines.push(`--${altBoundary}`)
    lines.push('Content-Type: text/plain; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64')
    lines.push('')
    lines.push(encodeBase64Mime(textBody || ''))
    lines.push('')

    // HTML part (base64 to avoid QP line-length issues with long URLs)
    lines.push(`--${altBoundary}`)
    lines.push('Content-Type: text/html; charset="UTF-8"')
    lines.push('Content-Transfer-Encoding: base64')
    lines.push('')
    lines.push(encodeBase64Mime(htmlBody || ''))
    lines.push('')
    lines.push(`--${altBoundary}--`)

    if (hasAttachments) {
      lines.push('')
      lines.push(`--${boundary}`)
    }
  } else if (htmlBody) {
    if (hasAttachments) {
      lines.push('Content-Type: text/html; charset="UTF-8"')
      lines.push('Content-Transfer-Encoding: base64')
      lines.push('')
      lines.push(encodeBase64Mime(htmlBody))
      lines.push('')
      lines.push(`--${boundary}`)
    } else {
      lines.push('Content-Type: text/html; charset="UTF-8"')
      lines.push('Content-Transfer-Encoding: base64')
      lines.push('')
      lines.push(encodeBase64Mime(htmlBody))
    }
  } else {
    if (hasAttachments) {
      lines.push('Content-Type: text/plain; charset="UTF-8"')
      lines.push('Content-Transfer-Encoding: base64')
      lines.push('')
      lines.push(encodeBase64Mime(textBody || ''))
      lines.push('')
      lines.push(`--${boundary}`)
    } else {
      lines.push('Content-Type: text/plain; charset="UTF-8"')
      lines.push('Content-Transfer-Encoding: base64')
      lines.push('')
      lines.push(encodeBase64Mime(textBody || ''))
    }
  }
  
  // Attachments
  if (hasAttachments) {
    for (const filePath of attachments) {
      try {
        const fileName = basename(filePath)
        const mimeType = getMimeType(filePath)
        const fileData = readFileSync(filePath)
        const base64Data = Buffer.from(fileData).toString('base64')
        
        lines.push(`Content-Type: ${mimeType}; name="${fileName}"`)
        lines.push('Content-Transfer-Encoding: base64')
        lines.push(`Content-Disposition: attachment; filename="${fileName}"`)
        lines.push('')
        
        // Split base64 into 76-char lines per RFC 2045
        for (let i = 0; i < base64Data.length; i += 76) {
          lines.push(base64Data.substring(i, i + 76))
        }
        lines.push('')
        
        if (attachments.indexOf(filePath) < attachments.length - 1) {
          lines.push(`--${boundary}`)
        }
      } catch (err) {
        throw new Error(`Failed to read attachment ${filePath}: ${err}`)
      }
    }
    
    lines.push(`--${boundary}--`)
  }
  
  const mimeString = lines.join('\r\n')
  return encodeBase64Url(mimeString)
}

export function markdownToHtml(markdown: string): string {
  let html = markdown

  // Protect link destinations from the emphasis regexes below (URLs like
  // youtube.com/watch?v=9Nvvg0j9_8Q&...&v=..._ were being split by `_(.+?)_`
  // into broken <em> tags). Swap each [text](url) URL for a placeholder.
  const linkUrls: string[] = []
  html = html.replace(/\]\(([^)]+)\)/g, (_m, url) => {
    linkUrls.push(url)
    return `](\u0000LINK${linkUrls.length - 1}\u0000)`
  })

  // Horizontal rules: a line that is only *** / --- / ___
  html = html.replace(/^[ \t]*([*_-])(?:[ \t]*\1){2,}[ \t]*$/gm, '<hr>')

  // Headers
  html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>')
  html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>')
  html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>')
  
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>')
  
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>')
  html = html.replace(/_(.+?)_/g, '<em>$1</em>')
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  html = html.replace(/\u0000LINK(\d+)\u0000/g, (_m, i) => linkUrls[Number(i)])

  // Bullet lists: group consecutive "- " or "* " lines into <ul><li>...</li></ul>
  html = html.replace(/(?:^|\n)((?:[-*] .+(?:\n|$))+)/g, (_match, block) => {
    const items = block
      .trim()
      .split('\n')
      .map((line: string) => line.replace(/^[-*] /, '').trim())
      .filter((item: string) => item.length > 0)
      .map((item: string) => `<li>${item}</li>`)
      .join('')
    return `\n<ul>${items}</ul>\n`
  })

  // Numbered lists: group consecutive "N. " lines into <ol><li>...</li></ol>
  html = html.replace(/(?:^|\n)((?:\d+\. .+(?:\n|$))+)/g, (_match, block) => {
    const items = block
      .trim()
      .split('\n')
      .map((line: string) => line.replace(/^\d+\. /, '').trim())
      .filter((item: string) => item.length > 0)
      .map((item: string) => `<li>${item}</li>`)
      .join('')
    return `\n<ol>${items}</ol>\n`
  })

  // Line breaks
  html = html.replace(/\n\n/g, '</p><p>')
  html = html.replace(/\n/g, '<br>')

  // Wrap in paragraphs
  html = '<p>' + html + '</p>'

  // Clean up empty paragraphs and bogus <br> around lists
  html = html.replace(/<p><\/p>/g, '')
  html = html.replace(/<p>(<[uo]l>)/g, '$1')
  html = html.replace(/(<\/[uo]l>)<\/p>/g, '$1')
  html = html.replace(/<br>(<[uo]l>)/g, '$1')
  html = html.replace(/(<\/[uo]l>)<br>/g, '$1')
  html = html.replace(/<p>(<hr>)<\/p>/g, '$1')

  return html
}
