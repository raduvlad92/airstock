// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
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
  Problem,
  renderScan,
  SHOP,
  STOCK,
  scan,
  scanRoutes,
  VAR,
} from './scan-kit.tsx';

// Count, Move, and receiving against a purchase order on the scan page (plan 5.6, 5.4, 5.8,
// 5.12), against a stubbed API: what each flow sends, and the choices it asks for first.

const VAR2 = '0196f3a0-0000-7000-8000-0000000000d3';
const LOC2 = '0196f3a0-0000-7000-8000-0000000000b2';
const ALLOC = '0196f3a0-0000-7000-8000-000000000a01';
const RES = '0196f3a0-0000-7000-8000-000000000a02';
const SESSION = '0196f3a0-0000-7000-8000-000000000c01';
const LINE1 = '0196f3a0-0000-7000-8000-000000000c11';
const LINE2 = '0196f3a0-0000-7000-8000-000000000c12';
const LIST = '0196f3a0-0000-7000-8000-000000000e01';
const PICK_LINE = '0196f3a0-0000-7000-8000-000000000e11';
const POS = '0196f3a0-0000-7000-8000-000000000101';
const PO = '0196f3a0-0000-7000-8000-000000000f01';
const PO_LINE = '0196f3a0-0000-7000-8000-000000000f11';
const OP = '0196f3a0-0000-7000-8000-000000000999';
const WH = LOCATION.location.warehouseId;

const COUNTER = [...OPERATOR, 'inventory.count'];

const CASE_SCAN = {
  code: 'CASE-BOX-6',
  kind: 'item',
  item: item({ pack: { packId: CASE, name: 'Case', baseQuantity: '6' } }),
  stock: STOCK,
};
const UNIT_SCAN = { code: '4006381333931', kind: 'item', item: item(), stock: STOCK };

function location(id: string, path: string, warehouseId = WH) {
  return {
    code: `LOC:${id.toUpperCase()}`,
    kind: 'location',
    location: {
      locationId: id,
      warehouseId,
      warehouseName: 'Main stock',
      path,
      code: null,
      holdsStock: true,
    },
    item: null,
    stock: null,
  };
}

const CHANGES = {
  released: [],
  reallocated: [],
  shortagesFilled: [],
  costVisible: false,
  unitCosts: null,
};

function posts(calls: Call[], path: string) {
  return calls.filter((c) => c.method === 'POST' && c.path === path);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('scan page: quick count', () => {
  it('counts a shelf by scanning, shows packs first, and asks before releasing reserved units', async () => {
    const calls = mockApi({
      ...BASE(COUNTER),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        'CASE-BOX-6': CASE_SCAN,
        '4006381333931': UNIT_SCAN,
      }),
      [`POST /shops/${SHOP}/counts/quick`]: (call: Call) =>
        (call.body as { reservationChoices?: unknown }).reservationChoices
          ? {
              operationId: OP,
              sessionId: SESSION,
              ...CHANGES,
              changes: [
                {
                  variantId: VAR,
                  locationId: LOC,
                  condition: 'sellable',
                  lotId: null,
                  serialId: null,
                  delta: '-12',
                },
              ],
              released: [{ allocationId: ALLOC, reservationId: RES, quantity: '2' }],
            }
          : new Problem(409, {
              code: 'below_reserved',
              title: 'This leaves fewer units than are reserved.',
              positions: [
                {
                  positionId: POS,
                  variantId: VAR,
                  locationId: LOC,
                  onHandAfter: '0',
                  reserved: '2',
                  toResolve: '2',
                  allocations: [
                    {
                      allocationId: ALLOC,
                      reservationId: RES,
                      purpose: 'manual',
                      externalRef: 'api:order/7',
                      outstanding: '2',
                    },
                  ],
                },
              ],
            }),
    });
    renderScan('?flow=count');
    expect(
      await screen.findByText('Scan the shelf’s location label, then every item on it.'),
    ).toBeTruthy();
    await scan(LOCATION.code);
    expect(await screen.findByRole('heading', { name: 'Count Main stock/B-02' })).toBeTruthy();
    // Each case scan adds a case; the quantity and pack read out before anything is sent.
    await scan('CASE-BOX-6');
    await scan('CASE-BOX-6');
    const toConfirm = () => screen.getByRole('list', { name: 'To confirm' }).textContent;
    await waitFor(() => expect(toConfirm()).toBe('BOX-1: 2 × Case (6) = 12 units'));
    expect(screen.getByText(/On record here: 12 \(2 reserved\)/)).toBeTruthy();
    // A loose unit mixed in switches the tally to units.
    await scan('4006381333931');
    await waitFor(() => expect(toConfirm()).toBe('BOX-1: 13 units'));
    // Typed: none left on the shelf.
    fireEvent.change(screen.getByLabelText('Counted'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm count of 1 item' }));

    // Below reserved: nothing is released until the person chooses, per claim.
    expect(await screen.findByRole('heading', { name: 'Reserved stock' })).toBeTruthy();
    expect(
      screen.getByText(/BOX-1 at Main stock\/B-02: 2 reserved units need a decision/),
    ).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply with these choices' });
    expect(apply).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Release' }));
    expect(apply).toHaveProperty('disabled', false);
    fireEvent.click(apply);
    expect(await screen.findByText(/Counted at Main stock\/B-02: BOX-1 -12/)).toBeTruthy();

    const sent = posts(calls, `/shops/${SHOP}/counts/quick`);
    expect(sent.map((c) => c.body)).toEqual([
      { locationId: LOC, counts: [{ variantId: VAR, counted: '0' }] },
      {
        locationId: LOC,
        counts: [{ variantId: VAR, counted: '0' }],
        reservationChoices: [{ allocationId: ALLOC, action: 'release', quantity: '2' }],
      },
    ]);
    // A changed request is a new command, with its own idempotency key.
    expect(sent[0]!.key).not.toBe(sent[1]!.key);
  });

  it('opens on a short-picked shelf from Pick, with the item listed and what is missing', async () => {
    localStorage.setItem(`airstock.scan.pick.${SHOP}`, LIST);
    const pickLine = {
      lineId: PICK_LINE,
      sequence: 1,
      status: 'open',
      locationId: LOC,
      locationPath: 'Main stock/B-02',
      variantId: VAR,
      sku: 'BOX-1',
      productName: 'Booster box',
      variantName: null,
      lotId: null,
      lotCode: null,
      serial: null,
      externalRef: 'api:order/7',
      quantity: '2',
      remaining: '2',
      inPacks: { packs: [], looseUnits: '2' },
    };
    const calls = mockApi({
      ...BASE([...COUNTER, 'picking.run']),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        'BOX-1': { ...UNIT_SCAN, code: 'BOX-1', item: item({ matchedBy: 'sku' }) },
      }),
      [`/shops/${SHOP}/pick-lists/${LIST}`]: {
        pickListId: LIST,
        number: 3,
        status: 'open',
        lines: 1,
        shortLines: 0,
        pickLines: [pickLine],
      },
      [`POST /shops/${SHOP}/pick-lists/${LIST}/short-picks`]: {
        openLines: 0,
        count: {
          positionId: POS,
          locationId: LOC,
          variantId: VAR,
          lotId: null,
          serialId: null,
          missing: '2',
          picked: '0',
        },
      },
      [`POST /shops/${SHOP}/counts/quick`]: {
        operationId: OP,
        sessionId: SESSION,
        ...CHANGES,
        changes: [],
      },
    });
    renderScan('?flow=pick');
    expect(
      await screen.findByText('Main stock/B-02', { selector: '.scan-pick-stop' }),
    ).toBeTruthy();
    await scan(LOCATION.code);
    fireEvent.click(await screen.findByRole('button', { name: 'Short…' }));
    fireEvent.change(screen.getByLabelText('Found'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Only 0 found' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Count that shelf' }));

    expect(
      await screen.findByText(
        'Short pick: 2 × BOX-1 missing at Main stock/B-02. Count what is on the shelf.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Count Main stock/B-02' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'To confirm' }).textContent).toBe('BOX-1: 0 units'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirm count of 1 item' }));
    await waitFor(() => expect(posts(calls, `/shops/${SHOP}/counts/quick`)).toHaveLength(1));
    expect(posts(calls, `/shops/${SHOP}/counts/quick`)[0]!.body).toEqual({
      locationId: LOC,
      counts: [{ variantId: VAR, counted: '0' }],
    });
  });

  it('adds the units already picked from a short-picked shelf, and lists the short order first', async () => {
    localStorage.setItem(`airstock.scan.pick.${SHOP}`, LIST);
    const PICKED_ALLOC = '0196f3a0-0000-7000-8000-000000000a03';
    const calls = mockApi({
      ...BASE([...COUNTER, 'picking.run']),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        'BOX-1': { ...UNIT_SCAN, code: 'BOX-1', item: item({ matchedBy: 'sku' }) },
      }),
      [`/shops/${SHOP}/pick-lists/${LIST}`]: {
        pickListId: LIST,
        number: 4,
        status: 'open',
        lines: 2,
        shortLines: 0,
        pickLines: [
          {
            lineId: PICK_LINE,
            sequence: 2,
            status: 'open',
            locationId: LOC,
            locationPath: 'Main stock/B-02',
            variantId: VAR,
            sku: 'BOX-1',
            productName: 'Booster box',
            variantName: null,
            lotId: null,
            lotCode: null,
            serial: null,
            externalRef: 'api:order/8',
            quantity: '1',
            remaining: '1',
            inPacks: { packs: [], looseUnits: '1' },
          },
        ],
      },
      // Three boxes of another order were picked from this shelf earlier: they are in the tote.
      [`POST /shops/${SHOP}/pick-lists/${LIST}/short-picks`]: {
        openLines: 0,
        count: {
          positionId: POS,
          locationId: LOC,
          variantId: VAR,
          lotId: null,
          serialId: null,
          missing: '1',
          picked: '3',
        },
      },
      [`POST /shops/${SHOP}/counts/quick`]: (call: Call) =>
        (call.body as { reservationChoices?: unknown }).reservationChoices
          ? {
              operationId: OP,
              sessionId: SESSION,
              ...CHANGES,
              changes: [
                {
                  variantId: VAR,
                  locationId: LOC,
                  condition: 'sellable',
                  lotId: null,
                  serialId: null,
                  delta: '-9',
                },
              ],
              reallocated: [{ allocationId: ALLOC, reservationId: RES, quantity: '1', to: [] }],
            }
          : new Problem(409, {
              code: 'below_reserved',
              title: 'This leaves fewer units than are reserved.',
              positions: [
                {
                  positionId: POS,
                  variantId: VAR,
                  locationId: LOC,
                  onHandAfter: '3',
                  reserved: '4',
                  toResolve: '1',
                  allocations: [
                    {
                      allocationId: PICKED_ALLOC,
                      reservationId: RES,
                      purpose: 'external_order',
                      externalRef: 'api:order/7',
                      outstanding: '3',
                    },
                    {
                      allocationId: ALLOC,
                      reservationId: RES,
                      purpose: 'external_order',
                      externalRef: 'api:order/8',
                      outstanding: '1',
                    },
                  ],
                },
              ],
            }),
    });
    renderScan('?flow=pick');
    await scan(LOCATION.code);
    fireEvent.click(await screen.findByRole('button', { name: 'Short…' }));
    fireEvent.change(screen.getByLabelText('Found'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Only 0 found' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Count that shelf' }));

    expect(
      await screen.findByText(
        'Short pick: 1 × BOX-1 missing at Main stock/B-02. Count what is on the shelf. The 3 already picked from it are added.',
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('list', { name: 'To confirm' }).textContent).toBe(
        'BOX-1: 0 units + 3 picked',
      ),
    );
    expect(screen.getByText(/3 picked from here, added to the count/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm count of 1 item' }));

    // Only the short order's unit needs a decision: it comes first, marked.
    expect(await screen.findByRole('heading', { name: 'Reserved stock' })).toBeTruthy();
    const claims = screen.getAllByRole('listitem').filter((li) => li.closest('.scan-claim-list'));
    expect(claims.map((li) => li.querySelector('span')?.textContent)).toEqual([
      'api:order/8 1 reserved · short pick',
      'api:order/7 3 reserved',
    ]);
    fireEvent.click(within(claims[0]!).getByRole('button', { name: 'Move to other stock' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply with these choices' }));
    expect(await screen.findByText(/Counted at Main stock\/B-02: BOX-1 -9/)).toBeTruthy();
    expect(posts(calls, `/shops/${SHOP}/counts/quick`).map((c) => c.body)).toEqual([
      { locationId: LOC, counts: [{ variantId: VAR, counted: '3' }] },
      {
        locationId: LOC,
        counts: [{ variantId: VAR, counted: '3' }],
        reservationChoices: [{ allocationId: ALLOC, action: 'reallocate', quantity: '1' }],
      },
    ]);
  });
});

describe('scan page: quick bursts', () => {
  // A wedge scanner reads codes faster than lookups answer. Each scan is applied in the order it
  // was read, after the page shows the one before it.

  /** Types and submits each code at once, as a scanner does, without waiting for an answer. */
  async function burst(...codes: string[]) {
    const field = await screen.findByRole('textbox', { name: 'Code' });
    for (const code of codes) {
      fireEvent.change(field, { target: { value: code } });
      fireEvent.submit(field.closest('form')!);
    }
  }

  const toConfirm = () => screen.getByRole('list', { name: 'To confirm' }).textContent;

  it('counts both of two quick scans of the same case', async () => {
    mockApi({
      ...BASE(COUNTER),
      [`/shops/${SHOP}/scan`]: scanRoutes({ [LOCATION.code]: LOCATION, 'CASE-BOX-6': CASE_SCAN }),
    });
    renderScan('?flow=count');
    await scan(LOCATION.code);
    expect(await screen.findByRole('heading', { name: 'Count Main stock/B-02' })).toBeTruthy();
    await burst('CASE-BOX-6', 'CASE-BOX-6');
    await waitFor(() => expect(toConfirm()).toBe('BOX-1: 2 × Case (6) = 12 units'));
  });

  it('applies a shelf label before the item scanned after it, whichever answers first', async () => {
    let answerLocation = () => {};
    const located = new Promise<void>((resolve) => {
      answerLocation = resolve;
    });
    const routes = scanRoutes({ [LOCATION.code]: LOCATION, 'CASE-BOX-6': CASE_SCAN });
    const calls = mockApi({
      ...BASE(COUNTER),
      [`/shops/${SHOP}/scan`]: async (call: Call) => {
        // The label's lookup is slow; the case's answers at once.
        if (call.query.code === LOCATION.code) await located;
        return routes(call);
      },
    });
    renderScan('?flow=count');
    expect(
      await screen.findByText('Scan the shelf’s location label, then every item on it.'),
    ).toBeTruthy();
    await burst(LOCATION.code, 'CASE-BOX-6');
    await waitFor(() =>
      expect(calls.filter((c) => c.path === `/shops/${SHOP}/scan`)).toHaveLength(2),
    );
    answerLocation();
    await waitFor(() => expect(toConfirm()).toBe('BOX-1: 1 × Case (6) = 6 units'));
    expect(screen.queryByText('Scan the shelf’s location label first.')).toBeNull();
  });
});

describe('scan page: count sessions', () => {
  it('records lines, then submits with a decision for a line that moved after counting', async () => {
    const line = (over: Record<string, unknown>) => ({
      lineId: LINE1,
      variantId: VAR,
      sku: 'BOX-1',
      name: 'Booster box',
      locationId: LOC,
      locationPath: 'Main stock/B-02',
      condition: 'sellable',
      lotCode: null,
      serial: null,
      expected: '12',
      counted: null,
      status: 'pending',
      countedAt: null,
      countedVersion: null,
      postedDelta: null,
      needsReview: false,
      movementsSince: [],
      ...over,
    });
    const moved = line({
      counted: '10',
      status: 'counted',
      needsReview: true,
      movementsSince: [
        { operationId: OP, kind: 'receipt', quantity: '3', at: '2026-11-16T09:00:00.000Z' },
      ],
    });
    const session = (lines: unknown[], counted: number, status = 'open') => ({
      sessionId: SESSION,
      name: null,
      status,
      blind: false,
      quick: false,
      location: { locationId: LOC, path: 'Main stock/B-02' },
      note: null,
      createdAt: '2026-11-16T08:00:00.000Z',
      submittedAt: null,
      operationId: null,
      totals: { lines: 2, counted, needsReview: 1 },
      lines,
    });
    const other = line({ lineId: LINE2, variantId: VAR2, sku: 'CARD-1', expected: '4' });
    let current = session([moved, other], 1);
    const calls = mockApi({
      ...BASE(COUNTER),
      [`/shops/${SHOP}/scan`]: scanRoutes({ [LOCATION.code]: LOCATION }),
      [`/shops/${SHOP}/counts`]: { counts: [current], next: null },
      [`/shops/${SHOP}/counts/${SESSION}`]: () => current,
      [`POST /shops/${SHOP}/counts/${SESSION}/record`]: () => {
        current = session([moved, { ...other, counted: '0', status: 'counted' }], 2);
        return current;
      },
      [`POST /shops/${SHOP}/counts/${SESSION}/submit`]: () => ({
        operationId: OP,
        ...CHANGES,
        changes: [],
        session: session([], 2, 'submitted'),
      }),
    });
    renderScan('?flow=count');
    fireEvent.click(await screen.findByRole('button', { name: 'Count session' }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Main stock\/B-02.*1 of 2 counted/ }),
    );
    expect(await screen.findByRole('heading', { name: 'Moved since counted' })).toBeTruthy();
    expect(screen.getByText(/counted 10; \+3 since/)).toBeTruthy();
    const submit = screen.getByRole('button', { name: 'Review 1 moved line first' });
    expect(submit).toHaveProperty('disabled', true);

    // At the shelf, an item that is not there is recorded as none.
    await scan(LOCATION.code);
    fireEvent.click(await screen.findByRole('button', { name: 'None here' }));
    expect(await screen.findByText(/Recorded none of CARD-1 at Main stock\/B-02/)).toBeTruthy();
    expect(posts(calls, `/shops/${SHOP}/counts/${SESSION}/record`)[0]!.body).toEqual({
      counts: [{ variantId: VAR2, locationId: LOC, counted: '0' }],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add the movements' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit count (2 of 2 counted)' }));
    expect(await screen.findByRole('heading', { name: /is submitted/ })).toBeTruthy();
    expect(posts(calls, `/shops/${SHOP}/counts/${SESSION}/submit`)[0]!.body).toEqual({
      reviews: [{ lineId: LINE1, resolution: 'apply_movements' }],
    });
  });
});

describe('scan page: move', () => {
  it('moves from the scanned shelf to the scanned destination in one command', async () => {
    const calls = mockApi({
      ...BASE([...OPERATOR, 'inventory.transfer']),
      [`/shops/${SHOP}/scan`]: scanRoutes({
        [LOCATION.code]: LOCATION,
        'CASE-BOX-6': CASE_SCAN,
        '4006381333931': UNIT_SCAN,
        [location(LOC2, 'Main stock/C-01').code]: location(LOC2, 'Main stock/C-01'),
        'LOC:OTHER': {
          ...location(LOC2, 'Annex/A-01', '0196f3a0-0000-7000-8000-0000000000a2'),
          code: 'LOC:OTHER',
        },
      }),
      [`POST /shops/${SHOP}/moves`]: { operationId: OP, transfer: {}, shortagesFilled: [] },
    });
    renderScan('?flow=move');
    expect(await screen.findByRole('heading', { name: 'Move' })).toBeTruthy();
    await scan('CASE-BOX-6');
    expect(
      await screen.findByText('Scan the label of the shelf you are taking from first.'),
    ).toBeTruthy();
    await scan(LOCATION.code);
    expect(await screen.findByText('Moving from Main stock/B-02. Scan the items.')).toBeTruthy();
    await scan('CASE-BOX-6');
    await scan('4006381333931');
    expect(await screen.findByText(/BOX-1: 7 units · Main stock\/B-02 → \?/)).toBeTruthy();
    expect(screen.getByText('Available here: 10')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Scan the destination label' })).toHaveProperty(
      'disabled',
      true,
    );
    // Another warehouse is refused: that is a transfer.
    await scan('LOC:OTHER');
    expect(await screen.findByText(/Annex\/A-01 is in another warehouse/)).toBeTruthy();
    await scan(location(LOC2, 'Main stock/C-01').code);
    fireEvent.click(await screen.findByRole('button', { name: 'Move 7 units to Main stock/C-01' }));
    expect(
      await screen.findByText('Moved BOX-1: 7 units from Main stock/B-02 to Main stock/C-01.'),
    ).toBeTruthy();
    expect(posts(calls, `/shops/${SHOP}/moves`)[0]!.body).toEqual({
      fromLocationId: LOC,
      toLocationId: LOC2,
      lines: [{ variantId: VAR, quantity: '7' }],
    });
  });
});

describe('scan page: receive against a purchase order', () => {
  it('matches the scanned case to its line and asks before an over-receipt', async () => {
    const poLine = {
      id: PO_LINE,
      position: 0,
      variantId: VAR,
      productId: PROD,
      productName: 'Booster box',
      variantName: null,
      sku: 'BOX-1',
      packId: CASE,
      packName: 'Case',
      packFactor: '6',
      supplierItemId: null,
      supplierSku: null,
      quantity: '4',
      ordered: '24',
      received: '18',
      cancelled: '0',
      open: '6',
      overReceived: '0',
      unitCost: null,
      lineTotal: null,
      note: null,
    };
    const order = {
      id: PO,
      number: 'PO-0007',
      status: 'partially_received',
      supplier: {
        id: PROD,
        name: 'Card Distributor',
        contactName: null,
        email: null,
        phone: null,
        address: null,
      },
      warehouse: { id: WH, name: 'Main stock', address: null },
      location: null,
      currency: 'EUR',
      expectedOn: '2026-11-20',
      supplierReference: null,
      notes: null,
      costVisible: false,
      total: null,
      lines: [poLine],
      receipts: [],
      sends: [],
    };
    const calls = mockApi({
      ...BASE(OPERATOR),
      [`/shops/${SHOP}/scan`]: scanRoutes({ [LOCATION.code]: LOCATION, 'CASE-BOX-6': CASE_SCAN }),
      [`/shops/${SHOP}/purchase-orders`]: {
        purchaseOrders: [
          {
            id: PO,
            number: 'PO-0007',
            status: 'partially_received',
            supplierId: PROD,
            supplierName: 'Card Distributor',
            warehouseId: WH,
            warehouseName: 'Main stock',
            expectedOn: '2026-11-20',
            overdue: false,
            lineCount: 1,
            ordered: '24',
            received: '18',
            open: '6',
            total: null,
            createdAt: '2026-11-10T08:00:00.000Z',
            sentAt: '2026-11-10T08:00:00.000Z',
            version: 2,
          },
        ],
        nextCursor: null,
      },
      [`/shops/${SHOP}/purchase-orders/${PO}`]: order,
      [`POST /shops/${SHOP}/purchase-orders/${PO}/receive`]: {
        purchaseOrder: {
          ...order,
          status: 'received',
          lines: [{ ...poLine, received: '30', open: '0', overReceived: '6' }],
        },
        receipt: {
          operationId: OP,
          lineId: PO_LINE,
          quantity: '12',
          overReceived: '6',
          locationId: LOC,
          lot: null,
          serials: [],
          shortagesFilled: [],
          averageCost: null,
        },
      },
    });
    renderScan('?flow=receive');
    fireEvent.click(await screen.findByRole('button', { name: 'Purchase order' }));
    await scan(LOCATION.code);
    fireEvent.click(await screen.findByRole('button', { name: /PO-0007 · Card Distributor/ }));
    expect(
      await screen.findByRole('button', { name: 'BOX-1: ordered 24, received 18, open 6' }),
    ).toBeTruthy();
    expect(screen.getByText(/Ordered 4 × Case \(6\) = 24/)).toBeTruthy();

    // The case matches the line in cases; a second case goes past what is open.
    await scan('CASE-BOX-6');
    expect(await screen.findByText('1 × Case (6) = 6 units → Main stock/B-02')).toBeTruthy();
    await scan('CASE-BOX-6');
    expect(await screen.findByText('2 × Case (6) = 12 units → Main stock/B-02')).toBeTruthy();
    const receive = screen.getByRole('button', { name: 'Receive 12 (6 over)' });
    expect(receive).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('checkbox', { name: /This is 6 more than the 6 still open/ }));
    expect(receive).toHaveProperty('disabled', false);
    fireEvent.click(receive);
    expect(await screen.findByText('Received 12 × BOX-1 against PO-0007.')).toBeTruthy();
    expect(posts(calls, `/shops/${SHOP}/purchase-orders/${PO}/receive`)[0]!.body).toEqual({
      lineId: PO_LINE,
      quantity: '2',
      locationId: LOC,
      confirmOverReceipt: true,
    });
    // Back on the order, refreshed from the receipt.
    expect(
      await screen.findByRole('button', { name: 'BOX-1: ordered 24, received 30, open 0' }),
    ).toBeTruthy();
  });
});
