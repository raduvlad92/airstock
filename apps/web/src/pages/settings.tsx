import type { ops } from '@airstock/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useParams } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { api, command, type Out } from '../api.ts';
import {
  Badge,
  Card,
  ErrorNotice,
  Field,
  formatDateTime,
  Loading,
  Notice,
  PageHeader,
  titleCase,
} from '../components/ui.tsx';
import { can, useShopContext } from '../context.tsx';
import { UnitsSetting } from './catalog-settings.tsx';
import { useLocations, useWarehouses } from './warehouses.tsx';

type Members = Out<typeof ops.listMembers>;
type Member = Members['members'][number];

const SETTINGS_TABS = [
  ['/shops/$shopId/settings/shop', 'Shop'],
  ['/shops/$shopId/settings/fields', 'Fields'],
  ['/shops/$shopId/settings/families', 'Families'],
  ['/shops/$shopId/settings/members', 'Members'],
] as const;

export function SettingsLayout() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  return (
    <>
      <PageHeader title="Settings" />
      <div className="tabs">
        {SETTINGS_TABS.map(([to, label]) => (
          <Link
            key={to}
            to={to}
            params={{ shopId }}
            className="tab"
            activeProps={{ className: 'tab active' }}
          >
            {label}
          </Link>
        ))}
      </div>
      <Outlet />
    </>
  );
}

export function ShopSettingsPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  if (!context.data) return <Loading />;
  const { shop, role, permissions, allLocations, rateLimits } = context.data;
  return (
    <>
      {can(context.data, 'shop.manage') ? (
        <UnitsSetting shopId={shopId} current={shop.displayUnits} />
      ) : null}
      <Card title="Shop">
        <dl className="facts">
          <dt>Name</dt>
          <dd>{shop.name}</dd>
          <dt>Currency</dt>
          <dd>{shop.currency}</dd>
          <dt>Time zone</dt>
          <dd>{shop.timezone}</dd>
          <dt>Your role</dt>
          <dd>{titleCase(role)}</dd>
          <dt>Locations</dt>
          <dd>{allLocations ? 'All locations' : 'Limited to some locations'}</dd>
        </dl>
      </Card>
      <Card title="Your permissions">
        <div className="chips">
          {permissions.map((p) => (
            <Badge key={p}>{p}</Badge>
          ))}
        </div>
      </Card>
      <Card title="Request limits">
        <p className="muted">
          Requests beyond these are refused with status 429 and a Retry-After header. Refusals are
          summarised in the activity history once per minute per caller.
        </p>
        <table className="table compact">
          <tbody>
            {rateLimits.map((l) => (
              <tr key={l.kind}>
                <td>{l.label}</td>
                <td className="num">{l.perSecond} per second</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

const INVITE_ROLES = [
  ['viewer', 'Viewer'],
  ['inventory_operator', 'Inventory operator'],
  ['catalog_editor', 'Catalog editor'],
  ['manager', 'Manager'],
] as const;

export function MembersPage() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const queryClient = useQueryClient();
  const members = useQuery({
    queryKey: ['shop', shopId, 'members'],
    queryFn: () => api<Members>(`/shops/${shopId}/members`),
  });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<string>('viewer');
  const [editing, setEditing] = useState<string | null>(null);
  // Only someone with every location can change scopes, so a scoped member cannot widen theirs.
  const manageScopes = can(context.data, 'members.manage') && context.data?.allLocations === true;
  const storage = can(context.data, 'storage.read');
  const warehouses = useWarehouses(shopId, storage);
  const locations = useLocations(shopId, storage);
  const names = new Map<string, string>([
    ...(warehouses.data?.warehouses ?? []).map((w) => [w.warehouseId, w.name] as [string, string]),
    ...(locations.data?.locations ?? []).map((l) => [l.locationId, l.path] as [string, string]),
  ]);
  const editingMember = members.data?.members.find((m) => m.membershipId === editing);
  const invite = useMutation({
    mutationFn: () => command(`/shops/${shopId}/invitations`, { email, role }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'members'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate();
  };
  return (
    <>
      <Card title="Members">
        <ErrorNotice error={members.error} />
        {members.isPending ? <Loading /> : null}
        {members.data ? (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Locations</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {members.data.members.map((m) => (
                  <tr key={m.membershipId}>
                    <td>
                      {m.email}
                      {m.displayName ? <span className="muted"> · {m.displayName}</span> : null}
                    </td>
                    <td>{titleCase(m.role)}</td>
                    <td>
                      {m.allLocations
                        ? 'All'
                        : m.locationScopeIds.map((id) => names.get(id) ?? 'Unknown').join(', ')}
                      {manageScopes && m.role !== 'owner' && m.status === 'active' ? (
                        <>
                          {' '}
                          <button
                            type="button"
                            className="ghost small"
                            onClick={() => setEditing(m.membershipId)}
                          >
                            Change
                          </button>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <Badge tone={m.status === 'active' ? 'ok' : 'muted'}>{m.status}</Badge>
                    </td>
                  </tr>
                ))}
                {members.data.invitations.map((i) => (
                  <tr key={i.invitationId}>
                    <td>{i.email}</td>
                    <td>{titleCase(i.role)}</td>
                    <td />
                    <td>
                      <Badge tone="muted">
                        invited{i.emailSentAt ? ', email sent' : ''} ({i.status})
                      </Badge>
                      <span className="muted"> until {formatDateTime(i.expiresAt)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </Card>
      {editingMember ? (
        <ScopeEditor
          key={editingMember.membershipId}
          shopId={shopId}
          member={editingMember}
          warehouses={(warehouses.data?.warehouses ?? []).filter((w) => w.status === 'active')}
          locations={(locations.data?.locations ?? []).filter((l) => l.status === 'active')}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {can(context.data, 'members.manage') ? (
        <Card title="Invite someone">
          <form className="inline-form" onSubmit={submit}>
            <Field label="Email">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={320}
              />
            </Field>
            <Field label="Role">
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                {INVITE_ROLES.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <button type="submit" disabled={invite.isPending}>
              Send invitation
            </button>
          </form>
          <p className="fine">The invited person accepts by signing in with this email address.</p>
          <ErrorNotice error={invite.error} />
          {invite.isSuccess ? <Notice tone="ok">Invitation sent.</Notice> : null}
        </Card>
      ) : null}
    </>
  );
}

type ScopeWarehouse = NonNullable<ReturnType<typeof useWarehouses>['data']>['warehouses'][number];
type ScopeLocation = NonNullable<ReturnType<typeof useLocations>['data']>['locations'][number];

/** All locations, or a set of warehouses and locations (C31). A warehouse covers everything in it. */
function ScopeEditor({
  shopId,
  member,
  warehouses,
  locations,
  onDone,
}: {
  shopId: string;
  member: Member;
  warehouses: ScopeWarehouse[];
  locations: ScopeLocation[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [all, setAll] = useState(member.allLocations);
  const [chosen, setChosen] = useState(() => new Set(member.locationScopeIds));
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = useMutation({
    mutationFn: () =>
      command(`/shops/${shopId}/members/${member.membershipId}/location-scope`, {
        allLocations: all,
        ...(all ? {} : { scopeIds: [...chosen] }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'members'] });
      onDone();
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const children = (parentId: string | null, warehouseId: string) =>
    locations.filter((l) => l.warehouseId === warehouseId && l.parentId === parentId);
  const renderLocations = (parentId: string | null, warehouseId: string, covered: boolean) => {
    const list = children(parentId, warehouseId);
    if (list.length === 0) return null;
    return (
      <ul className="scope-list">
        {list.map((l) => {
          const included = covered || chosen.has(l.locationId);
          return (
            <li key={l.locationId}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={included}
                  disabled={covered}
                  onChange={() => toggle(l.locationId)}
                />
                {l.code ? `${l.code} · ${l.name}` : l.name}
              </label>
              {renderLocations(l.locationId, warehouseId, included)}
            </li>
          );
        })}
      </ul>
    );
  };
  return (
    <Card title={`Locations for ${member.email}`}>
      <form className="stack" onSubmit={submit}>
        <fieldset className="checks">
          <legend>Access</legend>
          <label className="check">
            <input type="radio" name="scope" checked={all} onChange={() => setAll(true)} />
            All locations, including new ones
          </label>
          <label className="check">
            <input type="radio" name="scope" checked={!all} onChange={() => setAll(false)} />
            Only the warehouses and locations chosen below
          </label>
        </fieldset>
        {!all ? (
          <ul className="scope-list">
            {warehouses.map((w) => (
              <li key={w.warehouseId}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={chosen.has(w.warehouseId)}
                    onChange={() => toggle(w.warehouseId)}
                  />
                  <strong>{w.name}</strong>
                </label>
                {renderLocations(null, w.warehouseId, chosen.has(w.warehouseId))}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="fine">
          A warehouse includes all its locations; a location includes everything inside it. Stock
          and history elsewhere are hidden from this member, and their API credentials and AI
          connections follow the same limits.
        </p>
        <div className="form-actions">
          <button type="submit" disabled={save.isPending || (!all && chosen.size === 0)}>
            Save
          </button>
          <button type="button" className="ghost" onClick={onDone}>
            Cancel
          </button>
        </div>
        <ErrorNotice error={save.error} />
      </form>
    </Card>
  );
}
