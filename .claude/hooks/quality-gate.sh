#!/bin/bash
# Quality Gate Hook — validates commands before execution
# Reads hook input JSON from stdin, checks the command, and blocks dangerous operations.
#
# Hook events: PreToolUse (matcher: Bash), SessionStart

set -euo pipefail

INPUT=$(cat)

# Extract the command from tool_input (PreToolUse event)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# If no command (e.g., SessionStart), exit clean
if [ -z "$COMMAND" ]; then
  exit 0
fi

# Normalize: trim whitespace, collapse spaces
NORMALIZED=$(echo "$COMMAND" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | tr -s ' ')

# === Block destructive filesystem operations ===
if echo "$NORMALIZED" | grep -qE 'rm[[:space:]]+(-rf|-fr|--recursive)[[:space:]]+/'; then
  echo "BLOCKED: Destructive rm -rf on root path detected" >&2
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Destructive rm -rf on root path blocked by quality gate"
    }
  }'
  exit 0
fi

# === Block force push to main/master ===
if echo "$NORMALIZED" | grep -qE 'git[[:space:]]+push[[:space:]]+.*(--force|-f).*(main|master)'; then
  echo "BLOCKED: Force push to main/master is not allowed" >&2
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Force push to main/master blocked by quality gate"
    }
  }'
  exit 0
fi

# === Block hard reset on main/master ===
if echo "$NORMALIZED" | grep -qE 'git[[:space:]]+(reset)[[:space:]]+--hard[[:space:]]+(origin/)?(main|master)'; then
  echo "BLOCKED: Hard reset against main/master is not allowed" >&2
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Hard reset against main/master blocked by quality gate"
    }
  }'
  exit 0
fi

# All checks passed — allow the command
exit 0
