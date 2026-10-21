import { z } from 'zod';
import type { SceneWithScript } from './use-scenes';
import { useUpdateScene } from './use-scene-structure';
import { Input } from '@/ui/shadcn/input';
import { Button } from '@/ui/shadcn/button';
import { toast } from 'sonner';
import { errorMessage } from '@/platform/errors';

const settingSchema = z.object({
  timeOfDay: z.string().max(2000),
  lightingSetup: z.string().max(2000),
  colorPalette: z.string().max(2000),
});

/**
 * Scene-owned prompt inputs, on the scene's Script tab (#1929). The scene's
 * location is picked on its Locations tab, not typed here.
 */
export function SceneSettingForm({
  scene,
  sequenceId,
}: {
  scene: SceneWithScript;
  sequenceId: string;
}) {
  const update = useUpdateScene(sequenceId);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const parsed = settingSchema.safeParse(Object.fromEntries(fields));
        if (!parsed.success) {
          toast.error('Could not save scene setting', {
            description: parsed.error.issues[0]?.message,
          });
          return;
        }
        const values = parsed.data;
        update.mutate(
          {
            sceneId: scene.id,
            timeOfDay: values.timeOfDay,
            continuity: {
              lightingSetup: values.lightingSetup,
              colorPalette: values.colorPalette,
            },
          },
          {
            onSuccess: () => toast.success('Scene setting saved'),
            onError: (error) =>
              toast.error('Could not save scene setting', {
                description: errorMessage(error),
              }),
          }
        );
      }}
    >
      <label className="text-xs" htmlFor={`${scene.id}-timeOfDay`}>
        Time of day
        <Input
          id={`${scene.id}-timeOfDay`}
          name="timeOfDay"
          defaultValue={scene.timeOfDay ?? ''}
          maxLength={2000}
          placeholder="Day, night, dawn…"
        />
      </label>
      <label className="text-xs" htmlFor={`${scene.id}-lightingSetup`}>
        Lighting
        <Input
          id={`${scene.id}-lightingSetup`}
          name="lightingSetup"
          defaultValue={scene.continuity?.lightingSetup ?? ''}
          maxLength={2000}
          placeholder="Defaults from time of day"
        />
      </label>
      <label className="text-xs" htmlFor={`${scene.id}-colorPalette`}>
        Palette override
        <Input
          id={`${scene.id}-colorPalette`}
          name="colorPalette"
          defaultValue={scene.continuity?.colorPalette ?? ''}
          maxLength={2000}
          placeholder="Use sequence style"
        />
      </label>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Art style, grading and the default palette are set in the sequence
        style. Use a palette override for a flashback or dream.
      </p>
      <Button type="submit" size="sm" disabled={update.isPending}>
        {update.isPending ? 'Saving…' : 'Save setting'}
      </Button>
    </form>
  );
}
