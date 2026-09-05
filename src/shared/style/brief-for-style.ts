/**
 * Pure style-brief data + resolver (issue #718, extracted in #956).
 *
 * The one-liner brief that seeds a style's canonical sample is pure data — it
 * depends only on the style's name + category and the generated brief set. It
 * lives here, free of any DB-schema imports, so client code (the logged-out
 * sample-video showcase + gallery, which prefill the composer from a brief) can
 * import `briefForStyle` without dragging the Drizzle schema graph into the
 * browser bundle. `sample-videos.ts` re-exports these for the render/seed
 * scripts that already import them from there.
 */
import { GENERATED_STYLE_BRIEFS } from '@/shared/style/style-briefs.generated';
import { styleSlug } from '@/shared/style/style-slug';

/**
 * One-liner brief per style `category`, fed through the script-enhancer so each
 * style gets a script that suits it. Every category present in
 * `style-templates.ts` has an explicit entry (enforced by a unit test) — no
 * silent default that would render an off-brief sample.
 *
 * Every brief names a concrete subject AND an event — the first render round
 * proved that a subject-less brief ("a new product launch") enhances into the
 * same inert anticipation→reveal→logo mood piece for every style, and a
 * 15-second sample where nothing happens is a boring sample. Scenes become
 * motion clips, so the brief must describe visible motion.
 *
 * Every human subject is given an explicit gender and a short visual
 * descriptor. Neutral nouns ("a courier", "a dancer") made the enhancer
 * default to singular "they", which the image model rendered as androgynous
 * figures AND gave the character-bible nothing to lock identity onto across
 * cuts — the exact consistency #801 is about. The descriptor doubles as the
 * bible's anchor, so name what the person looks like, not just what they do.
 *
 * @public Exported for the invariant checks in `sample-videos.test.ts`, which
 * knip ignores; `briefForStyle` is its only in-app consumer.
 */
export const CATEGORY_BRIEFS: Record<string, string> = {
  commercial:
    'a premium brand spot: a woman in a flowing red dress sprints through a dark warehouse, bursts through a curtain of golden dust, and lands in slow motion as light floods the space',
  ecommerce:
    'a product launch where the product assembles itself mid-air — components fly in and snap together in slow motion, and the finished product drops onto the counter with a satisfying bounce',
  influencer:
    'an honest review spoken to camera: a young man with tousled hair unboxes the product, fumbles it in surprise at how light it is, catches it one-handed, and cracks up laughing',
  animatic:
    'a storyboard animatic of a heist gone sideways — a woman in a sharp black suit grabs the case, vaults a desk, and dives through closing elevator doors',
  animation:
    'a playful animated story: a small robot chases its runaway wheel downhill through a street market, bouncing off awnings, and catches it at the lip of a fountain',
  kids: 'a kids’ ad where a juice box rockets off the table, loops around the kitchen trailing rainbow fizz, and sticks the landing in a lunchbox just as it snaps shut',
  tech: 'a tech product reveal in motion — a woman engineer with cropped dark hair in a fitted grey tee lifts a brushed-aluminium device off a glowing pedestal; it spins open to float its internal components in mid-air, then snaps back together as she turns it to the camera',
  // Narrative film genres get per-style briefs in STYLE_BRIEF_OVERRIDES (a
  // shared "cinematic scene" brief enhanced into the same figure-standing-in-
  // rain mood piece for every genre — action had no action). This entry is
  // the guarded fallback for a future film style without an override.
  film: 'a cinematic scene where something decisive happens — a chase, a confrontation, or an escape; never a person standing still',
};

/**
 * Per-style brief overrides (keyed by style slug), consulted BEFORE the
 * generated per-style briefs (`style-briefs.generated.ts`) and the category
 * fallback. Two kinds of entry live here:
 *
 * 1. Creative-direction overrides that intentionally reshape the generated
 *    brief: `perfume-editorial` (sultry register), `product-ad` /
 *    `ugc-unboxing` (put a real on-camera person in frame, not faceless
 *    hands), `animated` (a physical poster, not a hologram), `beach-ritual`
 *    (a new style that has no generated brief yet).
 * 2. Single-shot review labels for styles whose real render is the verbatim
 *    `CANONICAL_SCRIPT_OVERRIDES` below (`mood-only-frames`, `360-turntable`,
 *    `restaurant-menu-hero`) — the entry here is only the review-tool BRIEF
 *    label, kept matching so it doesn't show the generated multi-cut text.
 *
 * `documentary` ships a full hand-written script via CANONICAL_SCRIPT_OVERRIDES
 * (`enhance: 'off'`), so it needs no brief here.
 *
 * @public Exported for the invariant checks in `sample-videos.test.ts`, which
 * knip ignores; `briefForStyle` is its only in-app consumer.
 */
export const STYLE_BRIEF_OVERRIDES: Record<string, string> = {
  // Creative-direction override: perfume advertising trades on allure, so the
  // generated "woman reaches into the haze" brief read too chaste. This pushes
  // the canonical render toward the sultry, sensual register the genre expects.
  'perfume-editorial':
    'A sultry high-fashion perfume film in warm, low-key light. A strikingly beautiful woman in a liquid-gold silk slip reclines against deep velvet, bare shoulders and collarbone glowing; she draws a faceted amber bottle slowly along the line of her neck, lips parted, eyes half-closed, as backlit mist drifts past — then turns a slow, smouldering look straight to camera while a sheer curtain billows behind her.',
  // Creative-direction override: the generated briefs for these two were
  // faceless "hands only" product shots — boring, and they never exercise the
  // character-consistency pipeline. Put a real on-camera woman (face visible,
  // recurring across all three scenes) front and centre.
  'product-ad':
    'A woman with sleek dark hair and a cream linen shirt unscrews a frosted-glass serum bottle on a sunlit bathroom shelf, dispenses a glossy drop onto her fingertip, and presses it across her cheek as warm late-afternoon light catches the dewy texture.',
  'ugc-unboxing':
    'A bubbly young woman with a messy bun and chipped pink nails films herself on her phone, grinning to camera as she tears open a cardboard box, peels back tissue paper, and lifts out a sleek skincare bottle to show it off.',
  // The generated brief asked for a "holographic wanted-poster", which fights
  // the visual-prompt generator's hard NO-HOLOGRAPHIC-SCREENS rule and rendered
  // as a blank blue rift. Use a physical paper poster instead.
  animated:
    'A grizzled male bounty hunter in a tattered crimson coat strides through a rain-slicked neon alley, then halts before a weathered paper wanted-poster nailed to a wall, recognition crossing his scarred face as its torn edges lift in the wind.',
  // New style (no generated brief yet): pin the generate-style-briefs.ts output
  // here so it renders on-brief instead of falling back to the off-style
  // commercial category brief. Regenerate the full set to retire this.
  'beach-ritual':
    'A tanned woman with sun-bleached wavy hair in a coral swimsuit wades out of the turquoise surf at golden hour, pushing her wet hair back and laughing as she lifts a frosty bottle from the wet sand, the handheld camera tracking her toward weathered timber with lens flares dancing.',
  // Single-shot review labels — the verbatim render lives in
  // CANONICAL_SCRIPT_OVERRIDES; kept matching so the review BRIEF isn't the
  // generated multi-cut text.
  'mood-only-frames':
    'a single continuous mood frame in one charcoal-and-amber palette — incense smoke curls up through a hard diagonal shaft of light as it slowly intensifies, one unbroken locked shot, no scene change',
  '360-turntable':
    'a single continuous 360 turntable pass — one pair of premium wireless earbuds in an open charging case makes one unbroken slow revolution on a seamless white pedestal, the same case throughout, no cuts',
  'restaurant-menu-hero':
    'a single continuous signature-dish hero — one unbroken overhead shot as a ladle pours glossy amber jus across a plated sliced duck breast and a hand lowers a final micro-herb garnish, the same dish throughout, no cuts',
};

/**
 * The brief used to enhance a style's canonical script. Per-style override
 * first, then the generated per-style brief, then the category brief. Throws on
 * an unmapped category.
 */
export function briefForStyle(style: {
  name: string;
  category: string | null;
}): string {
  const slug = styleSlug(style.name);
  // Hand-written overrides (film genres + the single-shot product fixes) win.
  const override = STYLE_BRIEF_OVERRIDES[slug];
  if (override) return override;
  // Then the per-style brief derived from this style's OWN description+config
  // (generate-style-briefs.ts) — replaces the too-coarse category bucket that
  // gave e.g. the "Car Talk" driving-monologue style a product-unboxing brief.
  const generated = GENERATED_STYLE_BRIEFS[slug];
  if (generated) return generated;
  // Category brief is the last-resort fallback (only hit by a new style not yet
  // in the generated set).
  const brief = style.category ? CATEGORY_BRIEFS[style.category] : undefined;
  if (!brief) {
    throw new Error(
      `No canonical brief for category "${style.category}". Add it to CATEGORY_BRIEFS.`
    );
  }
  return brief;
}
