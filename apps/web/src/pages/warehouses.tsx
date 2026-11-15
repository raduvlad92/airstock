import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, useMemo, useState } from 'react';
import { api, command, type Out } from '../api.ts';
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
import { can, useShopContext } from '../context.tsx';

type Locations = Out<typeof ops.listLocations>;
type Location = Locations['locations'][number];

export function useLocations(shopId: string) {
  return useQuery({
    queryKey: ['shop', shopId, 'locations'],
    queryFn: () => api<Locations>(`/shops/${shopId}/locations`),
  });
}

export function WarehousesPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const locations = useLocations(shopId);
  const manage = can(context.data, 'storage.manage');
  const byWarehouse = useMemo(() => {
    const groups = new Map<string, { name: string; ownership: string; locations: Location[] }>();
    for (const l of locations.data?.locations ?? []) {
      const group = groups.get(l.warehouseId) ?? {
        name: l.warehouseName,
        ownership: l.ownership,
        locations: [],
      };
      group.locations.push(l);
      groups.set(l.warehouseId, group);
    }
    return [...groups.entries()];
  }, [locations.data]);

  return (
    <>
      <PageHeader
        title="Warehouses"
        subtitle="Where stock is kept: your own sites, rented space, and partners."
      />
      {locations.data?.partial ? (
        <Notice>You see only the locations you have access to.</Notice>
      ) : null}
      <ErrorNotice error={locations.error} />
      {locations.isPending ? <Loading /> : null}
      {byWarehouse.map(([id, w]) => (
        <Card key={id} title={w.name} actions={<Badge>{titleCase(w.ownership)}</Badge>}>
          <ul className="tree">
            {w.locations.map((l) => (
              <li
                key={l.locationId}
                style={{ paddingInlineStart: `${depth(l, w.locations) * 1.25}rem` }}
              >
                <span>{l.code ? `${l.code} · ${l.name}` : l.name}</span>
                {l.holdsStockAllowed ? (
                  <Badge tone="ok">holds stock</Badge>
                ) : (
                  <Badge tone="muted">area</Badge>
                )}
                {!l.fulfillmentEligible ? <Badge tone="muted">not for fulfillment</Badge> : null}
                {l.status !== 'active' ? <Badge tone="muted">{l.status}</Badge> : null}
              </li>
            ))}
          </ul>
        </Card>
      ))}
      {manage ? (
        <CreateLocation shopId={shopId} locations={locations.data?.locations ?? []} />
      ) : null}
      {manage ? <CreateWarehouse shopId={shopId} /> : null}
    </>
  );
}

function depth(location: Location, all: Location[]): number {
  let d = 0;
  let parent = location.parentId;
  while (parent) {
    d++;
    parent = all.find((l) => l.locationId === parent)?.parentId ?? null;
  }
  return d;
}

function CreateWarehouse({ shopId }: { shopId: string }) {
  const queryClient = useQueryClient();
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
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'locations'] });
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
            <option value="owned">Owned</option>
            <option value="rented">Rented</option>
            <option value="third_party">Third party</option>
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
      <ErrorNotice error={create.error} />
    </Card>
  );
}

function CreateLocation({ shopId, locations }: { shopId: string; locations: Location[] }) {
  const queryClient = useQueryClient();
  const warehouses = [...new Map(locations.map((l) => [l.warehouseId, l.warehouseName])).entries()];
  const [warehouseId, setWarehouseId] = useState('');
  const [parentId, setParentId] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const wh = warehouseId || warehouses[0]?.[0] || '';
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
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'locations'] });
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
            {warehouses.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
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
        <Field label="Code" hint="Optional, such as A-03.">
          <input value={code} onChange={(e) => setCode(e.target.value)} maxLength={50} />
        </Field>
        <button type="submit" disabled={create.isPending || !wh}>
          Add location
        </button>
      </form>
      <ErrorNotice error={create.error} />
    </Card>
  );
}
