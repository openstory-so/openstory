# Implementation Plan: Issue #64 - Basic Motion Generation

## Issue Details
- **Number**: #64
- **Title**: [Feature] Basic motion generation
- **Description**: Like we created the thumbnails we now need to be able to generate video. Use fal ai to generate motion sequences.
- **Labels**: enhancement

## Current State Analysis

The codebase is already well-prepared for motion generation:
- ✅ Database schema includes `video_url` field in frames table
- ✅ Fal.ai client supports video generation with multiple models
- ✅ QStash infrastructure exists with video webhook endpoint
- ✅ Supabase Storage has a videos bucket configured (500MB limit)
- ✅ Job management system tracks async operations

## Architecture Design

### Approach: Image-to-Video Generation
1. User triggers motion generation for frames with existing thumbnails
2. System queues video generation jobs via QStash
3. Webhook processes jobs using Fal.ai's I2V models
4. Generated videos stored in Supabase Storage
5. Frame records updated with video URLs

### Technical Specifications

**Model Strategy**:
- **Fast**: SVD-LCM (~5s, $0.10/frame)
- **Balanced**: WAN I2V (~15s, $0.25/frame) - Recommended default
- **Premium**: Kling I2V (~30s, $0.50/frame)

**Storage Pattern**:
```
/teams/{teamId}/sequences/{sequenceId}/frames/{frameId}/motion.mp4
```

**API Endpoints**:
- `POST /api/v1/frames/:id/motion` - Generate motion for single frame
- `POST /api/v1/sequences/:id/motion` - Generate motion for all frames
- `GET /api/v1/sequences/:id/motion-status` - Get motion generation status

## Implementation Tasks

### Phase 1: Backend Infrastructure (Priority: HIGH)
1. **Extend Frame Actions** (`/app/api/v1/frames/[frameId]/actions.ts`)
   - Add `generateMotionAction` function
   - Validate frame has thumbnail before motion generation
   - Return job ID for tracking

2. **Create Motion Webhook** (`/app/api/webhooks/qstash/frames-motion/route.ts`)
   - Process motion generation jobs
   - Handle video upload to Supabase Storage
   - Update frame with video URL

3. **Extend QStash Client** (`/lib/qstash/client.ts`)
   - Add `publishMotionJob` method
   - Include motion-specific parameters

### Phase 2: Motion Generation Logic (Priority: HIGH)
1. **Motion Service** (`/lib/services/motion.service.ts`)
   - Prompt enhancement based on frame context
   - Model selection logic
   - Batch processing for sequences

2. **Video Storage Service** (`/lib/services/video-storage.service.ts`)
   - Upload videos to Supabase Storage
   - Generate signed URLs
   - Handle large file uploads

### Phase 3: Progress Tracking (Priority: MEDIUM)
1. **Job Status Updates**
   - Real-time progress via job manager
   - Sequence-level aggregation
   - Estimated completion times

2. **Error Handling**
   - Retry logic with exponential backoff
   - Fallback to lower quality models
   - User notifications for failures

### Phase 4: Frontend Integration (Priority: MEDIUM)
1. **UI Components**
   - Motion generation button for frames
   - Progress indicators
   - Video preview with controls

2. **Batch Operations**
   - Generate motion for entire sequence
   - Cancel/pause operations
   - Quality selection

### Phase 5: Testing & Optimization (Priority: HIGH)
1. **Test Coverage**
   - Unit tests for motion service
   - Integration tests for webhooks
   - E2E tests for full flow

2. **Performance Optimization**
   - Queue optimization for batch jobs
   - Parallel processing where possible
   - Caching strategies

## Code Examples

### Motion Generation Action
```typescript
// /app/api/v1/frames/[frameId]/actions.ts
export async function generateMotionAction(
  frameId: string,
  params: { quality?: 'fast' | 'balanced' | 'premium' }
): Promise<{ jobId: string }> {
  const frame = await getFrame(frameId);
  
  if (!frame.thumbnail_url) {
    throw new Error('Frame must have thumbnail before generating motion');
  }

  const jobId = await qstash.publishMotionJob({
    frameId,
    imageUrl: frame.thumbnail_url,
    prompt: frame.analysis?.prompt,
    quality: params.quality || 'balanced'
  });

  await jobManager.createJob({
    type: 'frame_motion',
    status: 'queued',
    metadata: { frameId, quality: params.quality }
  });

  return { jobId };
}
```

### Motion Webhook Handler
```typescript
// /app/api/webhooks/qstash/frames-motion/route.ts
export async function POST(request: Request) {
  const { frameId, imageUrl, prompt, quality } = await request.json();
  
  try {
    // Generate video using Fal.ai
    const model = getModelByQuality(quality);
    const result = await fal.run(model, {
      image_url: imageUrl,
      prompt: enhanceMotionPrompt(prompt),
      num_frames: 25,
      num_inference_steps: quality === 'fast' ? 4 : 25
    });

    // Upload to Supabase Storage
    const videoUrl = await videoStorage.upload(
      result.video_url,
      `frames/${frameId}/motion.mp4`
    );

    // Update frame
    await updateFrame(frameId, { video_url: videoUrl });
    
    // Update job status
    await jobManager.completeJob(frameId);

    return Response.json({ success: true });
  } catch (error) {
    await jobManager.failJob(frameId, error.message);
    throw error;
  }
}
```

## Risk Assessment

### Technical Challenges
1. **Rate Limiting**: Fal.ai has rate limits - implement queue delays
2. **Large Files**: Videos can be 10-50MB - optimize storage/streaming
3. **Processing Time**: Video generation takes 5-30s - implement progress tracking
4. **Cost Management**: $0.10-0.50 per video - implement user quotas

### Mitigation Strategies
1. Intelligent queue management with delays
2. Progressive enhancement (show thumbnail while generating)
3. Automatic retry with quality fallback
4. User-configurable quality settings
5. Cost tracking and alerts

## Success Criteria
- [ ] Single frame motion generation working end-to-end
- [ ] Batch motion generation for sequences
- [ ] Progress tracking visible in UI
- [ ] Error handling with user feedback
- [ ] Videos playing smoothly in preview
- [ ] All tests passing
- [ ] Documentation updated

## Estimated Timeline
- **Total**: 5-6 days
- **MVP** (single frame): 2 days
- **Full feature**: 4 days
- **Testing & polish**: 1-2 days

## Dependencies
- Existing thumbnail generation must be working
- Fal.ai API credentials configured
- Supabase Storage videos bucket available
- QStash webhook endpoint accessible

## Notes for Implementation
1. Start with single-frame generation to validate flow
2. Use existing patterns from thumbnail generation
3. Prioritize user feedback (progress indicators)
4. Consider mobile performance for video playback
5. Implement cost tracking from day one