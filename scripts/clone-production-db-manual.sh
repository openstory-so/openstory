#!/bin/bash
#
# Manual Production Database Clone
#
# This version prompts for credentials instead of loading from .env
# Use this if the automated script has issues with environment variables
#
# Usage:
#   ./scripts/clone-production-db-manual.sh

set -e

echo "🔄 Production Database Cloning Script (Manual Mode)"
echo "====================================================="
echo ""

# Prompt for production URL
echo "Enter your production Supabase URL:"
echo "(Example: https://abc123.supabase.co)"
read -r PROD_URL

# Extract project ref
PROJECT_REF=$(echo "$PROD_URL" | sed -E 's/https:\/\/([^.]+)\.supabase\.co/\1/')

if [ -z "$PROJECT_REF" ]; then
  echo "❌ Error: Could not extract project ref from URL"
  echo "Make sure URL is in format: https://PROJECT_REF.supabase.co"
  exit 1
fi

echo ""
echo "Production Project: $PROJECT_REF"
echo ""

# Prompt for database password
echo "Enter your production database password:"
echo "(Find in Supabase Dashboard → Database → Connection String)"
read -s DB_PASSWORD
echo ""

if [ -z "$DB_PASSWORD" ]; then
  echo "❌ Error: Database password is required"
  exit 1
fi

# Check if local Supabase is running
echo "Checking local Supabase status..."
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

echo "📦 Creating production database dump..."
echo "Dump file: $DUMP_FILE"
echo ""

# Create production database URL
PROD_DB_URL="postgresql://postgres:${DB_PASSWORD}@db.${PROJECT_REF}.supabase.co:5432/postgres"

# Dump production database
echo "Downloading production data (this may take a few minutes)..."
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
  > "$DUMP_FILE" 2>&1

if [ $? -eq 0 ]; then
  DUMP_SIZE=$(du -h "$DUMP_FILE" | cut -f1)
  echo "✅ Dump created successfully ($DUMP_SIZE)"
else
  echo "❌ Error: Failed to create database dump"
  echo ""
  echo "Common issues:"
  echo "  - Wrong database password"
  echo "  - Network/firewall blocking connection"
  echo "  - pg_dump not installed (install PostgreSQL client tools)"
  rm -rf "$DUMP_DIR"
  exit 1
fi

echo ""
echo "🗄️  Loading dump into local database..."
echo "⚠️  This will reset your local database!"
echo ""
read -p "Continue? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Cancelled. Dump saved at: $DUMP_FILE"
  exit 0
fi

# Reset local database
echo "Resetting local database..."
bunx supabase db reset

# Load dump into local database
echo "Loading production data..."
psql "$LOCAL_DB_URL" < "$DUMP_FILE" 2>&1 | tail -n 20

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
