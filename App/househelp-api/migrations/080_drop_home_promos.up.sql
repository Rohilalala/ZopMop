-- migration 080: drop home_promos (replaced by banners as canonical hero carousel source)
--
-- home_promos had zero write paths in the codebase — no CRM CRUD, no seed
-- migrations, no INSERTs anywhere. The BFF hero carousel source now reads
-- from the banners table which has full CRM CRUD and audience/time-window
-- filtering. home_promos is safe to drop.

DROP TABLE IF EXISTS home_promos CASCADE;
