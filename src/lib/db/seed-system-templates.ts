/**
 * System-template seeding, shared between the CLI (scripts/seed.ts) and the
 * worker runtime (src/server.ts).
 *
 * The sync is idempotent: templates are matched by name within the system
 * team, updated in place, and inserted when missing. A SHA-256 hash of the
 * template definitions is stored in `app_metadata` after a successful sync,
 * so `ensureSystemTemplatesSeeded` is a single SELECT when nothing changed —
 * cheap enough to run on worker cold start. This replaces the CI seed steps:
 * a fresh deployment (e.g. via the Deploy to Cloudflare button) seeds itself
 * on first request, and template edits roll out with the deploy that
 * contains them.
 */

import { and, eq } from 'drizzle-orm';
import type { drizzle as drizzleD1 } from 'drizzle-orm/d1';
import type { Database } from './client';
import {
  DEFAULT_SYSTEM_LOCATIONS,
  getLocationSheetUrl,
} from '@/lib/location/location-templates';
import { DEFAULT_SYSTEM_STYLES } from '@/lib/style/style-templates';
import {
  DEFAULT_SYSTEM_TALENT,
  getTalentSheetUrl,
} from '@/lib/talent/talent-templates';
import type { createD1HttpClient } from './client-d1-http';
import { generateId } from '@/shared/id';
import {
  appMetadata,
  locationLibrary,
  locationSheets,
  styles,
  talent,
  talentSheets,
  teams,
} from './schema';

export type SeedDb =
  | ReturnType<typeof drizzleD1>
  | ReturnType<typeof createD1HttpClient>
  | Database;

type SeedLog = (message: string) => void;

const SYSTEM_TEAM_SLUG = 'system-templates';
const SEED_HASH_KEY = 'system-templates-seed-hash';
const SEED_LOCK_KEY = 'system-templates-seed-lock';

// Old name → new name mappings for renamed templates
const RENAMES: Record<string, string> = {
  'Cinematic Drama': 'Award Season',
  'Documentary Realism': 'Documentary',
  'Action Blockbuster': 'Action',
  'Romantic Comedy': 'Rom-Com',
  'Animation Studio': 'Animated',
  'Wes Anderson Style': 'Pastel',
  'Lo-Fi iPhone 7 Aesthetic (Clean)': 'Lo-Fi Retro',
  YouTube: 'Animatic',
};

/**
 * Hash of everything that feeds the sync. Includes the public-assets domain
 * because sheet/preview URLs are derived from it at seed time.
 */
async function computeSeedHash(): Promise<string> {
  const payload = JSON.stringify(
    {
      styles: DEFAULT_SYSTEM_STYLES,
      talent: DEFAULT_SYSTEM_TALENT,
      locations: DEFAULT_SYSTEM_LOCATIONS,
      renames: RENAMES,
      assetsDomain: import.meta.env.VITE_R2_PUBLIC_ASSETS_DOMAIN ?? '',
    },
    // The template modules stamp createdAt/updatedAt with `new Date()` at
    // module load, which would make the hash differ on every process start
    // (and re-trigger a full sync per isolate). The sync sets its own
    // timestamps, so they carry no signal — drop them.
    (key, value) =>
      key === 'createdAt' || key === 'updatedAt' ? undefined : value
  );
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * After a template-changing deploy the hash goes stale in every colo at
 * once, so multiple isolates can reach the sync concurrently. Updates race
 * safely (by-name, idempotent) but brand-new templates have no unique index
 * on (teamId, name), so two racing inserts would duplicate. The lock row
 * makes exactly one isolate run the sync; losers skip and serve with the
 * previous templates until it lands. Stale locks (isolate died mid-sync)
 * are stolen after this TTL.
 */
const SEED_LOCK_TTL_MS = 10 * 60 * 1000;

/**
 * Acquire the seed lock via D1's single-writer consistency: INSERT … ON
 * CONFLICT DO NOTHING, then read back who won. A stale holder is stolen
 * with a compare-and-swap UPDATE on its observed value.
 */
async function acquireSeedLock(db: SeedDb): Promise<string | null> {
  const token = generateId();
  await db
    .insert(appMetadata)
    .values({ key: SEED_LOCK_KEY, value: token, updatedAt: new Date() })
    .onConflictDoNothing();

  const [lock] = await db
    .select()
    .from(appMetadata)
    .where(eq(appMetadata.key, SEED_LOCK_KEY));
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB query returns undefined when no rows match
  if (!lock) return null;
  if (lock.value === token) return token;

  if (lock.updatedAt.getTime() > Date.now() - SEED_LOCK_TTL_MS) return null;

  // Stale — steal with a CAS on the value we observed. If a rival steals
  // first, our WHERE matches zero rows and the re-read sees their token.
  await db
    .update(appMetadata)
    .set({ value: token, updatedAt: new Date() })
    .where(
      and(eq(appMetadata.key, SEED_LOCK_KEY), eq(appMetadata.value, lock.value))
    );
  const [stolen] = await db
    .select()
    .from(appMetadata)
    .where(eq(appMetadata.key, SEED_LOCK_KEY));
  return stolen?.value === token ? token : null;
}

async function releaseSeedLock(db: SeedDb, token: string): Promise<void> {
  await db
    .delete(appMetadata)
    .where(
      and(eq(appMetadata.key, SEED_LOCK_KEY), eq(appMetadata.value, token))
    );
}

/**
 * Run the template sync only when the stored seed hash differs from the
 * current template definitions, and only in one isolate at a time (see
 * acquireSeedLock). Lock losers return without seeding — that's safe, since
 * the winner writes to the shared database and templates are read from it
 * at request time; no isolate-local state depends on having run the sync.
 *
 * `force` skips the hash gate (but still takes the lock): the manual CLI
 * path (`bun scripts/seed.ts --force`) uses it to restore template rows
 * that were lost while the hash row survived — without it the "escape
 * hatch" would no-op exactly when it's needed.
 */
export async function ensureSystemTemplatesSeeded(
  db: SeedDb,
  log: SeedLog = () => {},
  options: { force?: boolean } = {}
): Promise<void> {
  const currentHash = await computeSeedHash();
  const [stored] = await db
    .select()
    .from(appMetadata)
    .where(eq(appMetadata.key, SEED_HASH_KEY));

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB query returns undefined when no rows match
  if (!options.force && stored?.value === currentHash) {
    log('System templates up to date (seed hash match)');
    return;
  }

  const lockToken = await acquireSeedLock(db);
  if (lockToken === null) {
    log('System template sync already running elsewhere — skipping');
    return;
  }

  try {
    await syncSystemTemplates(db, log);

    await db
      .insert(appMetadata)
      .values({ key: SEED_HASH_KEY, value: currentHash, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: appMetadata.key,
        set: { value: currentHash, updatedAt: new Date() },
      });
  } finally {
    // The lock has a TTL steal as its designed recovery, so a failed release
    // must not mask the sync's outcome (a throw here would replace the real
    // error — or turn a fully successful seed into a reported failure).
    try {
      await releaseSeedLock(db, lockToken);
    } catch {
      log('Seed lock release failed — a stale lock will be stolen after TTL');
    }
  }
}

/** Unconditional template sync (no hash gate). */
async function syncSystemTemplates(
  db: SeedDb,
  log: SeedLog = () => {}
): Promise<void> {
  // 1. Find or create system team
  let [systemTeam]: { id: string }[] = await db
    .select()
    .from(teams)
    .where(eq(teams.slug, SYSTEM_TEAM_SLUG));

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB query returns undefined when no rows match
  if (!systemTeam) {
    const teamId = generateId();
    await db.insert(teams).values({
      id: teamId,
      name: 'System Templates',
      slug: SYSTEM_TEAM_SLUG,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    systemTeam = { id: teamId };
    log(`System team created with ID: ${systemTeam.id}`);
  }

  // 2. Rename old template styles
  const existingTemplates = await db
    .select()
    .from(styles)
    .where(eq(styles.teamId, systemTeam.id));

  const existingByName = new Map(existingTemplates.map((t) => [t.name, t]));

  for (const [oldName, newName] of Object.entries(RENAMES)) {
    const existing = existingByName.get(oldName);
    if (existing && !existingByName.has(newName)) {
      await db
        .update(styles)
        .set({ name: newName, updatedAt: new Date() })
        .where(eq(styles.id, existing.id));
      existingByName.set(newName, { ...existing, name: newName });
      existingByName.delete(oldName);
      log(`Renamed style "${oldName}" → "${newName}"`);
    }
  }

  // 3. Update existing templates and insert new ones
  let insertedCount = 0;
  let updatedCount = 0;

  for (const template of DEFAULT_SYSTEM_STYLES) {
    const existing = existingByName.get(template.name);

    if (existing) {
      // Update all fields on existing template.
      // NOTE: sampleVideos is intentionally excluded — it's seeded
      // separately (scripts/seed-style-sample-videos.ts) and the template
      // mapper hardcodes it to [], so syncing it here would wipe seeded
      // sample videos.
      await db
        .update(styles)
        .set({
          description: template.description,
          category: template.category,
          tags: template.tags,
          config: template.config,
          isPublic: template.isPublic,
          isTemplate: template.isTemplate,
          previewUrl: template.previewUrl,
          sortOrder: template.sortOrder,
          recommendedImageModel: template.recommendedImageModel,
          recommendedVideoModel: template.recommendedVideoModel,
          defaultAspectRatio: template.defaultAspectRatio,
          useCases: template.useCases,
          updatedAt: new Date(),
        })
        .where(eq(styles.id, existing.id));
      updatedCount++;
    } else {
      await db.insert(styles).values({
        ...template,
        teamId: systemTeam.id,
        createdBy: null,
      });
      insertedCount++;
      log(`+ style ${template.name}`);
    }
  }

  log(`Synced templates: ${updatedCount} updated, ${insertedCount} inserted`);

  // 4. Sync system talent
  const existingTalent = await db
    .select()
    .from(talent)
    .where(eq(talent.teamId, systemTeam.id));

  const existingTalentByName = new Map(existingTalent.map((t) => [t.name, t]));
  let talentInserted = 0;
  let talentUpdated = 0;

  for (const template of DEFAULT_SYSTEM_TALENT) {
    const existing = existingTalentByName.get(template.name);

    if (existing) {
      await db
        .update(talent)
        .set({
          description: template.description,
          isPublic: template.isPublic,
          isTemplate: template.isTemplate,
          isHuman: template.isHuman,
          imageUrl: template.imageUrl,
          updatedAt: new Date(),
        })
        .where(eq(talent.id, existing.id));
      talentUpdated++;
    } else {
      await db.insert(talent).values({
        ...template,
        teamId: systemTeam.id,
        createdBy: null,
      });
      talentInserted++;
      log(`+ talent ${template.name}`);
    }
  }

  log(`Synced talent: ${talentUpdated} updated, ${talentInserted} inserted`);

  // 4b. Sync system talent sheets
  const allSystemTalent = await db
    .select()
    .from(talent)
    .where(eq(talent.teamId, systemTeam.id));

  let talentSheetsInserted = 0;

  for (const template of DEFAULT_SYSTEM_TALENT) {
    const talentRecord = allSystemTalent.find((t) => t.name === template.name);
    if (!talentRecord) continue;

    // Check if a default sheet already exists
    const existingSheets = await db
      .select()
      .from(talentSheets)
      .where(
        and(
          eq(talentSheets.talentId, talentRecord.id),
          eq(talentSheets.isDefault, true)
        )
      );

    if (existingSheets.length > 0) continue;

    await db.insert(talentSheets).values({
      id: generateId(),
      talentId: talentRecord.id,
      name: 'Default',
      imageUrl: getTalentSheetUrl(template.name),
      imagePath: `talent/${template.name.toLowerCase().replace(/\s+/g, '-')}/sheet.webp`,
      isDefault: true,
      source: 'ai_generated',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    talentSheetsInserted++;
    log(`+ talent sheet ${template.name}`);
  }

  log(`Synced talent sheets: ${talentSheetsInserted} inserted`);

  // 5. Sync system locations
  const existingLocations = await db
    .select()
    .from(locationLibrary)
    .where(eq(locationLibrary.teamId, systemTeam.id));

  const existingLocationsByName = new Map(
    existingLocations.map((l) => [l.name, l])
  );
  let locationsInserted = 0;
  let locationsUpdated = 0;

  for (const template of DEFAULT_SYSTEM_LOCATIONS) {
    const existing = existingLocationsByName.get(template.name);

    if (existing) {
      await db
        .update(locationLibrary)
        .set({
          description: template.description,
          isPublic: template.isPublic,
          isTemplate: template.isTemplate,
          referenceImageUrl: template.referenceImageUrl,
          updatedAt: new Date(),
        })
        .where(eq(locationLibrary.id, existing.id));
      locationsUpdated++;
    } else {
      await db.insert(locationLibrary).values({
        ...template,
        teamId: systemTeam.id,
        createdBy: null,
      });
      locationsInserted++;
      log(`+ location ${template.name}`);
    }
  }

  log(
    `Synced locations: ${locationsUpdated} updated, ${locationsInserted} inserted`
  );

  // 5b. Sync system location sheets
  const allSystemLocations = await db
    .select()
    .from(locationLibrary)
    .where(eq(locationLibrary.teamId, systemTeam.id));

  let locationSheetsInserted = 0;

  for (const template of DEFAULT_SYSTEM_LOCATIONS) {
    const locationRecord = allSystemLocations.find(
      (l) => l.name === template.name
    );
    if (!locationRecord) continue;

    // Check if a default sheet already exists
    const existingSheets = await db
      .select()
      .from(locationSheets)
      .where(
        and(
          eq(locationSheets.locationId, locationRecord.id),
          eq(locationSheets.isDefault, true)
        )
      );

    if (existingSheets.length > 0) continue;

    await db.insert(locationSheets).values({
      id: generateId(),
      locationId: locationRecord.id,
      name: 'Default',
      imageUrl: getLocationSheetUrl(template.name),
      imagePath: `locations/${template.name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')}/sheet.webp`,
      isDefault: true,
      source: 'ai_generated',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    locationSheetsInserted++;
    log(`+ location sheet ${template.name}`);
  }

  log(`Synced location sheets: ${locationSheetsInserted} inserted`);
}
