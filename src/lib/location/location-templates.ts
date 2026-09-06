import type { LibraryLocation } from '@/lib/db/schema';
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

function getLocationPreviewUrl(name: string): string {
  return `https://${getPublicAssetsDomain()}/locations/${sanitizeName(name)}/thumbnail.webp`;
}

export function getLocationSheetUrl(name: string): string {
  return `https://${getPublicAssetsDomain()}/locations/${sanitizeName(name)}/sheet.webp`;
}

// Default location templates available to all teams. The `id` is a stable
// ULID — see DEFAULT_TALENT_TEMPLATES for the rationale.
export const DEFAULT_LOCATION_TEMPLATES: Array<
  Omit<LibraryLocation, 'teamId' | 'createdAt' | 'updatedAt' | 'createdBy'>
> = [
  {
    id: '01KRMKES6TQSNP3DQJ409B54YS',
    name: 'Rooftop Bar at Golden Hour',
    description:
      'Sleek outdoor lounge with panoramic city skyline views, warm string lights, lush greenery planters, and a glowing amber sky. Low modern seating, craft cocktails on marble tables. Aspirational and cinematic.',
    referenceImageUrl: getLocationPreviewUrl('Rooftop Bar at Golden Hour'),
    referenceImagePath: null,
    referenceInputHash: null,
    isPublic: true,
    isTemplate: true,
  },
  {
    id: '01KRMKES6T6EGHCYYGMDQWEGTN',
    name: 'Neon-Lit Tokyo Alley',
    description:
      'Narrow rain-slicked backstreet with stacked glowing signs in Japanese, steam rising from street food stalls, vending machine glow, and reflective puddles. Moody, electric, and endlessly atmospheric.',
    referenceImageUrl: getLocationPreviewUrl('Neon-Lit Tokyo Alley'),
    referenceImagePath: null,
    referenceInputHash: null,
    isPublic: true,
    isTemplate: true,
  },
  {
    id: '01KRMKES6TX2WRRR7QDVHEVF1Q',
    name: 'Sunlit Loft Studio',
    description:
      'Airy industrial loft with exposed brick, massive arched windows flooding warm natural light, a velvet couch, scattered art supplies, and hanging plants. Creative, intimate, and effortlessly photogenic.',
    referenceImageUrl: getLocationPreviewUrl('Sunlit Loft Studio'),
    referenceImagePath: null,
    referenceInputHash: null,
    isPublic: true,
    isTemplate: true,
  },
];

// System locations with timestamps for seeding
export const DEFAULT_SYSTEM_LOCATIONS: Array<
  Omit<LibraryLocation, 'teamId' | 'createdBy'>
> = DEFAULT_LOCATION_TEMPLATES.map((l) => ({
  ...l,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
