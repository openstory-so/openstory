import { Button } from '@/ui/shadcn/button';
import { useHydrated } from '@/ui/use-hydrated';

type LibraryFiltersProps<T extends string> = {
  current: T;
  filters: readonly { value: T; label: string }[];
  onSelect: (value: T) => void;
};

/** The filter row above a library grid. The caller puts the pick in the URL. */
export function LibraryFilters<T extends string>({
  current,
  filters,
  onSelect,
}: LibraryFiltersProps<T>) {
  // Server-rendered before its handler exists: a click then does nothing
  // (the Characters e2e clicked "All Characters" early). Disabled until
  // hydrated, like the library button; Playwright's click waits for it.
  const hydrated = useHydrated();
  return (
    <div className="flex items-center gap-2">
      {filters.map((filter) => (
        <Button
          key={filter.value}
          variant={current === filter.value ? 'default' : 'outline'}
          size="sm"
          aria-pressed={current === filter.value}
          disabled={!hydrated}
          onClick={() => onSelect(filter.value)}
        >
          {filter.label}
        </Button>
      ))}
    </div>
  );
}
