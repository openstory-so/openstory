import { Link, useMatchRoute, useNavigate } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FileText, Grid3X3 } from 'lucide-react';

type SequenceTabsProps = {
  sequenceId: string;
};

type TabItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
};

// Landing tab when no sub-path is specified. `useSequenceTabItems` returns
// this as `tabs[0]`; keep them in sync.
export function getDefaultSequenceTabPath(sequenceId: string): string {
  return `/sequences/${sequenceId}/script`;
}

// Cast/Locations/Elements/Music became selection-scoped inspector facets and
// Theatre folded into the Scenes canvas (#986) — the tab bar is just the two
// primary surfaces now. The old index routes stay as deep-link targets.
function useSequenceTabItems(sequenceId: string): TabItem[] {
  return [
    {
      label: 'Script',
      href: getDefaultSequenceTabPath(sequenceId),
      icon: <FileText className="h-4 w-4" />,
    },
    {
      label: 'Scenes',
      href: `/sequences/${sequenceId}/scenes`,
      icon: <Grid3X3 className="h-4 w-4" />,
    },
  ];
}

export { useSequenceTabItems };

export const SequenceTabs: React.FC<SequenceTabsProps> = ({ sequenceId }) => {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const tabs = useSequenceTabItems(sequenceId);

  const activeIndex = tabs.findIndex((tab) =>
    matchRoute({ to: tab.href, fuzzy: false })
  );
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : tabs[0];
  if (!activeTab) return null;
  const activeHref = activeTab.href;

  return (
    <>
      {/* Desktop tabs */}
      <nav className="hidden md:flex items-center gap-2 py-2">
        {tabs.map((tab) => {
          const isActive = matchRoute({ to: tab.href, fuzzy: false });

          return (
            <Link
              key={tab.href}
              to={tab.href}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-transparent text-muted-foreground hover:border-muted hover:text-foreground'
              )}
            >
              {tab.icon}
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {/* Mobile: Select dropdown */}
      <div className="md:hidden py-2">
        <Select
          value={activeHref}
          onValueChange={(value) => void navigate({ to: value })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tabs.map((tab) => (
              <SelectItem key={tab.href} value={tab.href}>
                {tab.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </>
  );
};
