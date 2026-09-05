/**
 * Sample-video catalogue data (issue #718).
 *
 * Pure data + URL/entry builders shared by the render script
 * (`scripts/generate-style-sample-videos.ts`) and the seed
 * (`scripts/seed-style-sample-videos.ts`). Deliberately free of heavy imports
 * so the seed and unit tests stay lightweight.
 *
 * Every style gets a CANONICAL sample: a per-category one-liner brief (below)
 * is enhanced server-side by the platform's script-enhancer, so each style
 * gets a style-appropriate ~15s script (same brief within a category ⇒
 * comparable). The ~10 hero styles in BESPOKE_SCRIPTS also get a bespoke
 * sample, from a curated script tuned to show the style off. All samples
 * render through the real OpenStory pipeline (`POST /api/v1/sequences`) so
 * recurring people/characters stay consistent across shots.
 */
import {
  StyleSampleVideoSchema,
  type StyleSampleVideo,
} from '@/lib/db/schema/libraries';
import { styleSlug } from '@/shared/style/style-slug';

// Brief data + resolver moved to a schema-free module (#956) so client code can
// import `briefForStyle` without pulling the Drizzle schema into the browser
// bundle. Re-exported here for the render/seed scripts that import it from this
// module. (The brief constant maps live in `brief-for-style.ts`.)
export { briefForStyle } from '@/shared/style/brief-for-style';

/** A single curated shot, flattened into script prose via `beatsToScript`. */
export type SampleBeat = {
  /** Short id naming the shot (e.g. `wide`, `pour`). */
  id: string;
  /** Subject/scene description. The style layer is applied by the pipeline. */
  imagePrompt: string;
  /** Camera/motion description for the shot. */
  motionPrompt: string;
};

/** Nominal seconds per beat/shot — used for duration targets + cost estimates. */
export const NOMINAL_BEAT_SECONDS = 5;

/** Target length of a canonical sample (drives enhance scene count + seed metadata). */
export const CANONICAL_TARGET_SECONDS = 15;

/**
 * Hand-written canonical scripts, keyed by style slug — sent verbatim
 * (`enhance: 'off'`) INSTEAD of the platform enhancing the per-category brief,
 * for styles where that brief is a poor fit. `documentary` scored ~4.3 with
 * the shared film brief (anti-narrative), so it gets an observational portrait
 * that plays to the style.
 */
export const CANONICAL_SCRIPT_OVERRIDES: Record<
  string,
  { enhancedScript: string }
> = {
  documentary: {
    // NOTE: the scene-splitter's ONE-SHOT rule needs explicit cut markers
    // ("Cut to:", sequential framings) to produce multiple frames — plain
    // continuous prose collapses to a single scene/shot.
    enhancedScript:
      'An observational documentary portrait. INT. CLUTTERED VIOLIN WORKSHOP - EARLY MORNING. ' +
      'Elena, a violin maker in her sixties — grey hair tied back, worn canvas apron over a dark linen shirt — works alone at a bench by the window. ' +
      'Handheld close shot: her hands plane the spruce top of an unfinished violin, pale wood shavings curling away from the blade, dust drifting in the window light.\n\n' +
      'Cut to: a handheld medium close-up. Elena lifts the unvarnished violin body to the window light and turns it slowly, checking the curve of the arching with her thumb.\n\n' +
      'Cut to: a wide shot. Elena sits back on her stool, the violin resting on her knee, and looks at it in silence — the workshop quiet around her, morning light across the bench.',
  },
  // Single-hero-object styles. With NO recurring person to anchor, the
  // character-bible can't keep the product consistent, so multi-scene versions
  // morphed the hero object across cuts (earbuds→briefcase, duck→a different
  // duck, smoke→an unrelated street). Written as continuous prose with NO cut
  // markers so the splitter keeps them to ONE scene → one image → nothing to
  // morph between. (Brief copies live in STYLE_BRIEF_OVERRIDES for the review
  // label only; these scripts are what render, verbatim.)
  '360-turntable': {
    enhancedScript:
      'A premium product turntable shot. A single pair of matte-black wireless earbuds nestled in their open charging case, centered on a seamless white pedestal under soft, even three-point studio light, the brushed-metal hinge catching one clean specular highlight. ' +
      'In one continuous, unbroken locked-camera shot the turntable rotates the case through a single slow full revolution — the very same case throughout, its matte shell and the two earbuds never changing shape or finish — the traveling highlight sweeping across the hinge and lid as each face turns to camera and the case settles back exactly where it began. No cuts, no scene change, one steady rotation.',
  },
  'restaurant-menu-hero': {
    enhancedScript:
      'A signature-dish restaurant hero shot. A sliced duck breast fanned in five even pieces over a single swipe of glossy amber jus on a matte charcoal ceramic plate, lit by warm directional restaurant light, shallow depth of field. ' +
      'In one continuous, unbroken overhead shot a ladle pours a thin ribbon of that same amber jus, which pools and spreads slowly across the plate, fine steam curling upward, as a single hand lowers one last micro-herb garnish onto the duck and the plate turns a few degrees to camera — the same dish the whole time, the duck slices, the amber sauce colour and the garnish never changing. No cuts, no second dish, one held shot.',
  },
  'mood-only-frames': {
    enhancedScript:
      'A single atmospheric mood frame in a charcoal-and-amber palette. A dark, near-empty room with one hard diagonal shaft of warm light falling across suspended dust; a slow ribbon of incense smoke rises into the beam. ' +
      'In one continuous, unbroken locked shot the smoke twists and blooms upward as the light gradually intensifies and a sheer curtain at the edge of frame breathes inward on a faint draft — the same room and the same palette throughout, pure evolving mood. No cuts, no scene change, no figures.',
  },
};

/**
 * Flatten curated beats into prose the real pipeline can scene-split — the
 * API takes a script rather than per-shot prompts, so its scene split decides
 * the final shots.
 */
export function beatsToScript(beats: SampleBeat[]): string {
  return beats
    .map((beat, i) => `Shot ${i + 1}: ${beat.imagePrompt} ${beat.motionPrompt}`)
    .join('\n\n');
}

/**
 * Bespoke hero scripts, keyed by style slug. Each is a curated ~15s, 3-beat
 * script tuned to the style. DRAFT for review — slugs must match real template
 * names in `style-templates.ts` (validated at render time).
 *
 * Hero set: one strong style per major category plus standouts.
 */
export const BESPOKE_SCRIPTS: Record<string, SampleBeat[]> = {
  'product-ad': [
    {
      id: 'shelf',
      imagePrompt:
        'A minimalist skincare bottle on a sunlit bathroom shelf beside a folded linen towel and a sprig of eucalyptus.',
      motionPrompt:
        'Slow lateral dolly across the shelf, the bottle gliding into center frame; soft morning light shifting gently.',
    },
    {
      id: 'hands',
      imagePrompt:
        'Close-up of hands pressing a pump of the product into an open palm, glossy texture catching the light.',
      motionPrompt:
        'Tight handheld shot, a single confident pump and the cream landing in the palm; fingers spreading the texture.',
    },
    {
      id: 'hero',
      imagePrompt:
        'Beauty hero frame of the bottle on a color-matched pastel background, single clean shadow.',
      motionPrompt:
        'Locked hero shot, a fine mist drifting behind the bottle as it sits perfectly still; subtle light bloom.',
    },
  ],
  'real-estate': [
    {
      id: 'approach',
      imagePrompt:
        'Exterior of a modern luxury home at golden hour, warm interior lights glowing through floor-to-ceiling glass.',
      motionPrompt:
        'Smooth forward dolly toward the entrance, low warm sun raking across the facade; steadicam-calm movement.',
    },
    {
      id: 'living',
      imagePrompt:
        'Open-plan living room with designer furniture and a city skyline beyond the windows.',
      motionPrompt:
        'Slow tracking shot gliding through the living space, warm interior light against cool exterior dusk.',
    },
    {
      id: 'reveal',
      imagePrompt:
        'Infinity-edge terrace overlooking the skyline at blue hour, water reflecting city lights.',
      motionPrompt:
        'Rising crane move revealing the terrace and skyline; serene, cinematic, architectural-digest quality.',
    },
  ],
  'glossy-product-hero': [
    {
      id: 'emerge',
      imagePrompt:
        'A sleek product emerging from deep shadow on a reflective black surface, controlled rim light.',
      motionPrompt:
        'The product rotates slowly out of darkness, a single rim light tracing its silhouette.',
    },
    {
      id: 'orbit',
      imagePrompt:
        'Three-quarter hero angle of the product on glossy black, crisp reflections beneath it.',
      motionPrompt:
        'Camera orbits the product at eye level, reflections sliding across the surface; deep blacks, clean highlights.',
    },
    {
      id: 'detail',
      imagePrompt:
        'Macro of the product logo and a precision-machined edge catching a thin specular highlight.',
      motionPrompt:
        'Slow rack focus across the engraved detail, a sharp highlight sweeping along the edge.',
    },
  ],
  'automotive-cinematic': [
    {
      id: 'switchback',
      imagePrompt:
        'A matte sports car rounding a mountain switchback at dusk, headlights sweeping the rock face.',
      motionPrompt:
        'Low tracking shot on the front quarter panel as the car carves the bend; blue-hour sky, warm headlight glow.',
    },
    {
      id: 'detail',
      imagePrompt:
        'Close detail of the wheel and brake caliper, dust and light trailing behind.',
      motionPrompt:
        'Locked low angle, the wheel spinning up as the car accelerates away, dust catching backlight.',
    },
    {
      id: 'arrival',
      imagePrompt:
        'The car parked under a single overhead light in a concrete space, reflections on wet floor.',
      motionPrompt:
        'Slow orbit around the parked car, one hard light raking the bodywork; cinematic, premium.',
    },
  ],
  'fashion-editorial': [
    {
      id: 'walk',
      imagePrompt:
        'A model in a structured linen blazer walking toward camera on a clean studio cyclorama.',
      motionPrompt:
        'Camera at waist height, slight slow motion as the fabric moves naturally; soft diffused light, no harsh shadows.',
    },
    {
      id: 'turn',
      imagePrompt:
        'The model mid-turn, fabric flaring, confident editorial pose.',
      motionPrompt:
        'Locked shot, the model turns and the garment swings; crisp, controlled studio lighting.',
    },
    {
      id: 'detail',
      imagePrompt:
        'Close-up of the blazer texture, stitching and drape in sharp relief.',
      motionPrompt:
        'Slow push-in on the fabric detail, light grazing the weave; high-fashion finish.',
    },
  ],
  'food-beverage-hero': [
    {
      id: 'plate',
      imagePrompt:
        "A chef's hands plating a dish with tweezers in a high-end kitchen, microgreens placed with care.",
      motionPrompt:
        'Tight overhead shot pulling slowly wider as the final garnish is placed; warm tungsten light, rising steam.',
    },
    {
      id: 'pour',
      imagePrompt:
        'A sauce drizzled in an arc over the plated dish, glossy and rich.',
      motionPrompt:
        'Slow-motion pour, the sauce ribboning down and pooling; appetizing specular highlights.',
    },
    {
      id: 'hero',
      imagePrompt:
        'The finished dish on a dark ceramic plate, steam rising, shallow focus.',
      motionPrompt:
        'Locked hero shot, steam curling upward, a gentle focus pull onto the centerpiece; bon-appetit production value.',
    },
  ],
  'tech-keynote': [
    {
      id: 'stage',
      imagePrompt:
        'A presenter on a dark keynote stage, a glowing product render floating on a giant screen behind.',
      motionPrompt:
        'Slow push-in from a wide stage establishing shot; clean spotlight, deep blacks, confident energy.',
    },
    {
      id: 'device',
      imagePrompt:
        'A floating 3D device render rotating above a reflective stage floor, edge lighting.',
      motionPrompt:
        'The device rotates smoothly mid-air, light sweeping its edges; sleek, futuristic.',
    },
    {
      id: 'audience',
      imagePrompt:
        'Wide of the audience silhouettes facing the glowing screen, anticipation in the room.',
      motionPrompt:
        'Slow rise over the audience toward the screen; cinematic reveal, polished and aspirational.',
    },
  ],
  'beauty-macro': [
    {
      id: 'drop',
      imagePrompt:
        'Extreme macro of a single serum droplet suspended on glass, refracting soft light.',
      motionPrompt:
        'Ultra slow-motion as the droplet trembles and settles; glistening, pristine.',
    },
    {
      id: 'texture',
      imagePrompt:
        'Macro of cream texture being drawn into a soft peak, silky and luminous.',
      motionPrompt:
        'Slow pull across the texture as a peak forms; buttery light roll-off.',
    },
    {
      id: 'skin',
      imagePrompt:
        'Macro of dewy skin with a faint glow, fine highlights along the cheek.',
      motionPrompt:
        'Gentle rack focus across the skin, a soft highlight blooming; flawless, radiant.',
    },
  ],
  'award-season': [
    {
      id: 'window',
      imagePrompt:
        'A lone figure by a rain-streaked window in a dim room, a single shaft of light across the face.',
      motionPrompt:
        'Slow push-in on the contemplative figure; moody chiaroscuro, drifting rain shadows.',
    },
    {
      id: 'turn',
      imagePrompt:
        'The figure turns toward camera, half in shadow, a flicker of emotion.',
      motionPrompt:
        'Locked close-up as the head turns into the light; restrained, prestige-drama tension.',
    },
    {
      id: 'wide',
      imagePrompt:
        'Wide of the figure alone in the cavernous, beautifully lit room.',
      motionPrompt:
        'Slow dolly back revealing the scale of the room; cinematic, awards-caliber composition.',
    },
  ],
  'travel-destination': [
    {
      id: 'aerial',
      imagePrompt:
        'Aerial over turquoise water gliding toward a white-sand beach with a boutique resort.',
      motionPrompt:
        'Smooth forward drone dolly over the water toward the shore; golden-hour light on the sand.',
    },
    {
      id: 'street',
      imagePrompt:
        'An intimate cultural moment in a sunlit old-town street, warm stone and hanging lanterns.',
      motionPrompt:
        'Handheld-smooth glide down the street past a vendor; warm, inviting, lived-in.',
    },
    {
      id: 'sunset',
      imagePrompt:
        'A couple on a terrace overlooking the sea at sunset, glasses raised.',
      motionPrompt:
        'Slow push-in toward the silhouettes against the burning sky; aspirational, cinematic.',
    },
  ],
};

/** Slugs of styles that have a bespoke sample (the ~10 hero styles). */
export function heroStyleSlugs(): string[] {
  return Object.keys(BESPOKE_SCRIPTS);
}

/** True when the given style name maps to a hero (bespoke) style. */
export function isHeroStyle(styleName: string): boolean {
  return Object.hasOwn(BESPOKE_SCRIPTS, styleSlug(styleName));
}

export type SampleVideoKind = 'canonical' | 'bespoke';

/** Public R2 URL for a style's sample video. */
export function sampleVideoUrl(
  domain: string,
  slug: string,
  kind: SampleVideoKind
): string {
  return `https://${domain}/styles/${slug}/${kind}.mp4`;
}

function beatDurationSeconds(beats: SampleBeat[]): number {
  return beats.length * NOMINAL_BEAT_SECONDS;
}

/**
 * Build the validated `sampleVideos` entries for a style. Always includes the
 * canonical sample; includes a bespoke entry when the style is a hero style.
 * Canonical is `order: 0`, bespoke `order: 1`.
 */
export function buildSampleVideos(args: {
  domain: string;
  styleName: string;
}): StyleSampleVideo[] {
  const slug = styleSlug(args.styleName);
  const entries: StyleSampleVideo[] = [
    {
      url: sampleVideoUrl(args.domain, slug, 'canonical'),
      kind: 'canonical',
      label: 'Sample',
      durationSeconds: CANONICAL_TARGET_SECONDS,
      order: 0,
    },
  ];

  const bespoke = BESPOKE_SCRIPTS[slug];
  if (bespoke) {
    entries.push({
      url: sampleVideoUrl(args.domain, slug, 'bespoke'),
      kind: 'bespoke',
      label: 'Showcase',
      durationSeconds: beatDurationSeconds(bespoke),
      order: 1,
    });
  }

  // Validate against the DB schema so a bad shape fails here, not at write time.
  return entries.map((e) => StyleSampleVideoSchema.parse(e));
}
