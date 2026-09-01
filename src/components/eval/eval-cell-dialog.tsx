import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { VideoPlayer } from '@/components/motion/video-player';
import { buildMentionItems } from '@/components/scenes/prompt-mention/mention-items';
import { HighlightedPrompt } from '@/components/text-editor/mention/highlighted-prompt';
import { useSequenceCharacters } from '@/hooks/use-sequence-characters';
import { useSequenceElements } from '@/hooks/use-sequence-elements';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import type { SceneWithScript } from '@/hooks/use-scenes';
import type { ShotView } from '@/lib/shots/shot-view';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { stripMarkdown } from '@/lib/utils/markdown-plain';
import { Clapperboard, FileTextIcon, ImageIcon, TextIcon } from 'lucide-react';
import { AppImage } from '@/components/ui/app-image';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  getMotionPrompt,
  getSceneScript,
  getVisualPrompt,
} from './eval-scene-cell';
import type { ViewMode } from './eval-view';

export type DialogTab = ViewMode;

function isDialogTab(value: string): value is DialogTab {
  return (
    value === 'script' ||
    value === 'prompts' ||
    value === 'images' ||
    value === 'motion'
  );
}

const DIALOG_TABS = [
  { value: 'script', label: 'Script' },
  { value: 'prompts', label: 'Prompts' },
  { value: 'images', label: 'Image' },
  { value: 'motion', label: 'Motion' },
] as const;

type EvalCellDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shot: ShotView;
  scene?: SceneWithScript | undefined;
  sceneNumber: number;
  sequenceTitle: string;
  aspectRatio: AspectRatio;
  initialTab: DialogTab;
  onNavigateLeft?: () => void;
  onNavigateRight?: () => void;
  onNavigateUp?: () => void;
  onNavigateDown?: () => void;
};

export const EvalCellDialog: React.FC<EvalCellDialogProps> = ({
  open,
  onOpenChange,
  shot,
  scene,
  sceneNumber,
  sequenceTitle,
  aspectRatio,
  initialTab,
  onNavigateLeft,
  onNavigateRight,
  onNavigateUp,
  onNavigateDown,
}) => {
  const prompt = getVisualPrompt(shot);
  const motionPrompt = getMotionPrompt(shot);
  const script = getSceneScript(scene);
  const [selectedTab, setSelectedTab] = useState<DialogTab>(initialTab);

  // Mention pills for the prompt text. Gated on `open` so the lists are only
  // fetched for the dialog the user actually opened — each grid cell mounts its
  // own dialog, so unconditional fetching would hit every sequence at once.
  const seqId = open ? shot.sequenceId : undefined;
  const { data: mentionElements } = useSequenceElements(seqId);
  const { data: mentionCharacters } = useSequenceCharacters(seqId ?? '');
  const { data: mentionLocations } = useSequenceLocations(seqId ?? '');
  const mentionItems = useMemo(
    () =>
      buildMentionItems({
        characters: mentionCharacters ?? [],
        elements: mentionElements ?? [],
        locations: mentionLocations ?? [],
      }),
    [mentionCharacters, mentionElements, mentionLocations]
  );

  // Handle keyboard navigation
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't navigate if user is typing in an input/textarea
      if (!(e.target instanceof HTMLElement)) return;
      const target = e.target;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          e.stopPropagation();
          onNavigateLeft?.();
          break;
        case 'ArrowRight':
          e.preventDefault();
          e.stopPropagation();
          onNavigateRight?.();
          break;
        case 'ArrowUp':
          e.preventDefault();
          e.stopPropagation();
          onNavigateUp?.();
          break;
        case 'ArrowDown':
          e.preventDefault();
          e.stopPropagation();
          onNavigateDown?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown, true); // Use capture phase
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [open, onNavigateLeft, onNavigateRight, onNavigateUp, onNavigateDown]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-1rem)]! sm:max-w-[80vw]! max-h-[80vh] w-full h-full flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {sequenceTitle} - Scene {sceneNumber}
          </DialogTitle>
          <DialogDescription>
            View scene details, prompts, and generated images.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={selectedTab}
          onValueChange={(value) => {
            if (isDialogTab(value)) setSelectedTab(value);
          }}
          className="w-full flex-1 flex flex-col min-h-0"
        >
          {/* Mobile: Select dropdown */}
          <div className="sm:hidden mb-4">
            <Select
              value={selectedTab}
              items={DIALOG_TABS}
              onValueChange={(value) => {
                if (value && isDialogTab(value)) setSelectedTab(value);
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIALOG_TABS.map((tab) => (
                  <SelectItem key={tab.value} value={tab.value}>
                    {tab.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Desktop: Tab buttons */}
          <div className="hidden sm:flex justify-center mb-4">
            <TabsList
              onKeyDown={(e) => {
                // Prevent tabs from handling arrow keys - we use them for cell navigation
                if (
                  e.key === 'ArrowLeft' ||
                  e.key === 'ArrowRight' ||
                  e.key === 'ArrowUp' ||
                  e.key === 'ArrowDown'
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                }
              }}
            >
              <TabsTrigger value="script">
                <FileTextIcon className="h-4 w-4 mr-2" />
                Script
              </TabsTrigger>
              <TabsTrigger value="prompts">
                <TextIcon className="h-4 w-4 mr-2" />
                Prompts
              </TabsTrigger>
              <TabsTrigger value="images">
                <ImageIcon className="h-4 w-4 mr-2" />
                Image
              </TabsTrigger>
              <TabsTrigger value="motion">
                <Clapperboard className="h-4 w-4 mr-2" />
                Motion
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="script" className="flex-1 min-h-0 mt-0">
            {!script ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No script available
              </div>
            ) : (
              <ScrollArea className="h-full">
                <p className="text-sm leading-relaxed whitespace-pre-wrap">
                  {stripMarkdown(script)}
                </p>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="prompts" className="flex-1 min-h-0 mt-0">
            {!prompt && !motionPrompt ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No prompts available
              </div>
            ) : (
              <ScrollArea className="h-full">
                {prompt && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      Visual
                    </p>
                    <HighlightedPrompt
                      text={prompt}
                      items={mentionItems}
                      className="text-sm leading-relaxed"
                    />
                  </div>
                )}
                {prompt && motionPrompt && <hr className="my-3 border-muted" />}
                {motionPrompt && (
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1">
                      Motion
                    </p>
                    <HighlightedPrompt
                      text={motionPrompt}
                      items={mentionItems}
                      className="text-sm leading-relaxed"
                    />
                  </div>
                )}
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="images" className="flex-1 min-h-0 mt-0">
            {!shot.image?.url ? (
              <div className="flex items-center justify-center h-full text-muted-foreground">
                No image available
              </div>
            ) : (
              <div className="flex justify-center items-center h-full">
                <AppImage
                  src={shot.image.url}
                  alt={`Scene ${sceneNumber}`}
                  className="max-w-full max-h-full object-contain rounded-lg"
                  width={1000}
                  height={1000}
                />
              </div>
            )}
          </TabsContent>

          <TabsContent value="motion" className="flex-1 min-h-0 mt-0">
            {!shot.video?.url ? (
              shot.image?.url ? (
                <div className="flex justify-center items-center h-full w-full">
                  <div className="relative w-full max-w-4xl">
                    <AppImage
                      src={shot.image.url}
                      alt={`Scene ${sceneNumber} preview`}
                      className="w-full h-auto object-contain rounded-lg opacity-60"
                      width={1920}
                      height={1080}
                    />
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="text-sm font-medium text-foreground bg-background/85 backdrop-blur-sm px-3 py-1.5 rounded-md border">
                        {shot.videoStatus === 'generating'
                          ? 'Generating video…'
                          : 'No video yet'}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground">
                  No video available
                </div>
              )
            ) : (
              <div className="flex justify-center items-center h-full w-full">
                <div className="w-full max-w-4xl">
                  <VideoPlayer
                    src={shot.video.url}
                    posterSrc={shot.image?.url}
                    aspectRatio={aspectRatio}
                    className="rounded-lg"
                    playSource="modal"
                    sequenceId={shot.sequenceId}
                    shotId={shot.id}
                  />
                </div>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
};
