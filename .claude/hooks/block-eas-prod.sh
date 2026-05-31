#!/usr/bin/env bash
# PreToolUse(Bash): block EAS OTA push / branch publish to the production channel.
# `eas update --channel production` ships JS bundles to live users, bypassing
# App Store / TestFlight review (same blast radius as Railway migrate-on-deploy).
# exit 2 blocks the call; run it manually with explicit intent if truly needed.
cmd=$(jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0
if printf '%s' "$cmd" | grep -Eq 'eas[[:space:]]+(update|branch:publish)' \
   && printf '%s' "$cmd" | grep -Eq '(^|[[:space:]=])production([[:space:]]|$|")'; then
  echo "BLOCKED: EAS production OTA/publish bypasses store review. Run it yourself, deliberately." >&2
  exit 2
fi
exit 0
