import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { ManualSequenceDialog } from '../manual-sequence-dialog';
import { Input } from '@/ui/shadcn/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/shadcn/select';
import { Button } from '@/ui/shadcn/button';
import { Badge } from '@/ui/shadcn/badge';
import { Switch } from '@/ui/shadcn/switch';
import { Label } from '@/ui/shadcn/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/shadcn/popover';
import { SCRIPT_ANALYSIS_MODELS } from '@/models/models.config';
import { IMAGE_MODELS } from '@/models/models';
import { ASPECT_RATIOS } from '@/models/aspect-ratios';
import { Search, ShieldCheck, SlidersHorizontal, X } from 'lucide-react';
import {
  isValidViewMode,
  type FilterState,
  type SortCriteria,
  type ListViewMode,
} from './eval-view';

type EvalToolbarProps = {
  viewMode: ListViewMode;
  onViewModeChange: (mode: ListViewMode) => void;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  styleOptions: FilterSelectOption[];
  sortCriteria: SortCriteria[];
  onSortChange: (criteria: SortCriteria[]) => void;
  supportMode?: boolean;
  // Support-mode controls (rendered inline when isAdmin is true)
  isAdmin?: boolean;
  onSupportModeChange?: (value: boolean) => void;
  hideInternal?: boolean;
  onHideInternalChange?: (value: boolean) => void;
  hideInternalAvailable?: boolean;
  hideInternalLocked?: boolean;
};

const countActiveFilters = (filters: FilterState): number => {
  let count = 0;
  if (filters.analysisModel) count++;
  if (filters.imageModel) count++;
  if (filters.aspectRatio) count++;
  if (filters.styleId) count++;
  if (filters.dateFrom) count++;
  if (filters.dateTo) count++;
  return count;
};

type FilterSelectOption = { value: string; label: string };

type FilterSelectProps = {
  id?: string;
  label?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: FilterSelectOption[];
  placeholder: string;
  triggerClassName?: string;
};

const FilterSelect: React.FC<FilterSelectProps> = ({
  id,
  label,
  value,
  onValueChange,
  options,
  placeholder,
  triggerClassName,
}) => {
  const select = (
    <Select
      value={value}
      items={options}
      onValueChange={(next) => next && onValueChange(next)}
    >
      <SelectTrigger id={id} className={triggerClassName}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  if (!label || !id) return select;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {select}
    </div>
  );
};

const VIEW_OPTIONS = [
  { value: 'gallery', label: 'Gallery' },
  { value: 'script', label: 'Compare scripts' },
  { value: 'prompts', label: 'Compare prompts' },
  { value: 'images', label: 'Compare images' },
  { value: 'motion', label: 'Compare motion' },
];
const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'title', label: 'Title A–Z' },
];
export const EvalToolbar: React.FC<EvalToolbarProps> = ({
  viewMode,
  onViewModeChange,
  filters,
  onFiltersChange,
  styleOptions,
  sortCriteria,
  onSortChange,
  supportMode,
  isAdmin,
  onSupportModeChange,
  hideInternal,
  onHideInternalChange,
  hideInternalAvailable,
  hideInternalLocked,
}) => {
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [filtersOpen, setFiltersOpen] = useState(false);

  // Keep latest filters/onFiltersChange in refs so the debounce effect can
  // depend only on the draft. Without this, an external `filters` change
  // (e.g. parent clears search) restarts the timer and the in-flight commit
  // overwrites the new value with the stale draft.
  const filtersRef = useRef(filters);
  const onFiltersChangeRef = useRef(onFiltersChange);
  useEffect(() => {
    filtersRef.current = filters;
    onFiltersChangeRef.current = onFiltersChange;
  });

  // Reset draft when the committed search changes from outside (e.g. Clear).
  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  // Debounce draft → committed search to avoid a server roundtrip per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      const current = filtersRef.current;
      if (searchDraft === current.search) return;
      onFiltersChangeRef.current({ ...current, search: searchDraft });
    }, 250);
    return () => clearTimeout(t);
  }, [searchDraft]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchDraft(e.target.value);
  };

  const handleAnalysisModelChange = (value: string) => {
    onFiltersChange({
      ...filters,
      analysisModel: value === 'all' ? null : value,
    });
  };

  const handleImageModelChange = (value: string) => {
    onFiltersChange({
      ...filters,
      imageModel: value === 'all' ? null : value,
    });
  };

  const handleAspectRatioChange = (value: string) => {
    const match = ASPECT_RATIOS.find((r) => r.value === value);
    onFiltersChange({
      ...filters,
      aspectRatio: match ? match.value : null,
    });
  };

  const handleStyleChange = (value: string) => {
    onFiltersChange({
      ...filters,
      styleId: value === 'all' ? null : value,
    });
  };

  const clearFilters = () => {
    onFiltersChange({
      search: '',
      dateFrom: null,
      dateTo: null,
      analysisModel: null,
      imageModel: null,
      aspectRatio: null,
      styleId: null,
    });
  };

  const activeFilterCount = countActiveFilters(filters);
  const hasActiveFilters = Boolean(filters.search) || activeFilterCount > 0;

  const primarySort = sortCriteria[0];
  const sortValue =
    primarySort?.field === 'title'
      ? 'title'
      : primarySort?.direction === 'asc'
        ? 'oldest'
        : 'newest';
  return (
    <div className="flex shrink-0 flex-col gap-3">
      {isAdmin && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg border bg-muted/30 px-3 py-2">
          <ShieldCheck className="size-4 text-muted-foreground" />
          <Label htmlFor="support-mode">Support mode</Label>
          <Switch
            id="support-mode"
            checked={Boolean(supportMode)}
            onCheckedChange={(value) => onSupportModeChange?.(value)}
          />
          {supportMode && (
            <span className="text-xs text-muted-foreground">All teams</span>
          )}
          {supportMode && hideInternalAvailable && (
            <div className="ml-auto flex items-center gap-2">
              <Label htmlFor="hide-internal">Hide internal</Label>
              <Switch
                id="hide-internal"
                checked={Boolean(hideInternal)}
                onCheckedChange={(value) => onHideInternalChange?.(value)}
                disabled={Boolean(hideInternalLocked)}
              />
            </div>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input
            aria-label="Search sequences"
            placeholder={
              supportMode
                ? 'Search title, name or email…'
                : 'Search your sequences…'
            }
            value={searchDraft}
            onChange={handleSearchChange}
            className="h-11 sm:h-10 pl-9"
          />
        </div>
        <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className="h-11 sm:h-10 gap-2"
              aria-label={
                activeFilterCount
                  ? `Filters, ${activeFilterCount} active`
                  : 'Filters'
              }
            >
              <SlidersHorizontal className="size-4" /> Filters
              {activeFilterCount > 0 && (
                <Badge variant="secondary">{activeFilterCount}</Badge>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            className="flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-4"
          >
            <p className="text-sm font-medium">Filter sequences</p>
            <FilterSelect
              id="sequence-style"
              label="Style"
              value={filters.styleId || 'all'}
              onValueChange={handleStyleChange}
              options={styleOptions}
              placeholder="All styles"
            />
            <FilterSelect
              id="sequence-aspect-ratio"
              label="Format"
              value={filters.aspectRatio || 'all'}
              onValueChange={handleAspectRatioChange}
              options={[
                { value: 'all', label: 'All formats' },
                ...ASPECT_RATIOS.map((r) => ({
                  value: r.value,
                  label: r.label,
                })),
              ]}
              placeholder="All formats"
            />
            <FilterSelect
              id="sequence-analysis-model"
              label="Analysis model"
              value={filters.analysisModel || 'all'}
              onValueChange={handleAnalysisModelChange}
              options={[
                { value: 'all', label: 'All analysis models' },
                ...SCRIPT_ANALYSIS_MODELS.filter((m) => !('hidden' in m)).map(
                  (m) => ({ value: m.id, label: m.name })
                ),
              ]}
              placeholder="All analysis models"
            />
            <FilterSelect
              id="sequence-image-model"
              label="Image model"
              value={filters.imageModel || 'all'}
              onValueChange={handleImageModelChange}
              options={[
                { value: 'all', label: 'All image models' },
                ...Object.values(IMAGE_MODELS)
                  .filter((m) => !('hidden' in m))
                  .map((m) => ({ value: m.id, label: m.name })),
              ]}
              placeholder="All image models"
            />
            <Button
              variant="ghost"
              onClick={clearFilters}
              disabled={!hasActiveFilters}
            >
              Clear filters
            </Button>
          </PopoverContent>
        </Popover>
        <Select
          value={sortValue}
          items={SORT_OPTIONS}
          onValueChange={(value) => {
            if (value === 'title')
              onSortChange([{ field: 'title', direction: 'asc' }]);
            else if (value === 'newest' || value === 'oldest')
              onSortChange([
                {
                  field: 'createdAt',
                  direction: value === 'oldest' ? 'asc' : 'desc',
                },
              ]);
          }}
        >
          <SelectTrigger aria-label="Sort sequences" className="h-11 sm:h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={viewMode}
          items={VIEW_OPTIONS}
          onValueChange={(value) => {
            if (value === 'gallery' || (value && isValidViewMode(value)))
              onViewModeChange(value);
          }}
        >
          <SelectTrigger aria-label="Sequence view" className="h-11 sm:h-10">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {VIEW_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ManualSequenceDialog />
      </div>
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {filters.search && <span>Matching “{filters.search}”</span>}
          {filters.styleId && (
            <Badge variant="secondary">
              {styleOptions.find((o) => o.value === filters.styleId)?.label ??
                filters.styleId}
            </Badge>
          )}
          {filters.aspectRatio && (
            <Badge variant="secondary">{filters.aspectRatio}</Badge>
          )}
          {filters.analysisModel && (
            <Badge variant="secondary">
              {SCRIPT_ANALYSIS_MODELS.find(
                (m) => m.id === filters.analysisModel
              )?.name ?? filters.analysisModel}
            </Badge>
          )}
          {filters.imageModel && (
            <Badge variant="secondary">
              {Object.values(IMAGE_MODELS).find(
                (m) => m.id === filters.imageModel
              )?.name ?? filters.imageModel}
            </Badge>
          )}
          <Button size="sm" variant="ghost" onClick={clearFilters}>
            <X className="size-3" />
            Clear all
          </Button>
        </div>
      )}
    </div>
  );
};
