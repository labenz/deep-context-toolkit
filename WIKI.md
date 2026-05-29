# The Wiki Layer

The deep-context database is excellent for *search*. The **wiki layer** turns that raw data
into durable, readable **knowledge** — a browsable set of articles about the people,
organizations, projects, and ideas in your life, written so an AI assistant (or a trusted
human assistant) can get rich context about you **without ever touching your raw inbox**.

This is the most valuable part of the toolkit, and also the most involved to set up. It's
optional — the knowledge base works fine without it — but if you want an assistant that
"already knows" your world, this is how you get there.

```
deep-context DB  →  extract-for-summary  →  /summarize-monthly  →  /wiki update  →  wiki articles
   (raw messages)     (monthly export)        (narrative summary)     (absorb)        (knowledge)
```

---

## The two-repo model (and why)

The wiki lives in **two** parallel trees:

| | Path | Contents | Who reads it |
|---|------|----------|--------------|
| **Private** | `data/deep_context/wiki-private/` | The source of truth. Full detail, source pointers back to messages, financial specifics, medical details, `## Private Notes`. | Only you (and Claude when working locally). **Never published.** |
| **Shared** | `wiki/` | A *derived* copy with all sensitive content stripped. | Autonomous agents, a trusted EA. Host on a **private** GitHub repo. |

Every shared article is generated *from* its private counterpart by removing sensitive content
(see "Sensitivity derivation" below). You never write the shared version by hand — the `wiki`
skill derives it. This lets you give an assistant broad, useful context while keeping the
genuinely private material out of reach.

Both trees use the same six categories: `people/`, `organizations/`, `projects/`,
`positions/`, `expertise/`, `timeline/`.

---

## The pipeline, step by step

### 1. Export a month of activity

```bash
~/.bun/bin/bun tools/deep-context.ts extract-for-summary \
  --from YYYY-MM-01 --to YYYY-MM-<last-day> \
  --output data/deep_context/summaries/monthly-exports/YYYY-MM.md
```

This pulls every thread you touched in the month into one large markdown export (often ~1M
tokens) with participant lists and source labels.

### 2. Summarize the month

The `summarize-monthly` skill compresses that export into a dense **15-20K word narrative
briefing** with 300+ precise `--source [...]` retrieval pointers (so a future agent can jump
straight back to the exact conversation). It uses a rolling window of recent prior-month
summaries as context, so each month builds on the last.

```bash
# Assemble the prompt (uses up to 6 prior months for context)
cd data/deep_context/summaries && ./build-prompt.sh YYYY-MM 6

# Generate the summary
~/.bun/bin/bun tools/summarize.ts run \
  --export data/deep_context/summaries/monthly-exports/YYYY-MM.md \
  --prompt data/deep_context/summaries/prompts/prompt-YYYY-MM.md \
  --system data/deep_context/summaries/prompts/system.md \
  --output data/deep_context/summaries/monthly-summaries/YYYY-MM.md \
  --model claude-sonnet-4-6 --thinking
```

For the **very first month** (no prior context), use `prompts/standalone-first-month.md` as
the `--prompt` instead of the assembled one. See the `summarize-monthly` skill for the full
workflow, quality thresholds, and validation checks.

Generic prompt templates ship in `data/deep_context/summaries/prompts/` — tune them to taste.

### 2b. (Optional) Roll a year up into an annual summary

Once you have a year's worth of monthly summaries, compress them into one higher-level,
era-defining narrative — the long-range context layer the wiki draws on. Feed that year's
monthly summaries in as the input and use the annual prompt:

```bash
# Concatenate the year's monthly summaries into one file, then summarize with the annual prompt
cat data/deep_context/summaries/monthly-summaries/YYYY-*.md > /tmp/YYYY-monthlies.md
~/.bun/bin/bun tools/summarize.ts run \
  --export /tmp/YYYY-monthlies.md \
  --prompt data/deep_context/summaries/prompts/annual-task-instructions.md \
  --system data/deep_context/summaries/prompts/system.md \
  --output data/deep_context/summaries/annual-summaries/YYYY.md \
  --model claude-sonnet-4-6 --thinking
```

The `wiki` skill reads `annual-summaries/YYYY.md` for long-range context when generating and
fact-checking articles.

### 3. Absorb the summary into the wiki

The `wiki` skill reads the new monthly summary, figures out which people/orgs/projects it
touches, and regenerates the affected articles (private first, then derives shared):

```
/wiki update          # absorb the latest monthly summary, regenerate affected articles
/wiki generate <name> # build one entity's article from scratch
/wiki validate        # privacy + quality checks on the shared wiki
/wiki audit           # fact-check claims across articles
/wiki rebuild-indexes # regenerate backlinks / entity registry / index pages
```

See the `wiki` skill for all commands and the article-generation rules.

---

## Three-tier source model

When articles cite or characterize something, they distinguish three tiers of evidence:

- **Tier 1 — original words.** Actual text from emails, DMs, Slack, tweets. Only Tier 1 may be
  quoted directly. Marked with `--source [...]`.
- **Tier 2 — private context.** Your own annotations and interpretations. Private articles
  only; marked with `--context [...]`.
- **Tier 3 — summaries.** The monthly/annual summaries. Useful for navigation, but **never
  quoted as anyone's words** (they're paraphrase, not speech).

This keeps the wiki honest: a quote in an article is always traceable to something a real
person actually wrote.

---

## Sensitivity derivation (private → shared)

When the `wiki` skill derives a shared article from a private one, it strips:

- `source_months:` YAML and all `--source [...]` / `--context [...]` inline annotations
- The `## Private Notes` section
- Specific personal dollar amounts (public business figures like valuations are OK)
- Clinical medical details (generalize to "health situation")
- Home address, credentials, intimate DM quotes
- Contact fields `notes` (subjective preferences) and `signal` (secure-comms preference)

`/wiki validate` greps the shared wiki for these patterns and should report **zero** leaks.
Maintain your own watchlist of sensitive terms (specific diagnoses, deal names, etc.) to scan
for, based on what shows up in your private wiki.

---

## First-time setup

1. **Populate the knowledge base first.** Run `/update-deep-context` (see the
   `update-deep-context` skill) until you have a good span of history extracted and enriched.
2. **Generate summaries.** Start with your earliest month using `standalone-first-month.md`,
   then work forward chronologically with `build-prompt.sh` so each month has prior context.
   This is the slow part — each month is ~25 min of model time. Run a backfill in batches.
3. **Pick your wiki slug + repos.**
   - The shared wiki starter is `wiki/`. Make it its own **private** git repo and push it
     somewhere your agents/EA can read (e.g. a private GitHub repo).
   - The private wiki is `data/deep_context/wiki-private/` — keep it local; never push it to a
     shared remote.
   - Your self-article will be `people/<your-slug>.md` (e.g. `people/me.md`).
4. **Generate articles.** Run `/wiki update` over your summaries (oldest → newest), or
   `/wiki generate <name>` for specific people to start. Then `/wiki rebuild-indexes` and
   `/wiki validate`.
5. **Keep it fresh.** Monthly: run `/summarize-monthly` for the new month, then `/wiki update`.

## Files

| What | Path |
|------|------|
| Summary engine | `tools/summarize.ts` |
| Summary prompt templates | `data/deep_context/summaries/prompts/` |
| Prompt assembler | `data/deep_context/summaries/build-prompt.sh` |
| Monthly exports / summaries | `data/deep_context/summaries/monthly-exports/`, `monthly-summaries/` |
| Generation assets | `data/deep_context/wiki-generation/` (`corrections.json`, `contact-lookup.json`) |
| Private wiki (source of truth) | `data/deep_context/wiki-private/` |
| Shared wiki (publishable) | `wiki/` |
| Index builder | `wiki/_build_index.ts` |
| Skills | `skills/summarize-monthly/`, `skills/wiki/` |
