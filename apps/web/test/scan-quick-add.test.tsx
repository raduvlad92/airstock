// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadToProduct } from '../src/components/media/upload.ts';
import {
  BASE,
  type Call,
  item,
  LOC,
  LOCATION,
  mockApi,
  OPERATOR,
  PROD,
  Problem,
  renderScan,
  SHOP,
  SLAB,
  scan,
  scanRoutes,
  VAR,
} from './scan-kit.tsx';

// Quick add on the scan page (plan 5.7, D5): pictures, the certificate, the family's fields,
// price and cost, one quick_add command, then the pictures linked. Picture preparation and the
// byte upload are stood in for (their own tests cover them); the rest goes through the stubbed API.

vi.mock('../src/components/media/derivatives.ts', async (original) => ({
  ...(await original<typeof import('../src/components/media/derivatives.ts')>()),
  prepareFile: vi.fn(async (file: File) => ({
    original: file,
    fileName: file.name,
    contentType: 'image/jpeg',
    sha256: 'ab'.repeat(32),
    derivatives: null,
  })),
}));

vi.mock('../src/components/media/upload.ts', () => ({
  uploadToProduct: vi.fn(
    async (_shop: string, _product: string, _file: unknown, onProgress: (n: number) => void) => {
      onProgress(1);
      return {};
    },
  ),
}));

const FAMILY = '0196f3a0-0000-7000-8000-00000000fa01';
const F_COND = '0196f3a0-0000-7000-8000-00000000fb01';
const F_GRADE = '0196f3a0-0000-7000-8000-00000000fb02';
const F_CERT = '0196f3a0-0000-7000-8000-00000000fb03';
const NM = '0196f3a0-0000-7000-8000-00000000fc01';
const OP = '0196f3a0-0000-7000-8000-000000000999';

function field(id: string, key: string, label: string, type: string, options: string[] = []) {
  return {
    id,
    key,
    label,
    description: null,
    type,
    level: 'variant',
    config: {},
    defaultValue: null,
    visibility: 'everyone',
    status: 'active',
    isSystem: false,
    version: 1,
    options: options.map((o, i) => ({
      id: i === 0 ? NM : `${NM.slice(0, -2)}0${i}`,
      label: o,
      position: i,
      archived: false,
    })),
  };
}

const SCHEMA = {
  fields: [
    field(F_COND, 'card_condition', 'Condition', 'single_select', ['NM', 'LP']),
    field(F_GRADE, 'grade', 'Grade', 'decimal'),
    field(F_CERT, 'certificate_number', 'Certificate', 'text'),
  ],
  families: [
    {
      id: FAMILY,
      name: 'Trading cards',
      description: null,
      templateKey: 'trading_cards',
      status: 'active',
      version: 1,
      fields: [
        { fieldId: F_COND, key: 'card_condition', required: false, position: 0, group: null },
        { fieldId: F_GRADE, key: 'grade', required: false, position: 1, group: null },
        { fieldId: F_CERT, key: 'certificate_number', required: false, position: 2, group: null },
      ],
      suggestedOptions: [],
    },
  ],
  templates: [
    { key: 'trading_cards', name: 'Trading cards', description: '', added: true },
    { key: 'building_sets', name: 'Building sets', description: '', added: false },
  ],
  units: { display: 'metric', kinds: {} },
  limits: {},
  currency: 'EUR',
};

const ADDER = [...OPERATOR, 'catalog.write', 'costs.read'];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.mocked(uploadToProduct).mockClear();
  localStorage.clear();
});

describe('scan page: quick add', () => {
  it('adds a graded card with its pictures, certificate, family fields, price, and cost', async () => {
    const calls = mockApi({
      ...BASE(ADDER),
      [`/shops/${SHOP}/scan`]: scanRoutes({ [LOCATION.code]: LOCATION }),
      [`/shops/${SHOP}/catalog/schema`]: SCHEMA,
      [`POST /shops/${SHOP}/quick-add`]: (call: Call) =>
        (call.body as { acknowledgeSimilar: boolean }).acknowledgeSimilar
          ? {
              productId: PROD,
              variantId: VAR,
              sku: 'PSA-12345678',
              created: true,
              receipt: { operationId: OP, positionId: OP, serialId: null },
            }
          : new Problem(409, {
              code: 'similar_items_found',
              title: 'Products with similar names already exist.',
              similarNames: [{ productId: SLAB, name: 'Charizard Holo PSA 9' }],
            }),
    });
    renderScan('?flow=quick-add');
    expect(await screen.findByRole('heading', { name: 'One-of-a-kind item' })).toBeTruthy();
    await scan(LOCATION.code);

    // A picture from the camera, then the slab's certificate scanned.
    const photo = new File(['jpeg'], 'slab.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByLabelText('Take picture', { selector: 'input' }), {
      target: { files: [photo] },
    });
    await scan('PSA-12345678');
    expect(await screen.findByText('Certificate PSA-12345678.')).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Certificate number' }) as HTMLInputElement).value,
    ).toBe('PSA-12345678');

    // Trading cards is chosen by default; its key fields are on the form.
    await waitFor(() =>
      expect((screen.getByLabelText('Family') as HTMLSelectElement).value).toBe(FAMILY),
    );
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Charizard Holo' } });
    fireEvent.change(screen.getByLabelText('Condition'), { target: { value: NM } });
    fireEvent.change(screen.getByLabelText('Grade'), { target: { value: '9,5' } });
    fireEvent.change(screen.getByLabelText('Price'), { target: { value: '450' } });
    fireEvent.change(screen.getByLabelText('Cost'), { target: { value: '300' } });
    // Listing on Shopify waits for the connector.
    expect(screen.getByRole('checkbox', { name: /List on Shopify/ })).toHaveProperty(
      'disabled',
      true,
    );
    expect(
      await screen.findByText('1 unit of Charizard Holo at 450 EUR → Main stock/B-02 · 1 picture'),
    ).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: 'Add 1 unit' }));
    // A similar name needs a deliberate second tap.
    fireEvent.click(await screen.findByRole('button', { name: 'Add anyway' }));
    expect(await screen.findByRole('heading', { name: 'Added Charizard Holo' })).toBeTruthy();
    expect(await screen.findByText('Linked')).toBeTruthy();

    const sent = calls.filter((c) => c.method === 'POST' && c.path === `/shops/${SHOP}/quick-add`);
    const body = {
      locationId: LOC,
      name: 'Charizard Holo',
      price: '450',
      barcode: 'PSA-12345678',
      family: FAMILY,
      fields: { card_condition: NM, grade: '9.5', certificate_number: 'PSA-12345678' },
      unitCost: '300',
    };
    expect(sent.map((c) => c.body)).toEqual([
      { ...body, acknowledgeSimilar: false },
      { ...body, acknowledgeSimilar: true },
    ]);
    // Acknowledging similar names is a new request, under a new idempotency key.
    expect(sent[0]!.key).not.toBe(sent[1]!.key);
    // One command, then the picture is uploaded and linked to the new product.
    expect(vi.mocked(uploadToProduct)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(uploadToProduct).mock.calls[0]!.slice(0, 2)).toEqual([SHOP, PROD]);
    expect(
      await screen.findByText(
        /Added Charizard Holo \(PSA-12345678\) at Main stock\/B-02, 1 of 1 pictures/,
      ),
    ).toBeTruthy();
  });

  it('is offered for an unknown code, which becomes the certificate', async () => {
    mockApi({
      ...BASE(ADDER),
      [`/shops/${SHOP}/scan`]: scanRoutes({}),
      [`/shops/${SHOP}/catalog/schema`]: SCHEMA,
    });
    renderScan();
    await scan('CGC-4400112');
    fireEvent.click(
      await screen.findByRole('button', { name: 'Quick add as a one-of-a-kind item' }),
    );
    expect(await screen.findByRole('heading', { name: 'One-of-a-kind item' })).toBeTruthy();
    expect(
      (screen.getByRole('textbox', { name: 'Certificate number' }) as HTMLInputElement).value,
    ).toBe('CGC-4400112');
  });

  it('adds a serialized unit to an item whose units share a price', async () => {
    const calls = mockApi({
      ...BASE(ADDER),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        'SLAB-1': {
          code: 'SLAB-1',
          kind: 'item',
          item: item({
            variantId: SLAB,
            sku: 'SLAB-1',
            productName: 'PSA 10 Pikachu',
            trackingMode: 'serial',
            matchedBy: 'sku',
            packs: [],
          }),
          stock: null,
        },
      }),
      [`/shops/${SHOP}/catalog/schema`]: SCHEMA,
      [`POST /shops/${SHOP}/quick-add`]: {
        productId: PROD,
        variantId: SLAB,
        sku: 'SLAB-1',
        created: false,
        receipt: { operationId: OP, positionId: OP, serialId: OP },
      },
    });
    renderScan('?flow=quick-add');
    fireEvent.click(await screen.findByRole('button', { name: 'Unit of a shared item' }));
    await scan(LOCATION.code);
    await scan('SLAB-1');
    expect(await screen.findByRole('heading', { name: 'PSA 10 Pikachu' })).toBeTruthy();
    await scan('84731629');
    expect(
      await screen.findByText('1 unit of SLAB-1 · SN 84731629 → Main stock/B-02'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 unit' }));
    expect(
      await screen.findByText('Added SLAB-1 serial 84731629 at Main stock/B-02.'),
    ).toBeTruthy();
    expect(
      calls.find((c) => c.method === 'POST' && c.path === `/shops/${SHOP}/quick-add`)!.body,
    ).toEqual({ locationId: LOC, variantId: SLAB, serial: '84731629' });
  });
});
