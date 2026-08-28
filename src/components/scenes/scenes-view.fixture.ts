// Storybook fixture — originally generated from local D1 (sequence
// 01KT2TPG5WYQ15H79SAV88EH45), media URLs swapped for public placeholders,
// hand-maintained since. `scripts/generate-scenes-view-fixture.ts` predates the
// #1067 row split and cannot reproduce this file: running it would fail on the
// dropped `shots.order_index` and emit no frame/variant rows. Fix the script
// before trusting it again.
import type { SceneWithScript } from '@/hooks/use-scenes';
import {
  dbSceneId,
  type Frame,
  type FramePromptVersion,
  type FrameVariant,
  type Shot,
  type VideoVariant,
} from '@/lib/db/schema';
import {
  frameFixture,
  frameVariantFixture,
  videoVariantFixture,
} from '@/lib/mocks/frame-fixtures';
import {
  toShotView,
  type ShotGridSheet,
  type ShotView,
} from '@/lib/shots/shot-view';
import type { Sequence, Style } from '@/types/database';

export const fixtureSequence: Sequence = {
  id: '01KT2TPG5WYQ15H79SAV88EH45',
  teamId: '01KT2QSNQVWYS0EHZX0K206Y2Y',
  title: 'MAKEUP AD — 30-SECOND SHORT FILM',
  script:
    "MAKEUP AD — 30-SECOND SHORT FILM\nASPECT RATIO: 9:16 PORTRAIT\nMOOD: SENSORY · INTIMATE · LUXURIOUS\n\n---\n\nSCENE 1 — AWAKENING\nDURATION: ~5 SECONDS\n\nVISUAL:\nEXTREME MACRO. A single drop of luminous serum clings to the tip of a glass dropper, trembling almost imperceptibly. The background dissolves into a warm gradient wash — ivory (#F8E9DA) bleeding softly into the palest blush (#F4D5C5). The droplet catches a discreet edge light, igniting it from within like liquid amber. A gentle backlight halos the glass shaft, making the serum glow translucent gold.\n\nCAMERA:\nLocked probe-lens frame, positioned at eye level with the droplet. Ultra-slow-motion capture (120fps minimum). The drop releases — falling in a languid, weightless ribbon that stretches and narrows before vanishing below frame. The descent takes the full five seconds. Nothing rushes.\n\nSOUND:\nA single, resonant piano note. Low. Warm. It sustains beneath everything that follows.\n\n---\n\nSCENE 2 — THE TEXTURE\nDURATION: ~6 SECONDS\n\nVISUAL:\nCUT TO: A smooth porcelain surface — bone white, flawless. A generous curl of rich cream product is dispensed from below frame, coiling slowly onto the surface in a perfect, sculptural spiral. The cream is the color of warm magnolia (#F4D5C5), dense and velvety. Soft key light rakes across it at a low angle, throwing the ridges and peaks of the swirl into exquisite relief. Every texture fold is visible — intimate, almost architectural.\n\nCAMERA:\nSlow macro push-in descending from directly above, rotating two degrees clockwise as it moves. The cream fills the frame until its surface texture becomes an abstract landscape — peaks and valleys of pure indulgence.\n\nSOUND:\nBeneath the piano, a barely-there atmospheric hum rises — the faintest suggestion of warmth and depth. No words yet.\n\n---\n\nSCENE 3 — THE APPLICATION\nDURATION: ~7 SECONDS\n\nVISUAL:\nCUT TO: A close-up of a fingertip — skin rendered in extraordinary detail, every fine line and pore visible and celebrated. The pad of the finger presses gently into the cream. In slow motion, the product yields, blanching pale at the point of contact before spreading in a warm, even veil. The skin beneath flushes subtly — a living rose (#E2A8A1) bloom spreading outward from the touch.\n\nCAMERA:\nLow-angle macro, shooting almost parallel to the skin surface. A slight rotational drift — clockwise, imperceptibly slow — keeps the frame alive without distraction. The edge light catches the thin, luminous film of product on the skin, making it gleam like satin.\n\nSOUND:\nA second piano note joins the first — a soft, ascending interval. The atmosphere opens.\n\n---\n\nSCENE 4 — THE LIP\nDURATION: ~6 SECONDS\n\nVISUAL:\nCUT TO: A lipstick bullet — deep, burnished brown-rose (#3D2A24) — gliding in slow motion across the inside of a wrist. The product lays down a ribbon of saturated color, impossibly smooth, the pigment rich and dimensional. The wrist skin is luminous, dewy, lit from behind so the fine hairs catch the light like a halo. The color ribbon glistens.\n\nCAMERA:\nProbe-lens angle, positioned low and slightly ahead of the lipstick's path — the bullet moves toward camera in extreme slow motion, the color trail blooming behind it. Rack focus from the bullet tip to the color ribbon as it settles.\n\nSOUND:\nA soft, breathy vocal note — wordless, feminine — rises and holds over the piano. The composition breathes.\n\n---\n\nSCENE 5 — THE REVEAL\nDURATION: ~6 SECONDS\n\nVISUAL:\nCUT TO: A vertical portrait, centered in frame. A face — eyes closed, skin luminous, lit by a single soft key and a whisper of backlight that rims the cheekbones in warm gold. The complexion is dewy, flushed, alive. Lashes rest against the cheek. Lips — the same deep rose — are parted very slightly. There is complete stillness. Then, slowly, the eyes open. The gaze is direct, unhurried, sovereign.\n\nCAMERA:\nSlow, barely perceptible push-in. Centered. The face fills the 9:16 frame from chin to crown — a living portrait.\n\nSOUND:\nThe piano and vocal resolve to a single, resonant chord. Silence at the edges.\n\n---\n\nSCENE 6 — HERO PRODUCT\nDURATION: ~4 SECONDS\n\nVISUAL:\nCUT TO: The hero product — bottle, jar, or compact — centered on a pure warm-white (#FFFFFF) surface. Soft key light from the upper left. A discreet edge light on the right side traces the product's silhouette in gold. The background gradient shifts from ivory to the softest peach (#F8E9DA). The product sits still, perfect, inevitable.\n\nCAMERA:\nLocked frame. No movement. Let the product breathe.\n\nSOUND:\nSilence, then — a single clear piano note, like a signature.\n\nSUPER:\nBrand name. Clean serif. White. Centered.\nTagline fades in beneath — one line, unhurried.\n\nFADE TO WHITE.\n\n---\n\nEND CARD\nDURATION: ~1 SECOND\nBrand logo. White on warm ivory. Holds. Fades.",
  status: 'completed',
  createdAt: new Date('2026-06-02T00:10:53.000Z'),
  updatedAt: new Date('2026-06-02T00:13:00.000Z'),
  createdBy: '01KT2QSNQQNFCVAV1ASY9HRW90',
  updatedBy: '01KT2QSNQQNFCVAV1ASY9HRW90',
  styleId: '01KT2QRY2BWFJHT67CNQ3V9566',
  styleConfig: null,
  aspectRatio: '9:16',
  analysisModel: 'anthropic/claude-opus-5',
  analysisDurationMs: 81570,
  imageModel: 'nano_banana_pro',
  videoModel: 'kling_v3_pro',
  workflow: 'analyze-script-shorter-prompts-batch-size-1',
  musicUrl: null,
  musicPath:
    'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/music/sequence_music_9cmgk8_openstory.mp3',
  musicStatus: 'completed',
  musicGeneratedAt: new Date('2026-06-02T00:13:00.000Z'),
  musicError: null,
  musicModel: 'elevenlabs_music',
  musicPrompt:
    'A serene and intimate instrumental ambient composition with soft ethereal pads and delicate textural layers that evoke a luxurious sensory atmosphere, maintaining a gentle flowing progression throughout the sequence.',
  musicTags:
    'instrumental, ambient, ethereal, serene, slow, intimate, cinematic, pads, spacious, luxurious',
  statusError: null,
  autoGenerateMotion: false,
  autoGenerateMusic: false,
  posterUrl: null,
  readyEmailSentAt: null,
  suggestedTalentIds: null,
  suggestedLocationIds: null,
  musicPromptInputHash:
    '60d6365089ac968e73546fb2b9330ca73d60b38d96279af1556d047b18271174',
  workflowRunId: null,
  includeMusic: true,
};

export const fixtureStyle: Style = {
  id: '01KT2QRY2BWFJHT67CNQ3V9566',
  teamId: '01KT2QRY14ZWQ9YS21GGMF6DV1',
  sequenceId: null,
  name: 'Beauty Macro',
  description:
    'Beauty-counter close-ups with dewy texture, micro-detail, and slow-motion product engagement. Built for skincare, cosmetics, and fragrance launch content.',
  config: {
    mood: 'Sensory, intimate, luxurious',
    artStyle:
      'Macro beauty photography focused on texture and material. Cream swirling on porcelain, serum dripping down a glass dropper, lipstick gliding across a fingertip. Skin rendered with realistic pore detail. Backgrounds are simple gradient washes that flatter the product',
    lighting:
      'Soft, glowing key with a discreet edge light. Slight backlight to make liquids and gels glow. Even, flattering, never harsh. Subtle bounce into shadows so detail is preserved',
    colorPalette: ['#F8E9DA', '#E2A8A1', '#3D2A24', '#F4D5C5', '#FFFFFF'],
    cameraWork:
      'Slow macro push-ins, slight rotational moves, slow-motion liquid pours and ribbon shots. Locked frames for hero product. Probe lens style for unusual angles into bottles and jars',
    referenceFilms: [
      'glamour cosmetics launch films',
      'luxury skincare brand spots',
      'dewy minimalist beauty films',
      'maximalist editorial makeup launch reels',
    ],
    colorGrading:
      'Warm and luminous. Highlights softly bloomed, skin tones flushed and dewy. Pinks and peaches gently amplified. Looks like a high-end beauty editorial',
  },
  category: 'commercial',
  tags: ['commercial', 'beauty', 'macro', 'skincare', 'cosmetics'],
  isPublic: true,
  isTemplate: true,
  previewUrl: null,
  version: null,
  usageCount: null,
  createdAt: new Date('2026-06-01T23:19:47.000Z'),
  updatedAt: new Date('2026-06-24T02:27:10.000Z'),
  createdBy: null,
  sortOrder: 102,
  sampleVideos: [
    {
      url: 'https://assets.openstory.so/styles/beauty-macro/canonical.mp4',
      kind: 'canonical',
      label: 'Sample',
      durationSeconds: 15,
      order: 0,
    },
    {
      url: 'https://assets.openstory.so/styles/beauty-macro/bespoke.mp4',
      kind: 'bespoke',
      label: 'Showcase',
      durationSeconds: 15,
      order: 1,
    },
  ],
  recommendedImageModel: 'gpt_image_2',
  recommendedVideoModel: 'seedance_v2',
  defaultAspectRatio: '9:16',
  useCases: ['product', 'social-vertical'],
};

export const fixtureScenes: SceneWithScript[] = [
  {
    id: dbSceneId('01KT2TQ072YB92D8NWRQC5W9C6'),
    sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
    orderIndex: 0,
    location: 'Abstract macro background',
    timeOfDay: '',
    storyBeat: 'Opening macro shot of serum drop falling',
    title: 'Awakening',
    continuity: {
      characterTags: [],
      environmentTag: 'abstract_macro_background',
      elementTags: [],
      colorPalette: '#F8E9DA #F4D5C5 #FFFFFF warm luminous',
      lightingSetup:
        'soft glowing key with discreet edge light and gentle backlight halo',
      styleTag: 'macro_beauty_photography_luxurious',
    },
    selectedScriptVersionId: null,
    deletedAt: null,
    script: {
      extract:
        'SCENE 1 — AWAKENING\nDURATION: ~5 SECONDS\n\nVISUAL:\nEXTREME MACRO. A single drop of luminous serum clings to the tip of a glass dropper, trembling almost imperceptibly. The background dissolves into a warm gradient wash — ivory (#F8E9DA) bleeding softly into the palest blush (#F4D5C5). The droplet catches a discreet edge light, igniting it from within like liquid amber. A gentle backlight halos the glass shaft, making the serum glow translucent gold.\n\nCAMERA:\nLocked probe-lens frame, positioned at eye level with the droplet. Ultra-slow-motion capture (120fps minimum). The drop releases — falling in a languid, weightless ribbon that stretches and narrows before vanishing below frame. The descent takes the full five seconds. Nothing rushes.\n\nSOUND:\nA single, resonant piano note. Low. Warm. It sustains beneath everything that follows.',
      dialogue: [],
    },
    createdAt: new Date('2026-06-02T00:11:09.000Z'),
    updatedAt: new Date('2026-06-02T00:19:03.000Z'),
  },
  {
    id: dbSceneId('01KT2TQ2A3VNHR4NKMFZE9XAAC'),
    sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
    orderIndex: 1,
    location: 'Abstract macro background',
    timeOfDay: '',
    storyBeat: 'Macro of cream product texture',
    title: 'The Texture',
    continuity: {
      characterTags: [],
      environmentTag: 'abstract_macro_porcelain',
      elementTags: [],
      colorPalette: '#F8E9DA #F4D5C5 #FFFFFF',
      lightingSetup: 'soft key raking low with edge light and backlight',
      styleTag: 'macro_beauty_photography',
    },
    selectedScriptVersionId: null,
    deletedAt: null,
    script: {
      extract:
        'SCENE 2 — THE TEXTURE\nDURATION: ~6 SECONDS\n\nVISUAL:\nCUT TO: A smooth porcelain surface — bone white, flawless. A generous curl of rich cream product is dispensed from below frame, coiling slowly onto the surface in a perfect, sculptural spiral. The cream is the color of warm magnolia (#F4D5C5), dense and velvety. Soft key light rakes across it at a low angle, throwing the ridges and peaks of the swirl into exquisite relief. Every texture fold is visible — intimate, almost architectural.\n\nCAMERA:\nSlow macro push-in descending from directly above, rotating two degrees clockwise as it moves. The cream fills the frame until its surface texture becomes an abstract landscape — peaks and valleys of pure indulgence.\n\nSOUND:\nBeneath the piano, a barely-there atmospheric hum rises — the faintest suggestion of warmth and depth. No words yet.',
      dialogue: [],
    },
    createdAt: new Date('2026-06-02T00:11:12.000Z'),
    updatedAt: new Date('2026-06-02T00:14:57.000Z'),
  },
  {
    id: dbSceneId('01KT2TQ4BPDYFBAG7AHWAAY43C'),
    sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
    orderIndex: 2,
    location: 'Abstract macro background',
    timeOfDay: '',
    storyBeat: 'Application of cream onto skin',
    title: 'The Application',
    continuity: {
      characterTags: [],
      environmentTag: 'abstract_macro_background',
      elementTags: [],
      colorPalette: '#F8E9DA #E2A8A1 #F4D5C5 #FFFFFF',
      lightingSetup:
        'Soft glowing key with discreet edge light and subtle bounce',
      styleTag: 'macro_beauty_photography',
    },
    selectedScriptVersionId: null,
    deletedAt: null,
    script: {
      extract:
        'SCENE 3 — THE APPLICATION\nDURATION: ~7 SECONDS\n\nVISUAL:\nCUT TO: A close-up of a fingertip — skin rendered in extraordinary detail, every fine line and pore visible and celebrated. The pad of the finger presses gently into the cream. In slow motion, the product yields, blanching pale at the point of contact before spreading in a warm, even veil. The skin beneath flushes subtly — a living rose (#E2A8A1) bloom spreading outward from the touch.\n\nCAMERA:\nLow-angle macro, shooting almost parallel to the skin surface. A slight rotational drift — clockwise, imperceptibly slow — keeps the frame alive without distraction. The edge light catches the thin, luminous film of product on the skin, making it gleam like satin.\n\nSOUND:\nA second piano note joins the first — a soft, ascending interval. The atmosphere opens.',
      dialogue: [],
    },
    createdAt: new Date('2026-06-02T00:11:14.000Z'),
    updatedAt: new Date('2026-06-02T00:15:17.000Z'),
  },
  {
    id: dbSceneId('01KT2TQ6B0MH3VDAXH16G54X33'),
    sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
    orderIndex: 3,
    location: 'Abstract macro background',
    timeOfDay: '',
    storyBeat: 'Lipstick application on wrist',
    title: 'The Lip',
    continuity: {
      characterTags: [],
      environmentTag: 'abstract_macro_background',
      elementTags: [],
      colorPalette: '#F8E9DA #E2A8A1 #3D2A24 #F4D5C5 #FFFFFF',
      lightingSetup:
        'Soft glowing key with discreet edge light and subtle backlight',
      styleTag: 'macro_beauty_photography',
    },
    selectedScriptVersionId: null,
    deletedAt: null,
    script: {
      extract:
        "SCENE 4 — THE LIP\nDURATION: ~6 SECONDS\n\nVISUAL:\nCUT TO: A lipstick bullet — deep, burnished brown-rose (#3D2A24) — gliding in slow motion across the inside of a wrist. The product lays down a ribbon of saturated color, impossibly smooth, the pigment rich and dimensional. The wrist skin is luminous, dewy, lit from behind so the fine hairs catch the light like a halo. The color ribbon glistens.\n\nCAMERA:\nProbe-lens angle, positioned low and slightly ahead of the lipstick's path — the bullet moves toward camera in extreme slow motion, the color trail blooming behind it. Rack focus from the bullet tip to the color ribbon as it settles.\n\nSOUND:\nA soft, breathy vocal note — wordless, feminine — rises and holds over the piano. The composition breathes.",
      dialogue: [],
    },
    createdAt: new Date('2026-06-02T00:11:16.000Z'),
    updatedAt: new Date('2026-06-02T00:15:04.000Z'),
  },
  {
    id: dbSceneId('01KT2TQ8E692CA985WMB9SNXMX'),
    sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
    orderIndex: 4,
    location: 'Abstract macro background',
    timeOfDay: '',
    storyBeat: "Reveal of the model's face",
    title: 'The Reveal',
    continuity: {
      characterTags: [],
      environmentTag: 'abstract_macro_background',
      elementTags: [],
      colorPalette: '#F8E9DA #E2A8A1 #3D2A24 #F4D5C5 #FFFFFF',
      lightingSetup:
        'soft glowing key light from above with warm gold rim and edge light',
      styleTag: 'macro_beauty_photography_luxurious',
    },
    selectedScriptVersionId: null,
    deletedAt: null,
    script: {
      extract:
        'SCENE 5 — THE REVEAL\nDURATION: ~6 SECONDS\n\nVISUAL:\nCUT TO: A vertical portrait, centered in frame. A face — eyes closed, skin luminous, lit by a single soft key and a whisper of backlight that rims the cheekbones in warm gold. The complexion is dewy, flushed, alive. Lashes rest against the cheek. Lips — the same deep rose — are parted very slightly. There is complete stillness. Then, slowly, the eyes open. The gaze is direct, unhurried, sovereign.\n\nCAMERA:\nSlow, barely perceptible push-in. Centered. The face fills the 9:16 frame from chin to crown — a living portrait.\n\nSOUND:\nThe piano and vocal resolve to a single, resonant chord. Silence at the edges.',
      dialogue: [],
    },
    createdAt: new Date('2026-06-02T00:11:18.000Z'),
    updatedAt: new Date('2026-06-02T00:15:18.000Z'),
  },
  {
    id: dbSceneId('01KT2TQA9A3SYCK47G14S0YB8Y'),
    sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
    orderIndex: 5,
    location: 'Abstract macro background',
    timeOfDay: '',
    storyBeat: 'Hero product showcase',
    title: 'Hero Product',
    continuity: {
      characterTags: [],
      environmentTag: 'abstract_macro_background',
      elementTags: [],
      colorPalette: '#F8E9DA #E2A8A1 #FFFFFF #F4D5C5',
      lightingSetup:
        'Soft glowing key from upper left with discreet golden edge light',
      styleTag: 'macro_beauty_photography',
    },
    selectedScriptVersionId: null,
    deletedAt: null,
    script: {
      extract:
        "SCENE 6 — HERO PRODUCT\nDURATION: ~4 SECONDS\n\nVISUAL:\nCUT TO: The hero product — bottle, jar, or compact — centered on a pure warm-white (#FFFFFF) surface. Soft key light from the upper left. A discreet edge light on the right side traces the product's silhouette in gold. The background gradient shifts from ivory to the softest peach (#F8E9DA). The product sits still, perfect, inevitable.\n\nCAMERA:\nLocked frame. No movement. Let the product breathe.\n\nSOUND:\nSilence, then — a single clear piano note, like a signature.\n\nSUPER:\nBrand name. Clean serif. White. Centered.\nTagline fades in beneath — one line, unhurried.\n\nFADE TO WHITE.",
      dialogue: [],
    },
    createdAt: new Date('2026-06-02T00:11:20.000Z'),
    updatedAt: new Date('2026-06-25T02:27:46.000Z'),
  },
  {
    id: dbSceneId('01KT2TQAY2YNXFX1GVKP7HK43K'),
    sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
    orderIndex: 6,
    location: 'Abstract macro background',
    timeOfDay: '',
    storyBeat: 'Closing brand logo',
    title: 'End Card',
    continuity: {
      characterTags: [],
      environmentTag: 'abstract_macro_background',
      elementTags: [],
      colorPalette: '#F8E9DA #FFFFFF #F4D5C5',
      lightingSetup: 'soft_glowing_key_upper_left',
      styleTag: 'macro_beauty_photography',
    },
    selectedScriptVersionId: null,
    deletedAt: null,
    script: {
      extract:
        'END CARD\nDURATION: ~1 SECOND\nBrand logo. White on warm ivory. Holds. Fades.',
      dialogue: [],
    },
    createdAt: new Date('2026-06-02T00:11:20.000Z'),
    updatedAt: new Date('2026-06-02T00:14:18.000Z'),
  },
];

/**
 * A shot owns no assets (#1067): its still lives on the anchor frame's selected
 * `frame_variants` row, its prompt on the selected `frame_prompt_versions` row,
 * and its video on the segment's `video_variants` rows. Each entry carries
 * those rows' real columns; `fixtureShotView` assembles them below exactly as a
 * read path does.
 */
type FixtureShotSource = {
  shot: Shot;
  frame: Partial<Frame>;
  image?: Partial<FrameVariant>;
  /**
   * The pre-prompt stand-in's url (#1101) — a `kind: 'preview'` row, resolved
   * separately from the selected still because it can never BE the still.
   */
  previewUrl?: string;
  imagePromptVersion?: Pick<FramePromptVersion, 'text' | 'inputHash'>;
  /**
   * The segment's newest primary render — its lifecycle IS the shot's video
   * status. Only a completed one is selectable, so the selection pointer below
   * is url-gated off the same row.
   */
  render?: Partial<VideoVariant>;
  gridSheet?: ShotGridSheet;
};

const fixtureShotSources: FixtureShotSource[] = [
  {
    shot: {
      id: '01KT2TQ072YB92D8NWRQC5W9C6',
      sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
      sceneId: '01KT2TQ072YB92D8NWRQC5W9C6',
      shotNumber: 1,
      durationMs: 4000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-02T00:11:09.000Z'),
      updatedAt: new Date('2026-06-02T00:19:03.000Z'),
    },
    frame: {
      imageStatus: 'completed',
      imageWorkflowRunId:
        'image_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ072YB92D8NWRQC5W9C6_nano_banana_pro_rewldhr',
      imageError: null,
    },
    image: {
      url: 'https://picsum.photos/seed/01KT2TQ072YB92D8NWRQC5W9C6/720/1280',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ072YB92D8NWRQC5W9C6/01KT2TRRCR6RZ30YK2JWHYRN8Q.png',
      model: 'nano_banana_pro',
      inputHash:
        '638094256e60548cf03e763d845424d0891173245acbf1888c7723797e5a76c7',
    },
    previewUrl:
      'https://picsum.photos/seed/01KT2TQ072YB92D8NWRQC5W9C6-p/720/1280',
    imagePromptVersion: {
      text: 'Macro beauty photography extreme close-up of a single luminous serum droplet clinging to the tip of a glass dropper trembling almost imperceptibly against a seamless warm gradient wash from ivory to palest blush the droplet catching discreet edge light that ignites it from within like liquid amber with gentle backlight haloing the glass shaft in translucent gold the frame locked at eye level with the droplet in a poised moment of potential release soft sensual intimate atmosphere captured with probe lens.',
      inputHash:
        '5e35aef7cbcca388535f8280c210c9f8c4961f0f40720138df3fd8fdbf57a2db',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ072YB92D8NWRQC5W9C6/makeup-ad-30-second-short-film_awakening_hm97de_openstory.mp4',
      model: 'veo3_1',
      generatedAt: new Date('2026-06-02T00:19:03.000Z'),
      inputHash: null,
      status: 'completed',
      error: null,
      workflowRunId:
        'motion_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ072YB92D8NWRQC5W9C6_veo3_1_r-qzer8o',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/01KT2TQ072YB92D8NWRQC5W9C6-v/720/1280',
      status: 'completed',
    },
  },
  {
    shot: {
      id: '01KT2TQ2A3VNHR4NKMFZE9XAAC',
      sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
      sceneId: '01KT2TQ2A3VNHR4NKMFZE9XAAC',
      shotNumber: 1,
      durationMs: 6000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-02T00:11:12.000Z'),
      updatedAt: new Date('2026-06-02T00:14:57.000Z'),
    },
    frame: {
      imageStatus: 'completed',
      imageWorkflowRunId:
        'image_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ2A3VNHR4NKMFZE9XAAC_nano_banana_pro_rewldhr',
      imageError: null,
    },
    image: {
      url: 'https://picsum.photos/seed/01KT2TQ2A3VNHR4NKMFZE9XAAC/720/1280',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ2A3VNHR4NKMFZE9XAAC/01KT2TRPXC5BYE50YNPE7W737H.png',
      model: 'nano_banana_pro',
      inputHash:
        '25f45d2f849554e8ea0304f957cc61ebd97658eac4e24bd098e7ef5bdeed2847',
    },
    previewUrl:
      'https://picsum.photos/seed/01KT2TQ2A3VNHR4NKMFZE9XAAC-p/720/1280',
    imagePromptVersion: {
      text: 'Macro beauty photography in the style of high-end product films like Charlotte Tilbury and La Mer, a flawless bone-white porcelain surface filling the frame with a generous initial curl of dense velvety cream in warm magnolia beginning to coil slowly from below in a perfect sculptural spiral, captured at the very first moment of dispense with potential energy held in the forming ridges and peaks, abstract macro background as a simple gradient wash, intimate and luxurious atmosphere, soft glowing key light raking low across the surface to throw exquisite relief into every fold and peak of the cream texture, subtle edge light and warm backlight creating a luminous sheen on the product, slow macro push-in from directly above with a slight two-degree clockwise rotational implication, shallow depth of field emphasizing the tactile material details while softly blooming highlights, warm luminous color grading with soft pinks and peaches, 9:16 aspect ratio.',
      inputHash:
        '6a0661a6909ede6efb155a60703eb80a3bd0a16f07fc3e79a5a23285bcd03be6',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ2A3VNHR4NKMFZE9XAAC/makeup-ad-30-second-short-film_the-texture_mr10j1_openstory.mp4',
      model: 'kling_v3_pro',
      generatedAt: new Date('2026-06-02T00:14:57.000Z'),
      inputHash: null,
      status: 'completed',
      error: null,
      workflowRunId:
        'motion_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ2A3VNHR4NKMFZE9XAAC_kling_v3_pro_r-1crr24',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/01KT2TQ2A3VNHR4NKMFZE9XAAC-v/720/1280',
      status: 'completed',
    },
  },
  {
    shot: {
      id: '01KT2TQ4BPDYFBAG7AHWAAY43C',
      sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
      sceneId: '01KT2TQ4BPDYFBAG7AHWAAY43C',
      shotNumber: 1,
      durationMs: 7000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-02T00:11:14.000Z'),
      updatedAt: new Date('2026-06-02T00:15:17.000Z'),
    },
    frame: {
      imageStatus: 'completed',
      imageWorkflowRunId:
        'image_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ4BPDYFBAG7AHWAAY43C_nano_banana_pro_rewldhr',
      imageError: null,
    },
    image: {
      url: 'https://picsum.photos/seed/01KT2TQ4BPDYFBAG7AHWAAY43C/720/1280',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ4BPDYFBAG7AHWAAY43C/01KT2TRNG2YAS9KFXQNJHZC2YW.png',
      model: 'nano_banana_pro',
      inputHash:
        'e250b71299008aa923231b7c8cb543f8adfdd955ea7dd30f8135dd2547127818',
    },
    previewUrl:
      'https://picsum.photos/seed/01KT2TQ4BPDYFBAG7AHWAAY43C-p/720/1280',
    imagePromptVersion: {
      text: 'Macro beauty photography in a close-up low-angle view almost parallel to the skin surface showing a fingertip at the exact moment of gentle contact pressing downward into a layer of dense cream, the product surface yielding and beginning to blanch pale under the pressure while the skin beneath starts to flush with a subtle living rose tone spreading outward, set against a simple abstract gradient background wash, soft glowing key light with discreet edge light skimming the thin emerging film of product so it gleams with satin texture, warm luminous color grading with softly bloomed highlights, slight clockwise rotational framing implied in the still capture, 9:16 vertical composition.',
      inputHash:
        '9a5a8fb49c2420a571ced29213472cc5bc8611ffffabec608e321fc8d0a614ef',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ4BPDYFBAG7AHWAAY43C/makeup-ad-30-second-short-film_the-application_bd3z6b_openstory.mp4',
      model: 'kling_v3_pro',
      generatedAt: new Date('2026-06-02T00:15:17.000Z'),
      inputHash: null,
      status: 'completed',
      error: null,
      workflowRunId:
        'motion_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ4BPDYFBAG7AHWAAY43C_kling_v3_pro_r-1crr24',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/01KT2TQ4BPDYFBAG7AHWAAY43C-v/720/1280',
      status: 'completed',
    },
  },
  {
    shot: {
      id: '01KT2TQ6B0MH3VDAXH16G54X33',
      sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
      sceneId: '01KT2TQ6B0MH3VDAXH16G54X33',
      shotNumber: 1,
      durationMs: 6000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-02T00:11:16.000Z'),
      updatedAt: new Date('2026-06-02T00:15:04.000Z'),
    },
    frame: {
      imageStatus: 'completed',
      imageWorkflowRunId:
        'image_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ6B0MH3VDAXH16G54X33_nano_banana_pro_rewldhr',
      imageError: null,
    },
    image: {
      url: 'https://picsum.photos/seed/01KT2TQ6B0MH3VDAXH16G54X33/720/1280',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ6B0MH3VDAXH16G54X33/01KT2TRW091VKYGEXKT37B77QG.png',
      model: 'nano_banana_pro',
      inputHash:
        '7569cfba0a472864c2cdcd76aee3ca1f5491d35d70d5f478ecb9d83050337db8',
    },
    previewUrl:
      'https://picsum.photos/seed/01KT2TQ6B0MH3VDAXH16G54X33-p/720/1280',
    imagePromptVersion: {
      text: "Macro beauty photography capturing the starting moment of a deep burnished brown-rose lipstick bullet positioned just above the skin and beginning to glide across the inside of a luminous dewy wrist laying down an impossibly smooth saturated glossy color ribbon the fine hairs along the wrist catching a soft backlight like a delicate halo the skin rendered with realistic pore detail and subtle sheen set against a simple warm gradient abstract macro background soft glowing key light combined with discreet edge light and gentle rear illumination creating luminous depth and texture probe lens positioned low and slightly ahead of the bullet's path with shallow depth of field emphasizing the impending motion in an extreme close-up frame warm luminous color grading highlighting flushed dewy tones and softly bloomed highlights",
      inputHash:
        'c24b43ff12503d783dfd1513eecf8989160d3f1b2ae13dccc964ff2db63dfb9d',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ6B0MH3VDAXH16G54X33/makeup-ad-30-second-short-film_the-lip_ns0dw3_openstory.mp4',
      model: 'kling_v3_pro',
      generatedAt: new Date('2026-06-02T00:15:04.000Z'),
      inputHash: null,
      status: 'completed',
      error: null,
      workflowRunId:
        'motion_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ6B0MH3VDAXH16G54X33_kling_v3_pro_r-1crr24',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/01KT2TQ6B0MH3VDAXH16G54X33-v/720/1280',
      status: 'completed',
    },
  },
  {
    shot: {
      id: '01KT2TQ8E692CA985WMB9SNXMX',
      sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
      sceneId: '01KT2TQ8E692CA985WMB9SNXMX',
      shotNumber: 1,
      durationMs: 6000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-02T00:11:18.000Z'),
      updatedAt: new Date('2026-06-02T00:15:18.000Z'),
    },
    frame: {
      imageStatus: 'completed',
      imageWorkflowRunId:
        'image_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ8E692CA985WMB9SNXMX_nano_banana_pro_rewldhr',
      imageError: null,
    },
    image: {
      url: 'https://picsum.photos/seed/01KT2TQ8E692CA985WMB9SNXMX/720/1280',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ8E692CA985WMB9SNXMX/01KT2TRWC2VBMH96WWTSNQ4WBJ.png',
      model: 'nano_banana_pro',
      inputHash:
        '47f18d95f63eb293ecaa35f037f1e92b0807e763081282385f6d90dfde3cd0f2',
    },
    previewUrl:
      'https://picsum.photos/seed/01KT2TQ8E692CA985WMB9SNXMX-p/720/1280',
    imagePromptVersion: {
      text: "Cinematic macro beauty photography in vertical 9:16 frame of a woman's face centered tightly from chin to crown, eyes gently closed with lashes resting softly against luminous dewy skin, lips parted only slightly in deep rose, complete stillness and poised potential as the eyes prepare to open, rendered with realistic pore detail against an abstract soft gradient background shifting from ivory to peach, soft glowing key light from above combined with a subtle warm gold edge and rim light caressing the cheekbones, intimate luxurious mood with warm bloomed highlights and flushed skin tones, high-end editorial color grading, probe lens compression emphasizing texture and dimension, barely perceptible push-in framing suggesting imminent slow reveal.",
      inputHash:
        '08e0c43484383c9d78261fe4ea2983a1e08e331e40ec3d3e21aff6ed66a8c46b',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/sintel/mp4/h264/360/Sintel_360_10s_1MB.mp4',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQ8E692CA985WMB9SNXMX/makeup-ad-30-second-short-film_the-reveal_d21e7k_openstory.mp4',
      model: 'kling_v3_pro',
      generatedAt: new Date('2026-06-02T00:15:18.000Z'),
      inputHash: null,
      status: 'completed',
      error: null,
      workflowRunId:
        'motion_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQ8E692CA985WMB9SNXMX_kling_v3_pro_r-1crr24',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/01KT2TQ8E692CA985WMB9SNXMX-v/720/1280',
      status: 'completed',
    },
  },
  {
    shot: {
      id: '01KT2TQA9A3SYCK47G14S0YB8Y',
      sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
      sceneId: '01KT2TQA9A3SYCK47G14S0YB8Y',
      shotNumber: 1,
      durationMs: 4000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-02T00:11:20.000Z'),
      updatedAt: new Date('2026-06-02T00:14:32.000Z'),
    },
    frame: {
      imageStatus: 'completed',
      imageWorkflowRunId:
        'image_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQA9A3SYCK47G14S0YB8Y_nano_banana_pro_rewldhr',
      imageError: null,
    },
    image: {
      url: 'https://picsum.photos/seed/01KT2TQA9A3SYCK47G14S0YB8Y/720/1280',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQA9A3SYCK47G14S0YB8Y/01KT2TRRA92AS8F5VX6WSTANX6.png',
      model: 'nano_banana_pro',
      inputHash:
        '9bd2ce2b9f5bd92ffed6f03961595a0a5a653fca894de0a247c3dfd6fa30979d',
    },
    previewUrl:
      'https://picsum.photos/seed/01KT2TQA9A3SYCK47G14S0YB8Y-p/720/1280',
    imagePromptVersion: {
      text: 'Macro beauty photography of the hero product centered on a pure warm-white surface, the product sits still perfect and inevitable, soft glowing key light from upper left with a discreet golden edge light tracing its right silhouette, background gradient from ivory to the softest peach, highly detailed material textures with realistic depth, warm luminous color grading, highlights softly bloomed, locked frame composition with no movement, 9:16 vertical framing, intimate luxurious atmosphere',
      inputHash:
        'ce5025d3e93003b0aa943a6e2de0135317b332454bdf1520957d56d5a00f8272',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/jellyfish/mp4/h264/360/Jellyfish_360_10s_1MB.mp4',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQA9A3SYCK47G14S0YB8Y/makeup-ad-30-second-short-film_hero-product_wbqqe3_openstory.mp4',
      model: 'kling_v3_pro',
      generatedAt: new Date('2026-06-02T00:14:32.000Z'),
      inputHash: null,
      status: 'completed',
      error: null,
      workflowRunId:
        'motion_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQA9A3SYCK47G14S0YB8Y_kling_v3_pro_r-1crr24',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/01KT2TQA9A3SYCK47G14S0YB8Y-v/720/1280',
      status: 'completed',
    },
  },
  {
    shot: {
      id: '01KT2TQAY2YNXFX1GVKP7HK43K',
      sequenceId: '01KT2TPG5WYQ15H79SAV88EH45',
      sceneId: '01KT2TQAY2YNXFX1GVKP7HK43K',
      shotNumber: 1,
      durationMs: 3000,
      selectedMotionPromptVersionId: null,
      renderSegmentId: null,
      deletedAt: null,
      createdAt: new Date('2026-06-02T00:11:20.000Z'),
      updatedAt: new Date('2026-06-02T00:14:18.000Z'),
    },
    frame: {
      imageStatus: 'completed',
      imageWorkflowRunId:
        'image_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQAY2YNXFX1GVKP7HK43K_nano_banana_pro_rewldhr',
      imageError: null,
    },
    image: {
      url: 'https://picsum.photos/seed/01KT2TQAY2YNXFX1GVKP7HK43K/720/1280',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQAY2YNXFX1GVKP7HK43K/01KT2TRXWX1SVJFJJX8VZWHG8F.png',
      model: 'nano_banana_pro',
      inputHash:
        'e848cc7ba9bea3ea864228edcc0178ee25954c3c9368a835e9e8073eb5b31b6a',
    },
    previewUrl:
      'https://picsum.photos/seed/01KT2TQAY2YNXFX1GVKP7HK43K-p/720/1280',
    imagePromptVersion: {
      text: 'Macro beauty photography of a minimal abstract composition on a smooth warm ivory gradient background shifting to soft peach, crisp white brand logo centered and holding perfectly still, soft glowing key light from upper left with subtle bounce filling shadows, delicate edge highlights, luxurious luminous atmosphere, high-end beauty editorial quality, locked frame, vertical composition',
      inputHash:
        '02b2e4d327ff65d6106eace0deb7d9972ff93ead0d90b4014a0711fd3e7c29d5',
    },
    render: {
      url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4',
      storagePath:
        'teams/01KT2QSNQVWYS0EHZX0K206Y2Y/sequences/01KT2TPG5WYQ15H79SAV88EH45/frames/01KT2TQAY2YNXFX1GVKP7HK43K/makeup-ad-30-second-short-film_end-card_2gwwvg_openstory.mp4',
      model: 'kling_v3_pro',
      generatedAt: new Date('2026-06-02T00:14:18.000Z'),
      inputHash: null,
      status: 'completed',
      error: null,
      workflowRunId:
        'motion_01KT2TPG5WYQ15H79SAV88EH45_01KT2TQAY2YNXFX1GVKP7HK43K_kling_v3_pro_r-1crr24',
    },
    gridSheet: {
      url: 'https://picsum.photos/seed/01KT2TQAY2YNXFX1GVKP7HK43K-v/720/1280',
      status: 'completed',
    },
  },
];

function fixtureShotView(source: FixtureShotSource): ShotView {
  const { shot } = source;
  const frame = frameFixture({
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    ...source.frame,
  });
  const image = source.image
    ? frameVariantFixture({
        frameId: frame.id,
        sequenceId: shot.sequenceId,
        ...source.image,
      })
    : null;
  const render = source.render
    ? videoVariantFixture({
        // No fixture row is assigned to a segment; a synthetic id keeps the
        // per-shot renders distinct.
        renderSegmentId: `${shot.id}-segment`,
        sequenceId: shot.sequenceId,
        ...source.render,
      })
    : null;
  return toShotView(shot, frame, {
    image,
    preview: source.previewUrl
      ? frameVariantFixture({
          frameId: frame.id,
          sequenceId: shot.sequenceId,
          kind: 'preview',
          url: source.previewUrl,
        })
      : null,
    imagePromptVersion: source.imagePromptVersion
      ? {
          id: `${frame.id}-prompt`,
          frameId: frame.id,
          components: null,
          source: 'ai-generated',
          analysisModel: null,
          status: 'completed',
          pendingInputHash: null,
          workflowRunId: null,
          createdAt: shot.createdAt,
          createdBy: null,
          ...source.imagePromptVersion,
        }
      : null,
    video: render?.url ? render : null,
    primaryVideo: render,
    gridSheet: source.gridSheet ?? null,
  });
}

export const fixtureShots: ShotView[] = fixtureShotSources.map(fixtureShotView);
