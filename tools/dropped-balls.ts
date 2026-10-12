#!/usr/bin/env bun
/**
 * dropped-balls.ts — Find email threads awaiting YOUR reply.
 *
 * The computable version of "things I haven't replied to, from people I've
 * replied to in the past." Gmail filters can't express "I haven't replied"
 * (filters only see one incoming message, with no thread/sent context), so
 * this reads the deep-context gmail mirror instead and computes it properly:
 *
 *   A thread is "awaiting your reply" if the LAST message in it is inbound
 *   (from them, not you) — this catches both never-replied threads AND warm
 *   threads where you replied earlier then went quiet on their latest message
 *   (the most commonly-dropped ball).
 *
 * Flags:  K = known contact (you've emailed this address before)
 *         🔥 = warm (you replied earlier in this thread, then it went cold)
 *
 * Usage:
 *   bun tools/dropped-balls.ts [--days N] [--known-only] [--warm-only] [--json]
 *
 * Note: reads the local deep_context.db (as fresh as your last extraction). Run
 * `update-deep-context` first if you need the very latest.
 */
import { Database } from "bun:sqlite";
import { dirname, join } from "path";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string, d: number) => { const i = args.indexOf(n); return i >= 0 ? Number(args[i + 1]) : d; };
const DAYS = opt("--days", 90);
const knownOnly = flag("--known-only");
const warmOnly = flag("--warm-only");
const asJson = flag("--json");

const DB_PATH = process.env.DEEP_CONTEXT_DB || join(dirname(import.meta.dir), "data/deep_context/deep_context.db");
const db = new Database(DB_PATH, { readonly: true });
const hdr = (j: any, n: string) => { const h = (j.headers || []).find((x: any) => x.name.toLowerCase() === n.toLowerCase()); return h ? h.value : ""; };
const emailOf = (s: string) => { const m = s.match(/<([^>]+)>/); return (m ? m[1] : s).trim().toLowerCase(); };
const nameOf = (s: string) => { const m = s.match(/^\s*"?([^"<]+?)"?\s*</); return m ? m[1].trim() : s.replace(/<.*/, "").trim(); };

// People you've sent mail to (across all history) = "replied to in the past"
const contacts = new Set<string>();
for (const r of db.query("SELECT recipients FROM messages WHERE source='gmail' AND is_from_me=1").all() as any[]) {
  try { const rec = JSON.parse(r.recipients || "{}"); for (const f of ["to", "cc"]) for (const a of (rec[f] || [])) { const e = emailOf(a); if (e.includes("@")) contacts.add(e); } } catch {}
}

const since = new Date(Date.now() - DAYS * 864e5).toISOString();
const msgs = db.query("SELECT thread_id,is_from_me,timestamp,raw_json,content FROM messages WHERE source='gmail' AND timestamp>=? ORDER BY timestamp ASC").all(since) as any[];
const T = new Map<string, any>();
for (const m of msgs) {
  let j: any = {}; try { j = JSON.parse(m.raw_json || "{}") || {}; } catch {}
  let t = T.get(m.thread_id); if (!t) { t = { hasMe: false, everInbox: false }; T.set(m.thread_id, t); }
  t.hasMe = t.hasMe || !!m.is_from_me;
  t.everInbox = t.everInbox || (j.labelIds || []).includes("INBOX");
  t.last = { fromMe: !!m.is_from_me, from: hdr(j, "From"), subj: hdr(j, "Subject"), ts: m.timestamp, labels: j.labelIds || [], content: m.content || "" };
}

// Strip quoted reply-tail + signature so we can judge the actual new text.
const newText = (c: string) => c.replace(/\r/g, "").split(/\nOn .+wrote:|\n>+ |\n--\s*\n|\n_{3,}/)[0].trim();
// No closer/hand-off regex classification here: whether a thread still needs a reply
// is a judgment call for the consuming session/model — the preview field carries the text.

// Filter out automated / bulk / list mail — keep genuine person-to-person.
const noise = /(noreply|no-reply|donotreply|notification|mailer-|bounce|newsletter|@.*\.(substack|beehiiv)\.com|noreply\.github|calendly\.com|@cal\.com|cisionone|@cision\.com|venmo@|automatic reply|out of office|^ooo |alerts?@|do-not-reply)/i;

const out: any[] = [];
for (const t of T.values()) {
  const l = t.last; if (!l || l.fromMe) continue;          // last message must be inbound
  if (!t.everInbox) continue;
  if (l.labels.includes("CATEGORY_PROMOTIONS") || l.labels.includes("CATEGORY_FORUMS")) continue;
  const fe = emailOf(l.from), fn = nameOf(l.from);
  if (noise.test(fe) || noise.test(fn) || noise.test(l.subj)) continue;
  const known = contacts.has(fe), warm = t.hasMe;
  if (knownOnly && !known) continue;
  if (warmOnly && !warm) continue;
  out.push({ ts: l.ts.slice(0, 10), from: fn, email: fe, subj: l.subj.replace(/\s+/g, " ").slice(0, 90), known, warm, preview: newText(l.content).replace(/\s+/g, " ").slice(0, 240) });
}
out.sort((a, b) => b.ts.localeCompare(a.ts));

if (asJson) { console.log(JSON.stringify(out, null, 1)); process.exit(0); }
console.log(`\n📬 Awaiting your reply (last ${DAYS}d): ${out.length}  |  contacts known: ${contacts.size}`);
console.log(`   🔥 warm (replied earlier, went quiet): ${out.filter(o => o.warm).length}   K known sender: ${out.filter(o => o.known).length}\n`);
for (const o of out) console.log(`${o.ts} ${o.warm ? "🔥" : "  "}${o.known ? "K" : " "} ${o.from} <${o.email}>\n           ${o.subj}`);
