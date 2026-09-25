import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@/ui/use-dictation', () => ({
  useEditorDictation: () => ({ ref: null, voice: {} }),
}));
vi.mock('@/ui/text-editor/markdown-editor', () => ({
  MarkdownEditor: () => <textarea aria-label="Scene script" />,
}));
vi.mock('@/ui/voice/voice-input-button', () => ({
  VoiceInputButton: () => <button>Dictate script</button>,
}));

const { SceneScriptTab } = await import('./scene-script-tab');

function render(scriptText: string | undefined, sceneId = 'scene-1') {
  return renderToStaticMarkup(
    <SceneScriptTab
      sceneId={sceneId}
      scriptText={scriptText}
      editedScript="Unsaved draft"
      onEditedScriptChange={vi.fn()}
      isSaving={false}
      onSave={vi.fn()}
      isCopied={false}
      onCopy={vi.fn()}
      dialogue={<p>Shot dialogue</p>}
    />
  );
}

describe('SceneScriptTab', () => {
  it('shows the missing-script state without edit controls, even with a draft', () => {
    const html = render(undefined);
    expect(html).toContain('This scene has no script yet.');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('<button');
    expect(html).toContain('Shot dialogue');
  });

  it.each(['', 'Existing script'])(
    'allows editing an existing script (%j)',
    (extract) => {
      const html = render(extract);
      expect(html).toContain('<textarea');
      expect(html).toContain('Save</button>');
      expect(html).not.toContain('This scene has no script yet.');
    }
  );

  it('keeps the single-scene selection prompt', () => {
    expect(render(undefined, '')).toContain('Select a single scene');
  });
});
