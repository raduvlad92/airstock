import { Link, Outlet, useParams } from '@tanstack/react-router';
import { PageHeader } from '../components/ui.tsx';

/** Inventory: stock per variant, transfers, returns, and counts, as tabs (milestone I2). */
export function InventoryLayout() {
  const { shopId } = useParams({ from: '/shops/$shopId' });
  return (
    <>
      <PageHeader
        title="Inventory"
        subtitle="Stock by location, lot, and serial; transfers between locations; returns; and counts."
      />
      <div className="tabs">
        {(
          [
            ['/shops/$shopId/inventory', 'Stock'],
            ['/shops/$shopId/inventory/transfers', 'Transfers'],
          ] as const
        ).map(([to, label]) => (
          <Link
            key={to}
            to={to}
            params={{ shopId }}
            className="tab"
            activeOptions={{ exact: true, includeSearch: false }}
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
