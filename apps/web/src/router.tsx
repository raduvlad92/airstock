import { createRootRoute, createRoute, createRouter, redirect } from '@tanstack/react-router';
import { RootLayout, ShopLayout } from './components/layout.tsx';
import { parseLabelsSearch } from './labels/search.ts';
import { ActivityPage, parseActivitySearch } from './pages/activity.tsx';
import { AlertsPage } from './pages/alerts.tsx';
import { FamiliesSettingsPage, FieldsSettingsPage } from './pages/catalog-settings.tsx';
import { CountsPage } from './pages/counts.tsx';
import { ImportsPage } from './pages/imports.tsx';
import {
  AiConnectionsPage,
  ApiCredentialsPage,
  IntegrationsLayout,
  ShopifyPage,
} from './pages/integrations.tsx';
import { InventoryPage } from './pages/inventory.tsx';
import { InventoryLayout } from './pages/inventory-layout.tsx';
import { LabelsPage } from './pages/labels.tsx';
import { PickingPage } from './pages/picking.tsx';
import { ProductsPage } from './pages/products.tsx';
import { PurchasingPage } from './pages/purchasing.tsx';
import { ReturnsPage } from './pages/returns.tsx';
import { MembersPage, SettingsLayout, ShopSettingsPage } from './pages/settings.tsx';
import { ShopsPage } from './pages/shops.tsx';
import { StockCheckPage } from './pages/stock-check.tsx';
import { SuppliersPage } from './pages/suppliers.tsx';
import { TransfersPage } from './pages/transfers.tsx';
import { WarehousesPage } from './pages/warehouses.tsx';
import { WebhooksPage } from './pages/webhooks.tsx';
import { parseScanSearch, ScanPage } from './scan/page.tsx';

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

/** The phone scanning app (plan D13): the installed app starts here. */
const scanRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/scan',
  component: ScanPage,
  validateSearch: parseScanSearch,
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
  component: InventoryLayout,
});
const inventoryIndexRoute = createRoute({
  getParentRoute: () => inventoryRoute,
  path: '/',
  component: InventoryPage,
});
const countsRoute = createRoute({
  getParentRoute: () => inventoryRoute,
  path: '/counts',
  component: CountsPage,
  validateSearch: (search: Record<string, unknown>): { count?: string } =>
    typeof search.count === 'string' && /^[0-9a-f-]{36}$/.test(search.count)
      ? { count: search.count }
      : {},
});
const returnsRoute = createRoute({
  getParentRoute: () => inventoryRoute,
  path: '/returns',
  component: ReturnsPage,
  validateSearch: (search: Record<string, unknown>): { return?: string } =>
    typeof search.return === 'string' && /^[0-9a-f-]{36}$/.test(search.return)
      ? { return: search.return }
      : {},
});
const transfersRoute = createRoute({
  getParentRoute: () => inventoryRoute,
  path: '/transfers',
  component: TransfersPage,
  validateSearch: (search: Record<string, unknown>): { transfer?: string } =>
    typeof search.transfer === 'string' && /^[0-9a-f-]{36}$/.test(search.transfer)
      ? { transfer: search.transfer }
      : {},
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
const alertsRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/alerts',
  component: AlertsPage,
});
const purchasingRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/purchasing',
  component: PurchasingPage,
  validateSearch: (search: Record<string, unknown>): { po?: string } =>
    typeof search.po === 'string' && /^[0-9a-f-]{36}$/.test(search.po) ? { po: search.po } : {},
});
const labelsRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/labels',
  component: LabelsPage,
  validateSearch: parseLabelsSearch,
});
const pickingRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/picking',
  component: PickingPage,
});
const activityRoute = createRoute({
  getParentRoute: () => shopRoute,
  path: '/activity',
  component: ActivityPage,
  validateSearch: parseActivitySearch,
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
  scanRoute,
  shopRoute.addChildren([
    shopIndexRoute,
    productsRoute,
    importsRoute,
    inventoryRoute.addChildren([inventoryIndexRoute, transfersRoute, returnsRoute, countsRoute]),
    warehousesRoute,
    suppliersRoute,
    purchasingRoute,
    alertsRoute,
    labelsRoute,
    pickingRoute,
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
