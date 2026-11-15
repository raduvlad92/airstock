import { ops } from '@airstock/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  appDatabase,
  type Harness,
  harness,
  MemoryAuditSink,
  ownerQuery,
  type SeededShop,
  seedShop,
} from '../../../test/helpers.ts';

// D4 and A17: bulk edits are previewed, then committed all or nothing; a stale preview is rejected.

const db = appDatabase();
const sink = new MemoryAuditSink();
let shop: SeededShop;
let h: Harness;
const items: Array<{ productId: string; variantId: string }> = [];

beforeAll(async () => {
  shop = await seedShop(db, sink, 'Bulk shop');
  h = harness(db, sink, shop);
  for (const [i, name] of ['Alpha kettle', 'Bravo toaster', 'Charlie blender'].entries()) {
    items.push(await h.run(ops.createItem, { name, sku: `BULK-${i}`, price: '10' }));
  }
});
afterAll(() => db.close());

describe('bulk edit preview and commit (D4)', () => {
  it('previews values before and after, then commits every change', async () => {
    const preview = await h.run(ops.previewBulkEdit, {
      edits: items.map((x, i) => ({
        productId: x.productId,
        variantId: x.variantId,
        field: 'price',
        value: `${12 + i}`,
      })),
    });
    expect(preview.previewId).toBeTruthy();
    expect(preview.records).toBe(3);
    expect(
      preview.lines.map((l: { before: string; after: string }) => [l.before, l.after]),
    ).toEqual([
      ['10.000000', '12'],
      ['10.000000', '13'],
      ['10.000000', '14'],
    ]);
    // Nothing is saved yet.
    expect(
      (await h.run(ops.getItem, { productId: items[0]!.productId })).item.variants[0].price,
    ).toBe('10.000000');
    const done = await h.run(ops.commitBulkEdit, { previewId: preview.previewId });
    expect(done.records).toHaveLength(3);
    expect(
      (await h.run(ops.getItem, { productId: items[2]!.productId })).item.variants[0].price,
    ).toBe('14.000000');
    // Each record's history has its change.
    const rows = await ownerQuery<{ n: number }>(
      `select count(*)::int as n from audit_events where target_id = any($1) and changes->'fields' ? 'price'`,
      [items.map((x) => x.variantId)],
    );
    expect(rows[0]!.n).toBe(3);
    await expect(h.run(ops.commitBulkEdit, { previewId: preview.previewId })).rejects.toMatchObject(
      { code: 'preview_closed' },
    );
  });

  it('A17: rejects a preview whose records changed before commit, and saves nothing', async () => {
    const preview = await h.run(ops.previewBulkEdit, {
      edits: [
        { productId: items[0]!.productId, field: 'name', value: 'Alpha kettle XL' },
        { productId: items[1]!.productId, field: 'name', value: 'Bravo toaster XL' },
      ],
    });
    // Someone else renames the second product meanwhile.
    const other = await addMember(shop.shopId, 'catalog_editor');
    await h.run(
      ops.updateItem,
      {
        productId: items[1]!.productId,
        changes: [{ field: 'name', expected: 'Bravo toaster', value: 'Bravo grill' }],
      },
      { caller: other.caller },
    );
    await expect(h.run(ops.commitBulkEdit, { previewId: preview.previewId })).rejects.toMatchObject(
      {
        status: 409,
        code: 'preview_stale',
      },
    );
    // All or nothing: the first product kept its name.
    expect((await h.run(ops.getItem, { productId: items[0]!.productId })).item.product.name).toBe(
      'Alpha kettle',
    );
    // A new preview shows the new value and commits.
    const again = await h.run(ops.previewBulkEdit, {
      edits: [
        { productId: items[0]!.productId, field: 'name', value: 'Alpha kettle XL' },
        { productId: items[1]!.productId, field: 'name', value: 'Bravo toaster XL' },
      ],
    });
    expect(again.lines[1].before).toBe('Bravo grill');
    await h.run(ops.commitBulkEdit, { previewId: again.previewId });
    expect((await h.run(ops.getItem, { productId: items[1]!.productId })).item.product.name).toBe(
      'Bravo toaster XL',
    );
  });

  it('returns no preview when a change is invalid, and refuses other callers and more than 500 records', async () => {
    const bad = await h.run(ops.previewBulkEdit, {
      edits: [
        {
          productId: items[0]!.productId,
          variantId: items[0]!.variantId,
          field: 'price',
          value: '-1',
        },
        {
          productId: items[1]!.productId,
          variantId: items[1]!.variantId,
          field: 'price',
          value: '5',
        },
      ],
    });
    expect(bad.previewId).toBeNull();
    expect(bad.errors).toEqual([
      expect.objectContaining({ productId: items[0]!.productId, code: 'validation_failed' }),
    ]);
    const ok = await h.run(ops.previewBulkEdit, {
      edits: [
        {
          productId: items[1]!.productId,
          variantId: items[1]!.variantId,
          field: 'price',
          value: '5',
        },
      ],
    });
    const other = await addMember(shop.shopId, 'manager');
    await expect(
      h.run(ops.commitBulkEdit, { previewId: ok.previewId }, { caller: other.caller }),
    ).rejects.toMatchObject({
      status: 404,
    });
    const many = Array.from({ length: 501 }, () => ({
      productId: items[0]!.productId,
      variantId: crypto.randomUUID(),
      field: 'price',
      value: '1',
    }));
    await expect(h.run(ops.previewBulkEdit, { edits: many })).rejects.toMatchObject({
      code: 'too_many_records',
    });
  });
});
