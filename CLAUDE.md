# Deep Context Toolkit -- Claude Code

The full project guide lives in AGENTS.md (shared with Codex and other agents) and is imported here:

@AGENTS.md

## Claude Code specifics

- Skills in `skills/` are exposed to Claude Code via the `.claude/skills` symlink, so `/update-deep-context`,
  `/deep-context-reference`, `/summarize-monthly` and `/wiki` are available when you open Claude Code in this folder.
- Extraction and enrichment output is verbose: delegate long runs to a sub-agent and keep the main context for reasoning.
