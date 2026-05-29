---
name: summarize-monthly
description: Generate monthly narrative briefings from deep-context exports with rolling prior-month context (Strategy E). Handles export, prompt assembly, summarization, and validation.
---

# Summarize Monthly Skill

Produces 15-20K word narrative briefings that compress a month of digital activity into structured summaries with 300+ conversation-specific retrieval pointers. Each summary builds on prior months using a rolling 6-month context window.

## User Invocable

- **Slash command**: `/summarize-monthly`
- **Triggers**: "run monthly summary", "summarize next month", "continue monthly summaries", "generate briefing for [month]"

## Usage

```
/summarize-monthly 2021-07              # Single month
/summarize-monthly 2021-07 2021-12      # Range of months (sequential)
/summarize-monthly --status             # Show which months have exports/summaries
/summarize-monthly --validate 2021-06   # Re-validate an existing summary
```

## Prerequisites

- Monthly exports in `data/deep_context/summaries/monthly-exports/` (created by `deep-context extract-for-summary`)
- Prior months' summaries in `data/deep_context/summaries/monthly-summaries/` (for the context window)
- A populated deep-context database with enriched messages spanning the months you want to summarize

## CLI Reference

```bash
# All paths relative to:
SUMMARIES=data/deep_context/summaries

# Core tools
bun tools/deep-context.ts extract-for-summary  # Export a month to markdown
bun tools/summarize.ts run                      # Run a summarization prompt
$SUMMARIES/build-prompt.sh                       # Prompt assembly
```

---

## Workflow

### Phase 1: Export (skip if already exists)

Check if the export exists first:
```bash
ls data/deep_context/summaries/monthly-exports/YYYY-MM.md
```

If missing, generate it:
```bash
bun tools/deep-context.ts extract-for-summary \
  --from YYYY-MM-01 --to YYYY-MM-{last-day} \
  --output data/deep_context/summaries/monthly-exports/YYYY-MM.md
```

Exports include expanded participant lists (up to ~20 names) and workspace-qualified Slack headers, which is what makes the conversation-specific retrieval pointers possible.

### Phase 2: Build Prompt

**For the very first month** (no prior summaries exist):
- Use the standalone prompt: `data/deep_context/summaries/prompts/standalone-first-month.md`
- No prompt assembly needed — pass it directly via `--prompt`.

**For months with prior context** (the common case):
```bash
cd data/deep_context/summaries
./build-prompt.sh YYYY-MM 6
```

This assembles:
1. Up to 6 prior months' summaries from `monthly-summaries/` (chronological order)
2. A context header explaining how to use prior months for comparison
3. The task instructions from `prompts/monthly-task-instructions.md` (Strategy E)

Output: `data/deep_context/summaries/prompts/prompt-YYYY-MM.md`

**Rolling window**: Once 6+ months of summaries exist, `build-prompt.sh` automatically uses only the most recent 6. The `6` parameter is the max — it won't fail if fewer exist.

### Phase 3: Summarize

```bash
bun tools/summarize.ts run \
  --export data/deep_context/summaries/monthly-exports/YYYY-MM.md \
  --prompt data/deep_context/summaries/prompts/prompt-YYYY-MM.md \
  --system data/deep_context/summaries/prompts/system.md \
  --output data/deep_context/summaries/monthly-summaries/YYYY-MM.md \
  --model claude-sonnet-4-6 --thinking
```

**For the standalone first month** (no prior context), use the standalone prompt path instead:
```bash
--prompt data/deep_context/summaries/prompts/standalone-first-month.md
```

**Timing**: ~25 minutes per month is typical. Timeouts are possible on large contexts (1.4M+ tokens with 3+ prior months). Retry once before investigating.

**Run as a background task** — use a sub-agent so the main conversation stays responsive.

### Phase 4: Validate

After each summary completes, check these metrics:

```bash
SUMMARY=data/deep_context/summaries/monthly-summaries/YYYY-MM.md

# Word count (target: 15,000-20,000)
wc -w "$SUMMARY"

# Pointer count (target: 300+)
grep -c '\-\-source \[' "$SUMMARY"

# Generic pointer check (target: ZERO)
grep -c '\-\-source \[email\]' "$SUMMARY"
grep -c '\-\-source \[slack\]' "$SUMMARY"
grep -c '\-\-source \[imessage\]' "$SUMMARY"

# Heading marker count (target: 10-30+)
grep -cE '\[(NEW|CHANGED|RESOLVED|ESCALATED)\]' "$SUMMARY"

# Delta section present (for months with prior context)
grep -c 'Month-Over-Month Delta' "$SUMMARY"
```

**Quality thresholds** — alert the user if any of these fail:
- Words < 14,000 or > 22,000
- Pointers < 250
- Any generic pointers found (every pointer must be conversation-specific)
- Markers < 10 (for months with prior context)
- No delta section (for months with prior context)

---

## Batch Processing

When running multiple months (e.g., continuing a backfill):

1. **Run in chronological order** — each summary becomes context for the next
2. **Validate each before proceeding** — a bad summary propagates errors forward
3. **Rolling window kicks in at month 7+** — `build-prompt.sh` caps at 6 prior months
4. **If a month fails/times out** — retry once, then alert the user
5. **Track progress** — report after each month: "YYYY-MM complete: X words, Y pointers, Z markers"

Example batch sequence for Jul-Dec 2021:
```
Jul 2021: context = Jan-Jun 2021 (6 months)
Aug 2021: context = Feb-Jul 2021 (6 months, Jan drops off)
Sep 2021: context = Mar-Aug 2021 (6 months)
...
```

---

## Strategy E (Hybrid) — Design Reference

The winning prompt strategy, validated across multiple months. Combines:

- **Heading-level markers**: `[NEW]`, `[CHANGED]`, `[RESOLVED]`, `[ESCALATED]` on section headings only (NOT in body text). Shows what evolved relative to prior months.
- **300+ conversation-specific retrieval pointers**: Every paragraph has at least one `--source [specific]` pointer. A future agent can go directly to the right conversation.
- **Month-Over-Month Delta**: 500-800 word synthesis section at the END comparing against the most recent prior month.
- **Clean narrative prose**: No bullet lists in the main sections. Tables only in the Commitments section. Bullets only in Operational Lessons.
- **Sandwich technique**: Critical formatting instructions appear at both the TOP and BOTTOM of the prompt to prevent instruction dilution in 300K+ token contexts.

### Pointer Format

```
--source [email: "Subject line"]
--source [Slack: MyWorkspace #channel-name]
--source [Slack DM with Person Name]
--source [iMessage with Person Name]
--source [iMessage group with Person1, Person2, Person3]
--source [call: "Meeting title"]
--source [twitter]
```

For key claims, add a verbatim quote anchor:
```
("3-7 word exact quote" --source [specific])
```

---

## Data Locations

| What | Path |
|------|------|
| Monthly exports | `data/deep_context/summaries/monthly-exports/YYYY-MM.md` |
| Monthly summaries | `data/deep_context/summaries/monthly-summaries/YYYY-MM.md` |
| Built prompts | `data/deep_context/summaries/prompts/prompt-YYYY-MM.md` |
| Task instructions | `data/deep_context/summaries/prompts/monthly-task-instructions.md` |
| System prompt | `data/deep_context/summaries/prompts/system.md` |
| Standalone (first-month) prompt | `data/deep_context/summaries/prompts/standalone-first-month.md` |
| Prompt builder | `data/deep_context/summaries/build-prompt.sh` |
| Deep context DB | `data/deep_context/deep_context.db` |
