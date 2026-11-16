import { Link, Outlet, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import { can, useAppInfo, useShopContext, useShops } from '../context.tsx';
import { AlertCount } from '../pages/alerts.tsx';
import { telemetry } from '../telemetry.ts';
import { ErrorNotice, Loading } from './ui.tsx';

/** Top bar for every page: brand, shop switcher, and the signed-in user. */
export function RootLayout() {
  const { email } = useAppInfo();
  const scanning = useRouterState({ select: (s) => s.matches.some((m) => m.routeId === '/scan') });
  // The scanning app is full screen on the phone, with its own header.
  if (scanning) return <Outlet />;
  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          <img src="/assets/icon.svg" alt="" width="22" height="22" />
          <span>Airstock</span>
        </Link>
        <span className="env-pill">staging</span>
        <ShopSwitcher />
        <div className="topbar-end">
          <span className="muted user-email">{email}</span>
          <form method="post" action="/auth/logout">
            <button type="submit" className="ghost small">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <Outlet />
    </div>
  );
}

function ShopSwitcher() {
  const params = useParams({ strict: false }) as { shopId?: string };
  const shops = useShops();
  const navigate = useNavigate();
  if (!params.shopId || !shops.data) return null;
  return (
    <select
      className="shop-switcher"
      aria-label="Shop"
      value={params.shopId}
      onChange={(e) => {
        if (e.target.value === '') void navigate({ to: '/', search: { all: true } });
        else void navigate({ to: '/shops/$shopId/products', params: { shopId: e.target.value } });
      }}
    >
      {shops.data.shops.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
      <option value="">All shops…</option>
    </select>
  );
}

const NAV = [
  { to: '/shops/$shopId/products', label: 'Products', permission: 'catalog.read' },
  { to: '/shops/$shopId/inventory', label: 'Inventory', permission: 'inventory.read' },
  { to: '/shops/$shopId/warehouses', label: 'Warehouses', permission: 'storage.read' },
  { to: '/shops/$shopId/suppliers', label: 'Suppliers', permission: 'catalog.read' },
  { to: '/shops/$shopId/purchasing', label: 'Purchasing', permission: 'inventory.read' },
  { to: '/shops/$shopId/alerts', label: 'Alerts', permission: 'inventory.read' },
  { to: '/shops/$shopId/reports', label: 'Reports', permission: 'reports.run' },
  { to: '/shops/$shopId/labels', label: 'Labels', permission: 'catalog.read' },
  { to: '/shops/$shopId/picking', label: 'Picking', permission: 'inventory.read' },
  { to: '/shops/$shopId/activity', label: 'Activity', permission: 'activity.read' },
  { to: '/shops/$shopId/integrations', label: 'Integrations', permission: 'shop.read' },
  { to: '/shops/$shopId/settings', label: 'Settings', permission: 'shop.read' },
] as const;

/** Navigation inside one shop (PRD 3.2), and a page-view event per route for the history. */
export function ShopLayout() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  const context = useShopContext(shopId);
  const routeId = useRouterState({ select: (s) => s.matches.at(-1)?.routeId ?? '' });

  useEffect(() => {
    if (routeId) telemetry.track(shopId, 'page.viewed', { route: routeId });
  }, [shopId, routeId]);

  if (context.isPending) return <Loading />;
  if (context.error) {
    return (
      <main className="content">
        <ErrorNotice error={context.error} />
        <Link to="/">All shops</Link>
      </main>
    );
  }
  return (
    <div className="shop-layout">
      <nav className="sidenav" aria-label="Shop">
        <div className="sidenav-shop">
          <strong>{context.data.shop.name}</strong>
          <span className="muted">{context.data.role.replaceAll('_', ' ')}</span>
        </div>
        {NAV.filter((item) => can(context.data, item.permission)).map((item) => (
          <Link
            key={item.to}
            to={item.to}
            params={{ shopId }}
            className="nav-link"
            activeProps={{ className: 'nav-link active' }}
          >
            {item.label}
            {item.label === 'Alerts' ? <AlertCount shopId={shopId} /> : null}
          </Link>
        ))}
        {can(context.data, 'inventory.read') ? (
          <Link to="/scan" search={{ shop: shopId }} className="nav-link">
            Scan
          </Link>
        ) : null}
      </nav>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
