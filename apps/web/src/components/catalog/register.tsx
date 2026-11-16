import { detailExtensions } from '../../catalog/detail.tsx';
import { ShopifyListingTab } from '../../pages/shopify-health.tsx';
import { PackagingTab, SuppliersTab } from './tabs.tsx';

let registered = false;

/** Adds the Packaging, Suppliers, and Shopify tabs to the product detail panel (plan N5, D21). */
export function registerCatalogExtensions() {
  if (registered) return;
  registered = true;
  detailExtensions.push(
    { id: 'packaging', label: 'Packaging', render: (props) => <PackagingTab {...props} /> },
    { id: 'suppliers', label: 'Suppliers', render: (props) => <SuppliersTab {...props} /> },
    { id: 'shopify', label: 'Shopify', render: (props) => <ShopifyListingTab {...props} /> },
  );
}
