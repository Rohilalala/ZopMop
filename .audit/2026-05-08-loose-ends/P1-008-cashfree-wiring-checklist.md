P1-008 - Cashfree PG wiring audit (verify production state)

Severity: P1
Category: OPS
Surfaced by: Business logic clarification 2026-05-08 (Cashfree test page
was working in dev; need to verify Railway production wiring)
Date: 2026-05-08

SUMMARY
Cashfree integration was confirmed working in dev/sandbox earlier. This
ticket is the audit to verify the production wiring is correct on Railway:
all four CASHFREE_PG_* env vars set with production credentials (not
sandbox), PUBLIC_BASE_URL set to Railway URL, webhook URL in Cashfree
dashboard pointing at Railway production endpoint (not localhost or
ngrok from dev), mobile EXPO_PUBLIC_* env vars matching production. Common
failure mode: dev credentials accidentally shipped to production, or
webhook URL never updated from local-dev value. Audit takes 30 min,
includes a Re 1 production smoke test.

FINDING
Cashfree PG end-to-end was working in earlier dev iterations - mobile app
opening Drop Checkout, payment completing, webhook firing back to local
Go API via ngrok, booking flipping to paid. Code path is correct.

The audit concern: when ZopMop deployed to Railway production today, were
the Cashfree credentials migrated correctly?

Three things commonly go wrong in this kind of dev-to-prod transition:

1. Sandbox credentials shipped to production. CASHFREE_PG_ENV is set to
   "production" but APP_ID and SECRET_KEY are sandbox values. Backend
   tries to call production Cashfree API with sandbox creds, gets 401.
   Or vice versa.

2. Webhook URL still points at ngrok or localhost. Cashfree dashboard
   has the dev webhook URL configured. Production payments succeed at
   Cashfree end, but the webhook never reaches Railway, so booking stays
   in payment_status='pending' forever. Customer paid, system doesn't know.

3. Mobile env mismatch. EXPO_PUBLIC_CASHFREE_ENV in mobile says sandbox
   but Railway backend says production. Mobile creates a sandbox order,
   backend tries to verify against production API, mismatch.

Any of these is silently launch-broken. Code is fine, wiring is wrong.

EVIDENCE TO COLLECT
A. In Railway ZopMop service Variables tab, eye-reveal each:
   - CASHFREE_PG_APP_ID
   - CASHFREE_PG_SECRET_KEY (do not paste, just confirm non-empty)
   - CASHFREE_PG_ENV (sandbox or production)
   - CASHFREE_PG_WEBHOOK_SECRET (do not paste, just confirm non-empty)
   - PUBLIC_BASE_URL (must be https://zopmop-production.up.railway.app
     or your custom domain)
   Confirm none are empty. Confirm CASHFREE_PG_ENV matches the credential
   set type (sandbox creds + sandbox env, or production creds + production
   env).

B. In Cashfree dashboard Webhooks section:
   - Confirm webhook URL is the Railway production URL, not ngrok,
     not localhost, not a previous dev tunnel
   - Specifically: https://zopmop-production.up.railway.app/api/v1/payments/webhook
     (or your custom domain equivalent)
   - Confirm subscribed events include PAYMENT_SUCCESS at minimum

C. In zopmop-app .env or EAS secrets:
   - EXPO_PUBLIC_CASHFREE_PG_APP_ID matches Railway value
   - EXPO_PUBLIC_CASHFREE_ENV matches CASHFREE_PG_ENV in Railway

D. Boot logs on Railway:
   curl https://zopmop-production.up.railway.app/health
   Look at recent ZopMop deploy logs. Search for "[payments] cashfree".
   - If you see "cashfree PG gateway not configured (manual fallback)" -
     credentials are missing or empty
   - If you see anything else specific, note it

REPRODUCTION (production smoke test)
1. In TestFlight or EAS preview build of mobile app, create a small
   booking (Re 1 if you can configure a test service, or smallest real
   service)
2. Pay via Cashfree Drop Checkout, real card or UPI
3. Observe payment completes
4. Within 30 sec, check Railway logs for webhook receipt
5. SQL check:
   SELECT id, payment_status, gateway_ref, webhook_received_at
   FROM payments WHERE created_at > NOW() - INTERVAL '5 minutes';
6. payment_status should flip from 'pending' to 'paid' within seconds
7. webhook_received_at should be set
8. Refund the test payment via CRM or Cashfree dashboard immediately to
   clean up

If steps 4-7 fail, one of A/B/C is wrong.

BLAST RADIUS
At launch, with this audit not done:
- Best case: everything is wired correctly, no impact
- Common case: one of the three failure modes silently breaks payments
  for some users (those whose webhook delivery fails, or all users if
  credentials are wrong)
- Worst case: customers pay, system thinks they didn't, double-charge
  attempts on retry, support nightmare

The audit itself is low-risk - just verification + a Re 1 transaction
that gets refunded.

FIX PLAN

Step 1: Run the evidence-collection (A-D above)
30 min total. No changes made yet.

Step 2: If anything is wrong, fix the specific gap
- Wrong env or empty creds: paste correct values into Railway, save,
  Railway auto-redeploys
- Wrong webhook URL: update in Cashfree dashboard
- Mobile mismatch: update .env, push EAS update, mobile refetches

Step 3: Production Re 1 smoke test
After any fix or if everything looked correct, run the reproduction steps
above. Confirm end-to-end flow works against production.

Step 4: Wallet topup smoke test
Same flow but via Wallet > Topup. Different code path on backend
(payment.booking_id IS NULL routes to wallet credit branch). Verify
this path also works.

Step 5: Document the wired state
Add to docs/DEPLOYMENT.md or similar:
- What env vars are required in Railway for Cashfree
- What webhook URL must be configured in Cashfree dashboard
- How to test end-to-end after re-deploys

EFFORT
- Step 1 (audit): 30 min
- Step 2 (fix only if needed): 0-30 min
- Step 3 (Re 1 production smoke): 15 min
- Step 4 (wallet topup smoke): 10 min
- Step 5 (documentation): 15 min

Total: 1-1.5 hr.

DEPENDENCIES
- Mobile app must be runnable on a real device or TestFlight to do the
  smoke test (depends on resolving the Firebase iOS build issue we hit
  earlier today - separate ticket)
- P0-003 (Postgres password rotation) ideally before this so any
  webhook-secret leak from past dev sessions is also addressed

ACCEPTANCE CRITERIA
- All four CASHFREE_PG_* vars confirmed set in Railway production with
  matching env mode
- PUBLIC_BASE_URL set to Railway URL, https
- Webhook URL in Cashfree dashboard points at Railway production endpoint
- Mobile EXPO_PUBLIC_* env vars match Railway backend mode
- Production Re 1 smoke test: payment completes, webhook fires,
  payment_status=paid within 30 sec
- Wallet topup smoke test passes
- docs/DEPLOYMENT.md or equivalent has the wired-state checklist

ANCHOR
Operational audit, no code anchor.
