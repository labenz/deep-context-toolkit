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
| 1 | gmail | `deep-context extract gmail` | Google OAuth configured |
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
- Run via sub-agent (Task tool) to keep main context clean — extraction output is verbose
- Record: success/failure, items extracted, new threads/messages, errors
- On failure: log the error, continue to next source

### Phase 3: Enrichment

Skip this phase if `--skip-enrich` was specified.

**Important:** Only enrich threads that were newly extracted or updated in this run. This prevents the enrichment step from getting stuck on the massive backlog of old threads and blocking cron runs.

1. Determine enrichment limit:
   - Default: 200 threads
   - `--enrich-limit N`: Use N
   - `--full`: 500 threads
2. Record the timestamp from when Phase 2 started (ISO 8601 format, e.g. `2026-02-12T04:50:00Z`)
3. Run: `~/.bun/bin/bun tools/deep-context.ts enrich --limit <N> --extracted-since <phase2_start_timestamp>`
   - The `--extracted-since` flag scopes enrichment to only threads whose `extracted_at` >= the given timestamp
   - This ensures only content from the current extraction run gets enriched, not the full backlog
4. Run via sub-agent — enrichment is verbose and may take minutes
5. On Gemini 429 (quota exhausted): report progress so far, don't treat as failure

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

To run this on a schedule, wire it into your OS scheduler (e.g. a macOS launchd plist or a cron
job) that invokes the Claude CLI with `/update-deep-context`. Keep the schedule modest
(2-3x/day is plenty) and log output so you can spot silent failures.

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
