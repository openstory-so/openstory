import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { SCRIPT_ANALYSIS_MODELS } from '@/lib/ai/models.config';
import { IMAGE_MODELS } from '@/lib/ai/models';
import { ASPECT_RATIOS } from '@/lib/constants/aspect-ratios';
import {
  Clapperboard,
  ImageIcon,
  TextIcon,
  FileTextIcon,
  ShieldCheck,
  X,
  ArrowUpDown,
  Plus,
  SlidersHorizontal,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import {
  isValidSortField,
  isValidViewMode,
  type FilterState,
  type SortCriteria,
  type ViewMode,
} from './eval-view';

type EvalToolbarProps = {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
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

const SORT_FIELDS: { value: SortCriteria['field']; label: string }[] = [
  { value: 'createdAt', label: 'Date' },
  { value: 'title', label: 'Title' },
  { value: 'analysisModel', label: 'Analysis Model' },
  { value: 'imageModel', label: 'Image Model' },
];

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

const VIEW_MODE_ITEMS: {
  value: ViewMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { value: 'script', label: 'Script', icon: FileTextIcon },
  { value: 'prompts', label: 'Prompts', icon: TextIcon },
  { value: 'images', label: 'Images', icon: ImageIcon },
  { value: 'motion', label: 'Motion', icon: Clapperboard },
];

type ViewModeToggleProps = {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  iconOnly?: boolean;
};

const ViewModeToggle: React.FC<ViewModeToggleProps> = ({
  viewMode,
  onViewModeChange,
  iconOnly,
}) => {
  return (
    <ToggleGroup
      type="single"
      value={viewMode}
      onValueChange={(value) => {
        if (value && isValidViewMode(value)) {
          onViewModeChange(value);
        }
      }}
      variant="outline"
      spacing={0}
      className={iconOnly ? 'w-full' : undefined}
    >
      {VIEW_MODE_ITEMS.map(({ value, label, icon: Icon }) => (
        <ToggleGroupItem
          key={value}
          value={value}
          aria-label={`Show ${label.toLowerCase()}`}
          className={iconOnly ? 'h-10 flex-1' : undefined}
        >
          <Icon className={iconOnly ? 'h-4 w-4' : 'h-4 w-4 mr-2'} />
          {!iconOnly && label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
};

const getSortFieldOptions = (criteria: SortCriteria[], index: number) => {
  const usedFields = new Set(
    criteria.filter((_, i) => i !== index).map((c) => c.field)
  );
  const currentField = criteria[index]?.field;
  return SORT_FIELDS.filter(
    (f) => !usedFields.has(f.value) || f.value === currentField
  );
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
    <Select value={value} onValueChange={onValueChange}>
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

  const addSortCriteria = () => {
    if (sortCriteria.length >= 3) return;
    const usedFields = new Set(sortCriteria.map((c) => c.field));
    const availableField = SORT_FIELDS.find((f) => !usedFields.has(f.value));
    if (availableField) {
      onSortChange([
        ...sortCriteria,
        { field: availableField.value, direction: 'desc' },
      ]);
    }
  };

  const removeSortCriteria = (index: number) => {
    if (sortCriteria.length <= 1) return;
    onSortChange(sortCriteria.filter((_, i) => i !== index));
  };

  const toggleSortDirection = (index: number) => {
    const current = sortCriteria[index];
    if (!current) return;
    const updated = [...sortCriteria];
    updated[index] = {
      ...current,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
    onSortChange(updated);
  };

  const updateSortField = (index: number, field: SortCriteria['field']) => {
    const current = sortCriteria[index];
    if (!current) return;
    const updated = [...sortCriteria];
    updated[index] = { ...current, field };
    onSortChange(updated);
  };

  // Build options for select components
  const analysisModelOptions = [
    { value: 'all', label: 'All Analysis Models' },
    ...SCRIPT_ANALYSIS_MODELS.filter((model) => !('hidden' in model)).map(
      (model) => ({
        value: model.id,
        label: model.name,
      })
    ),
  ];

  const imageModelOptions = [
    { value: 'all', label: 'All Image Models' },
    ...Object.values(IMAGE_MODELS)
      .filter((m) => !('hidden' in m))
      .map((model) => ({
        value: model.id,
        label: model.name,
      })),
  ];

  const aspectRatioOptions = [
    { value: 'all', label: 'All Aspect Ratios' },
    ...ASPECT_RATIOS.map((r) => ({ value: r.value, label: r.label })),
  ];

  const primarySort = sortCriteria[0];

  return (
    <>
      {/* Mobile layout (≤sm) — flat, no Card chrome */}
      <div className="flex flex-col gap-2 pb-3 border-b border-border sm:hidden">
        <div className="flex items-center gap-2">
          <Input
            placeholder={
              supportMode ? 'Search title, name, email…' : 'Search by title…'
            }
            value={searchDraft}
            onChange={handleSearchChange}
            className="h-11 flex-1 min-w-0"
          />
          <Popover open={filtersOpen} onOpenChange={setFiltersOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="lg"
                className="h-11 shrink-0 gap-1.5 px-3"
                aria-label={
                  activeFilterCount > 0
                    ? `Filters and sort, ${activeFilterCount} active`
                    : 'Filters and sort'
                }
              >
                <SlidersHorizontal className="h-4 w-4" />
                {activeFilterCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="h-5 min-w-5 justify-center px-1.5"
                  >
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent
              align="end"
              className="flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-3"
            >
              {primarySort && (
                <div className="flex flex-col gap-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Sort by
                  </Label>
                  <div className="flex items-center gap-2">
                    <Select
                      value={primarySort.field}
                      onValueChange={(value) => {
                        if (isValidSortField(value)) {
                          updateSortField(0, value);
                        }
                      }}
                    >
                      <SelectTrigger
                        aria-label="Sort by"
                        className="h-11 flex-1"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {getSortFieldOptions(sortCriteria, 0).map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-11 w-11 shrink-0"
                      onClick={() => toggleSortDirection(0)}
                      aria-label={
                        primarySort.direction === 'asc'
                          ? 'Sort ascending'
                          : 'Sort descending'
                      }
                    >
                      {primarySort.direction === 'asc' ? (
                        <ArrowUp className="h-4 w-4" />
                      ) : (
                        <ArrowDown className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              )}

              <FilterSelect
                id="mobile-analysis-model"
                label="Analysis Model"
                value={filters.analysisModel || 'all'}
                onValueChange={handleAnalysisModelChange}
                options={analysisModelOptions}
                placeholder="Analysis Model"
                triggerClassName="h-11"
              />

              <FilterSelect
                id="mobile-image-model"
                label="Image Model"
                value={filters.imageModel || 'all'}
                onValueChange={handleImageModelChange}
                options={imageModelOptions}
                placeholder="Image Model"
                triggerClassName="h-11"
              />

              <FilterSelect
                id="mobile-aspect-ratio"
                label="Aspect Ratio"
                value={filters.aspectRatio || 'all'}
                onValueChange={handleAspectRatioChange}
                options={aspectRatioOptions}
                placeholder="Aspect Ratio"
                triggerClassName="h-11"
              />

              <FilterSelect
                id="mobile-style"
                label="Style"
                value={filters.styleId || 'all'}
                onValueChange={handleStyleChange}
                options={styleOptions}
                placeholder="Style"
                triggerClassName="h-11"
              />

              {isAdmin && (
                <div className="flex flex-col gap-3 border-t pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label
                      htmlFor="mobile-support-mode"
                      className="flex items-center gap-2 text-sm font-medium"
                    >
                      <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                      Support
                    </Label>
                    <Switch
                      id="mobile-support-mode"
                      checked={Boolean(supportMode)}
                      onCheckedChange={(v) => onSupportModeChange?.(v)}
                    />
                  </div>
                  {supportMode && hideInternalAvailable && (
                    <div className="flex items-center justify-between gap-2">
                      <Label
                        htmlFor="mobile-hide-internal"
                        className="text-sm font-medium"
                      >
                        Hide internal
                      </Label>
                      <Switch
                        id="mobile-hide-internal"
                        checked={Boolean(hideInternal)}
                        onCheckedChange={(v) => onHideInternalChange?.(v)}
                        disabled={Boolean(hideInternalLocked)}
                      />
                    </div>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 border-t pt-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={clearFilters}
                  disabled={!hasActiveFilters}
                >
                  <X className="h-4 w-4 mr-1" />
                  Clear
                </Button>
                <Button size="sm" onClick={() => setFiltersOpen(false)}>
                  Done
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        <ViewModeToggle
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
          iconOnly
        />
      </div>

      {/* Desktop layout (≥sm) — keeps Card chrome */}
      <Card className="hidden sm:flex sm:flex-col sm:gap-3 p-3">
        {/* Row 1: filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder={
              supportMode
                ? 'Search by title, name, or email…'
                : 'Search by title…'
            }
            value={searchDraft}
            onChange={handleSearchChange}
            className="w-48"
          />
          <FilterSelect
            value={filters.analysisModel || 'all'}
            onValueChange={handleAnalysisModelChange}
            options={analysisModelOptions}
            placeholder="Analysis Model"
            triggerClassName="w-44"
          />
          <FilterSelect
            value={filters.imageModel || 'all'}
            onValueChange={handleImageModelChange}
            options={imageModelOptions}
            placeholder="Image Model"
            triggerClassName="w-44"
          />
          <FilterSelect
            value={filters.aspectRatio || 'all'}
            onValueChange={handleAspectRatioChange}
            options={aspectRatioOptions}
            placeholder="Aspect Ratio"
            triggerClassName="w-36"
          />
          <FilterSelect
            value={filters.styleId || 'all'}
            onValueChange={handleStyleChange}
            options={styleOptions}
            placeholder="Style"
            triggerClassName="w-44"
          />
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="h-4 w-4 mr-1" />
              Clear
            </Button>
          )}
        </div>

        {/* Row 2: view toggle, sort, support mode */}
        <div className="flex flex-wrap items-center gap-3">
          <ViewModeToggle
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
          />

          <div className="flex items-center gap-2">
            <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
            {sortCriteria.map((criteria, index) => {
              const sortFieldOptions = getSortFieldOptions(sortCriteria, index);

              return (
                <Badge
                  key={criteria.field}
                  variant="secondary"
                  className="flex items-center gap-1 px-2 py-1"
                >
                  <Select
                    value={criteria.field}
                    onValueChange={(value) => {
                      if (isValidSortField(value)) {
                        updateSortField(index, value);
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-auto p-0 border-0 bg-transparent w-auto min-w-16"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sortFieldOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 p-0"
                    onClick={() => toggleSortDirection(index)}
                  >
                    {criteria.direction === 'asc' ? '↑' : '↓'}
                  </Button>
                  {sortCriteria.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0"
                      onClick={() => removeSortCriteria(index)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </Badge>
              );
            })}
            {sortCriteria.length < 3 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={addSortCriteria}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Support Mode (admin only) — pushed to end of row */}
          {isAdmin && (
            <div className="ml-auto flex items-center gap-4">
              {supportMode && hideInternalAvailable && (
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="hide-internal"
                    className="text-sm font-medium"
                  >
                    Hide internal
                  </Label>
                  <Switch
                    id="hide-internal"
                    checked={Boolean(hideInternal)}
                    onCheckedChange={(v) => onHideInternalChange?.(v)}
                    disabled={Boolean(hideInternalLocked)}
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="support-mode" className="text-sm font-medium">
                  Support
                </Label>
                <Switch
                  id="support-mode"
                  checked={Boolean(supportMode)}
                  onCheckedChange={(v) => onSupportModeChange?.(v)}
                />
              </div>
            </div>
          )}
        </div>
      </Card>
    </>
  );
};
