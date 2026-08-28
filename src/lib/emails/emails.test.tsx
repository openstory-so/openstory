import { describe, expect, it } from 'vitest';
import { OtpEmail } from './otp-email';
import { SequenceReadyEmail } from './sequence-ready-email';
import { renderEmail } from './render-email';

describe('renderEmail(OtpEmail)', () => {
  const email = <OtpEmail appName="OpenStory" otp="482913" />;

  it('renders HTML containing the code and expiry notice', async () => {
    const { html } = await renderEmail(email);

    // Exactly one doctype — React's stream renderer emits its own, which
    // renderEmail must strip before prepending the XHTML one.
    expect(html.match(/<!DOCTYPE/g)).toHaveLength(1);
    expect(html.startsWith('<!DOCTYPE html PUBLIC')).toBe(true);
    expect(html).toContain('482913');
    expect(html).toContain('OpenStory');
    expect(html).toContain('This code expires in 5 minutes');
    // Dark-ground wordmark (#1276). Email clients strip inline SVG.
    expect(html).toContain('/brand/openstory-logo-dark.png');
    expect(html).not.toContain('/brand/openstory-logo-light.png');
    // Styles must be inline — Gmail strips <style> blocks.
    expect(html).not.toContain('<style');
    // The Tailwind wrapper must have compiled classes to inline styles.
    expect(html).toContain('style=');
    // Dark canvas, not the old light grey. Tailwind inlines rgb(), not hex.
    expect(html).toContain('rgb(10,10,10)');
  });

  it('renders a plain-text version with the code', async () => {
    const { text } = await renderEmail(email);

    expect(text).toContain('482913');
    expect(text).not.toContain('<');
  });
});

describe('renderEmail(SequenceReadyEmail)', () => {
  const email = (
    <SequenceReadyEmail
      appName="OpenStory"
      title="The Long Walk"
      watchUrl="https://openstory.so/sequences/seq_1/scenes?utm_source=email&utm_campaign=ready"
      creditsUrl="https://openstory.so/credits?utm_source=email&utm_campaign=ready"
      posterUrl="https://assets.openstory.so/posters/seq_1.png"
      clipMeta="6 clips · 30s"
      balanceDisplay="$6.40"
      typicalShortCostDisplay="~$13"
    />
  );

  it('renders the title, CTA, poster, and balance line', async () => {
    const { html } = await renderEmail(email);

    expect(html).toContain('The Long Walk is ready');
    expect(html).toContain('Watch');
    expect(html).toContain('utm_campaign=ready');
    expect(html).toContain('6 clips · 30s');
    expect(html).toContain('$6.40');
    expect(html).toContain('left · another short is about');
    expect(html).toContain('~$13');
    expect(html).toContain('https://assets.openstory.so/posters/seq_1.png');
    expect(html).toContain('/brand/openstory-logo-dark.png');
    expect(html).not.toContain('<style');
  });

  it('renders a plain-text version with the title', async () => {
    const { text } = await renderEmail(email);

    expect(text).toMatch(/the long walk is ready/i);
    expect(text).toContain('Watch');
    expect(text).not.toContain('<');
  });
});
