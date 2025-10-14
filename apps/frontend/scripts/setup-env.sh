#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Setting up .env.development.local...${NC}"

# Check if Supabase is running
echo -e "${BLUE}Checking Supabase status...${NC}"
SUPABASE_STATUS=$(bunx supabase status 2>&1)

if echo "$SUPABASE_STATUS" | grep -q "supabase local development setup"; then
    echo -e "${GREEN}✓ Supabase is running${NC}"
    
    # Extract Supabase values
    SUPABASE_URL=$(echo "$SUPABASE_STATUS" | grep "API URL" | awk '{print $3}')
    SUPABASE_ANON_KEY=$(echo "$SUPABASE_STATUS" | grep "anon key" | awk '{print $3}')
    SUPABASE_SERVICE_KEY=$(echo "$SUPABASE_STATUS" | grep "service_role key" | awk '{print $3}')
    
    # Database URL is typically: postgresql://postgres:postgres@localhost:54322/postgres
    DATABASE_URL="postgresql://postgres:postgres@localhost:54322/postgres"
else
    echo -e "${RED}✗ Supabase is not running. Please run: bun supabase:start${NC}"
    exit 1
fi

# Setup QStash for local development (using hardcoded user 1)
echo -e "${BLUE}Setting up QStash for local development...${NC}"
echo -e "${YELLOW}Make sure 'bun qstash:dev' is running in another terminal!${NC}"

# Get the tunnel URL if needed
echo -e "${BLUE}Setting up tunnel for QStash callbacks...${NC}"
echo -e "${YELLOW}If you have a tunnel running (e.g., ngrok), enter the URL${NC}"
echo -e "${YELLOW}Otherwise, press Enter to use localhost:${NC}"
read -p "Tunnel URL (optional): " QSTASH_TUNNEL_URL

# Create .env.development.local file
ENV_FILE=".env.development.local"

cat > $ENV_FILE << EOF
# Supabase (Local Development)
NEXT_PUBLIC_SUPABASE_URL=$SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_KEY
DATABASE_URL=$DATABASE_URL

# QStash
QSTASH_TOKEN=$QSTASH_TOKEN
QSTASH_URL=$QSTASH_URL
QSTASH_CURRENT_SIGNING_KEY=$QSTASH_CURRENT_SIGNING_KEY
QSTASH_NEXT_SIGNING_KEY=$QSTASH_NEXT_SIGNING_KEY

# QStash tunnel URL (when using qstash:dev)
EOF

if [ -n "$QSTASH_TUNNEL_URL" ]; then
    echo "QSTASH_TUNNEL_URL=$QSTASH_TUNNEL_URL" >> $ENV_FILE
fi

# Generate a random secret for BetterAuth
BETTER_AUTH_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)
BETTER_AUTH_URL="http://localhost:3000"

cat >> $ENV_FILE << EOF

# BetterAuth Configuration
BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET
BETTER_AUTH_URL=$BETTER_AUTH_URL
NEXT_PUBLIC_BETTER_AUTH_URL=$BETTER_AUTH_URL

# Google OAuth Configuration (optional - for Google sign-in)
# GOOGLE_CLIENT_ID=your-google-client-id
# GOOGLE_CLIENT_SECRET=your-google-client-secret

# Optional: AI Service Keys (add as needed)
# OPENROUTER_KEY=
# FAL_KEY=
# RUNWAY_API_SECRET=
# KLING_ACCESS_KEY=
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
EOF

echo -e "${GREEN}✓ Created $ENV_FILE${NC}"
echo ""
echo -e "${BLUE}Environment variables configured:${NC}"
echo "  Supabase URL: $SUPABASE_URL"
echo "  Database URL: $DATABASE_URL"
echo "  QStash URL: $QSTASH_URL (local dev)"
echo "  QStash User: user1"
if [ -n "$QSTASH_TUNNEL_URL" ]; then
    echo "  QStash Tunnel URL: $QSTASH_TUNNEL_URL"
fi
echo ""
echo -e "${YELLOW}Remember to keep 'bun qstash:dev' running in another terminal!${NC}"
echo -e "${GREEN}Setup complete! You can now run 'bun dev'${NC}"