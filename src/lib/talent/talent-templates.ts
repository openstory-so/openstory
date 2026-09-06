import type { Talent } from '@/lib/db/schema';
import { getPublicAssetsDomain } from '@/lib/storage/public-assets';

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getTalentPreviewUrl(name: string): string {
  return `https://${getPublicAssetsDomain()}/talent/${sanitizeName(name)}/thumbnail.webp`;
}

export function getTalentSheetUrl(name: string): string {
  return `https://${getPublicAssetsDomain()}/talent/${sanitizeName(name)}/sheet.webp`;
}

// Default talent templates available to all teams. The `id` is a stable ULID
// so re-seeding (esp. test.db) produces the same primary key every time —
// recorded e2e fixtures embed these IDs in LLM responses, and the talent-
// matching workflow looks up by id, so drift would break replay. Existing
// rows in seeded production DBs keep their original random IDs because
// scripts/seed.ts matches by name and UPDATEs without touching `id`.
export const DEFAULT_TALENT_TEMPLATES: Array<
  Omit<Talent, 'teamId' | 'createdAt' | 'updatedAt' | 'createdBy'>
> = [
  {
    id: '01KRMKES6TWAEC44S2S8PXZBM8',
    name: 'Sienna Blake',
    description:
      'Golden blonde, beach-tanned skin, effortless Bondi energy. Wide smile, freckles across the nose, the kind of face that sells skincare without trying. Perfect for product ads, lifestyle campaigns, and rom-com leads.',
    isHuman: true,
    isFavorite: false,
    isInTeamLibrary: false,
    isPublic: true,
    isTemplate: true,
    imageUrl: getTalentPreviewUrl('Sienna Blake'),
    imagePath: null,
  },
  {
    id: '01KRMKES6T70N08WV09TCZFGEN',
    name: 'Jude Calloway',
    description:
      'Dark features, strong brow, salt-wind-tousled hair. Ruggedly photogenic with an easy grin. Equally at home in a real estate walkthrough, a whiskey ad, or an action sequence on a rooftop.',
    isHuman: true,
    isFavorite: false,
    isInTeamLibrary: false,
    isPublic: true,
    isTemplate: true,
    imageUrl: getTalentPreviewUrl('Jude Calloway'),
    imagePath: null,
  },
  {
    id: '01KRMKES6T2BZJ04SKRKNTB8RX',
    name: 'Rani Sharma',
    description:
      'Deep brown eyes, sleek black hair, razor-sharp cheekbones. Elegant intensity with a warmth underneath. Born for corporate power plays, award-season drama, and luxury brand spots.',
    isHuman: true,
    isFavorite: false,
    isInTeamLibrary: false,
    isPublic: true,
    isTemplate: true,
    imageUrl: getTalentPreviewUrl('Rani Sharma'),
    imagePath: null,
  },
];

// System talent with timestamps for seeding
export const DEFAULT_SYSTEM_TALENT: Array<
  Omit<Talent, 'teamId' | 'createdBy'>
> = DEFAULT_TALENT_TEMPLATES.map((t) => ({
  ...t,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
