# Implementation Plan: Issue #50 - Anonymous User Flow

## Executive Summary

This plan outlines the implementation of a frontend-only anonymous user flow that allows users to test the complete video creation experience with mocked data. Users can input scripts, generate storyboards, and add motion to frames using simulated responses. The focus is on perfecting the UX flow before implementing real backend services.

**Timeline**: 5 working days
**Priority**: High - Core user experience feature
**Risk Level**: Low - Frontend-only with existing components and mock data

## Technical Requirements

### Core Features
1. **Anonymous User Simulation**: Simulate long-lived anonymous users with localStorage persistence
2. **Three-Step Creation Flow**: Script → Storyboard → Motion
3. **Mock Data Persistence**: Store user work in localStorage to simulate database behavior
4. **Simulated AI Responses**: Mock script analysis, frame generation, and image/video creation
5. **Frame CRUD**: Create, read, update, delete, and reorder frames with local state
6. **Upgrade Flow Mockup**: Show upgrade prompts and simulate magic link transition

### Technology Stack
- **Frontend**: Next.js 15, React 19, TypeScript
- **Storage**: localStorage for simulating persistence
- **Mocking**: Faker.js for consistent mock data generation
- **State**: Reducers for complex UI state
- **Components**: shadcn/ui components (existing)
- **Validation**: Zod schemas for data validation
- **Delays**: Simulated async operations with realistic timing

## Component Architecture

### Page Structure
```
src/
├── app/
│   └── create/
│       └── page.tsx (Main anonymous flow page)
├── components/
│   └── sequence/ (existing sequence components)
│       ├── script-step.tsx (Step 1)
│       ├── storyboard-step.tsx (Step 2)
│       └── motion-step.tsx (Step 3)
├── hooks/
│   ├── use-anonymous-flow.ts
│   └── use-auto-save.ts
└── reducers/
    └── anonymous-flow-reducer.ts
```

### State Structure
```typescript
interface StoryboardFlowState {
  currentStep: 1 | 2 | 3
  user: {
    id: string // Simulated anonymous user ID
    isAnonymous: boolean
    createdAt: Date
  }
  sequence: {
    id: string // Local sequence ID
    script: string
    enhanced_script?: string
    style_stack_id: string | null
    frames: MockFrame[]
    lastSaved: Date
  }
  generation: {
    jobs: Record<string, MockJobStatus>
    isGenerating: boolean
  }
  ui: {
    showUpgradePrompt: boolean
    hasUnsavedChanges: boolean
  }
}
```

## Implementation Steps

### Phase 1: Foundation (Days 1-2)

#### 1.1 Create Anonymous Flow Page
```typescript
// src/app/create/page.tsx
- Set up main container with step navigation
- Initialize or retrieve anonymous user from localStorage
- Load existing sequence data from localStorage
- Use existing sequence components
```

#### 1.2 Implement Flow Reducer
```typescript
// src/reducers/anonymous-flow-reducer.ts
- Extend existing sequence form reducer
- Add localStorage sync actions
- Add frame CRUD actions
- Handle step transitions
- Manage simulated anonymous user state
```

#### 1.3 Create Mock Data Management
```typescript
// src/app/actions/anonymous-flow/index.mock.ts
- validateScript() - Simple mock validation (always passes)
- enhanceScript() - Add some mock enhancements
- generateFrames() - Split script into mock frames with fake images
- generateFrameImage() - Return Picsum placeholder URLs
- generateMotion() - Return mock video URLs

// src/hooks/use-anonymous-session.ts
- Manages anonymous user ID in localStorage
- Simulates long-lived sessions
- Provides mock upgrade-to-magic-link functionality
```

### Phase 2: Script & Style Step (Days 2-3)

#### 2.1 Script Step Component
```typescript
// src/components/sequence/script-step.tsx
- Integrate existing ScriptEditor component
- Auto-save script changes to localStorage
- Add mock validation feedback UI
- Show mock enhancement notification with simulated delays
```

#### 2.2 Style Selection
```typescript
// Extend script-step.tsx
- Integrate existing StyleSelector component
- Use mock style stacks from existing Storybook data
- Preview selected style
- Save style selection to localStorage
```

#### 2.3 Storyboard Generation
```typescript
// Add to script-step.tsx
- "Generate Storyboard" button
- Show mock loading state (2-3 second delay)
- Generate mock frames based on script length
- Transition to Step 2 on completion
```

### Phase 3: Storyboard Step (Days 3-4)

#### 3.1 Frame List View
```typescript
// src/components/sequence/storyboard-step.tsx
- Display mock frames using existing StoryboardFrame component
- Drag-and-drop reordering with localStorage sync
- Frame selection state
- Use mock frame data with consistent images
```

#### 3.2 Frame CRUD Operations
```typescript
// Add to storyboard-step.tsx
- Edit script section inline with localStorage auto-save
- Mock creative direction chat interface
- Add frame dialog with mock frame creation
- Split frame functionality with mock data updates
- Delete with confirmation and localStorage removal
```

#### 3.3 Frame Image Regeneration
```typescript
// Add frame regeneration
- Mock image generation (1-2 second delays)
- Regenerate button per frame returns new Picsum URL
- Loading states with mock progress
- Simple error simulation and retry
```

### Phase 4: Motion Step (Days 4-5)

#### 4.1 Motion Preview
```typescript
// src/components/sequence/motion-step.tsx
- Display frames with mock motion previews
- Use existing MotionPreview component
- Simulate motion generation (3-4 second delays)
- Mock job progress tracking
```

#### 4.2 Export and Upgrade Options
```typescript
// Add to motion-step.tsx
- Preview full sequence with mock video
- Mock export options (simulate downloads)
- Show upgrade to magic link prompt
- Simulate preserving user data during upgrade flow
```

### Phase 5: Testing & Polish (Day 5)

#### 5.1 Integration Testing
- Full flow walkthrough with mock data
- localStorage persistence verification
- Cross-session data recovery
- Mock error state coverage

#### 5.2 UI Polish
- Smooth loading state transitions
- Step navigation improvements
- Responsive design verification
- Mock data consistency

## Mock Data Strategy

### Consistent Mock Generation
```typescript
// Use seed-based generation for consistent results
const generateMockFrame = (seed: string, index: number) => {
  faker.seed(hashString(seed + index))
  return {
    id: faker.string.uuid(),
    name: `Frame ${index + 1}`,
    thumbnail: `https://picsum.photos/seed/${seed}${index}/400/300`,
    video: `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4`,
    scriptSection: script.slice(start, end),
    order: index,
    createdAt: new Date()
  }
}
```

### Mock Response Delays
```typescript
// Realistic delays for different operations
const MOCK_DELAYS = {
  scriptValidation: 500,    // Quick validation
  scriptEnhancement: 1500,  // AI processing time
  frameGeneration: 2500,    // Storyboard creation
  imageGeneration: 2000,    // Per frame image
  motionGeneration: 3500,   // Per frame video
  export: 4000             // Final export
}
```

### localStorage Persistence Schema
```typescript
interface LocalStorageData {
  anonymousUserId: string
  sequences: Record<string, MockSequence>
  currentSequenceId: string | null
  userPreferences: {
    preferredStyle: string
    seenUpgradePrompt: boolean
  }
  lastActive: Date
}
```

## Testing Approach

### Unit Tests
- Reducer action tests
- Mock data generator tests
- Validation logic tests

### Integration Tests
- Full flow completion
- State persistence
- Error recovery
- Session expiry

### E2E Tests (Future)
```typescript
// tests/anonymous-flow.spec.ts
- Complete creation flow
- Frame CRUD operations
- Auto-save verification
```

## Risk Assessment

### Low Risk Items
1. **localStorage Data Loss**: User might lose work if they clear browser data
   - **Mitigation**: Prompt users before data loss, show upgrade prompts to preserve work

2. **Cross-browser Consistency**: Different browsers handle localStorage differently
   - **Mitigation**: Test across major browsers, use consistent data serialization

3. **Mock Data Realism**: Generated data might not feel realistic enough
   - **Mitigation**: Use high-quality seed-based generation, realistic delays, varied content

### Very Low Risk Items
1. **Component Integration**: Existing components might need minor adjustments
   - **Mitigation**: Use components as-is first, minimal modifications only if needed

2. **State Management Complexity**: Multiple steps with local state
   - **Mitigation**: Use proven reducer patterns, thorough testing of state transitions

## Implementation Checklist

### Pre-Implementation
- [ ] Review existing components in Storybook
- [ ] Check existing mock data generators
- [ ] Understand current reducer patterns
- [ ] Verify localStorage capabilities

### Phase 1 (Days 1-2)
- [ ] Create `src/app/create` route with step navigation
- [ ] Implement anonymous flow reducer in `src/reducers/`
- [ ] Create mock actions in `src/app/actions/anonymous-flow/`
- [ ] Set up localStorage persistence hooks
- [ ] Test anonymous session simulation

### Phase 2 (Days 2-3)
- [ ] Build script step with existing ScriptEditor
- [ ] Integrate StyleSelector with mock data
- [ ] Add mock validation and enhancement
- [ ] Implement mock storyboard generation
- [ ] Test step 1 to step 2 transition

### Phase 3 (Days 3-4)
- [ ] Create storyboard step with existing components
- [ ] Implement frame list with drag-and-drop
- [ ] Add frame CRUD with localStorage sync
- [ ] Mock frame image regeneration
- [ ] Test full frame management flow

### Phase 4 (Days 4-5)
- [ ] Build motion step with existing MotionPreview
- [ ] Mock motion generation with delays
- [ ] Add export simulation
- [ ] Implement upgrade prompt mockup
- [ ] Test complete end-to-end flow

### Phase 5 (Day 5)
- [ ] Full integration testing
- [ ] Cross-browser localStorage testing
- [ ] UI/UX polish and transitions
- [ ] Mock data consistency verification
- [ ] Prepare for demo

## Success Criteria

1. **User can complete full flow** with simulated anonymous account
2. **All data persists** in localStorage across browser sessions
3. **All CRUD operations** work on frames with localStorage sync
4. **Data survives** browser refresh and reopening browser
5. **Mock upgrade flow** demonstrates magic link transition
6. **Responsive design** works on mobile/tablet
7. **Loading states** provide realistic feedback with proper delays
8. **Mock data feels realistic** and consistent across sessions
9. **Error simulation** shows proper error handling patterns
10. **Performance is smooth** with no blocking operations

## Future Enhancements (Out of Scope)

1. Real database backend implementation
2. Actual AI script analysis and enhancement
3. Real image and video generation via AI models
4. QStash job queue integration
5. Supabase anonymous user management
6. Magic link authentication system
7. Payment integration for premium features
8. Analytics and usage tracking

## Code Examples

### Reducer Actions
```typescript
type StoryboardFlowAction =
  | { type: 'SET_ANONYMOUS_USER'; payload: AnonymousUser }
  | { type: 'SET_SEQUENCE'; payload: Sequence }
  | { type: 'UPDATE_SCRIPT'; payload: string }
  | { type: 'SET_STYLE'; payload: StyleStack }
  | { type: 'SET_FRAMES'; payload: Frame[] }
  | { type: 'UPDATE_FRAME'; payload: { id: string; updates: Partial<Frame> } }
  | { type: 'ADD_FRAME'; payload: Frame }
  | { type: 'DELETE_FRAME'; payload: string }
  | { type: 'REORDER_FRAMES'; payload: string[] }
  | { type: 'NEXT_STEP' }
  | { type: 'PREVIOUS_STEP' }
  | { type: 'SET_GENERATION_JOB'; payload: { frameId: string; jobId: string; status: JobStatus } }
  | { type: 'SHOW_UPGRADE_PROMPT'; payload: boolean }
```

### Anonymous User Hook
```typescript
export function useAnonymousUser() {
  const [user, setUser] = useState<AnonymousUser | null>(null)
  
  useEffect(() => {
    const storedToken = localStorage.getItem('velro_anon_token')
    if (storedToken) {
      // Validate and refresh user from API
      validateAnonymousToken(storedToken).then(setUser)
    } else {
      // Create new anonymous user
      createAnonymousUser().then((newUser) => {
        localStorage.setItem('velro_anon_token', newUser.auth_token)
        setUser(newUser)
      })
    }
  }, [])
  
  const upgradeToMagicLink = async (email: string) => {
    if (!user) return
    return upgradeAnonymousUser(user.id, email)
  }
  
  return { user, upgradeToMagicLink }
}
```

### Database Auto-Save
```typescript
export function useDatabaseAutoSave(sequenceId: string, data: Partial<Sequence>) {
  const saveTimeoutRef = useRef<NodeJS.Timeout>()
  
  useEffect(() => {
    if (!sequenceId) return
    
    clearTimeout(saveTimeoutRef.current)
    saveTimeoutRef.current = setTimeout(() => {
      updateSequence(sequenceId, data)
    }, 2000) // Debounced saves
    
    return () => clearTimeout(saveTimeoutRef.current)
  }, [sequenceId, data])
}
```

## Notes for Implementation Team

1. **Use existing components** - Leverage all Storybook components as-is
2. **Follow CLAUDE.md guidelines** - Especially component size and state management
3. **Frontend-only focus** - No API routes, no database, pure localStorage
4. **Mock everything realistically** - Use proper delays and realistic data
5. **Keep it simple** - Don't over-engineer mocks, focus on UX flow
6. **Test localStorage thoroughly** - Handle edge cases like data corruption
7. **Make it feel real** - Users should believe it's working with real backend
8. **Document mock patterns** - For future real implementation reference

## Approval and Sign-off

This plan has been created based on:
- Issue #50 requirements
- Existing codebase analysis
- CLAUDE.md architectural guidelines
- Current component inventory

Ready for implementation once approved.