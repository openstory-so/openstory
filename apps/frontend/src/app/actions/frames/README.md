# Frame Generation Actions

This module handles frame generation for video sequences in Velro.

## Architecture

Frame generation is split into two phases for optimal user experience:

### Phase 1: Quick Frame Creation (Synchronous)
- Happens immediately when user triggers frame generation
- Analyzes script to determine frame boundaries
- Generates detailed descriptions for each frame
- Creates frame records in database
- User sees frames appear instantly in the UI

### Phase 2: Image Generation (Asynchronous)
- Individual jobs queued for each frame's thumbnail
- Images generate in parallel using AI models
- Each frame updates independently as its image completes
- Better progress tracking and error handling per frame

## Key Functions

### `generateFramesAction`
Main entry point for frame generation. Performs Phase 1 synchronously then queues Phase 2 jobs.

**Options:**
- `framesPerScene`: Number of frames to generate per scene (default: 5)
- `generateThumbnails`: Whether to generate images (default: true)
- `aiProvider`: AI provider to use (openai/anthropic/openrouter)
- `regenerateAll`: Delete existing frames before generating (default: true)

### Benefits of the Two-Phase Approach

1. **Instant Feedback**: Users see frames immediately instead of waiting minutes
2. **Better Progress Tracking**: Each frame's image generates independently
3. **Improved Error Recovery**: If one image fails, others continue
4. **Reduced Timeout Risk**: No single long-running job that might timeout
5. **Parallel Processing**: Multiple images can generate simultaneously

## Testing

Run tests with:
```bash
bun test src/app/actions/frames/__tests__/
```

## Legacy Webhook

The webhook at `/api/v1/webhooks/qstash/frames/` still exists for:
- Backward compatibility with older jobs
- Special frame regeneration cases
- Batch operations that need async processing

However, the main flow no longer uses this webhook for initial frame generation.