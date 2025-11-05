-- Migration: Move pg_trgm extension from public schema to extensions schema
-- This improves security and organization by isolating extensions from user data

-- Create extensions schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS extensions;

-- Drop the extension from public schema (will be automatically dropped from public when recreated elsewhere)
-- Note: DROP EXTENSION CASCADE would remove dependent objects, so we use IF EXISTS
DROP EXTENSION IF EXISTS pg_trgm;

-- Create the extension in the extensions schema
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Update the database search path to include extensions schema
-- This ensures that the pg_trgm operators (like gin_trgm_ops) work without schema qualification
ALTER DATABASE postgres SET search_path TO public, extensions;

-- Note: The GIN index on styles.name using gin_trgm_ops will continue to work
-- because the operators are now available through the search path
