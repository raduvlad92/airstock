// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE,
  CASE,
  type Call,
  item,
  LOC,
  LOCATION,
  mockApi,
  OPERATOR,
  PROD,
  renderScan,
  SHOP,
  SLAB,
  STOCK,
  scan,
  scanRoutes,
  VAR,
} from './scan-kit.tsx';

// The scan page's flows against a stubbed API (plan 5.12): look up, location labels, receive with
// packs, serials, and costs, and an unknown code attached or created. The server side of each
// call has its own tests; these check what the page sends and shows.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('scan page: look up', () => {
  it('shows an item with its stock per location, and a location label sets the location', async () => {
    const calls = mockApi({
      ...BASE(OPERATOR),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        '4006381333931': { code: '4006381333931', kind: 'item', item: item(), stock: STOCK },
      }),
    });
    renderScan();
    await scan(LOCATION.code);
    expect(await screen.findByRole('status')).toHaveProperty(
      'textContent',
      'Location: Main stock/B-02',
    );
    await scan('4006381333931');
    expect(await screen.findByRole('heading', { name: 'Booster box' })).toBeTruthy();
    expect(screen.getByText('Single unit')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Stock per location' });
    expect(list.textContent).toContain('Main stock/B-02');
    expect(list.textContent).toContain('2 reserved');
    expect(calls.filter((c) => c.path === `/shops/${SHOP}/scan`).map((c) => c.query.code)).toEqual([
      LOCATION.code,
      '4006381333931',
    ]);
  });
});

describe('scan page: receive', () => {
  it('receives cases into the current location, showing the quantity and pack first', async () => {
    const calls = mockApi({
      ...BASE(OPERATOR),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        'CASE-BOX-6': {
          code: 'CASE-BOX-6',
          kind: 'item',
          item: item({ pack: { packId: CASE, name: 'Case', baseQuantity: '6' } }),
          stock: STOCK,
        },
      }),
      [`POST /shops/${SHOP}/receipts`]: { quantity: '12', variantId: VAR },
    });
    renderScan('?flow=receive');
    expect(await screen.findByText('Scan a location label first, then the item.')).toBeTruthy();
    await scan(LOCATION.code);
    await scan('CASE-BOX-6');
    expect(await screen.findByText('1 × Case (6) = 6 units → Main stock/B-02')).toBeTruthy();
    // Scanning the same case again adds one; no cost field without costs.read.
    await scan('CASE-BOX-6');
    expect(await screen.findByText('2 × Case (6) = 12 units → Main stock/B-02')).toBeTruthy();
    expect(screen.queryByLabelText('Unit cost')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Receive 12' }));
    await waitFor(() => expect(calls.some((c) => c.path === `/shops/${SHOP}/receipts`)).toBe(true));
    const receipt = calls.find((c) => c.path === `/shops/${SHOP}/receipts`)!;
    expect(receipt.body).toEqual({ variantId: VAR, locationId: LOC, quantity: '2', packId: CASE });
    expect(receipt.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(await screen.findByText(/Received 12 × BOX-1 into Main stock\/B-02/)).toBeTruthy();
  });

  it('captures serials one by one and a unit cost with costs.read', async () => {
    const calls = mockApi({
      ...BASE([...OPERATOR, 'costs.read']),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        'SLAB-1': {
          code: 'SLAB-1',
          kind: 'item',
          item: item({
            variantId: SLAB,
            sku: 'SLAB-1',
            productName: 'Graded slab',
            trackingMode: 'serial',
            matchedBy: 'sku',
            packs: [],
          }),
          stock: null,
        },
      }),
      [`POST /shops/${SHOP}/receipts`]: { quantity: '2', variantId: SLAB },
    });
    renderScan('?flow=receive');
    await scan(LOCATION.code);
    await scan('SLAB-1');
    expect(await screen.findByText('One serial per unit. Scan them one by one.')).toBeTruthy();
    // Unknown codes become serials; a repeat is refused.
    await scan('84731629');
    await scan('84731630');
    await scan('84731630');
    expect(await screen.findByText('84731630 is already in this receipt.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Serials' }).textContent).toContain('84731629');
    fireEvent.change(screen.getByLabelText('Unit cost'), { target: { value: '300,50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Receive 2' }));
    await waitFor(() => expect(calls.some((c) => c.path === `/shops/${SHOP}/receipts`)).toBe(true));
    expect(calls.find((c) => c.path === `/shops/${SHOP}/receipts`)!.body).toEqual({
      variantId: SLAB,
      locationId: LOC,
      quantity: '2',
      serials: ['84731629', '84731630'],
      unitCost: '300.50',
      costPer: 'base_unit',
    });
  });
});

describe('scan page: unknown codes', () => {
  it('attaches an unknown code to an item found by search', async () => {
    let attached = false;
    const calls = mockApi({
      ...BASE([...OPERATOR, 'catalog.write']),
      [`/shops/${SHOP}/scan`]: (call: Call) =>
        attached && call.query.code === '5901234123457'
          ? { code: '5901234123457', kind: 'item', item: item(), stock: STOCK }
          : { code: call.query.code, kind: 'unknown', location: null, item: null, stock: null },
      [`POST /shops/${SHOP}/items/query`]: {
        rows: [{ variantId: VAR, productId: PROD, name: 'Booster box', title: null, sku: 'BOX-1' }],
        nextCursor: null,
      },
      [`/shops/${SHOP}/variants/${VAR}/packaging`]: {
        barcodesVersion: 4,
        barcodes: [{ code: '4006381333931', symbology: 'ean13', packId: null }],
      },
      [`POST /shops/${SHOP}/variants/${VAR}/barcodes`]: () => {
        attached = true;
        return { packaging: {} };
      },
    });
    renderScan();
    await scan('5901234123457');
    expect(await screen.findByRole('heading', { name: 'Unknown code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Attach to an item' }));
    fireEvent.change(screen.getByLabelText('Find the item'), { target: { value: 'boost' } });
    fireEvent.click(await screen.findByRole('button', { name: /Booster box/ }));
    expect(await screen.findByRole('heading', { name: 'Booster box' })).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/barcodes'))!.body).toEqual({
      barcodesVersion: 4,
      barcodes: [
        { code: '4006381333931', symbology: 'ean13', packId: null },
        { code: '5901234123457', symbology: 'ean13' },
      ],
    });
  });

  it('creates an item with the code after the duplicate check', async () => {
    let created = false;
    const calls = mockApi({
      ...BASE([...OPERATOR, 'catalog.write']),
      [`/shops/${SHOP}/scan`]: (call: Call) =>
        created
          ? { code: 'PSA-99', kind: 'item', item: item({ sku: 'PSA-99' }), stock: STOCK }
          : { code: call.query.code, kind: 'unknown', location: null, item: null, stock: null },
      [`POST /shops/${SHOP}/items/duplicates`]: {
        skuTaken: null,
        barcodeTaken: null,
        similarNames: [{ productId: PROD, name: 'Charizard slab', similarity: 0.7 }],
      },
      [`POST /shops/${SHOP}/items`]: () => {
        created = true;
        return { productId: PROD, variantId: VAR, sku: 'PSA-99' };
      },
    });
    renderScan();
    await scan('PSA-99');
    fireEvent.click(await screen.findByRole('button', { name: 'Create new item' }));
    expect((screen.getByLabelText('SKU') as HTMLInputElement).value).toBe('PSA-99');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Charizard slab 2' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '450' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create with this code' }));
    // A similar name needs a second, deliberate tap.
    fireEvent.click(await screen.findByRole('button', { name: 'Create anyway' }));
    expect(await screen.findByText('PSA-99 now belongs to PSA-99.')).toBeTruthy();
    expect(
      calls.find((c) => c.method === 'POST' && c.path === `/shops/${SHOP}/items`)!.body,
    ).toEqual({
      name: 'Charizard slab 2',
      sku: 'PSA-99',
      price: '450',
      barcode: 'PSA-99',
      acknowledgeSimilar: true,
    });
  });
});
