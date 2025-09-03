#!/bin/bash

# Add issue number to commit message if branch starts with a number
# Usage: add-issue-number.sh <commit-msg-file>

commit_msg_file="$1"

# Exit if no commit message file provided
if [ -z "$commit_msg_file" ]; then
    exit 0
fi

# Get the current branch name
branch_name=$(git branch --show-current)

# Extract issue number from branch name if it starts with digits followed by a dash
if [[ $branch_name =~ ^([0-9]+)- ]]; then
    issue_number="${BASH_REMATCH[1]}"
    
    # Read the current commit message
    current_msg=$(cat "$commit_msg_file")
    
    # Skip if the commit message already contains the issue number
    if [[ $current_msg =~ \#$issue_number([^0-9]|$) ]]; then
        exit 0
    fi
    
    # Skip if this is a merge commit (starts with "Merge")
    if [[ $current_msg =~ ^Merge ]]; then
        exit 0
    fi
    
    # Skip if this is an empty commit message or just whitespace
    if [[ -z "$(echo "$current_msg" | tr -d '[:space:]')" ]]; then
        exit 0
    fi
    
    # Add issue number to the end of the first line
    echo "$current_msg" | sed "1s/$/ (#$issue_number)/" > "$commit_msg_file"
fi

exit 0