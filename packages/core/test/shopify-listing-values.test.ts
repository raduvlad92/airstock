import { describe, expect, it } from 'vitest';
import { htmlToText, sameValue, textToHtml } from '../src/shopify/listing.ts';

// Listing values compared with Shopify's (ADR 0038): Shopify keeps the HTML Airstock sends in its
// own form, which must not read as a difference.

describe('Shopify listing values', () => {
  it('a description Shopify stored in its own HTML form is the same description', () => {
    const text = 'Sealed box.\n\n\nShips in 2 days, "fast".\nOne per customer';
    // Blocks on their own lines, other entities, self-closing breaks.
    const stored = `${textToHtml(text)
      .replace(/<\/p>/g, '</p>\n')
      .replace(/&quot;/g, '&#34;')
      .replace(/<br>/g, '<br />')}\n`;
    expect(sameValue('description', text, htmlToText(stored))).toBe(true);
    expect(
      sameValue(
        'description',
        'Ships today — ’fast’',
        htmlToText('<p>Ships&nbsp;today &#8212; &#x2019;fast&#x2019;</p>'),
      ),
    ).toBe(true);
  });

  it('a changed description is still a difference', () => {
    expect(sameValue('description', 'Sealed box', htmlToText('<p>Sealed tin</p>'))).toBe(false);
    expect(sameValue('description', 'One\n\nTwo', htmlToText('<p>One Two</p>'))).toBe(false);
  });
});
