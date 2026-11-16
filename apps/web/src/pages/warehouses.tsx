import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, useMemo, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import { countryForTimeZone, countryName } from '../components/countries.ts';
import { CountrySelect, CurrencySelect, TimeZoneSelect } from '../components/pickers.tsx';
import {
  Badge,
  Card,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  PageHeader,
  titleCase,
} from '../components/ui.tsx';
import { can, type ShopContext, useShopContext } from '../context.tsx';

type Locations = Out<typeof ops.listLocations>;
type Location = Locations['locations'][number];
type Warehouses = Out<typeof ops.listWarehouses>;
type Warehouse = Warehouses['warehouses'][number];
type Contract = NonNullable<Warehouse['contract']>;
type Shop = ShopContext['shop'];

export function useLocations(shopId: string, enabled = true) {
  return useQuery({
    queryKey: ['shop', shopId, 'locations'],
    queryFn: () => api<Locations>(`/shops/${shopId}/locations`),
    enabled,
  });
}

export function useWarehouses(shopId: string, enabled = true) {
  return useQuery({
    queryKey: ['shop', shopId, 'warehouses'],
    queryFn: () =>
      api<Warehouses>(`/shops/${shopId}/warehouses`, { query: { includeArchived: true } }),
    enabled,
  });
}

/** Warehouses and locations change together (names flow into paths), so refresh both. */
function useStorageRefresh(shopId: string) {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'warehouses'] }),
      queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'locations'] }),
    ]);
}

const OWNERSHIP = [
  ['owned', 'Owned'],
  ['rented', 'Rented'],
  ['third_party', 'Third party'],
] as const;

export function WarehousesPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const warehouses = useWarehouses(shopId);
  const locations = useLocations(shopId);
  const manage = can(context.data, 'storage.manage');
  const [showArchived, setShowArchived] = useState(false);
  const byWarehouse = useMemo(() => {
    const groups = new Map<string, Location[]>();
    for (const l of locations.data?.locations ?? []) {
      groups.set(l.warehouseId, [...(groups.get(l.warehouseId) ?? []), l]);
    }
    return groups;
  }, [locations.data]);
  const all = warehouses.data?.warehouses ?? [];
  const archivedCount = all.filter((w) => w.status === 'archived').length;
  const shown = all.filter((w) => showArchived || w.status === 'active');

  return (
    <>
      <PageHeader
        title="Warehouses"
        subtitle="Where stock is kept: your own sites, rented space, and partners."
        actions={
          archivedCount > 0 ? (
            <label className="check">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
              />
              Show archived ({archivedCount})
            </label>
          ) : null
        }
      />
      {warehouses.data?.partial ? (
        <Notice>You see only the warehouses and locations you have access to.</Notice>
      ) : null}
      <ErrorNotice error={warehouses.error ?? locations.error} />
      {warehouses.isPending || locations.isPending ? <Loading /> : null}
      {shown.map((w) => (
        <WarehouseCard
          key={w.warehouseId}
          shopId={shopId}
          shop={context.data?.shop}
          warehouse={w}
          locations={byWarehouse.get(w.warehouseId) ?? []}
          commercial={warehouses.data?.commercialVisible ?? false}
          manage={manage}
        />
      ))}
      {manage ? (
        <CreateLocation
          shopId={shopId}
          warehouses={all.filter((w) => w.status === 'active')}
          locations={(locations.data?.locations ?? []).filter((l) => l.status === 'active')}
        />
      ) : null}
      {manage ? <CreateWarehouse shopId={shopId} /> : null}
    </>
  );
}

// Warehouse card ---------------------------------------------------------------------------

function WarehouseCard({
  shopId,
  shop,
  warehouse: w,
  locations,
  commercial,
  manage,
}: {
  shopId: string;
  shop: Shop | undefined;
  warehouse: Warehouse;
  locations: Location[];
  commercial: boolean;
  manage: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const refresh = useStorageRefresh(shopId);
  const archived = w.status === 'archived';
  const toggle = useMutation({
    mutationFn: () =>
      command(
        `/shops/${shopId}/warehouses/${w.warehouseId}/${archived ? 'restore' : 'archive'}`,
        {},
      ),
    onSuccess: refresh,
  });
  const actions = (
    <div className="chips">
      <Badge>{titleCase(w.ownership)}</Badge>
      {w.operatingStatus === 'paused' ? <Badge tone="warn">paused</Badge> : null}
      {!w.fulfillmentEligible ? <Badge tone="muted">not for fulfillment</Badge> : null}
      {archived ? <Badge tone="muted">archived</Badge> : null}
      {manage && !archived && !editing ? (
        <button type="button" className="ghost small" onClick={() => setEditing(true)}>
          Edit
        </button>
      ) : null}
      {manage ? (
        <button
          type="button"
          className={archived ? 'ghost small' : 'danger small'}
          disabled={toggle.isPending}
          onClick={() => toggle.mutate()}
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
      ) : null}
    </div>
  );
  return (
    <Card title={w.name} actions={actions}>
      <ErrorNotice error={toggle.error} />
      {editing && shop ? (
        <WarehouseForm
          shopId={shopId}
          shop={shop}
          warehouse={w}
          commercial={commercial}
          onDone={() => setEditing(false)}
        />
      ) : (
        <WarehouseFacts warehouse={w} shop={shop} commercial={commercial} />
      )}
      <LocationTree shopId={shopId} locations={locations} manage={manage && !archived} />
    </Card>
  );
}

function WarehouseFacts({
  warehouse: w,
  shop,
  commercial,
}: {
  warehouse: Warehouse;
  shop: Shop | undefined;
  commercial: boolean;
}) {
  const address = w.address
    ? [w.address.line1, w.address.line2, w.address.postalCode, w.address.city, w.address.region]
        .filter(Boolean)
        .concat(w.address.country ? [countryName(w.address.country)] : [])
        .join(', ')
    : '';
  const contact = w.contact
    ? [w.contact.name, w.contact.email, w.contact.phone].filter(Boolean).join(' · ')
    : '';
  return (
    <>
      <dl className="facts">
        {w.operatorName ? (
          <>
            <dt>Operator</dt>
            <dd>{w.operatorName}</dd>
          </>
        ) : null}
        {address ? (
          <>
            <dt>Address</dt>
            <dd>{address}</dd>
          </>
        ) : null}
        {contact ? (
          <>
            <dt>Contact</dt>
            <dd>{contact}</dd>
          </>
        ) : null}
        <dt>Time zone</dt>
        <dd>{w.timezone ?? shop?.timezone ?? 'Shop time zone'}</dd>
        {w.providerRefs.length > 0 ? (
          <>
            <dt>Provider IDs</dt>
            <dd>{w.providerRefs.map((r) => `${r.provider}: ${r.externalId}`).join(', ')}</dd>
          </>
        ) : null}
      </dl>
      {commercial && (w.contract || w.ownership !== 'owned') ? (
        <ContractFacts contract={w.contract ?? null} />
      ) : null}
    </>
  );
}

function ContractFacts({ contract }: { contract: Contract | null }) {
  if (!contract) return <p className="fine">No contract recorded.</p>;
  const dates =
    contract.startDate || contract.endDate
      ? `${contract.startDate ?? '…'} to ${contract.endDate ?? 'open-ended'}`
      : 'No dates';
  return (
    <div className="stack">
      <h3>Contract</h3>
      <dl className="facts">
        <dt>Term</dt>
        <dd>{dates}</dd>
        {contract.feeDescription ? (
          <>
            <dt>Fees</dt>
            <dd>{contract.feeDescription}</dd>
          </>
        ) : null}
        {contract.notes ? (
          <>
            <dt>Notes</dt>
            <dd>{contract.notes}</dd>
          </>
        ) : null}
      </dl>
      {contract.rates.length > 0 ? (
        <div className="table-wrap">
          <table className="table compact">
            <tbody>
              {contract.rates.map((r, i) => (
                <tr key={i}>
                  <td>{r.description}</td>
                  <td className="num nowrap">
                    {r.amount} {contract.currency}
                  </td>
                  <td>per {r.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="fine">A record of the agreed terms. Airstock does not bill from it.</p>
    </div>
  );
}

// Warehouse form ---------------------------------------------------------------------------

interface RateDraft {
  description: string;
  amount: string;
  unit: string;
}

/** Time zone, country, and currency start from the shop's when the warehouse has none. */
function draftFrom(w: Warehouse, shop: Shop) {
  return {
    name: w.name,
    ownership: w.ownership as string,
    operatorName: w.operatorName ?? '',
    timezone: w.timezone ?? shop.timezone,
    operatingStatus: w.operatingStatus as string,
    fulfillmentEligible: w.fulfillmentEligible,
    line1: w.address?.line1 ?? '',
    line2: w.address?.line2 ?? '',
    city: w.address?.city ?? '',
    region: w.address?.region ?? '',
    postalCode: w.address?.postalCode ?? '',
    country: w.address?.country ?? countryForTimeZone(shop.timezone),
    contactName: w.contact?.name ?? '',
    email: w.contact?.email ?? '',
    phone: w.contact?.phone ?? '',
    providerRefs: w.providerRefs.map((r) => `${r.provider}: ${r.externalId}`).join('\n'),
    startDate: w.contract?.startDate ?? '',
    endDate: w.contract?.endDate ?? '',
    feeDescription: w.contract?.feeDescription ?? '',
    currency: w.contract?.currency ?? shop.currency,
    notes: w.contract?.notes ?? '',
    rates: (w.contract?.rates ?? []).map((r) => ({ ...r })) as RateDraft[],
  };
}

type Draft = ReturnType<typeof draftFrom>;

/** "provider: id" per line. */
function parseProviderRefs(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf(':');
      return at === -1
        ? { provider: line, externalId: '' }
        : { provider: line.slice(0, at).trim(), externalId: line.slice(at + 1).trim() };
    });
}

function contractFrom(d: Draft, existing: Contract | null | undefined) {
  const rates = d.rates.filter((r) => r.description || r.amount || r.unit);
  const empty = !d.startDate && !d.endDate && !d.feeDescription && !d.notes && rates.length === 0;
  if (empty) return null;
  return {
    startDate: d.startDate || null,
    endDate: d.endDate || null,
    feeDescription: d.feeDescription || null,
    ...(d.currency ? { currency: d.currency.toUpperCase() } : {}),
    rates,
    notes: d.notes || null,
    attachmentMediaIds: existing?.attachmentMediaIds ?? [],
  };
}

function WarehouseForm({
  shopId,
  shop,
  warehouse,
  commercial,
  onDone,
}: {
  shopId: string;
  shop: Shop;
  warehouse: Warehouse;
  commercial: boolean;
  onDone: () => void;
}) {
  const refresh = useStorageRefresh(shopId);
  const [d, setD] = useState<Draft>(() => draftFrom(warehouse, shop));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setD((p) => ({ ...p, [key]: value }));
  const text = (key: keyof Draft) => ({
    value: d[key] as string,
    onChange: (e: { target: { value: string } }) => set(key, e.target.value as never),
  });
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/warehouses/${warehouse.warehouseId}`, {
        expectedVersion: warehouse.version,
        name: d.name,
        ownership: d.ownership,
        operatorName: d.operatorName || null,
        // The shop's own zone is stored as null, so the warehouse follows the shop if it changes.
        timezone: d.timezone && d.timezone !== shop.timezone ? d.timezone : null,
        operatingStatus: d.operatingStatus,
        fulfillmentEligible: d.fulfillmentEligible,
        address: {
          line1: d.line1,
          line2: d.line2,
          city: d.city,
          region: d.region,
          postalCode: d.postalCode,
          country: d.country,
        },
        contact: { name: d.contactName, email: d.email, phone: d.phone },
        providerRefs: parseProviderRefs(d.providerRefs),
        ...(commercial ? { contract: contractFrom(d, warehouse.contract) } : {}),
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: () => refresh(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const setRate = (i: number, patch: Partial<RateDraft>) =>
    set(
      'rates',
      d.rates.map((r, j) => (j === i ? { ...r, ...patch } : r)),
    );
  return (
    <form className="stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="Name">
          <input {...text('name')} required maxLength={200} />
        </Field>
        <Field label="Ownership">
          <select value={d.ownership} onChange={(e) => set('ownership', e.target.value)}>
            {OWNERSHIP.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Operator" hint="Who runs the site.">
          <input {...text('operatorName')} maxLength={200} />
        </Field>
        <Field label="Time zone">
          <TimeZoneSelect {...text('timezone')} required />
        </Field>
        <Field label="Operating status">
          <select
            value={d.operatingStatus}
            onChange={(e) => set('operatingStatus', e.target.value)}
          >
            <option value="operating">Operating</option>
            <option value="paused">Paused</option>
          </select>
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={d.fulfillmentEligible}
            onChange={(e) => set('fulfillmentEligible', e.target.checked)}
          />
          Orders may be fulfilled from here
        </label>
      </div>
      <h3>Address</h3>
      <div className="form-grid">
        <Field label="Street">
          <input {...text('line1')} maxLength={200} />
        </Field>
        <Field label="Street, line 2">
          <input {...text('line2')} maxLength={200} />
        </Field>
        <Field label="Postal code">
          <input {...text('postalCode')} maxLength={20} />
        </Field>
        <Field label="City">
          <input {...text('city')} maxLength={100} />
        </Field>
        <Field label="Region">
          <input {...text('region')} maxLength={100} />
        </Field>
        <Field label="Country">
          <CountrySelect {...text('country')} />
        </Field>
      </div>
      <h3>Contact</h3>
      <div className="form-grid">
        <Field label="Contact name">
          <input {...text('contactName')} maxLength={200} />
        </Field>
        <Field label="Email">
          <input type="email" {...text('email')} maxLength={320} />
        </Field>
        <Field label="Phone">
          <input type="tel" {...text('phone')} maxLength={50} />
        </Field>
      </div>
      <Field label="Provider IDs">
        <textarea
          {...text('providerRefs')}
          rows={2}
          placeholder="The site's IDs in other systems, one per line: provider: ID"
        />
      </Field>
      {commercial ? (
        <fieldset className="checks">
          <legend>Contract</legend>
          <div className="form-grid">
            <Field label="Starts">
              <input type="date" {...text('startDate')} />
            </Field>
            <Field label="Ends">
              <input type="date" {...text('endDate')} />
            </Field>
            <Field label="Currency">
              <CurrencySelect {...text('currency')} required />
            </Field>
          </div>
          <Field label="Fees">
            <textarea {...text('feeDescription')} rows={2} maxLength={2000} />
          </Field>
          {d.rates.map((r, i) => (
            <div className="form-grid" key={i}>
              <Field label="Rate for">
                <input
                  value={r.description}
                  onChange={(e) => setRate(i, { description: e.target.value })}
                  maxLength={200}
                />
              </Field>
              <Field label="Amount">
                <input
                  value={r.amount}
                  onChange={(e) => setRate(i, { amount: e.target.value })}
                  inputMode="decimal"
                />
              </Field>
              <Field label="Per">
                <input
                  value={r.unit}
                  onChange={(e) => setRate(i, { unit: e.target.value })}
                  maxLength={50}
                  placeholder="pallet per week"
                />
              </Field>
              <button
                type="button"
                className="ghost small"
                onClick={() =>
                  set(
                    'rates',
                    d.rates.filter((_, j) => j !== i),
                  )
                }
              >
                Remove rate
              </button>
            </div>
          ))}
          <div className="form-actions">
            <button
              type="button"
              className="ghost small"
              onClick={() => set('rates', [...d.rates, { description: '', amount: '', unit: '' }])}
            >
              Add a rate
            </button>
          </div>
          <Field label="Notes">
            <textarea {...text('notes')} rows={2} maxLength={5000} />
          </Field>
        </fieldset>
      ) : null}
      <div className="form-actions">
        <button type="submit" disabled={save.isPending}>
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

// Location tree ----------------------------------------------------------------------------

function depth(location: Location, all: Location[]): number {
  let d = 0;
  let parent = location.parentId;
  while (parent) {
    d++;
    parent = all.find((l) => l.locationId === parent)?.parentId ?? null;
  }
  return d;
}

/** The location and everything inside it. */
function subtreeIds(id: string, all: Location[]): Set<string> {
  const ids = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of all) {
      if (l.parentId && ids.has(l.parentId) && !ids.has(l.locationId)) {
        ids.add(l.locationId);
        grew = true;
      }
    }
  }
  return ids;
}

function LocationTree({
  shopId,
  locations,
  manage,
}: {
  shopId: string;
  locations: Location[];
  manage: boolean;
}) {
  if (locations.length === 0) return <p className="fine">No locations yet.</p>;
  return (
    <ul className="tree">
      {locations.map((l) => (
        <LocationRow
          key={l.locationId}
          shopId={shopId}
          location={l}
          all={locations}
          manage={manage}
        />
      ))}
    </ul>
  );
}

function LocationRow({
  shopId,
  location: l,
  all,
  manage,
}: {
  shopId: string;
  location: Location;
  all: Location[];
  manage: boolean;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'move'>('view');
  const refresh = useStorageRefresh(shopId);
  const archived = l.status !== 'active';
  const toggle = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/locations/${l.locationId}/${archived ? 'restore' : 'archive'}`, {}),
    onSuccess: refresh,
  });
  return (
    <li style={{ paddingInlineStart: `${depth(l, all) * 1.25}rem` }}>
      <div className="tree-row">
        <span className={archived ? 'muted' : undefined}>
          {l.code ? `${l.code} · ${l.name}` : l.name}
        </span>
        {l.holdsStockAllowed ? (
          <Badge tone="ok">holds stock</Badge>
        ) : (
          <Badge tone="muted">area</Badge>
        )}
        {!l.effectiveFulfillmentEligible ? <Badge tone="muted">not for fulfillment</Badge> : null}
        {archived ? <Badge tone="muted">{l.status}</Badge> : null}
        {manage ? (
          <span className="tree-actions">
            {!archived && mode === 'view' ? (
              <>
                <button type="button" className="ghost small" onClick={() => setMode('edit')}>
                  Edit
                </button>
                <button type="button" className="ghost small" onClick={() => setMode('move')}>
                  Move
                </button>
              </>
            ) : null}
            <button
              type="button"
              className="ghost small"
              disabled={toggle.isPending}
              onClick={() => toggle.mutate()}
            >
              {archived ? 'Restore' : 'Archive'}
            </button>
          </span>
        ) : null}
      </div>
      <ErrorNotice error={toggle.error} />
      {mode === 'edit' ? (
        <EditLocation shopId={shopId} location={l} onDone={() => setMode('view')} />
      ) : null}
      {mode === 'move' ? (
        <MoveLocation shopId={shopId} location={l} all={all} onDone={() => setMode('view')} />
      ) : null}
    </li>
  );
}

function EditLocation({
  shopId,
  location,
  onDone,
}: {
  shopId: string;
  location: Location;
  onDone: () => void;
}) {
  const refresh = useStorageRefresh(shopId);
  const [name, setName] = useState(location.name);
  const [code, setCode] = useState(location.code ?? '');
  const [eligible, setEligible] = useState(location.fulfillmentEligible);
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/locations/${location.locationId}`, {
        expectedVersion: location.version,
        name,
        code: code.trim() || null,
        fulfillmentEligible: eligible,
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: () => refresh(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <form className="inline-form tree-form" onSubmit={submit}>
      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
      </Field>
      <Field label="Code">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={50}
          placeholder="Optional, such as A-03"
        />
      </Field>
      <label className="check">
        <input type="checkbox" checked={eligible} onChange={(e) => setEligible(e.target.checked)} />
        For fulfillment
      </label>
      <button type="submit" disabled={save.isPending}>
        Save
      </button>
      <button type="button" className="ghost" onClick={onDone}>
        Cancel
      </button>
      <ErrorNotice error={save.error} />
    </form>
  );
}

function MoveLocation({
  shopId,
  location,
  all,
  onDone,
}: {
  shopId: string;
  location: Location;
  all: Location[];
  onDone: () => void;
}) {
  const refresh = useStorageRefresh(shopId);
  const inside = subtreeIds(location.locationId, all);
  const targets = all.filter((l) => l.status === 'active' && !inside.has(l.locationId));
  const [parentId, setParentId] = useState(location.parentId ?? '');
  const move = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/locations/${location.locationId}/move`, {
        expectedVersion: location.version,
        parentId: parentId || null,
      }),
    onSuccess: async () => {
      await refresh();
      onDone();
    },
    onError: () => refresh(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    move.mutate();
  };
  return (
    <form className="inline-form tree-form" onSubmit={submit}>
      <Field label="Move inside">
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">Top level</option>
          {targets.map((l) => (
            <option key={l.locationId} value={l.locationId}>
              {l.path}
            </option>
          ))}
        </select>
      </Field>
      <button type="submit" disabled={move.isPending}>
        Move
      </button>
      <button type="button" className="ghost" onClick={onDone}>
        Cancel
      </button>
      <p className="fine">
        A location can move only while it and everything inside it hold no stock.
      </p>
      <ErrorNotice error={move.error} />
    </form>
  );
}

// Create forms -----------------------------------------------------------------------------

function CreateWarehouse({ shopId }: { shopId: string }) {
  const refresh = useStorageRefresh(shopId);
  const [name, setName] = useState('');
  const [ownership, setOwnership] = useState('owned');
  const [operatorName, setOperatorName] = useState('');
  const create = useMutation({
    mutationFn: async () => {
      const wh = await command<{ warehouseId: string }>(`/shops/${shopId}/warehouses`, {
        name,
        ownership,
        ...(operatorName ? { operatorName } : {}),
      });
      // A warehouse holds stock in its locations; start it with one.
      await command(`/shops/${shopId}/locations`, { warehouseId: wh.warehouseId, name: 'Main' });
    },
    onSuccess: async () => {
      setName('');
      setOperatorName('');
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="Add a warehouse">
      <form className="inline-form" onSubmit={submit}>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Ownership">
          <select value={ownership} onChange={(e) => setOwnership(e.target.value)}>
            {OWNERSHIP.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        {ownership !== 'owned' ? (
          <Field label="Operator">
            <input
              value={operatorName}
              onChange={(e) => setOperatorName(e.target.value)}
              maxLength={200}
            />
          </Field>
        ) : null}
        <button type="submit" disabled={create.isPending}>
          Add warehouse
        </button>
      </form>
      <p className="fine">Add the address, contact, and contract with Edit once it exists.</p>
      <ErrorNotice error={create.error} />
    </Card>
  );
}

function CreateLocation({
  shopId,
  warehouses,
  locations,
}: {
  shopId: string;
  warehouses: Warehouse[];
  locations: Location[];
}) {
  const refresh = useStorageRefresh(shopId);
  const [warehouseId, setWarehouseId] = useState('');
  const [parentId, setParentId] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const wh = warehouseId || warehouses[0]?.warehouseId || '';
  const create = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/locations`, {
        warehouseId: wh,
        name,
        ...(parentId ? { parentId } : {}),
        ...(code ? { code } : {}),
      }),
    onSuccess: async () => {
      setName('');
      setCode('');
      await refresh();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card title="Add a location">
      <form className="inline-form" onSubmit={submit}>
        <Field label="Warehouse">
          <select
            value={wh}
            onChange={(e) => {
              setWarehouseId(e.target.value);
              setParentId('');
            }}
          >
            {warehouses.map((w) => (
              <option key={w.warehouseId} value={w.warehouseId}>
                {w.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Inside">
          <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
            <option value="">Top level</option>
            {locations
              .filter((l) => l.warehouseId === wh)
              .map((l) => (
                <option key={l.locationId} value={l.locationId}>
                  {l.path}
                </option>
              ))}
          </select>
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </Field>
        <Field label="Code">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            maxLength={50}
            placeholder="Optional, such as A-03"
          />
        </Field>
        <button type="submit" disabled={create.isPending || !wh}>
          Add location
        </button>
      </form>
      <ErrorNotice error={create.error} />
    </Card>
  );
}
