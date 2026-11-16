import type { Tx } from '@airstock/db';
import { findBarcodeOwners, normalizeBarcode } from '../catalog/barcodes.ts';
import { csvLine } from '../csv.ts';
import { normalizeSku } from '../schemas.ts';

// The onboarding import (plan Section 5.14, D17): a store's catalog as read with a bulk
// operation, matched against the shop's catalog, and written as a CSV for the import job
// (ADR 0018), so new records go through the same preview, duplicate check, chunks, checkpoints,
// and opening-stock receipts as any import.

export interface CatalogImage {
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
}

export interface CatalogVariant {
  variantId: string;
  inventoryItemId: string | null;
  sku: string | null;
  barcode: string | null;
  title: string;
  price: string | null;
  options: Array<{ name: string; value: string }>;
  tracked: boolean;
  /** Shopify's `available` per Shopify location ID. */
  levels: Array<{ locationId: string; available: number }>;
  image: CatalogImage | null;
}

export interface CatalogProduct {
  productId: string;
  title: string;
  description: string | null;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED' | string;
  options: string[];
  images: CatalogImage[];
  variants: CatalogVariant[];
}

export type MatchKind = 'sku' | 'barcode' | 'new' | 'skipped';

export interface MatchedRow {
  shopifyVariantId: string;
  shopifyProductId: string;
  shopifyInventoryItemId: string | null;
  sku: string | null;
  barcode: string | null;
  title: string;
  match: MatchKind;
  variantId: string | null;
  packId: string | null;
  /** The SKU the import writes for a new variant. */
  importSku: string | null;
  importRow: number | null;
  note: string | null;
}

/** Shopify's placeholder for a product without options. */
const DEFAULT_OPTION = 'Title';
const DEFAULT_VALUE = 'Default Title';

export function realOptions(product: CatalogProduct): string[] {
  return product.options.filter(
    (name) =>
      !(
        name === DEFAULT_OPTION &&
        product.variants.every((v) =>
          v.options.every((o) => o.name !== DEFAULT_OPTION || o.value === DEFAULT_VALUE),
        )
      ),
  );
}

/**
 * Matches every Shopify variant: by SKU (normalized as Airstock does), then by barcode (a variant's
 * own barcode, or one of its packs': then the Shopify variant sells that pack). Variants that
 * match nothing are new. An archived Shopify product, an untracked item, and a second Shopify
 * variant matching the same record are skipped with a note.
 */
export async function matchCatalog(
  tx: Tx,
  products: CatalogProduct[],
  alreadyMapped: Map<string, { variantId: string; packId: string | null }>,
): Promise<MatchedRow[]> {
  const all = products.flatMap((p) => p.variants.map((v) => ({ p, v })));
  const skus = [...new Set(all.flatMap(({ v }) => (v.sku?.trim() ? [normalizeSku(v.sku)] : [])))];
  const bySku = new Map(
    (
      await tx.query<{ id: string; sku_normalized: string }>(
        `select id, sku_normalized from variants where status = 'active'
         and sku_normalized = any($1::text[])`,
        [skus],
      )
    ).map((r) => [r.sku_normalized, r.id]),
  );
  const codes = [
    ...new Set(all.flatMap(({ v }) => (v.barcode?.trim() ? [normalizeBarcode(v.barcode)] : []))),
  ];
  const owners = new Map<string, { variantId: string; packId: string | null }>();
  for (let i = 0; i < codes.length; i += 1000) {
    for (const o of await findBarcodeOwners(tx, codes.slice(i, i + 1000))) {
      owners.set(normalizeBarcode(o.code), { variantId: o.variantId, packId: o.packId });
    }
  }
  const used = new Set<string>();
  const usedSkus = new Set<string>(bySku.keys());
  const out: MatchedRow[] = [];
  for (const { p, v } of all) {
    const base = {
      shopifyVariantId: v.variantId,
      shopifyProductId: p.productId,
      shopifyInventoryItemId: v.inventoryItemId,
      sku: v.sku?.trim() || null,
      barcode: v.barcode?.trim() || null,
      title: v.title && v.title !== DEFAULT_VALUE ? `${p.title} / ${v.title}` : p.title,
      importSku: null,
      importRow: null,
    };
    const existing = alreadyMapped.get(v.variantId);
    let target: { variantId: string; packId: string | null } | null = existing ?? null;
    let match: MatchKind = existing ? 'sku' : 'new';
    if (!target && base.sku) {
      const id = bySku.get(normalizeSku(base.sku));
      if (id) {
        target = { variantId: id, packId: null };
        match = 'sku';
      }
    }
    if (!target && base.barcode) {
      const owner = owners.get(normalizeBarcode(base.barcode));
      if (owner) {
        target = owner;
        match = 'barcode';
      }
    }
    if (target) {
      const key = `${target.variantId}:${target.packId ?? ''}`;
      if (used.has(key)) {
        out.push({
          ...base,
          match: 'skipped',
          variantId: null,
          packId: null,
          note: 'Another Shopify variant already matches the same record; map this one by hand.',
        });
        continue;
      }
      used.add(key);
      out.push({
        ...base,
        match,
        variantId: target.variantId,
        packId: target.packId,
        note: v.tracked ? null : 'Shopify does not track this item’s quantity; it is not pushed.',
      });
      continue;
    }
    if (p.status === 'ARCHIVED') {
      out.push({
        ...base,
        match: 'skipped',
        variantId: null,
        packId: null,
        note: 'Archived in Shopify: not imported.',
      });
      continue;
    }
    // A new variant needs a SKU here; Shopify's may be empty.
    let importSku = base.sku;
    let note: string | null = null;
    if (!importSku) {
      importSku = base.barcode ?? `SHOPIFY-${v.variantId}`;
      note = base.barcode
        ? 'No SKU in Shopify: the barcode is used as the SKU.'
        : 'No SKU or barcode in Shopify: a SKU was made from the Shopify ID.';
    }
    if (usedSkus.has(normalizeSku(importSku))) {
      importSku = `${importSku}-${v.variantId}`.slice(0, 100);
      note = 'The SKU repeats in Shopify: the Shopify ID was added to it.';
    }
    usedSkus.add(normalizeSku(importSku));
    out.push({ ...base, match: 'new', variantId: null, packId: null, importSku, note });
  }
  return out;
}

export interface OnboardingCsv {
  csv: string;
  mapping: Record<string, string>;
  rows: number;
}

/**
 * The CSV for new variants: one product per Shopify product (grouped by its ID), its options,
 * and opening stock at each mapped location's receiving location (Shopify's available, never
 * below zero). Writes each row's number into `matched`.
 */
export function onboardingCsv(
  products: CatalogProduct[],
  matched: MatchedRow[],
  receiveAt: Map<string, string>,
): OnboardingCsv | null {
  const byVariant = new Map(matched.map((m) => [m.shopifyVariantId, m]));
  const optionNames = [...new Set(products.flatMap(realOptions))];
  const stockLocations = [...new Set(receiveAt.values())];
  const header = [
    'Product key',
    'Name',
    'Description',
    'Status',
    'SKU',
    'Barcode',
    'Price',
    ...optionNames.map((n) => `Option ${n}`),
    ...stockLocations.map((id) => `Stock ${id}`),
  ];
  const mapping: Record<string, string> = {
    'Product key': 'product',
    Name: 'name',
    Description: 'description',
    Status: 'status',
    SKU: 'sku',
    Barcode: 'barcode',
    Price: 'price',
  };
  for (const n of optionNames) mapping[`Option ${n}`] = `option:${n}`;
  for (const id of stockLocations) mapping[`Stock ${id}`] = `stock:${id}`;
  const lines = [csvLine(header)];
  let row = 0;
  for (const p of products) {
    const options = new Set(realOptions(p));
    for (const v of p.variants) {
      const m = byVariant.get(v.variantId);
      if (!m || m.match !== 'new') continue;
      const stock = new Map<string, number>();
      for (const level of v.levels) {
        const at = receiveAt.get(level.locationId);
        if (at && v.tracked) stock.set(at, (stock.get(at) ?? 0) + Math.max(0, level.available));
      }
      row++;
      // The import numbers rows as lines of the file, the header being line 1.
      m.importRow = row + 1;
      lines.push(
        csvLine([
          `shopify-${p.productId}`,
          p.title.slice(0, 500),
          p.description?.slice(0, 20_000) ?? '',
          p.status === 'DRAFT' ? 'draft' : 'active',
          m.importSku,
          m.barcode ?? '',
          v.price ?? '',
          ...optionNames.map((n) =>
            options.has(n) ? (v.options.find((o) => o.name === n)?.value ?? '') : '',
          ),
          ...stockLocations.map((id) => {
            const q = stock.get(id);
            return q ? String(q) : '';
          }),
        ]),
      );
    }
  }
  if (row === 0) return null;
  return { csv: `${lines.join('\n')}\n`, mapping, rows: row };
}
