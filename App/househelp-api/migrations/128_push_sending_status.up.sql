-- 128_push_sending_status.up.sql (renumbered from 125 on integration)
-- Adds a transient 'sending' status to crm_push_messages so SendPush can
-- atomically claim a row (CAS draft|scheduled -> sending) BEFORE dispatching
-- to FCM. Without the claim, two concurrent dispatchers (an admin "Send now"
-- racing the 30s scheduler tick, or two crm-api instances both running the
-- scheduler) both pass the unlocked status read and both deliver — every
-- targeted device receives the push twice. The terminal status ('sent' /
-- 'failed') is written after dispatch as before.

ALTER TABLE crm_push_messages
    DROP CONSTRAINT IF EXISTS crm_push_messages_status_check;

ALTER TABLE crm_push_messages
    ADD CONSTRAINT crm_push_messages_status_check
    CHECK (status IN ('draft','scheduled','sending','sent','failed','cancelled'));
