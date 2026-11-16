import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../src/catalog/query.ts';

// A page that ends on a name outside Latin-1 ("ș", "—", "€", emoji) must page on, not fail:
// btoa alone threw on those, and the grid query answered 500 (found by the I0 bench seed).
describe('catalog cursors', () => {
  const id = '0190d4f2-7c1a-7b3e-8a4f-1234567890ab';

  it('round-trips names outside Latin-1', () => {
    for (const value of ['Brățară — argint', 'Preț 12 €', 'カード', 'Pikachu ⚡', 'ăâîșț', '']) {
      const text = encodeCursor({ value, id, sort: 'name:asc' });
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor(text, 'name:asc')).toEqual({ value, id, sort: 'name:asc' });
    }
  });

  it('round-trips any string, number, boolean, or null', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ unit: 'binary' }),
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.boolean(),
          fc.constant(null),
        ),
        (value) => {
          const c = { value, id, sort: 'x' };
          expect(decodeCursor(encodeCursor(c), 'x')).toEqual(JSON.parse(JSON.stringify(c)));
        },
      ),
    );
  });

  it('refuses a cursor from another sort or a damaged one', () => {
    const text = encodeCursor({ value: 'ș', id, sort: 'name:asc' });
    expect(() => decodeCursor(text, 'price:asc')).toThrow(/another query/);
    expect(() => decodeCursor(`${text}%%`, 'name:asc')).toThrow(/another query/);
    expect(() => decodeCursor('_w', 'name:asc')).toThrow(/another query/);
  });
});
