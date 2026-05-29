---
name: wiki
description: Maintain a personal knowledge wiki built on top of the deep-context knowledge base — a two-repo (shared/private) system of articles derived from monthly/annual summaries. Use to generate, update, correct, validate, and audit wiki articles.
---

# Wiki Maintenance Skill

Maintain a personal knowledge wiki — a two-repo system of articles across 6 categories
(people, organizations, projects, positions, expertise, timeline), derived from the monthly
and annual summaries produced by the `summarize-monthly` skill (see `WIKI.md` for the optional
annual-rollup step). The wiki is the human- and
agent-readable layer on top of the raw deep-context database: it lets an assistant get rich
context about the owner without touching raw, sensitive messages.

> All paths below are relative to the toolkit root unless absolute. See `WIKI.md` at the
> toolkit root for the end-to-end architecture and first-time setup.

## Architecture Quick Reference

- **Shared wiki:** `wiki/` — the publishable repo (host on a PRIVATE GitHub repo, e.g.
  `<your-username>/<your-wiki>`). Safe for autonomous agents and a trusted EA to read. No
  source pointers, no financials, no medical specifics, no Private Notes.
- **Private wiki:** `data/deep_context/wiki-private/` — the source of truth. Full source
  pointers, sensitive details, Private Notes. NEVER published.
- **Generation assets:** `data/deep_context/wiki-generation/` (`corrections.json`,
  `contact-lookup.json`).
- **Source data:** `data/deep_context/summaries/` (monthly + annual summaries).
- **Index builder:** `wiki/_build_index.ts`.

The shared article is always *derived* from the private article by stripping sensitive
content (see Sensitivity Derivation below).

## Commands

### `/wiki status`

Report current state: article counts by category, last update date, pending items in
`agent-notes/`, any unprocessed corrections.

```bash
# Quick counts
find wiki -name '*.md' -not -name '_*' -not -name 'README.md' -not -path '*/agent-notes/*' | wc -l
```

### `/wiki update`

Absorb a new monthly summary after it's been generated via `/summarize-monthly`.

**Flow:**

1. Read the new monthly summary from `data/deep_context/summaries/monthly-summaries/YYYY-MM.md`
2. Identify all people, organizations, and projects mentioned
3. Cross-reference against `wiki/_entity-registry.json` to find existing articles
4. For entities with existing articles: spawn sub-agents (3-5 in parallel) to regenerate articles
   - Each sub-agent reads: the entity's current private article, the new monthly summary, relevant annual summary, and `corrections.json`
   - Writes updated private article to `wiki-private/`, then derives shared version
5. Update the self-article's "What's Happening Now" section (see `/wiki update-self` below)
6. For new entities (not in registry): evaluate significance — if 3+ substantial mentions or obviously important, generate new articles
7. Check `agent-notes/` for items flagged `**Promote to wiki:** yes` — present to the owner for review
8. Apply any pending corrections from `corrections.json` that haven't been processed
9. Rebuild indexes: `cd wiki && ~/.bun/bin/bun _build_index.ts`
10. Run validation (see `/wiki validate`)
11. Commit and push the shared wiki: `cd wiki && git add . && git commit -m "Update: absorb YYYY-MM summary" && git push`
12. Report: N articles updated, M new articles created, validation results

**Sub-agent prompt template for article regeneration:**

> You are regenerating a wiki article for [ENTITY]. Read:
> 1. Current private article: `data/deep_context/wiki-private/[category]/[slug].md`
> 2. New monthly summary: `data/deep_context/summaries/monthly-summaries/YYYY-MM.md`
> 3. Annual summary for context: `data/deep_context/summaries/annual-summaries/YYYY.md`
> 4. Corrections: `data/deep_context/wiki-generation/corrections.json` — check for any entries matching this entity
> 5. Contact lookup: `data/deep_context/wiki-generation/contact-lookup.json` — merge any contact info into the `contact:` YAML block
>
> Update the private article with any new information from the monthly summary. Ensure the `contact:` block includes ALL known contact modes (email, phone, signal, twitter, linkedin, slack, website). Then derive the shared version by stripping:
> - `source_months:` from YAML
> - All `--source [...]` and `--context [...]` inline annotations
> - The `## Private Notes` section
> - Specific dollar amounts from private financial arrangements
> - Clinical medical details (generalize to "health situation" etc.)
> - Contact fields `notes` and `signal` (private-only)
>
> Write updated private article to `wiki-private/[category]/[slug].md`
> Write updated shared article to `wiki/[category]/[slug].md`
>
> Rules:
> - Three-tier source model: only quote Tier 1 (original words). Never quote summaries.
> - Commitments vs. completed actions: if something was planned but never happened, say so.
> - corrections.json overrides any summary characterization.
> - Never remove existing contact info — only add or merge new data.

### `/wiki update-self`

Ad-hoc refresh of the self-article's "What's Happening Now" section.

**Flow:**

1. Read the current private self-article: `data/deep_context/wiki-private/people/<owner-slug>.md` (your own slug, e.g. `people/me.md`)
2. Read the most recent monthly summary for latest context
3. Read any current-priorities notes you keep for the owner
4. Optionally read recent `agent-notes/sessions/` for work context
5. Regenerate only the "What's Happening Now" section (below the `<!-- STABLE SECTION BOUNDARY -->` comment)
6. Update the knowledge cutoff date in the blockquote at the top of WHN to today's date
7. Derive the shared version's "What's Happening Now" section (strip private details)
8. Do NOT modify anything above the stable section boundary

### `/wiki correct`

Add a ground-truth correction and apply it.

**Flow:**

1. The owner describes the error (e.g., "Company X did not invest in Company Y")
2. Read current `data/deep_context/wiki-generation/corrections.json`
3. Add structured entry:
   ```json
   {
     "entity": "[category]/[slug]",
     "correction": "[what's actually true]",
     "date": "YYYY-MM-DD",
     "supersedes": ["[what this overrides]"]
   }
   ```
4. Spawn sub-agent to regenerate the affected article(s) with correction applied
5. If the error originated in source summaries (not just article-layer), surgically edit the relevant monthly/annual summaries
6. Rebuild indexes
7. Commit and push
8. Report what changed

### `/wiki validate`

Run privacy and quality validation on the shared wiki. This is agent-based — read the
articles and check for violations rather than running a rigid script.

**Checks:**

1. **Source pointers:** Grep for `--source [` in `wiki/` — should be 0 matches
2. **Context annotations:** Grep for `--context [` in `wiki/` — should be 0 matches
3. **source_months field:** Grep for `source_months:` in `wiki/` YAML — should be 0 matches
4. **Private Notes section:** Grep for `## Private Notes` in `wiki/` — should be 0 matches
5. **Medical terms:** Grep the shared wiki for specific clinical terms — particular diagnoses, treatments, lab/test names, or medication names tied to the owner or their family. Personal medical specifics should be 0; generic discussion of health topics in a professional/AI context is OK. (Maintain your own watchlist of terms to scan for, based on what appears in the private wiki.)
6. **Dollar amounts:** Grep for `\$[0-9]` in shared wiki — review each match. Personal compensation/deal terms should be generalized; public business figures (company valuations, fundraise sizes) are OK.
7. **Interpretation markers:** Grep for `--interpretation` — should be resolved to prose
8. **Link integrity:** Check that all `[text](../path.md)` links resolve to existing files
9. **Cross-reference density:** Flag articles with fewer than 2 outgoing links
10. **Private-shared parity:** Count articles in both repos — should match

Report violations and offer to fix them.

### `/wiki audit`

Run a fact-checking audit using agent-based reasoning. NOT a script — spawn sub-agents that
read articles and reason about claims.

**Usage:** `/wiki audit [category]` or `/wiki audit [specific-article]`

**Audit agent prompt template:**

> Read all articles in `wiki/[category]/`. For each article, identify specific factual claims — especially:
> - Investment/financial claims ("X invested in Y", "X backed Y")
> - Founding/role claims ("X founded Y", "X serves as Y at Z")
> - Relationship claims ("X and Y are close", "X introduced Y to Z")
> - Event/timeline claims (specific dates, sequences of events)
>
> For each claim, assess whether it's:
> (a) Directly supported by source material (annual/monthly summaries)
> (b) A reasonable inference but not explicitly stated
> (c) Potentially wrong (contradicted by other articles or unsupported)
> (d) A commitment/plan described as a completed action
>
> Cross-check claims across articles — if article A says "X invested in Y" but article Y doesn't mention X, flag the discrepancy.
>
> Read relevant annual summaries to verify key claims: `data/deep_context/summaries/annual-summaries/`
>
> Report findings as markdown organized by severity:
> - **Likely errors** (category c — should be corrected)
> - **Unverified claims** (category b — need the owner's input)
> - **Consistency issues** (cross-reference discrepancies)

**Audit categories to prioritize:**
1. Investment/financial claims (highest risk — easy to state an investment that was discussed but never happened)
2. Cross-reference consistency
3. Commitment vs. completed action
4. Role/organizational claims

### `/wiki rebuild-indexes`

Regenerate all index infrastructure.

```bash
cd wiki && ~/.bun/bin/bun _build_index.ts
```

This rebuilds `_backlinks.json`, `_entity-registry.json`, and all `_index.md` files.

### `/wiki generate <entity>`

Generate or regenerate a specific entity's articles.

**Flow:**

1. Look up entity in `_entity-registry.json` to find the slug and category
2. Search monthly and annual summaries for mentions
3. Check `corrections.json` for relevant corrections
4. Look up contact info in `contact-lookup.json` and `tools/deep-context.ts contacts search "<name>"`
5. Generate private article (full detail, source pointers, private notes, ALL contact modes)
6. Derive shared article (strip sensitive content; keep contact info except `notes` and `signal`)
7. Rebuild indexes

### `/wiki enrich-contacts [category|slug]`

Re-run contact enrichment for specific articles or all people.

**Flow:**

1. If no argument: process all `people/` articles. If slug: process one. If category: process all in category.
2. Rebuild `contact-lookup.json` from the deep-context DB people table + unified_contacts + macOS Contacts:
   ```bash
   ~/.bun/bin/bun tools/contacts.ts export  # refresh macOS contacts
   ```
3. Spawn sub-agents in batches to merge lookup data into article `contact:` YAML blocks
4. Private articles get ALL fields (email, phone, signal, twitter, linkedin, slack, website, notes)
5. Shared articles get everything EXCEPT `notes` and `signal`
6. Rules: never remove existing info, only add/merge. Don't fabricate.
7. Run validation, rebuild indexes, commit + push

**Contact YAML schema:**
```yaml
contact:
  role: [string]
  org: [string]
  email: [string or list]       # all known emails
  phone: [string or list]       # all known phone numbers
  signal: [string]              # private only — Signal number if different from phone
  twitter: [string]             # handle without @ prefix
  linkedin: [string]            # linkedin.com/in/slug
  slack: [string or list]       # workspace:UXXXXXXX format
  website: [string]             # personal site or primary URL
  channel: [string]             # preferred contact method (freetext)
  location: [string]            # city/region
  notes: [string]               # private only — subjective contact preferences
```

**Reusable lookup asset:** `data/deep_context/wiki-generation/contact-lookup.json` — rebuilt during `/wiki update` and `/wiki enrich-contacts`.

## Key Rules for All Article Generation

These rules were learned through issues discovered during the initial build. They apply to
ALL sub-agents generating or updating articles:

1. **Three-tier source model:** Only quote Tier 1 material (actual words from emails, DMs, Slack, tweets). Never quote summaries as anyone's words. Use `--source` for Tier 1, `--context` for Tier 2 (private articles only).

2. **Corrections override summaries:** Always check `corrections.json` before writing. The owner's corrections are ground truth.

3. **Commitments vs. completed actions:** If a venture was proposed but never launched, an investment was committed but never wired, or a deal was discussed but never closed — say so explicitly. Don't write "invested" when the investment never happened.

4. **No interpretive leaps:** Don't attribute agency when summaries are ambiguous. If summaries say a decision was "agreed," don't assert a specific person made it unless the source says so.

5. **Dormancy awareness:** If something has been "unresolved" for 12+ months with no practical consequences, it's probably not important — don't feature it prominently.

6. **Sensitivity derivation (private → shared):** The shared version strips: `source_months`, `--source`/`--context` annotations, `## Private Notes`, specific personal dollar amounts, clinical medical details, home address, credentials/passwords, intimate DM quotes. Contact fields: shared gets email, phone, Twitter, LinkedIn, Slack handle, website, role, org, location, preferred channel. Private-only: `notes` (subjective contact preferences), `signal` (reveals secure-comms preference).

7. **Self-article boundary:** The self-article (`people/<owner-slug>.md`) has two sections separated by `<!-- STABLE SECTION BOUNDARY -->`. Only `/wiki update-self` or explicit rewrite requests should modify the "What's Happening Now" section. The stable section above the boundary only changes via `/wiki correct` or periodic review. The WHN section MUST include a knowledge cutoff blockquote at the top:
   ```
   > **Knowledge cutoff: YYYY-MM-DD**
   > This section reflects the owner's situation as of the date above. If more than
   > 7 days have passed since this date, treat active status claims and priorities
   > with caution — projects may have shifted, new developments may have occurred.
   > Check `agent-notes/sessions/` for more recent context from other agents.
   ```
   Always update the date in this block when modifying WHN content.

8. **Comprehensive contact info:** Every person article must have a fully populated `contact:` YAML block. Check `contact-lookup.json` for emails, Slack IDs, Twitter handles, and phones. Search the deep-context DB (`tools/deep-context.ts contacts search "<name>"`) for additional data. Extract contact info mentioned in source summaries. Private articles get ALL fields; shared articles omit `notes` and `signal`.
