#!/bin/bash

# Run biome check and capture output
output=$(bun biome check . 2>&1)
exit_code=$?

# Print the output
echo "$output"

# If there were errors, extract file paths and open them
if [ $exit_code -ne 0 ]; then
    # Extract unique file paths from biome output
    # Biome outputs paths like: /Users/tom/code/velro/src/file.tsx
    files=$(echo "$output" | grep -oE '/[^:]+\.(tsx?|jsx?|css|json)' | sort -u)
    
    if [ -n "$files" ]; then
        echo ""
        echo "Opening files with issues in Cursor..."
        # Open all files in Cursor
        echo "$files" | xargs cursor
    fi
fi

exit $exit_code