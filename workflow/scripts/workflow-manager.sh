#!/bin/bash

# Workflow Manager for Claude Code Agent System
# Orchestrates issue assignment, worktree creation, and agent delegation

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKFLOW_DIR="$PROJECT_ROOT/workflow"
WORKTREE_DIR="$PROJECT_ROOT/.trees"
STATE_DIR="$WORKFLOW_DIR/state"
INSTRUCTIONS_DIR="$WORKFLOW_DIR/instructions"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# Initialize directories
mkdir -p "$STATE_DIR"
mkdir -p "$WORKTREE_DIR"
mkdir -p "$INSTRUCTIONS_DIR"

log() {
    echo -e "${GREEN}[WORKFLOW]${NC} $1" >&2
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

info() {
    echo -e "${BLUE}[INFO]${NC} $1" >&2
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1" >&2
}

# Function to sanitize branch name
sanitize_branch_name() {
    local issue_num=$1
    local title=$2
    local sanitized=$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//')
    sanitized="${sanitized:0:50}"
    echo "${issue_num}-${sanitized}"
}

# Function to determine issue type
determine_issue_type() {
    local title="$1"
    local body="$2"
    local labels="$3"
    
    if echo "$labels" | grep -qi "backend\|api\|database"; then
        echo "backend"
    elif echo "$labels" | grep -qi "frontend\|ui\|component"; then
        echo "frontend"
    elif echo "$labels" | grep -qi "qa\|test"; then
        echo "qa"
    else
        # Check content
        if echo "$title $body" | grep -qi "api\|endpoint\|database\|supabase\|qstash"; then
            echo "backend"
        elif echo "$title $body" | grep -qi "component\|ui\|react\|shadcn"; then
            echo "frontend"
        else
            echo "general"
        fi
    fi
}

# Function to select appropriate agent
# Now implements two-stage process: tech leads triage first, then assign to engineers
select_agent() {
    local issue_type=$1
    local complexity=$2
    local stage=${3:-triage}  # Default to triage stage
    
    case "$issue_type" in
        backend)
            if [ "$stage" = "triage" ]; then
                echo "backend-tech-lead"
            else
                echo "backend-engineer"
            fi
            ;;
        frontend)
            if [ "$stage" = "triage" ]; then
                echo "frontend-architect"
            else
                echo "frontend-react-engineer"
            fi
            ;;
        qa)
            echo "qa-lead-tester"
            ;;
        *)
            echo "engineering-lead"
            ;;
    esac
}

# Function to create worktree
create_worktree() {
    local issue_num=$1
    local branch_name=$2
    local worktree_path="$WORKTREE_DIR/$branch_name"
    
    # Check if worktree already exists by checking git worktree list
    if git worktree list | grep -q "$worktree_path"; then
        info "Worktree already exists at $worktree_path"
        # Ensure we're on the right branch
        (cd "$worktree_path" && git checkout "$branch_name" 2>/dev/null || true)
        echo "$worktree_path"
        return 0
    fi
    
    log "Creating worktree for issue #$issue_num at $worktree_path"
    
    # Check if directory exists but is not a worktree (cleanup needed)
    if [ -d "$worktree_path" ]; then
        warning "Directory exists but is not a worktree, cleaning up..."
        rm -rf "$worktree_path"
    fi
    
    # Check if branch exists locally
    if git show-ref --verify --quiet "refs/heads/$branch_name"; then
        log "Branch $branch_name already exists locally"
        git worktree add "$worktree_path" "$branch_name"
    # Check if branch exists on remote
    elif git ls-remote --heads origin "$branch_name" | grep -q "$branch_name"; then
        log "Branch $branch_name exists on remote, checking out"
        git fetch origin "$branch_name":"$branch_name"
        git worktree add "$worktree_path" "$branch_name"
    else
        log "Creating new branch $branch_name from main"
        git worktree add -b "$branch_name" "$worktree_path" main
    fi
    
    # Setup worktree environment
    setup_worktree_environment "$worktree_path"
    
    echo "$worktree_path"
}

# Function to setup worktree environment
setup_worktree_environment() {
    local worktree_path=$1
    
    log "Setting up environment for worktree at $worktree_path"
    
    # Copy environment files from main project
    if [ -f "$PROJECT_ROOT/.env.local" ]; then
        cp "$PROJECT_ROOT/.env.local" "$worktree_path/"
        info "Copied .env.local"
    fi
    
    if [ -f "$PROJECT_ROOT/.env.development.local" ]; then
        cp "$PROJECT_ROOT/.env.development.local" "$worktree_path/"
        info "Copied .env.development.local"
    fi
    
    if [ -d "$PROJECT_ROOT/.vercel" ]; then
        cp -r "$PROJECT_ROOT/.vercel" "$worktree_path/"
        info "Copied .vercel directory"
    fi
    
    # Copy Claude settings to worktree
    if [ -d "$PROJECT_ROOT/.claude" ]; then
        mkdir -p "$worktree_path/.claude"
        
        # Copy all Claude settings including local settings
        if [ -f "$PROJECT_ROOT/.claude/settings.local.json" ]; then
            cp "$PROJECT_ROOT/.claude/settings.local.json" "$worktree_path/.claude/"
            info "Copied .claude/settings.local.json"
        fi
        
        # Copy agent definitions if they exist
        if [ -d "$PROJECT_ROOT/.claude/agents" ]; then
            cp -r "$PROJECT_ROOT/.claude/agents" "$worktree_path/.claude/"
            info "Copied .claude/agents directory"
        fi
        
        # Copy any other Claude configuration files
        for file in "$PROJECT_ROOT/.claude"/*.{json,md,yaml,yml} 2>/dev/null; do
            if [ -f "$file" ] && [ "$(basename "$file")" != "settings.local.json" ]; then
                cp "$file" "$worktree_path/.claude/"
                info "Copied $(basename "$file")"
            fi
        done
    fi
    
    # Install dependencies
    log "Installing dependencies with bun..."
    (cd "$worktree_path" && bun install) || {
        error "Failed to install dependencies, but continuing..."
    }
    
    info "Worktree environment setup complete"
}

# Function to create agent instructions
create_agent_instructions() {
    local issue_num=$1
    local agent_type=$2
    local worktree_path=$3
    local issue_title=$4
    local issue_body=$5
    local stage=${6:-implementation}  # Default to implementation stage
    
    local instructions_file="$INSTRUCTIONS_DIR/issue-${issue_num}-${stage}-instructions.md"
    
    if [ "$stage" = "triage" ]; then
        # Triage stage instructions for tech leads
        cat > "$instructions_file" << EOF
# Agent Instructions for Issue #$issue_num - TRIAGE STAGE

## Agent: $agent_type
## Working Directory: $worktree_path
## Stage: TRIAGE

## Issue Details
**Title:** $issue_title
**Description:**
$issue_body

## Your Task - Technical Review and Planning

As the $agent_type, you are responsible for triaging this issue before implementation. Your tasks:

### 1. Technical Analysis
- Review the issue requirements thoroughly
- Analyze the codebase to understand current implementation
- Identify all components that need to be modified
- Assess technical complexity and potential risks

### 2. Architecture Planning
- Design the solution architecture
- Identify required design patterns
- Plan component interfaces and data flow
- Consider performance and scalability implications

### 3. Implementation Plan
- Break down the work into specific tasks
- Create a detailed implementation checklist
- Identify dependencies and prerequisites
- Estimate complexity for each component

### 4. Create Implementation Guide
- Write detailed technical specifications
- Document key decisions and trade-offs
- Prepare code examples or pseudocode where helpful
- List acceptance criteria and test scenarios

### 5. Prepare for Handoff
- Create a comprehensive TODO list using TodoWrite
- Document any setup requirements
- Note potential challenges or blockers
- Prepare questions that need clarification

**IMPORTANT**: Do NOT implement the solution. Your role is to:
- Analyze and plan the technical approach
- Create detailed specifications
- Prepare everything for the implementation engineer
- The implementation will be done by ${agent_type/tech-lead/engineer} or ${agent_type/architect/engineer} in the next stage

When complete, provide a summary with:
1. Technical approach overview
2. Detailed task breakdown
3. Key architectural decisions
4. Implementation readiness checklist
EOF
    else
        # Implementation stage instructions for engineers
        cat > "$instructions_file" << EOF
# Agent Instructions for Issue #$issue_num - IMPLEMENTATION STAGE

## Agent: $agent_type
## Working Directory: $worktree_path
## Stage: IMPLEMENTATION

## Issue Details
**Title:** $issue_title
**Description:**
$issue_body

## Your Task - Implementation

You are tasked with implementing issue #$issue_num. The technical approach has been reviewed and planned by the tech lead.

### 1. Review Previous Analysis
- Check for any triage notes in: $INSTRUCTIONS_DIR/issue-${issue_num}-triage-instructions.md
- Review any TODO lists or specifications created during triage
- Understand the technical approach that was planned

### 2. Setup and Context
- Your working directory is already set to: $worktree_path
- You are on branch: $(cd "$worktree_path" && git branch --show-current)
- Review the project guidelines in CLAUDE.md

### 3. Implementation Steps
EOF
    fi

    # Add agent-specific instructions
    case "$agent_type" in
        backend-engineer|backend-tech-lead)
            cat >> "$instructions_file" << 'EOF'
- Review existing API patterns in /app/api/v1/
- Implement the required endpoint following REST principles
- Use Zod for input validation
- Ensure all DB operations go through API routes
- Queue long-running tasks with QStash if needed
- Write comprehensive tests using Vitest
EOF
            ;;
        frontend-react-engineer|frontend-architect)
            cat >> "$instructions_file" << 'EOF'
- Review existing components in /components/
- Use shadcn/ui components exclusively
- Apply theme variables, avoid inline Tailwind
- Use TanStack Query for server state
- Keep components pure and avoid useEffect when possible
- Write component tests
EOF
            ;;
        qa-lead-tester)
            cat >> "$instructions_file" << 'EOF'
- Review the implementation thoroughly
- Verify all acceptance criteria are met
- Check test coverage (>80% backend, >75% frontend)
- Validate error handling and edge cases
- Ensure no security vulnerabilities
- Verify performance is acceptable
EOF
            ;;
    esac

    cat >> "$instructions_file" << 'EOF'

### 3. Testing and Validation
- Run tests: `bun test`
- Check types: `bun tsc --noEmit`
- Lint code: `bunx @biomejs/biome check --write .`

### 4. Commit Guidelines
- Make frequent, descriptive commits
- Format: `feat:` / `fix:` / `refactor:` + description
- Example: `feat: add user profile update endpoint`

### 5. Create Pull Request
When implementation is complete:
```bash
gh pr create \
  --title "fix: #ISSUE_NUM - ISSUE_TITLE" \
  --body "Closes #ISSUE_NUM\n\n## Changes\n- List changes here\n\n## Testing\n- Describe testing done" \
  --assignee "@me"
```

### 6. Success Criteria
- [ ] All requirements implemented
- [ ] Tests written and passing
- [ ] Code linted and formatted
- [ ] Types check passing
- [ ] PR created with proper description

## Available Commands
- `bun dev` - Start development server
- `bun test` - Run tests
- `bun build` - Build the project
- `gh issue view ISSUE_NUM` - View issue details
- `gh pr create` - Create pull request
- `gh pr checks` - View PR checks status

Remember to use the TodoWrite tool to track your progress!
EOF

    # Replace placeholders
    sed -i.bak "s/ISSUE_NUM/$issue_num/g" "$instructions_file"
    sed -i.bak "s/ISSUE_TITLE/$issue_title/g" "$instructions_file"
    rm -f "${instructions_file}.bak"
    
    echo "$instructions_file"
}

# Function to launch Claude with agent using Cursor
launch_cursor_with_agent() {
    local worktree_path=$1
    local agent_type=$2
    local instructions_file=$3
    local issue_num=$4
    
    log "Launching Cursor IDE with $agent_type agent"
    
    # Open Cursor in the worktree
    info "Opening Cursor IDE at $worktree_path"
    cursor "$worktree_path" &
    
    sleep 3
    
    # Create a launch script that can be run in Cursor's terminal
    local launch_script="$worktree_path/.launch-claude.sh"
    
    cat > "$launch_script" << EOF
#!/bin/bash
# Launch Claude Code with agent context

echo "Starting Claude Code with $agent_type agent..."
echo ""
echo "Instructions are available at: $instructions_file"
echo ""
echo "Initial prompt for Claude:"
echo ""

# Create initial prompt with agent references
if [ "$agent_type" = "backend-tech-lead" ] || [ "$agent_type" = "frontend-architect" ]; then
    # Tech lead/architect prompt with delegation
    prompt="Can you get the @agent-$agent_type to validate the plan for issue #$issue_num.

First, read the instructions at $instructions_file to understand the requirements.

Then:
1. Analyze the technical approach and architecture
2. Create a detailed implementation plan
3. Delegate the work to @agent-${agent_type/tech-lead/engineer} or @agent-${agent_type/architect/react-engineer} who should make regular commits
4. Involve the @agent-qa-lead-tester to create a test suite and validate the implementation
5. Validate the work at the end through a PR review

The implementation engineer should:
- Make frequent, descriptive commits
- Follow the coding standards in CLAUDE.md
- Write comprehensive tests
- Create a PR when complete"
elif [ "$agent_type" = "backend-engineer" ] || [ "$agent_type" = "frontend-react-engineer" ]; then
    # Implementation engineer prompt
    prompt="Can you get the @agent-$agent_type to implement issue #$issue_num.

Please read the instructions at $instructions_file and implement the issue.

Work closely with:
- @agent-qa-lead-tester for test coverage and validation
- The tech lead/architect who assigned this task for guidance

Remember to:
1. Read the instructions file and any triage notes
2. Understand the codebase structure
3. Implement the required changes incrementally
4. Make regular, descriptive commits
5. Write comprehensive tests
6. Coordinate with @agent-qa-lead-tester for test validation
7. Create a PR when implementation is complete"
elif [ "$agent_type" = "qa-lead-tester" ]; then
    # QA lead prompt
    prompt="Can you get the @agent-qa-lead-tester to validate issue #$issue_num implementation.

Please read the instructions at $instructions_file.

Your responsibilities:
1. Review the implementation for quality and completeness
2. Create comprehensive test suites for all new functionality
3. Generate mock data for API endpoints if applicable
4. Validate error handling and edge cases
5. Ensure test coverage meets standards (>80% backend, >75% frontend)
6. Coordinate with @agent-backend-engineer or @agent-frontend-react-engineer on any issues found
7. Approve the PR when quality standards are met"
else
    # Default prompt for other agents
    prompt="You are working as a @agent-$agent_type on issue #$issue_num.

Please read the instructions at $instructions_file and implement the issue.

Start by:
1. Reading the instructions file
2. Understanding the codebase structure
3. Implementing the required changes
4. Testing your implementation
5. Creating commits with descriptive messages"
fi

echo "\$prompt"
echo ""
echo "========================================"
echo "To launch Claude Code manually, run:"
echo "  claude \"\$prompt\"
echo "========================================"
echo ""

# Try to launch Claude automatically
if command -v claude &> /dev/null; then
    echo "Attempting to launch Claude Code..."
    claude "\$prompt"
else
    echo "Claude CLI not found in PATH."
    echo "Please run the command above manually to start Claude Code."
    echo ""
    echo "If Claude is not installed, install it with:"
    echo "  npm install -g @anthropic-ai/claude"
fi
EOF

    chmod +x "$launch_script"
    
    info "Launch script created at $launch_script"
    info ""
    info "========================================"
    info "MANUAL LAUNCH INSTRUCTIONS:"
    info "If Claude doesn't auto-launch, run this in the Cursor terminal:"
    info "  ./.launch-claude.sh"
    info "========================================"
    
    # Create a VS Code task file for auto-launch (may not work in all environments)
    mkdir -p "$worktree_path/.vscode"
    cat > "$worktree_path/.vscode/tasks.json" << 'EOF'
{
    "version": "2.0.0",
    "tasks": [
        {
            "label": "Launch Claude Code Agent",
            "type": "shell",
            "command": "./.launch-claude.sh",
            "runOptions": {
                "runOn": "folderOpen"
            },
            "presentation": {
                "reveal": "always",
                "panel": "new"
            },
            "problemMatcher": []
        }
    ]
}
EOF
    
    info "VS Code task created for auto-launch (may require manual trigger)"
}

# Function to launch Claude CLI directly
launch_claude_cli_with_agent() {
    local worktree_path=$1
    local agent_type=$2
    local instructions_file=$3
    local issue_num=$4
    
    log "Launching Claude CLI with $agent_type agent for issue #$issue_num"
    
    # Change to worktree directory
    cd "$worktree_path"
    
    # Create initial prompt with agent references
    if [ "$agent_type" = "backend-tech-lead" ] || [ "$agent_type" = "frontend-architect" ]; then
        # Tech lead/architect prompt with delegation
        local prompt="Can you get the @agent-$agent_type to validate the plan for issue #$issue_num.

First, read the instructions at: cat $instructions_file

Then:
1. Analyze the technical approach and architecture
2. Create a detailed implementation plan using TodoWrite
3. Delegate the work to @agent-${agent_type/tech-lead/engineer} or @agent-${agent_type/architect/react-engineer} who should make regular commits
4. Involve the @agent-qa-lead-tester to create test suites and mock data
5. Validate the work at the end through a PR review

The implementation should include:
- Frequent, descriptive commits
- Comprehensive test coverage
- Following CLAUDE.md guidelines
- Creating a PR when complete"
    elif [ "$agent_type" = "backend-engineer" ] || [ "$agent_type" = "frontend-react-engineer" ]; then
        # Implementation engineer prompt
        local prompt="Can you get the @agent-$agent_type to implement issue #$issue_num.

Start by reading: cat $instructions_file

Work closely with:
- @agent-qa-lead-tester for test coverage and validation
- The tech lead who created the plan for guidance

Implementation steps:
1. Review any triage notes and technical plans
2. Understand the codebase: ls -la && cat CLAUDE.md
3. Implement changes incrementally with regular commits
4. Write comprehensive tests with @agent-qa-lead-tester
5. Validate implementation meets requirements
6. Create PR with detailed description

Remember to:
- Make frequent, descriptive commits
- Follow coding standards in CLAUDE.md
- Use TodoWrite to track progress"
    elif [ "$agent_type" = "qa-lead-tester" ]; then
        # QA lead prompt
        local prompt="Can you get the @agent-qa-lead-tester to validate issue #$issue_num.

Start by reading: cat $instructions_file

Your responsibilities:
1. Review implementation quality and completeness
2. Create comprehensive test suites for all functionality
3. Generate mock data for API endpoints
4. Validate error handling and edge cases
5. Ensure coverage: >80% backend, >75% frontend
6. Coordinate with @agent-backend-engineer or @agent-frontend-react-engineer on issues
7. Approve PR when standards are met

Use TodoWrite to track testing tasks."
    else
        # Default prompt
        local prompt="You are working as @agent-$agent_type on issue #$issue_num.

Read instructions: cat $instructions_file

Steps:
1. Understand codebase: ls -la && cat CLAUDE.md
2. Implement required changes
3. Test implementation
4. Create descriptive commits
5. Create PR when complete

Use TodoWrite to track your progress."
    fi

    # Launch Claude using the agent-launcher script
    if [ -f "$SCRIPT_DIR/agent-launcher.sh" ]; then
        # Use the agent-launcher script if available
        CLAUDE_MODE="${CLAUDE_MODE:-repl}" \
        CLAUDE_MODEL="${CLAUDE_MODEL:-}" \
        CLAUDE_MAX_TURNS="${CLAUDE_MAX_TURNS:-20}" \
        "$SCRIPT_DIR/agent-launcher.sh" implement "$worktree_path" "$issue_num" "$agent_type"
    else
        # Fallback to direct Claude CLI launch
        if [ "${CLAUDE_MODE:-repl}" = "print" ]; then
            claude -p "$prompt" --max-turns "${CLAUDE_MAX_TURNS:-20}"
        else
            claude "$prompt"
        fi
    fi
    
    log "Claude CLI session completed for issue #$issue_num"
}

# Function to process issue
process_issue() {
    local issue_num=$1
    local stage=${2:-triage}  # Default to triage stage
    
    log "Processing issue #$issue_num (stage: $stage)"
    
    # Get issue details
    local issue_json=$(gh issue view "$issue_num" --json number,title,body,labels,assignees)
    local title=$(echo "$issue_json" | jq -r '.title')
    local body=$(echo "$issue_json" | jq -r '.body // ""')
    local labels=$(echo "$issue_json" | jq -r '.labels | map(.name) | join(" ")')
    local assignees=$(echo "$issue_json" | jq -r '.assignees | length')
    
    # Determine issue type and complexity
    local issue_type=$(determine_issue_type "$title" "$body" "$labels")
    local complexity="normal"  # Could be enhanced with complexity detection
    
    # Select appropriate agent based on stage
    local agent_type=$(select_agent "$issue_type" "$complexity" "$stage")
    
    # Assign issue to current user if not already assigned
    if [ "$assignees" -eq 0 ]; then
        log "Assigning issue #$issue_num to current user..."
        gh issue edit "$issue_num" --add-assignee "@me" || {
            warning "Failed to assign issue #$issue_num, but continuing..."
        }
        
        # Add a comment to indicate work has started
        local comment="🤖 Claude Code workflow has picked up this issue.

**Agent:** ${agent_type}
**Stage:** ${stage}
**Started:** $(date -u +"%Y-%m-%d %H:%M:%S UTC")"
        
        gh issue comment "$issue_num" --body "$comment" || {
            warning "Failed to add comment to issue #$issue_num"
        }
    else
        info "Issue #$issue_num already has assignees"
    fi
    
    log "Issue type: $issue_type, Stage: $stage, Agent: $agent_type"
    
    # Create branch name
    local branch_name=$(sanitize_branch_name "$issue_num" "$title")
    
    # Create worktree
    local worktree_path=$(create_worktree "$issue_num" "$branch_name")
    
    # Create agent instructions (different for triage vs implementation)
    local instructions_file=$(create_agent_instructions "$issue_num" "$agent_type" "$worktree_path" "$title" "$body" "$stage")
    
    # Track state
    local state_file="$STATE_DIR/issue-${issue_num}.json"
    cat > "$state_file" << EOF
{
  "issue_number": $issue_num,
  "title": "$title",
  "agent": "$agent_type",
  "stage": "$stage",
  "worktree_path": "$worktree_path",
  "branch": "$branch_name",
  "instructions": "$instructions_file",
  "status": "assigned",
  "timestamp": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF

    # Choose launch method based on environment variable
    local launch_method="${LAUNCH_METHOD:-cursor}"
    
    if [ "$launch_method" = "claude-cli" ]; then
        # Launch Claude CLI directly
        launch_claude_cli_with_agent "$worktree_path" "$agent_type" "$instructions_file" "$issue_num"
    else
        # Launch Cursor with Claude context (default)
        launch_cursor_with_agent "$worktree_path" "$agent_type" "$instructions_file" "$issue_num"
    fi
    
    log "Issue #$issue_num assigned to $agent_type"
}

# Function to monitor PR reviews
monitor_pr_reviews() {
    log "Checking for PRs that need review..."
    
    local prs=$(gh pr list --json number,headRefName,state,reviews)
    
    echo "$prs" | jq -c '.[]' | while read -r pr; do
        local pr_num=$(echo "$pr" | jq -r '.number')
        local branch=$(echo "$pr" | jq -r '.headRefName')
        local reviews=$(echo "$pr" | jq -r '.reviews | length')
        
        if [ "$reviews" -eq 0 ]; then
            log "PR #$pr_num needs review"
            
            # Create review instructions
            local review_file="$INSTRUCTIONS_DIR/pr-${pr_num}-review.md"
            cat > "$review_file" << EOF
# Review Instructions for PR #$pr_num

Please review this PR using the qa-lead-tester agent:

1. Check the diff: gh pr diff $pr_num
2. Verify CI checks: gh pr checks $pr_num
3. Review for:
   - Code quality and patterns
   - Test coverage
   - Security issues
   - Performance concerns
4. Leave feedback: gh pr review $pr_num --comment -b "feedback"
5. Approve or request changes

Use the Task tool to invoke the qa-lead-tester agent for this review.
EOF
            
            info "Review instructions created at $review_file"
            
            # Optionally auto-launch review agent if configured
            if [ "${AUTO_LAUNCH_REVIEW:-no}" = "yes" ]; then
                launch_review_agent "$pr_num" "$review_file"
            fi
        fi
    done
}

# Function to launch review agent
launch_review_agent() {
    local pr_num=$1
    local review_file=$2
    local agent_type="qa-lead-tester"
    
    log "Launching review for PR #$pr_num with $agent_type"
    
    local launch_method="${LAUNCH_METHOD:-cursor}"
    
    if [ "$launch_method" = "claude-cli" ]; then
        # Launch Claude CLI for review
        if [ -f "$SCRIPT_DIR/agent-launcher.sh" ]; then
            CLAUDE_MODE="${CLAUDE_MODE:-repl}" \
            CLAUDE_MODEL="${CLAUDE_MODEL:-}" \
            CLAUDE_MAX_TURNS="${CLAUDE_MAX_TURNS:-15}" \
            "$SCRIPT_DIR/agent-launcher.sh" review "$pr_num" "$agent_type"
        else
            # Fallback to direct Claude CLI
            local prompt="You are acting as a $agent_type reviewing PR #$pr_num.

Please review the PR:
1. Check the diff: gh pr diff $pr_num
2. Verify CI checks: gh pr checks $pr_num
3. Review for code quality, test coverage, security, and performance
4. Leave constructive feedback
5. Approve or request changes as appropriate"
            
            if [ "${CLAUDE_MODE:-repl}" = "print" ]; then
                claude -p "$prompt" --max-turns "${CLAUDE_MAX_TURNS:-15}"
            else
                claude "$prompt"
            fi
        fi
    else
        info "Please review PR #$pr_num manually using the instructions at $review_file"
    fi
}

# Function to cleanup merged PRs
cleanup_merged() {
    log "Cleaning up merged PRs..."
    
    # First prune any stale worktrees
    git worktree prune
    
    local merged=$(gh pr list --state merged --json number,headRefName)
    
    echo "$merged" | jq -c '.[]' | while read -r pr; do
        local pr_num=$(echo "$pr" | jq -r '.number')
        local branch=$(echo "$pr" | jq -r '.headRefName')
        local issue_num=$(echo "$branch" | cut -d'-' -f1)
        
        local worktree_path="$WORKTREE_DIR/$branch"
        
        if [ -d "$worktree_path" ]; then
            log "Cleaning up worktree for PR #$pr_num"
            git worktree remove "$worktree_path" --force 2>/dev/null || true
            git branch -D "$branch" 2>/dev/null || true
            rm -f "$STATE_DIR/issue-${issue_num}.json"
            rm -f "$INSTRUCTIONS_DIR/issue-${issue_num}-instructions.md"
        fi
    done
    
    # Clean up any orphaned worktrees
    cleanup_orphaned_worktrees
}

# Function to cleanup orphaned worktrees
cleanup_orphaned_worktrees() {
    log "Checking for orphaned worktrees..."
    
    # Get list of all worktrees
    git worktree list --porcelain | grep "^worktree " | cut -d' ' -f2 | while read -r worktree_path; do
        # Skip the main worktree
        if [ "$worktree_path" = "$PROJECT_ROOT" ]; then
            continue
        fi
        
        # Check if worktree directory exists
        if [ ! -d "$worktree_path" ]; then
            warning "Removing stale worktree entry: $worktree_path"
            git worktree prune
        fi
    done
}

# Function to show status
show_status() {
    echo -e "${MAGENTA}=== Workflow Status ===${NC}"
    
    echo -e "\n${BLUE}Active Issues:${NC}"
    if ls "$STATE_DIR"/*.json >/dev/null 2>&1; then
        for state_file in "$STATE_DIR"/*.json; do
            local issue_num=$(jq -r '.issue_number' "$state_file")
            local agent=$(jq -r '.agent' "$state_file")
            local stage=$(jq -r '.stage // "unknown"' "$state_file")
            local status=$(jq -r '.status' "$state_file")
            echo "  Issue #$issue_num - Stage: $stage - Agent: $agent - Status: $status"
        done
    else
        echo "  No active issues"
    fi
    
    echo -e "\n${BLUE}Worktrees:${NC}"
    git worktree list | grep -v "$(pwd)" || echo "  No active worktrees"
    
    echo -e "\n${BLUE}Open PRs:${NC}"
    gh pr list --limit 10 || echo "  No open PRs"
}

# Main command handler
case "${1:-}" in
    assign)
        if [ -z "${2:-}" ]; then
            error "Usage: $0 assign <issue_number>"
            exit 1
        fi
        process_issue "$2" "triage"
        ;;
    implement)
        if [ -z "${2:-}" ]; then
            error "Usage: $0 implement <issue_number>"
            exit 1
        fi
        process_issue "$2" "implementation"
        ;;
    review)
        monitor_pr_reviews
        ;;
    cleanup)
        cleanup_merged
        ;;
    status)
        show_status
        ;;
    reset)
        log "Resetting all worktrees and state..."
        git worktree prune
        rm -rf "$WORKTREE_DIR"/*
        rm -f "$STATE_DIR"/*.json
        rm -f "$INSTRUCTIONS_DIR"/*.md
        log "Reset complete"
        ;;
    *)
        echo "Claude Code Workflow Manager"
        echo ""
        echo "Usage: $0 {assign|implement|review|cleanup|status|reset}"
        echo ""
        echo "Commands:"
        echo "  assign <issue_num>     - Assign issue to tech lead for triage"
        echo "  implement <issue_num>  - Assign issue to engineer for implementation"
        echo "  review                 - Check for PRs needing review"
        echo "  cleanup                - Clean up merged PR worktrees"
        echo "  status                 - Show current workflow status"
        echo "  reset                  - Reset all worktrees and state"
        echo ""
        echo "Environment Variables:"
        echo "  LAUNCH_METHOD=cursor|claude-cli  (default: cursor)"
        echo "    - cursor: Opens Cursor IDE with context"
        echo "    - claude-cli: Launches Claude CLI directly"
        echo ""
        echo "  CLAUDE_MODE=repl|print  (default: repl)"
        echo "    - repl: Interactive mode"
        echo "    - print: Non-interactive mode (requires LAUNCH_METHOD=claude-cli)"
        echo ""
        echo "  CLAUDE_MODEL=<model>  (optional, e.g., claude-3-5-sonnet-20241022)"
        echo "  CLAUDE_MAX_TURNS=<number>  (default: 20 for implement, 15 for review)"
        echo "  AUTO_LAUNCH_REVIEW=yes|no  (default: no) - Auto-launch review agents"
        echo ""
        echo "Example workflows:"
        echo ""
        echo "  # Two-stage workflow (recommended):"
        echo "  $0 assign 123        # Tech lead triages the issue"
        echo "  $0 implement 123     # Engineer implements after triage"
        echo ""
        echo "  # Default triage (Cursor IDE):"
        echo "  $0 assign 123"
        echo ""
        echo "  # Claude CLI interactive:"
        echo "  LAUNCH_METHOD=claude-cli $0 assign 123"
        echo ""
        echo "  # Claude CLI non-interactive with auto-review:"
        echo "  LAUNCH_METHOD=claude-cli CLAUDE_MODE=print AUTO_LAUNCH_REVIEW=yes $0 implement 123"
        echo ""
        echo "  # Review PRs:"
        echo "  $0 review"
        echo ""
        echo "  # Cleanup after merge:"
        echo "  $0 cleanup"
        exit 1
        ;;
esac