#!/usr/bin/env bash
# PreToolUse(Edit|Write): an existing migration.sql has been applied to erp and erp_test;
# editing it desyncs both databases from git (the P3009 failure class from Phase 3 Task 6).
# Writing a brand-NEW migration.sql (file does not exist yet) stays allowed — that is the
# hand-written TTY-less recipe from CLAUDE.md.
f=$(jq -r '.tool_input.file_path // ""')
if [[ "$f" == *"/prisma/migrations/"*"/migration.sql" && -f "$f" ]]; then
  printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"This migration file already exists and has been applied to both databases — editing it desyncs erp/erp_test from git (P3009 class). Create a NEW migration directory via the TTY-less recipe in CLAUDE.md instead. If this file is genuinely still being authored, ask the user to approve the edit manually."}}'
fi
