import type { ops } from '@airstock/core';
import { inferSymbology } from '@airstock/core/barcodes';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ApiError, api, command, errorMessage, type Out } from '../api.ts';
import { can } from '../context.tsx';
import { useMutation } from '../mutation.ts';
import type { ScanEnv } from './flows.ts';
import { type Resolved, resolveScan } from './resolve.ts';

type QueryResult = Out<typeof ops.queryItems>;
type Packaging = Out<typeof ops.getPackaging>;
type Duplicates = Out<typeof ops.checkDuplicates>;
type Created = Out<typeof ops.createItem>;

/**
 * An unknown code (plan 5.12): attach it to an existing variant found by search, or create a new
 * item with it, after the same duplicate check as the dashboard (ADR 0019). Both are ordinary
 * catalog commands; afterwards the code is looked up again, so the flow continues with the item.
 * A graded card's certificate can also go straight to Quick add, which creates and receives it.
 */
export function UnknownCode({
  env,
  code,
  onDone,
}: {
  env: ScanEnv;
  code: string;
  onDone: (resolved: Resolved) => void;
}) {
  const [mode, setMode] = useState<'choose' | 'attach' | 'create'>('choose');
  const canWrite = can(env.shop, 'catalog.write');
  const finish = async () => {
    const again = await resolveScan(env.shopId, code);
    env.feedback('ok', again.kind === 'item' ? `${code} now belongs to ${again.item.sku}.` : '');
    onDone(again);
  };
  return (
    <div className="scan-card">
      <h2>Unknown code</h2>
      <p className="mono scan-code">{code}</p>
      {!canWrite ? (
        <p className="muted">No product or pack in this shop has this code.</p>
      ) : mode === 'choose' ? (
        <>
          <p className="muted">No product or pack in this shop has this code yet.</p>
          <div className="scan-actions two">
            <button type="button" onClick={() => setMode('attach')}>
              Attach to an item
            </button>
            <button type="button" className="secondary" onClick={() => setMode('create')}>
              Create new item
            </button>
          </div>
          {can(env.shop, 'inventory.receive') ? (
            <button
              type="button"
              className="secondary"
              onClick={() => env.startFlow('quick-add', { certificate: code })}
            >
              Quick add as a one-of-a-kind item
            </button>
          ) : null}
        </>
      ) : mode === 'attach' ? (
        <AttachCode env={env} code={code} onDone={finish} onBack={() => setMode('choose')} />
      ) : (
        <CreateItem env={env} code={code} onDone={finish} onBack={() => setMode('choose')} />
      )}
    </div>
  );
}

function AttachCode({
  env,
  code,
  onDone,
  onBack,
}: {
  env: ScanEnv;
  code: string;
  onDone: () => Promise<void>;
  onBack: () => void;
}) {
  const [search, setSearch] = useState('');
  const found = useQuery({
    queryKey: ['shop', env.shopId, 'scan-attach-search', search.trim()],
    queryFn: () =>
      api<QueryResult>(`/shops/${env.shopId}/items/query`, {
        method: 'POST',
        body: { mode: 'variants', search: search.trim(), limit: 8 },
      }),
    enabled: search.trim().length >= 2,
  });
  const attach = useMutation({
    mutationFn: async (variantId: string) => {
      const packaging = await api<Packaging>(
        `/shops/${env.shopId}/variants/${variantId}/packaging`,
      );
      return command(`/shops/${env.shopId}/variants/${variantId}/barcodes`, {
        barcodesVersion: packaging.barcodesVersion,
        barcodes: [
          ...packaging.barcodes.map((b) => ({
            code: b.code,
            symbology: b.symbology,
            packId: b.packId,
          })),
          { code, symbology: inferSymbology(code) },
        ],
      });
    },
    onSuccess: () => onDone(),
    onError: (error) => env.feedback('error', errorMessage(error)),
  });
  return (
    <div className="scan-actions">
      <input
        type="search"
        aria-label="Find the item"
        placeholder="Name or SKU"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: the next step is typing a search.
        autoFocus
      />
      <ul className="scan-results">
        {(found.data?.rows ?? [])
          .filter((r) => r.variantId)
          .map((r) => (
            <li key={r.variantId}>
              <button
                type="button"
                className="scan-choice"
                disabled={attach.isPending}
                onClick={() => attach.mutate(r.variantId!)}
              >
                <strong>
                  {r.name}
                  {r.title ? ` · ${r.title}` : ''}
                </strong>
                <span className="mono muted">{r.sku}</span>
              </button>
            </li>
          ))}
      </ul>
      {found.data && found.data.rows.length === 0 ? <p className="muted">No match.</p> : null}
      {attach.error ? <p className="notice error">{errorMessage(attach.error)}</p> : null}
      <button type="button" className="secondary" onClick={onBack}>
        Back
      </button>
    </div>
  );
}

function CreateItem({
  env,
  code,
  onDone,
  onBack,
}: {
  env: ScanEnv;
  code: string;
  onDone: () => Promise<void>;
  onBack: () => void;
}) {
  const [name, setName] = useState('');
  const [sku, setSku] = useState(code.length <= 100 ? code : '');
  const [price, setPrice] = useState('');
  const [similar, setSimilar] = useState<Duplicates['similarNames'] | null>(null);
  const create = useMutation({
    mutationFn: async (acknowledgeSimilar: boolean) => {
      if (!acknowledgeSimilar) {
        const dupes = await api<Duplicates>(`/shops/${env.shopId}/items/duplicates`, {
          method: 'POST',
          body: { name: name.trim(), sku: sku.trim(), barcode: code },
        });
        if (dupes.skuTaken) {
          throw new Error(
            `The SKU ${sku.trim()} is taken by ${dupes.skuTaken.name}. Choose another.`,
          );
        }
        if (dupes.barcodeTaken) throw new Error('Another item took this code meanwhile.');
        if (dupes.similarNames.length > 0) {
          setSimilar(dupes.similarNames);
          return null;
        }
      }
      return command<Created>(`/shops/${env.shopId}/items`, {
        name: name.trim(),
        sku: sku.trim(),
        ...(price.trim() ? { price: price.trim() } : {}),
        barcode: code,
        acknowledgeSimilar,
      });
    },
    onSuccess: (created) => {
      if (created) void onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'similar_name') return;
      env.feedback('error', errorMessage(error));
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(false);
  };
  return (
    <form className="scan-actions" onSubmit={submit}>
      <input
        aria-label="Name"
        placeholder="Name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        maxLength={500}
        // biome-ignore lint/a11y/noAutofocus: the next step is typing the name.
        autoFocus
      />
      <input
        aria-label="SKU"
        placeholder="SKU"
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        required
        maxLength={100}
        autoCapitalize="characters"
      />
      <input
        aria-label="Price"
        placeholder="Price (optional)"
        inputMode="decimal"
        value={price}
        onChange={(e) => setPrice(e.target.value)}
      />
      {similar ? (
        <div className="notice">
          <p>Similar names already exist:</p>
          <ul>
            {similar.map((s) => (
              <li key={s.productId}>{s.name}</li>
            ))}
          </ul>
          <button type="button" onClick={() => create.mutate(true)} disabled={create.isPending}>
            Create anyway
          </button>
        </div>
      ) : (
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Creating…' : 'Create with this code'}
        </button>
      )}
      {create.error ? <p className="notice error">{errorMessage(create.error)}</p> : null}
      <button type="button" className="secondary" onClick={onBack}>
        Back
      </button>
    </form>
  );
}
