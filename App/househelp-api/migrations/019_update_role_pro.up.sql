-- 019_update_role_pro.sql
-- Change 'helper' role constraint to 'pro'

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'pro' WHERE role = 'helper';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('customer', 'pro', 'admin'));
