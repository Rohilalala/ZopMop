#!/usr/bin/env bash
# PostToolUse(Edit|Write): Squawk lint on migration .up.sql files.
# railway.json runs `migrate up` against prod Postgres on push to main; an
# ACCESS EXCLUSIVE lock from ADD CONSTRAINT / non-CONCURRENT CREATE INDEX /
# DROP COLUMN can take the live DB down. Advisory (exit 0) — surfaces findings.
# No-op until squawk is installed: brew install sbdchd/squawk/squawk
command -v squawk >/dev/null 2>&1 || exit 0
p=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$p" in
  */househelp-api/migrations/*.up.sql)
    out=$(squawk "$p" 2>&1 | head -40)
    [ -n "$out" ] && printf 'Squawk (migration safety):\n%s\n' "$out" >&2 ;;
esac
exit 0
