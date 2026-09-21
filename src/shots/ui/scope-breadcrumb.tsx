import { plainSceneTitle } from '@/platform/markdown-plain';
import type { ShotView } from '@/shots/shot-view';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from '@/ui/shadcn/breadcrumb';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/shadcn/dropdown-menu';
import { Link } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { Fragment } from 'react';
import type { SceneSelection } from './scene-selection';
import type { SceneWithScript } from './use-scenes';

type Crumb = { label: string; search: { scenes?: string; shot?: string } };

const crumbKey = (crumb: Crumb) =>
  crumb.search.shot ?? crumb.search.scenes ?? 'sequence';

const sceneLabel = (scene: SceneWithScript) =>
  plainSceneTitle(scene.title) || `Scene ${scene.orderIndex + 1}`;

const shotLabel = (shot: ShotView, siblings: ShotView[]) =>
  `Shot ${shot.shotNumber ?? siblings.indexOf(shot) + 1}`;

/**
 * Inspector header (#1713): Sequence › Scene › Shot. A crumb walks up; the last
 * crumb's menu walks down (scenes of the sequence, shots of the scene — a shot
 * has no children, so its menu lists its siblings). Every crumb is a link that
 * only rewrites the selection params, so the `facet` tab rides along and
 * `resolveTab` lands on the same tab wherever the new level has it.
 */
export const ScopeBreadcrumb: React.FC<{
  selection: SceneSelection;
  scenes?: SceneWithScript[];
  shots?: ShotView[];
}> = ({ selection, scenes = [], shots = [] }) => {
  const shot = shots.find((s) => s.id === selection.shotId);
  const sceneIds = shot?.sceneId ? [shot.sceneId] : selection.sceneIds;
  const selectedScenes = scenes.filter((s) => sceneIds.includes(s.id));
  const sceneShots = shots.filter(
    (s) => s.sceneId != null && sceneIds.includes(s.sceneId)
  );

  const trail: Crumb[] = [{ label: 'Sequence', search: {} }];
  if (selectedScenes.length > 0) {
    trail.push({
      label:
        selectedScenes.length === 1 && selectedScenes[0]
          ? sceneLabel(selectedScenes[0])
          : `${selectedScenes.length} scenes`,
      search: { scenes: sceneIds.join(',') },
    });
  }
  if (shot) {
    trail.push({
      label: shotLabel(shot, sceneShots),
      search: { shot: shot.id },
    });
  }

  const menu: Crumb[] =
    trail.length === 1
      ? scenes.map((s) => ({ label: sceneLabel(s), search: { scenes: s.id } }))
      : sceneShots.map((s) => ({
          label: shotLabel(s, sceneShots),
          search: { shot: s.id },
        }));
  // A lone shot's sibling menu would list only itself.
  const showMenu = menu.length > (shot ? 1 : 0);
  const menuLabel = trail.length === 1 ? 'Scenes' : 'Shots';
  const current = trail[trail.length - 1];

  const crumbLink = (crumb: Crumb, className?: string) => (
    <Link
      from="/sequences/$id/scenes"
      search={(prev) => ({
        ...prev,
        scenes: crumb.search.scenes,
        shot: crumb.search.shot,
      })}
      title={crumb.label}
      className={className}
    >
      {crumb.label}
    </Link>
  );

  return (
    <Breadcrumb aria-label="Selection" className="min-w-0 flex-1">
      <BreadcrumbList className="flex-nowrap gap-1 text-xs font-semibold sm:gap-1">
        {trail.slice(0, -1).map((crumb, i) => (
          <Fragment key={crumbKey(crumb)}>
            {/* The scene title is the long one, so it alone gives way — before
                the active crumb does. */}
            <BreadcrumbItem className={i === 0 ? 'shrink-0' : 'min-w-0'}>
              <BreadcrumbLink asChild>
                {crumbLink(
                  crumb,
                  'truncate rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring'
                )}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </Fragment>
        ))}
        {/* "Shot N" never truncates; an active scene title still has to. */}
        <BreadcrumbItem className={shot ? 'shrink-0' : 'min-w-0'}>
          {!showMenu ? (
            <span aria-current="page" className="truncate text-foreground">
              {current?.label}
            </span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label={`${current?.label} — ${menuLabel}`}
                className="flex min-h-6 min-w-0 items-center gap-0.5 rounded-sm text-foreground outline-none hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span aria-current="page" className="truncate">
                  {current?.label}
                </span>
                <ChevronDown className="size-3.5 shrink-0" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-80 max-w-64">
                {menu.map((crumb) => (
                  <DropdownMenuItem key={crumbKey(crumb)} asChild>
                    {crumbLink(crumb)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
};
