/**
 * The `+` panel for the studio composer (#1274): a left nav of sources
 * (Generations / Sequences / Cast / Locations / Audio), a tile grid on the
 * right with multi-select ticks, and Upload in the corner. Sequences drill
 * in: pick a sequence, then any of its shots (stills and clips), elements,
 * cast, or locations. Picking hands back stored URLs + labels + kind; the
 * composer decides whether they become `@ImageN` / `@VideoN` / `@AudioN`,
 * the start frame, or the end frame.
 */

import { AppImage } from '@/components/ui/app-image';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceCharacters } from '@/hooks/use-sequence-characters';
import { useSequenceElements } from '@/hooks/use-sequence-elements';
import {
  useLibraryLocations,
  useSequenceLocations,
} from '@/hooks/use-sequence-locations';
import {
  useSequencesWithShots,
  type SequenceWithShots,
} from '@/hooks/use-sequences-with-shots';
import { useStudioAssets } from '@/hooks/use-studio-assets';
import { useTalent } from '@/hooks/use-talent';
import { isBrowserDisplayableStillUrl } from '@/lib/shots/shot-view';
import {
  studioPosterOutput,
  studioPrimaryOutput,
  studioPrompt,
} from '@/lib/studio/outputs';
import { cn } from '@/lib/utils';
import {
  ArrowLeft,
  AudioLines,
  Check,
  Clapperboard,
  Film,
  MapPin,
  Sparkles,
  Upload,
  Users,
} from 'lucide-react';
import type { StudioReferenceKind } from '@/lib/studio/schema';
import { useMemo, useRef, useState } from 'react';

export type StudioReference = {
  /** Stored (origin-relative `/r2/…`) or absolute URL. */
  url: string;
  /** Shown on the tile and in the @ dropdown. */
  label: string;
  kind: StudioReferenceKind;
  /** Still to show for a video tile. */
  posterUrl?: string;
};

type StudioSequenceSummary = Pick<SequenceWithShots, 'id' | 'title'> & {
  posterUrl?: string;
  shotCount: number;
};

export type StudioLibrary = {
  generations: StudioReference[];
  sequences: StudioSequenceSummary[];
  cast: StudioReference[];
  locations: StudioReference[];
};

type StudioReferenceSlots = Record<StudioReferenceKind, number>;

type Source = 'generations' | 'sequences' | 'cast' | 'locations' | 'audio';

const SOURCES: { key: Source; label: string; icon: typeof Sparkles }[] = [
  { key: 'generations', label: 'Generations', icon: Sparkles },
  { key: 'sequences', label: 'Sequences', icon: Clapperboard },
  { key: 'cast', label: 'Talent', icon: Users },
  { key: 'locations', label: 'Locations', icon: MapPin },
  { key: 'audio', label: 'Audio', icon: AudioLines },
];

const EMPTY: Record<Exclude<Source, 'audio'>, string> = {
  generations:
    'No generations yet — make an image or clip and it shows up here.',
  sequences: 'No sequences yet.',
  cast: 'No talent with a headshot yet.',
  locations: 'No locations with a reference image yet.',
};

function shotReferences(sequence: SequenceWithShots): StudioReference[] {
  return sequence.shots.flatMap((shot, index) => {
    const label = `${sequence.title} · shot ${index + 1}`;
    const still = shot.image?.url;
    const stillOk = still && isBrowserDisplayableStillUrl(still);
    const refs: StudioReference[] = [];
    if (stillOk) refs.push({ url: still, label, kind: 'image' });
    const clip = shot.video?.url;
    if (clip && shot.videoStatus === 'completed') {
      refs.push({
        url: clip,
        label: `${label} (clip)`,
        kind: 'video',
        posterUrl: stillOk ? still : undefined,
      });
    }
    return refs;
  });
}

/** The team's pickable media, as flat `{ url, label, kind }` rows per source. */
export function useStudioLibrary(): StudioLibrary {
  const { data: talent } = useTalent();
  const { data: locations } = useLibraryLocations();
  const { data: sequences } = useSequencesWithShots();
  const images = useStudioAssets({ activity: 'image' });
  const videos = useStudioAssets({ activity: 'video' });

  return useMemo((): StudioLibrary => {
    const generations = [
      ...(images.data?.pages ?? []).flatMap((page) => page.assets),
      ...(videos.data?.pages ?? []).flatMap((page) => page.assets),
    ]
      .filter((asset) => asset.status === 'completed')
      .flatMap((asset): StudioReference[] => {
        const url = studioPrimaryOutput(asset)?.url;
        if (!url) return [];
        const label = studioPrompt(asset).slice(0, 60) || 'Generation';
        return asset.activity === 'video'
          ? [
              {
                url,
                label,
                kind: 'video',
                posterUrl: studioPosterOutput(asset)?.url,
              },
            ]
          : [{ url, label, kind: 'image' }];
      });

    return {
      generations,
      sequences: sequences.map((sequence) => {
        const shots = shotReferences(sequence);
        return {
          id: sequence.id,
          title: sequence.title,
          posterUrl: shots.find((r) => r.kind === 'image')?.url,
          shotCount: sequence.shots.length,
        };
      }),
      cast: (talent ?? []).flatMap((t) => {
        const url = t.imageUrl ?? t.defaultSheet?.imageUrl;
        return url ? [{ url, label: t.name, kind: 'image' as const }] : [];
      }),
      locations: (locations ?? []).flatMap((loc) =>
        loc.referenceImageUrl
          ? [
              {
                url: loc.referenceImageUrl,
                label: loc.name,
                kind: 'image' as const,
              },
            ]
          : []
      ),
    };
  }, [talent, locations, sequences, images.data, videos.data]);
}

type TileGridProps = {
  items: StudioReference[];
  attached: string[];
  pending: StudioReference[];
  slots: StudioReferenceSlots;
  multiple: boolean;
  onToggle: (item: StudioReference) => void;
};

function TileGrid({
  items,
  attached,
  pending,
  slots,
  multiple,
  onToggle,
}: TileGridProps) {
  return (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
      {items.map((item) => {
        const isAttached = attached.includes(item.url);
        const isPending = pending.some((p) => p.url === item.url);
        const ticked = isAttached || isPending;
        const kindFull =
          !isPending &&
          pending.filter((p) => p.kind === item.kind).length >=
            slots[item.kind];
        const disabled =
          isAttached || (multiple ? kindFull : slots[item.kind] === 0);
        return (
          <li key={item.url}>
            <button
              type="button"
              onClick={() => onToggle(item)}
              disabled={disabled}
              aria-pressed={multiple ? ticked : undefined}
              aria-label={item.label}
              title={item.label}
              className={cn(
                'relative block aspect-square w-full overflow-hidden rounded-md border bg-muted transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-default',
                ticked && 'border-primary',
                disabled && !ticked && 'opacity-40',
                isAttached && 'opacity-70'
              )}
            >
              {item.kind === 'video' ? (
                <video
                  src={item.url}
                  poster={item.posterUrl}
                  muted
                  playsInline
                  preload="metadata"
                  className="h-full w-full object-cover"
                >
                  <track kind="captions" />
                </video>
              ) : (
                <AppImage
                  src={item.url}
                  alt=""
                  width={160}
                  height={160}
                  className="h-full w-full object-cover"
                />
              )}
              {item.kind === 'video' && (
                <span className="absolute bottom-1 left-1 flex items-center gap-1 rounded bg-background/85 px-1 font-mono text-[10px] leading-4">
                  <Film className="size-3" aria-hidden="true" />
                  clip
                </span>
              )}
              {ticked && (
                <span className="absolute inset-0 flex items-center justify-center bg-background/40">
                  <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
                    <Check className="size-4" aria-hidden="true" />
                  </span>
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Section({
  title,
  items,
  ...grid
}: { title: string; items: StudioReference[] } & Omit<TileGridProps, 'items'>) {
  if (items.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <TileGrid items={items} {...grid} />
    </section>
  );
}

/** One sequence, drilled into: its shots, elements, cast, and locations. */
function SequenceDetail({
  sequence,
  onBack,
  ...grid
}: {
  sequence: SequenceWithShots;
  onBack: () => void;
} & Omit<TileGridProps, 'items'>) {
  const { data: elements } = useSequenceElements(sequence.id);
  const { data: characters } = useSequenceCharacters(sequence.id);
  const { data: locations } = useSequenceLocations(sequence.id);
  const loading = !elements || !characters || !locations;

  const shots = shotReferences(sequence);
  const elementRefs = (elements ?? []).flatMap((el) =>
    el.imageUrl
      ? [{ url: el.imageUrl, label: el.token, kind: 'image' as const }]
      : []
  );
  const castRefs = (characters ?? []).flatMap((c) =>
    c.sheetImageUrl
      ? [{ url: c.sheetImageUrl, label: c.name, kind: 'image' as const }]
      : []
  );
  const locationRefs = (locations ?? []).flatMap((loc) =>
    loc.referenceImageUrl
      ? [
          {
            url: loc.referenceImageUrl,
            label: loc.name,
            kind: 'image' as const,
          },
        ]
      : []
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Sequences
        </Button>
        <span className="truncate text-sm font-medium">{sequence.title}</span>
      </div>
      <Section title="Shots" items={shots} {...grid} />
      {loading ? (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="aspect-square rounded-md" />
          ))}
        </div>
      ) : (
        <>
          <Section title="Elements" items={elementRefs} {...grid} />
          <Section title="Cast" items={castRefs} {...grid} />
          <Section title="Locations" items={locationRefs} {...grid} />
          {shots.length +
            elementRefs.length +
            castRefs.length +
            locationRefs.length ===
            0 && (
            <p className="text-sm text-muted-foreground">
              Nothing generated in this sequence yet.
            </p>
          )}
        </>
      )}
    </div>
  );
}

type StudioReferencePickerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  library: StudioLibrary;
  /** URLs already attached — shown ticked, not re-addable. */
  attached: string[];
  /** Multi-select with a confirm button; otherwise the first click picks. */
  multiple: boolean;
  /** How many more of each kind can be added. 0 disables that kind. */
  slots: StudioReferenceSlots;
  onPick: (references: StudioReference[]) => void;
  onUpload: (files: File[]) => void;
};

export function StudioReferencePicker({
  open,
  onOpenChange,
  title,
  library,
  attached,
  multiple,
  slots,
  onPick,
  onUpload,
}: StudioReferencePickerProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source>('generations');
  const [sequenceId, setSequenceId] = useState<string | null>(null);
  const [pending, setPending] = useState<StudioReference[]>([]);
  const { data: sequences } = useSequencesWithShots();
  const sources = SOURCES.filter((s) => s.key !== 'audio' || slots.audio > 0);
  const openSequence = sequenceId
    ? sequences.find((s) => s.id === sequenceId)
    : undefined;

  const close = () => {
    setPending([]);
    setSequenceId(null);
    onOpenChange(false);
  };

  const toggle = (item: StudioReference) => {
    if (!multiple) {
      onPick([item]);
      close();
      return;
    }
    setPending((prev) =>
      prev.some((p) => p.url === item.url)
        ? prev.filter((p) => p.url !== item.url)
        : [...prev, item]
    );
  };

  const grid = { attached, pending, slots, multiple, onToggle: toggle };

  const accept =
    source === 'audio'
      ? 'audio/mpeg,audio/wav,.mp3,.wav'
      : [
          'image/*',
          ...(slots.video > 0
            ? ['video/mp4', 'video/quicktime', '.mp4', '.mov']
            : []),
        ].join(',');

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-3xl">
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b py-3 pr-12 pl-4">
          <div className="flex flex-col gap-0.5">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
              {multiple
                ? `Up to ${slots.image} stills${slots.video > 0 ? `, ${slots.video} clips` : ''}${slots.audio > 0 ? `, ${slots.audio} audio` : ''}. Upload or paste.`
                : 'Pick one, upload, or paste.'}
            </DialogDescription>
          </div>
          <input
            ref={fileInput}
            type="file"
            accept={accept}
            multiple={multiple || source === 'audio'}
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              if (files.length > 0) {
                onUpload(files);
                close();
              }
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInput.current?.click()}
          >
            <Upload aria-hidden="true" />
            {source === 'audio' ? 'Upload audio' : 'Upload'}
          </Button>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          <nav
            aria-label="Reference source"
            className="flex w-40 shrink-0 flex-col gap-1 border-r p-2"
          >
            {sources.map(({ key, label, icon: Icon }) => (
              <Button
                key={key}
                type="button"
                variant={source === key ? 'secondary' : 'ghost'}
                size="sm"
                className="justify-start"
                aria-pressed={source === key}
                onClick={() => {
                  setSource(key);
                  setSequenceId(null);
                }}
              >
                <Icon aria-hidden="true" />
                {label}
                {key !== 'audio' && (
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    {library[key].length}
                  </span>
                )}
              </Button>
            ))}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            {source === 'audio' ? (
              <div className="flex flex-col items-start gap-3 p-4">
                <p className="text-sm text-muted-foreground">
                  MP3 or WAV, up to {slots.audio} more. Seedance: 15 seconds
                  combined. Each clip becomes{' '}
                  <span className="font-mono">@Audio1</span>,{' '}
                  <span className="font-mono">@Audio2</span>… in the prompt.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => fileInput.current?.click()}
                >
                  <Upload aria-hidden="true" />
                  Upload audio
                </Button>
              </div>
            ) : source === 'sequences' ? (
              openSequence ? (
                <SequenceDetail
                  sequence={openSequence}
                  onBack={() => setSequenceId(null)}
                  {...grid}
                />
              ) : library.sequences.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">
                  {EMPTY.sequences}
                </p>
              ) : (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                  {library.sequences.map((sequence) => (
                    <li key={sequence.id}>
                      <button
                        type="button"
                        onClick={() => setSequenceId(sequence.id)}
                        className="flex w-full flex-col gap-1 rounded-md border bg-muted p-1 text-left transition-colors hover:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                      >
                        <span className="block aspect-video w-full overflow-hidden rounded bg-background">
                          {sequence.posterUrl ? (
                            <AppImage
                              src={sequence.posterUrl}
                              alt=""
                              width={320}
                              height={180}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span className="flex h-full items-center justify-center text-muted-foreground">
                              <Clapperboard
                                className="size-5"
                                aria-hidden="true"
                              />
                            </span>
                          )}
                        </span>
                        <span className="truncate px-1 text-xs">
                          {sequence.title}
                        </span>
                        <span className="px-1 pb-0.5 font-mono text-[10px] text-muted-foreground">
                          {sequence.shotCount} shots
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )
            ) : library[source].length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">
                {EMPTY[source]}
              </p>
            ) : (
              <TileGrid items={library[source]} {...grid} />
            )}
          </div>
        </div>

        {multiple && (
          <DialogFooter className="mx-0 mb-0 border-t px-4 py-3">
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending.length === 0}
              onClick={() => {
                onPick(pending);
                close();
              }}
            >
              {pending.length > 0 ? `Add ${pending.length}` : 'Add'}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
