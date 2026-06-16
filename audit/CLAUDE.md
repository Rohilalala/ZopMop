# audit/ — CLAUDE.md
**Purpose:** Static read-only audit findings for ZopMop — security, money-flow, and code/quality reviews of the backend, mobile, and CRM. Source of truth for open launch blockers and conflicts.

**Run / test:** N/A — documentation only. No code, no build.

**Debug:** N/A. Layout:
- `audit/security/` — SYNTHESIS.md + findings-{secrets,authnz,dos,input-validation,disclosure}.md
- `audit/money/` — SYNTHESIS.md, REVIEW.md, FLOW_MAP.md, trace-scenarios.md, findings-{units,math,idempotency}.md
- `audit/findings/` — code-quality, bugs, performance, devops, database, frontend, auth-session, etc.
- top level: FULL_REPORT.md, EXECUTIVE_SUMMARY.md, QUICK_WINS.md, STORE_READINESS.md, OPEN_QUESTIONS.md, REPO_MAP.md

**Landmines:**
- These files describe what the code does TODAY, not what it should do. Code wins; assumptions are flagged.
- Never edit audit files to "close" a finding without explicit sign-off from Aditya. Status changes are decisions, not edits.
- Launch blockers LB-1..LB-9 (money/) and conflicts C1..C10 (business rules, see docs/) are open until signed off.
- Business-rules conflicts (C1/C7/C10) live in `docs/business-rules-audit-2026-05-21.md`, NOT here.

**Open items:** LB-1 (pro-cancel no refund), LB-6 (payment-intent race) → audit/money/SYNTHESIS.md. Security: Maps key history scrub, webhook SSRF → audit/security/SYNTHESIS.md.

**Last updated:** 2026-06-05
