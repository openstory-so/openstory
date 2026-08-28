const APP_NAME = import.meta.env.VITE_APP_NAME || 'OpenStory';
const APP_URL = import.meta.env.VITE_APP_URL || 'https://openstory.so';
const VITE_R2_PUBLIC_ASSETS_DOMAIN =
  import.meta.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so';

const APP_DOMAIN = (() => {
  try {
    return new URL(APP_URL).hostname;
  } catch {
    return 'openstory.so';
  }
})();

export const CONTACT_EMAIL = `hello@${APP_DOMAIN}`;
export const PRIVACY_EMAIL = `privacy@${APP_DOMAIN}`;
/** Where "Ask Tom for Credits" requests land (#1096). Deliberately a person,
 * not an alias — the pitch is that the founder replies. */
export const FOUNDER_EMAIL = 'tom@openstory.so';

export const SITE_CONFIG = {
  name: APP_NAME,
  description:
    'Create 5-minute AI films with consistent characters. Iterate until you nail it. Open source and free to self-host.',
  /** Logged-out homepage heading. */
  tagline: 'Tell your whole story',
  /** Logged-out homepage subtitle — what the product does. */
  taglineSub:
    'Create 5-minute AI films with consistent characters. Iterate until you nail it.',
  url: APP_URL,
  contactEmail: CONTACT_EMAIL,
  privacyEmail: PRIVACY_EMAIL,
  // The OG card is the app's own front page, captured to public/og.jpg by
  // scripts/generate-og-image.ts. Served same-origin so it deploys atomically
  // with the app (and each preview shows its own) instead of drifting from a
  // hand-uploaded R2 file.
  ogImage: `${APP_URL}/og.jpg`,
  ctaText: 'Get Started',
  ctaHref: '/',
  githubHref: 'https://github.com/openstory-so/openstory',
  xHref: 'https://x.com/openstory_so',
  youtubeHref:
    'https://www.youtube.com/playlist?list=PLCFHxgvzZ1EGTj_miPI2Rn8eUGrajumEA',
};

export const TOP_TIER_FEATURES = [
  {
    title: 'From Idea to Finished Video',
    description:
      'Describe what you want in a line or paste a full script. OpenStory breaks it into scenes, generates shots, and scores the music — a multi-scene film with consistent characters, not a single-shot toy.',
    image: `https://${VITE_R2_PUBLIC_ASSETS_DOMAIN}/images/marketing/14-fantasy-dragon.webp`,
  },
  {
    title: 'Cast Your Own Talent & Locations',
    description:
      'Define your characters and environments once \u2014 age, wardrobe, lighting, architecture. OpenStory maintains consistency across every shot in every sequence.',
    images: [
      `https://${VITE_R2_PUBLIC_ASSETS_DOMAIN}/images/marketing/08-fashion-editorial.webp`,
      `https://${VITE_R2_PUBLIC_ASSETS_DOMAIN}/images/marketing/05-corporate-team.webp`,
    ],
  },
  {
    title: 'Get The Shot You Want',
    description:
      'Generate variations of any shot \u2014 different angles, lighting, compositions \u2014 and iterate the whole film until it\u2019s exactly right.',
    image: `https://${VITE_R2_PUBLIC_ASSETS_DOMAIN}/images/marketing/02-product-sneaker.webp`,
  },
  {
    title: 'Take Your Work Anywhere',
    description:
      'Download individual shots, export full sequences, and get the prompts behind every generation. Your work isn\u2019t trapped here \u2014 use it in any editing tool or pipeline.',
    image: `https://${VITE_R2_PUBLIC_ASSETS_DOMAIN}/images/marketing/12-travel-adventure.webp`,
  },
  {
    title: 'Latest Models',
    description:
      'Access the best image and video models as they ship. Switch per shot, or let OpenStory pick the best one for the job.',
    image: `https://${VITE_R2_PUBLIC_ASSETS_DOMAIN}/images/marketing/01-product-cosmetics.webp`,
  },
  {
    title: 'Music & Audio',
    description:
      'Generate music tracks and sound effects that match your sequence. Full audio composition built in.',
    image: `https://${VITE_R2_PUBLIC_ASSETS_DOMAIN}/images/marketing/09-music-video.webp`,
  },
] as const;

export const PROCESS_STEPS = [
  {
    number: '01',
    title: 'Describe Your Idea',
    description:
      'Start with a one-liner or a full script. OpenStory builds out scenes, assigns characters and locations, and prepares shot directions for a multi-scene film.',
  },
  {
    number: '02',
    title: 'Define Your Look',
    description:
      'Set your visual style, cast your talent, choose your locations. These carry across your entire project.',
  },
  {
    number: '03',
    title: 'Generate & Refine',
    description:
      'Generate AI shots for every shot. Swap models, try variations, regenerate until every shot is right.',
  },
  {
    number: '04',
    title: 'Export Everything',
    description:
      'Download shots, sequences, prompts, and music. Take it all into your editing tool of choice.',
  },
] as const;

export const FAQ_ITEMS = [
  {
    question: 'What is OpenStory?',
    answer:
      'OpenStory is an open source AI video production platform. Paste a script or a one-liner and it builds a multi-scene film \u2014 consistent characters, locations, and look across every shot, up to around five minutes. Iterate on scenes until you nail it, then export. Free to self-host.',
  },
  {
    question: 'Do I need to write a full script?',
    answer:
      'No. You can start with a single line and OpenStory will expand it into a full script with scenes, characters, and shot directions. Or paste in a complete script if you have one.',
  },
  {
    question: 'What AI models does it support?',
    answer:
      'OpenStory fully supports the latest image and video models as close to day zero as possible. You can switch models per shot or let OpenStory pick the best one.',
  },
  {
    question: 'How does pricing work?',
    answer:
      'No subscriptions. Generations are billed at the rates of the labs and platforms that run them (fal.ai, OpenRouter, and more soon). A platform fee applies only when you buy credits, not on each generation. See openstory.so/pricing for the full model price list. Bring your own API keys to skip credits entirely.',
  },
  {
    question: 'Can I use my own API keys?',
    answer:
      'Absolutely. You can enter your own API keys directly\u2009\u2014\u2009no self-hosting required. Pay providers directly with full control over costs and usage.',
  },
  {
    question: 'Is it open source?',
    answer:
      'Yes. MIT licensed, full source on GitHub. You can self-host it, fork it, or use the managed cloud version.',
  },
  {
    question: 'How do I get started?',
    answer:
      'Sign up to start immediately, or clone the GitHub repo to self-host. Describe your idea, define your look, and generate your first storyboard in minutes.',
  },
] as const;

export const OPEN_FAIR_BENEFITS = [
  {
    title: 'Open Source',
    description:
      'MIT licensed, full source on GitHub. Fork it, self-host it, or build entirely new workflows on top.',
  },
  {
    title: 'Bring Your Own Keys',
    description:
      'Use your own API keys or self-host entirely. Pay providers directly with no platform fees.',
  },
  {
    title: 'At Cost Pricing',
    description:
      'No subscriptions. AI usage at provider cost. A small fee applies only when buying credits.',
  },
  {
    title: 'Export Everything',
    description:
      'Shots, sequences, prompts, and music. Your work isn\u2019t trapped\u2009\u2014\u2009take it anywhere.',
  },
] as const;
