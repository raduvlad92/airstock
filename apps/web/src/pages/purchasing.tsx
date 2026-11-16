import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { ApiError, api, command, type Out } from '../api.ts';
import {
  Badge,
  Card,
  Empty,
  ErrorNotice,
  Field,
  formatDateTime,
  formatDecimal,
  Loading,
  Notice,
  PageHeader,
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { useLocations, useWarehouses } from './warehouses.tsx';

type PurchaseOrders = Out<typeof ops.listPurchaseOrders>;
type PurchaseOrder = Out<typeof ops.getPurchaseOrder>;
type Suppliers = Out<typeof ops.listSuppliers>;
type SupplierDetail = Out<typeof ops.getSupplier>;
type Variants = Out<typeof ops.searchVariants>;
type Packaging = Out<typeof ops.getPackaging>;

const STATUS_TONE: Record<string, string> = {
  draft: 'muted',
  sent: '',
  partially_received: 'warn',
  received: 'ok',
  closed: 'muted',
  cancelled: 'muted',
};

const FILTERS = [
  ['all', 'All'],
  ['open', 'Open (sent or partly received)'],
  ['draft', 'Drafts'],
  ['received', 'Received'],
  ['closed', 'Closed'],
  ['cancelled', 'Cancelled'],
] as const;

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS_TONE[status]}>{titleCase(status)}</Badge>;
}

function usePurchasingRefresh(shopId: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'purchasing'] });
}

export function PurchasingPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const search = useSearch({ strict: false }) as { po?: string };
  const navigate = useNavigate();
  const context = useShopContext(shopId);
  const canManage = can(context.data, 'purchasing.manage');
  const [creating, setCreating] = useState(false);
  const open = (id: string | null) =>
    void navigate({
      to: '/shops/$shopId/purchasing',
      params: { shopId },
      search: id ? { po: id } : {},
    });
  return (
    <div className="stack">
      <PageHeader
        title="Purchasing"
        subtitle="Purchase orders to your suppliers: draft, send as PDF, receive, and close."
        actions={
          canManage ? (
            <button type="button" className="small" onClick={() => setCreating(!creating)}>
              New purchase order
            </button>
          ) : null
        }
      />
      {creating ? (
        <DraftForm
          shopId={shopId}
          onDone={(id) => {
            setCreating(false);
            if (id) open(id);
          }}
        />
      ) : null}
      {search.po ? (
        <PurchaseOrderPanel
          shopId={shopId}
          purchaseOrderId={search.po}
          onClose={() => open(null)}
        />
      ) : null}
      <PurchaseOrderList shopId={shopId} selected={search.po ?? null} onOpen={open} />
    </div>
  );
}

function PurchaseOrderList({
  shopId,
  selected,
  onOpen,
}: {
  shopId: string;
  selected: string | null;
  onOpen: (id: string) => void;
}) {
  const [status, setStatus] = useState<(typeof FILTERS)[number][0]>('all');
  const list = useQuery({
    queryKey: ['shop', shopId, 'purchasing', 'list', status],
    queryFn: () =>
      api<PurchaseOrders>(`/shops/${shopId}/purchase-orders`, {
        query: { status: status === 'all' ? undefined : status, limit: 100 },
      }),
  });
  return (
    <Card
      title="Purchase orders"
      actions={
        <select
          aria-label="Show"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
        >
          {FILTERS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      }
    >
      <ErrorNotice error={list.error} />
      {list.isPending ? <Loading /> : null}
      {list.data && list.data.purchaseOrders.length === 0 ? (
        <Empty>No purchase orders here yet.</Empty>
      ) : null}
      {list.data && list.data.purchaseOrders.length > 0 ? (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Order</th>
                <th>Supplier</th>
                <th>Deliver to</th>
                <th>Status</th>
                <th>Expected</th>
                <th className="num">Still open</th>
                <th className="num">Total</th>
              </tr>
            </thead>
            <tbody>
              {list.data.purchaseOrders.map((o) => (
                <tr
                  key={o.id}
                  className={o.id === selected ? 'selected clickable' : 'clickable'}
                  onClick={() => onOpen(o.id)}
                >
                  <td>
                    <button type="button" className="link-button" onClick={() => onOpen(o.id)}>
                      {o.number}
                    </button>
                  </td>
                  <td>{o.supplierName}</td>
                  <td>{o.warehouseName}</td>
                  <td>
                    <StatusBadge status={o.status} />
                  </td>
                  <td>
                    {o.expectedOn ?? '—'} {o.overdue ? <Badge tone="error">Overdue</Badge> : null}
                  </td>
                  <td className="num">{formatDecimal(o.open)}</td>
                  <td className="num">{o.total === null ? '—' : formatDecimal(o.total, 2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Card>
  );
}

// Drafting -----------------------------------------------------------------------------------

export interface LineDraft {
  key: string;
  variantId: string;
  label: string;
  /** '' = the supplier item's pack (default), 'units' = base units, else a pack ID. */
  pack: string;
  quantity: string;
  unitCost: string;
}

let lineKey = 0;
export const newLine = (variantId: string, label: string, pack = '', quantity = ''): LineDraft => ({
  key: `line-${++lineKey}`,
  variantId,
  label,
  pack,
  quantity,
  unitCost: '',
});

export function lineBody(l: LineDraft) {
  return {
    variantId: l.variantId,
    quantity: l.quantity.trim(),
    ...(l.pack === 'units' ? { packId: null } : l.pack ? { packId: l.pack } : {}),
    ...(l.unitCost.trim() ? { unitCost: l.unitCost.trim() } : {}),
  };
}

function useSuppliers(shopId: string) {
  return useQuery({
    queryKey: ['shop', shopId, 'suppliers', 'list', '', false],
    queryFn: () => api<Suppliers>(`/shops/${shopId}/suppliers`, { query: { limit: 200 } }),
    select: (d) => ({ suppliers: d.suppliers, nextCursor: d.nextCursor }),
  });
}

function DraftForm({ shopId, onDone }: { shopId: string; onDone: (id: string | null) => void }) {
  const context = useShopContext(shopId);
  const suppliers = useSuppliers(shopId);
  const warehouses = useWarehouses(shopId);
  const active = (warehouses.data?.warehouses ?? []).filter((w) => w.status === 'active');
  const [supplierId, setSupplierId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [expectedOn, setExpectedOn] = useState('');
  const [supplierReference, setSupplierReference] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const warehouse = warehouseId || active[0]?.warehouseId || '';
  const refresh = usePurchasingRefresh(shopId);
  const create = useMutation({
    mutationFn: () =>
      command<PurchaseOrder>(`/shops/${shopId}/purchase-orders`, {
        supplierId,
        warehouseId: warehouse,
        ...(locationId ? { locationId } : {}),
        ...(expectedOn ? { expectedOn } : {}),
        ...(supplierReference.trim() ? { supplierReference: supplierReference.trim() } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        lines: lines.map(lineBody),
      }),
    onSuccess: async (po) => {
      await refresh();
      onDone(po.id);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="New purchase order">
      <form className="stack" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Supplier">
            <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} required>
              <option value="">Choose a supplier</option>
              {(suppliers.data?.suppliers ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Deliver to">
            <select
              value={warehouse}
              onChange={(e) => {
                setWarehouseId(e.target.value);
                setLocationId('');
              }}
              required
            >
              {active.map((w) => (
                <option key={w.warehouseId} value={w.warehouseId}>
                  {w.name}
                </option>
              ))}
            </select>
          </Field>
          <ReceivingLocationSelect
            shopId={shopId}
            warehouseId={warehouse}
            value={locationId}
            onChange={setLocationId}
          />
          <Field label="Expected">
            <input type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />
          </Field>
          <Field label="Supplier reference">
            <input
              value={supplierReference}
              onChange={(e) => setSupplierReference(e.target.value)}
              placeholder="Their order or confirmation number"
              maxLength={200}
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Printed on the order, such as delivery hours"
            rows={2}
            maxLength={5000}
          />
        </Field>
        <LinesEditor
          shopId={shopId}
          supplierId={supplierId}
          lines={lines}
          onChange={setLines}
          showCosts={can(context.data, 'costs.read')}
          currency={context.data?.shop.currency ?? ''}
        />
        <div className="form-actions">
          <button
            type="submit"
            disabled={create.isPending || !supplierId || !warehouse || lines.length === 0}
          >
            Save draft
          </button>
          <button type="button" className="ghost" onClick={() => onDone(null)}>
            Cancel
          </button>
        </div>
        <ErrorNotice error={create.error} />
      </form>
    </Card>
  );
}

function ReceivingLocationSelect({
  shopId,
  warehouseId,
  value,
  onChange,
  label = 'Receiving location',
  required = false,
}: {
  shopId: string;
  warehouseId: string;
  value: string;
  onChange: (id: string) => void;
  label?: string;
  required?: boolean;
}) {
  const locations = useLocations(shopId);
  const leaves = (locations.data?.locations ?? []).filter(
    (l) => l.warehouseId === warehouseId && l.holdsStockAllowed && l.status === 'active',
  );
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        {required ? null : <option value="">Choose when receiving</option>}
        {leaves.map((l) => (
          <option key={l.locationId} value={l.locationId}>
            {l.path}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Order lines: pick from the supplier's items or search the catalog; packs come from the item. */
export function LinesEditor({
  shopId,
  supplierId,
  lines,
  onChange,
  showCosts,
  currency,
}: {
  shopId: string;
  supplierId: string;
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  showCosts: boolean;
  currency: string;
}) {
  const supplier = useQuery({
    queryKey: ['shop', shopId, 'suppliers', 'detail', supplierId],
    queryFn: () => api<SupplierDetail>(`/shops/${shopId}/suppliers/${supplierId}`),
    enabled: supplierId !== '',
  });
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQuery(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const found = useQuery({
    queryKey: ['shop', shopId, 'variants', 'search', query],
    queryFn: () => api<Variants>(`/shops/${shopId}/variants`, { query: { query, limit: 8 } }),
    enabled: query.length >= 2,
  });
  const update = (key: string, patch: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const items = supplier.data?.items ?? [];
  return (
    <div className="stack">
      <h3>Lines</h3>
      {lines.length === 0 ? <Empty>Add the items to order.</Empty> : null}
      {lines.length > 0 ? (
        <div className="table-wrap">
          <table className="table compact">
            <thead>
              <tr>
                <th>Item</th>
                <th>Pack</th>
                <th className="num">Quantity</th>
                {showCosts ? <th className="num">Unit cost ({currency})</th> : null}
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td>{l.label}</td>
                  <td>
                    <PackSelect
                      shopId={shopId}
                      variantId={l.variantId}
                      value={l.pack}
                      onChange={(pack) => update(l.key, { pack })}
                    />
                  </td>
                  <td className="num">
                    <input
                      aria-label={`Quantity for ${l.label}`}
                      className="num-input"
                      value={l.quantity}
                      onChange={(e) => update(l.key, { quantity: e.target.value })}
                      inputMode="decimal"
                      placeholder="0"
                      required
                    />
                  </td>
                  {showCosts ? (
                    <td className="num">
                      <input
                        aria-label={`Unit cost for ${l.label}`}
                        className="num-input"
                        value={l.unitCost}
                        onChange={(e) => update(l.key, { unitCost: e.target.value })}
                        inputMode="decimal"
                        placeholder="Supplier’s last cost"
                      />
                    </td>
                  ) : null}
                  <td>
                    <button
                      type="button"
                      className="ghost small"
                      onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <div className="inline-form">
        {items.length > 0 ? (
          <Field label="Add from this supplier">
            <select
              value=""
              onChange={(e) => {
                const item = items.find((i) => i.id === e.target.value);
                if (item)
                  onChange([
                    ...lines,
                    newLine(
                      item.variantId,
                      `${item.productName} · ${item.sku}`,
                      item.packId ?? 'units',
                      item.minimumOrderQuantity ? formatDecimal(item.minimumOrderQuantity) : '',
                    ),
                  ]);
              }}
            >
              <option value="">Choose an item</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.productName} · {i.sku}
                  {i.packName ? ` (${i.packName})` : ''}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Add any item">
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search by name or SKU"
            maxLength={200}
          />
        </Field>
      </div>
      {found.data && query.length >= 2 ? (
        <div className="chip-list">
          {found.data.variants.length === 0 ? <span className="muted">No matches.</span> : null}
          {found.data.variants.map((v) => (
            <button
              key={v.variantId}
              type="button"
              className="small ghost"
              onClick={() => {
                onChange([...lines, newLine(v.variantId, `${v.productName} · ${v.sku}`)]);
                setText('');
              }}
            >
              + {v.productName} · {v.sku}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PackSelect({
  shopId,
  variantId,
  value,
  onChange,
}: {
  shopId: string;
  variantId: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const packaging = useQuery({
    queryKey: ['shop', shopId, 'packaging', variantId],
    queryFn: () => api<Packaging>(`/shops/${shopId}/variants/${variantId}/packaging`),
  });
  const packs = (packaging.data?.packs ?? []).filter((p) => p.status === 'active');
  return (
    <select aria-label="Pack" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">Supplier’s pack</option>
      <option value="units">Units ({packaging.data?.baseUnit ?? 'base'})</option>
      {packs.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name} ({formatDecimal(p.baseQuantity)})
        </option>
      ))}
    </select>
  );
}

// One order -----------------------------------------------------------------------------------

async function downloadPdf(shopId: string, purchaseOrderId: string) {
  const res = await fetch(`/api/v1/shops/${shopId}/purchase-orders/${purchaseOrderId}/pdf`, {
    headers: { 'x-airstock-request': '1' },
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`The PDF could not be made (HTTP ${res.status}).`);
  const name =
    /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
    'purchase-order.pdf';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function PurchaseOrderPanel({
  shopId,
  purchaseOrderId,
  onClose,
}: {
  shopId: string;
  purchaseOrderId: string;
  onClose: () => void;
}) {
  const context = useShopContext(shopId);
  const canManage = can(context.data, 'purchasing.manage');
  const canReceive = can(context.data, 'inventory.receive');
  const order = useQuery({
    queryKey: ['shop', shopId, 'purchasing', 'order', purchaseOrderId],
    queryFn: () => api<PurchaseOrder>(`/shops/${shopId}/purchase-orders/${purchaseOrderId}`),
  });
  const refresh = usePurchasingRefresh(shopId);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const pdf = useMutation({ mutationFn: () => downloadPdf(shopId, purchaseOrderId) });
  const finish = useMutation({
    mutationFn: (kind: 'close' | 'cancel') =>
      command(`/shops/${shopId}/purchase-orders/${purchaseOrderId}/${kind}`, {
        expectedVersion: order.data!.version,
      }),
    onSuccess: async () => {
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability'] });
    },
  });
  if (order.isPending) return <Loading />;
  if (order.error) return <ErrorNotice error={order.error} />;
  const po = order.data;
  const open = ['sent', 'partially_received'].includes(po.status);
  const anyReceived = po.lines.some((l) => Number(l.received) > 0);
  return (
    <Card
      title={`${po.number} · ${po.supplier.name}`}
      actions={
        <div className="page-actions">
          <StatusBadge status={po.status} />
          <button
            type="button"
            className="small ghost"
            onClick={() => pdf.mutate()}
            disabled={pdf.isPending}
          >
            Download PDF
          </button>
          {canManage && ['draft', 'sent', 'partially_received'].includes(po.status) ? (
            <button type="button" className="small" onClick={() => setSending(!sending)}>
              {po.status === 'draft' ? 'Send' : 'Send again'}
            </button>
          ) : null}
          {canManage && po.status === 'draft' ? (
            <button type="button" className="small ghost" onClick={() => setEditing(!editing)}>
              Edit
            </button>
          ) : null}
          {canManage && ['sent', 'partially_received', 'received'].includes(po.status) ? (
            <button
              type="button"
              className="small ghost"
              disabled={finish.isPending}
              onClick={() => {
                if (
                  po.status === 'received' ||
                  window.confirm(
                    'Close this order? Anything not yet received is cancelled and stops counting as on order.',
                  )
                )
                  finish.mutate('close');
              }}
            >
              Close
            </button>
          ) : null}
          {canManage && (po.status === 'draft' || (po.status === 'sent' && !anyReceived)) ? (
            <button
              type="button"
              className="small ghost danger"
              disabled={finish.isPending}
              onClick={() => {
                if (window.confirm('Cancel this purchase order?')) finish.mutate('cancel');
              }}
            >
              Cancel order
            </button>
          ) : null}
          <button type="button" className="small ghost" onClick={onClose}>
            Done
          </button>
        </div>
      }
    >
      <ErrorNotice error={pdf.error ?? finish.error} />
      <dl className="facts">
        <dt>Deliver to</dt>
        <dd>
          {po.warehouse.name}
          {po.location ? ` · ${po.location.path}` : ''}
        </dd>
        <dt>Expected</dt>
        <dd>{po.expectedOn ?? '—'}</dd>
        <dt>Supplier email</dt>
        <dd>{po.supplier.email ?? '—'}</dd>
        {po.supplierReference ? (
          <>
            <dt>Supplier reference</dt>
            <dd>{po.supplierReference}</dd>
          </>
        ) : null}
        {po.notes ? (
          <>
            <dt>Notes</dt>
            <dd>{po.notes}</dd>
          </>
        ) : null}
        {po.costVisible ? (
          <>
            <dt>Total</dt>
            <dd>{po.total === null ? '—' : `${formatDecimal(po.total, 2)} ${po.currency}`}</dd>
          </>
        ) : null}
      </dl>
      {sending ? <SendForm shopId={shopId} order={po} onDone={() => setSending(false)} /> : null}
      {editing && po.status === 'draft' ? (
        <EditDraft shopId={shopId} order={po} onDone={() => setEditing(false)} />
      ) : (
        <LinesTable shopId={shopId} order={po} canReceive={canReceive && open} />
      )}
      {po.sends.length > 0 ? (
        <>
          <h3>Send log</h3>
          <ul className="plain-list">
            {po.sends.map((s) => (
              <li key={s.id} className="alert-row">
                {formatDateTime(s.createdAt)} ·{' '}
                {s.channel === 'email' ? `Email to ${s.recipient}` : 'Recorded as sent'} ·{' '}
                <Badge
                  tone={s.status === 'failed' ? 'error' : s.status === 'sent' ? 'ok' : 'muted'}
                >
                  {titleCase(s.status)}
                </Badge>
                {s.error ? <span className="muted"> {s.error}</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Card>
  );
}

function SendForm({
  shopId,
  order,
  onDone,
}: {
  shopId: string;
  order: PurchaseOrder;
  onDone: () => void;
}) {
  const [email, setEmail] = useState(Boolean(order.supplier.email));
  const [to, setTo] = useState(order.supplier.email ?? '');
  const [message, setMessage] = useState('');
  const refresh = usePurchasingRefresh(shopId);
  const send = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/purchase-orders/${order.id}/send`, {
        email,
        ...(email && to.trim() && to.trim() !== order.supplier.email ? { emailTo: to.trim() } : {}),
        ...(email && message.trim() ? { message: message.trim() } : {}),
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        send.mutate();
      }}
    >
      <label className="check">
        <input type="checkbox" checked={email} onChange={(e) => setEmail(e.target.checked)} />
        Email the PDF to the supplier
      </label>
      {email ? (
        <>
          <Field label="To">
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="orders@supplier.example"
              required
            />
          </Field>
          <Field label="Message">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Optional note at the top of the email"
              rows={2}
              maxLength={2000}
            />
          </Field>
        </>
      ) : (
        <Notice>Records that you sent the order another way, such as by phone or portal.</Notice>
      )}
      <div className="form-actions">
        <button type="submit" disabled={send.isPending}>
          {email ? 'Send email' : 'Mark as sent'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNotice error={send.error} />
    </form>
  );
}

function EditDraft({
  shopId,
  order,
  onDone,
}: {
  shopId: string;
  order: PurchaseOrder;
  onDone: () => void;
}) {
  const context = useShopContext(shopId);
  const [expectedOn, setExpectedOn] = useState(order.expectedOn ?? '');
  const [notes, setNotes] = useState(order.notes ?? '');
  const [locationId, setLocationId] = useState(order.location?.id ?? '');
  const [lines, setLines] = useState<LineDraft[]>(() =>
    order.lines.map((l) => ({
      ...newLine(
        l.variantId,
        `${l.productName} · ${l.sku}`,
        l.packId ?? 'units',
        formatDecimal(l.quantity),
      ),
      unitCost: l.unitCost === null ? '' : formatDecimal(l.unitCost),
    })),
  );
  const refresh = usePurchasingRefresh(shopId);
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/purchase-orders/${order.id}`, {
        expectedVersion: order.version,
        expectedOn: expectedOn || null,
        notes: notes.trim() || null,
        locationId: locationId || null,
        lines: lines.map(lineBody),
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <div className="form-grid">
        <ReceivingLocationSelect
          shopId={shopId}
          warehouseId={order.warehouse.id}
          value={locationId}
          onChange={setLocationId}
        />
        <Field label="Expected">
          <input type="date" value={expectedOn} onChange={(e) => setExpectedOn(e.target.value)} />
        </Field>
      </div>
      <Field label="Notes">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          maxLength={5000}
        />
      </Field>
      <LinesEditor
        shopId={shopId}
        supplierId={order.supplier.id}
        lines={lines}
        onChange={setLines}
        showCosts={order.costVisible}
        currency={context.data?.shop.currency ?? order.currency}
      />
      <div className="form-actions">
        <button type="submit" disabled={save.isPending || lines.length === 0}>
          Save
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNotice error={save.error} />
    </form>
  );
}

function LinesTable({
  shopId,
  order,
  canReceive,
}: {
  shopId: string;
  order: PurchaseOrder;
  canReceive: boolean;
}) {
  const [receiving, setReceiving] = useState<string | null>(null);
  return (
    <div className="table-wrap">
      <table className="table compact">
        <thead>
          <tr>
            <th>Item</th>
            <th>Ordered</th>
            <th className="num">Received</th>
            <th className="num">Still open</th>
            {order.costVisible ? <th className="num">Unit cost</th> : null}
            {order.costVisible ? <th className="num">Total</th> : null}
            {canReceive ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {order.lines.map((l) => (
            <LineRow
              key={l.id}
              shopId={shopId}
              order={order}
              line={l}
              canReceive={canReceive}
              receiving={receiving === l.id}
              onReceive={() => setReceiving(receiving === l.id ? null : l.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Line = PurchaseOrder['lines'][number];

function LineRow({
  shopId,
  order,
  line,
  canReceive,
  receiving,
  onReceive,
}: {
  shopId: string;
  order: PurchaseOrder;
  line: Line;
  canReceive: boolean;
  receiving: boolean;
  onReceive: () => void;
}) {
  const columns = 4 + (order.costVisible ? 2 : 0) + (canReceive ? 1 : 0);
  return (
    <>
      <tr>
        <td>
          {line.productName}
          {line.variantName ? ` – ${line.variantName}` : ''}
          <div className="muted small-text">
            {line.sku}
            {line.supplierSku ? ` · supplier ${line.supplierSku}` : ''}
          </div>
        </td>
        <td>
          {formatDecimal(line.quantity)}{' '}
          {line.packName ? `× ${line.packName} (${formatDecimal(line.ordered)} units)` : 'units'}
        </td>
        <td className="num">
          {formatDecimal(line.received)}
          {Number(line.overReceived) > 0 ? (
            <Badge tone="warn">+{formatDecimal(line.overReceived)} over</Badge>
          ) : null}
        </td>
        <td className="num">{formatDecimal(line.open)}</td>
        {order.costVisible ? (
          <td className="num">{line.unitCost === null ? '—' : formatDecimal(line.unitCost, 2)}</td>
        ) : null}
        {order.costVisible ? (
          <td className="num">
            {line.lineTotal === null ? '—' : formatDecimal(line.lineTotal, 2)}
          </td>
        ) : null}
        {canReceive ? (
          <td>
            <button type="button" className="small" onClick={onReceive}>
              Receive
            </button>
          </td>
        ) : null}
      </tr>
      {receiving ? (
        <tr>
          <td colSpan={columns}>
            <ReceiveLineForm shopId={shopId} order={order} line={line} onDone={onReceive} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ReceiveLineForm({
  shopId,
  order,
  line,
  onDone,
}: {
  shopId: string;
  order: PurchaseOrder;
  line: Line;
  onDone: () => void;
}) {
  const openPacks = useMemo(() => {
    if (!line.packFactor) return formatDecimal(line.open);
    const packs = Number(line.open) / Number(line.packFactor);
    return Number.isInteger(packs) ? String(packs) : '';
  }, [line]);
  const [quantity, setQuantity] = useState(openPacks);
  const [inBaseUnits, setInBaseUnits] = useState(false);
  const [locationId, setLocationId] = useState(order.location?.id ?? '');
  const [lotCode, setLotCode] = useState('');
  const [expiresOn, setExpiresOn] = useState('');
  const [serials, setSerials] = useState('');
  const [overReceipt, setOverReceipt] = useState<string | null>(null);
  const refresh = usePurchasingRefresh(shopId);
  const queryClient = useQueryClient();
  const receive = useMutation({
    mutationFn: (confirmOverReceipt: boolean) =>
      command(`/shops/${shopId}/purchase-orders/${order.id}/receive`, {
        lineId: line.id,
        quantity: quantity.trim(),
        ...(inBaseUnits ? { inBaseUnits: true } : {}),
        ...(locationId ? { locationId } : {}),
        ...(lotCode.trim() ? { lotCode: lotCode.trim() } : {}),
        ...(expiresOn ? { expiresOn } : {}),
        ...(serials.trim() ? { serials: serials.split(/[\s,]+/).filter(Boolean) } : {}),
        ...(confirmOverReceipt ? { confirmOverReceipt: true } : {}),
      }),
    onSuccess: async () => {
      setOverReceipt(null);
      await refresh();
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'availability'] });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'over_receipt') {
        setOverReceipt(
          typeof error.problem.detail === 'string' ? error.problem.detail : error.message,
        );
      }
    },
  });
  return (
    <form
      className="stack mini-form"
      onSubmit={(e) => {
        e.preventDefault();
        receive.mutate(false);
      }}
    >
      <div className="form-grid">
        <Field
          label={line.packName && !inBaseUnits ? `Quantity (${line.packName})` : 'Quantity (units)'}
        >
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            required
          />
        </Field>
        <ReceivingLocationSelect
          shopId={shopId}
          warehouseId={order.warehouse.id}
          value={locationId}
          onChange={setLocationId}
          label="Location"
          required
        />
        <Field label="Lot">
          <input
            value={lotCode}
            onChange={(e) => setLotCode(e.target.value)}
            placeholder="Lot-tracked items only"
            maxLength={100}
          />
        </Field>
        <Field label="Expires">
          <input type="date" value={expiresOn} onChange={(e) => setExpiresOn(e.target.value)} />
        </Field>
      </div>
      {line.packName ? (
        <label className="check">
          <input
            type="checkbox"
            checked={inBaseUnits}
            onChange={(e) => setInBaseUnits(e.target.checked)}
          />
          Count in units instead of {line.packName}
        </label>
      ) : null}
      <Field label="Serials">
        <textarea
          value={serials}
          onChange={(e) => setSerials(e.target.value)}
          placeholder="Serial-tracked items: one serial per unit, separated by spaces or new lines"
          rows={2}
        />
      </Field>
      <div className="form-actions">
        <button type="submit" disabled={receive.isPending}>
          Receive
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      {overReceipt ? (
        <div className="notice error" role="alert">
          {overReceipt}{' '}
          <button
            type="button"
            className="small"
            disabled={receive.isPending}
            onClick={() => receive.mutate(true)}
          >
            Receive anyway
          </button>
        </div>
      ) : (
        <ErrorNotice error={receive.error} />
      )}
    </form>
  );
}
