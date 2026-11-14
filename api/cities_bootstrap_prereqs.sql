-- Newsium Cities bootstrap PREREQUISITES — superuser-only.
--
-- Run this ONCE per consumer database as a superuser. It installs
-- the postgres_fdw and postgis extensions required by the consumer
-- setup, and grants usage to the consuming role so the regular-user
-- cities_bootstrap.sql script can complete.
--
-- Pass the consuming role as the first argument, e.g.:
--   psql -d my_consumer_db -f cities_bootstrap_prereqs.sql -v role=my_app_user

\set role :role

CREATE EXTENSION IF NOT EXISTS postgres_fdw;
CREATE EXTENSION IF NOT EXISTS postgis;

-- Allow the consuming role to create foreign servers and tables.
DO $$
BEGIN
    IF length('role') > 0 THEN
        EXECUTE format('GRANT USAGE ON FOREIGN DATA WRAPPER postgres_fdw TO %I', 'role');
    END IF;
END$$;
