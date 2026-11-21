/** Hex colours as words: a video or image model reads "dark teal", not "#1f3a45". */

const HEX = /#(?:[0-9a-f]{6}|[0-9a-f]{3})\b/gi;

// ponytail: coarse hue buckets; swap for a named-colour table if the words read wrong.
const HUES: ReadonlyArray<readonly [number, string]> = [
  [15, 'red'],
  [45, 'orange'],
  [70, 'yellow'],
  [165, 'green'],
  [200, 'teal'],
  [255, 'blue'],
  [290, 'purple'],
  [345, 'magenta'],
  [360, 'red'],
];

function colourName(hex: string): string {
  const digits = hex.slice(1);
  const full =
    digits.length === 3 ? digits.replace(/./g, (c) => c + c) : digits;
  const channel = (at: number) => parseInt(full.slice(at, at + 2), 16) / 255;
  const r = channel(0);
  const g = channel(2);
  const b = channel(4);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const spread = max - min;
  const saturation = spread === 0 ? 0 : spread / (1 - Math.abs(2 * light - 1));
  const degrees =
    spread === 0
      ? 0
      : max === r
        ? (60 * ((g - b) / spread) + 360) % 360
        : max === g
          ? 60 * ((b - r) / spread) + 120
          : 60 * ((r - g) / spread) + 240;
  const hue = HUES.find(([upTo]) => degrees < upTo)?.[1] ?? 'red';

  if (light < 0.12) return saturation > 0.2 ? `near-black ${hue}` : 'black';
  if (saturation < 0.2) {
    if (light > 0.92) return 'white';
    return light > 0.65 ? 'light grey' : light > 0.3 ? 'grey' : 'charcoal';
  }
  if (hue === 'orange' && light < 0.4) return 'brown';
  const shade = light < 0.32 ? 'dark ' : light > 0.72 ? 'pale ' : '';
  return `${shade}${saturation < 0.35 ? 'muted ' : ''}${hue}`;
}

/** Every hex in the text becomes its colour word; other text is untouched. */
export function nameHexColours(text: string): string {
  return text.replace(HEX, colourName);
}
