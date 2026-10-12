// Synthetic Google Takeout fixtures for import-takeout tests. Everyone here is fictional and all
// addresses use reserved example domains (RFC 2606).
//
//   bun tools/tests/takeout-fixtures.ts <out-dir> [--bulk-mb N]
// writes <out-dir>/Takeout/Mail/All mail Including Spam and Trash.mbox and
// <out-dir>/Takeout/Calendar/riley@example.com.ics (and, with --bulk-mb, a large mbox for perf).

import { mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'fs'
import { join } from 'path'

export const OWNER = 'riley@example.com'
export const OWNER_ALIAS = 'riley.quinn@example.net'

const BASE_MSG = 1781234567890000000n
const BASE_THR = 1781234567800000000n

export function msgDec(n: number): string { return (BASE_MSG + BigInt(n)).toString() }
export function thrDec(n: number): string { return (BASE_THR + BigInt(n)).toString() }
export function msgHex(n: number): string { return (BASE_MSG + BigInt(n)).toString(16) }
export function thrHex(n: number): string { return (BASE_THR + BigInt(n)).toString(16) }

function rfc2822(d: Date): string {
  return d.toUTCString().replace('GMT', '+0000')
}

function fromLine(id: string, d: Date): string {
  // Takeout style: "From 1781234567890000001@xxx Mon Oct 05 14:03:11 +0000 2026"
  const wd = d.toUTCString().slice(0, 3)
  const mon = d.toUTCString().slice(8, 11)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `From ${id}@xxx ${wd} ${mon} ${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000 ${d.getUTCFullYear()}`
}

interface Msg {
  n: number // message number (id)
  thread: number
  date: Date
  from: string
  to: string
  cc?: string
  subject: string
  labels: string
  messageId?: string | null // null = omit header
  inReplyTo?: string
  references?: string
  body: string // full MIME body incl. Content-Type headers (see helpers)
  fromLineId?: string // override (non-Gmail mbox)
  noThrid?: boolean
}

function plain(text: string): string {
  return `Content-Type: text/plain; charset="UTF-8"\nContent-Transfer-Encoding: 7bit\n\n${text}`
}

function assemble(m: Msg): string {
  const h: string[] = []
  h.push(fromLine(m.fromLineId ?? msgDec(m.n), m.date))
  if (!m.noThrid) h.push(`X-GM-THRID: ${thrDec(m.thread)}`)
  h.push(`X-Gmail-Labels: ${m.labels}`)
  h.push(`Date: ${rfc2822(m.date)}`)
  h.push(`From: ${m.from}`)
  h.push(`To: ${m.to}`)
  if (m.cc) h.push(`Cc: ${m.cc}`)
  h.push(`Subject: ${m.subject}`)
  if (m.messageId !== null) h.push(`Message-ID: ${m.messageId ?? `<m${m.n}@mail.example.com>`}`)
  if (m.inReplyTo) h.push(`In-Reply-To: ${m.inReplyTo}`)
  if (m.references) h.push(`References: ${m.references}`)
  h.push('MIME-Version: 1.0')
  return h.join('\n') + '\n' + m.body + '\n\n'
}

export interface FixtureInfo {
  mboxPath: string
  icsPath: string
  expected: {
    ownerThreads: number[]
    inboundThreads: number[]
    notImportedThreads: number[]
    recentThreads: number[] // last activity within 30 days of `now`
    importedMessages: number[]
  }
}

export function buildMessages(now: Date): Msg[] {
  const daysAgo = (d: number, h = 0) => new Date(now.getTime() - d * 86400000 - h * 3600000)
  const morgan = 'Morgan Avery <morgan@example.org>'
  const dana = '"Dana Okafor-Lind" <dana@example.org>'
  const riley = 'Riley Quinn <riley@example.com>'
  const sam = 'Sam <sam@acme.example>'
  const msgs: Msg[] = []

  // Thread 1 — Morgan writes, Riley replies (with quoted text to strip). Dana cc'd → known contact.
  msgs.push({
    n: 1, thread: 1, date: daysAgo(5, 3), from: morgan, to: riley, cc: dana,
    subject: 'Lunch next week?', labels: 'Inbox,Category Personal,Opened',
    body: [
      'Content-Type: multipart/alternative; boundary="b1"', '', '--b1',
      'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable', '',
      'Hi Riley =E2=80=94 are you free for lunch next Tuesday? The new place on Elm=',
      ' Street looks good.', '', '--b1',
      'Content-Type: text/html; charset="UTF-8"', '', '<p>Hi Riley — are you free for lunch?</p>', '--b1--',
    ].join('\n'),
  })
  msgs.push({
    n: 2, thread: 1, date: daysAgo(5, 1), from: riley, to: morgan, cc: dana,
    subject: 'Re: Lunch next week?', labels: 'Sent', inReplyTo: '<m1@mail.example.com>', references: '<m1@mail.example.com>',
    body: plain([
      'Tuesday works. Let us say noon at the Elm Street place.',
      '',
      'On Mon, Oct 5, 2026 at 9:00 AM Morgan Avery <morgan@example.org> wrote:',
      '> Hi Riley, are you free for lunch next Tuesday?',
    ].join('\n')),
  })
  // A trashed message in thread 1 — must be dropped.
  msgs.push({
    n: 3, thread: 1, date: daysAgo(4), from: morgan, to: riley, subject: 'Re: Lunch next week?',
    labels: 'Trash,Opened', body: plain('This message was deleted.'),
  })

  // Thread 2 — Dana (known contact via thread 1 cc) writes; Riley never replies → inbound import.
  msgs.push({
    n: 4, thread: 2, date: daysAgo(3), from: dana, to: riley, subject: '=?UTF-8?B?Q2Fmw6kgcGxhbnMg4piV?=',
    labels: 'Inbox,Important,Category Personal',
    body: [
      'Content-Type: multipart/mixed; boundary="outer"', '', '--outer',
      'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      Buffer.from('Café on Thursday? I attached the menu. Señor Pepe recommends the soup.\n').toString('base64'),
      '--outer',
      'Content-Type: application/pdf; name="menu.pdf"', 'Content-Disposition: attachment; filename="menu.pdf"',
      'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64'),
      '--outer--',
    ].join('\n'),
  })

  // Thread 3 — stranger writes, no reply → NOT imported.
  msgs.push({
    n: 5, thread: 3, date: daysAgo(2), from: 'Pat Stranger <pat@unknown.example>', to: riley,
    subject: 'Quick question', labels: 'Inbox', body: plain('Do you have a minute to chat about synergies?'),
  })

  // Thread 4 — promotion from a store → NOT imported.
  msgs.push({
    n: 6, thread: 4, date: daysAgo(1), from: 'Shop <news@shop.example>', to: riley,
    subject: '50% off everything', labels: 'Category Promotions,Inbox', body: plain('Sale sale sale'),
  })

  // Thread 5 — spam from a known contact's address → dropped at scan.
  msgs.push({
    n: 7, thread: 5, date: daysAgo(1), from: morgan, to: riley,
    subject: 'You won', labels: 'Spam', body: plain('Click here'),
  })

  // Thread 6 — Riley sent via an API (no Message-ID) → authorship candidate. Body has an escaped >From line.
  msgs.push({
    n: 8, thread: 6, date: daysAgo(2, 5), from: riley, to: sam,
    subject: 'Project kickoff notes', labels: 'Sent', messageId: null,
    body: plain('Notes from the kickoff:\n\n>From the start we agreed on weekly check-ins.\n- Riley'),
  })
  // Sam answers with HTML only.
  msgs.push({
    n: 9, thread: 6, date: daysAgo(1, 2), from: sam, to: riley,
    subject: 'Re: Project kickoff notes', labels: 'Inbox,Category Updates', inReplyTo: '<m8-missing@mail.example.com>',
    body: 'Content-Type: text/html; charset="UTF-8"\n\n<html><body><p>Thanks!</p><p>Weekly works for me.</p></body></html>',
  })
  // Sam's HTML-only follow-up, not bulk
  msgs.push({
    n: 10, thread: 6, date: daysAgo(1, 1), from: sam, to: riley,
    subject: 'Re: Project kickoff notes', labels: 'Inbox',
    body: 'Content-Type: text/html; charset="UTF-8"\n\n<html><body><p>Agenda attached next week.</p></body></html>',
  })

  // Draft and chat → dropped.
  msgs.push({ n: 11, thread: 7, date: daysAgo(1), from: riley, to: morgan, subject: 'draft', labels: 'Drafts', body: plain('unfinished') })
  msgs.push({ n: 12, thread: 8, date: daysAgo(1), from: riley, to: morgan, subject: 'chat', labels: 'Chat', body: plain('hey') })

  // Thread 9 — an old (2019) thread Riley wrote in → only with full history (not --since).
  const old = new Date(Date.UTC(2019, 4, 14, 15, 30, 0))
  msgs.push({
    n: 13, thread: 9, date: old, from: `Riley Quinn <${OWNER_ALIAS}>`, to: morgan,
    subject: 'Old times', labels: 'Sent,Archived', body: plain('Remember the 2019 offsite in the mountains?'),
  })

  // Thread 10 — non-Gmail style message: non-numeric From_ id and no X-GM-THRID (threads by References).
  msgs.push({
    n: 14, thread: 10, date: daysAgo(6), from: riley, to: 'Jordan Ellery <jordan@example.org>',
    subject: 'Board deck draft', labels: 'Sent', fromLineId: 'MAILER-DAEMON', noThrid: true,
    messageId: '<root-10@mail.example.com>', body: plain('Draft deck attached for review.'),
  })
  msgs.push({
    n: 15, thread: 10, date: daysAgo(6, -2), from: 'Jordan Ellery <jordan@example.org>', to: riley,
    subject: 'Re: Board deck draft', labels: 'Inbox', fromLineId: 'MAILER-DAEMON', noThrid: true,
    messageId: '<reply-10@mail.example.org>', inReplyTo: '<root-10@mail.example.com>', references: '<root-10@mail.example.com>',
    body: plain('Looks great, two small comments on slide 4.'),
  })

  return msgs
}

export function writeFixtures(outDir: string, now: Date = new Date()): FixtureInfo {
  const mailDir = join(outDir, 'Takeout', 'Mail')
  const calDir = join(outDir, 'Takeout', 'Calendar')
  mkdirSync(mailDir, { recursive: true })
  mkdirSync(calDir, { recursive: true })
  const mboxPath = join(mailDir, 'All mail Including Spam and Trash.mbox')
  // Takeout order is not chronological — shuffle deterministically.
  const msgs = buildMessages(now)
  const order = [9, 3, 0, 12, 5, 1, 13, 7, 2, 10, 4, 14, 6, 11, 8].filter(i => i < msgs.length)
  writeFileSync(mboxPath, order.map(i => assemble(msgs[i])).join(''))
  const icsPath = join(calDir, `${OWNER}.ics`)
  writeFileSync(icsPath, buildIcs(now))
  return {
    mboxPath,
    icsPath,
    expected: {
      ownerThreads: [1, 6, 9, 10],
      inboundThreads: [2],
      notImportedThreads: [3, 4, 5, 7, 8],
      recentThreads: [1, 2, 6, 10],
      importedMessages: [1, 2, 4, 8, 9, 10, 13, 14, 15],
    },
  }
}

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

export function buildIcs(now: Date): string {
  const inDays = (d: number) => new Date(now.getTime() + d * 86400000)
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '')
  const lines = [
    'BEGIN:VCALENDAR', 'PRODID:-//Google Inc//Google Calendar 70.9054//EN', 'VERSION:2.0', 'X-WR-CALNAME:riley@example.com',
    'BEGIN:VTIMEZONE', 'TZID:America/New_York', 'END:VTIMEZONE',
    // Timed event in a named zone (fixed date so UTC conversion is checkable: EDT = UTC-4)
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/New_York:20260715T090000',
    'DTEND;TZID=America/New_York:20260715T100000',
    'UID:evt-standup@google.com',
    'SUMMARY:Team standup',
    'ORGANIZER;CN=Morgan Avery:mailto:morgan@example.org',
    'ATTENDEE;CN=Morgan Avery;PARTSTAT=ACCEPTED;ROLE=REQ-PARTICIPANT:mailto:morgan@example.org',
    'ATTENDEE;CN=Riley Quinn;PARTSTAT=TENTATIVE;ROLE=REQ-PARTICIPANT:mailto:ri',
    ' ley@example.com',
    'DESCRIPTION:Daily sync\\, keep it short.\\nJoin: https://meet.google.com/abc-defg-hij',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
    'STATUS:CONFIRMED',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:This is an event reminder', 'TRIGGER:-P0DT0H10M0S', 'END:VALARM',
    'END:VEVENT',
    // Upcoming all-day event organized by the owner
    'BEGIN:VEVENT',
    `DTSTART;VALUE=DATE:${ymd(inDays(3))}`,
    `DTEND;VALUE=DATE:${ymd(inDays(4))}`,
    'UID:evt-offsite@google.com',
    'SUMMARY:Planning offsite',
    'LOCATION:Lakeside Lodge\\, Room 2',
    'ORGANIZER:mailto:riley@example.com',
    'ATTENDEE;CN=Dana Okafor-Lind;PARTSTAT=NEEDS-ACTION:mailto:dana@example.org',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    // UTC event, long ago (excluded by --since)
    'BEGIN:VEVENT',
    'DTSTART:20190514T153000Z',
    'DTEND:20190514T163000Z',
    'UID:evt-old@google.com',
    'SUMMARY:Old offsite debrief',
    'END:VEVENT',
    // Modified instance of the recurring standup
    'BEGIN:VEVENT',
    'DTSTART;TZID=America/New_York:20260716T110000',
    'DTEND;TZID=America/New_York:20260716T113000',
    'RECURRENCE-ID;TZID=America/New_York:20260716T090000',
    'UID:evt-standup@google.com',
    'SUMMARY:Team standup (moved)',
    `LAST-MODIFIED:${icsStamp(now)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
  return lines.join('\r\n') + '\r\n'
}

/**
 * A large synthetic mbox for performance testing: many threads with realistic-ish bodies
 * (multipart/alternative with QP text + HTML, some base64 attachments, some promotions/spam).
 */
export function writeBulkMbox(path: string, targetBytes: number, now: Date = new Date()): { messages: number; bytes: number } {
  const fd = openSync(path, 'w')
  let bytes = 0
  let i = 0
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu'.split(' ')
  const people = Array.from({ length: 400 }, (_, k) => `Person ${k} <person${k}@example.org>`)
  const riley = 'Riley Quinn <riley@example.com>'
  const attachment = Buffer.alloc(30_000, 7).toString('base64').replace(/(.{76})/g, '$1\n')
  while (bytes < targetBytes) {
    const thread = Math.floor(i / 3)
    const who = people[thread % people.length]
    const fromOwner = i % 3 === 1
    const r = i % 20
    const labels = r === 0 ? 'Spam' : r === 1 ? 'Category Promotions,Inbox' : r === 2 ? 'Trash' : fromOwner ? 'Sent' : 'Inbox,Category Personal'
    const text = Array.from({ length: 120 + (i % 200) }, (_, k) => words[(i + k * 7) % words.length]).join(' ')
    const date = new Date(now.getTime() - (i % 3650) * 86400000)
    let body = [
      'Content-Type: multipart/mixed; boundary="mx"', '', '--mx',
      'Content-Type: multipart/alternative; boundary="alt"', '', '--alt',
      'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: quoted-printable', '',
      text.replace(/(.{70})/g, '$1=\n'), '--alt',
      'Content-Type: text/html; charset="UTF-8"', '', `<html><body><div>${text}</div></body></html>`, '--alt--',
    ].join('\n')
    if (i % 10 === 5) body += `\n--mx\nContent-Type: image/png; name="x.png"\nContent-Disposition: attachment; filename="x.png"\nContent-Transfer-Encoding: base64\n\n${attachment}`
    body += '\n--mx--'
    const msg = assemble({
      n: 100000 + i, thread: 100000 + thread, date, from: fromOwner ? riley : who, to: fromOwner ? who : riley,
      subject: `Thread ${thread} about ${words[thread % words.length]}`, labels, body,
    })
    writeSync(fd, msg)
    bytes += Buffer.byteLength(msg)
    i++
  }
  closeSync(fd)
  return { messages: i, bytes }
}

if (import.meta.main) {
  const out = process.argv[2]
  if (!out) {
    console.error('usage: bun tools/tests/takeout-fixtures.ts <out-dir> [--bulk-mb N]')
    process.exit(1)
  }
  const info = writeFixtures(out)
  console.log(`wrote ${info.mboxPath}\nwrote ${info.icsPath}`)
  const bi = process.argv.indexOf('--bulk-mb')
  if (bi > 0) {
    const mb = parseFloat(process.argv[bi + 1])
    const p = join(out, 'bulk.mbox')
    const r = writeBulkMbox(p, mb * 1e6)
    console.log(`wrote ${p}: ${r.messages} messages, ${(r.bytes / 1e6).toFixed(1)} MB`)
  }
}
