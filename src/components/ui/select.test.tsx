import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  resolveSelectValueDisplay,
  wrapSelectItemLabel,
} from '@/components/ui/select';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

describe('resolveSelectValueDisplay', () => {
  it('never returns undefined — Radix portals ItemText into SelectValue when children are missing', () => {
    expect(resolveSelectValueDisplay(undefined, undefined)).toBeNull();
    expect(resolveSelectValueDisplay(undefined, '5s')).toBe('5s');
    expect(resolveSelectValueDisplay('explicit', '5s')).toBe('explicit');
    expect(resolveSelectValueDisplay(null, '5s')).toBeNull();
  });
});

describe('Select', () => {
  it('keeps an explicit SelectValue label in the trigger (no ItemText portal)', () => {
    const html = renderToStaticMarkup(
      <Select value="text">
        <SelectTrigger>
          <SelectValue>Text to video</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="text">Text to video</SelectItem>
        </SelectContent>
      </Select>
    );
    expect(html).toContain('data-slot="select-value"');
    expect(html).toContain('Text to video');
  });

  it('wraps SelectItem labels in a span so the item owns an element, not a bare text node', () => {
    expect(renderToStaticMarkup(wrapSelectItemLabel('5s'))).toBe(
      '<span>5s</span>'
    );
  });
});
