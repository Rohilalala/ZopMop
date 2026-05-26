# Security Audit — Open Questions

Items where intent or current state could not be verified in this session. Each blocks or refines a finding above.

---

1. **What is the production value of `APP_ENV` on Railway, and is it guaranteed to be `production` (lowercase, no whitespace)?** If empty, all the env-gated unsafe defaults fire (S-002, S-008, E-009). Need to see the Railway environment dashboard.

2. **Has either Google Maps key been actually revoked at vendor side yet?** S-001 fix calls for rotation; we cannot tell from the repo whether vendor-side revoke has happened, or whether the keys still spend.

3. **Cashfree webhook idempotency in `dispatchCashfreeEventTx` (`internal/payments/handler.go:875`):** Does it dedupe on `event_id` (or equivalent) before triggering side effects? If yes, C-006/D-004 downgrades to LOW. Need to read that function.

4. **WS booking-tracking handler (`bookingTrackWS.RegisterTrackingWS`):** Where does JWT validation happen — at upgrade, or after? If upgrade-time, D-005/B-012 partially mitigated. Need to find the WS handler file.

5. **CRM SPA token transport in `App/zopmop-crm/src/api/client.ts`:** bearer-in-header or cookie-attached automatically? Resolves whether B-010 (no CSRF) is a real gap.

6. **CRM admin TOTP enforcement:** `/admin/auth/totp/verify` endpoint exists. Is TOTP required for every admin, optional with opt-in, or admin-toggleable? If toggleable, is there an audit log entry when an admin turns it off?

7. **Message Central dashboard hard spend cap:** Is there a daily/monthly SMS spend ceiling configured at the vendor side? If no, D-001 is materially worse.

8. **Railway egress network policy:** Does the Railway pod block outbound to RFC1918 / 169.254.169.254 (cloud IMDS)? If no, C-004 is more critical.

9. **`internal/credentials/firebase.go`:** does the parse error path log the raw value? S-004 hinges on this. Quick read.

10. **`internal/crm/auth/service.go` CRM login flow:** is there a per-account failed-attempt counter, or only per-IP? B-019 assumes no — confirm.

11. **CRM admin lifecycle audit log coverage:** does `internal/crm/audit/` get called on role-change / TOTP-disable / suspend? E-003 — needs enumeration.

12. **Bootstrap admin creation (`cmd/crm-api/bootstrap/main.go`):** is it idempotent + audit-logged + disabled after first run? B-020.

13. **`is_new_user` consumption in mobile app:** is the field strictly used for UX (privacy-policy checkbox)? If the app gates anything else off it, removing it (QW-3) needs an app release in lockstep.

14. **OpenRouter usage cap at vendor side:** is there a monthly budget cap? D-003 worse if not.

15. **Zop chat history persistence:** does the app render LLM responses with markdown that could parse `[x](javascript:...)` links? C-003 risk level depends.

16. **Multi-replica deployment:** how many backend replicas are running on Railway today? Determines D-006/D-008 actual exposure.

17. **`pkg/config/config.go` length validation on JWT secrets:** is there already a `len ≥ N` check we missed? S-005 + QW-6 partially redundant if yes.

18. **`internal/auth/messagecentral.go` `vid` lifecycle:** after a successful VerifyOTP, is the vendor-side `vid` invalidated, or only the local Redis copy? If only local, the same `vid` could be replayed by an attacker who sniffed it before deletion.

19. **CSRF token storage:** is the CSRF cookie `HttpOnly: false` (so SPA JS can read it) and `Secure: true` (so HTTP can't)? Need to read `internal/middleware/csrf.go`.

20. **`internal/admin/handler.go` admin runtime/metrics gate:** `RequirePermission(admin.PermViewAnalytics)` — is `PermViewAnalytics` distinct from `PermViewPII`? If the same string, viewing analytics implies viewing PII — sloppy.

End of open questions.
