import { z } from 'zod';
import type { SceneWithScript } from './use-scenes';
import { useUpdateScene } from './use-scene-structure';
import { Input } from '@/ui/shadcn/input';
import { Button } from '@/ui/shadcn/button';
import { toast } from 'sonner';
import { errorMessage } from '@/platform/errors';

const settingSchema = z.object({
  location: z.string().max(2000),
  timeOfDay: z.string().max(2000),
  lightingSetup: z.string().max(2000),
  colorPalette: z.string().max(2000),
});

/** Scene-owned prompt inputs, beside the shot list they direct. */
export function SceneSettingForm({
  scene,
  sequenceId,
}: {
  scene: SceneWithScript;
  sequenceId: string;
}) {
  const update = useUpdateScene(sequenceId);
  return (
    <details className="border-t px-3 py-2">
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Scene setting
      </summary>
      <form
        className="grid gap-3 pt-2 sm:grid-cols-2"
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
              location: values.location,
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
        <label className="text-xs" htmlFor={`${scene.id}-location`}>
          Location
          <Input
            id={`${scene.id}-location`}
            name="location"
            defaultValue={scene.location ?? ''}
            maxLength={2000}
          />
        </label>
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
    </details>
  );
}
