import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useScenesBySequence } from '@/hooks/use-scenes';
import { useAddModelToSequence, useSequence } from '@/hooks/use-sequences';
import { useShotsBySequence } from '@/hooks/use-shots';
import { useSequenceStyle } from '@/hooks/use-styles';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isModelCompatibleWithAspectRatio,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
} from '@/lib/ai/models';
import {
  compareSelectorModels,
  QUALITY_DEFAULT_AUDIO,
  QUALITY_DEFAULT_IMAGE,
  QUALITY_DEFAULT_VIDEO,
  SELECTOR_GROUP_ORDER,
  selectorGroup,
  TURBO_AUDIO_MODELS,
  TURBO_IMAGE_MODELS,
  TURBO_VIDEO_MODELS,
  type SelectorGroup,
} from '@/lib/ai/generation-mode';
import type { VariantType } from '@/lib/db/schema/shot-variants';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import { useViaAvailability } from '@/hooks/use-via-availability';
import { rendersReferenceOnly } from '@/lib/shots/use-start-frame';
import { useMemo } from 'react';
import { toast } from 'sonner';

type Candidate = {
  key: string;
  name: string;
  scope: string;
  group: SelectorGroup;
};

const scenes = (n: number) => `${n} scene${n === 1 ? '' : 's'}`;

/**
 * "Add a model" section for the header model dropdowns (#547). Lists models of
 * the given type that have NOT yet generated for this sequence with the scope
 * they would generate over; clicking confirms via a toast then triggers
 * addModelToSequenceFn (which generates the new model for every shot / the
 * whole sequence using the existing prompts). The server runs the authoritative
 * credit pre-flight.
 *
 * Deliberately shows no cost estimate. It was the only price in the editor, so
 * it read as a price list against a quality-ranked order and pushed users at the
 * cheapest model with nothing arguing for the good one — and for compute-second
 * models the number was wrong by up to ~100× (#1069). Cost comes back as an
 * opt-in display once the estimates self-correct from observed `unitsBilled`.
 */
export const AddModelMenuSection = ({
  sequenceId,
  variantType,
  usedModels,
}: {
  sequenceId: string;
  variantType: VariantType;
  usedModels: string[];
}) => {
  const addModel = useAddModelToSequence();
  const { data: shots } = useShotsBySequence(sequenceId);
  const { data: sceneRows } = useScenesBySequence(sequenceId);
  const { data: sequence } = useSequence(sequenceId);
  const { data: style } = useSequenceStyle(sequenceId);
  const aspectRatio = sequence?.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  // Only the DEFAULT — `rendersReferenceOnly` resolves each shot's override
  // against it below.
  const generateStartFrames = sequence?.generateStartFrames ?? false;
  const { referenceOnlyModels } = useViaAvailability();
  // Style-category gating (mirrors motion-model-selector): a model declaring a
  // `requiredStyleCategory` (none currently declare one) is only offered when
  // the sequence's style matches — otherwise it isn't a valid choice here.
  const styleCategory = style?.category ?? undefined;

  const candidates = useMemo<Candidate[]>(() => {
    const used = new Set(usedModels);
    const shotList = shots ?? [];
    const extractBySceneId = new Map<string, string>(
      (sceneRows ?? []).map((scene) => [scene.id, scene.script?.extract ?? ''])
    );

    if (variantType === 'image') {
      const count = shotList.filter(
        (f) =>
          f.imagePromptVersion?.text ||
          (f.sceneId ? extractBySceneId.get(f.sceneId) : undefined)
      ).length;
      return Object.keys(IMAGE_MODELS)
        .filter(isValidTextToImageModel)
        .filter((key) => !used.has(key) && !('hidden' in IMAGE_MODELS[key]))
        .sort((a, b) =>
          compareSelectorModels(
            a,
            b,
            TURBO_IMAGE_MODELS,
            QUALITY_DEFAULT_IMAGE,
            (id) =>
              isValidTextToImageModel(id) ? IMAGE_MODELS[id].qualityRank : 99
          )
        )
        .map((key) => ({
          key,
          name: IMAGE_MODELS[key].name,
          scope: count ? scenes(count) : 'all scenes',
          group: selectorGroup(key, TURBO_IMAGE_MODELS),
        }));
    }

    if (variantType === 'video') {
      // What the server will accept (`selectEligibleVideoShots`): a shot needs
      // a still UNLESS it renders reference-only, which is a per-shot answer.
      const eligible = shotList.filter(
        (f) =>
          rendersReferenceOnly(f, { generateStartFrames }) ||
          (f.frame.imageStatus === 'completed' && f.image?.url)
      );
      const count = eligible.length;
      // The add generates for EVERY eligible shot, so a single reference-only
      // one among them decides the list: a model with no reference-to-video
      // route cannot serve that shot, and the server refuses the whole add
      // rather than quietly skipping it.
      const anyReferenceOnly = eligible.some((f) =>
        rendersReferenceOnly(f, { generateStartFrames })
      );
      return Object.keys(IMAGE_TO_VIDEO_MODELS)
        .filter(isValidImageToVideoModel)
        .filter((key) => {
          const model = IMAGE_TO_VIDEO_MODELS[key];
          if (used.has(key) || 'hidden' in model) return false;
          if (anyReferenceOnly && !referenceOnlyModels.includes(key)) {
            return false;
          }
          // Exclude models gated to a different style category (e.g. Seedance 2
          // is animation-only) — same rule as the motion-model selector.
          if (
            'requiredStyleCategory' in model &&
            model.requiredStyleCategory !== styleCategory
          )
            return false;
          return isModelCompatibleWithAspectRatio(key, aspectRatio);
        })
        .sort((a, b) =>
          compareSelectorModels(
            a,
            b,
            TURBO_VIDEO_MODELS,
            QUALITY_DEFAULT_VIDEO,
            (id) =>
              isValidImageToVideoModel(id)
                ? IMAGE_TO_VIDEO_MODELS[id].qualityRank
                : 99
          )
        )
        .map((key) => ({
          key,
          name: IMAGE_TO_VIDEO_MODELS[key].name,
          // Matches the image branch: before any still is rendered the scope is
          // every scene, not the literal zero that have one today.
          scope: count ? scenes(count) : 'all scenes',
          group: selectorGroup(key, TURBO_VIDEO_MODELS),
        }));
    }

    // audio — one track for the whole sequence.
    return Object.keys(AUDIO_MODELS)
      .filter(isValidAudioModel)
      .filter(
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        (key) => !used.has(key) && AUDIO_MODELS[key].type === 'music'
      )
      .sort((a, b) =>
        compareSelectorModels(
          a,
          b,
          TURBO_AUDIO_MODELS,
          QUALITY_DEFAULT_AUDIO,
          (id) => (isValidAudioModel(id) ? AUDIO_MODELS[id].qualityRank : 99)
        )
      )
      .map((key) => ({
        key,
        name: AUDIO_MODELS[key].name,
        scope: '1 track',
        group: selectorGroup(key, TURBO_AUDIO_MODELS),
      }));
  }, [
    variantType,
    usedModels,
    shots,
    sceneRows,
    aspectRatio,
    styleCategory,
    generateStartFrames,
    referenceOnlyModels,
  ]);

  if (candidates.length === 0) return null;

  // Audio requires a generated music prompt; gate the section in that case.
  const audioBlocked =
    variantType === 'audio' && !(sequence?.musicPrompt && sequence.musicTags);

  const handleAdd = ({ key, name, scope }: Candidate) => {
    toast(`Add ${name}?`, {
      description: audioBlocked
        ? 'Generate music once before adding another audio model.'
        : `Generates ${scope} using the existing prompts.`,
      action: audioBlocked
        ? undefined
        : {
            label: 'Add',
            onClick: () => {
              addModel.mutate(
                { sequenceId, variantType, model: key },
                {
                  onSuccess: (r) =>
                    toast.success(
                      r.failed > 0
                        ? `Generating ${name} (${r.count}) — ${r.failed} failed to start`
                        : `Generating ${name} (${r.count})…`
                    ),
                  onError: (e) => toast.error(e.message),
                }
              );
            },
          },
    });
  };

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider font-normal">
        Add a model
      </DropdownMenuLabel>
      {SELECTOR_GROUP_ORDER.map((group, groupIndex) => {
        const groupCandidates = candidates.filter((c) => c.group === group);
        if (groupCandidates.length === 0) return null;
        return (
          <div key={group}>
            {groupIndex > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider font-normal">
              {group === 'fast' ? 'Fast' : 'Quality'}
            </DropdownMenuLabel>
            {groupCandidates.map((c) => (
              <DropdownMenuItem
                key={c.key}
                disabled={addModel.isPending}
                onSelect={(e) => {
                  e.preventDefault();
                  handleAdd(c);
                }}
                className="cursor-pointer flex flex-col items-start gap-0.5"
              >
                <span className="w-full truncate">{c.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {c.scope}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        );
      })}
    </>
  );
};
