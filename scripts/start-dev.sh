#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}Starting Velro Development Environment...${NC}"
echo -e "${YELLOW}This script will run all services in this terminal.${NC}"
echo -e "${YELLOW}For separate terminals, open 3 terminals in VS Code/Cursor and run each command manually.${NC}"
echo ""

# Use tmux if available for split terminals
if command -v tmux &> /dev/null; then
    echo -e "${BLUE}Starting services with tmux...${NC}"
    
    # Kill existing session if it exists
    tmux kill-session -t velro 2>/dev/null
    
    # Create new tmux session with Supabase
    tmux new-session -d -s velro -n supabase "bunx supabase start"
    
    # Create QStash pane
    tmux new-window -t velro -n qstash "bunx qstash dev"
    
    # Create Next.js pane
    tmux new-window -t velro -n nextjs "bun dev"
    
    # Attach to the session
    tmux attach-session -t velro
else
    # Fallback: use concurrent execution
    echo -e "${BLUE}Running services concurrently...${NC}"
    echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
    echo ""
    
    # Function to handle cleanup
    cleanup() {
        echo -e "\n${RED}Stopping all services...${NC}"
        kill 0
        exit
    }
    
    trap cleanup SIGINT
    
    # Start all services in background
    echo -e "${BLUE}[1/3] Starting Supabase...${NC}"
    bunx supabase start &
    
    sleep 3
    
    echo -e "${BLUE}[2/3] Starting QStash tunnel...${NC}"
    bunx qstash dev &
    
    echo -e "${BLUE}[3/3] Starting Next.js app...${NC}"
    bun dev &
    
    # Wait for all background jobs
    wait
fi