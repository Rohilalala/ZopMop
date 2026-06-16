# docs/ — CLAUDE.md
**Purpose:** Product, business-rule, and planning docs for ZopMop (business rules audit, SDUI design, CRM v2 plan, phase backlogs, lessons learned). Narrative context behind architectural decisions.

**Run / test:** N/A — documentation only.

**Debug:** N/A. Key files:
- `business-rules-audit-2026-05-21.md` — authoritative conflict log C1..C10 (pay formulas, KYC plaintext, OTP hardcode, etc.)
- `BUSINESS.md`, `AUDIT.md`, `SDUI.md`, `crmv2plan.md`, `phase-12-backlog.md`, `lessons-learned.md`
- `audits/` — dated point-in-time file audits

**Landmines:**
- `business-rules-audit-2026-05-21.md` is the canonical home of conflicts C1/C7/C10 referenced everywhere else. Don't duplicate; link to it.
- Docs describe intent and current behaviour; when docs and code disagree, code wins — update the doc, flag for sign-off.
- Don't mark a conflict resolved here without the corresponding code change landing first.

**Open items:** C1 (two pro-pay formulas), C7 (Aadhaar/bank plaintext, Phase 12), C10 (OTP "999999" hardcoded) — all in business-rules-audit-2026-05-21.md.

**Last updated:** 2026-06-05
