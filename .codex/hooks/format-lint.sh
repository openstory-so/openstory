#!/bin/bash

# Hook to format and lint files after Write/Edit operations
file_path=$(jq -r '.tool_input.file_path')

# Only process source files
if [[ ! "$file_path" =~ \.(ts|tsx|js|jsx)$ ]]; then
  exit 0
fi

# Read ignorePatterns from oxfmt config and skip matching files
# (oxfmt doesn't enforce ignorePatterns for explicitly-passed file paths)
if [[ -f "$CLAUDE_PROJECT_DIR/.oxfmtrc.json" ]]; then
  while IFS= read -r pattern; do
    # Convert glob pattern to regex: ** → .*, * → [^/]*
    regex=$(echo "$pattern" | sed 's/\*\*/.*/g; s/\*/[^\/]*/g')
    if [[ "$file_path" =~ $regex ]]; then
      exit 0
    fi
  done < <(jq -r '.ignorePatterns[]' "$CLAUDE_PROJECT_DIR/.oxfmtrc.json" 2>/dev/null)
fi

bunx oxfmt "$file_path"
bunx oxlint --fix "$file_path"
