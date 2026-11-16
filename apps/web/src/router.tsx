import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { RootLayout, ShopLayout } from './components/layout.tsx';
import { parseLabelsSearch } from './labels/search.ts';
import { ActivityPage } from './pages/activity.tsx';
import { FamiliesSettingsPage, FieldsSettingsPage } from './pages/catalog-settings.tsx';
import { ImportsPage } from './pages/imports.tsx';
import {
  AiConnectionsPage,
  ApiCredentialsPage,
  IntegrationsLayout,
  ShopifyPage,
} from './pages/integrations.tsx';
import { InventoryPage } from './pages/inventory.tsx';
import { LabelsPage } from './pages/labels.tsx';
import { ProductsPage } from './pages/products.tsx';
import { MembersPage, SettingsLayout, ShopSettingsPage } from './pages/settings.tsx';
import { ShopsPage } from './pages/shops.tsx';
import { StockCheckPage } from './pages/stock-check.tsx';
import { SuppliersPage } from './pages/suppliers.tsx';
import { WarehousesPage } from './pages/warehouses.tsx';
import { WebhooksPage } from './pages/webhooks.tsx';

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
  validateSearch: (search: Record<string, unknown>): { item?: string } =>
    typeof search.item === 'string' && /^[0-9a-f-]{36}$/.test(search.item)
      ? { item: search.item }
      : {},
});
const importsRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/imports',
  component: ImportsPage,
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
const suppliersRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/suppliers',
  component: SuppliersPage,
  validateSearch: (search: Record<string, unknown>): { supplier?: string } =>
    typeof search.supplier === 'string' && /^[0-9a-f-]{36}$/.test(search.supplier)
      ? { supplier: search.supplier }
      : {},
});
const labelsRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/labels',
  component: LabelsPage,
  validateSearch: parseLabelsSearch,
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
const webhooksRoute = createRoute({
  getParentRoute: () => integrationsRoute,
  path: '/webhooks',
  component: WebhooksPage,
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
const stockCheckRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/stock-check',
  component: StockCheckPage,
});
const fieldsRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/fields',
  component: FieldsSettingsPage,
});
const familiesRoute = createRoute({
  getParentRoute: () => settingsRoute,
  path: '/families',
  component: FamiliesSettingsPage,
});

export const routeTree = rootRoute.addChildren([
  homeRoute,
  shopRoute.addChildren([
    shopIndexRoute,
    productsRoute,
    importsRoute,
    inventoryRoute,
    warehousesRoute,
    suppliersRoute,
    labelsRoute,
    activityRoute,
    integrationsRoute.addChildren([
      integrationsIndexRoute,
      shopifyRoute,
      aiRoute,
      apiRoute,
      webhooksRoute,
    ]),
    settingsRoute.addChildren([
      settingsIndexRoute,
      shopSettingsRoute,
      fieldsRoute,
      familiesRoute,
      membersRoute,
      stockCheckRoute,
    ]),
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
