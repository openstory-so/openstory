import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { SECTION_ORDER } from '@/components/docs/sections';
import { Link, useRouterState } from '@tanstack/react-router';
import { allDocs } from 'content-collections';

type NavItem = { slug: string; title: string };

// Pages that live as routes (not content-collections markdown) but belong in
// the docs nav. The FAQ renders from FAQ_ITEMS so it stays in sync with
// llms.txt.
const EXTRA_NAV_ITEMS: Record<string, NavItem[]> = {
  Support: [{ slug: 'faq', title: 'FAQ' }],
};

function buildNavTree() {
  const grouped = new Map<string, typeof allDocs>();

  for (const doc of allDocs) {
    const existing = grouped.get(doc.section);
    if (existing) {
      existing.push(doc);
    } else {
      grouped.set(doc.section, [doc]);
    }
  }

  for (const items of grouped.values()) {
    items.sort((a, b) => a.order - b.order);
  }

  return SECTION_ORDER.reduce<{ section: string; items: NavItem[] }[]>(
    (acc, section) => {
      const docs = grouped.get(section) ?? [];
      const items = [
        ...docs.map(({ slug, title }) => ({ slug, title })),
        ...(EXTRA_NAV_ITEMS[section] ?? []),
      ];
      if (items.length > 0) {
        acc.push({ section, items });
      }
      return acc;
    },
    []
  );
}

const navTree = buildNavTree();

export const DocsSidebar: React.FC = () => {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <>
      {navTree.map(({ section, items }) => (
        <SidebarGroup key={section}>
          <SidebarGroupLabel>{section}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((doc) => {
                const href = `/docs/${doc.slug}`;
                const isActive =
                  currentPath === href || currentPath === `${href}/`;

                return (
                  <SidebarMenuItem key={doc.slug}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      tooltip={doc.title}
                    >
                      <Link to={href}>
                        <span>{doc.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      ))}
    </>
  );
};
