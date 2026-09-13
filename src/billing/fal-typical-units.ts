/**
 * Sibling endpoints that share advertised (and, so far, billed) rates.
 * t2v has no usage of its own yet, so it inherits i2v's bill-verified rate
 * rather than sitting on fal's advertised "compute seconds × $0.00017".
 * Unit price only: each sibling has its own llms.txt, so its own rate card.
 */
export const FAL_UNVERIFIED_SIBLINGS: Readonly<Record<string, string>> = {
  'minimax/h3-max/text-to-video': 'minimax/h3-max/image-to-video',
};
