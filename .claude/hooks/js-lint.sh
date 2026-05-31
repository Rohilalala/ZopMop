#!/usr/bin/env bash
# PostToolUse(Edit|Write): ESLint --fix on JS/TS edits in the 3 JS projects.
# No prettier anywhere — ESLint 9 is the sole style/lint gate (CI runs it).
# Uses project-local eslint via `npx --no-install`; no-op if not installed.
# Advisory (exit 0).
p=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$p" in
  *node_modules*) exit 0 ;;
  */App/zopmop-app/*.ts|*/App/zopmop-app/*.tsx|*/App/zopmop-app/*.js|*/App/zopmop-app/*.jsx) proj="App/zopmop-app" ;;
  */App/zopmop-crm/*.ts|*/App/zopmop-crm/*.tsx|*/App/zopmop-crm/*.js|*/App/zopmop-crm/*.jsx) proj="App/zopmop-crm" ;;
  */web/*.ts|*/web/*.tsx|*/web/*.js|*/web/*.jsx) proj="web" ;;
  *) exit 0 ;;
esac
root="/Users/adityarohilla/Documents/ZopMop"
( cd "$root/$proj" && npx --no-install eslint --fix "$p" >/dev/null 2>&1 ) || true
exit 0
