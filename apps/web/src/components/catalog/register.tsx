import { detailExtensions } from '../../catalog/detail.tsx';
import { PackagingTab, SuppliersTab } from './tabs.tsx';

let registered = false;

/** Adds the Packaging and Suppliers tabs to the product detail panel (plan N5). */
export function registerCatalogExtensions() {
  if (registered) return;
  registered = true;
  detailExtensions.push(
    { id: 'packaging', label: 'Packaging', render: (props) => <PackagingTab {...props} /> },
    { id: 'suppliers', label: 'Suppliers', render: (props) => <SuppliersTab {...props} /> },
  );
}
