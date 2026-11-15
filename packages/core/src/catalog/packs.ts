import { compare, decimalScale, multiply, normalize } from './decimal.ts';

/**
 * Pack arithmetic (plan Section 5.3, PRD 4.6, ADR 0019). A pack holds `quantity` base units, or,
 * with an inner pack, `quantity` whole inner packs: "a case holds 12 inner packs of 6" is
 * 12 × 6 = 72 base units. Base quantities are computed exactly (no floating point) and must fit
 * the variant's quantity scale, so converting any whole number of packs never breaks it.
 */

export const PACK_USES = ['purchasing', 'counting', 'transfer', 'sales'] as const;
export type PackUse = (typeof PACK_USES)[number];

export const PACK_LIMITS = { perVariant: 20, nesting: 5 } as const;

/** The largest value numeric(20, 6) holds. */
const MAX_QUANTITY = '99999999999999.999999';

export interface PackSpec {
  /** The pack's ID, or a temporary key for a new pack. */
  key: string;
  name: string;
  quantity: string;
  /** Key of the pack this one is made of, or null for base units. */
  inner: string | null;
}

export type PackProblem =
  | 'pack_cycle'
  | 'pack_breaks_quantity_scale'
  | 'pack_inner_quantity_not_whole'
  | 'pack_too_large'
  | 'pack_nesting_too_deep'
  | 'pack_unknown_inner';

export type PackResolution =
  | { ok: true; base: Map<string, string>; depth: Map<string, number> }
  | { ok: false; code: PackProblem; key: string; message: string };

/**
 * Resolves every pack to its exact base quantity. Fails on the first pack that refers to an
 * unknown pack, takes part in a cycle, nests too deep, needs a fraction of an inner pack, is too
 * large, or does not fit the variant's quantity scale.
 */
export function resolvePacks(specs: PackSpec[], quantityScale: number): PackResolution {
  const byKey = new Map(specs.map((s) => [s.key, s]));
  const base = new Map<string, string>();
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  let problem: Extract<PackResolution, { ok: false }> | null = null;
  const fail = (code: PackProblem, key: string, message: string) => {
    problem ??= { ok: false, code, key, message };
    return null;
  };

  const resolve = (key: string): string | null => {
    const known = base.get(key);
    if (known !== undefined) return known;
    const spec = byKey.get(key)!;
    if (visiting.has(key)) return fail('pack_cycle', key, `${spec.name} ends up inside itself.`);
    let value: string;
    let level = 1;
    if (spec.inner === null) {
      value = normalize(spec.quantity);
    } else {
      const inner = byKey.get(spec.inner);
      if (!inner)
        return fail(
          'pack_unknown_inner',
          key,
          `${spec.name} names a pack that is not in the list.`,
        );
      if (decimalScale(normalize(spec.quantity)) > 0) {
        return fail(
          'pack_inner_quantity_not_whole',
          key,
          `${spec.name} holds a whole number of ${inner.name}.`,
        );
      }
      visiting.add(key);
      const innerBase = resolve(spec.inner);
      visiting.delete(key);
      if (innerBase === null) return null;
      level = depth.get(spec.inner)! + 1;
      if (level > PACK_LIMITS.nesting)
        return fail(
          'pack_nesting_too_deep',
          key,
          `Packs nest at most ${PACK_LIMITS.nesting} deep.`,
        );
      // Both factors have at most 6 decimal places, so 12 keeps the product exact.
      value = normalize(multiply(spec.quantity, innerBase, 12));
    }
    if (compare(value, MAX_QUANTITY) > 0)
      return fail('pack_too_large', key, `${spec.name} holds more units than can be stored.`);
    if (decimalScale(value) > quantityScale) {
      return fail(
        'pack_breaks_quantity_scale',
        key,
        quantityScale === 0
          ? `${spec.name} must hold a whole number of base units.`
          : `${spec.name} must hold base units with at most ${quantityScale} decimal places.`,
      );
    }
    base.set(key, value);
    depth.set(key, level);
    return value;
  };

  for (const spec of specs) {
    if (resolve(spec.key) === null || problem) break;
  }
  // Assigned inside resolve(), which TypeScript's narrowing does not follow.
  return (problem as PackResolution | null) ?? { ok: true, base, depth };
}
