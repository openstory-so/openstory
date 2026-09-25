import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/ui/shadcn/tooltip';
import { SceneScriptTab } from './scene-script-tab';

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

describe('SceneScriptTab', () => {
  it('renders the editor when a script exists', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SceneScriptTab
          sceneId="scene-1"
          scriptText="INT. COFFEE SHOP - DAY"
          editedScript={undefined}
          onEditedScriptChange={() => {}}
          isSaving={false}
          onSave={() => {}}
          isCopied={false}
          onCopy={() => {}}
        />
      </TooltipProvider>
    );

    expect(html).toContain('Scene script');
    expect(html).toContain('INT. COFFEE SHOP - DAY');
    expect(html).not.toContain('This scene has no script to edit.');
  });

  it('hides the editor and displays empty message when scene has no script', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SceneScriptTab
          sceneId="scene-1"
          scriptText={undefined}
          editedScript={undefined}
          onEditedScriptChange={() => {}}
          isSaving={false}
          onSave={() => {}}
          isCopied={false}
          onCopy={() => {}}
        />
      </TooltipProvider>
    );

    expect(html).toContain('This scene has no script to edit.');
    expect(html).not.toContain('Scene script');
    expect(html).not.toContain('id="script-extract-input"');
  });

  it('renders the multi-scene selection message when sceneId is undefined', () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SceneScriptTab
          sceneId={undefined}
          scriptText="Some text"
          editedScript={undefined}
          onEditedScriptChange={() => {}}
          isSaving={false}
          onSave={() => {}}
          isCopied={false}
          onCopy={() => {}}
        />
      </TooltipProvider>
    );

    expect(html).toContain(
      'Select a single scene to edit its script, or use the Script view to edit them all in one document.'
    );
    expect(html).not.toContain('Scene script');
    expect(html).not.toContain('This scene has no script to edit.');
  });
});
