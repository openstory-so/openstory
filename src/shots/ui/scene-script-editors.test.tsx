import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { dbSceneId } from '@/shots/scene-id';
import { NO_SCENE_SCRIPT_MESSAGE } from '@/shots/scene-script-message';
import { SceneScriptDocument } from './scene-script-document';
import { SceneScriptTab } from './scene-script-tab';
import type { SceneWithScript } from './use-scenes';

vi.mock('@/ui/use-dictation', () => ({
  useEditorDictation: () => ({ ref: null, voice: {} }),
}));
vi.mock('@/ui/text-editor/markdown-editor', () => ({
  MarkdownEditor: () => <textarea aria-label="Scene script" />,
}));
vi.mock('@/ui/voice/voice-input-button', () => ({
  VoiceInputButton: () => <button type="button">Dictate script</button>,
}));
vi.mock('./use-mention-items', () => ({
  useSequenceMentionItems: () => ({ items: [], onMentionRename: undefined }),
}));
vi.mock('./use-scenes', () => ({
  useSaveSceneScript: () => ({ mutate: vi.fn(), isPending: false }),
}));

function scene(script: SceneWithScript['script']): SceneWithScript {
  return {
    id: dbSceneId('scene-1'),
    orderIndex: 0,
    title: 'Garage',
    script,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the document only reads id, order, title, and script
  } as SceneWithScript;
}

describe('script editing when a scene has no script', () => {
  it('hides the inspector editor', () => {
    const html = renderToStaticMarkup(
      <SceneScriptTab
        sceneId="scene-1"
        scriptText={undefined}
        editedScript={undefined}
        onEditedScriptChange={vi.fn()}
        isSaving={false}
        onSave={vi.fn()}
        isCopied={false}
        onCopy={vi.fn()}
        setting={<p>Lighting</p>}
        dialogue={<p>Lines</p>}
      />
    );

    expect(html).toContain(NO_SCENE_SCRIPT_MESSAGE);
    expect(html).toContain('Lighting');
    expect(html).toContain('Lines');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Save</button>');
    expect(html).not.toContain('Dictate script');
  });

  it('still edits a saved empty script', () => {
    const html = renderToStaticMarkup(
      <SceneScriptTab
        sceneId="scene-1"
        scriptText=""
        editedScript={undefined}
        onEditedScriptChange={vi.fn()}
        isSaving={false}
        onSave={vi.fn()}
        isCopied={false}
        onCopy={vi.fn()}
      />
    );

    expect(html).toContain('<textarea');
    expect(html).not.toContain(NO_SCENE_SCRIPT_MESSAGE);
  });

  it('hides the script-document editor', () => {
    const html = renderToStaticMarkup(
      <SceneScriptDocument
        sequenceId="sequence-1"
        scenes={[scene(null)]}
        selectedSceneIds={[]}
        onSelectScene={vi.fn()}
      />
    );

    expect(html).toContain(NO_SCENE_SCRIPT_MESSAGE);
    expect(html).toContain('Garage');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('Save</button>');
    expect(html).not.toContain('Dictate script');
  });
});
