---
name: update-deep-context
description: Update the personal knowledge base with new data from all sources (Gmail, Slack, Beeper, GroupMe, Twitter, calls). Use for daily/weekly context updates. Handles extraction, storage, and enrichment - NOT summarization.
---

# Update Deep Context Skill

Orchestrated pipeline to extract, store, and enrich communications data in the personal knowledge base.

> Commands below assume you run from the toolkit root (the directory containing `tools/` and `data/`).
> Bun installs to `~/.bun/bin/bun` and may not be on PATH, so the full path is used.

## User Invocable

- **Slash command**: `/update-deep-context`
- **Triggers**: "update my context", "extract new data", "sync communications", "run deep context update"

## Usage

```
/update-deep-context                           # All default sources + enrichment
/update-deep-context gmail slack               # Specific sources only
/update-deep-context --exclude beeper calls    # All except these
/update-deep-context --enrich-only             # Skip extraction, just enrich
/update-deep-context --status                  # Show status only
/update-deep-context --enrich-limit 500        # Custom enrichment limit
/update-deep-context --skip-enrich             # Extract only, no enrichment
/update-deep-context --full                    # Alias: all sources + 500 enrichment limit
```

## CLI Reference

```bash
# All commands use this base (run from the toolkit root)
~/.bun/bin/bun tools/deep-context.ts <command>

# Database
data/deep_context/deep_context.db
```

---

## Default Source Set (7 sources)

Every run checks ALL 7 default sources unless narrowed by named sources or `--exclude`.

| # | Source | Command | Prerequisites |
|---|--------|---------|---------------|
| 1 | gmail | `deep-context extract gmail` | Google OAuth configured (no OAuth? see **No-OAuth path: Google Takeout** below; skip gmail in routine runs) |
| 2 | slack | `deep-context extract slack` | Slack token(s) configured |
| 3 | slack-dm | `deep-context extract slack-dm` | Slack token(s) configured |
| 4 | beeper | `deep-context extract beeper` | Desktop running, contacts fresh |
| 5 | groupme | `deep-context extract groupme` | `GROUPME_ACCESS_TOKEN` set (no app) |
| 6 | calls | `deep-context extract calls` | Fireflies transcripts imported first |
| 7 | twitter | `deep-context extract twitter` | Archive path configured; also runs live API fetch |

**Inbound coverage (built into the sources above):**
- **Gmail runs two passes** — Pass 1 = your sent mail (`from:me`); Pass 2 = inbound mail *from known contacts* (people you've corresponded with). This captures incoming threads you never replied to from people who matter.
- **Slack runs three passes** — Pass 1 = your messages (`from:`); Pass 2 = threads where you're @-mentioned but haven't replied (`slack-mentions`); Pass 3 = full capture of any channels listed in `tools/slack-capture-config.json` (`slack-channel-full`). All three run inside `extract slack`.

**Not in default set** (standalone / owner-specific):
- twitter-live — live API only (no archive), useful for targeted catch-up
- slack-mentions / slack-channel-full — sub-passes of `extract slack`; can be run standalone
- podcast — owner-specific (reads a local `episodes.csv` + transcript files). Only relevant if you produce a podcast; enable in `config.json` and run `extract podcast` explicitly.
- imessage — deprecated, use `beeper` for iMessage going forward
- **gmail --account <name>** — a secondary Google account (work, travel, …). Lands under
  `source='gmail-<name>'` with its own incremental watermark, so it never shifts the primary
  mailbox's start date. Authorize once with `extract gmail --account <name>` (device flow;
  sign in as that account), then add it to your routine if you want it every run.
- **takeout** — one-shot history import from a Google Takeout export (see next section). Not a
  routine source: run it when the user hands you a new Takeout archive.

### No-OAuth path: Google Takeout

For users who haven't set up Google OAuth (or don't want to), import Gmail **and Google Calendar** from
a Takeout export. It needs no tokens and no Google Cloud project.

1. **Get the export.** If the user has none, walk them through README → "Start without OAuth: Google Takeout":
   takeout.google.com → **Deselect all** → tick **Mail** (MBOX) and **Calendar** (iCalendar) → Next step →
   *Send download link via email*, *Export once*, *.zip*, largest file size → **Create export**. Google
   emails a download link, usually within hours (large mailboxes can take a day or more). The links
   expire after about a week.
2. **Seed pass (fast orientation):**
   `~/.bun/bin/bun tools/deep-context.ts import-takeout <takeout-*.zip> --since <today minus 30 days>`
   The first run scans the whole mbox into a staging DB, then loads only recently active threads. It
   prints your detected addresses; copy them into `OWNER_CONFIG.emails` if they aren't there yet.
3. **Full-history pass:** the same command without `--since`. It reuses the staging DB (no re-scan), loads
   newest-first, and is resumable. If it's interrupted (laptop sleep, Ctrl-C), re-run the same command.
4. **Afterwards:** `status`, `recent --hours 720`, `query <term> --source calendar`. Then run enrich/embeddings
   as usual. If OAuth is added later, `extract gmail` lines up with the imported rows (same `gmail:<hex id>`
   IDs) and only fetches what's new.

Options worth knowing: `--account work` (second mailbox → `gmail-work`), `--me addr` (extra owner address),
`--mail-only` / `--calendar-only`, `--dry-run` (counts only), `--rescan` (ignore scan checkpoint).
Long imports should run detached or in a sub-agent; they print progress every ~5s.

---

## Execution Steps

Follow these phases in order. Report progress to the user after each phase.

### Phase 0: Status & Planning

1. Run `deep-context status` to get current state
2. Parse the output to determine:
   - Last extraction timestamp per source
   - Unenriched thread/message counts
   - Total threads, messages, people
3. **Determine update set** based on invocation:
   - **Default (no args)**: All 7 default sources
   - **`--full`**: All 7 sources + enrichment limit 500
   - **Named sources** (e.g., `gmail slack`): Only those sources
   - **`--exclude <sources>`**: All defaults minus the excluded sources
   - **`--enrich-only`**: Skip to Phase 3
   - **`--status`**: Report status and stop here
4. Report the plan to the user:
   - Which sources will run
   - Current staleness of each source
   - **Alerts** for archive-only sources: if twitter is >30 days stale, note it

**Staleness reference** (informational — does NOT gate execution):

| Source | Typical cadence | Notes |
|--------|----------------|-------|
| gmail | Daily | Most active source; runs outbound + inbound-from-known passes |
| slack | Daily | Runs from: + mentions + full-capture passes |
| slack-dm | Daily | DMs and group DMs |
| beeper | Daily | Requires Desktop running |
| groupme | Daily | Token-only (no app); first run uses `--backfill`, then incremental |
| calls | Weekly | Import Fireflies transcripts first |
| twitter | Daily (live) + archive | Live API auto-runs within `extract twitter` |

### Phase 1: Prerequisites

Run these checks/preparations before extraction:

1. **Beeper Desktop check** (if beeper is in update set):
   - Test API reachability: `~/.bun/bin/bun tools/beeper.ts accounts`
   - If unreachable: remove beeper from update set, warn user, continue

2. **Contacts refresh** (if beeper is in update set):
   - Check contacts DB age: `~/.bun/bin/bun tools/contacts.ts stats`
   - If >7 days old: `~/.bun/bin/bun tools/contacts.ts export`

3. **Calls import** (if calls is in update set):
   - List recent Fireflies transcripts and compare against existing calls (`tools/calls.ts list --days 30`)
   - For each Fireflies transcript NOT already imported: `~/.bun/bin/bun tools/calls.ts import <fireflies_id>`
   - Then summarize newly imported calls: `~/.bun/bin/bun tools/calls.ts summarize "<fireflies_id_prefix>"`
   - If import/summarize fails for a call: log the error, continue with others
   - If Fireflies API is unreachable: remove calls from update set, warn user, continue
   - **Note:** `calls sync` only lists — it does NOT import. Always use `calls import` explicitly.

### Phase 2: Extraction

Run extractions **sequentially** (SQLite WAL mode handles reads but sequential writes avoid contention).

For each source in the update set, run the corresponding command. Continue to the next source on failure — don't abort the entire update.

**Commands by source:**

| Source | Command |
|--------|---------|
| gmail | `~/.bun/bin/bun tools/deep-context.ts extract gmail` |
| slack | `~/.bun/bin/bun tools/deep-context.ts extract slack` |
| slack-dm | `~/.bun/bin/bun tools/deep-context.ts extract slack-dm` |
| beeper | `~/.bun/bin/bun tools/deep-context.ts extract beeper` |
| groupme | `~/.bun/bin/bun tools/deep-context.ts extract groupme` |
| calls | `~/.bun/bin/bun tools/deep-context.ts extract calls` |
| twitter | `~/.bun/bin/bun tools/deep-context.ts extract twitter` |

For each extraction:
- Extraction output is verbose: in Claude Code, a sub-agent keeps the main context clean; in
  Codex or a headless run, redirect each source's output to its own log file and read the tail.
  Either way, wait for each command to finish before starting the next.
- Record: success/failure, items extracted, new threads/messages, errors
- On failure: log the error, continue to next source

### Phase 3: Enrichment

Skip this phase if `--skip-enrich` was specified.

Enrichment is **optional** — it needs `GEMINI_API_KEY`. Without one, `enrich` prints a one-line
note and exits 0; report enrichment as "skipped (no key)" and move on.

**Important:** Only enrich threads active in this run's window. This prevents the enrichment step from getting stuck on the massive backlog of old threads and blocking scheduled runs.

1. Determine enrichment limit:
   - Default: 200 threads
   - `--enrich-limit N`: Use N
   - `--full`: 500 threads
2. Pick a lookback date matching the extraction window (e.g. 7 days ago)
3. Run: `~/.bun/bin/bun tools/deep-context.ts enrich --limit <N> --from <lookback_date>`
   - `--from` filters on `threads.last_activity_at`, which updates whenever a thread gets new
     messages — so it catches both brand-new threads AND new replies in existing threads.
   - (`--extracted-since` is a deprecated alias for `--from`; older scripts that pass it still work.)
4. Sanity-check the backlog before/after so "0 enriched" is never ambiguous:
   ```sql
   SELECT COUNT(m.id) FROM threads t
     JOIN messages m ON m.thread_id = t.id AND m.is_from_me = 1
     LEFT JOIN message_metadata mm ON m.id = mm.message_id
   WHERE t.my_message_count > 0 AND mm.message_id IS NULL
     AND t.last_activity_at >= '<lookback_date>';
   ```
5. Enrichment is verbose and can run 20+ minutes on large group threads; capture its log and wait.
   Failed/truncated batches retry up to 3x and every batch is saved as it completes, so an
   interrupted run resumes where it left off.
6. On Gemini 429 (quota exhausted): report progress so far, don't treat as failure

### Phase 3b: Semantic index (optional)

If an embedding provider is configured (`GEMINI_API_KEY`, or `DEEP_CONTEXT_EMBED_PROVIDER=ollama`),
run `~/.bun/bin/bun tools/deep-context.ts embed-update --max-cost 0.50` so `query --semantic`
covers the new messages. It is resumable and additive. Without a provider it exits with a
short explanation — report "skipped (no embedding provider)". The scheduled wrapper
(`tools/deep-context-cron.sh`) runs this stage itself, so skip it when invoked from there.

### Phase 4: Summary Report

Present a clear summary showing ALL sources in the update set with explicit status, not just the ones that produced new data.

```
## Deep Context Update Summary

### Extraction Results
| Source    | Status | New Threads | New Messages | Notes                    |
|-----------|--------|-------------|--------------|--------------------------|
| gmail     | OK     | 12          | 47           |                          |
| slack     | OK     | 8           | 34           |                          |
| slack-dm  | OK     | 3           | 11           |                          |
| beeper    | SKIP   | -           | -            | Desktop not running      |
| groupme   | OK     | 1           | 22           |                          |
| calls     | OK     | 2           | 6            |                          |
| twitter   | OK     | 5           | 5            |                          |

### Enrichment
- Threads processed: 200
- Remaining unenriched: ~X
- Coverage: X% of messages enriched

### Alerts
- Twitter archive is X days old (consider re-downloading)
- Beeper Desktop was not reachable
```

Status values: **OK** (ran successfully), **SKIP** (excluded or prerequisite failed), **FAIL** (ran but errored)

---

## Tactical Reference

### Beeper
- Requires Beeper Desktop running with API enabled
- Privacy filtering via `beeper-config.json` (`mode: "entire_chat"`)
- WhatsApp doesn't transfer full history to new devices
- **Beeper is the sole ongoing iMessage source** — supports incremental updates. Old native `imessage` data (if any) is preserved as a historical archive; cross-source dedup prevents duplicate iMessage messages.
- **API pagination quirks:**
  - Must use `cursor=<sortKey>` — `before=<sortKey>` is silently ignored (returns the same 20 msgs)
  - `limit=N` is ignored — always returns exactly 20 messages per page
  - `hasMore` is always `true` even when pagination is broken — don't rely on it alone
- **`--backfill` flag** for full-history gap recovery: disables early-stop, unchanged-thread skip, and timestamp post-filter; relies on ID-based dedup. `extract beeper --backfill --from 2023-01-01`

### GroupMe
- Token-only via the GroupMe REST API (`GROUPME_ACCESS_TOKEN`), no desktop app
- **First run should use `--backfill`** to pull full group/DM history; subsequent runs are incremental
- Thread IDs: `groupme:group:<id>` and `groupme:dm:<id>`

### Calls
- **`calls sync` only lists — it does NOT import.** Always use `calls import <id>` to add new calls.
- Pipeline: list Fireflies → identify new calls → `calls import <id>` → `calls summarize "<id>"` → `deep-context extract calls`
- Fireflies API has rate limits; import handles backoff
- Compare the Fireflies list against `calls list` to find unimported calls (match by Fireflies ID)

### Enrichment (Gemini)
- Model: `gemini-3-flash` (configurable in `config.json`)
- All schema fields must be marked `required` (Gemini silently skips optional fields)
- Do NOT set restrictive `--max-tokens` (output truncation)
- ~100 messages/batch, ~100 tokens/message output
- ~1M tokens/min limit; daily quota exists
- Include participant names in prompt for entity recognition (fixes spelling errors)
- Debug logs: `data/deep_context/debug/`

### Gmail
- Auto-detects `--from` date: 7 days before the newest gmail thread in DB (no need to pass `--from` manually)
- **Pass 1 (outbound):** `from:me -category:promotions -category:updates -category:social`
- **Pass 2 (inbound from known contacts):** `from:(<known emails>) -category:promotions -updates -social`, where the known-contact list is derived from people you've already corresponded with
- Upsert by comparing message counts (API vs DB) — catches new replies in existing threads
- Early termination: stops after 200 consecutive unchanged threads
- Auth tokens expire after ~1 hour — `gmail-extractor.ts` auto-refreshes before each extraction (no manual re-auth needed for cron)

### Slack (3-pass)
- Auto-detects `--from` date: 7 days before the newest slack thread in DB
- **Pass 1 (your messages):** `search.messages from:@YOUR_SLACK_USERNAME after:<date>`, sorted by timestamp (`--sort timestamp --sort-dir asc`), 6-month date chunks to work around Slack's 100-page search limit
- **Pass 2 (mentions):** threads where you're @-mentioned (per-workspace `mentionQueries` in `OWNER_CONFIG.slackIdentifiers`), excluding your own authored messages
- **Pass 3 (full capture):** every message in channels/users listed in `tools/slack-capture-config.json`
- Each workspace has a separate token: `SLACK_BOT_TOKEN_YOUR_WORKSPACE`
- 1.5s between API calls; exponential backoff for rate limits

### Slack (DMs)
- Auto-detects `--from` date: 7 days before the newest slack-dm thread in DB
- **Search-based discovery**: uses `search.messages from:@YOUR_SLACK_USERNAME after:<date>` to find active DM channels, then only fetches those (a handful vs. all channels)
- Filters to DM channels only: D-prefix (1:1) and mpdm-prefix (group DMs)
- **Incremental updates**: appends new messages to existing DM threads (not just new channels)
- All configured workspaces are searched using per-workspace search queries from `OWNER_CONFIG`

### Twitter
- **Two extraction methods**: archive (static, no credentials) + live (official X API v2)
- `extract twitter` runs both: archive first, then a live fetch (200 tweets by default)
- `extract twitter-live` runs live only (useful for quick daily catch-up)
- **Live fetch uses the official X API** via `tools/twitter-api.ts user-tweets` (requires `X_API_*` creds in `tools/.env`; create an app at developer.x.com). No scraping/cookies. If creds are absent, the live pass skips cleanly and the archive still imports.
- Live uses the same `twitter:{tweetId}` ID scheme as the archive — dedup is automatic
- Self-reply chains grouped into threads (`thread_type='thread'`) by post-processing
- Parent tweet stubs hydrated from `like.js` (liked tweets index, from the archive)

### SQLite
- WAL mode + `busy_timeout=30000` already configured
- Retry with exponential backoff on lock errors
- Close TablePlus/other DB viewers before running extractions
- Check locks: `lsof data/deep_context/deep_context.db`

---

## Error Handling

| Error | Action |
|-------|--------|
| Beeper Desktop not running | Skip beeper, warn user, continue other sources |
| Gemini 429 (quota exhausted) | Stop enrichment, report progress so far |
| Slack rate limit | Built-in backoff handles it; if persistent, report and continue |
| Gmail auth expired | Report error, suggest re-auth, continue other sources |
| Database locked | Retry with backoff; if persistent, suggest closing other DB connections |
| Calls import fails | Skip calls extraction, report error, continue |
| Any extraction fails | Log error, continue to next source, include in summary |

---

## Data Locations

| Resource | Path |
|----------|------|
| Database | `data/deep_context/deep_context.db` |
| Debug logs | `data/deep_context/debug/` |
| Contacts DB | `data/contacts.db` |
| Beeper config | `data/deep_context/beeper-config.json` |
| Slack full-capture config | `tools/slack-capture-config.json` |

## Scheduling (optional)

`tools/deep-context-cron.sh` runs this skill headlessly with whichever subscription CLI you have
(`claude` or `codex`; `DC_AGENT=` to choose), takes a lock so runs never overlap, then refreshes
the semantic index and (with `--todo`) runs a TODO scan from `prompts/todo-scan.md`. A macOS
launchd template is in `templates/com.deep-context.update.plist`; a crontab line works too.
2-3 runs a day is plenty. Logs: `logs/deep-context-cron.log`.

## The layer on top: summaries + wiki

This skill only keeps the raw knowledge base fresh. To turn it into narrative briefings and a
browsable knowledge wiki, see `WIKI.md` at the toolkit root and the `summarize-monthly` and
`wiki` skills. Pipeline: deep-context DB → `extract-for-summary` → `/summarize-monthly` →
`/wiki update`.

## What This Skill Does NOT Cover

- **Summarization/synthesis** — see the `summarize-monthly` skill (`extract-for-summary` produces input; LLM summarization is a separate step)
- **Wiki generation** — see the `wiki` skill
- **Twitter re-import** — manual process when you have a fresh archive
- **iMessage native extraction** — deprecated; Beeper handles iMessage incrementally now
