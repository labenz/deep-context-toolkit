#!/usr/bin/env bash
#
# build-prompt.sh — Assemble a monthly-briefing prompt with rolling prior-month context.
#
# Usage:
#   ./build-prompt.sh YYYY-MM [N]
#
#   YYYY-MM   The target month to summarize (e.g. 2021-07).
#   N         Max number of most-recent prior months to include as context.
#             Optional; defaults to 6.
#
# Behavior:
#   1. Collects up to N most-recent prior monthly summaries from ../monthly-summaries/
#      (chronological order, oldest first), excluding the target month itself.
#   2. Writes a context header explaining how to use prior months for comparison.
#   3. Appends the contents of prompts/monthly-task-instructions.md (Strategy E).
#   4. Writes the assembled prompt to prompts/prompt-YYYY-MM.md.
#
# All paths resolve relative to this script's own location, so it is portable
# regardless of the caller's working directory.

set -euo pipefail

# Resolve directories relative to this script (the summaries/ dir).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SUMMARIES_DIR="$SCRIPT_DIR/monthly-summaries"
PROMPTS_DIR="$SCRIPT_DIR/prompts"
TASK_INSTRUCTIONS="$PROMPTS_DIR/monthly-task-instructions.md"

# --- Args -------------------------------------------------------------------
TARGET_MONTH="${1:-}"
MAX_PRIOR="${2:-6}"

if [[ -z "$TARGET_MONTH" ]]; then
  echo "Usage: $0 YYYY-MM [N=6]" >&2
  exit 1
fi

if [[ ! "$TARGET_MONTH" =~ ^[0-9]{4}-[0-9]{2}$ ]]; then
  echo "Error: target month must be in YYYY-MM format (got '$TARGET_MONTH')" >&2
  exit 1
fi

if [[ ! -f "$TASK_INSTRUCTIONS" ]]; then
  echo "Error: task instructions not found at $TASK_INSTRUCTIONS" >&2
  exit 1
fi

OUTPUT="$PROMPTS_DIR/prompt-$TARGET_MONTH.md"

# --- Collect prior-month summaries -----------------------------------------
# List YYYY-MM.md summaries, sorted chronologically (filename sort works for
# zero-padded dates), keep only those strictly before the target month, then
# take the most recent N.
prior_files=()
if [[ -d "$SUMMARIES_DIR" ]]; then
  while IFS= read -r f; do
    base="$(basename "$f" .md)"
    # Skip anything that isn't a YYYY-MM summary.
    [[ "$base" =~ ^[0-9]{4}-[0-9]{2}$ ]] || continue
    # Only months strictly before the target month.
    [[ "$base" < "$TARGET_MONTH" ]] || continue
    prior_files+=("$f")
  done < <(find "$SUMMARIES_DIR" -maxdepth 1 -name '*.md' | sort)
fi

# Keep only the most recent N (the list is oldest-first, so slice the tail).
count="${#prior_files[@]}"
if (( count > MAX_PRIOR )); then
  start=$(( count - MAX_PRIOR ))
  prior_files=("${prior_files[@]:$start}")
fi

# --- Assemble the prompt ----------------------------------------------------
{
  if (( ${#prior_files[@]} > 0 )); then
    echo "# Prior-Month Context"
    echo
    echo "Below are the ${#prior_files[@]} most recent prior monthly summaries, in"
    echo "chronological order (oldest first). They are provided ONLY so you can"
    echo "detect what is new, what changed, what resolved, and what escalated in the"
    echo "target month relative to recent history. Do NOT re-summarize them. Use them"
    echo "to write accurate change markers and the Month-Over-Month Delta section."
    echo
    for f in "${prior_files[@]}"; do
      base="$(basename "$f" .md)"
      echo "---"
      echo
      echo "## Prior Month: $base"
      echo
      cat "$f"
      echo
    done
    echo "---"
    echo
    echo "# End of Prior-Month Context"
    echo
    echo "The target month to summarize is **$TARGET_MONTH**. Its raw export is provided"
    echo "as the separate input document. Now follow the task instructions below."
    echo
    echo "---"
    echo
  fi

  # Always append the Strategy E task instructions last.
  cat "$TASK_INSTRUCTIONS"
} > "$OUTPUT"

echo "Wrote $OUTPUT"
echo "  target month: $TARGET_MONTH"
echo "  prior months included: ${#prior_files[@]} (max $MAX_PRIOR)"
