#!/usr/bin/env bash
# PreToolUse(Bash): enforce the owner's no-per-commit-attribution rule (2026-08-01).
# Branches are squash-merged, so per-commit Co-Authored-By/Claude-Session trailers
# concatenate N times into one squash message. Attribution belongs in the PR body, once.
cmd=$(jq -r '.tool_input.command // ""')
if [[ "$cmd" == *"git commit"* ]] && grep -qiE 'co-authored-by|claude-session' <<<"$cmd"; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"House rule (owner, 2026-08-01): no attribution trailers on individual commits — every branch is squash-merged, so per-commit trailers concatenate N times. Attribution goes in the PR body, once. Remove the Co-Authored-By/Claude-Session line and commit again."}}'
fi
