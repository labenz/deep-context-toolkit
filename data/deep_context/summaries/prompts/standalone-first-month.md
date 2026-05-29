# Monthly Narrative Briefing — First Month (Standalone) Task Instructions

> Use this prompt for the **very first month** of the archive, when no prior monthly summaries exist. Because there is nothing to compare against, this variant drops the Month-Over-Month Delta section and the `[NEW]`/`[CHANGED]`/`[RESOLVED]`/`[ESCALATED]` change markers. Every later month uses `monthly-task-instructions.md` with rolling prior-month context instead.

## CRITICAL FORMATTING RULES (read these first)

1. **Length: 15,000-20,000 words.** This is a dense, comprehensive briefing, not a summary. Err long.
2. **One retrieval pointer per paragraph, minimum.** Every paragraph that makes a factual claim ends with at least one `--source [...]` pointer. Aim for **300+ pointers** across the whole briefing.
3. **Pointers must be conversation-specific.** Never write a bare `--source [email]` or `--source [slack]`. Always identify the conversation (subject line, channel, person).
4. **No change markers.** There is no prior month to compare against, so do NOT use `[NEW]`/`[CHANGED]`/`[RESOLVED]`/`[ESCALATED]` tags. Headings are plain.
5. **Clean narrative prose.** Write in flowing paragraphs. NO bullet lists in the main narrative sections. Tables only in the Commitments section. Bullets only in the Operational Lessons section.
6. **No Month-Over-Month Delta section.** There is no prior month, so omit it entirely.

---

## Your Task

You are given **this month's export** — the raw digital communications for the target month (provided separately as the input document). There is no prior-month context for this first month.

Produce a single third-person narrative briefing of **15,000-20,000 words** chronicling the target month. Because this is the first month, focus on establishing baseline context: who the recurring people are, what the active projects are, and what the owner's main concerns appear to be. Later months will be compared against this one, so make it a solid foundation.

## Structure

Organize the briefing into roughly these sections (adapt the headings to what actually happened this month — these are a scaffold, not a rigid template). Headings are plain (no change markers).

1. **Overview** — A 300-500 word orientation: the shape of the month, the dominant threads, the mood.
2. **Active Projects & Work** — The main initiatives, organized by project. What progressed, what stalled, what shipped.
3. **Key Relationships & Conversations** — Notable people and the substance of exchanges with them this month.
4. **Decisions & Commitments** — What the owner decided and what they committed to (see the Commitments table requirement below).
5. **Financial & Administrative** — Money, contracts, logistics, scheduling (only as it appears in the source material).
6. **External Developments** — News, market events, or third-party actions that the owner engaged with.
7. **Ideas & Intellectual Threads** — Positions taken, arguments made, things the owner was thinking through.
8. **Personal & Health** — Family, personal life, health, travel (only as it appears in the source).
9. **Loose Ends & Open Questions** — Unresolved threads carried into next month.
10. **Operational Lessons** — (Bullets allowed here.) Process/working observations from the month.
11. **Commitments** — (Table allowed here.) A table of explicit commitments made this month: who, to whom, what, by when, status.

## Pointer Format (mandatory)

Every claim is anchored. Use these exact forms:

```
--source [email: "Subject line"]
--source [Slack: WorkspaceName #channel-name]
--source [Slack DM with Person Name]
--source [iMessage with Person Name]
--source [iMessage group with Person1, Person2, Person3]
--source [call: "Meeting title"]
--source [twitter]
```

For a key claim, add a short verbatim quote anchor inline:
```
The deal terms were set early ("we can't go above the cap" --source [Slack DM with Person Name]).
```

A pointer is **only valid if it names the specific conversation**. Bare source types (`--source [email]`, `--source [slack]`, `--source [imessage]`) are forbidden and count as defects.

---

## CRITICAL FORMATTING RULES (repeated — these matter most)

1. **15,000-20,000 words.** Dense and comprehensive.
2. **300+ conversation-specific retrieval pointers**, at least one per paragraph. Never bare/generic.
3. **No change markers and no Month-Over-Month Delta** — this is the first month.
4. **Narrative prose** — no bullets except Operational Lessons; tables only in Commitments.
5. **Third person throughout.** You are a chronicler, not the owner.
