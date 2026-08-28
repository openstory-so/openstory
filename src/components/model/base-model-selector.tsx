import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Loader2,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

/**
 * Per-scene marker for a model in the dropdown (#545).
 * - `set`: this model's output is the scene's live primary (what plays).
 * - `completed`: a finished variant exists but isn't set — selectable, then
 *   "Set Video/Image" promotes it.
 * - `generating`/`failed`/`pending`: variant state, no promotion yet.
 */
export type ModelGenerationStatus =
  | 'pending'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'set';

type ModelItem = {
  id: string;
  name: string;
  group: string;
  badge?: 'open-weight' | 'proprietary';
  /** Show a "Recommended" badge with the given tooltip text */
  recommendedFor?: string;
  /**
   * Renders a per-scene status marker for this model's variant (#545):
   * ⊙ set (live primary) / ✓ completed / ⟳ generating / ! failed.
   * `pending`/undefined render nothing.
   */
  generationStatus?: ModelGenerationStatus;
};

const STATUS_ICON: Record<
  'generating' | 'completed' | 'failed' | 'set',
  { Icon: typeof Check; className: string; label: string }
> = {
  set: {
    Icon: CircleCheck,
    className: 'text-emerald-500',
    label: 'Currently set for this scene',
  },
  completed: {
    Icon: Check,
    className: 'text-muted-foreground',
    label: 'Generated — select then click Set to use',
  },
  generating: {
    Icon: Loader2,
    className: 'text-muted-foreground animate-spin',
    label: 'Generating…',
  },
  failed: {
    Icon: CircleAlert,
    className: 'text-destructive',
    label: 'Generation failed',
  },
};

function ModelStatusIcon({ status }: { status?: ModelGenerationStatus }) {
  if (!status || status === 'pending') return null;
  const { Icon, className, label } = STATUS_ICON[status];
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0" aria-label={label}>
            <Icon className={`size-3.5 ${className}`} />
          </span>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type BaseModelSelectorProps = {
  label: string;
  models: ModelItem[];
  groupOrder: readonly string[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
  multiSelect?: boolean;
};

export const BaseModelSelector: React.FC<BaseModelSelectorProps> = ({
  label,
  models,
  groupOrder,
  selectedIds,
  onSelectionChange,
  disabled = false,
  multiSelect = false,
}) => {
  const [open, setOpen] = useState(false);
  const [multipleEnabled, setMultipleEnabled] = useState(
    selectedIds.length > 1
  );

  // Group models by their group field
  const groupedModels = useMemo(() => {
    const groups = new Map<string, ModelItem[]>();
    for (const model of models) {
      if (!groups.has(model.group)) {
        groups.set(model.group, []);
      }
      groups.get(model.group)?.push(model);
    }
    return Object.fromEntries(groups);
  }, [models]);

  const isMultiActive = multiSelect && multipleEnabled;

  const handleToggle = useCallback(
    (modelId: string, checked: boolean) => {
      if (disabled) return;

      if (!isMultiActive) {
        // Single select mode — pick this model
        if (checked) {
          onSelectionChange([modelId]);
        }
      } else {
        // Multi select mode
        if (checked) {
          onSelectionChange([...selectedIds, modelId]);
        } else {
          // Ensure at least one remains
          if (selectedIds.length > 1) {
            onSelectionChange(selectedIds.filter((id) => id !== modelId));
          }
        }
      }
    },
    [selectedIds, onSelectionChange, disabled, isMultiActive]
  );

  const handleMultipleToggle = useCallback(
    (enabled: boolean) => {
      setMultipleEnabled(enabled);
      // When turning off multiple, snap to just the first selected model
      const firstId = selectedIds[0];
      if (!enabled && selectedIds.length > 1 && firstId) {
        onSelectionChange([firstId]);
      }
    },
    [selectedIds, onSelectionChange]
  );

  // Display label for button
  const displayLabel = useMemo(() => {
    if (selectedIds.length === 0) {
      return `Select ${label.toLowerCase()}`;
    }

    const firstModel = models.find((m) => m.id === selectedIds[0]);
    const firstName = firstModel?.name ?? 'Unknown';

    if (selectedIds.length === 1) {
      return firstName;
    }

    return `${firstName} +${selectedIds.length - 1}`;
  }, [selectedIds, models, label]);

  // Format group label (capitalize, format nicely)
  const formatGroupLabel = (group: string) => {
    return group
      .split('-')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  };

  const showGroupHeaders = groupOrder.length > 1;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-full justify-between"
          disabled={disabled}
          aria-label={`${label}: ${displayLabel}`}
        >
          <span className="text-sm truncate">{displayLabel}</span>
          <ChevronDown className="ml-2 size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-[300px] max-h-[400px] overflow-y-auto">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="p-0 text-xs">{label}</DropdownMenuLabel>
          {multiSelect && (
            <div className="flex items-center gap-1.5">
              <label
                htmlFor="multi-toggle"
                className="text-[10px] text-muted-foreground"
              >
                Multiple
              </label>
              <Switch
                id="multi-toggle"
                size="sm"
                checked={multipleEnabled}
                onCheckedChange={handleMultipleToggle}
              />
            </div>
          )}
        </div>
        <DropdownMenuSeparator />
        {groupOrder.map((groupKey, groupIndex) => {
          const groupModels = groupedModels[groupKey];
          if (!groupModels || groupModels.length === 0) return null;

          return (
            <DropdownMenuGroup key={groupKey}>
              {groupIndex > 0 && <DropdownMenuSeparator />}
              {showGroupHeaders && (
                <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider font-normal">
                  {formatGroupLabel(groupKey)}
                </DropdownMenuLabel>
              )}
              {groupModels.map((model) => {
                const isSelected = selectedIds.includes(model.id);
                const isDisabled = isMultiActive
                  ? isSelected && selectedIds.length === 1
                  : isSelected;

                return (
                  <DropdownMenuCheckboxItem
                    key={model.id}
                    checked={isSelected}
                    onCheckedChange={(checked) =>
                      handleToggle(model.id, checked)
                    }
                    onSelect={(e) => e.preventDefault()}
                    disabled={isDisabled}
                    className="cursor-pointer"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      <span className="truncate">{model.name}</span>
                      <ModelStatusIcon status={model.generationStatus} />
                      {model.recommendedFor && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                Recommended
                              </span>
                            </TooltipTrigger>
                            <TooltipContent>
                              {model.recommendedFor}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      )}
                      {model.badge === 'open-weight' && (
                        <span className="shrink-0 rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-500">
                          Open Weight
                        </span>
                      )}
                    </span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
