import { Button } from '@/ui/shadcn/button';

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
  return (
    <div className="flex items-center gap-2">
      {filters.map((filter) => (
        <Button
          key={filter.value}
          variant={current === filter.value ? 'default' : 'outline'}
          size="sm"
          aria-pressed={current === filter.value}
          onClick={() => onSelect(filter.value)}
        >
          {filter.label}
        </Button>
      ))}
    </div>
  );
}
