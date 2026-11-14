-- Rename newsium → xyzo: database user, function, and FDW objects
-- Run this migration AFTER updating all code and .env files

-- 1. Rename the function (if it exists)
DO $$
BEGIN
  ALTER FUNCTION newsium_set_updated_at() RENAME TO xyzo_set_updated_at;
  RAISE NOTICE 'Renamed function newsium_set_updated_at → xyzo_set_updated_at';
EXCEPTION WHEN undefined_function THEN
  RAISE NOTICE 'Function newsium_set_updated_at does not exist (already renamed or never created)';
END$$;

-- 2. Rename the database user/role (if it exists)
-- NOTE: This requires no active connections using the old role
DO $$
BEGIN
  ALTER ROLE newsium_app RENAME TO xyzo_app;
  RAISE NOTICE 'Renamed role newsium_app → xyzo_app';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'Role newsium_app does not exist (already renamed or never created)';
END$$;

-- 3. Update the password for the new role
ALTER ROLE xyzo_app WITH PASSWORD 'CHANGE_ME';

-- 4. Rename the cities database (requires no active connections)
-- NOTE: Must be run outside a transaction block. Run manually:
-- ALTER DATABASE newsium_cities RENAME TO xyzo_cities;

-- 5. Update FDW server name (if it exists)
DO $$
BEGIN
  ALTER SERVER newsium_cities_server RENAME TO xyzo_cities_server;
  RAISE NOTICE 'Renamed FDW server newsium_cities_server → xyzo_cities_server';
EXCEPTION WHEN undefined_object THEN
  RAISE NOTICE 'FDW server newsium_cities_server does not exist (already renamed or never created)';
END$$;

-- 6. Grant permissions to new role
GRANT SELECT ON ALL TABLES IN SCHEMA public TO xyzo_app;
GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO xyzo_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO xyzo_app;

-- Post-migration steps (run manually):
-- 1. Restart all services: systemctl restart xyzo-api
-- 2. Verify: SELECT rolname FROM pg_roles WHERE rolname = 'xyzo_app';
-- 3. If newsium_cities DB exists, rename it:
--    ALTER DATABASE newsium_cities RENAME TO xyzo_cities;
