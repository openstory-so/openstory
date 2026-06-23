# MSW Mocks for Storybook

This directory contains MSW (Mock Service Worker) handlers for mocking API endpoints in Storybook and tests.

## How It Works

MSW intercepts HTTP requests and returns mock data, allowing components to be developed and tested without a real backend.

### Configuration

- **Handlers**: `handlers.ts` - Defines all mock API endpoints
- **Data Generators**: `data-generators.ts` - Functions to generate realistic mock data
- **Storybook Integration**: `.storybook/preview.ts` - Configures MSW for all stories

## HLS & VTT Mocks

The following endpoints are mocked for video playback testing:

### GET `/api/sequences/:sequenceId/playlist.m3u8`

Generates an HLS playlist with 5 mock scenes:

- **Scenes 1, 2, 4, 5**: Use Big Buck Bunny sample video (completed)
- **Scene 3**: Set to "pending" status (shows placeholder)
- **Duration**: Each scene is 5 seconds

**Example Usage in Stories:**

```tsx
export const MyStory: Story = {
  args: {
    sequenceId: 'demo-sequence-123', // Any ID works
    shots: mockShots,
  },
};
```

### GET `/api/sequences/:sequenceId/chapters.vtt`

Generates WebVTT chapter markers with scene titles:

- Scene 1: "Opening Scene"
- Scene 2: "The Journey Begins"
- Scene 3: "Rising Action"
- Scene 4: "Climax"
- Scene 5: "Resolution"

## Testing Locally

1. **Start Storybook**: `bun storybook`
2. **View Stories**: Navigate to Motion/ScenePlayer
3. **Test Playback**:
   - Click play to start video
   - Click chapter markers to jump between scenes
   - Notice Scene 3 shows placeholder (pending status)

## Adding New Mocks

To add a new mock endpoint:

1. Add handler to `handlers.ts`:

```typescript
http.get('/api/my-endpoint', ({ params }) => {
  return HttpResponse.json({
    success: true,
    data: myMockData,
  });
});
```

2. The handler will automatically be available in all stories (configured in `.storybook/preview.ts`)

## Placeholder Video

For the HLS placeholder to work, create a 1-second video at:
`public/placeholders/loading.mp4`

See `public/placeholders/README.md` for instructions on creating this file.

## Notes

- MSW runs in the browser's service worker (Storybook) or Node.js (tests)
- Handlers use TypeScript for full type safety
- Mock data is generated with Faker.js for realistic content
- All handlers support dynamic parameters (IDs, filters, etc.)
