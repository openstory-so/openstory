import { useElevenLabsVoices } from '@/cast/ui/use-elevenlabs-voices';
import {
  DEFAULT_VOICE_LANGUAGE,
  OTHER_VOICE_LANGUAGES,
  VOICE_NATIONALITIES,
  parseVoiceLocale,
  voiceLocaleKey,
  type CatalogVoice,
  type CatalogVoiceFilters,
  type VoiceAgeFilter,
  type VoiceGenderFilter,
  type VoiceQualityFilter,
} from '@/cast/voice';
import { Button } from '@/ui/shadcn/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/ui/shadcn/dialog';
import { Input } from '@/ui/shadcn/input';
import { ScrollArea } from '@/ui/shadcn/scroll-area';
import { Skeleton } from '@/ui/shadcn/skeleton';
import { cn } from '@/ui/utils';
import { Library, Search } from 'lucide-react';
import { useRef, useState } from 'react';

type VoiceLibraryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedVoiceId?: string | null;
  onSelect: (voice: CatalogVoice) => void;
  pending?: boolean;
  characterName: string;
  recommended: CatalogVoiceFilters;
};

const QUALITY_OPTIONS: { value: VoiceQualityFilter; label: string }[] = [
  { value: 'studio', label: 'Studio' },
];

const GENDER_OPTIONS: { value: VoiceGenderFilter; label: string }[] = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'neutral', label: 'Neutral' },
];

const AGE_OPTIONS: { value: VoiceAgeFilter; label: string }[] = [
  { value: 'young', label: 'Young' },
  { value: 'middle_aged', label: 'Middle aged' },
  { value: 'old', label: 'Old' },
];

const VoiceRow: React.FC<{
  voice: CatalogVoice;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
}> = ({ voice, selected, disabled, onSelect }) => (
  <li
    className={cn(
      'flex flex-col gap-2 rounded-lg border p-3',
      selected ? 'border-primary ring-2 ring-primary/40' : 'border-border'
    )}
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{voice.name}</p>
        {voice.labels.length > 0 && (
          <p className="truncate text-xs text-muted-foreground">
            {voice.labels.join(' · ')}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant={selected ? 'secondary' : 'outline'}
        disabled={disabled || selected}
        onClick={onSelect}
      >
        {selected ? 'In use' : 'Use'}
      </Button>
    </div>
    {voice.previewUrl ? (
      // oxlint-disable-next-line jsx-a11y/media-has-caption -- a voice sample has no words to caption
      <audio
        controls
        preload="none"
        src={voice.previewUrl}
        className="w-full"
      />
    ) : (
      <p className="text-xs text-muted-foreground">No preview</p>
    )}
  </li>
);

function FilterPills<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <p className="w-24 shrink-0 text-sm font-medium">{label}</p>
      <div className="flex min-w-0 flex-nowrap justify-end gap-1">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            size="sm"
            variant="secondary"
            aria-pressed={value === option.value}
            className={cn(
              'shrink-0',
              value === option.value && 'bg-foreground text-background'
            )}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          aria-pressed={value === undefined}
          className={cn(
            'shrink-0',
            value === undefined && 'bg-foreground text-background'
          )}
          onClick={() => onChange(undefined)}
        >
          Any
        </Button>
      </div>
    </div>
  );
}

function LanguageSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: Pick<CatalogVoiceFilters, 'language' | 'accent'>) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <label
        htmlFor="voice-library-language"
        className="w-24 shrink-0 text-sm font-medium"
      >
        Language
      </label>
      <select
        id="voice-library-language"
        value={value}
        onChange={(event) => onChange(parseVoiceLocale(event.target.value))}
        className="h-8 min-w-40 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        <optgroup label="English">
          <option value={DEFAULT_VOICE_LANGUAGE}>English</option>
          {VOICE_NATIONALITIES.map((nationality) => (
            <option
              key={nationality.value}
              value={voiceLocaleKey(DEFAULT_VOICE_LANGUAGE, nationality.value)}
            >
              {nationality.label}
            </option>
          ))}
        </optgroup>
        <optgroup label="Other languages">
          {OTHER_VOICE_LANGUAGES.map((language) => (
            <option key={language.value} value={language.value}>
              {language.label}
            </option>
          ))}
        </optgroup>
      </select>
    </div>
  );
}

export const VoiceLibraryDialog: React.FC<VoiceLibraryDialogProps> = ({
  open,
  onOpenChange,
  selectedVoiceId,
  onSelect,
  pending = false,
  characterName,
  recommended,
}) => {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<CatalogVoiceFilters>(recommended);
  const searchTimer = useRef<number>(0);

  const query = useElevenLabsVoices(search, filters, open);
  const voices = query.data?.pages.flatMap((page) => page.voices) ?? [];
  const empty = !query.isFetching && voices.length === 0;
  const lastPage = query.data?.pages.at(-1);
  const hasFilters =
    Boolean(
      filters.gender || filters.age || filters.quality || filters.accent
    ) || filters.language !== DEFAULT_VOICE_LANGUAGE;

  const reset = () => {
    window.clearTimeout(searchTimer.current);
    setInput('');
    setSearch('');
    setFilters(recommended);
  };

  const handleSearchChange = (value: string) => {
    setInput(value);
    window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      setSearch(value.trim());
    }, 300);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="flex h-[min(90vh,44rem)] w-full flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Voice library</DialogTitle>
          <DialogDescription className="sr-only">
            Pick an ElevenLabs voice for {characterName}.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            autoComplete="off"
            placeholder={`Search voices${characterName ? ` for ${characterName}` : ''}…`}
            value={input}
            onChange={(event) => handleSearchChange(event.target.value)}
            className="pl-9"
          />
        </div>
        <div className="flex flex-col gap-2">
          <LanguageSelect
            value={voiceLocaleKey(filters.language, filters.accent)}
            onChange={(locale) =>
              setFilters((current) => ({
                ...current,
                language: locale.language,
                accent: locale.accent,
              }))
            }
          />
          <FilterPills
            label="Quality"
            value={filters.quality}
            options={QUALITY_OPTIONS}
            onChange={(quality) =>
              setFilters((current) => ({ ...current, quality }))
            }
          />
          <FilterPills
            label="Gender"
            value={filters.gender}
            options={GENDER_OPTIONS}
            onChange={(gender) =>
              setFilters((current) => ({ ...current, gender }))
            }
          />
          <FilterPills
            label="Age"
            value={filters.age}
            options={AGE_OPTIONS}
            onChange={(age) => setFilters((current) => ({ ...current, age }))}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="self-end"
            disabled={!hasFilters}
            onClick={() => setFilters({ language: DEFAULT_VOICE_LANGUAGE })}
          >
            Clear filters
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1">
          {query.isFetching && voices.length === 0 ? (
            <div className="flex flex-col gap-2 p-1">
              {Array.from({ length: 4 }).map((_, index) => (
                <Skeleton key={index} className="h-24 w-full rounded-lg" />
              ))}
            </div>
          ) : empty ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Library className="h-10 w-10 text-muted-foreground/30" />
              <p className="mt-3 text-sm text-muted-foreground">
                {search || hasFilters
                  ? 'No voices matching these filters'
                  : 'No voices available'}
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2 p-1">
              {voices.map((voice) => (
                <VoiceRow
                  key={`${voice.source}:${voice.voiceId}`}
                  voice={voice}
                  selected={voice.voiceId === selectedVoiceId}
                  disabled={pending}
                  onSelect={() => onSelect(voice)}
                />
              ))}
            </ul>
          )}
        </ScrollArea>
        <div className="h-8">
          {lastPage?.hasMore ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </div>
        <p className="h-5 text-sm text-destructive">
          <span className={query.isError ? undefined : 'invisible'}>
            Could not load voices. Try again in a moment.
          </span>
        </p>
      </DialogContent>
    </Dialog>
  );
};
