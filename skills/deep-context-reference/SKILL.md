---
name: deep-context-reference
description: Reference for the deep-context personal knowledge base CLI. Trigger when searching the owner's messages/email/chats, browsing recent threads, working with todo items, extraction, enrichment, semantic search, or the deep_context.db database.
---

# Deep Context Reference

> Commands assume you run from the toolkit root (the directory containing `tools/` and `data/`).
> `deep-context` below is shorthand for `~/.bun/bin/bun tools/deep-context.ts`.

**Database:** `data/deep_context/deep_context.db` (SQLite, WAL mode)
**Schema:** `data/deep_context/schema.sql`
**File size:** `tools/deep-context.ts` is ~12K lines. Read it in sections (or via a sub-agent); never load the whole file.

---

## Quick Reference

### Search messages (keyword — always available, no API key)
```bash
deep-context query "search term" --source gmail --from 2026-01-01 --to 2026-03-01 --limit 30
```
Sources: `gmail` (plus `gmail-<account>` for secondary mailboxes), `slack`, `slack-dm`, `beeper`, `groupme`, `twitter`, `calls`, `podcast`

Calendar events (from a Google Takeout import) live in their own table — search them with `--source calendar`:
```bash
deep-context query "offsite" --source calendar
deep-context query '%' --source calendar --from 2026-10-12 --to 2026-10-19   # everything in a window
```

### Semantic search (optional — finds paraphrases keyword search misses)
```bash
deep-context query "someone had to reschedule" --semantic --limit 10   # meaning-based
deep-context query "sponsorship" --hybrid                              # keyword + semantic merged
deep-context query "..." --semantic --no-rerank                        # skip the optional rerank pass
deep-context embed-status                                              # index coverage
deep-context embed-update                                              # embed anything new (resumable)
```
- **Embeddings:** Gemini `gemini-embedding-2` @ 768 dims (needs `GEMINI_API_KEY`), or free/local
  Ollama `nomic-embed-text` with `DEEP_CONTEXT_EMBED_PROVIDER=ollama`. Each provider gets its own
  sidecar DB (`data/deep_context/deep_context_vectors_<provider>.db`); the main DB is never written.
- **Rerank (optional):** with `VOYAGE_API_KEY` set, `--semantic`/`--hybrid` re-score the top 50
  vector hits with Voyage `rerank-3` (~$0.002/query, +~1s). Without a key, results stay in vector
  order. Off switch: `--no-rerank` or `DEEP_CONTEXT_RERANK=0`.
- Build/extend with `embed-backfill [--from DATE] [--source S] [--max-cost N] [--dry-run]`.
  Only embedded date ranges are searchable — check `embed-status` before trusting recall.
- Rule of thumb: plain `query` for names, handles, exact phrases; `--semantic` when keyword
  search returns nothing or the question is conceptual; `--hybrid` when unsure.

### Browse recent threads (no search term needed)
```bash
deep-context recent --hours 24 --source slack --limit 30
```
Phone-number thread titles (common for iMessage via Beeper) are resolved to contact names at
print time when `data/contacts.db` exists (`bun tools/contacts.ts export`, macOS).

### Email you haven't answered
```bash
bun tools/dropped-balls.ts --days 30 [--known-only] [--warm-only] [--json]
```
Threads whose last message is inbound. 🔥 = you replied earlier then it went quiet; K = known sender.

### Check system status
```bash
deep-context status                   # All sources
deep-context status --source gmail    # One source
deep-context status --json            # Machine-readable
bun skills/deep-context-reference/scripts/source-health.ts   # Freshness table with staleness warnings
```

### Extract from a source
```bash
deep-context extract gmail --from 2026-01-01
deep-context extract gmail --account work --from 2026-01-01   # secondary Google account → source 'gmail-work'
deep-context extract slack-dm
deep-context extract beeper --backfill
deep-context extract twitter          # Archive import + live fetch
deep-context extract twitter-live     # Recent via the official X API
deep-context import-takeout takeout.zip --since 2026-09-12   # No-OAuth: Gmail mbox + Calendar .ics from Google Takeout
```

### Enrich messages with AI metadata (optional — needs GEMINI_API_KEY)
```bash
deep-context enrich --limit 100 --source gmail
deep-context enrich --limit 200 --from 2026-03-01    # threads active since a date
```
Adds `quality_score` (1-7), `authorship_score` (0-1), `originality_score` (1-7), `topics` and
`entities` to the owner's messages. `extract-for-summary` uses quality/originality to drop filler
and AI-written mail. Without a key, `enrich` prints a note and exits 0.

### Generate summaries from recent activity
```bash
deep-context extract-for-summary --from 2026-03-01 --to 2026-03-21 --output summary.md --token-budget 300000
```

### Public-only export for low-access agents
```bash
deep-context export-public [--output FILE] [--push user@host:~/dir]
```
Copies ONLY `public_sources` (config.json; default podcast + your tweets) into a slim FTS5 DB.

---

## TODO System

`todo_items` holds action items detected from communications (your agent detects them and calls
`todo add`; see `prompts/todo-scan.md` for a ready-made scan prompt).

```bash
deep-context todo list                                    # Pending + accepted
deep-context todo list --status pending --category incoming
deep-context todo add --title "Follow up with Jane" --category committed --source manual \
  --related-person "Jane Doe" --priority high --due 2026-03-25
deep-context todo update <id-prefix> --status accepted|dismissed|completed [--reason "..."]
deep-context todo expire [--days 30] [--dry-run]          # soft-expire stale INCOMING items (reversible)
deep-context todo recap --since 24                        # daily briefing
deep-context todo strategic                               # birds-eye analysis
```
Categories: `committed` (things the owner promised) and `incoming` (credible requests from others).
Lifecycle: detected → pending → accepted/dismissed → completed (stale `incoming` → `expired`).
`expire` never touches `committed` items and never deletes rows.

---

## Initial history load (Slack)
```bash
deep-context backfill slack mentions --from 2021-01-01        # checkpointed; rerun to resume
deep-context backfill slack channel-full --channel C0123 --from 2024-01-01
```

| Table | Purpose |
|-------|---------|
| `threads` | Conversation containers (email threads, chats, tweet threads, episodes, calls) |
| `messages` | Individual messages (all participants). `is_from_me` = sent from the owner's account; `authored_by` = whose words (agent-written mail is tagged) |
| `people` | People the owner interacts with, per-source identity |
| `message_metadata` | AI enrichment for the owner's messages only |
| `todo_items` | Detected action items |
| `extraction_log` | Extraction runs per source |
| `calendar_events` | Calendar events from Takeout `.ics` (start_at UTC or YYYY-MM-DD for all-day; attendees JSON; `my_response`; rrule not expanded) |

**Thread ID format:** `source:thread_id` (e.g. `gmail:18d3a4b5c6d7e8f9`)

### Excluding agent-written text
If you configure `OWNER_CONFIG.agentEmails`, mail your agents send is tagged `authored_by=<agent>`.
For "my own voice" analysis use `WHERE is_from_me = 1 AND (authored_by IS NULL OR authored_by = '<your-person-id>')`.
Messages with `authorship_evidence LIKE 'api-sent%'` were sent via the API (by a script or agent)
and are worth a manual look before treating them as your writing.

---

## Critical Patterns

- **Search strategy:** keyword `query` is SQL `LIKE %term%`. Cast a wide net with several terms;
  add `--semantic`/`--hybrid` for meaning-based recall.
- **Never use web search for Twitter/X** — it isn't indexed. Use `--source twitter`.
- **DB first, live tools second.** Hit live APIs only when results are stale or real-time data is needed.
- **Close DB viewers** (TablePlus etc.) before extraction to avoid lock contention.

## Deeper Documentation

- **Query patterns and recipes:** `references/query-recipes.md`
- **Extraction behavior per source:** `references/extraction-patterns.md`
