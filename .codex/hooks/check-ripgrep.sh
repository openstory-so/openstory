#!/bin/bash

# Hook to prevent using find/grep and suggest rg (ripgrep) instead
tool_name=$(jq -r '.tool_name')
command=$(jq -r '.tool_input.command // empty')

# Only check Bash tool
if [[ "$tool_name" == "Bash" && -n "$command" ]]; then
  # Check if command contains find or grep (but not ripgrep/rg)
  if echo "$command" | grep -qE '\b(find|grep)\b' && ! echo "$command" | grep -qE '\b(rg|ripgrep)\b'; then
    echo "⚠️  Please use 'rg' (ripgrep) via the Grep tool instead of 'find' or 'grep' commands."
    echo "The Grep tool is optimized and faster than bash find/grep."
    exit 1  # Block the tool execution
  fi
fi

exit 0  # Allow the tool execution
