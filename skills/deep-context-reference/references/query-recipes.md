# Deep Context Query Recipes

Common patterns for searching the deep-context knowledge base (854K+ messages).

---

## Basic Query

```bash
deep-context query "search term"
```

The query engine uses SQL `LIKE %term%` matching against message content. This is keyword-based, not semantic -- exact substrings matter.

**Default behavior:** Returns 20 most recent matches, ordered by timestamp descending.

---

## Filtering by Source

```bash
deep-context query "project-name" --source gmail
deep-context query "episode" --source slack
deep-context query "lunch" --source beeper
deep-context query "GPT-5" --source twitter
deep-context query "alignment" --source podcast
deep-context query "follow up" --source calls
```

Valid sources: `gmail`, `slack`, `slack-dm`, `beeper`, `twitter`, `calls`, `podcast`

Note: `slack` and `slack-dm` are separate sources. Channel messages are `slack`; direct messages are `slack-dm`.

---

## Date Range Filtering

```bash
# Messages from a specific period
deep-context query "hiring" --from 2026-01-01 --to 2026-02-01

# Everything since a date
deep-context query "budget" --from 2026-03-01

# Combine with source
deep-context query "contract" --source gmail --from 2026-01-01 --limit 50
```

Date format: `YYYY-MM-DD`

---

## Adjusting Result Count

```bash
deep-context query "AI safety" --limit 50    # More results
deep-context query "meeting" --limit 5       # Fewer results
```

Default limit is 20.

---

## Browsing Without a Search Term: `recent`

When you want to see what has been happening without a specific keyword:

```bash
deep-context recent --hours 24                  # Last day, all sources
deep-context recent --hours 48 --source gmail   # Last 2 days, Gmail only
deep-context recent --hours 6 --limit 50        # Last 6 hours, more results
```

Shows thread summaries (not individual messages): source, timestamp, subject/title, message count, participants.

Default: 24 hours, 30 results.

---

## Finding Specific Conversations

### By person
```bash
deep-context query "John Smith" --source gmail
deep-context query "@johndoe" --source twitter
```

### By topic across sources
```bash
# Cast a wide net -- try multiple terms
deep-context query "acquisition offer" --limit 30
deep-context query "due diligence" --source gmail --limit 30
deep-context query "data room" --from 2026-01-01
```

### Twitter-specific patterns
```bash
# Search by a handle (without @)
deep-context query "somehandle" --source twitter

# Search by topic keywords
deep-context query "scaling laws" --source twitter --limit 30

# You may post multi-tweet threads -- a single query may only return one tweet.
# Search for @handles and key phrases separately to find all parts of a thread.
```

**Never use web search for Twitter.** X/Twitter blocks web indexing since 2023. Always use deep-context (or the official X API via tools/twitter-api.ts).

---

## Getting Thread Context

The `query` command returns individual messages. To see the full thread context around a result, note the `[source]` and timestamp, then use `recent` or query with more specific terms.

For direct database access (advanced), the thread ID format is `source:thread_id`. Messages within a thread have `position_in_thread` ordering.

---

## Search Strategy Tips

1. **Start broad, then narrow.** Try a general term first, then add `--source` or date filters.
2. **Try multiple phrasings.** SQL LIKE is literal -- "AI" won't match "artificial intelligence".
3. **Twitter threads are pre-grouped.** Self-reply chains have `thread_type='thread'`. Replies to others have stub messages at position 0 for context.
4. **Deep context first, live APIs second.** The DB has 854K+ messages and is fast. Only hit Beeper MCP, Slack API, Gmail API when results are clearly stale or the user wants real-time data.
5. **Extraction runs ~3x daily.** Messages from the last few hours may not be in the DB yet.
6. **For podcast content,** search with `--source podcast` for episode transcripts, or `--source twitter` for promotion threads about episodes.
