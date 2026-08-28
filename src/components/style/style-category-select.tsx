import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  ALL_COMPOSER_STYLE_CATEGORIES,
  composerStyleCategoryOptions,
} from '@/lib/style/composer-style-row';
import { styleCategoryLabel } from '@/lib/style/style-assets';
import type { Style } from '@/types/database';
import { ChevronDown } from 'lucide-react';

type StyleCategorySelectProps = {
  styles: Style[];
  value: string;
  onChange: (category: string) => void;
  disabled?: boolean;
  size?: 'sm' | 'default' | 'lg';
};

export function StyleCategorySelect({
  styles,
  value,
  onChange,
  disabled = false,
  size = 'sm',
}: StyleCategorySelectProps) {
  const families = composerStyleCategoryOptions(styles);
  const isAll = value === ALL_COMPOSER_STYLE_CATEGORIES;
  const selected = families.find((option) => option.value === value);
  const label = isAll
    ? 'All styles'
    : (selected?.label ?? styleCategoryLabel(value));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size}
          disabled={disabled}
          aria-label={`Style category: ${label}`}
        >
          <span className="max-w-40 truncate">{label}</span>
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {families.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
          {families.length > 0 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuRadioItem value={ALL_COMPOSER_STYLE_CATEGORIES}>
            All styles
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
