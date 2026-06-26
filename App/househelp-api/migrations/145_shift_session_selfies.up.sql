-- 145_shift_session_selfies
-- Mandatory go-online / go-offline selfies (proof-of-presence). Stored as a
-- base64 data URL in TEXT, mirroring zone_approval_requests.photo_url (there is
-- no object-storage pipeline yet). offline_selfie_url is NULL for sessions the
-- system force-offlines after shift end (the pro is not present to take one).
ALTER TABLE shift_sessions
    ADD COLUMN IF NOT EXISTS online_selfie_url  TEXT,
    ADD COLUMN IF NOT EXISTS offline_selfie_url TEXT;
