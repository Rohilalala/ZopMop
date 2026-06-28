-- 115_set_service_step_icons.up.sql
-- Service Catalog Rework — STEP 3 of 4 (icon wiring), Job B.
--
-- service_steps.icon was left NULL in Step 2. Set a stable numeral key per step
-- so the Step 4 UI can map it to the numeral PNGs (assets/icons/1.png..4.png).
-- Value convention: 'step-1'..'step-4' (icon is varchar(10)), keyed off
-- step_number. Steps are 1-4 per service, so only step-1..step-4 occur.
--
-- Idempotent: re-running sets the same value. No Go/front-end change here.

UPDATE service_steps SET icon = 'step-' || step_number;
