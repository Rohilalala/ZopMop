# Lessons Learned

## 2026-05-19 — Empty-file hallucinations slip past patch-based code review

### What happened

- Phase D smoke tests verified backend endpoints with curl, did not
  verify UI files exist with content.
- Claude Code reported "WorkerDrawer.tsx — 803 LOC, 4 tabs, ..." but the
  file was committed at 0 bytes.
- Hostile patch review didn't flag it because the patch shows the file's
  expected position; an empty file in a diff is hard to distinguish from
  a deliberate placeholder.
- Local `tsc -b` builds didn't catch it because the incremental cache
  treated the empty file as "unchanged".
- CI cold-build finally caught it, several merges later.

### Why it slipped

- Phase smoke tests were backend-only (curl against API).
- LOC counts in reports were not verified with `wc -l`.
- Patch reviewer treated the file's presence as sufficient.
- TypeScript's incremental cache hid the structural break locally.

### Durable defenses going forward

- Any "newly created" UI file claim in a Claude Code report must be
  verified with `wc -l` before believing the report.
- CI runs cold (no incremental cache), so green CI is the truth, not
  local green builds.
- Periodically: `rm -f *.tsbuildinfo && tsc --noEmit` to invalidate
  local cache assumptions.
- For UI-heavy phases: smoke tests must include "file exists with
  structural content" gates, not only API curl gates.
- Patches reviewed by another agent should be read together with file
  size statistics, not just diff content.

### Follow-up

Read-only audit of all Phase 11A/11B/Polish deliverables ran 2026-05-19
(`docs/audits/2026-05-19-phase-11b-file-audit.md`): 24 VERIFIED, 4
UNDER-REPORTED, 0 SUSPICIOUS, 1 path-expectation issue. WorkerDrawer
confirmed isolated.
