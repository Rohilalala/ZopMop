#!/usr/bin/env bash
# PostToolUse(Edit|Write): format + lint Go edits to stay CI-clean.
# CI gates on `go vet ./...`. gofmt -w fixes formatting in place; then run
# golangci-lint (errcheck/sqlclosecheck/bodyclose) if installed, else go vet.
# Scoped to the edited package dir, not repo root, to stay fast. Advisory.
p=$(jq -r '.tool_input.file_path // empty' 2>/dev/null)
case "$p" in
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$p"
    d=$(dirname "$p")
    if command -v golangci-lint >/dev/null 2>&1; then
      out=$( (cd "$d" && golangci-lint run 2>&1) | head -30 )
    elif command -v go >/dev/null 2>&1; then
      out=$( (cd "$d" && go vet ./... 2>&1) | head -20 )
    fi
    [ -n "${out:-}" ] && printf 'Go lint (%s):\n%s\n' "$d" "$out" >&2 ;;
esac
exit 0
