/**
 * Three months of stock activity for the persona shops (plan Section 7.2, milestone I7), on top of
 * seed-personas.ts's catalog and opening stock. It fills in what personas.ts marks "I1:":
 *
 * - **Tracking.** Food (every variant) and cosmetics (skincare, foundations, concealers) become
 *   `lot_expiry` with a sell-by margin; their opening stock is received again in two to four lots.
 *   Spare parts' pumps, motors, contactors, relays, and sensors (about 10%) and the fashion brand's
 *   watches become serial-tracked, one serial per unit. Single and graded cards, used sets, and
 *   single-variant jewellery become one of a kind.
 * - **Activity**, from the day after the opening import to now, about `--per-day` stock operations
 *   a day per shop, weighted to weekdays and office hours:
 *   - orders: a reservation per line (earliest expiry first, then oldest stock, as allocation rule
 *     D3), fulfilled hours to two days later, some released; the newest stay open;
 *   - purchase orders by preferred supplier when sellable stock runs low, received days later with
 *     costs, new lots, and new serials; the newest stay sent or draft;
 *   - transfers between warehouses (dispatch, then receipt a day or two later; some in transit);
 *   - returns to quarantine and their inspection (back to sellable, damaged, or disposed);
 *   - counts of a location with a few corrections, damage write-offs, and expired-lot write-offs;
 *   - reorder rules on a share of the variants.
 *
 * The commands are replayed in memory with the engine's rules (no position below zero, allocations
 * never above on hand, a serial in one position, owned quantity behind the moving average), then
 * written in bulk as the database owner, one transaction per shop. `stock_reconciliation_problems()`,
 * `transfer_reconciliation_problems()`, and `return_reconciliation_problems()` must find nothing
 * afterwards; `--check` runs them. Audit events and idempotency records are not written (the history
 * seed covers events; see the I7 section of docs/phase-2-measurements.md for the idempotency cost).
 *
 *   DATABASE_OWNER_URL=postgres://…owner…/db tsx scripts/bench/seed-stock-activity.ts \
 *     [--per-day 280] [--only 'Bench Fuel%'] [--seed 7] [--check] [--dry-run]
 *
 * Run it on a branch of `i0-personas` after the migrations, never on staging. Run it once: it
 * refuses a shop that already has operations after its opening import.
 */
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { uuidv7 } from '../../packages/core/src/ids.ts';
import { normalizeCode } from '../../packages/core/src/stock/engine.ts';

const { values: args } = parseArgs({
  options: {
    'per-day': { type: 'string', default: '280' },
    only: { type: 'string', default: 'Bench %' },
    seed: { type: 'string', default: '7' },
    check: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
  },
});
const url = process.env.DATABASE_OWNER_URL;
if (!url) throw new Error('Set DATABASE_OWNER_URL (the owner role).');
const perDay = Number(args['per-day']);
const DAY = 86_400_000;

// Random numbers ---------------------------------------------------------------------------------

function rng(seed: string) {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = rng('x');
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const chance = (p: number) => rand() < p;
const money = (x: number) => (Math.round(x * 1e6) / 1e6).toFixed(6);
const iso = (t: number) => new Date(t).toISOString();
const dateOnly = (t: number) => iso(t).slice(0, 10);

/** Weighted picks over a fixed list: popular items sell far more than the long tail. */
function zipf<T>(items: T[], s = 0.9) {
  const cum: number[] = [];
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += 1 / (i + 4) ** s;
    cum.push(total);
  }
  return () => {
    const x = rand() * total;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    return items[lo]!;
  };
}

// Persona profiles --------------------------------------------------------------------------------

interface Profile {
  /** Share of the day's operations that are order lines (each a reservation and its outcome). */
  orderShare: number;
  /** Units per order line. */
  qty: (v: Variant) => number;
  linesMax: number;
  /** Share of fulfilled lines that come back. */
  returnRate: number;
  transfersPerDay: number;
  countsPerDay: number;
  damagePerDay: number;
  /** Lot tracking: which variants, the sell-by margin, and shelf life in days. */
  lot?: {
    match: (v: Variant) => boolean;
    margin: number;
    shelf: (v: Variant) => number;
    /** Lots per variant and location in the opening stock, and per delivery. */
    opening: [number, number];
    perDelivery: number;
    /** Restock below this share of the opening level. */
    restockAt: number;
  };
  serial?: (v: Variant) => boolean;
  oneOfAKind?: (v: Variant) => boolean;
  /** Share of order lines for one-of-a-kind items. */
  uniqueShare?: number;
  connectorShare: number;
  ruleShare: number;
}

const PROFILES: Record<string, Profile> = {
  'Bench Cards and Bricks': {
    orderShare: 0.86,
    qty: (v) => (v.family === 'Sealed TCG products' ? int(1, 4) : 1),
    linesMax: 3,
    returnRate: 0.015,
    transfersPerDay: 0,
    countsPerDay: 1,
    damagePerDay: 1,
    oneOfAKind: (v) => v.family === 'Trading cards' || v.family === 'Used sets',
    uniqueShare: 0.05,
    connectorShare: 0.8,
    ruleShare: 0.3,
  },
  'Bench Stride Sportswear': {
    orderShare: 0.82,
    qty: () => (chance(0.85) ? 1 : 2),
    linesMax: 4,
    returnRate: 0.12,
    transfersPerDay: 3,
    countsPerDay: 2,
    damagePerDay: 1,
    connectorShare: 0.75,
    ruleShare: 0.1,
  },
  'Bench Fuel Kitchen': {
    orderShare: 0.84,
    qty: () => pick([6, 6, 12, 12, 12, 24]),
    linesMax: 3,
    returnRate: 0.01,
    transfersPerDay: 0,
    countsPerDay: 2,
    damagePerDay: 1,
    lot: {
      match: () => true,
      margin: 14,
      shelf: (v) => (v.family === 'Food' ? 150 : v.family === 'Drinkable meals' ? 240 : 330),
      opening: [5, 8],
      perDelivery: 3,
      restockAt: 0.6,
    },
    connectorShare: 0.7,
    ruleShare: 0.5,
  },
  'Bench Lumen Skin': {
    orderShare: 0.84,
    qty: () => (chance(0.8) ? 1 : int(2, 3)),
    linesMax: 4,
    returnRate: 0.05,
    transfersPerDay: 0,
    countsPerDay: 2,
    damagePerDay: 1,
    lot: {
      match: (v) => v.family === 'Skincare' || /Foundation|Concealer/.test(v.productName),
      margin: 30,
      shelf: (v) => (v.family === 'Skincare' ? 540 : 720),
      opening: [1, 3],
      perDelivery: 1,
      restockAt: 0.4,
    },
    connectorShare: 0.8,
    ruleShare: 0.1,
  },
  'Bench Partline Supply': {
    orderShare: 0.8,
    qty: (v) =>
      v.family === 'Fasteners' || v.family === 'Seals and O-rings'
        ? pick([10, 25, 50, 100, 200])
        : int(1, 4),
    linesMax: 6,
    returnRate: 0.02,
    transfersPerDay: 4,
    countsPerDay: 3,
    damagePerDay: 1,
    serial: (v) =>
      v.family === 'Pumps' ||
      (v.family === 'Electrical' && /Motor|Contactor|Relay|sensor/.test(v.productName)),
    connectorShare: 0.2,
    ruleShare: 0.08,
  },
  'Bench Maison Verre': {
    orderShare: 0.8,
    qty: () => 1,
    linesMax: 3,
    returnRate: 0.07,
    transfersPerDay: 3,
    countsPerDay: 2,
    damagePerDay: 1,
    serial: (v) => v.family === 'Watches',
    oneOfAKind: (v) => v.family === 'Jewellery' && v.siblings === 1,
    uniqueShare: 0.04,
    connectorShare: 0.7,
    ruleShare: 0.08,
  },
};

// State ------------------------------------------------------------------------------------------

interface Variant {
  id: string;
  productId: string;
  sku: string;
  family: string;
  productName: string;
  siblings: number;
  tracking: 'none' | 'lot_expiry' | 'serial';
  ooak: boolean;
  margin: number;
  shelf: number;
  supplierId: string | null;
  supplierItemId: string | null;
  supplierSku: string | null;
  cost: number;
  moq: number;
  /** Sellable on hand at the opening: the restock target. */
  target: number;
  converted: boolean;
  sold: boolean;
}
interface Loc {
  id: string;
  warehouseId: string | null;
  path: string;
  eligible: boolean;
}
interface Pos {
  id: string;
  variantId: string;
  locationId: string;
  condition: string;
  lotId: string | null;
  serialId: string | null;
  transferId: string | null;
  onHand: number;
  allocated: number;
  receivedAt: number | null;
  createdAt: number;
  updatedAt: number;
  isNew: boolean;
  bumps: number;
}
interface Lot {
  id: string;
  variantId: string;
  code: string;
  expiresOn: string;
  expiresAt: number;
  producedOn: string;
  supplierId: string | null;
  po: string | null;
  opId: string;
  createdAt: number;
}
interface Serial {
  id: string;
  variantId: string;
  serial: string;
  status: string;
  positionId: string | null;
  createdOp: string;
  lastOp: string;
  createdAt: number;
  updatedAt: number;
}
interface Alloc {
  id: string;
  reservationId: string;
  positionId: string;
  quantity: number;
  released: number;
  fulfilled: number;
  createdAt: number;
}
interface Reservation {
  id: string;
  variantId: string;
  quantity: number;
  status: string;
  purpose: string;
  externalRef: string | null;
  opId: string;
  createdAt: number;
  updatedAt: number;
  channel: string;
  allocs: Alloc[];
}
type Row = Record<string, unknown>;

class Shop {
  variants = new Map<string, Variant>();
  locs = new Map<string, Loc>();
  inTransit = '';
  positions = new Map<string, Pos>();
  byKey = new Map<string, Pos>();
  byVariant = new Map<string, Pos[]>();
  lots = new Map<string, Lot>();
  lotCodes = new Set<string>();
  serials = new Map<string, Serial>();
  costs = new Map<string, { qty: number; avg: number | null }>();
  reservations: Reservation[] = [];
  out: Record<string, Row[]> = {};
  users: string[] = [];
  credential = 'bench-erp';
  poNumber = 0;
  tz = 'UTC';
  currency = 'EUR';
  /** Variants with sellable stock in each warehouse, for transfers. */
  warehouses: string[] = [];
  constructor(
    public id: string,
    public name: string,
    public p: Profile,
  ) {}

  push(table: string, row: Row) {
    const rows = this.out[table] ?? [];
    rows.push(row);
    this.out[table] = rows;
  }
  key(v: string, l: string, c: string, lot: string | null, s: string | null, t: string | null) {
    return `${v}|${l}|${c}|${lot ?? ''}|${s ?? ''}|${t ?? ''}`;
  }
  /** Finds or creates the position for an identity (the engine's upsert). */
  position(
    variantId: string,
    locationId: string,
    condition: string,
    lotId: string | null,
    serialId: string | null,
    transferId: string | null,
    at: number,
  ): Pos {
    const k = this.key(variantId, locationId, condition, lotId, serialId, transferId);
    let p = this.byKey.get(k);
    if (!p) {
      p = {
        id: uuidv7(at),
        variantId,
        locationId,
        condition,
        lotId,
        serialId,
        transferId,
        onHand: 0,
        allocated: 0,
        receivedAt: null,
        createdAt: at,
        updatedAt: at,
        isNew: true,
        bumps: 0,
      };
      this.byKey.set(k, p);
      this.positions.set(p.id, p);
      const list = this.byVariant.get(variantId) ?? [];
      list.push(p);
      this.byVariant.set(variantId, list);
    }
    return p;
  }
  op(kind: string, at: number, extra: Partial<Row> = {}, actor?: [string, string, string]): string {
    const id = uuidv7(at);
    const [actorType, actorId, source] = actor ?? ['user', pick(this.users), 'dashboard'];
    this.push('inventory_operations', {
      id,
      kind,
      actor_type: actorType,
      actor_id: actorId,
      source,
      external_ref: null,
      reason: null,
      supplier_id: null,
      transfer_id: null,
      return_id: null,
      count_session_id: null,
      occurred_at: iso(at),
      ...extra,
    });
    return id;
  }
  /** apply_stock_cost: owned quantity and moving average, with a history row. */
  cost(
    variantId: string,
    opId: string | null,
    kind: string,
    delta: number,
    entered: number | null,
    at: number,
  ) {
    const c = this.costs.get(variantId) ?? { qty: 0, avg: null };
    this.costs.set(variantId, c);
    let applied: number | null;
    let basis: string;
    if (delta > 0 && entered !== null) {
      applied = entered;
      basis = 'entered';
      c.avg =
        c.avg === null || c.qty === 0
          ? entered
          : Math.round(((c.qty * c.avg + delta * entered) / (c.qty + delta)) * 1e6) / 1e6;
    } else {
      applied = c.avg;
      basis = c.avg === null ? 'none' : 'average';
    }
    c.qty += delta;
    if (c.qty < 0) throw new Error(`Owned quantity below zero for ${variantId}`);
    this.push('variant_cost_history', {
      id: uuidv7(at),
      variant_id: variantId,
      operation_id: opId,
      occurred_at: iso(at),
      kind,
      quantity_delta: String(delta),
      unit_cost: applied === null ? null : money(applied),
      quantity_after: String(c.qty),
      average_after: c.avg === null ? null : money(c.avg),
    });
    return { unitCost: applied, basis };
  }
  /** One ledger entry and the balance change it explains. */
  entry(
    opId: string,
    pos: Pos,
    delta: number,
    at: number,
    cost: { unitCost: number | null; basis: string } | null,
    reservationId: string | null = null,
  ) {
    pos.onHand += delta;
    if (pos.onHand < 0 || pos.allocated > pos.onHand)
      throw new Error(`Position ${pos.id} out of range: ${pos.onHand} / ${pos.allocated}`);
    if (delta > 0 && pos.onHand === delta) pos.receivedAt = at;
    pos.updatedAt = at;
    pos.bumps++;
    this.push('inventory_entries', {
      id: uuidv7(at),
      operation_id: opId,
      position_id: pos.id,
      variant_id: pos.variantId,
      location_id: pos.locationId,
      delta: String(delta),
      unit_cost: cost?.unitCost == null ? null : money(cost.unitCost),
      cost_basis: cost ? cost.basis : null,
      lot_id: pos.lotId,
      serial_id: pos.serialId,
      reservation_id: reservationId,
      created_at: iso(at),
    });
  }
  lotSellable(lotId: string | null, v: Variant, at: number) {
    if (!lotId) return true;
    const lot = this.lots.get(lotId)!;
    return at < lot.expiresAt - v.margin * DAY;
  }
  /** Sellable positions with free units, in allocation order (D3). */
  candidates(v: Variant, at: number, warehouseId?: string): Pos[] {
    return (this.byVariant.get(v.id) ?? [])
      .filter((p) => {
        const l = this.locs.get(p.locationId)!;
        return (
          p.condition === 'sellable' &&
          !p.transferId &&
          l.eligible &&
          (!warehouseId || l.warehouseId === warehouseId) &&
          p.onHand - p.allocated > 0 &&
          this.lotSellable(p.lotId, v, at)
        );
      })
      .sort((a, b) => {
        const ea = a.lotId ? this.lots.get(a.lotId)!.expiresAt : Number.POSITIVE_INFINITY;
        const eb = b.lotId ? this.lots.get(b.lotId)!.expiresAt : Number.POSITIVE_INFINITY;
        if (ea !== eb) return ea - eb;
        const ra = a.receivedAt ?? 0;
        const rb = b.receivedAt ?? 0;
        if (ra !== rb) return ra - rb;
        const pa = this.locs.get(a.locationId)!.path;
        const pb = this.locs.get(b.locationId)!.path;
        return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : 1;
      });
  }
  available(v: Variant, at: number) {
    return this.candidates(v, at).reduce((s, p) => s + p.onHand - p.allocated, 0);
  }
  newLot(
    v: Variant,
    at: number,
    opId: string,
    supplierId: string | null,
    po: string | null,
    expiresAt: number,
  ): Lot {
    const code = `${v.family === 'Skincare' || v.family === 'Make-up' ? 'B' : 'L'}${dateOnly(at).replaceAll('-', '').slice(2)}-${int(100, 999)}${String.fromCharCode(65 + int(0, 25))}`;
    const lot: Lot = {
      id: uuidv7(at),
      variantId: v.id,
      code,
      expiresOn: dateOnly(expiresAt),
      expiresAt: Date.parse(`${dateOnly(expiresAt)}T00:00:00Z`) + DAY,
      producedOn: dateOnly(at - int(5, 40) * DAY),
      supplierId,
      po,
      opId,
      createdAt: at,
    };
    const k = `${v.id}|${normalizeCode(code)}`;
    if (this.lotCodes.has(k)) return this.newLot(v, at, opId, supplierId, po, expiresAt);
    this.lotCodes.add(k);
    this.lots.set(lot.id, lot);
    return lot;
  }
  newSerial(v: Variant, at: number, opId: string): Serial {
    const s: Serial = {
      id: uuidv7(at),
      variantId: v.id,
      serial: `${v.sku.slice(0, 6).toUpperCase()}-${int(10_000_000, 99_999_999)}`,
      status: 'in_stock',
      positionId: null,
      createdOp: opId,
      lastOp: opId,
      createdAt: at,
      updatedAt: at,
    };
    this.serials.set(s.id, s);
    return s;
  }
  /**
   * Receives units of a variant at a location: new lots or serials as the variant's tracking needs.
   */
  receive(
    opId: string,
    v: Variant,
    locationId: string,
    qty: number,
    unitCost: number,
    at: number,
    condition = 'sellable',
    supplierId: string | null = null,
    po: string | null = null,
    lotsWanted = 1,
    costKind = 'receipt',
  ) {
    // One cost change per variant and operation, as apply_stock_cost is called.
    const cost = this.cost(v.id, opId, costKind, qty, unitCost, at);
    if (v.tracking === 'serial') {
      for (let i = 0; i < qty; i++) {
        const s = this.newSerial(v, at, opId);
        const pos = this.position(v.id, locationId, condition, null, s.id, null, at);
        this.entry(opId, pos, 1, at, cost);
        s.positionId = pos.id;
      }
      return;
    }
    if (v.tracking === 'lot_expiry') {
      let left = qty;
      for (let i = 0; i < lotsWanted && left > 0; i++) {
        const part = i === lotsWanted - 1 ? left : Math.max(1, Math.round(qty / lotsWanted));
        const expires = at + Math.round(v.shelf * (0.55 + 0.15 * i + 0.2 * rand())) * DAY;
        const lot = this.newLot(v, at, opId, supplierId, po, expires);
        const pos = this.position(v.id, locationId, condition, lot.id, null, null, at);
        this.entry(opId, pos, part, at, cost);
        left -= part;
      }
      return;
    }
    const pos = this.position(v.id, locationId, condition, null, null, null, at);
    this.entry(opId, pos, qty, at, cost);
  }
}

// Load -------------------------------------------------------------------------------------------

const client = new pg.Client({ connectionString: url });
await client.connect();
const q = async <T extends Row>(sql: string, params: unknown[] = []) =>
  (await client.query<T>(sql, params)).rows;

const shopRows = await q<{ id: string; name: string; timezone: string; currency: string }>(
  'select id, name, timezone, currency from shops where name like $1 order by name',
  [args.only],
);
const now = Date.now() - 2 * 3_600_000;

for (const shopRow of shopRows) {
  const profile = PROFILES[shopRow.name];
  if (!profile) {
    console.log(`${shopRow.name}: no profile, skipped`);
    continue;
  }
  rand = rng(`${args.seed}:${shopRow.name}`);
  const t0 = Date.now();
  const s = new Shop(shopRow.id, shopRow.name, profile);
  s.tz = shopRow.timezone;
  s.currency = shopRow.currency;
  await client.query('begin');
  await client.query(`select set_config('app.shop_id', $1, true)`, [s.id]);
  const [{ n: after }] = (await q<{ n: number }>(
    `select count(*)::int as n from inventory_operations where shop_id = $1 and source <> 'import'`,
    [s.id],
  )) as [{ n: number }];
  if (after > 0) {
    await client.query('rollback');
    console.log(`${s.name}: already has ${after} operations after the import; skipped`);
    continue;
  }
  const [{ opening }] = (await q<{ opening: Date }>(
    `select min(occurred_at) as opening from inventory_operations where shop_id = $1`,
    [s.id],
  )) as [{ opening: Date }];
  const openAt = opening.getTime();

  for (const l of await q<{
    id: string;
    warehouse_id: string | null;
    path: string;
    kind: string;
    eligible: boolean;
  }>(
    `select id, warehouse_id, path, kind, kind = 'storage' and status = 'active'
       and location_fulfillment_eligible(shop_id, path_ids) as eligible
     from locations where shop_id = $1`,
    [s.id],
  )) {
    if (l.kind === 'in_transit') s.inTransit = l.id;
    s.locs.set(l.id, { id: l.id, warehouseId: l.warehouse_id, path: l.path, eligible: l.eligible });
  }
  s.warehouses = [
    ...new Set([...s.locs.values()].map((l) => l.warehouseId).filter(Boolean)),
  ] as string[];
  s.users = (
    await q<{ user_id: string }>(
      `select user_id from memberships where shop_id = $1
       and role in ('owner', 'manager', 'inventory_operator') order by id`,
      [s.id],
    )
  ).map((r) => r.user_id);
  const [cred] = await q<{ id: string }>(
    `select id from api_credentials where shop_id = $1 limit 1`,
    [s.id],
  );
  if (cred) s.credential = cred.id;

  const vrows = await q<{
    id: string;
    product_id: string;
    sku: string;
    family: string | null;
    product_name: string;
    siblings: number;
    supplier_id: string | null;
    supplier_item_id: string | null;
    supplier_sku: string | null;
    cost: string | null;
    moq: string | null;
    opening_cost: string | null;
  }>(
    `select v.id, v.product_id, v.sku, f.name as family, p.name as product_name,
       count(*) over (partition by v.product_id)::int as siblings,
       si.supplier_id, si.id as supplier_item_id, si.supplier_sku, si.last_cost::text as cost,
       si.minimum_order_quantity::text as moq,
       (select (sum(e.delta * e.unit_cost) / nullif(sum(e.delta), 0))::text from inventory_entries e
        where e.shop_id = v.shop_id and e.variant_id = v.id and e.unit_cost is not null) as opening_cost
     from variants v
     join products p on p.shop_id = v.shop_id and p.id = v.product_id
     left join product_families f on f.shop_id = p.shop_id and f.id = p.family_id
     left join lateral (select * from supplier_items x where x.shop_id = v.shop_id
       and x.variant_id = v.id and x.status = 'active'
       order by x.preferred desc, x.id limit 1) si on true
     where v.shop_id = $1 and v.status = 'active'
       and not exists (select 1 from bundles b where b.shop_id = v.shop_id and b.variant_id = v.id)`,
    [s.id],
  );
  for (const r of vrows) {
    const cost = Number(r.opening_cost ?? r.cost ?? 0) || 1;
    s.variants.set(r.id, {
      id: r.id,
      productId: r.product_id,
      sku: r.sku,
      family: r.family ?? '',
      productName: r.product_name,
      siblings: r.siblings,
      tracking: 'none',
      ooak: false,
      margin: 0,
      shelf: 0,
      supplierId: r.supplier_id,
      supplierItemId: r.supplier_item_id,
      supplierSku: r.supplier_sku,
      cost,
      moq: Math.max(1, Math.round(Number(r.moq ?? 1))),
      target: 0,
      converted: false,
      sold: false,
    });
    s.costs.set(r.id, { qty: 0, avg: r.opening_cost ? Number(r.opening_cost) : null });
  }
  // Positions as the opening import left them.
  const prows = await q<{
    id: string;
    variant_id: string;
    location_id: string;
    on_hand: string;
    created_at: Date;
  }>(
    `select id, variant_id, location_id, on_hand::text, created_at from inventory_positions
     where shop_id = $1`,
    [s.id],
  );
  // Tracking modes (the "I1:" markers in personas.ts).
  for (const v of s.variants.values()) {
    if (profile.lot?.match(v)) {
      v.tracking = 'lot_expiry';
      v.margin = profile.lot.margin;
      v.shelf = profile.lot.shelf(v);
    } else if (profile.serial?.(v)) v.tracking = 'serial';
    else if (profile.oneOfAKind?.(v)) v.ooak = true;
  }
  const converted: Array<{ v: Variant; locationId: string; qty: number }> = [];
  const owned = new Map<string, number>();
  for (const r of prows)
    owned.set(r.variant_id, (owned.get(r.variant_id) ?? 0) + Number(r.on_hand));
  for (const r of prows) {
    const v = s.variants.get(r.variant_id);
    const qty = Number(r.on_hand);
    if (v && (v.tracking !== 'none' || (v.ooak && owned.get(v.id)! > 1))) {
      v.converted = true;
      if (qty > 0) converted.push({ v, locationId: r.location_id, qty: v.ooak ? 1 : qty });
      continue;
    }
    const pos: Pos = {
      id: r.id,
      variantId: r.variant_id,
      locationId: r.location_id,
      condition: 'sellable',
      lotId: null,
      serialId: null,
      transferId: null,
      onHand: qty,
      allocated: 0,
      receivedAt: qty > 0 ? openAt : null,
      createdAt: r.created_at.getTime(),
      updatedAt: r.created_at.getTime(),
      isNew: false,
      bumps: 0,
    };
    s.positions.set(pos.id, pos);
    s.byKey.set(s.key(pos.variantId, pos.locationId, 'sellable', null, null, null), pos);
    const list = s.byVariant.get(pos.variantId) ?? [];
    list.push(pos);
    s.byVariant.set(pos.variantId, list);
    const c = s.costs.get(pos.variantId);
    if (c) c.qty += qty;
  }
  // Owned quantity for converted variants is received again below, from zero.
  for (const v of s.variants.values()) if (v.converted) s.costs.get(v.id)!.qty = 0;
  // One-of-a-kind: at most one unit across the shop.
  const ooakSeen = new Set<string>();
  const reopen = converted.filter(({ v }) => {
    if (!v.ooak) return true;
    if (ooakSeen.has(v.id)) return false;
    ooakSeen.add(v.id);
    return true;
  });
  // The opening import again, for converted variants: lots, serials, one unit.
  const reopenOp = new Map<string, string>();
  for (const { v, locationId, qty } of reopen) {
    let opId = reopenOp.get(`${v.id}|${locationId}`);
    if (!opId) {
      opId = s.op('receipt', openAt, { reason: 'opening stock' }, ['user', s.users[0]!, 'import']);
      reopenOp.set(`${v.id}|${locationId}`, opId);
    }
    if (v.tracking === 'lot_expiry') {
      // Older lots first: some expire during the three months.
      const lots = Math.min(qty, int(...profile.lot!.opening));
      const cost = s.cost(v.id, opId, 'receipt', qty, v.cost, openAt);
      let left = qty;
      for (let i = 0; i < lots && left > 0; i++) {
        const part = i === lots - 1 ? left : Math.max(1, Math.floor(qty / lots));
        const age = Math.round(v.shelf * (0.75 - 0.2 * i - 0.1 * rand()));
        const lot = s.newLot(
          v,
          openAt - age * DAY,
          opId,
          v.supplierId,
          null,
          openAt - age * DAY + v.shelf * DAY,
        );
        lot.createdAt = openAt;
        const pos = s.position(v.id, locationId, 'sellable', lot.id, null, null, openAt);
        s.entry(opId, pos, part, openAt, cost);
        left -= part;
      }
    } else
      s.receive(opId, v, locationId, qty, v.cost, openAt, 'sellable', null, null, 1, 'receipt');
  }
  for (const v of s.variants.values()) {
    v.target = (s.byVariant.get(v.id) ?? []).reduce(
      (sum, p) => sum + (p.condition === 'sellable' ? p.onHand : 0),
      0,
    );
  }

  // Reorder rules: a share of the stocked variants, per warehouse they are stocked in.
  const rules = new Map<string, number>();
  for (const v of s.variants.values()) {
    if (v.ooak || v.target === 0 || !chance(profile.ruleShare)) continue;
    const wh = s.locs.get((s.byVariant.get(v.id) ?? [])[0]?.locationId ?? '')?.warehouseId;
    if (!wh) continue;
    const point = Math.max(1, Math.round(v.target * 0.3));
    rules.set(v.id, point);
    s.push('reorder_rules', {
      id: uuidv7(openAt),
      variant_id: v.id,
      warehouse_id: wh,
      reorder_point: String(point),
      reorder_quantity: chance(0.6) ? String(Math.max(v.moq, Math.round(v.target * 0.7))) : null,
      maximum_level: null,
      preferred_supplier_id: v.supplierId,
      created_at: iso(openAt),
    });
  }
  for (const r of s.out.reorder_rules ?? [])
    if (r.reorder_quantity === null)
      r.maximum_level = String(
        Math.max(Number(r.reorder_point) + 1, s.variants.get(r.variant_id as string)!.target),
      );

  // Activity ----------------------------------------------------------------------------------
  type Ev = { at: number; seq: number; run: () => void };
  // A binary heap on (time, order of scheduling).
  const heap: Ev[] = [];
  const less = (a: Ev, b: Ev) => a.at < b.at || (a.at === b.at && a.seq < b.seq);
  let seq = 0;
  let cur = 0;
  const schedule = (at: number, run: () => void) => {
    if (at >= now) return;
    heap.push({ at: Math.round(at), seq: seq++, run });
    for (let i = heap.length - 1; i > 0; ) {
      const up = (i - 1) >> 1;
      if (!less(heap[i]!, heap[up]!)) break;
      [heap[i], heap[up]] = [heap[up]!, heap[i]!];
      i = up;
    }
  };
  const next = (): Ev | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length && last) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m]!, heap[i]!];
        i = m;
      }
    }
    return top;
  };
  const sellable = [...s.variants.values()].filter((v) => v.target > 0 && !v.ooak);
  for (let i = sellable.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [sellable[i], sellable[j]] = [sellable[j]!, sellable[i]!];
  }
  const popular = zipf(sellable);
  const uniques = [...s.variants.values()].filter((v) => v.ooak);
  let orderNo = 1000;
  const fulfilledLines: Array<{
    v: Variant;
    res: Reservation;
    qty: number;
    at: number;
    costs: Array<{
      lotId: string | null;
      serialId: string | null;
      unit: number | null;
      qty: number;
    }>;
  }> = [];
  const openPo = new Map<string, number>();
  const stats: Record<string, number> = {};
  const count = (k: string) => {
    stats[k] = (stats[k] ?? 0) + 1;
  };
  const actor = (): [string, string, string] =>
    chance(profile.connectorShare)
      ? ['connector', 'shopify', 'shopify']
      : chance(0.5)
        ? ['api_credential', s.credential, 'api']
        : ['user', pick(s.users), 'dashboard'];

  function reserve(
    v: Variant,
    qty: number,
    at: number,
    ref: string,
    who: [string, string, string],
  ) {
    const cands = s.candidates(v, at);
    const free = cands.reduce((sum, p) => sum + p.onHand - p.allocated, 0);
    if (free < qty) return null;
    const opId = s.op('reservation', at, { external_ref: ref }, who);
    const res: Reservation = {
      id: uuidv7(at),
      variantId: v.id,
      quantity: qty,
      status: 'active',
      purpose: 'external_order',
      externalRef: ref,
      opId,
      createdAt: at,
      updatedAt: at,
      channel: 'default',
      allocs: [],
    };
    let left = qty;
    for (const p of cands) {
      if (left === 0) break;
      const take = Math.min(left, p.onHand - p.allocated);
      p.allocated += take;
      p.bumps++;
      p.updatedAt = at;
      res.allocs.push({
        id: uuidv7(at),
        reservationId: res.id,
        positionId: p.id,
        quantity: take,
        released: 0,
        fulfilled: 0,
        createdAt: at,
      });
      left -= take;
    }
    s.reservations.push(res);
    count('reservation');
    return res;
  }
  function fulfill(v: Variant, res: Reservation, at: number, who: [string, string, string]) {
    const opId = s.op('fulfillment', at, { external_ref: res.externalRef }, who);
    const costs: Array<{
      lotId: string | null;
      serialId: string | null;
      unit: number | null;
      qty: number;
    }> = [];
    const cost = s.cost(v.id, opId, 'fulfillment', -res.quantity, null, at);
    for (const a of res.allocs) {
      const p = s.positions.get(a.positionId)!;
      const qty = a.quantity - a.released - a.fulfilled;
      a.fulfilled += qty;
      p.allocated -= qty;
      s.entry(opId, p, -qty, at, cost, res.id);
      costs.push({ lotId: p.lotId, serialId: p.serialId, unit: cost.unitCost, qty });
      if (p.serialId) {
        const ser = s.serials.get(p.serialId)!;
        ser.status = 'sold';
        ser.positionId = null;
        ser.lastOp = opId;
        ser.updatedAt = at;
      }
    }
    res.status = 'fulfilled';
    res.updatedAt = at;
    if (v.ooak && s.costs.get(v.id)!.qty === 0) v.sold = true;
    count('fulfillment');
    return costs;
  }
  function release(res: Reservation, at: number, who: [string, string, string]) {
    s.op('release', at, { external_ref: res.externalRef, reason: 'order cancelled' }, who);
    for (const a of res.allocs) {
      const p = s.positions.get(a.positionId)!;
      const qty = a.quantity - a.released - a.fulfilled;
      a.released += qty;
      p.allocated -= qty;
      p.bumps++;
      p.updatedAt = at;
    }
    res.status = 'released';
    res.updatedAt = at;
    count('release');
  }

  function order(at: number) {
    const who = actor();
    const lines = int(1, profile.linesMax);
    const ref = `#${++orderNo}`;
    for (let line = 1; line <= lines; line++) {
      let v: Variant | undefined;
      if (profile.uniqueShare && chance(profile.uniqueShare)) {
        const unsold = uniques.filter((u) => !u.sold && s.costs.get(u.id)!.qty > 0);
        v = unsold.length ? pick(unsold) : undefined;
      }
      for (let tries = 0; !v && tries < 6; tries++) {
        const c = popular();
        if (s.available(c, at) > 0) v = c;
      }
      if (!v) continue;
      const qty = v.ooak ? 1 : Math.min(profile.qty(v), s.available(v, at));
      if (qty <= 0) continue;
      const res = reserve(v, qty, at, `${ref}-${line}`, who);
      if (!res) continue;
      const vv = v;
      if (chance(0.06)) {
        const when = at + int(1, 30) * 3_600_000;
        schedule(when, () => release(res, when, who));
      } else {
        const when = at + int(2, 40) * 3_600_000;
        schedule(when, () => {
          const costs = fulfill(vv, res, when, who);
          fulfilledLines.push({ v: vv, res, qty: res.quantity, at: when, costs });
        });
      }
    }
  }

  function restock(at: number) {
    // Variants under 40% of their opening level (or their rule), grouped by supplier.
    const due = new Map<string, Variant[]>();
    for (const v of s.variants.values()) {
      if (v.ooak || v.target === 0 || openPo.has(v.id) || !v.supplierId) continue;
      const sellableNow = (s.byVariant.get(v.id) ?? []).reduce(
        (sum, p) =>
          sum +
          (p.condition === 'sellable' && !p.transferId && s.lotSellable(p.lotId, v, at)
            ? p.onHand
            : 0),
        0,
      );
      const point = rules.get(v.id) ?? v.target * (profile.lot?.restockAt ?? 0.4);
      if (sellableNow >= point) continue;
      const list = due.get(v.supplierId) ?? [];
      list.push(v);
      due.set(v.supplierId, list);
    }
    for (const [supplierId, list] of due) {
      for (let i = 0; i < list.length; i += 40) poFor(supplierId, list.slice(i, i + 40), at);
    }
  }
  function poFor(supplierId: string, list: Variant[], at: number) {
    const poId = uuidv7(at);
    const number = ++s.poNumber;
    const firstLoc = s.locs.get((s.byVariant.get(list[0]!.id) ?? [])[0]?.locationId ?? '');
    const warehouseId = firstLoc?.warehouseId ?? s.warehouses[0]!;
    const expected = at + int(4, 12) * DAY;
    const po: Row = {
      id: poId,
      number,
      supplier_id: supplierId,
      warehouse_id: warehouseId,
      status: 'sent',
      currency: s.currency,
      expected_on: dateOnly(expected),
      created_by_type: 'user',
      created_by_id: pick(s.users),
      sent_at: iso(at + 3_600_000),
      received_at: null,
      closed_at: null,
      created_at: iso(at),
      updated_at: iso(at + 3_600_000),
    };
    if (expected > now && chance(0.25)) {
      po.status = 'draft';
      po.sent_at = null;
    }
    s.push('purchase_orders', po);
    const lines = list.map((v, i) => {
      const qty = Math.max(v.moq, Math.round(v.target - 0.3 * v.target));
      openPo.set(v.id, number);
      const row: Row = {
        id: uuidv7(at),
        purchase_order_id: poId,
        position: i,
        variant_id: v.id,
        supplier_item_id: v.supplierItemId,
        supplier_sku: v.supplierSku,
        quantity: String(qty),
        ordered: String(qty),
        received: '0',
        cancelled: '0',
        unit_cost: money(v.cost * (0.95 + 0.1 * rand())),
      };
      s.push('purchase_order_lines', row);
      return { v, row, qty };
    });
    if (po.status === 'draft') return;
    count('purchase_order');
    schedule(expected, () => {
      const opId = s.op('receipt', expected, {
        supplier_id: supplierId,
        external_ref: `PO-${number}`,
      });
      for (const { v, row, qty } of lines) {
        const short = chance(0.08) ? Math.max(1, Math.floor(qty * 0.7)) : qty;
        const loc =
          (s.byVariant.get(v.id) ?? [])
            .map((p) => s.locs.get(p.locationId)!)
            .find((l) => l.warehouseId === warehouseId && l.eligible) ??
          [...s.locs.values()].find((l) => l.warehouseId === warehouseId && l.eligible)!;
        s.receive(
          opId,
          v,
          loc.id,
          short,
          Number(row.unit_cost),
          expected,
          'sellable',
          supplierId,
          `PO-${number}`,
          Math.min(short, profile.lot?.perDelivery ?? 1),
        );
        row.received = String(short);
        s.push('purchase_order_receipts', {
          id: uuidv7(expected),
          purchase_order_id: poId,
          line_id: row.id,
          operation_id: opId,
          quantity: String(short),
          created_at: iso(expected),
        });
        openPo.delete(v.id);
      }
      const partial = lines.some((l) => Number(l.row.received) < l.qty);
      po.status = partial ? 'partially_received' : 'received';
      po.received_at = partial ? null : iso(expected);
      po.updated_at = iso(expected);
      if (partial && chance(0.7)) {
        // Closed short a few days later: the rest is not coming.
        const closed = expected + 3 * DAY;
        schedule(closed, () => {
          po.status = 'closed';
          po.closed_at = iso(closed);
          po.updated_at = iso(closed);
          for (const l of lines) l.row.cancelled = String(l.qty - Number(l.row.received));
        });
      }
      count('receipt');
    });
  }

  function transfer(at: number) {
    if (s.warehouses.length < 2) return;
    const from = pick(s.warehouses);
    const to = pick(s.warehouses.filter((w) => w !== from));
    const toLocs = [...s.locs.values()].filter((l) => l.warehouseId === to && l.eligible);
    const fromLocs = [...s.locs.values()].filter((l) => l.warehouseId === from && l.eligible);
    if (!toLocs.length || !fromLocs.length) return;
    const fromLoc = pick(fromLocs);
    const toLoc = pick(toLocs);
    // Lines: variants with free sellable stock in the source warehouse.
    const picks: Array<{ v: Variant; qty: number }> = [];
    for (let tries = 0; tries < 30 && picks.length < int(3, 12); tries++) {
      const v = popular();
      if (picks.some((p) => p.v === v)) continue;
      const free = s.candidates(v, at, from).reduce((sum, p) => sum + p.onHand - p.allocated, 0);
      if (free < 2) continue;
      picks.push({
        v,
        qty: Math.max(1, Math.min(free - 1, Math.round(free * (0.2 + 0.3 * rand())))),
      });
    }
    if (!picks.length) return;
    const tId = uuidv7(at);
    const t: Row = {
      id: tId,
      kind: 'transfer',
      reference: `TR-${dateOnly(at).replaceAll('-', '')}-${int(10, 99)}`,
      from_location_id: fromLoc.id,
      to_location_id: toLoc.id,
      status: 'dispatched',
      created_by_type: 'user',
      created_by_id: pick(s.users),
      ready_at: iso(at),
      closed_at: null,
      created_at: iso(at - 3_600_000),
      updated_at: iso(at),
    };
    s.push('transfers', t);
    const dispatchOp = s.op('transfer_dispatch', at, { transfer_id: tId });
    const moved: Array<{ line: Row; positions: Array<{ transit: Pos; qty: number }> }> = [];
    picks.forEach(({ v, qty }, i) => {
      const line: Row = {
        id: uuidv7(at),
        transfer_id: tId,
        variant_id: v.id,
        position: i,
        condition: 'sellable',
        lot_id: null,
        planned: String(qty),
        cancelled: '0',
        dispatched: String(qty),
        received: '0',
        resolved: '0',
      };
      s.push('transfer_lines', line);
      let left = qty;
      const positions: Array<{ transit: Pos; qty: number }> = [];
      for (const p of s.candidates(v, at, from)) {
        if (left === 0) break;
        const take = Math.min(left, p.onHand - p.allocated);
        s.entry(dispatchOp, p, -take, at, null);
        const transit = s.position(v.id, s.inTransit, 'sellable', p.lotId, p.serialId, tId, at);
        s.entry(dispatchOp, transit, take, at, null);
        if (p.serialId) {
          const ser = s.serials.get(p.serialId)!;
          ser.status = 'in_transit';
          ser.positionId = transit.id;
          ser.lastOp = dispatchOp;
          ser.updatedAt = at;
        }
        positions.push({ transit, qty: take });
        left -= take;
      }
      moved.push({ line, positions });
    });
    count('transfer_dispatch');
    const arrive = at + int(18, 60) * 3_600_000;
    schedule(arrive, () => {
      const receiptOp = s.op('transfer_receipt', arrive, { transfer_id: tId });
      for (const { line, positions } of moved) {
        let got = 0;
        for (const { transit, qty } of positions) {
          s.entry(receiptOp, transit, -qty, arrive, null);
          const dest = s.position(
            transit.variantId,
            toLoc.id,
            'sellable',
            transit.lotId,
            transit.serialId,
            null,
            arrive,
          );
          s.entry(receiptOp, dest, qty, arrive, null);
          if (transit.serialId) {
            const ser = s.serials.get(transit.serialId)!;
            ser.status = 'in_stock';
            ser.positionId = dest.id;
            ser.lastOp = receiptOp;
            ser.updatedAt = arrive;
          }
          got += qty;
        }
        line.received = String(got);
      }
      t.status = 'received';
      t.closed_at = iso(arrive);
      t.updated_at = iso(arrive);
      count('transfer_receipt');
    });
  }

  function customerReturn(at: number) {
    // A line fulfilled two to twenty days ago (the list is in time order).
    let hi = fulfilledLines.length;
    while (hi > 0 && fulfilledLines[hi - 1]!.at > at - 2 * DAY) hi--;
    let lo = hi;
    while (lo > 0 && fulfilledLines[lo - 1]!.at > at - 20 * DAY) lo--;
    if (hi === lo) return;
    const i = lo + Math.floor(rand() * (hi - lo));
    const [f] = fulfilledLines.splice(i, 1) as [(typeof fulfilledLines)[number]];
    const v = f.v;
    const loc = s.locs.get(s.positions.get(f.res.allocs[0]!.positionId)!.locationId)!;
    const retId = uuidv7(at);
    const ret: Row = {
      id: retId,
      reference: `RMA-${int(10000, 99999)}`,
      order_ref: f.res.externalRef,
      reason: pick([
        'wrong size',
        'changed mind',
        'damaged in transit',
        'not as described',
        'arrived late',
      ]),
      status: 'received',
      location_id: loc.id,
      created_by_type: 'connector',
      created_by_id: 'shopify',
      authorized_at: iso(at - DAY),
      received_at: iso(at),
      completed_at: null,
      created_at: iso(at - 2 * DAY),
      updated_at: iso(at),
    };
    s.push('returns', ret);
    const qty = f.qty;
    const line: Row = {
      id: uuidv7(at),
      return_id: retId,
      variant_id: v.id,
      position: 0,
      expected: String(qty),
      received: String(qty),
      sellable: '0',
      damaged: '0',
      repair: '0',
      supplier_return: '0',
      disposed: '0',
    };
    s.push('return_lines', line);
    const opId = s.op('return', at, { return_id: retId, external_ref: f.res.externalRef }, [
      'user',
      pick(s.users),
      'dashboard',
    ]);
    const units: Array<{ unit: Row; pos: Pos; qty: number; unitCost: number | null }> = [];
    for (const c of f.costs) {
      const serialId = c.serialId;
      if (serialId) {
        const ser = s.serials.get(serialId)!;
        ser.status = 'in_stock';
        ser.lastOp = opId;
        ser.updatedAt = at;
      }
      const pos = s.position(v.id, loc.id, 'quarantine', c.lotId, serialId, null, at);
      if (serialId) s.serials.get(serialId)!.positionId = pos.id;
      const cost = s.cost(v.id, opId, 'return', c.qty, c.unit, at);
      s.entry(
        opId,
        pos,
        c.qty,
        at,
        c.unit === null ? cost : { unitCost: c.unit, basis: 'entered' },
      );
      const existing = units.find((u) => u.pos === pos);
      if (existing) {
        existing.qty += c.qty;
        existing.unit.received = String(existing.qty);
        continue;
      }
      const unit: Row = {
        id: uuidv7(at),
        return_id: retId,
        line_id: line.id,
        variant_id: v.id,
        lot_id: c.lotId,
        serial_id: serialId,
        received: String(c.qty),
        inspected: '0',
        matched: serialId ? true : null,
        unit_cost: c.unit === null ? null : money(c.unit),
        cost_source: c.unit === null ? 'average' : 'fulfillment',
      };
      s.push('return_units', unit);
      units.push({ unit, pos, qty: c.qty, unitCost: c.unit });
    }
    if (v.ooak) v.sold = false;
    count('return');
    const inspect = at + int(4, 72) * 3_600_000;
    schedule(inspect, () => {
      const r = rand();
      const disposition = r < 0.8 ? 'sellable' : r < 0.95 ? 'damaged' : 'disposal';
      const kind = disposition === 'disposal' ? 'adjustment' : 'condition_change';
      const opId2 = s.op(kind, inspect, {
        return_id: retId,
        reason: disposition === 'disposal' ? 'write_off' : null,
      });
      for (const u of units) {
        s.entry(opId2, u.pos, -u.qty, inspect, null);
        if (disposition === 'disposal') {
          const cost = s.cost(v.id, opId2, 'adjustment', -u.qty, null, inspect);
          // The entry above records the move out; give it the cost the disposal left at.
          const last = s.out.inventory_entries!.at(-1)!;
          last.unit_cost = cost.unitCost === null ? null : money(cost.unitCost);
          last.cost_basis = cost.basis;
          if (u.pos.serialId) {
            const ser = s.serials.get(u.pos.serialId)!;
            ser.status = 'written_off';
            ser.positionId = null;
            ser.lastOp = opId2;
            ser.updatedAt = inspect;
          }
        } else {
          const dest = s.position(
            v.id,
            u.pos.locationId,
            disposition,
            u.pos.lotId,
            u.pos.serialId,
            null,
            inspect,
          );
          s.entry(opId2, dest, u.qty, inspect, null);
          if (u.pos.serialId) {
            const ser = s.serials.get(u.pos.serialId)!;
            ser.positionId = dest.id;
            ser.lastOp = opId2;
            ser.updatedAt = inspect;
          }
        }
        u.unit.inspected = String(u.qty);
        s.push('return_inspections', {
          id: uuidv7(inspect),
          return_id: retId,
          line_id: line.id,
          unit_id: u.unit.id,
          operation_id: opId2,
          disposition,
          quantity: String(u.qty),
          created_at: iso(inspect),
        });
      }
      const col = disposition === 'disposal' ? 'disposed' : disposition;
      line[col] = String(qty);
      ret.status = 'completed';
      ret.completed_at = iso(inspect);
      ret.updated_at = iso(inspect);
      count('inspection');
    });
  }

  function countLocation(at: number) {
    // A location with stock: count every position there; a few lines differ.
    const p0 = s.positions.get(pick([...s.positions.keys()]))!;
    const loc = s.locs.get(p0.locationId)!;
    if (!loc.eligible) return;
    const here = [...s.positions.values()].filter(
      (p) => p.locationId === loc.id && p.condition === 'sellable' && !p.transferId && p.onHand > 0,
    );
    if (!here.length || here.length > 200) return;
    const sessionId = uuidv7(at - 3_600_000);
    const session: Row = {
      id: sessionId,
      name: `Count ${loc.path} ${dateOnly(at)}`,
      location_id: loc.id,
      blind: chance(0.3),
      status: 'submitted',
      created_by_type: 'user',
      created_by_id: pick(s.users),
      submitted_at: iso(at),
      operation_id: null,
      created_at: iso(at - 3_600_000),
      updated_at: iso(at),
    };
    s.push('count_sessions', session);
    const opId = s.op('count', at, { count_session_id: sessionId, reason: 'count_correction' });
    session.operation_id = opId;
    for (const p of here) {
      const v = s.variants.get(p.variantId)!;
      let counted = p.onHand;
      if (!p.serialId && chance(0.12))
        counted = Math.max(p.allocated, p.onHand + pick([-2, -1, -1, 1]));
      if (v.ooak) counted = Math.min(counted, p.onHand);
      const diff = counted - p.onHand;
      s.push('count_lines', {
        id: uuidv7(at),
        session_id: sessionId,
        variant_id: p.variantId,
        location_id: p.locationId,
        condition: p.condition,
        lot_id: p.lotId,
        serial_id: p.serialId,
        position_id: p.id,
        expected: String(p.onHand),
        counted: String(counted),
        counted_version: p.bumps,
        counted_on_hand: String(p.onHand),
        counted_at: iso(at - 1_800_000),
        counted_by: session.created_by_id,
        status: 'posted',
        posted_delta: String(diff),
      });
      if (diff !== 0) {
        const cost = s.cost(
          v.id,
          opId,
          'count',
          diff,
          diff > 0 ? (s.costs.get(v.id)!.avg ?? v.cost) : null,
          at,
        );
        s.entry(opId, p, diff, at, cost);
      }
    }
    count('count');
  }

  function damage(at: number) {
    const v = popular();
    const p = s.candidates(v, at)[0];
    if (!p || p.serialId) return;
    const opId = s.op('adjustment', at, { reason: 'damaged' });
    const cost = s.cost(v.id, opId, 'adjustment', -1, null, at);
    s.entry(opId, p, -1, at, cost);
    count('adjustment');
  }

  function expiredWriteOff(at: number) {
    // Units of lots past their sell-by date and not reserved go out (the expiry sweep's job).
    const opIds = new Map<string, string>();
    for (const p of s.positions.values()) {
      if (!p.lotId || p.condition !== 'sellable' || p.onHand - p.allocated <= 0 || p.transferId)
        continue;
      const v = s.variants.get(p.variantId)!;
      if (s.lotSellable(p.lotId, v, at)) continue;
      let opId = opIds.get('x');
      if (!opId) {
        opId = s.op('adjustment', at, { reason: 'expired' });
        opIds.set('x', opId);
      }
      const qty = p.onHand - p.allocated;
      const cost = s.cost(v.id, opId, 'adjustment', -qty, null, at);
      s.entry(opId, p, -qty, at, cost);
    }
    if (opIds.size) count('expiry_write_off');
  }

  // The days: weekdays busier, office hours, growing by half over the three months.
  const days = Math.floor((now - openAt) / DAY);
  for (let d = 1; d <= days; d++) {
    const dayStart = openAt + d * DAY - ((openAt % DAY) - 0);
    const weekday = new Date(dayStart).getUTCDay();
    const busy = (weekday === 0 || weekday === 6 ? 0.55 : 1.12) * (0.8 + 0.4 * (d / days));
    const ops = Math.round(perDay * busy);
    const orders = Math.round((ops * profile.orderShare) / ((2 * (1 + profile.linesMax)) / 2));
    const hour = () => dayStart + (7 + 14 * rand()) * 3_600_000;
    for (let i = 0; i < orders; i++) schedule(hour(), () => order(cur));
    for (let i = 0; i < profile.transfersPerDay * busy; i++) schedule(hour(), () => transfer(cur));
    for (let i = 0; i < profile.countsPerDay; i++) schedule(hour(), () => countLocation(cur));
    for (let i = 0; i < profile.damagePerDay; i++) schedule(hour(), () => damage(cur));
    const returns = Math.round(orders * 1.5 * profile.returnRate);
    for (let i = 0; i < returns; i++) schedule(hour(), () => customerReturn(cur));
    if (d % 2 === 0) schedule(dayStart + 6 * 3_600_000, () => restock(cur));
    if (profile.lot) schedule(dayStart + 5 * 3_600_000, () => expiredWriteOff(cur));
  }
  // Run the events in time order; events may schedule later ones.
  for (let e = next(); e; e = next()) {
    cur = e.at;
    e.run();
  }

  // Write ---------------------------------------------------------------------------------------
  const tSim = Date.now();
  for (const v of s.variants.values()) {
    if (v.tracking !== 'none' || v.ooak)
      s.push('variant_updates', {
        id: v.id,
        tracking_mode: v.tracking,
        one_of_a_kind: v.ooak,
        sell_by_margin_days: v.margin,
      });
    if (v.ooak && v.sold) s.push('product_sold', { id: v.productId });
  }
  for (const r of s.reservations) {
    const outstanding = r.allocs.reduce((sum, a) => sum + a.quantity - a.released - a.fulfilled, 0);
    s.push('reservations', {
      id: r.id,
      variant_id: r.variantId,
      quantity: String(r.quantity),
      status: r.status === 'active' && outstanding === 0 ? 'fulfilled' : r.status,
      purpose: r.purpose,
      external_ref: r.externalRef,
      created_operation_id: r.opId,
      channel: r.channel,
      created_at: iso(r.createdAt),
      updated_at: iso(r.updatedAt),
    });
    for (const a of r.allocs)
      s.push('reservation_allocations', {
        id: a.id,
        reservation_id: a.reservationId,
        position_id: a.positionId,
        quantity: String(a.quantity),
        released: String(a.released),
        fulfilled: String(a.fulfilled),
        created_at: iso(a.createdAt),
      });
  }
  for (const l of s.lots.values())
    s.push('lots', {
      id: l.id,
      variant_id: l.variantId,
      code: l.code,
      code_normalized: normalizeCode(l.code),
      expires_on: l.expiresOn,
      produced_on: l.producedOn,
      supplier_id: l.supplierId,
      purchase_order_ref: l.po,
      created_operation_id: l.opId,
      created_at: iso(l.createdAt),
    });
  for (const x of s.serials.values())
    s.push('serial_units', {
      id: x.id,
      variant_id: x.variantId,
      serial: x.serial,
      serial_normalized: normalizeCode(x.serial),
      status: x.status,
      position_id: x.positionId,
      created_operation_id: x.createdOp,
      last_operation_id: x.lastOp,
      created_at: iso(x.createdAt),
      updated_at: iso(x.updatedAt),
    });
  for (const p of s.positions.values()) {
    const row = {
      id: p.id,
      variant_id: p.variantId,
      location_id: p.locationId,
      condition: p.condition,
      lot_id: p.lotId,
      serial_id: p.serialId,
      transfer_id: p.transferId,
      on_hand: String(p.onHand),
      allocated: String(p.allocated),
      received_at: p.receivedAt === null ? null : iso(p.receivedAt),
      version: p.bumps,
      created_at: iso(p.createdAt),
      updated_at: iso(p.updatedAt),
    };
    if (p.isNew) s.push('positions_new', row);
    // Unchanged positions keep the row the import wrote (migration 0017 set received_at).
    else if (p.bumps > 0) s.push('positions_changed', row);
  }
  for (const [variantId, c] of s.costs)
    s.push('variant_costs_final', {
      variant_id: variantId,
      quantity: String(c.qty),
      average_cost: c.avg === null ? null : money(c.avg),
    });

  const sizes = Object.fromEntries(Object.entries(s.out).map(([k, v]) => [k, v.length]));
  console.log(
    `${s.name}: simulated in ${((tSim - t0) / 1000).toFixed(1)} s`,
    JSON.stringify(stats),
  );
  console.log(`  rows: ${JSON.stringify(sizes)}`);
  if (args['dry-run']) {
    await client.query('rollback');
    continue;
  }

  const T: Record<string, Record<string, string>> = {
    inventory_operations: {
      id: 'uuid',
      kind: 'text',
      actor_type: 'text',
      actor_id: 'text',
      source: 'text',
      external_ref: 'text',
      reason: 'text',
      supplier_id: 'uuid',
      transfer_id: 'uuid',
      return_id: 'uuid',
      count_session_id: 'uuid',
      occurred_at: 'timestamptz',
    },
    inventory_entries: {
      id: 'uuid',
      operation_id: 'uuid',
      position_id: 'uuid',
      variant_id: 'uuid',
      location_id: 'uuid',
      delta: 'numeric',
      unit_cost: 'numeric',
      cost_basis: 'text',
      lot_id: 'uuid',
      serial_id: 'uuid',
      reservation_id: 'uuid',
      created_at: 'timestamptz',
    },
    lots: {
      id: 'uuid',
      variant_id: 'uuid',
      code: 'text',
      code_normalized: 'text',
      expires_on: 'date',
      produced_on: 'date',
      supplier_id: 'uuid',
      purchase_order_ref: 'text',
      created_operation_id: 'uuid',
      created_at: 'timestamptz',
    },
    serial_units: {
      id: 'uuid',
      variant_id: 'uuid',
      serial: 'text',
      serial_normalized: 'text',
      status: 'text',
      position_id: 'uuid',
      created_operation_id: 'uuid',
      last_operation_id: 'uuid',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    inventory_positions: {
      id: 'uuid',
      variant_id: 'uuid',
      location_id: 'uuid',
      condition: 'text',
      lot_id: 'uuid',
      serial_id: 'uuid',
      transfer_id: 'uuid',
      on_hand: 'numeric',
      allocated: 'numeric',
      received_at: 'timestamptz',
      version: 'integer',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    reservations: {
      id: 'uuid',
      variant_id: 'uuid',
      quantity: 'numeric',
      status: 'text',
      purpose: 'text',
      external_ref: 'text',
      created_operation_id: 'uuid',
      channel: 'text',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    reservation_allocations: {
      id: 'uuid',
      reservation_id: 'uuid',
      position_id: 'uuid',
      quantity: 'numeric',
      released: 'numeric',
      fulfilled: 'numeric',
      created_at: 'timestamptz',
    },
    variant_cost_history: {
      id: 'uuid',
      variant_id: 'uuid',
      operation_id: 'uuid',
      occurred_at: 'timestamptz',
      kind: 'text',
      quantity_delta: 'numeric',
      unit_cost: 'numeric',
      quantity_after: 'numeric',
      average_after: 'numeric',
    },
    transfers: {
      id: 'uuid',
      kind: 'text',
      reference: 'text',
      from_location_id: 'uuid',
      to_location_id: 'uuid',
      status: 'text',
      created_by_type: 'text',
      created_by_id: 'text',
      ready_at: 'timestamptz',
      closed_at: 'timestamptz',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    transfer_lines: {
      id: 'uuid',
      transfer_id: 'uuid',
      variant_id: 'uuid',
      position: 'integer',
      condition: 'text',
      lot_id: 'uuid',
      planned: 'numeric',
      cancelled: 'numeric',
      dispatched: 'numeric',
      received: 'numeric',
      resolved: 'numeric',
    },
    returns: {
      id: 'uuid',
      reference: 'text',
      order_ref: 'text',
      reason: 'text',
      status: 'text',
      location_id: 'uuid',
      created_by_type: 'text',
      created_by_id: 'text',
      authorized_at: 'timestamptz',
      received_at: 'timestamptz',
      completed_at: 'timestamptz',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    return_lines: {
      id: 'uuid',
      return_id: 'uuid',
      variant_id: 'uuid',
      position: 'integer',
      expected: 'numeric',
      received: 'numeric',
      sellable: 'numeric',
      damaged: 'numeric',
      repair: 'numeric',
      supplier_return: 'numeric',
      disposed: 'numeric',
    },
    return_units: {
      id: 'uuid',
      return_id: 'uuid',
      line_id: 'uuid',
      variant_id: 'uuid',
      lot_id: 'uuid',
      serial_id: 'uuid',
      received: 'numeric',
      inspected: 'numeric',
      matched: 'boolean',
      unit_cost: 'numeric',
      cost_source: 'text',
    },
    return_inspections: {
      id: 'uuid',
      return_id: 'uuid',
      line_id: 'uuid',
      unit_id: 'uuid',
      operation_id: 'uuid',
      disposition: 'text',
      quantity: 'numeric',
      created_at: 'timestamptz',
    },
    count_sessions: {
      id: 'uuid',
      name: 'text',
      location_id: 'uuid',
      blind: 'boolean',
      status: 'text',
      created_by_type: 'text',
      created_by_id: 'text',
      submitted_at: 'timestamptz',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    count_lines: {
      id: 'uuid',
      session_id: 'uuid',
      variant_id: 'uuid',
      location_id: 'uuid',
      condition: 'text',
      lot_id: 'uuid',
      serial_id: 'uuid',
      position_id: 'uuid',
      expected: 'numeric',
      counted: 'numeric',
      counted_version: 'integer',
      counted_on_hand: 'numeric',
      counted_at: 'timestamptz',
      counted_by: 'text',
      status: 'text',
      posted_delta: 'numeric',
    },
    purchase_orders: {
      id: 'uuid',
      number: 'integer',
      supplier_id: 'uuid',
      warehouse_id: 'uuid',
      status: 'text',
      currency: 'text',
      expected_on: 'date',
      created_by_type: 'text',
      created_by_id: 'text',
      sent_at: 'timestamptz',
      received_at: 'timestamptz',
      closed_at: 'timestamptz',
      created_at: 'timestamptz',
      updated_at: 'timestamptz',
    },
    purchase_order_lines: {
      id: 'uuid',
      purchase_order_id: 'uuid',
      position: 'integer',
      variant_id: 'uuid',
      supplier_item_id: 'uuid',
      supplier_sku: 'text',
      quantity: 'numeric',
      ordered: 'numeric',
      received: 'numeric',
      cancelled: 'numeric',
      unit_cost: 'numeric',
    },
    purchase_order_receipts: {
      id: 'uuid',
      purchase_order_id: 'uuid',
      line_id: 'uuid',
      operation_id: 'uuid',
      quantity: 'numeric',
      created_at: 'timestamptz',
    },
    reorder_rules: {
      id: 'uuid',
      variant_id: 'uuid',
      warehouse_id: 'uuid',
      reorder_point: 'numeric',
      reorder_quantity: 'numeric',
      maximum_level: 'numeric',
      preferred_supplier_id: 'uuid',
      created_at: 'timestamptz',
    },
  };
  const insert = async (table: string, rows: Row[] | undefined, target = table) => {
    if (!rows?.length) return;
    const cols = T[target]!;
    const names = Object.keys(cols);
    const decl = names.map((n) => `"${n}" ${cols[n]}`).join(', ');
    for (let i = 0; i < rows.length; i += 5000) {
      await client.query(
        `insert into ${target} (shop_id, ${names.join(', ')})
         select $2, ${names.map((n) => `x."${n}"`).join(', ')} from jsonb_to_recordset($1::jsonb) as x(${decl})`,
        [JSON.stringify(rows.slice(i, i + 5000)), s.id],
      );
    }
  };
  // Converted variants: their opening rows go, and the replay received them again.
  const conv = [...s.variants.values()].filter((v) => v.converted).map((v) => v.id);
  if (conv.length) {
    await client.query(
      `create temp table conv_ops on commit drop as
       select distinct operation_id as id from inventory_entries where shop_id = $1 and variant_id = any($2::uuid[])`,
      [s.id, conv],
    );
    await client.query(
      `delete from inventory_entries where shop_id = $1 and variant_id = any($2::uuid[])`,
      [s.id, conv],
    );
    await client.query(
      `delete from inventory_positions where shop_id = $1 and variant_id = any($2::uuid[])`,
      [s.id, conv],
    );
    await client.query(
      `delete from inventory_operations o using conv_ops c where o.shop_id = $1 and o.id = c.id
         and not exists (select 1 from inventory_entries e where e.shop_id = $1 and e.operation_id = o.id)`,
      [s.id],
    );
  }
  await client.query(
    `update variants v set tracking_mode = x.tracking_mode, one_of_a_kind = x.one_of_a_kind,
       sell_by_margin_days = x.sell_by_margin_days, version = v.version + 1
     from jsonb_to_recordset($1::jsonb) as x(id uuid, tracking_mode text, one_of_a_kind boolean,
       sell_by_margin_days integer)
     where v.shop_id = $2 and v.id = x.id`,
    [JSON.stringify(s.out.variant_updates ?? []), s.id],
  );
  await insert('transfers', s.out.transfers);
  await insert('returns', s.out.returns);
  await insert('count_sessions', s.out.count_sessions);
  await insert('inventory_operations', s.out.inventory_operations);
  await client.query(
    `update count_sessions c set operation_id = x.operation_id
     from jsonb_to_recordset($1::jsonb) as x(id uuid, operation_id uuid)
     where c.shop_id = $2 and c.id = x.id`,
    [
      JSON.stringify(
        (s.out.count_sessions ?? []).map((c) => ({ id: c.id, operation_id: c.operation_id })),
      ),
      s.id,
    ],
  );
  await insert('lots', s.out.lots);
  await insert('positions_new', s.out.positions_new, 'inventory_positions');
  await client.query(
    `update inventory_positions p set on_hand = x.on_hand, allocated = x.allocated,
       received_at = x.received_at, version = p.version + x.version, updated_at = x.updated_at
     from jsonb_to_recordset($1::jsonb) as x(id uuid, on_hand numeric, allocated numeric,
       received_at timestamptz, version integer, updated_at timestamptz)
     where p.shop_id = $2 and p.id = x.id`,
    [JSON.stringify(s.out.positions_changed ?? []), s.id],
  );
  await insert('serial_units', s.out.serial_units);
  await insert('reservations', s.out.reservations);
  await insert('reservation_allocations', s.out.reservation_allocations);
  await insert('inventory_entries', s.out.inventory_entries);
  await client.query(
    `delete from variant_cost_history where shop_id = $1 and kind = 'opening' and variant_id = any($2::uuid[])`,
    [s.id, conv],
  );
  await client.query(
    `update variant_cost_history set occurred_at = $2 where shop_id = $1 and kind = 'opening'`,
    [s.id, iso(openAt)],
  );
  await client.query(
    `update variant_cost_history h set average_after = c.average_cost
     from (select variant_id, (sum(delta * unit_cost) / nullif(sum(delta), 0)) as average_cost
           from inventory_entries where shop_id = $1 and unit_cost is not null and created_at <= $2
           group by variant_id) c
     where h.shop_id = $1 and h.kind = 'opening' and h.variant_id = c.variant_id`,
    [s.id, iso(openAt)],
  );
  await insert('variant_cost_history', s.out.variant_cost_history);
  await client.query(
    `insert into variant_costs (shop_id, variant_id, quantity, average_cost)
     select $2, x.variant_id, x.quantity, x.average_cost
     from jsonb_to_recordset($1::jsonb) as x(variant_id uuid, quantity numeric, average_cost numeric)
     on conflict (shop_id, variant_id) do update set quantity = excluded.quantity,
       average_cost = excluded.average_cost, version = variant_costs.version + 1, updated_at = now()`,
    [JSON.stringify(s.out.variant_costs_final ?? []), s.id],
  );
  await insert('transfer_lines', s.out.transfer_lines);
  await insert('return_lines', s.out.return_lines);
  await insert('return_units', s.out.return_units);
  await insert('return_inspections', s.out.return_inspections);
  await insert('count_lines', s.out.count_lines);
  await insert('purchase_orders', s.out.purchase_orders);
  await insert('purchase_order_lines', s.out.purchase_order_lines);
  await insert('purchase_order_receipts', s.out.purchase_order_receipts);
  await client.query(
    `insert into purchase_order_counters (shop_id, last_number) values ($1, $2)
     on conflict (shop_id) do update set last_number = greatest(purchase_order_counters.last_number, excluded.last_number)`,
    [s.id, s.poNumber],
  );
  await insert('reorder_rules', s.out.reorder_rules);
  await client.query(
    `update products p set status = 'sold', version = p.version + 1
     from jsonb_to_recordset($1::jsonb) as x(id uuid) where p.shop_id = $2 and p.id = x.id`,
    [JSON.stringify(s.out.product_sold ?? []), s.id],
  );
  if (args.check) {
    const problems = await q<{ problem: string; n: number }>(
      `select problem, count(*)::int as n from (
         select problem from stock_reconciliation_problems()
         union all select problem from transfer_reconciliation_problems()
         union all select problem from return_reconciliation_problems()) x group by problem`,
    );
    if (problems.length) {
      console.log(`  PROBLEMS: ${JSON.stringify(problems)}`);
      await client.query('rollback');
      continue;
    }
    console.log('  reconciliation: no problems');
  }
  await client.query('commit');
  console.log(`  written in ${((Date.now() - tSim) / 1000).toFixed(1)} s`);
}
await client.end();
