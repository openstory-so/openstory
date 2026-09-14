import { useElevenLabsVoices } from '@/cast/ui/use-elevenlabs-voices';
import type { CatalogVoice, CatalogVoiceSource } from '@/cast/voice';
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
import { Tabs, TabsList, TabsTrigger } from '@/ui/shadcn/tabs';
import { cn } from '@/ui/utils';
import { Library, Search } from 'lucide-react';
import { useRef, useState } from 'react';

type VoiceLibraryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedVoiceId?: string | null;
  onSelect: (voice: CatalogVoice) => void;
  pending?: boolean;
};

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

export const VoiceLibraryDialog: React.FC<VoiceLibraryDialogProps> = ({
  open,
  onOpenChange,
  selectedVoiceId,
  onSelect,
  pending = false,
}) => {
  const [source, setSource] = useState<CatalogVoiceSource>('premade');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const searchTimer = useRef<number>(0);

  const query = useElevenLabsVoices(source, search, open);
  const voices = query.data?.pages.flatMap((page) => page.voices) ?? [];
  const empty = !query.isFetching && voices.length === 0;
  const lastPage = query.data?.pages.at(-1);

  const reset = () => {
    window.clearTimeout(searchTimer.current);
    setInput('');
    setSearch('');
    setSource('premade');
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
      <DialogContent className="flex max-h-[min(90vh,40rem)] w-full flex-col gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Voice library</DialogTitle>
          <DialogDescription>
            Default ElevenLabs voices cost no slot. Voice Library picks are
            copied onto the platform account.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={source}
          onValueChange={(value) => {
            if (value !== 'premade' && value !== 'library') return;
            setSource(value);
          }}
        >
          <TabsList>
            <TabsTrigger value="premade">Default</TabsTrigger>
            <TabsTrigger value="library">Voice Library</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            autoComplete="off"
            placeholder="Search voices…"
            value={input}
            onChange={(event) => handleSearchChange(event.target.value)}
            className="pl-9"
          />
        </div>
        <ScrollArea className="h-[24rem]">
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
                {search
                  ? 'No voices matching your search'
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
        {source === 'library' && lastPage?.hasMore && (
          <Button
            type="button"
            variant="outline"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
          </Button>
        )}
        {query.isError && (
          <p className="text-sm text-destructive">
            Could not load voices. Try again in a moment.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
};
