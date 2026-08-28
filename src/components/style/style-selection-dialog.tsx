import { StyleSelectorButton } from '@/components/style/style-selector-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { StyleLibraryView } from '@/components/style-library/style-library-view';
import type { Style } from '@/types/database';
import type { FC, ReactNode } from 'react';
import { useState } from 'react';

/**
 * The composer's "browse all styles" dialog — the exact styles-page browse
 * experience (search, category chips that scroll, category-grouped sections,
 * click-to-open detail), except "Use this style" selects in place.
 */
const StyleBrowserContent: FC<{
  styles?: Style[];
  onUseStyle: (styleId: string) => void;
  selectedStyleId?: string | null;
}> = ({ styles, onUseStyle, selectedStyleId }) => (
  <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw] lg:max-w-[90vw] xl:max-w-[85vw]">
    <DialogHeader>
      <DialogTitle>Visual Style</DialogTitle>
      <DialogDescription>
        Choose the visual style of your sequence
      </DialogDescription>
    </DialogHeader>
    {/* overscroll-contain: reaching the list's end must not chain the touch
        gesture into scrolling the page behind the dialog. */}
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <StyleLibraryView
        styles={styles}
        onUseStyle={onUseStyle}
        initialStyleId={selectedStyleId}
      />
    </div>
  </DialogContent>
);

type StyleSelectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  styles?: Style[];
  onStyleSelect: (styleId: string) => void;
  /** Current pick — the dialog opens scrolled to its category section. */
  selectedStyleId?: string | null;
};

/** Controlled variant used by the composer's style selector. */
export const StyleSelectionDialog: FC<StyleSelectionDialogProps> = ({
  open,
  onOpenChange,
  styles,
  onStyleSelect,
  selectedStyleId,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <StyleBrowserContent
      styles={styles}
      onUseStyle={onStyleSelect}
      selectedStyleId={selectedStyleId}
    />
  </Dialog>
);

type StyleSelectionDialogWithTriggerProps = {
  styles?: Style[];
  selectedStyle?: Style | null;
  onStyleSelect: (styleId: string) => void;
  trigger?: ReactNode;
  buttonSize?: 'default' | 'sm' | 'lg';
};

/** Self-contained variant with its own trigger button. */
export const StyleSelectionDialogWithTrigger: FC<
  StyleSelectionDialogWithTriggerProps
> = ({ styles, selectedStyle, onStyleSelect, trigger, buttonSize }) => {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <StyleSelectorButton
            selectedStyle={selectedStyle}
            size={buttonSize}
          />
        )}
      </DialogTrigger>
      <StyleBrowserContent
        styles={styles}
        onUseStyle={(styleId) => {
          onStyleSelect(styleId);
          setOpen(false);
        }}
      />
    </Dialog>
  );
};
