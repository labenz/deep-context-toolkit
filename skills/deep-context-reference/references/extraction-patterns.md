# Deep Context Extraction Patterns

How extraction works for each data source, including incremental behavior, gotchas, and known issues.

---

## General Extraction Command

```bash
deep-context extract <source> [--from DATE] [--to DATE] [--limit N] [--dry-run] [--backfill]
```

All extractions are **incremental by default** -- they detect where the last run left off and only fetch new data.

---

## Gmail

```bash
deep-context extract gmail [--from DATE]
```

**Incremental behavior:**
- Auto-detects `--from` when not specified: queries DB for the newest gmail thread, subtracts 7 days for overlap.
- Uses `from:me` filter to focus on the owner's sent messages.
- **Early termination:** Stops after 200 consecutive unchanged threads (threads that exist in DB with the same message count). This prevents re-scanning the entire history on each run.

**Known issues:**
- **Auth tokens expire after ~1 hour.** The tool now auto-refreshes via `try_refresh_token` and persists the new token. Previously returned stale tokens from `.env` without refreshing, causing 401s on cron runs. The fix: refresh -> persist -> use.
- HTML-only emails are converted to plain text at extract time (`html-to-text`).

---

## Slack (Channels)

```bash
deep-context extract slack [--from DATE]
```

**Incremental behavior:**
- Auto-detects `--from` same as Gmail: queries DB for newest slack thread, subtracts 7 days.
- Extracts from configured workspace channels.

**Post-processing:**
- Slack user mention tokens like `<@U12345>` are resolved to `@DisplayName` at extract time, using the `slack_user_cache` table.

---

## Slack DMs

```bash
deep-context extract slack-dm [--from DATE]
```

**Incremental behavior (Feb 2026 rewrite):**
- Uses **search-based discovery**: runs `search.messages from:@yourname after:<date>` to find the handful of active DM channels instead of scanning every channel.
- **Incremental updates:** Appends new messages to existing threads (old code skipped existing threads entirely).
- Stops paginating once it reaches messages already in the DB.

---

## Beeper (Cross-Platform Messaging)

```bash
deep-context extract beeper [--backfill]
```

**Incremental behavior (Feb 2026 rewrite):**
- No longer skips existing threads -- inserts only new messages via ID-based dedup.
- For iMessage threads, also cross-checks `source_message_id` against the native `imessage` source to avoid cross-source duplication.
- Beeper is the sole ongoing iMessage source; old native `imessage` data (338K messages) stays as historical archive.

**Pagination:**
- Must use `cursor=` parameter (not `before=`). Always returns 20 messages per page.
- The `--backfill` flag enables full-history gap recovery (fetches all available history for each chat).

**Privacy filtering:**
- Certain contacts are excluded from all queries per `beeper-config.json`. Uses `mode: "entire_chat"` to filter both directions.

---

## Twitter

Two separate extraction modes:

### Archive Import
```bash
deep-context extract twitter [--from DATE]
```
Imports from a downloaded Twitter archive (data export). Processes tweets, retweets, quote tweets, and reply context.

**Thread handling:**
- Self-reply chains are grouped into proper threads with `thread_type='thread'`.
- Parent tweet stubs are added for replies to others, providing conversation context at `position_in_thread=0`. These threads keep `thread_type='standalone'`.
- Branching self-reply chains exist: when you reply to the same tweet multiple times, the tree is flattened by timestamp (`timestamp ASC`), not depth.
- Parent-tweet stubs are filled from the archive's `like.js` when the parent is a tweet you liked.

### Live Extraction
```bash
deep-context extract twitter-live
```
Fetches recent tweets via the official X API (`tools/twitter-api.ts`, needs `X_API_*` keys). Uses the same `twitter:{tweetId}` ID scheme as archive import for automatic dedup; runs automatically as part of `extract twitter`. Without X API keys the live pass skips cleanly.

---

## Calls (Fireflies)

```bash
deep-context extract calls [--from DATE]
```

Imports meeting transcripts from Fireflies.ai. Each call becomes a thread with speaker turns as individual messages.

---

## Podcast

```bash
deep-context extract podcast [--from DATE]
```

Optional — only if you produce a podcast (set `extraction.podcast.episodes_csv` in config.json). Imports episode transcripts. Each episode is a thread; speaker turns become messages with content types like `speaker_turn`, `questions`, `intro`, `editorial_commentary`.

---

## Enrichment (Post-Extraction)

After extraction, run enrichment to add AI-generated metadata:

```bash
deep-context enrich --limit 100                        # Enrich 100 unenriched messages
deep-context enrich --source gmail                     # Only Gmail messages
deep-context enrich --from 2026-03-01                  # Threads active since a date (catches new replies too)
deep-context enrich --dry-run                          # Preview without writing
```

**What enrichment does:**
- Processes the owner's messages only (`is_from_me = 1`)
- Uses Gemini to generate: quality score (1-7), authorship score (0-1), originality score (1-7), topics, entities. (Earlier versions also produced domain/sentiment/engagement/actionability/style/thread-role fields; nothing read them, so they were dropped in 2026-10.)
- Sends full thread context (not just the single message) so Gemini understands conversation flow
- Writes to `message_metadata` table
- Skips messages already enriched by the current model (`message_metadata.processor_model`)
- Optional: needs `GEMINI_API_KEY`; without one `enrich` prints a note and exits cleanly
- Scope with `--from` (thread activity). `--extracted-since` is a deprecated alias for it.

**Enrichment model:** `gemini-3.7-flash` by default (override with `DEEP_CONTEXT_ENRICH_MODEL` or `enrichment.model` in config.json). Messages are marked `[MSG n]` per batch; failed/truncated batches retry up to 3x; huge threads get a windowed context; each batch is written as soon as it returns.

---

## Automated Extraction Schedule

If you schedule it (see `tools/deep-context-cron.sh`), a typical cadence is:
- **2-3x daily** for core sources (Gmail, Slack, Beeper, Twitter-live), followed by `embed-update`
- **TODO scanning** 1-2x daily, via your agent reading recent threads and calling `todo add`

For a manual full update, run the `update-deep-context` skill (extract each source → enrich → `embed-update`).
