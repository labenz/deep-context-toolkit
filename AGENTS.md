# Deep Context Toolkit -- Claude Code Project Instructions

This is the Deep Context personal knowledge base system. It extracts communications from multiple sources (Gmail, Slack, Beeper, GroupMe, Twitter, Fireflies calls), enriches them with AI-generated metadata, and provides universal search and synthesis across all sources. An optional **wiki layer** (see `WIKI.md` and the `summarize-monthly` + `wiki` skills) builds monthly summaries and a knowledge wiki on top.

## Tools

All tools are Bun/TypeScript. Run with `bun tools/<tool>.ts` or `~/.bun/bin/bun tools/<tool>.ts`.

| Tool | Command | Purpose |
|------|---------|---------|
| Deep Context | `bun tools/deep-context.ts` | Main CLI: extract (incl. GroupMe), enrich, query, synthesize, todo, contacts |
| Gmail Extractor | `bun tools/gmail-extractor.ts` | Gmail extraction logic (called by deep-context); outbound + inbound-from-known passes |
| Slack | `bun tools/slack.ts` | Slack API client (channels, DMs, search) |
| Twitter | `bun tools/twitter-api.ts` | Official X API v2 client (user-tweets/liked-tweets/post/dm/etc.); live tweet fetch for extraction |
| Beeper | `bun tools/beeper.ts` | Beeper Desktop API (iMessage, WhatsApp, Signal) |
| Contacts | `bun tools/contacts.ts` | macOS Contacts lookup and export |
| Gemini | `bun tools/gemini.ts` | Gemini API client (used for enrichment and synthesis) |
| Calls | `bun tools/calls.ts` | Call transcript management |
| Fireflies | `bun tools/fireflies.ts` | Fireflies.ai API client (meeting transcripts; used by calls.ts) |
| Deepgram | `bun tools/deepgram.ts` | Deepgram API client (audio re-transcription; used by `calls retranscribe`) |
| Summarize | `bun tools/summarize.ts` | Multi-model summarization engine (wiki layer) |
| Anthropic | `bun tools/anthropic.ts` | Claude API client (summarization provider for summarize.ts) |
| OpenAI | `bun tools/openai.ts` | OpenAI API client (summarization provider for summarize.ts) |

> **GroupMe** has no separate tool — extraction lives inside `deep-context.ts` (`extract groupme`).
> **summarize.ts** auto-routes to `anthropic.ts` / `openai.ts` / `gemini.ts` based on the `--model` prefix.

## Database

- **Path:** `data/deep_context/deep_context.db` (SQLite, WAL mode)
- **Schema:** `data/deep_context/schema.sql`
- **Auto-created** on `deep-context init`

### Key Tables

| Table | Purpose |
|-------|---------|
| `threads` | Conversation containers (email threads, chats, tweet threads, calls) |
| `messages` | Individual messages within threads |
| `people` | Contacts extracted from communications |
| `message_metadata` | AI-enriched metadata (quality, topics, sentiment, originality, etc.) |
| `syntheses` | Generated summaries (timelines, relationships, projects) |
| `todo_items` | Action items auto-detected from messages |
| `unified_contacts` | Deduplicated contact records |
| `contact_links` | Maps `people` records to `unified_contacts` |
| `extraction_log` | Tracks when each source was last extracted |

### Useful Views

- `v_my_messages` -- Owner's messages with thread context
- `v_people_ranked` -- Contacts ranked by interaction volume
- `v_extraction_status` -- Last extraction time per source
- `v_unified_people` -- Combined unified + unlinked contacts

## Key Patterns

### OWNER_CONFIG

At the top of `tools/deep-context.ts`, the `OWNER_CONFIG` object holds all owner identity info:

```typescript
const OWNER_CONFIG = {
  personId: 'your-person-id',
  displayName: 'Your Name',
  emails: ['you@example.com'],
  twitterHandle: 'yourhandle',
  twitterId: '12345678',
  phone: '+1...',
  slackIdentifiers: {
    'workspace_name': { userId: 'UXXXXXXXX', searchQuery: 'from:@yourname', mentionQueries: ['@yourname'] }
  }
};
```

This is used throughout the codebase to identify which messages belong to the owner vs. other participants. It must be configured before first use. `gmail-extractor.ts` imports the same block. The `mentionQueries` per workspace drive the Slack "mentions" pass (threads where you're @-mentioned but haven't replied).

### Configuration Files

- **`data/deep_context/config.json`** -- Main configuration (extraction settings, enrichment model, privacy filters). Copy from `config.template.json`.
- **`data/deep_context/beeper-config.json`** -- Beeper privacy filtering (excluded contacts, service toggles). Copy from `beeper-config.template.json`.
- **`tools/.env`** -- All API keys and tokens. Loaded via `_lib/env.ts`.

### Secret Management

All secrets live in `tools/.env`. The env loader (`_lib/env.ts`) searches multiple locations with a fallback chain but the canonical location is `tools/.env`. Never commit `.env` files.

### Extraction Architecture

- Each source has its own extractor function in `deep-context.ts` (GroupMe included)
- Extractors are incremental: they auto-detect the last extraction date and only fetch new content
- Gmail and Slack auto-detect `--from` date (7 days before newest thread in DB)
- All data normalizes into the threads/messages/people schema
- Extractions should run sequentially (SQLite WAL handles concurrent reads but sequential writes avoid contention)

**Inbound coverage (not just the owner's outbound messages):**
- **Gmail — two passes:** Pass 1 = owner's sent mail (`from:me`); Pass 2 = inbound mail from *known contacts* (`buildContactInboundQuery()` derives the contact list from existing threads where the owner participated). Threads with `my_message_count = 0` now get stored.
- **Slack — three passes inside `extract slack`:** Pass 1 = owner's messages (`from:`); Pass 2 = threads where the owner is @-mentioned (`extractSlackMentions`, driven by `mentionQueries`); Pass 3 = full capture of channels/users in `tools/slack-capture-config.json` (`extractSlackChannelFull` via `loadSlackCaptureConfig`).
- **GroupMe** is token-only (`GROUPME_ACCESS_TOKEN`); first run should pass `--backfill`.

### Enrichment

- Uses Gemini (configured in `config.json`, default `gemini-3-flash`)
- Processes only the owner's messages (`is_from_me = 1`)
- Generates quality_score, originality_score, topics, sentiment, engagement, and more
- All enrichment schema fields must be marked `required` (Gemini silently drops optional fields)
- `--extracted-since` flag scopes enrichment to recently extracted content only (use it in cron runs to avoid re-processing the whole backlog)

### Wiki Layer

On top of the raw DB, the `summarize-monthly` and `wiki` skills build narrative monthly summaries and a two-repo (shared `wiki/` + private `data/deep_context/wiki-private/`) knowledge wiki. Engine: `tools/summarize.ts`. Index builder: `wiki/_build_index.ts`. Full architecture and setup: `WIKI.md`. The shared wiki is always *derived* from the private one by stripping source pointers, financials, medical specifics, and Private Notes.

### Contact Unification

Multi-stage dedup pipeline:
1. `contacts suggest` -- heuristic + optional LLM matching to find duplicate people
2. `contacts review` -- interactive review of suggestions
3. `contacts auto-accept --min-confidence 0.99` -- batch accept high-confidence matches
4. `contacts link` / `contacts reject` -- manual overrides

## Conventions

- **Use Bun for all TypeScript** -- never use Node directly
- **Use csv-parse for CSV operations** -- never parse CSV with string splitting, awk, or sed
- **Use `_lib/` utilities** -- `env.ts` for secrets, `google_oauth.ts` for Google auth, `paths.ts` for fuzzy path resolution, `http.ts` for HTTP requests
- **SQLite WAL mode** -- database is configured with WAL mode and `busy_timeout=30000`; retry with backoff on lock errors

## Runtime

- **Bun** is required. Install: `curl -fsSL https://bun.sh/install | bash`
- Bun installs to `~/.bun/bin/bun` and may not be in PATH
- Full path: `~/.bun/bin/bun tools/deep-context.ts <command>`
- Dependencies: `cd tools && bun install`

## Main Commands Reference

```bash
deep-context init                              # Create DB and directories
deep-context status                            # Extraction status and counts
deep-context extract <source>                  # Extract from a source
deep-context enrich --limit N                  # AI-enrich unprocessed messages
deep-context query "term" [--source S]         # Search across all sources
deep-context recent --hours N                  # Browse recent threads
deep-context synthesize <type>                 # Generate summaries
deep-context export <type> --output FILE       # Export data
deep-context extract-for-summary               # Generate LLM-ready summary doc
deep-context todo list|recap|strategic         # Action item tracking
deep-context contacts <subcommand>             # Contact unification
deep-context patch-html-emails                 # Clean up HTML email content
deep-context patch-slack-mentions              # Resolve Slack @mentions
```

## Setup Guidance

If the user asks to set up or configure the toolkit:

1. **Read `OWNER_CONFIG`** at the top of `tools/deep-context.ts` and help them fill in their identity info (person ID, display name, emails, Twitter handle, Slack user IDs)
2. **Create `tools/.env`** -- walk through each source they want to use and help them add the required API keys
3. **Google OAuth** -- guide them through creating a Google Cloud project, enabling Gmail API, creating OAuth credentials, and running the device auth flow
4. **Slack** -- help them create a Slack app with the required scopes and install it to their workspace(s)
5. **Copy config templates** -- `config.template.json` to `config.json`, `beeper-config.template.json` to `beeper-config.json`, and (if using Slack full-capture) `tools/slack-capture-config.template.json` to `tools/slack-capture-config.json`
6. **Run `deep-context init`** to create the database
7. **Test with `deep-context extract gmail`** as the first extraction
8. **Run `deep-context enrich --limit 50`** to verify enrichment works

Guide them interactively through each step. Not all sources are required -- Gmail alone provides significant value. Beeper, GroupMe, Twitter, and Calls can be added later. Once the knowledge base is populated, the optional **wiki layer** (`WIKI.md`, `summarize-monthly` + `wiki` skills) builds summaries and a knowledge wiki on top.
