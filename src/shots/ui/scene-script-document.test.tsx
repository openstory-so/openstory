import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import {
  buildScriptBlocks,
  SceneScriptDocument,
  type ScriptBlockScene,
} from './scene-script-document';

// Mock useEditorDictation hook
vi.mock('@/ui/use-dictation', () => ({
  useEditorDictation: () => ({
    ref: { current: null },
    voice: {
      isListening: false,
      startListening: vi.fn(),
      stopListening: vi.fn(),
    },
  }),
}));

// Mock useSaveSceneScript
vi.mock('./use-scenes', () => ({
  useSaveSceneScript: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// Mock useSequenceMentionItems
vi.mock('./use-mention-items', () => ({
  useSequenceMentionItems: () => ({
    items: [],
    elements: [],
    onMentionRename: vi.fn(),
  }),
}));

describe('buildScriptBlocks', () => {
  it('correctly populates hasScript true when script is present', () => {
    const scenes: ScriptBlockScene[] = [
      {
        id: 'scene-1',
        orderIndex: 0,
        title: 'Scene 1',
        script: { extract: 'Script for scene 1', dialogue: [] },
      },
    ];

    const blocks = buildScriptBlocks(scenes);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.hasScript).toBe(true);
    expect(blocks[0]?.extract).toBe('Script for scene 1');
  });

  it('correctly populates hasScript false when script is null/undefined', () => {
    const scenes: ScriptBlockScene[] = [
      {
        id: 'scene-2',
        orderIndex: 0,
        title: 'Scriptless Scene',
        script: null,
      },
    ];

    const blocks = buildScriptBlocks(scenes);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.hasScript).toBe(false);
    expect(blocks[0]?.extract).toBe('');
  });
});

describe('SceneScriptDocument', () => {
  it('renders disabled editor for scriptless scene blocks', () => {
    const scenes = [
      {
        id: 'scene-1',
        orderIndex: 0,
        title: 'Has Script',
        script: { extract: 'Line 1', dialogue: [] },
      },
      {
        id: 'scene-2',
        orderIndex: 1,
        title: 'No Script',
        script: null,
      },
    ] as any;

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SceneScriptDocument
          sequenceId="seq-1"
          scenes={scenes}
          selectedSceneIds={[]}
          onSelectScene={() => {}}
        />
      </TooltipProvider>
    );

    expect(html).toContain('Has Script');
    expect(html).toContain('No Script');
    expect(html).toContain('This scene has no script');
  });
});
