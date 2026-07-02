/**
 * Faceted inspector (#986) — the right pane of the unified Scenes editor.
 *
 * One inspector, scoped by selection:
 * - Scope breadcrumb (Sequence › Scene › Shot) — each crumb re-scopes.
 * - Look/Motion models: sequence scope edits the sequence default, scene
 *   scope edits the scene override (multi-scene shows Mixed + set-all,
 *   #909 locked overrides to scene scope), shot scope is read-only.
 * - Facets (Cast / Locations / Elements / Music / Script) re-use the scene
 *   tabs fed by `selectionTags()` — the same lens at every scope.
 */

import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { SceneCastTab } from '@/components/scenes/scene-cast-tab';
import { SceneElementsTab } from '@/components/scenes/scene-elements-tab';
import { SceneLocationTab } from '@/components/scenes/scene-location-tab';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Kbd } from '@/components/ui/kbd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useScenesBySequence, useUpdateSceneModel } from '@/hooks/use-scenes';
import {
  useSetSequenceMusic,
  useUpdateSequenceModels,
} from '@/hooks/use-sequences';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  resolveSceneImageModel,
  resolveSceneVideoModel,
} from '@/lib/ai/resolve-scene-models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { SceneRow } from '@/lib/db/schema';
import {
  scopeOf,
  selectScene,
  shotsInSelection,
  type SceneSelection,
  type SelectionTags,
} from '@/lib/scenes/selection';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { cn } from '@/lib/utils';
import { stripMarkdown } from '@/lib/utils/markdown-plain';
import type { Sequence } from '@/types/database';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Music } from 'lucide-react';
import { useMemo } from 'react';

export type FacetValue = 'cast' | 'locations' | 'elements' | 'music' | 'script';

type ScopeInspectorProps = {
  sequenceId: string;
  sequence?: Sequence;
  shots?: ShotWithImage[];
  selection: SceneSelection;
  onSelectionChange: (next: SceneSelection) => void;
  tags: SelectionTags | null;
  facet: FacetValue;
  onFacetChange: (facet: FacetValue) => void;
  aspectRatio: AspectRatio;
  styleCategory?: string;
  styleName?: string;
  recommendedImageModel?: string | null;
  recommendedVideoModel?: string | null;
};

function isFacetValue(value: string): value is FacetValue {
  return (
    value === 'cast' ||
    value === 'locations' ||
    value === 'elements' ||
    value === 'music' ||
    value === 'script'
  );
}

export const ScopeInspector: React.FC<ScopeInspectorProps> = ({
  sequenceId,
  sequence,
  shots,
  selection,
  onSelectionChange,
  tags,
  facet,
  onFacetChange,
  aspectRatio,
  styleCategory,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
}) => {
  const scope = scopeOf(selection);
  const { data: scenes } = useScenesBySequence(sequenceId);

  const covered = useMemo(
    () => (shots ? shotsInSelection(selection, shots) : []),
    [selection, shots]
  );

  const selectedShot = selection.shotId
    ? shots?.find((s) => s.id === selection.shotId)
    : undefined;

  const scenesById = useMemo(() => {
    const map = new Map<string, SceneRow>();
    for (const scene of scenes ?? []) map.set(scene.id, scene);
    return map;
  }, [scenes]);

  const selectedScenes = useMemo(() => {
    if (scope === 'shot') {
      const scene = selectedShot?.sceneId
        ? scenesById.get(selectedShot.sceneId)
        : undefined;
      return scene ? [scene] : [];
    }
    if (scope === 'scene') {
      return selection.sceneIds
        .map((id) => scenesById.get(id))
        .filter((scene): scene is SceneRow => scene !== undefined);
    }
    return [];
  }, [scope, selection.sceneIds, selectedShot, scenesById]);

  const shotScene = scope === 'shot' ? selectedScenes[0] : undefined;

  const scriptText = tags ? tags.scriptExtracts.join('\n\n') : '';

  return (
    <div className="flex h-full flex-col gap-4 rounded-lg border bg-background p-4">
      <ScopeBreadcrumb
        scope={scope}
        selection={selection}
        onSelectionChange={onSelectionChange}
        selectedScenes={selectedScenes}
        selectedShot={selectedShot}
        shotScene={shotScene}
      />

      <ModelSection
        scope={scope}
        sequenceId={sequenceId}
        sequence={sequence}
        selectedScenes={selectedScenes}
        shotScene={shotScene}
        aspectRatio={aspectRatio}
        styleCategory={styleCategory}
        styleName={styleName}
        recommendedImageModel={recommendedImageModel}
        recommendedVideoModel={recommendedVideoModel}
      />

      <Tabs
        value={facet}
        onValueChange={(value) => {
          if (isFacetValue(value)) onFacetChange(value);
        }}
        className="flex min-h-0 flex-1 flex-col"
      >
        <TabsList className="w-full">
          <TabsTrigger value="cast">Cast</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="elements">Elements</TabsTrigger>
          <TabsTrigger value="music" aria-label="Music">
            <Music className="h-3.5 w-3.5" />
          </TabsTrigger>
          <TabsTrigger value="script">Script</TabsTrigger>
        </TabsList>

        <div className="min-h-0 flex-1 overflow-y-auto pt-3">
          <TabsContent value="cast" className="mt-0">
            <FacetHeaderLink to="/sequences/$id/cast" sequenceId={sequenceId}>
              Manage cast
            </FacetHeaderLink>
            <SceneCastTab
              sequenceId={sequenceId}
              characterTags={tags ? tags.characterTags : null}
            />
          </TabsContent>

          <TabsContent value="locations" className="mt-0">
            <FacetHeaderLink
              to="/sequences/$id/locations"
              sequenceId={sequenceId}
            >
              Manage locations
            </FacetHeaderLink>
            <SceneLocationTab
              sequenceId={sequenceId}
              environmentTags={tags ? tags.environmentTags : null}
            />
          </TabsContent>

          <TabsContent value="elements" className="mt-0">
            <FacetHeaderLink
              to="/sequences/$id/elements"
              sequenceId={sequenceId}
            >
              Manage elements
            </FacetHeaderLink>
            <SceneElementsTab
              sequenceId={sequenceId}
              elementTags={tags ? tags.elementTags : null}
              scriptText={scriptText}
            />
          </TabsContent>

          <TabsContent value="music" className="mt-0">
            <MusicFacet
              sequence={sequence}
              scope={scope}
              covered={covered}
              sequenceId={sequenceId}
            />
          </TabsContent>

          <TabsContent value="script" className="mt-0">
            <ScriptFacet covered={covered} sequenceId={sequenceId} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Scope breadcrumb
// ---------------------------------------------------------------------------

type ScopeBreadcrumbProps = {
  scope: 'sequence' | 'scene' | 'shot';
  selection: SceneSelection;
  onSelectionChange: (next: SceneSelection) => void;
  selectedScenes: SceneRow[];
  selectedShot?: ShotWithImage;
  shotScene?: SceneRow;
};

const ScopeBreadcrumb: React.FC<ScopeBreadcrumbProps> = ({
  scope,
  onSelectionChange,
  selectedScenes,
  selectedShot,
  shotScene,
}) => {
  const sceneLabel =
    scope === 'scene'
      ? selectedScenes.length > 1
        ? `${selectedScenes.length} scenes`
        : (selectedScenes[0]?.title ?? 'Scene')
      : (shotScene?.title ?? 'Scene');
  const shotLabel =
    selectedShot?.metadata?.metadata?.title ??
    (selectedShot ? `Shot ${selectedShot.orderIndex + 1}` : '');

  return (
    <div className="flex items-center justify-between gap-2">
      <nav
        aria-label="Selection scope"
        className="flex min-w-0 items-center gap-1 text-sm"
      >
        <button
          type="button"
          onClick={() => onSelectionChange({ sceneIds: [] })}
          className={cn(
            'shrink-0 rounded px-1 py-0.5 hover:bg-muted',
            scope === 'sequence'
              ? 'font-medium text-foreground'
              : 'text-muted-foreground'
          )}
        >
          Sequence
        </button>
        {scope !== 'sequence' && (
          <>
            <span className="text-muted-foreground/50">›</span>
            {scope === 'shot' && shotScene ? (
              <button
                type="button"
                onClick={() => onSelectionChange(selectScene(shotScene.id))}
                className="min-w-0 truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-muted"
              >
                {sceneLabel}
              </button>
            ) : (
              <span className="min-w-0 truncate px-1 py-0.5 font-medium">
                {sceneLabel}
              </span>
            )}
          </>
        )}
        {scope === 'shot' && (
          <>
            <span className="text-muted-foreground/50">›</span>
            <span className="min-w-0 truncate px-1 py-0.5 font-medium">
              {shotLabel}
            </span>
          </>
        )}
      </nav>
      {scope !== 'sequence' && (
        <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
          <Kbd>esc</Kbd> up
        </span>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Scope-aware model section
// ---------------------------------------------------------------------------

type ModelSectionProps = {
  scope: 'sequence' | 'scene' | 'shot';
  sequenceId: string;
  sequence?: Sequence;
  selectedScenes: SceneRow[];
  shotScene?: SceneRow;
  aspectRatio: AspectRatio;
  styleCategory?: string;
  styleName?: string;
  recommendedImageModel?: string | null;
  recommendedVideoModel?: string | null;
};

const ModelSection: React.FC<ModelSectionProps> = ({
  scope,
  sequenceId,
  sequence,
  selectedScenes,
  shotScene,
  aspectRatio,
  styleCategory,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
}) => {
  const updateSceneModel = useUpdateSceneModel();
  const updateSequenceModels = useUpdateSequenceModels(sequenceId);

  const sequenceModels = {
    imageModel: sequence?.imageModel,
    videoModel: sequence?.videoModel,
  };
  const sequenceImageModel = safeTextToImageModel(
    sequence?.imageModel,
    DEFAULT_IMAGE_MODEL
  );
  const sequenceVideoModel = safeImageToVideoModel(
    sequence?.videoModel,
    DEFAULT_VIDEO_MODEL
  );

  const resolvedImage = selectedScenes.map((scene) =>
    resolveSceneImageModel(scene, sequenceModels)
  );
  const resolvedVideo = selectedScenes.map((scene) =>
    resolveSceneVideoModel(scene, sequenceModels)
  );
  const imageMixed = new Set(resolvedImage).size > 1;
  const videoMixed = new Set(resolvedVideo).size > 1;
  const hasOverrides = selectedScenes.some(
    (scene) => scene.imageModel !== null || scene.videoModel !== null
  );

  const setSceneModels = (
    input:
      | { imageModel?: TextToImageModel | null }
      | {
          videoModel?: ImageToVideoModel | null;
        }
  ) => {
    for (const scene of selectedScenes) {
      updateSceneModel.mutate({ sequenceId, sceneId: scene.id, ...input });
    }
  };

  if (scope === 'shot') {
    const look = resolveSceneImageModel(shotScene, sequenceModels);
    const motion = resolveSceneVideoModel(shotScene, sequenceModels);
    return (
      <div className="flex flex-col gap-1 rounded-md border bg-muted/30 px-3 py-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Look</span>
          <span className="font-medium">
            {isValidTextToImageModel(look) ? IMAGE_MODELS[look].name : look}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Motion</span>
          <span className="font-medium">
            {isValidImageToVideoModel(motion)
              ? IMAGE_TO_VIDEO_MODELS[motion].name
              : motion}
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Models are set on the scene — select it to change them.
        </p>
      </div>
    );
  }

  const isSceneScope = scope === 'scene' && selectedScenes.length > 0;
  const imageValue = isSceneScope
    ? (resolvedImage[0] ?? sequenceImageModel)
    : sequenceImageModel;
  const videoValue = isSceneScope
    ? (resolvedVideo[0] ?? sequenceVideoModel)
    : sequenceVideoModel;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {isSceneScope
            ? selectedScenes.length > 1
              ? `Models · ${selectedScenes.length} scenes`
              : 'Scene models'
            : 'Sequence defaults'}
        </span>
        {isSceneScope && hasOverrides && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={() => {
              setSceneModels({ imageModel: null });
              setSceneModels({ videoModel: null });
            }}
          >
            Reset to default
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          Look
          {isSceneScope && imageMixed && (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              Mixed
            </Badge>
          )}
        </span>
        <ImageModelSelector
          selectedModel={imageValue}
          onModelChange={(model) => {
            if (isSceneScope) setSceneModels({ imageModel: model });
            else updateSequenceModels.mutate({ imageModel: model });
          }}
          recommendedImageModel={recommendedImageModel}
          styleName={styleName}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          Motion
          {isSceneScope && videoMixed && (
            <Badge variant="outline" className="h-4 px-1 text-[10px]">
              Mixed
            </Badge>
          )}
        </span>
        <MotionModelSelector
          selectedModel={videoValue}
          onModelChange={(model) => {
            if (isSceneScope) setSceneModels({ videoModel: model });
            else updateSequenceModels.mutate({ videoModel: model });
          }}
          aspectRatio={aspectRatio}
          styleCategory={styleCategory}
          styleName={styleName}
          recommendedVideoModel={recommendedVideoModel}
        />
      </div>
      {!isSceneScope && (
        <p className="text-[11px] text-muted-foreground">
          Scenes without their own choice inherit these.
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Music facet
// ---------------------------------------------------------------------------

type MusicFacetProps = {
  sequence?: Sequence;
  scope: 'sequence' | 'scene' | 'shot';
  covered: ShotWithImage[];
  sequenceId: string;
};

const MusicFacet: React.FC<MusicFacetProps> = ({
  sequence,
  scope,
  covered,
  sequenceId,
}) => {
  const setMusicEnabled = useSetSequenceMusic(sequenceId);

  if (scope !== 'sequence') {
    // Scene/shot scope: music is a sequence-level asset; show the covered
    // shots' music design read-only.
    const designs = covered
      .map((shot) => shot.metadata?.musicDesign)
      .filter((design) => design !== undefined);
    return (
      <div className="flex flex-col gap-3">
        {designs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No music design for this selection.
          </p>
        ) : (
          designs.map((design, i) => (
            <div
              key={i}
              className="rounded-md border bg-muted/30 px-3 py-2 text-xs"
            >
              <span className="font-medium">{design.style}</span>
              <span className="text-muted-foreground">
                {' '}
                · {design.mood} · {design.presence}
              </span>
            </div>
          ))
        )}
        <p className="text-[11px] text-muted-foreground">
          The music track belongs to the whole sequence — press <Kbd>esc</Kbd>{' '}
          to edit it.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <FacetHeaderLink to="/sequences/$id/music" sequenceId={sequenceId}>
        Open music editor
      </FacetHeaderLink>
      {sequence?.musicUrl ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- music track, no dialogue
        <audio controls src={sequence.musicUrl} className="w-full" />
      ) : (
        <p className="text-sm text-muted-foreground">
          {sequence?.musicStatus === 'generating'
            ? 'Composing music…'
            : 'No music yet.'}
        </p>
      )}
      {sequence?.musicPrompt && (
        <p className="line-clamp-4 text-xs leading-relaxed text-muted-foreground">
          {sequence.musicPrompt}
        </p>
      )}
      {sequence && (
        <label
          htmlFor="inspector-include-music"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Checkbox
            id="inspector-include-music"
            checked={sequence.includeMusic}
            onCheckedChange={(checked) =>
              setMusicEnabled.mutate(checked === true)
            }
          />
          <span>Play music with the sequence</span>
        </label>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Script facet
// ---------------------------------------------------------------------------

type ScriptFacetProps = {
  covered: ShotWithImage[];
  sequenceId: string;
};

const ScriptFacet: React.FC<ScriptFacetProps> = ({ covered, sequenceId }) => {
  return (
    <div className="flex flex-col gap-3">
      <FacetHeaderLink to="/sequences/$id/script" sequenceId={sequenceId}>
        Edit script
      </FacetHeaderLink>
      {covered.length === 0 && (
        <p className="text-sm text-muted-foreground">No script yet.</p>
      )}
      {covered.map((shot) => {
        const title =
          shot.metadata?.metadata?.title ?? `Scene ${shot.orderIndex + 1}`;
        const extract = shot.metadata?.originalScript.extract;
        if (!extract) return null;
        return (
          <div key={shot.id} className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {title}
            </span>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              {stripMarkdown(extract)}
            </p>
          </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shared facet header link
// ---------------------------------------------------------------------------

const FacetHeaderLink: React.FC<{
  to:
    | '/sequences/$id/cast'
    | '/sequences/$id/locations'
    | '/sequences/$id/elements'
    | '/sequences/$id/music'
    | '/sequences/$id/script';
  sequenceId: string;
  children: React.ReactNode;
}> = ({ to, sequenceId, children }) => (
  <div className="mb-3 flex justify-end">
    <Link
      to={to}
      params={{ id: sequenceId }}
      className="flex items-center gap-1 text-xs text-primary hover:underline"
    >
      {children}
      <ExternalLink className="h-3 w-3" />
    </Link>
  </div>
);
