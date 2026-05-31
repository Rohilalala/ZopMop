#!/usr/bin/env bash
# PreToolUse(Edit|Write): block writes to .env files and secrets/ dirs.
# .env / .env.local / .env.production hold Cashfree + Firebase keys (gitignored).
# exit 2 blocks the tool call; stderr is shown to Claude.
p=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$p" ] && exit 0
case "$p" in
  *.env.example|*.env.local.example|*.env.*.example) exit 0 ;;  # scaffolding templates allowed
esac
if printf '%s' "$p" | grep -Eq '(^|/)\.env($|\.[^/]*$)|/secrets/'; then
  echo "BLOCKED: '$p' is a protected secret/env path (holds Cashfree/Firebase keys). Edit it manually." >&2
  exit 2
fi
exit 0
