// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Grid } from '../src/catalog/grid.tsx';
import type { Column } from '../src/catalog/schema.ts';
import { type Row, STOCK_AT } from '../src/catalog/values.ts';

// G5: a quantity typed in the grid's stock column is a one-line quick count of that shelf. It
// sends the position version and on hand it read; when the shelf moved since, or the count would
// leave fewer units than are reserved, the grid asks as the stock panel does, never silently.

const SHOP = '0196f3a0-0000-7000-8000-000000000001';
const PRODUCT = '0196f3a0-0000-7000-8000-000000000002';
const VARIANT = '0196f3a0-0000-7000-8000-000000000003';
const LOTTED = '0196f3a0-0000-7000-8000-000000000004';
const SHELF = '0196f3a0-0000-7000-8000-000000000005';
const ALLOC = '0196f3a0-0000-7000-8000-000000000006';
const RES = '0196f3a0-0000-7000-8000-000000000007';
const POS = '0196f3a0-0000-7000-8000-000000000008';
const QUICK = `/shops/${SHOP}/counts/quick`;

function row(variantId: string, sku: string, countable = true): Row {
  return {
    productId: PRODUCT,
    variantId,
    name: `Item ${sku}`,
    sku,
    title: '',
    status: 'active',
    productStatus: 'active',
    price: null,
    familyId: null,
    tags: [],
    variantCount: null,
    priceRange: null,
    skus: null,
    available: '10',
    values: {},
    stockAt: { locationId: SHELF, onHand: '10.000000', version: 4, countable },
  };
}

const columns: Column[] = [
  {
    key: 'name',
    label: 'Name',
    kind: 'text',
    level: 'product',
    editable: true,
    sortable: true,
    defaultWidth: 200,
    builtin: true,
  },
  {
    key: STOCK_AT,
    label: 'On hand · Main/A-1',
    kind: 'number',
    level: 'variant',
    editable: true,
    sortable: false,
    defaultWidth: 150,
    builtin: true,
  },
];

type Answer = { status: number; body: unknown };

/** Answers each quick count with the next answer; records what was sent. */
function mockCounts(answers: Answer[]) {
  const sent: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input), 'http://localhost');
      if (init.method !== 'POST' || url.pathname !== `/api/v1${QUICK}`) {
        return new Response(JSON.stringify({ code: 'not_found', title: 'Not found' }), {
          status: 404,
        });
      }
      sent.push(JSON.parse(String(init.body)));
      const answer = answers.shift() ?? { status: 201, body: { changes: [] } };
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }),
  );
  return sent;
}

const saved = { status: 201, body: { changes: [{ delta: '-2' }] } };

function showGrid(rows: Row[]) {
  const onSaved = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Grid
        shopId={SHOP}
        mode="variants"
        columns={columns}
        widths={{}}
        rows={rows}
        rowCount={rows.length}
        schema={undefined}
        sort={null}
        density="compact"
        onSort={() => {}}
        onNeedMore={() => {}}
        onOpen={() => {}}
        onResize={() => {}}
        onReorder={() => {}}
        onBulk={() => {}}
        overrides={new Map()}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { onSaved, grid: screen.getByRole('grid') };
}

/** Moves to the stock cell of the first row and types a number, then Enter, as a person would. */
function typeCount(grid: HTMLElement, text: string) {
  grid.focus();
  fireEvent.keyDown(grid, { key: 'ArrowRight' });
  fireEvent.keyDown(grid, { key: text[0]! });
  const editor = screen.getByLabelText('On hand · Main/A-1') as HTMLInputElement;
  fireEvent.change(editor, { target: { value: text } });
  fireEvent.keyDown(editor, { key: 'Enter' });
}

// The grid renders the rows and columns in view; happy-dom lays nothing out, so give elements a
// size for the virtualizer to measure.
const sizes = {
  clientHeight: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
};
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, value: 600 });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
});
afterAll(() => {
  for (const [key, descriptor] of Object.entries(sizes)) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, key, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, key);
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('a count typed in the grid (G5)', () => {
  it('sends a one-line quick count with the version and on hand it read', async () => {
    const sent = mockCounts([saved]);
    const { onSaved, grid } = showGrid([row(VARIANT, 'MUG-01')]);
    expect(screen.getByText('10')).toBeTruthy();
    typeCount(grid, '8');
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toEqual([
      {
        locationId: SHELF,
        counts: [{ variantId: VARIANT, counted: '8', read: { version: 4, onHand: '10.000000' } }],
      },
    ]);
    expect(onSaved).toHaveBeenCalledWith(`${VARIANT}:${STOCK_AT}`, {
      raw: '8',
      display: '8',
      source: 'own',
    });
  });

  it('asks before posting when the shelf moved since it was read, as the stock panel does', async () => {
    const sent = mockCounts([
      {
        status: 409,
        body: {
          code: 'moved_since_read',
          title: 'Units moved since this was read.',
          positions: [
            {
              variantId: VARIANT,
              locationId: SHELF,
              condition: 'sellable',
              lotId: null,
              read: { version: 4, onHand: '10' },
              now: { version: 6, onHand: '15' },
            },
          ],
        },
      },
      saved,
    ]);
    const { onSaved, grid } = showGrid([row(VARIANT, 'MUG-01')]);
    typeCount(grid, '8');
    expect(await screen.findByText(/Stock moved here since you read it/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: 'Count needs a decision' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keep my count (8)' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Count plus movements since (13)' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
      locationId: SHELF,
      counts: [{ variantId: VARIANT, counted: '13', read: { version: 6, onHand: '15' } }],
    });
    expect(screen.queryByText(/Stock moved here/)).toBeNull();
  });

  it('asks per claim when the count leaves fewer units than are reserved', async () => {
    const sent = mockCounts([
      {
        status: 409,
        body: {
          code: 'below_reserved',
          title: 'This leaves fewer units than are reserved.',
          positions: [
            {
              positionId: POS,
              toResolve: '2',
              allocations: [
                {
                  allocationId: ALLOC,
                  reservationId: RES,
                  purpose: 'order',
                  externalRef: 'shop:order/9',
                  outstanding: '4',
                },
              ],
            },
          ],
        },
      },
      saved,
    ]);
    const { onSaved, grid } = showGrid([row(VARIANT, 'MUG-01')]);
    typeCount(grid, '2');
    expect(await screen.findByText(/shop:order\/9/)).toBeTruthy();
    expect(onSaved).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Action'), { target: { value: 'release' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply with these choices' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent[1]).toEqual({
      locationId: SHELF,
      counts: [{ variantId: VARIANT, counted: '2', read: { version: 4, onHand: '10.000000' } }],
      reservationChoices: [{ allocationId: ALLOC, action: 'release' }],
    });
  });

  it('leaves lots, serials, and bundles to the stock panel, and refuses what is not a number', async () => {
    const sent = mockCounts([]);
    const { grid } = showGrid([row(LOTTED, 'LOT-01', false)]);
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'Enter' });
    expect(screen.getByText(/counted in the product’s stock panel/)).toBeTruthy();
    expect(screen.queryByLabelText('On hand · Main/A-1')).toBeNull();
    cleanup();

    const second = showGrid([row(VARIANT, 'MUG-01')]);
    typeCount(second.grid, '1x');
    expect(await screen.findByText(/Type the units on the shelf/)).toBeTruthy();
    expect(sent).toEqual([]);
  });
});
