import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { RootLayout, ShopLayout } from './components/layout.tsx';
import { ActivityPage } from './pages/activity.tsx';
import {
  AiConnectionsPage,
  ApiCredentialsPage,
  IntegrationsLayout,
  ShopifyPage,
} from './pages/integrations.tsx';
import { InventoryPage } from './pages/inventory.tsx';
import { ProductsPage } from './pages/products.tsx';
import { MembersPage, SettingsLayout, ShopSettingsPage } from './pages/settings.tsx';
import { ShopsPage } from './pages/shops.tsx';
import { WarehousesPage } from './pages/warehouses.tsx';

const rootRoute = createRootRoute({ component: RootLayout });

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: ShopsPage,
  validateSearch: (search: Record<string, unknown>): { all?: boolean; joined?: string } => ({
    ...(search.all === true || search.all === 'true' ? { all: true } : {}),
    ...(typeof search.joined === 'string' || typeof search.joined === 'number'
      ? { joined: String(search.joined) }
      : {}),
  }),
});

const shopRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/shops/$shopId',
  component: ShopLayout,
});

const shopIndexRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/shops/$shopId/products', params });
  },
});

const productsRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/products',
  component: ProductsPage,
});
const inventoryRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/inventory',
  component: InventoryPage,
});
const warehousesRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/warehouses',
  component: WarehousesPage,
});
const activityRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/activity',
  component: ActivityPage,
});

const integrationsRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/integrations',
  component: IntegrationsLayout,
});
const integrationsIndexRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/shops/$shopId/integrations/shopify', params });
  },
});
const shopifyRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: '/shopify',
  component: ShopifyPage,
  validateSearch: (search: Record<string, unknown>): { connected?: string } =>
    typeof search.connected === 'string' ? { connected: search.connected } : {},
});
const aiRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: '/ai',
  component: AiConnectionsPage,
});
const apiRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: '/api',
  component: ApiCredentialsPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/settings',
  component: SettingsLayout,
});
const settingsIndexRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/',
  beforeLoad: ({ params }) => {
    throw redirect({ to: '/shops/$shopId/settings/shop', params });
  },
});
const shopSettingsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/shop',
  component: ShopSettingsPage,
});
const membersRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/members',
  component: MembersPage,
});

export const routeTree = rootRoute.addChildren([
  homeRoute,
  shopRoute.addChildren([
    shopIndexRoute,
    productsRoute,
    inventoryRoute,
    warehousesRoute,
    activityRoute,
    integrationsRoute.addChildren([integrationsIndexRoute, shopifyRoute, aiRoute, apiRoute]),
    settingsRoute.addChildren([settingsIndexRoute, shopSettingsRoute, membersRoute]),
  ]),
]);

export function createAppRouter() {
  return createRouter({ routeTree, basepath: '/app', defaultPreload: 'intent' });
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
