-- 022_seed_time_slots.sql
-- Seeds 30-minute time slots for the next 14 days (07:00 – 21:00 IST).
-- ON CONFLICT DO NOTHING makes this safe to re-run at any time.
-- The repository's ensureSlotsExist() handles future dates on demand;
-- this migration ensures slots exist immediately on deployment.

-- 07:00 + n*30min for n in 0..27 → 07:00 through 20:30 (28 slots/day)
INSERT INTO time_slots (slot_date, start_time, end_time)
SELECT
    d::date                                                        AS slot_date,
    ('07:00'::time + (n * INTERVAL '30 minutes'))::time            AS start_time,
    ('07:30'::time + (n * INTERVAL '30 minutes'))::time            AS end_time
FROM
    generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '13 days', INTERVAL '1 day') AS d,
    generate_series(0, 27) AS n
ON CONFLICT (slot_date, start_time) DO NOTHING;
