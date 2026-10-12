# Deep Context Toolkit

A personal knowledge base system that extracts your communications from Gmail, Slack, Beeper (iMessage/WhatsApp/Signal), GroupMe, Twitter/X, and Fireflies call transcripts into a unified SQLite database. AI enrichment adds metadata (topics, sentiment, quality scores) to every message, and synthesis commands generate relationship summaries, timelines, and project overviews.

The goal: give your AI assistant deep, searchable context about your professional and personal communications.

Works with **Claude Code** or **Codex** — your existing Claude or ChatGPT subscription runs the setup, the scheduled refreshes, and the searches. The only API keys you need are the ones for the data sources you connect; the AI extras (enrichment, semantic search, reranking) are optional and degrade gracefully.

On top of the raw knowledge base, an optional **wiki layer** turns the data into monthly narrative briefings and a browsable, two-repo (shared/private) knowledge wiki — see [WIKI.md](WIKI.md).

## What's new (October 2026)

- **No-OAuth start: Google Takeout import** — `deep-context import-takeout <takeout.zip>` loads your Gmail (mbox) and Google Calendar (.ics) export with no Google Cloud project, no OAuth client, no tokens. Streams multi-GB mailboxes, resumable, idempotent, and lines up row-for-row with the Gmail API extractor so you can switch to live extraction later without duplicates. See [Start without OAuth: Google Takeout](#start-without-oauth-google-takeout).
- **Semantic + hybrid search** — `query --semantic` finds conversations by meaning, `--hybrid` merges keyword and semantic hits. Embeddings via Gemini (`gemini-embedding-2`) **or free and fully local via Ollama**; optional Voyage `rerank-3` pass for sharper top results. Stored in a separate sidecar DB; the main DB is never touched.
- **Enrichment v2** — better default model (`gemini-3.7-flash`), indexed `[MSG n]` prompts that stop ID mix-ups, stricter entity grounding, retries on truncated output, windowing for huge threads, per-batch saves, and a clean skip when no Gemini key is configured.
- **Agent-authorship tagging** — list the addresses your AI agents send from (`OWNER_CONFIG.agentEmails`) and their mail is tagged `authored_by=<agent>`, so "my own writing" stays yours.
- **Multiple Google accounts** — `extract gmail --account work` pulls a second mailbox into its own source with its own watermark and tokens; first interactive run opens Google sign-in.
- **TODO upgrades** — `todo expire` soft-expires stale incoming requests (reversible, never deletes); `todo update --reason` no longer breaks on apostrophes (it was building SQL by string concatenation); a ready-made scan prompt in `prompts/todo-scan.md`.
- **`dropped-balls.ts`** — email threads where the last word is theirs, flagged 🔥 when you'd replied earlier and then went quiet.
- **`export-public`** — builds a public-only (default: podcast + your tweets) full-text DB you can hand to low-access agents on another machine.
- **Scheduled refresh on your subscription** — `tools/deep-context-cron.sh` runs the update skill headlessly with `claude` or `codex`, with locking, a deadline, an embedding refresh and an optional TODO scan; launchd template included.
- **Fixes** — Gmail owner detection now uses exact addresses (the old substring match could swallow relatives/colleagues with similar addresses), phone-number chat titles resolve to contact names when printed, Beeper cursor pagination, Claude 5 "thinking" requests in `anthropic.ts`, orphaned temp files in `summarize.ts`, a missing Twitter archive is now a skip rather than an error.
- **Works in Codex too** — `AGENTS.md` is the canonical agent guide (`CLAUDE.md` imports it), and skills are linked into both `.claude/skills` and `.agents/skills`.

## Architecture

The system follows a three-stage pipeline:

1. **Extract** -- Pull messages from each source into a normalized schema (threads + messages + people)
2. **Enrich** *(optional)* -- AI metadata generation (via Gemini) scores each of your messages for quality, originality, topics, sentiment, and more; an optional embedding index adds meaning-based search
3. **Synthesize** -- Higher-level summaries: relationship profiles, project timelines, communication preferences, thinking patterns

All data lives in a single SQLite database with WAL mode for concurrent reads.

## How your agent uses this (the access model)

There's **no MCP server** here, and you don't need one. An AI agent reaches the data through three plain mechanisms — and the distinction that makes the whole thing work is **search vs. standing context**:

1. **The CLI is the search layer.** The agent shells out to `deep-context.ts` over Bash — `deep-context query "term" --source gmail --limit 20`, `deep-context recent --hours 24`, `deep-context synthesize relationships --person jane-doe`. It's a thin, composable wrapper over the SQLite DB so the agent writes commands instead of hand-rolling SQL, and the good default joins/ranking live in one place. You *could* point an agent straight at the raw `.db`, but the CLI keeps queries consistent and stops the agent from rediscovering the schema every session.

2. **`AGENTS.md`/`CLAUDE.md` + the skills teach the agent the system exists.** This is the part people skip: the access mechanism isn't the database — it's *telling the agent the database exists and how you want it queried*. The repo's [`AGENTS.md`](AGENTS.md) (imported by [`CLAUDE.md`](CLAUDE.md)) documents the command vocabulary and auto-loads as project instructions in Codex and Claude Code; the `skills/` (`update-deep-context`, `deep-context-reference`, `summarize-monthly`, `wiki`) auto-discover via `.claude/skills` / `.agents/skills` and encode the multi-step procedures. That's the entire "integration."

3. **The wiki is the standing-context layer — plain markdown the agent reads directly.** The DB is for *retrieval when you need it*. The highest-value context is the stuff you want the agent to **already know** without querying: who the people in your life are, what your projects are, your positions and history. That's the wiki — a browsable set of articles generated *from* the DB (see [WIKI.md](WIKI.md)). The agent just reads those files. No query, no MCP, just markdown on disk:

   ```
   DB  →  monthly summary  →  wiki articles the agent reads as plain files
   (search layer)               (standing-context layer)
   ```

The payoff is the combination: the wiki gives the agent broad, durable context about your world, and the CLI lets it drill back down to the exact original message when it needs a specific fact or quote. The two-repo split in the wiki layer (a private source-of-truth tree and a *derived* shared tree with the sensitive material stripped) is what lets you hand an autonomous agent — or a trusted assistant — useful context without ever exposing the raw inbox.

## Sources

| Source | What it captures | Auth method |
|--------|-----------------|-------------|
| **Gmail** | Email you sent **plus inbound mail from known contacts** | Google OAuth (gmail.readonly) **or** a Google Takeout export (no OAuth) |
| **Google Calendar** | Events (title, time, attendees, your RSVP, location, description) | Google Takeout export (no OAuth) |
| **Slack** | Your messages, threads you're @-mentioned in, and full-capture channels — across workspaces, including DMs | Slack Bot Token per workspace |
| **Beeper** | iMessage, WhatsApp, Signal conversations | Beeper Desktop API token |
| **GroupMe** | Group and DM messages | GroupMe access token (no app) |
| **Twitter/X** | Your tweets, replies, quote tweets, threads | Archive import (no creds) + official X API v2 (live) |
| **Calls** | Meeting transcripts from Fireflies.ai | Fireflies API key |

Each source supports incremental extraction -- after the first full run, subsequent extractions only fetch new content.

### Inbound coverage (capturing what comes *to* you)

Early versions captured mostly your *outbound* messages. The system now also captures credible *inbound* communication, so threads from people who matter aren't lost just because you didn't reply:

- **Gmail** runs two passes: your sent mail (`from:me`) **and** inbound mail *from contacts you've corresponded with* (derived automatically from your existing threads).
- **Slack** runs three passes: your messages, threads where you're **@-mentioned** but haven't replied, and **full capture** of any channels you list in `tools/slack-capture-config.json` (copy `slack-capture-config.template.json` to enable).

## Quick Start

1. Clone this repo: `git clone https://github.com/labenz/deep-context-toolkit.git && cd deep-context-toolkit`
2. Install Bun: `curl -fsSL https://bun.sh/install | bash`
3. Install dependencies: `cd tools && bun install && cd ..`
4. (macOS, for semantic search) `brew install sqlite`
5. Open **Claude Code** (`claude`) or **Codex** (`codex`) in this directory and say:

```
"I just cloned the deep-context toolkit. Help me configure it for my
accounts: fill in OWNER_CONFIG, then (1) Google OAuth for Gmail,
(2) my Slack workspaces, (3) optionally Beeper, Twitter, and Fireflies.
Start by reading AGENTS.md, README.md and .env.example, then guide me
through setup interactively. Run init and a first Gmail extraction when
we're done, and show me a few searches."
```

No appetite for Google Cloud setup? Say instead: *"Help me import my Google Takeout export (see README → Start without OAuth)"*, and add OAuth later.

6. Optional extras, in order of value: schedule refreshes (`tools/deep-context-cron.sh`), semantic search (`embed-backfill`), enrichment (`GEMINI_API_KEY`), the wiki layer ([WIKI.md](WIKI.md)).

## Start without OAuth: Google Takeout

Setting up Google OAuth (a Cloud project, a consent screen, a client ID) is the hardest part of getting started. You can skip it entirely: ask Google for an export of your mail and calendar, and import the file. Later you can add OAuth for daily incremental updates. The two paths use the same IDs, so nothing gets duplicated.

### 1. Request the export (5 minutes, then wait)

1. Go to **https://takeout.google.com** and sign in with the account you want to import.
2. Click **Deselect all** at the top of the product list. You only want two products.
3. Scroll to **Calendar** and tick it. Its format is iCalendar (`.ics`); leave that as is.
4. Scroll to **Mail** and tick it. The format is **MBOX**, which is what we need. "All Mail data included" is fine. Spam and Trash come along, and the importer skips them.
5. Click **Next step** at the bottom.
6. Destination: **Send download link via email**. Frequency: **Export once**. File type: **.zip**. File size: choose the **largest size offered** (e.g. 50 GB) so your mailbox stays in one file.
7. Click **Create export**.

Google emails you when the export is ready ("Your Google data is ready to download"). That takes **a few hours for most people, sometimes a day or two** for very large mailboxes. Google's wording on these screens changes from time to time; the choices are the same. Work/school (Google Workspace) accounts: your administrator may have disabled Takeout.

### 2. Download

Open the email, click **Download your files**, and sign in again when asked. The links expire after about a week. You'll get one or more files named like `takeout-20261012T120000Z-001.zip`. There's no need to unzip them.

### 3. Import

```bash
# Fast first pass: just the last 30 days (orientation in minutes)
bun tools/deep-context.ts import-takeout ~/Downloads/takeout-*.zip --since 2026-09-12   # = 30 days ago

# Then the full history (resumable: Ctrl-C any time, re-run the same command to continue)
bun tools/deep-context.ts import-takeout ~/Downloads/takeout-*.zip
```

What gets imported follows the same policy as live Gmail extraction:
- every thread you wrote in, excluding Promotions, Updates and Social;
- inbound threads from people who appear in those threads;
- calendar events, which you can search with `query <term> --source calendar`.

Spam, Trash, Drafts and Chats are skipped. Attachments are flagged (`has_attachments`) but not stored. Addresses listed in `config.json` → `privacy.excluded_emails` are never imported.

If you haven't filled in `OWNER_CONFIG.emails` yet, the importer works out your addresses from your Sent mail and tells you what to add. You can also pass `--me you@example.com`. A second Google account goes in with `--account work`, which stores it as `source='gmail-work'`, the same convention `extract gmail --account work` uses.

The importer stages parsed mail in `data/deep_context/takeout/staging-<account>.db`. This file is what makes a re-run instant. Delete it once you're done. Full options: `bun tools/import-takeout.ts --help`.

### Keys: required vs optional

| Capability | Needs | Without it |
|---|---|---|
| Gmail extraction (live, incremental) | Google OAuth client (`GOOGLE_CLIENT_ID/SECRET`) | use a Google Takeout export (`import-takeout`) instead |
| Gmail + Calendar history import | a Google Takeout `.zip` — nothing else | — |
| Slack / Beeper / GroupMe / Fireflies / X live | that source's token | source is skipped |
| Keyword search, `recent`, todos, exports, dropped-balls | nothing | — |
| Scheduled refresh | a Claude Code or Codex subscription (CLI installed) | run `/update-deep-context` by hand |
| Enrichment (quality/topics/sentiment) | `GEMINI_API_KEY` | `enrich` skips cleanly |
| Semantic / hybrid search | `GEMINI_API_KEY` **or** local Ollama (`DEEP_CONTEXT_EMBED_PROVIDER=ollama`, `ollama pull nomic-embed-text`) | keyword search only |
| Rerank of semantic results | `VOYAGE_API_KEY` | vector order |
| Wiki layer summaries | your agent session (or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY` for `summarize.ts` batch runs) | — |

## Prerequisites

- **Bun** (TypeScript runtime) -- `curl -fsSL https://bun.sh/install | bash`
- **Google Cloud OAuth credentials** -- for live Gmail access (gmail.readonly scope, device auth flow). *Optional if you start from a Google Takeout export.*
- **Slack Bot Token(s)** -- one per workspace, with channels:history, channels:read, search:read, users:read scopes
- **Beeper Desktop** (optional) -- with Developer API enabled for iMessage/WhatsApp/Signal
- **GroupMe access token** (optional) -- create an app at dev.groupme.com; token-only, no desktop app
- **Twitter/X** (optional) -- archive import (download from x.com/settings, no credentials needed) and/or live fetch via the official X API v2 (create an app at developer.x.com, set the `X_API_*` keys)
- **Fireflies API key** (optional) -- requires Business plan for transcript access
- **Gemini API key** (optional) -- enrichment (`gemini-3.7-flash`), synthesis, and default embeddings for semantic search
- **Ollama** (optional) -- free local embeddings for semantic search instead of Gemini
- **Voyage API key** (optional) -- rerank for semantic search
- **Homebrew SQLite** (macOS, for semantic search) -- `brew install sqlite`; Apple's built-in SQLite can't load the sqlite-vec extension
- **Anthropic API key** (optional) -- for the wiki layer (summaries + article generation) and LLM contact matching
- **macOS recommended** -- Beeper Desktop and macOS Contacts integration are macOS-native

## File Structure

```
deep-context-toolkit/
  tools/
    deep-context.ts          # Main CLI -- all commands run through here (GroupMe extraction lives here too)
    deep-context-semantic.ts # Embeddings (Gemini / Ollama), sqlite-vec index, optional Voyage rerank
    deep-context-cron.sh     # Scheduled refresh via your Claude Code / Codex subscription
    dropped-balls.ts         # Email threads awaiting your reply
    gmail-extractor.ts       # Gmail extraction logic (outbound + inbound-from-known passes)
    import-takeout.ts        # Google Takeout importer (Gmail mbox + Calendar .ics), no OAuth
    slack.ts                 # Slack API client
    twitter-api.ts           # Twitter/X official API v2 client (live tweet fetch)
    beeper.ts                # Beeper Desktop API client
    calls.ts                 # Call transcript management (Fireflies)
    contacts.ts              # macOS Contacts integration
    fireflies.ts             # Fireflies.ai API client (used by calls.ts)
    deepgram.ts              # Deepgram API client (audio re-transcription, optional)
    gemini.ts / anthropic.ts / openai.ts   # LLM provider clients (enrichment, synthesis, summaries)
    summarize.ts             # Multi-model summarization engine (wiki layer)
    slack-capture-config.template.json  # Full-capture channel list (copy to enable)
    package.json             # Dependencies
    _lib/                    # Shared utilities (env, oauth, http, contact matching, ...)
  data/
    deep_context/
      schema.sql             # Database schema (auto-applied on init)
      validation_queries.sql # Diagnostic queries
      config.template.json   # Configuration template
      beeper-config.template.json  # Beeper privacy filter template
      deep_context.db        # SQLite database (created on first run)
      summaries/             # Monthly/annual summary pipeline (wiki layer)
        prompts/             # Generic summary prompt templates
        build-prompt.sh      # Assembles a month's prompt with rolling context
      wiki-generation/       # corrections.json, contact-lookup.json (generation assets)
      wiki-private/          # PRIVATE wiki (source of truth; never published)
  wiki/                      # SHARED wiki repo starter (publishable; host on a private GitHub repo)
    _build_index.ts          # Rebuilds backlinks / entity registry / index pages
  skills/                    # (linked as .claude/skills and .agents/skills)
    update-deep-context/     # Keep the knowledge base fresh (extract + enrich + embed)
    deep-context-reference/  # Command/query reference the agent consults when searching
    summarize-monthly/       # Generate monthly narrative briefings
    wiki/                    # Build & maintain the knowledge wiki
  prompts/todo-scan.md       # Headless TODO-detection prompt (used by the cron wrapper --todo)
  templates/                 # launchd plist for scheduled refreshes
  AGENTS.md / CLAUDE.md      # Agent instructions (Codex / Claude Code)
  WIKI.md                    # The wiki layer: architecture + setup guide
```

## Key Commands

All commands use: `bun tools/deep-context.ts <command>`

```bash
# First-time setup
deep-context init                    # Create database and directory structure

# Status
deep-context status                  # Show extraction status, counts, staleness

# Extraction
deep-context extract gmail           # Extract Gmail (outbound + inbound-from-known passes)
deep-context import-takeout takeout.zip [--since DATE]   # Gmail + Calendar from Google Takeout, no OAuth
deep-context extract slack           # Extract Slack (your msgs + mentions + full-capture channels)
deep-context extract slack-dm        # Extract Slack DMs
deep-context extract beeper          # Extract Beeper messages
deep-context extract groupme         # Extract GroupMe (use --backfill on first run)
deep-context extract twitter         # Import Twitter archive + live fetch
deep-context extract calls           # Extract call transcripts

# Enrichment (optional; needs GEMINI_API_KEY)
deep-context enrich --limit 200 --from 2026-10-01   # AI-enrich owner messages in threads active since a date

# Semantic search index (optional; Gemini or local Ollama)
deep-context embed-backfill --dry-run                # chunk count + cost estimate
deep-context embed-backfill --max-cost 2             # build it (resumable)
deep-context embed-update                            # add anything new
deep-context embed-status                            # coverage

# Search
deep-context query "search term"     # Keyword search across all sources
deep-context query "an idea, in other words" --semantic   # meaning-based
deep-context query "topic" --hybrid  # keyword + semantic, merged
deep-context query "term" --source gmail --limit 20
deep-context recent --hours 24       # Browse recent threads without a search term
bun tools/dropped-balls.ts --days 30 # Email threads awaiting your reply

# Synthesis
deep-context synthesize timeline --from 2025-01-01 --to 2025-12-31
deep-context synthesize relationships --person jane-doe
deep-context synthesize projects
deep-context synthesize preferences
deep-context synthesize thinking

# Export
deep-context export people --output people.json
deep-context extract-for-summary --from 2025-01-01 --to 2025-06-30
deep-context export-public --push agent@other-mac:~/.agent-data   # public-only DB for low-access agents

# Todo tracking (auto-detected from messages)
deep-context todo list               # View detected action items
deep-context todo recap --since 24   # Last 24 hours of action items
deep-context todo strategic          # Birds-eye organizational analysis
deep-context todo expire --dry-run   # Stale incoming requests that would be soft-expired

# Contact unification
deep-context contacts status         # Show dedup progress
deep-context contacts suggest        # Find potential duplicate contacts
deep-context contacts review         # Interactive review of suggestions
```

## Configuration

### config.json

Copy `data/deep_context/config.template.json` to `data/deep_context/config.json` and customize:

- **privacy** -- emails, phone patterns, and names to exclude globally
- **extraction** -- per-source settings (Slack workspaces, Twitter archive path, etc.)
- **enrichment** -- AI model and batch size for metadata generation
- **public_sources** -- the only sources `export-public` will ever copy (default podcast + twitter)
- **synthesis** -- AI model for higher-level summaries

### beeper-config.json

Copy `data/deep_context/beeper-config.template.json` to `data/deep_context/beeper-config.json` to configure:

- Contacts to exclude from extraction
- Which messaging services to enable/disable (iMessage, WhatsApp, Signal, etc.)

### .env

Create `tools/.env` with your API keys and tokens. Required variables depend on which sources you use:

```bash
# Google OAuth (required for Gmail)
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_TOKEN=
GOOGLE_REFRESH_TOKEN=

# Slack (one token per workspace)
SLACK_BOT_TOKEN_MYWORKSPACE=xoxb-...

# Gemini (optional -- enrichment, synthesis, default semantic-search embeddings)
GEMINI_API_KEY=

# Semantic search (optional): local embeddings instead of Gemini, and reranking
# DEEP_CONTEXT_EMBED_PROVIDER=ollama
VOYAGE_API_KEY=

# Beeper (optional)
BEEPER_ACCESS_TOKEN=

# GroupMe (optional -- token from dev.groupme.com)
GROUPME_ACCESS_TOKEN=

# Twitter / X (optional -- official X API v2; archive import needs no creds)
X_API_CONSUMER_KEY=
X_API_CONSUMER_SECRET=
X_API_ACCESS_TOKEN=
X_API_ACCESS_TOKEN_SECRET=
X_API_BEARER_TOKEN=

# Fireflies (optional)
FIREFLIES_API_KEY=

# Anthropic (optional -- wiki layer summaries + article generation, LLM contact matching)
ANTHROPIC_API_KEY=
```

### OWNER_CONFIG

In `tools/deep-context.ts`, the `OWNER_CONFIG` block at the top of the file must be filled in with your identity information (name, **every email address you send from** — matching is exact — Twitter handle, Slack user IDs + per-workspace search/mention queries, and optionally `agentEmails` for addresses your AI agents send from). This is how the system knows which messages are yours vs. other participants'. The `gmail-extractor.ts` imports this same block.

## The Wiki Layer (optional, but the most valuable part)

The raw database is great for search. The **wiki layer** turns it into durable, readable knowledge:

```
deep-context DB  →  extract-for-summary  →  /summarize-monthly  →  /wiki update  →  wiki articles
```

1. **Monthly summaries** — `summarize-monthly` compresses each month of activity into a dense, 15-20K-word narrative briefing with hundreds of precise retrieval pointers back to the source messages.
2. **The wiki** — `wiki` absorbs those summaries into a browsable set of articles (people, organizations, projects, positions, expertise, timeline) across **two repos**: a **shared** wiki (`wiki/`, safe for agents/an assistant to read) and a **private** wiki (`data/deep_context/wiki-private/`, the full-detail source of truth that's never published). The shared article is always *derived* from the private one by stripping sensitive content.

This is what lets an AI assistant get rich context about you without ever touching your raw inbox. See **[WIKI.md](WIKI.md)** for the full architecture and first-time setup, and the `summarize-monthly` and `wiki` skills for the commands.

## Scheduling

`tools/deep-context-cron.sh` keeps the knowledge base fresh without API-key billing for the agent: it runs the `update-deep-context` skill through your installed `claude` (or `codex`, via `DC_AGENT=codex`) CLI, so it uses your subscription. It holds a lock, enforces a wall-clock deadline, refreshes the embedding index, and with `--todo` runs a TODO scan. Install the launchd job from `templates/com.deep-context.update.plist` (instructions inside) or add a crontab line. Logs go to `logs/deep-context-cron.log`.

## Database

The SQLite database is auto-created at `data/deep_context/deep_context.db` when you run `deep-context init`. The schema is defined in `data/deep_context/schema.sql`.

Key tables:
- **threads** -- Conversation containers (email threads, chat conversations, tweet threads, calls)
- **messages** -- Individual messages within threads
- **people** -- Contacts extracted from communications
- **message_metadata** -- AI-generated enrichment (quality, topics, sentiment, etc.)
- **messages.authored_by** -- whose words a message is (agent-sent mail is tagged; NULL = not judged)
- **syntheses** -- Generated summaries (timelines, relationship profiles, etc.)
- **todo_items** -- Action items auto-detected from messages
- **unified_contacts** -- Deduplicated contact records

Semantic search keeps its vectors in a separate sidecar file (`deep_context_vectors_<provider>.db`) so the main database is never modified by indexing.

The database uses WAL mode for concurrent read access. Close other database viewers before running extractions to avoid write contention.
