# CLAUDE.md — ZopMop Repo
Project-specific instructions. Read after ~/.claude/CLAUDE.md.
Last revised: <!-- LAST_REVISED: 2026-06-05 -->

## Session Start (ZopMop-specific additions)
After completing the global session start ritual, also read:
- audit/ directory — know which audit items are still open before touching prod paths
  (audit/security/, audit/money/, audit/findings/; business rules in docs/business-rules-audit-2026-05-21.md)
- Any open PR descriptions on the current branch

## Stack Quick Reference
Backend:  Go + Fiber  |  cd App/househelp-api && go run ./cmd/api
Mobile:   RN + Expo   |  cd App/zopmop-app && npx expo start
CRM:      React + Vite |  cd App/zopmop-crm && npm run dev
DB:       pg + postgis + redis (local via docker-compose)
Deploy:   Railway — push to main triggers prod deploy

## ZopMop Non-Negotiables
- Integer paise. No floats. Ever. Money = int64 paise in every layer.
- IsProduction() guard on: OTP sends, SMS, payment triggers, webhook calls.
- All timestamps stored and displayed in Asia/Kolkata.
- git worktree add before any parallel workstream (violated twice — both caused messes).
- Read audit/ before touching payroll, pricing, dispatch, or auth paths.
- CRM is not deployed to prod. Do not reference CRM endpoints from mobile or backend prod.

## Open Blockers — do not close without explicit sign-off
Business rules:  C1, C7, C10  →  docs/business-rules-audit-2026-05-21.md
Money:           LB-1, LB-6   →  audit/money/SYNTHESIS.md (+ audit/money/REVIEW.md)
Security:        Maps key history scrub, webhook SSRF  →  audit/security/SYNTHESIS.md

## Branch Flow
feature/<slug> → develop → main (prod, Railway auto-deploy)
Never push directly to main. PR only.

## Self-Improvement
Follow ~/.claude/CLAUDE.md Section 5.
ZopMop-specific findings go to ~/.claude/projects/zopmop.md or the relevant
directory CLAUDE.md. Update audit/ files if a finding changes audit status.

---

<!-- code-review-graph MCP tools -->
## MCP Tools: code-review-graph

**IMPORTANT: This project has a knowledge graph. ALWAYS use the
code-review-graph MCP tools BEFORE using Grep/Glob/Read to explore
the codebase.** The graph is faster, cheaper (fewer tokens), and gives
you structural context (callers, dependents, test coverage) that file
scanning cannot.

### When to use graph tools FIRST

- **Exploring code**: `semantic_search_nodes` or `query_graph` instead of Grep
- **Understanding impact**: `get_impact_radius` instead of manually tracing imports
- **Code review**: `detect_changes` + `get_review_context` instead of reading entire files
- **Finding relationships**: `query_graph` with callers_of/callees_of/imports_of/tests_for
- **Architecture questions**: `get_architecture_overview` + `list_communities`

Fall back to Grep/Glob/Read **only** when the graph doesn't cover what you need.

### Key Tools

| Tool | Use when |
|------|----------|
| `detect_changes` | Reviewing code changes — gives risk-scored analysis |
| `get_review_context` | Need source snippets for review — token-efficient |
| `get_impact_radius` | Understanding blast radius of a change |
| `get_affected_flows` | Finding which execution paths are impacted |
| `query_graph` | Tracing callers, callees, imports, tests, dependencies |
| `semantic_search_nodes` | Finding functions/classes by name or keyword |
| `get_architecture_overview` | Understanding high-level codebase structure |
| `refactor_tool` | Planning renames, finding dead code |

### Workflow

1. The graph auto-updates on file changes (via hooks).
2. Use `detect_changes` for code review.
3. Use `get_affected_flows` to understand impact.
4. Use `query_graph` pattern="tests_for" to check coverage.
