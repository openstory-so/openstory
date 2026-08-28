import { GitHubIcon } from '@/components/icons/github-icon';
import { XIcon } from '@/components/icons/x-icon';
import { YouTubeIcon } from '@/components/icons/youtube-icon';
import {
  OpenStoryIcon,
  OpenStoryLogo,
} from '@/components/icons/openstory-logo';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { FeedbackDialog } from '@/components/feedback/feedback-dialog';
import { useLowBalanceWarning } from '@/hooks/use-low-balance-warning';
import { MODELS_ENABLED } from '@/lib/flags';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { usePostHog } from '@posthog/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  BadgeDollarSign,
  Boxes,
  Clapperboard,
  Film,
  Images,
  LifeBuoy,
  Mail,
  MapPin,
  Palette,
  Plus,
  Users,
  Video,
} from 'lucide-react';
import { CreditBalancePill } from './credit-balance-pill';
import { UserSidebarFooter } from './user-sidebar-footer';

const navLinks = [
  { to: '/sequences', label: 'Sequences', icon: Video },
  { to: '/images', label: 'Images', icon: Images },
  { to: '/videos', label: 'Videos', icon: Film },
  ...(MODELS_ENABLED
    ? [{ to: '/models', label: 'Models', icon: Boxes } as const]
    : []),
  { to: '/styles', label: 'Styles', icon: Palette },
  { to: '/talent', label: 'Talent', icon: Users },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/gallery', label: 'Gallery', icon: Clapperboard },
] as const;

export function AppSidebar() {
  useLowBalanceWarning();

  const { isMobile, setOpenMobile } = useSidebar();
  const posthog = usePostHog();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          to="/"
          className="flex h-10 items-center px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <OpenStoryLogo
            size="md"
            className="group-data-[collapsible=icon]:hidden"
          />
          <OpenStoryIcon
            size="md"
            className="hidden group-data-[collapsible=icon]:block"
          />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="New sequence">
                  {/* `/` is the free composer for everyone (#1104); the
                      signed-in alias `/sequences/new` is for copy/breadcrumb
                      entry points that require a session. */}
                  <Link
                    to="/"
                    onClick={() =>
                      posthog.capture('make_another_clicked', {
                        surface: 'sidebar',
                      })
                    }
                  >
                    <Plus />
                    <span>New sequence</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {navLinks.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={label}>
                  <SidebarMenuButton asChild tooltip={label}>
                    <Link
                      to={to}
                      activeProps={{ 'data-active': 'true' }}
                      activeOptions={{ exact: false }}
                    >
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Guide">
              <Link to="/docs">
                <LifeBuoy />
                <span>Guide</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Pricing">
              <Link to="/pricing">
                <BadgeDollarSign />
                <span>Pricing</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip="Feedback"
              onClick={() => setFeedbackOpen(true)}
            >
              <Mail />
              <span>Feedback</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="GitHub">
              <a href={SITE_CONFIG.githubHref} target="_blank" rel="noreferrer">
                <GitHubIcon className="size-4" />
                <span>GitHub</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="YouTube">
              <a
                href={SITE_CONFIG.youtubeHref}
                target="_blank"
                rel="noreferrer"
              >
                <YouTubeIcon className="size-4" />
                <span>YouTube</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Follow OpenStory">
              <a href={SITE_CONFIG.xHref} target="_blank" rel="noreferrer">
                <XIcon className="size-4" />
                <span>Follow OpenStory</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        {/* Quiet status chip — not a nav peer of Sequences/Gallery (#1090). */}
        <CreditBalancePill />
        <SidebarMenu>
          <UserSidebarFooter />
        </SidebarMenu>
      </SidebarFooter>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </Sidebar>
  );
}
