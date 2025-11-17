#!/bin/bash
#
# Clone Production Database to Local Supabase
#
# This script safely clones your production Supabase database to your local
# Supabase instance for testing migrations.
#
# Usage:
#   ./scripts/clone-production-db.sh
#
# Prerequisites:
#   - Local Supabase running (bunx supabase start)
#   - Production credentials in .env.development.local

set -e  # Exit on error

echo "🔄 Production Database Cloning Script"
echo "======================================"
echo ""

# Load environment variables
if [ -f .env.development.local ]; then
  export $(grep -v '^#' .env.development.local | xargs)
else
  echo "❌ Error: .env.development.local not found"
  echo "Run: bun setup:env"
  exit 1
fi

# Verify required variables
if [ -z "$NEXT_PUBLIC_SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_ROLE_KEY" ]; then
  echo "❌ Error: Missing Supabase credentials"
  echo "Required: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY"
  exit 1
fi

# Extract project ref from URL
PROJECT_REF=$(echo "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's/https:\/\/([^.]+)\.supabase\.co/\1/')

echo "Production Project: $PROJECT_REF"
echo "Production URL: $NEXT_PUBLIC_SUPABASE_URL"
echo ""

# Check if local Supabase is running
if ! bunx supabase status &> /dev/null; then
  echo "⚠️  Local Supabase not running. Starting it now..."
  bunx supabase start
  echo ""
fi

# Get local database connection details
LOCAL_DB_URL=$(bunx supabase status | grep "DB URL" | awk '{print $3}')

if [ -z "$LOCAL_DB_URL" ]; then
  echo "❌ Error: Could not get local database URL"
  echo "Make sure local Supabase is running: bunx supabase start"
  exit 1
fi

echo "Local Database: $LOCAL_DB_URL"
echo ""

# Create temporary directory for dump
DUMP_DIR=$(mktemp -d)
DUMP_FILE="$DUMP_DIR/production-dump.sql"

echo "📦 Step 1: Creating production database dump..."
echo "Dump file: $DUMP_FILE"
echo ""

# Prompt for database password if not in env
if [ -z "$SUPABASE_DB_PASSWORD" ]; then
  echo "Enter your production database password:"
  echo "(Find it in Supabase Dashboard → Database → Connection String)"
  read -s SUPABASE_DB_PASSWORD
  echo ""
fi

# Create production database URL
PROD_DB_URL="postgresql://postgres:${SUPABASE_DB_PASSWORD}@db.${PROJECT_REF}.supabase.co:5432/postgres"

# Dump production database
echo "Creating dump (this may take a few minutes)..."
pg_dump "$PROD_DB_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --exclude-schema=extensions \
  --exclude-schema=graphql \
  --exclude-schema=graphql_public \
  --exclude-schema=pgbouncer \
  --exclude-schema=realtime \
  --exclude-schema=storage \
  --exclude-schema=supabase_functions \
  --exclude-table=storage.buckets \
  --exclude-table=storage.objects \
  --exclude-table=storage.migrations \
  > "$DUMP_FILE"

if [ $? -eq 0 ]; then
  DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
  echo "✅ Dump created successfully ($DUMP_SIZE)"
else
  echo "❌ Error: Failed to create database dump"
  rm -rf "$DUMP_DIR"
  exit 1
fi

echo ""
echo "🗄️  Step 2: Loading dump into local database..."
echo "This will reset your local database!"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled. Dump saved at: $DUMP_FILE"
  exit 0
fi

# Reset local database
echo "Resetting local database..."
bunx supabase db reset --db-url "$LOCAL_DB_URL"

# Load dump into local database
echo "Loading production data..."
psql "$LOCAL_DB_URL" < "$DUMP_FILE"

if [ $? -eq 0 ]; then
  echo "✅ Production data loaded successfully"
else
  echo "❌ Error: Failed to load data into local database"
  rm -rf "$DUMP_DIR"
  exit 1
fi

# Clean up
rm -rf "$DUMP_DIR"

echo ""
echo "🎉 Success!"
echo ""
echo "Your local database now contains production data."
echo ""
echo "Next steps:"
echo "  1. Verify data: bun scripts/verify-production-urls.ts"
echo "  2. Test migration: bun scripts/update-database-urls.ts --dry-run"
echo "  3. Check results in local database"
echo ""
echo "⚠️  Important:"
echo "  - This is a LOCAL copy only"
echo "  - Production database is unchanged"
echo "  - Safe to test migrations here"
echo ""
