import { type ReactNode, useState } from 'react';
import type { Item } from '../../catalog/detail.tsx';
import { Field } from '../ui.tsx';
import { BarcodesEditor } from './BarcodesEditor.tsx';
import { BundleEditor } from './BundleEditor.tsx';
import { PacksEditor } from './PacksEditor.tsx';
import { ShippingPackagesEditor } from './ShippingPackagesEditor.tsx';
import { SupplierItemsEditor } from './SupplierItemsEditor.tsx';

export interface TabProps {
  shopId: string;
  item: Item;
  canWrite: boolean;
}

/** Packaging and suppliers are per variant; a product with several variants picks one first. */
function PerVariant({ item, children }: { item: Item; children(variantId: string): ReactNode }) {
  const variants = [...item.variants].sort(
    (a, b) => Number(a.status !== 'active') - Number(b.status !== 'active'),
  );
  const [variantId, setVariantId] = useState(variants[0]?.id ?? '');
  if (!variantId) return <p className="muted">This product has no variants.</p>;
  return (
    <div className="stack">
      {variants.length > 1 ? (
        <Field label="Variant">
          <select value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.title || 'Default'} · {v.sku}
                {v.status === 'active' ? '' : ` (${v.status})`}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {/* A new key per variant drops another variant's unsaved draft instead of carrying it over. */}
      <div key={variantId} className="stack">
        {children(variantId)}
      </div>
    </div>
  );
}

export function PackagingTab({ shopId, item, canWrite }: TabProps) {
  return (
    <PerVariant item={item}>
      {(variantId) => {
        const props = { shopId, productId: item.product.id, variantId, canWrite };
        return (
          <>
            <PacksEditor {...props} />
            <BarcodesEditor {...props} />
            <ShippingPackagesEditor {...props} />
            <BundleEditor {...props} />
          </>
        );
      }}
    </PerVariant>
  );
}

export function SuppliersTab({ shopId, item, canWrite }: TabProps) {
  return (
    <PerVariant item={item}>
      {(variantId) => (
        <SupplierItemsEditor
          shopId={shopId}
          productId={item.product.id}
          variantId={variantId}
          canWrite={canWrite}
        />
      )}
    </PerVariant>
  );
}
