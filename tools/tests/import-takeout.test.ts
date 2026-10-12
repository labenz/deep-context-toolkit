// bun test tools/tests/import-takeout.test.ts
import { describe, test, expect, beforeAll } from 'bun:test'
import Database from 'bun:sqlite'
import { mkdtempSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { runImport, gmailDecToHex, decodeMimeWords, icsDate } from '../import-takeout'
import { writeFixtures, OWNER, OWNER_ALIAS, thrHex, msgHex, msgDec } from './takeout-fixtures'

const TOOLS = dirname(import.meta.dir)
const SCHEMA = join(TOOLS, '..', 'data/deep_context/schema.sql')
const NOW = new Date()
const ME = [OWNER, OWNER_ALIAS]

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'takeout-test-'))
}

function counts(dbPath: string) {
  const db = new Database(dbPath, { readonly: true })
  const r = {
    threads: (db.query('SELECT COUNT(*) c FROM threads').get() as any).c,
    messages: (db.query('SELECT COUNT(*) c FROM messages').get() as any).c,
    people: (db.query('SELECT COUNT(*) c FROM people').get() as any).c,
    threadCounts: JSON.stringify(db.query('SELECT id, thread_count FROM people ORDER BY id').all()),
    msgCounts: JSON.stringify(db.query('SELECT id, message_count, my_message_count, participant_ids FROM threads ORDER BY id').all()),
    events: (db.query('SELECT COUNT(*) c FROM calendar_events').get() as any).c,
  }
  db.close()
  return r
}

describe('helpers', () => {
  test('decimal Gmail ids map to API hex ids', () => {
    expect(gmailDecToHex('1781234567890000001')).toBe((1781234567890000001n).toString(16))
    expect(gmailDecToHex('MAILER-DAEMON')).toBeNull()
  })
  test('RFC 2047 headers decode', () => {
    expect(decodeMimeWords('=?UTF-8?B?Q2Fmw6kgcGxhbnMg4piV?=')).toBe('Café plans ☕')
    expect(decodeMimeWords('=?ISO-8859-1?Q?Se=F1or_Pepe?=')).toBe('Señor Pepe')
  })
  test('ICS TZID times convert to UTC', () => {
    expect(icsDate({ name: 'DTSTART', params: { TZID: 'America/New_York' }, value: '20260715T090000' }).iso).toBe('2026-07-15T13:00:00.000Z')
    expect(icsDate({ name: 'DTSTART', params: { TZID: 'America/New_York' }, value: '20260115T090000' }).iso).toBe('2026-01-15T14:00:00.000Z')
    expect(icsDate({ name: 'DTSTART', params: { VALUE: 'DATE' }, value: '20261015' })).toMatchObject({ iso: '2026-10-15', allDay: true })
  })
})

describe('full import from an extracted Takeout folder', () => {
  const dir = tmp()
  const dbPath = join(dir, 'dc.db')
  const staging = join(dir, 'staging.db')
  let fx: ReturnType<typeof writeFixtures>

  beforeAll(async () => {
    fx = writeFixtures(join(dir, 'fx'), NOW)
    await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: staging, quiet: true })
  })

  test('imports owner threads + inbound-from-known-contacts, nothing else', () => {
    const db = new Database(dbPath, { readonly: true })
    const ids = new Set((db.query('SELECT id FROM threads').all() as any[]).map(r => r.id))
    for (const t of [1, 2, 6, 9]) expect(ids.has(`gmail:${thrHex(t)}`)).toBe(true)
    for (const t of fx.expected.notImportedThreads) expect(ids.has(`gmail:${thrHex(t)}`)).toBe(false)
    expect(ids.size).toBe(5) // + the References-threaded non-Gmail thread
    const msgIds = new Set((db.query('SELECT id FROM messages').all() as any[]).map(r => r.id))
    for (const n of [1, 2, 4, 8, 9, 10, 13]) expect(msgIds.has(`gmail:${msgHex(n)}`)).toBe(true)
    for (const n of [3, 5, 6, 7, 11, 12]) expect(msgIds.has(`gmail:${msgHex(n)}`)).toBe(false)
    expect(msgIds.size).toBe(fx.expected.importedMessages.length)
    db.close()
  })

  test('rows match the API extractor shape', () => {
    const db = new Database(dbPath, { readonly: true })
    const reply = db.query('SELECT * FROM messages WHERE id = ?').get(`gmail:${msgHex(2)}`) as any
    expect(reply.is_from_me).toBe(1)
    expect(reply.content).toBe('Tuesday works. Let us say noon at the Elm Street place.') // quoted text stripped
    expect(reply.reply_to_message_id).toBe(`gmail:${msgHex(1)}`)
    expect(reply.source_message_id).toBe(msgHex(2))
    expect(JSON.parse(reply.recipients).cc).toEqual(['"Dana Okafor-Lind" <dana@example.org>'])
    const t1 = db.query('SELECT * FROM threads WHERE id = ?').get(`gmail:${thrHex(1)}`) as any
    expect(t1.source_url).toBe(`https://mail.google.com/mail/u/0/#inbox/${thrHex(1)}`)
    expect(t1.message_count).toBe(2) // trashed message dropped
    expect(t1.thread_type).toBe('group')
    const dana = db.query('SELECT * FROM messages WHERE id = ?').get(`gmail:${msgHex(4)}`) as any
    expect(dana.has_attachments).toBe(1)
    expect(dana.content).toContain('Señor Pepe')
    expect((db.query('SELECT subject FROM threads WHERE id = ?').get(`gmail:${thrHex(2)}`) as any).subject).toBe('Café plans ☕')
    const api = db.query('SELECT * FROM messages WHERE id = ?').get(`gmail:${msgHex(8)}`) as any
    expect(api.authorship_evidence).toContain('api-sent')
    expect(api.content).toContain('\nFrom the start') // >From un-escaped
    const html = db.query('SELECT content FROM messages WHERE id = ?').get(`gmail:${msgHex(10)}`) as any
    expect(html.content).toBe('Agenda attached next week.')
    const alias = db.query('SELECT is_from_me FROM messages WHERE id = ?').get(`gmail:${msgHex(13)}`) as any
    expect(alias.is_from_me).toBe(1)
    db.close()
  })

  test('calendar events land in calendar_events', () => {
    const db = new Database(dbPath, { readonly: true })
    const standup = db.query(`SELECT * FROM calendar_events WHERE id = 'calendar:evt-standup@google.com'`).get() as any
    expect(standup.start_at).toBe('2026-07-15T13:00:00.000Z')
    expect(standup.rrule).toContain('FREQ=WEEKLY')
    expect(standup.my_response).toBe('TENTATIVE') // folded ATTENDEE line
    expect(standup.conference_url).toBe('https://meet.google.com/abc-defg-hij')
    const offsite = db.query(`SELECT * FROM calendar_events WHERE uid = 'evt-offsite@google.com'`).get() as any
    expect(offsite.all_day).toBe(1)
    expect(offsite.is_organizer).toBe(1)
    expect(offsite.location).toBe('Lakeside Lodge, Room 2')
    expect((db.query(`SELECT COUNT(*) c FROM calendar_events`).get() as any).c).toBe(4) // incl. moved instance
    db.close()
  })

  test('re-import is idempotent (no duplicate rows, counters unchanged)', async () => {
    const before = counts(dbPath)
    await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: staging, quiet: true })
    expect(counts(dbPath)).toEqual(before)
    // Even with a fresh staging DB (forces a full re-scan and re-load path)
    await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: join(dir, 'staging2.db'), quiet: true })
    expect(counts(dbPath)).toEqual(before)
  })

  test('deep-context query --source calendar and import-takeout routing work from the CLI', () => {
    const env = { ...process.env, DEEP_CONTEXT_DB: dbPath }
    const q = Bun.spawnSync(['bun', join(TOOLS, 'deep-context.ts'), 'query', 'standup', '--source', 'calendar'], { env })
    const out = q.stdout.toString()
    expect(out).toContain('Found 2 calendar events')
    expect(out).toContain('Team standup')
    const help = Bun.spawnSync(['bun', join(TOOLS, 'deep-context.ts'), 'import-takeout', '--help'], { env })
    expect(help.exitCode).toBe(0)
    expect(help.stderr.toString()).toContain('import-takeout')
  })
})

describe('seed (--since) then full history', () => {
  test('seed loads only recent threads; full pass adds the rest; third pass adds nothing', async () => {
    const dir = tmp()
    const dbPath = join(dir, 'dc.db')
    const staging = join(dir, 'staging.db')
    writeFixtures(join(dir, 'fx'), NOW)
    const since = new Date(NOW.getTime() - 30 * 86400000).toISOString().slice(0, 10)
    const seed = await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: staging, since, quiet: true })
    expect(seed.load!.newThreads).toBe(4)
    expect(seed.calendar.skippedOld).toBe(2) // 2019 event + the July moved instance (recurring master is kept)
    const db = new Database(dbPath, { readonly: true })
    expect(db.query('SELECT id FROM threads WHERE id = ?').get(`gmail:${thrHex(9)}`)).toBeNull()
    db.close()
    const full = await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: staging, quiet: true })
    expect(full.load!.newThreads).toBe(1)
    expect(full.load!.unchangedThreads).toBe(4)
    const again = await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: staging, quiet: true })
    expect(again.load!.newThreads).toBe(0)
    expect(again.load!.newMessages).toBe(0)
  })
})

describe('dedupe with the Gmail API extractor', () => {
  test('API-extracted rows are extended, never duplicated', async () => {
    const dir = tmp()
    const dbPath = join(dir, 'dc.db')
    writeFixtures(join(dir, 'fx'), NOW)
    const db = new Database(dbPath)
    db.exec(readFileSync(SCHEMA, 'utf8'))
    // What `extract gmail` would have stored for thread 1 (only the first message so far)
    const tid = `gmail:${thrHex(1)}`
    db.query(`INSERT INTO people (id, display_name, identifiers, thread_count) VALUES ('morgan-avery','Morgan Avery','["morgan@example.org"]',1)`).run()
    db.query(`INSERT INTO threads (id, source, source_thread_id, subject, started_at, last_activity_at, message_count, my_message_count, participant_ids, thread_type) VALUES (?, 'gmail', ?, 'Lunch next week?', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1, 0, '["me","morgan-avery"]', '1:1')`).run(tid, thrHex(1))
    db.query(`INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, position_in_thread, sender_id, is_from_me, content, content_type, raw_json) VALUES (?, ?, 'gmail', ?, '2026-01-01T00:00:00.000Z', 1, 'morgan-avery', 0, 'from api', 'email', ?)`)
      .run(`gmail:${msgHex(1)}`, tid, msgHex(1), JSON.stringify({ headers: [{ name: 'Message-ID', value: '<m1@mail.example.com>' }] }))
    // Thread 6: API stored message 9 under a different id but the same RFC Message-ID
    const t6 = `gmail:${thrHex(6)}`
    db.query(`INSERT INTO threads (id, source, source_thread_id, subject, message_count, my_message_count, participant_ids) VALUES (?, 'gmail', ?, 'Project kickoff notes', 1, 0, '["me"]')`).run(t6, thrHex(6))
    db.query(`INSERT INTO messages (id, thread_id, source, source_message_id, timestamp, sender_id, is_from_me, content, raw_json) VALUES ('gmail:other-id', ?, 'gmail', 'other-id', '2026-01-01', 'sam-acme', 0, 'x', ?)`)
      .run(t6, JSON.stringify({ headers: [{ name: 'Message-Id', value: '<m9@mail.example.com>' }] }))
    db.close()

    const r = await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: join(dir, 's.db'), quiet: true })
    expect(r.load!.skippedDuplicateMessages).toBe(1)
    const db2 = new Database(dbPath, { readonly: true })
    expect((db2.query('SELECT COUNT(*) c FROM messages WHERE thread_id = ?').get(tid) as any).c).toBe(2)
    expect((db2.query('SELECT content FROM messages WHERE id = ?').get(`gmail:${msgHex(1)}`) as any).content).toBe('from api') // untouched
    const t = db2.query('SELECT message_count, my_message_count, participant_ids FROM threads WHERE id = ?').get(tid) as any
    expect(t.message_count).toBe(2)
    expect(t.my_message_count).toBe(1)
    expect(JSON.parse(t.participant_ids)).toContain('dana-okafor-lind')
    expect((db2.query('SELECT COUNT(*) c FROM messages WHERE thread_id = ?').get(t6) as any).c).toBe(3)
    db2.close()
  })
})

describe('resumable scan + archive input', () => {
  test('a paused scan resumes from its checkpoint and ends identical to a one-shot scan', async () => {
    const dir = tmp()
    writeFixtures(join(dir, 'fx'), NOW)
    const staging = join(dir, 's.db')
    const dbPath = join(dir, 'dc.db')
    const first = await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: staging, scanStopAfter: 4, mailOnly: true, quiet: true })
    expect(first.scan.paused).toBe(true)
    const st = new Database(staging, { readonly: true })
    const state = st.query('SELECT byte_offset, done FROM scan_state').get() as any
    st.close()
    expect(state.done).toBe(0)
    expect(state.byte_offset).toBeGreaterThan(0)
    await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath, stagingPath: staging, mailOnly: true, quiet: true })

    const ref = join(dir, 'ref.db')
    await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath: ref, stagingPath: join(dir, 'ref-s.db'), mailOnly: true, quiet: true })
    const a = counts(dbPath), b = counts(ref)
    expect(a.messages).toBe(b.messages)
    expect(a.msgCounts).toBe(b.msgCounts)
  })

  test('reads straight from a Takeout .zip and .tgz', async () => {
    const dir = tmp()
    writeFixtures(join(dir, 'fx'), NOW)
    expect(Bun.spawnSync(['zip', '-qr', join(dir, 'takeout-001.zip'), 'Takeout'], { cwd: join(dir, 'fx') }).exitCode).toBe(0)
    expect(Bun.spawnSync(['tar', '-czf', join(dir, 'takeout-001.tgz'), 'Takeout'], { cwd: join(dir, 'fx') }).exitCode).toBe(0)
    const ref = join(dir, 'ref.db')
    await runImport({ inputs: [join(dir, 'fx')], me: ME, dbPath: ref, stagingPath: join(dir, 'r.db'), quiet: true })
    for (const name of ['takeout-001.zip', 'takeout-001.tgz']) {
      const dbPath = join(dir, `${name}.db`)
      const r = await runImport({ inputs: [join(dir, name)], me: ME, dbPath, stagingPath: join(dir, `${name}.s.db`), quiet: true })
      expect(r.scan.messages).toBe(11)
      expect(counts(dbPath)).toEqual(counts(ref))
    }
  })

  test('owner addresses are detected from Sent mail when not configured', async () => {
    const dir = tmp()
    writeFixtures(join(dir, 'fx'), NOW)
    const r = await runImport({ inputs: [join(dir, 'fx')], dbPath: join(dir, 'dc.db'), stagingPath: join(dir, 's.db'), quiet: true })
    expect(r.owner.sort()).toEqual([OWNER, OWNER_ALIAS].sort())
    expect(r.load!.newThreads).toBe(5)
  })
})

// keep the fixture's decimal id helper referenced (documents the From_ line format)
void msgDec
