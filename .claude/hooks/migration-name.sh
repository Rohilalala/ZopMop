#!/usr/bin/env bash
# PostToolUse(Write): enforce the CI migration filename pattern locally.
# Mirrors .github/workflows/ci.yml 'migrations' job regex so a bad name
# (049_foo.sql, 49_x.up.sql, .SQL) is caught instantly, not minutes later in CI.
# Forward-only repo policy: prefer .up.sql; legacy .down.sql (081-096) predate it.
p=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$p" in
  */househelp-api/migrations/*)
    b=$(basename "$p")
    if ! printf '%s' "$b" | grep -Eq '^[0-9]{3}_[a-z0-9_]+\.(up|down)\.sql$'; then
      echo "Bad migration name: '$b' — need NNN_description.{up,down}.sql (CI regex). Next prefix is 114." >&2
      exit 2
    fi ;;
esac
exit 0
