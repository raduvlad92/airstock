import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import { can, useShopContext } from '../context.tsx';
import { useLocations, useWarehouses } from '../pages/warehouses.tsx';
import { Badge, Card, Empty, ErrorNotice, Field, formatDecimal, Loading } from './ui.tsx';

type Rules = Out<typeof ops.listReorderRules>;
type Rule = Rules['rules'][number];
type Suppliers = Out<typeof ops.listSuppliers>;

export function useReorderRules(shopId: string, query: { variantId?: string; lowOnly?: boolean }) {
  return useQuery({
    queryKey: ['shop', shopId, 'purchasing', 'rules', query],
    queryFn: () => api<Rules>(`/shops/${shopId}/reorder-rules`, { query }),
  });
}

function useRulesRefresh(shopId: string) {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'purchasing'] });
    await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'alerts'] });
  };
}

function RuleText({ rule }: { rule: Rule }) {
  return (
    <>
      At or below {formatDecimal(rule.reorderPoint)}, order{' '}
      {rule.reorderQuantity
        ? formatDecimal(rule.reorderQuantity)
        : `up to ${formatDecimal(rule.maximumLevel)}`}
      {rule.preferredSupplierName ? ` from ${rule.preferredSupplierName}` : ''}
    </>
  );
}

/** A variant's reorder rules, in the product detail panel's Stock tab (PRD 6.9). */
export function ReorderRulesPanel({ shopId, variantId }: { shopId: string; variantId: string }) {
  const context = useShopContext(shopId);
  const canManage = can(context.data, 'purchasing.manage');
  const rules = useReorderRules(shopId, { variantId });
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  return (
    <Card
      title="Reorder rules"
      actions={
        canManage ? (
          <button type="button" className="small" onClick={() => setEditing('new')}>
            Add rule
          </button>
        ) : null
      }
    >
      <ErrorNotice error={rules.error} />
      {rules.isPending ? <Loading /> : null}
      {rules.data && rules.data.rules.length === 0 && editing === null ? (
        <Empty>No reorder rule. Add one to be alerted when stock runs low.</Empty>
      ) : null}
      {rules.data && rules.data.rules.length > 0 ? (
        <RulesTable
          shopId={shopId}
          rules={rules.data.rules}
          onEdit={canManage ? setEditing : null}
        />
      ) : null}
      {editing ? (
        <RuleForm
          key={editing === 'new' ? 'new' : editing.id}
          shopId={shopId}
          variantId={variantId}
          rule={editing === 'new' ? null : editing}
          onDone={() => setEditing(null)}
        />
      ) : null}
    </Card>
  );
}

export function RulesTable({
  shopId,
  rules,
  onEdit,
  showItem = false,
}: {
  shopId: string;
  rules: Rule[];
  onEdit: ((rule: Rule) => void) | null;
  showItem?: boolean;
}) {
  const refresh = useRulesRefresh(shopId);
  const remove = useMutation({
    mutationFn: (rule: Rule) =>
      command(`/shops/${shopId}/reorder-rules/${rule.id}/remove`, {
        expectedVersion: rule.version,
      }),
    onSuccess: refresh,
  });
  return (
    <div className="table-wrap">
      <ErrorNotice error={remove.error} />
      <table className="table compact">
        <thead>
          <tr>
            {showItem ? <th>Item</th> : null}
            <th>Where</th>
            <th>Rule</th>
            <th className="num">Available</th>
            <th className="num">On order</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              {showItem ? (
                <td>
                  {r.productName} <span className="muted">{r.sku}</span>
                </td>
              ) : null}
              <td>{r.locationPath ?? r.warehouseName}</td>
              <td>
                <RuleText rule={r} />
              </td>
              <td className="num">
                {formatDecimal(r.available)} {r.low ? <Badge tone="warn">Low</Badge> : null}
              </td>
              <td className="num">{formatDecimal(r.onOrder)}</td>
              <td>
                {onEdit ? (
                  <span className="page-actions">
                    <button type="button" className="small ghost" onClick={() => onEdit(r)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="small ghost danger"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(r)}
                    >
                      Remove
                    </button>
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RuleForm({
  shopId,
  variantId,
  rule,
  onDone,
}: {
  shopId: string;
  variantId: string;
  rule: Rule | null;
  onDone: () => void;
}) {
  const warehouses = useWarehouses(shopId);
  const locations = useLocations(shopId);
  const suppliers = useQuery({
    queryKey: ['shop', shopId, 'suppliers', 'list', '', false],
    queryFn: () => api<Suppliers>(`/shops/${shopId}/suppliers`, { query: { limit: 200 } }),
  });
  const active = (warehouses.data?.warehouses ?? []).filter((w) => w.status === 'active');
  const [warehouseId, setWarehouseId] = useState(rule?.warehouseId ?? '');
  const [locationId, setLocationId] = useState(rule?.locationId ?? '');
  const [point, setPoint] = useState(rule ? formatDecimal(rule.reorderPoint) : '');
  const [mode, setMode] = useState<'quantity' | 'maximum'>(
    rule?.maximumLevel ? 'maximum' : 'quantity',
  );
  const [amount, setAmount] = useState(
    rule ? formatDecimal(rule.reorderQuantity ?? rule.maximumLevel) : '',
  );
  const [supplierId, setSupplierId] = useState(rule?.preferredSupplierId ?? '');
  const warehouse = warehouseId || active[0]?.warehouseId || '';
  const leaves = (locations.data?.locations ?? []).filter(
    (l) => l.warehouseId === warehouse && l.status === 'active',
  );
  const refresh = useRulesRefresh(shopId);
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/reorder-rules`, {
        ...(rule
          ? { ruleId: rule.id, expectedVersion: rule.version }
          : {
              variantId,
              warehouseId: warehouse,
              ...(locationId ? { locationId } : {}),
            }),
        reorderPoint: point.trim(),
        ...(mode === 'quantity'
          ? { reorderQuantity: amount.trim(), maximumLevel: null }
          : { maximumLevel: amount.trim(), reorderQuantity: null }),
        preferredSupplierId: supplierId || null,
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form className="stack mini-form" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Warehouse">
          <select
            value={warehouse}
            disabled={rule !== null}
            onChange={(e) => {
              setWarehouseId(e.target.value);
              setLocationId('');
            }}
          >
            {active.map((w) => (
              <option key={w.warehouseId} value={w.warehouseId}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Location">
          <select
            value={locationId}
            disabled={rule !== null}
            onChange={(e) => setLocationId(e.target.value)}
          >
            <option value="">The whole warehouse</option>
            {leaves.map((l) => (
              <option key={l.locationId} value={l.locationId}>
                {l.path}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Reorder point">
          <input
            value={point}
            onChange={(e) => setPoint(e.target.value)}
            inputMode="decimal"
            placeholder="Alert at or below this many units"
            required
          />
        </Field>
        <Field label="Then order">
          <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            <option value="quantity">A fixed quantity</option>
            <option value="maximum">Up to a maximum level</option>
          </select>
        </Field>
        <Field label={mode === 'quantity' ? 'Reorder quantity' : 'Maximum level'}>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            placeholder="Units"
            required
          />
        </Field>
        <Field label="Preferred supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">The item’s preferred supplier</option>
            {(suppliers.data?.suppliers ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="form-actions">
        <button type="submit" disabled={save.isPending}>
          {rule ? 'Save rule' : 'Add rule'}
        </button>
        <button type="button" className="ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <ErrorNotice error={save.error} />
    </form>
  );
}

/** Every reorder rule, low ones first: on the Purchasing page. */
export function ReorderRulesList({ shopId }: { shopId: string }) {
  const [lowOnly, setLowOnly] = useState(false);
  const rules = useReorderRules(shopId, lowOnly ? { lowOnly: true } : {});
  const sorted = [...(rules.data?.rules ?? [])].sort((a, b) => Number(b.low) - Number(a.low));
  return (
    <Card
      title="Reorder rules"
      actions={
        <label className="check">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          Low only
        </label>
      }
    >
      <ErrorNotice error={rules.error} />
      {rules.isPending ? <Loading /> : null}
      {rules.data && sorted.length === 0 ? (
        <Empty>
          No reorder rules {lowOnly ? 'are low' : 'yet'}. Add them on an item’s Stock tab in{' '}
          <Link to="/shops/$shopId/products" params={{ shopId }}>
            Products
          </Link>
          .
        </Empty>
      ) : null}
      {sorted.length > 0 ? (
        <RulesTable shopId={shopId} rules={sorted} onEdit={null} showItem />
      ) : null}
    </Card>
  );
}
