-- Migration: Move pg_trgm extension from public schema to extensions schema
-- This improves security and organization by isolating extensions from user data

-- Create extensions schema if it doesn't exist
CREATE SCHEMA IF NOT EXISTS extensions;

-- Step 1: Drop the dependent index first
DROP INDEX IF EXISTS "idx_styles_name_gin";

-- Step 2: Drop the extension from public schema
DROP EXTENSION IF EXISTS pg_trgm;

-- Step 3: Create the extension in the extensions schema
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;

-- Step 4: Update the database search path to include extensions schema
-- This ensures that the pg_trgm operators (like gin_trgm_ops) work without schema qualification
ALTER DATABASE postgres SET search_path TO public, extensions;

-- Step 5: Recreate the index - it will now use the extension from the extensions schema
CREATE INDEX "idx_styles_name_gin" ON "styles" USING gin ("name" gin_trgm_ops);
