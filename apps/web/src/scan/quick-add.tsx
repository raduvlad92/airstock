import type { ops } from '@airstock/core';
import { DEFAULT_ORIGINAL_MAX_SIDE } from '@airstock/core/media';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError, api, command, errorMessage, type Out } from '../api.ts';
import { type CatalogSchema, useCatalogSchema } from '../catalog/schema.ts';
import { type PreparedFile, prepareFile } from '../components/media/derivatives.ts';
import { uploadToProduct } from '../components/media/upload.ts';
import { can } from '../context.tsx';
import { useMutation } from '../mutation.ts';
import { type ScanEnv, useScanHandler } from './flows.ts';
import { ItemTitle } from './lookup.tsx';
import type { ScanItem } from './resolve.ts';
import { ScanField } from './scan-field.tsx';

type QuickAdded = Out<typeof ops.quickAdd>;
type Field = CatalogSchema['fields'][number];
type Family = CatalogSchema['families'][number];

const PRICE = /^\d+(\.\d{1,4})?$/;
const COST = /^\d+(\.\d{1,6})?$/;
/** Field types the phone form can fill; others stay for the dashboard. */
const PHONE_TYPES = new Set(['text', 'integer', 'decimal', 'single_select', 'boolean', 'date']);
/** The certificate number is the scanned code; the form fills this family field with it. */
const CERTIFICATE_FIELD = 'certificate_number';
/** The starter families quick add is made for (D5). */
const STARTERS = [
  { key: 'trading_cards', name: 'Trading cards' },
  { key: 'building_sets', name: 'Building sets' },
] as const;

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: not remembered.
  }
}

function dataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

interface Picture {
  id: string;
  name: string;
  url: string | null;
  prepared: PreparedFile | null;
  state: 'preparing' | 'ready' | 'failed' | 'uploading' | 'done';
  progress: number;
  error?: string;
}

/**
 * Quick add (plan 5.7, D5) from the phone: a one-of-a-kind item, such as a graded card, in one
 * command. Take pictures, scan or type the certificate number (it becomes the item's barcode),
 * choose the family and fill its fields, the price (and cost with costs.read), and add it at the
 * current location: inventory.quick_add creates the product and receives the unit, then the
 * pictures are uploaded and linked through the media pipeline, shrunk to the shop's limit. Or add
 * one more serialized unit to an item whose units share a price.
 */
export function QuickAddFlow({ env }: { env: ScanEnv }) {
  const modeKey = `airstock.scan.quick-add-mode.${env.shopId}`;
  const [mode, setModeState] = useState<'new' | 'unit'>(() =>
    env.preset?.certificate ? 'new' : remembered(modeKey) === 'unit' ? 'unit' : 'new',
  );
  const setMode = (next: 'new' | 'unit') => {
    remember(modeKey, next);
    setModeState(next);
  };
  if (!can(env.shop, 'inventory.receive')) {
    return (
      <div className="scan-hint">
        <h2>Quick add</h2>
        <p>Quick add also receives the item, which needs the receive permission.</p>
      </div>
    );
  }
  return (
    <>
      <fieldset className="scan-segments" aria-label="Quick add mode">
        <button
          type="button"
          aria-pressed={mode === 'new'}
          className={mode === 'new' ? 'chosen' : 'secondary'}
          onClick={() => setMode('new')}
        >
          One of a kind
        </button>
        <button
          type="button"
          aria-pressed={mode === 'unit'}
          className={mode === 'unit' ? 'chosen' : 'secondary'}
          onClick={() => setMode('unit')}
        >
          Unit of a shared item
        </button>
      </fieldset>
      {mode === 'new' ? (
        <NewItem env={env} initialCertificate={env.preset?.certificate ?? ''} />
      ) : (
        <SharedUnit env={env} />
      )}
    </>
  );
}

function fieldValue(field: Field, raw: string): unknown {
  if (field.type === 'boolean') return raw === 'true';
  return raw;
}

function NewItem({ env, initialCertificate }: { env: ScanEnv; initialCertificate: string }) {
  const queryClient = useQueryClient();
  const schema = useCatalogSchema(env.shopId);
  const familyKey = `airstock.scan.quick-add-family.${env.shopId}`;
  // List on Shopify (D21): off, or a draft or active listing; the last choice is remembered.
  const shopifyKey = `airstock.scan.quick-add-shopify.${env.shopId}`;
  const [listing, setListingState] = useState<'off' | 'draft' | 'active'>(() => {
    const v = remembered(shopifyKey);
    return v === 'draft' || v === 'active' ? v : 'off';
  });
  const setListing = (next: 'off' | 'draft' | 'active') => {
    setListingState(next);
    remember(shopifyKey, next);
  };
  const canList = can(env.shop, 'catalog.write');
  const stores = useQuery({
    queryKey: ['shop', env.shopId, 'shopify'],
    queryFn: () =>
      api<Out<typeof ops.listShopifyConnections>>(`/shops/${env.shopId}/shopify/connections`),
    enabled: canList,
  });
  const connected = (stores.data?.connections ?? []).filter((c) => c.status === 'active');
  const [certificate, setCertificate] = useState(initialCertificate);
  const [pictures, setPictures] = useState<Picture[]>([]);
  const [familyChoice, setFamilyChoice] = useState<string | null>(() => remembered(familyKey));
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [similar, setSimilar] = useState<Array<{ productId: string; name: string }> | null>(null);
  const [added, setAdded] = useState<(QuickAdded & { name: string; path: string }) | null>(null);
  const key = useRef(crypto.randomUUID());
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const seesCosts = can(env.shop, 'costs.read');
  const managesSchema = can(env.shop, 'catalog.schema.manage');
  const maxSide =
    env.shop.shop.mediaOriginalMaxSide === undefined
      ? DEFAULT_ORIGINAL_MAX_SIDE
      : env.shop.shop.mediaOriginalMaxSide;

  const families = schema.data?.families.filter((f) => f.status === 'active') ?? [];
  // The remembered family, else Trading cards when the shop has it.
  const familyId =
    familyChoice !== null && (familyChoice === '' || families.some((f) => f.id === familyChoice))
      ? familyChoice
      : (families.find((f) => f.templateKey === 'trading_cards')?.id ?? '');
  const family: Family | null = families.find((f) => f.id === familyId) ?? null;
  const fields: Field[] = family
    ? family.fields
        .map((ff) => schema.data!.fields.find((f) => f.id === ff.fieldId))
        .filter((f): f is Field => !!f && f.status === 'active' && PHONE_TYPES.has(f.type))
    : [];
  const hasCertificateField = fields.some((f) => f.key === CERTIFICATE_FIELD);

  const addPictures = async (files: File[]) => {
    const rows: Picture[] = files.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      url: null,
      prepared: null,
      state: 'preparing',
      progress: 0,
    }));
    setPictures((current) => [...current, ...rows]);
    // One at a time: each picture holds its bytes and two resized copies in memory.
    for (const [i, file] of files.entries()) {
      const row = rows[i]!;
      try {
        const prepared = await prepareFile(file, undefined, { originalMaxSide: maxSide });
        // The preview is the small thumbnail as a data: URL; the CSP allows no blob: images.
        const url = prepared.derivatives ? await dataUrl(prepared.derivatives.thumbnail) : null;
        setPictures((list) =>
          list.map((p) => (p.id === row.id ? { ...p, prepared, url, state: 'ready' } : p)),
        );
      } catch (error) {
        setPictures((list) =>
          list.map((p) =>
            p.id === row.id ? { ...p, state: 'failed', error: errorMessage(error) } : p,
          ),
        );
      }
    }
  };

  const uploadAll = async (productId: string, list: Picture[]) => {
    let failed = 0;
    for (const p of list) {
      if (!p.prepared || p.state === 'done') continue;
      setPictures((all) =>
        all.map((x) => (x.id === p.id ? { ...x, state: 'uploading', error: undefined } : x)),
      );
      try {
        await uploadToProduct(env.shopId, productId, p.prepared, (share) =>
          setPictures((all) => all.map((x) => (x.id === p.id ? { ...x, progress: share } : x))),
        );
        setPictures((all) =>
          all.map((x) => (x.id === p.id ? { ...x, state: 'done', progress: 1 } : x)),
        );
      } catch (error) {
        failed += 1;
        setPictures((all) =>
          all.map((x) =>
            x.id === p.id ? { ...x, state: 'failed', error: errorMessage(error) } : x,
          ),
        );
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['shop', env.shopId, 'media'] });
    return failed;
  };

  const submit = useMutation({
    mutationFn: (acknowledgeSimilar: boolean) => {
      const fieldValues: Record<string, unknown> = {};
      for (const f of fields) {
        const raw = f.key === CERTIFICATE_FIELD ? certificate.trim() : (values[f.key] ?? '').trim();
        if (raw) fieldValues[f.key] = fieldValue(f, raw);
      }
      return command<QuickAdded>(
        `/shops/${env.shopId}/quick-add`,
        {
          locationId: env.location!.locationId,
          name: name.trim(),
          price: price.trim(),
          ...(certificate.trim() ? { barcode: certificate.trim() } : {}),
          ...(family ? { family: family.id } : {}),
          ...(Object.keys(fieldValues).length > 0 ? { fields: fieldValues } : {}),
          ...(seesCosts && cost.trim() ? { unitCost: cost.trim() } : {}),
          acknowledgeSimilar,
        },
        key.current,
      );
    },
    onSuccess: async (r) => {
      key.current = crypto.randomUUID();
      setSimilar(null);
      const path = env.location!.path;
      setAdded({ ...r, name: name.trim(), path });
      const toSend = pictures.filter((p) => p.prepared);
      const failed = toSend.length > 0 ? await uploadAll(r.productId, toSend) : 0;
      // Listed after the pictures are in, so the Shopify product has them from the start.
      let listed = '';
      if (listing !== 'off' && connected.length === 1) {
        try {
          await command(`/shops/${env.shopId}/products/${r.productId}/shopify-listing`, {
            productId: r.productId,
            connectionId: connected[0]!.connectionId,
            status: listing,
          });
          listed = `, listing on Shopify as ${listing}`;
        } catch (error) {
          listed = `; not listed on Shopify: ${errorMessage(error)}`;
        }
      }
      env.feedback(
        failed > 0 || listed.startsWith(';') ? 'error' : 'ok',
        `Added ${name.trim()} (${r.sku}) at ${path}${toSend.length ? `, ${toSend.length - failed} of ${toSend.length} pictures` : ''}${listed}.`,
      );
      void queryClient.invalidateQueries({ queryKey: ['shop', env.shopId] });
    },
    onError: (error) => {
      // The next attempt is a new request (it may acknowledge similar names): a new key.
      key.current = crypto.randomUUID();
      if (error instanceof ApiError && error.code === 'similar_items_found') {
        setSimilar(
          (error.problem.similarNames as Array<{ productId: string; name: string }>) ?? [],
        );
        env.feedback('notice', 'Items with similar names exist. Check them before adding.');
        return;
      }
      env.feedback('error', errorMessage(error));
    },
  });

  const addTemplate = useMutation({
    mutationFn: (template: string) =>
      command<{ family: Family }>(`/shops/${env.shopId}/catalog/templates`, { template }),
    onSuccess: async (r) => {
      await queryClient.invalidateQueries({ queryKey: ['shop', env.shopId, 'schema'] });
      remember(familyKey, r.family.id);
      setFamilyChoice(r.family.id);
    },
    onError: (error) => env.feedback('error', errorMessage(error)),
  });

  useScanHandler((scan) => {
    if (added || scan.kind === 'location') return false;
    if (scan.kind === 'unknown') {
      setCertificate(scan.code);
      env.feedback('ok', `Certificate ${scan.code}.`);
      return true;
    }
    const item = scan.item;
    env.feedback(
      'error',
      item.trackingMode === 'serial' && item.matchedBy !== 'serial'
        ? `${scan.code} is ${item.sku}, whose units share a price: add a unit of it instead.`
        : `${scan.code} already belongs to ${item.sku}.`,
    );
    return true;
  });

  const reset = () => {
    setAdded(null);
    setCertificate('');
    setPictures([]);
    setValues({});
    setName('');
    setPrice('');
    setCost('');
    setSimilar(null);
  };

  if (added) {
    const busy = pictures.some((p) => p.state === 'uploading' || p.state === 'preparing');
    const failed = pictures.filter((p) => p.state === 'failed' && p.prepared);
    return (
      <div className="scan-card">
        <h2>Added {added.name}</h2>
        <p className="scan-meta">
          <span className="mono">{added.sku}</span>
          <span>1 unit → {added.path}</span>
        </p>
        <PictureStrip pictures={pictures} />
        {failed.length > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void uploadAll(added.productId, failed)}
          >
            Retry {failed.length} {failed.length === 1 ? 'picture' : 'pictures'}
          </button>
        ) : null}
        <div className="scan-actions">
          <button type="button" disabled={busy} onClick={reset}>
            Add another
          </button>
        </div>
      </div>
    );
  }

  const priceOk = PRICE.test(price.trim());
  const costOk = !cost.trim() || COST.test(cost.trim());
  const preparing = pictures.some((p) => p.state === 'preparing');
  const ready = env.location !== null && name.trim() !== '' && priceOk && costOk && !preparing;
  const missingStarters = STARTERS.filter(
    (t) => schema.data && !schema.data.templates.find((x) => x.key === t.key)?.added,
  );

  return (
    <form
      className="scan-card scan-quick-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) submit.mutate(false);
      }}
    >
      <h2>One-of-a-kind item</h2>

      <div className="scan-pictures">
        <PictureStrip
          pictures={pictures}
          onRemove={(id) => setPictures((list) => list.filter((p) => p.id !== id))}
        />
        <div className="scan-actions two">
          <button type="button" onClick={() => camera.current?.click()}>
            Take picture
          </button>
          <button type="button" className="secondary" onClick={() => library.current?.click()}>
            From library
          </button>
        </div>
        {/* capture opens the rear camera; the second input is the photo library fallback. */}
        <input
          ref={camera}
          type="file"
          accept="image/*"
          capture="environment"
          aria-label="Take picture"
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length > 0) void addPictures(files);
          }}
        />
        <input
          ref={library}
          type="file"
          accept="image/*"
          multiple
          aria-label="Choose pictures"
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length > 0) void addPictures(files);
          }}
        />
      </div>

      <ScanField
        label="Certificate number"
        placeholder="Scan or type the certificate number"
        button="Set"
        keepValue
        onSubmit={(code) => setCertificate(code)}
        inputProps={{ value: certificate, onChange: (e) => setCertificate(e.target.value) }}
      />
      {certificate.trim() ? (
        <p className="muted small-text">
          The certificate number becomes the item’s barcode, so scanning the slab finds it.
        </p>
      ) : null}

      <label className="scan-label">
        <span>Family</span>
        <select
          aria-label="Family"
          value={familyId}
          onChange={(e) => {
            remember(familyKey, e.target.value);
            setFamilyChoice(e.target.value);
          }}
        >
          <option value="">No family</option>
          {families.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      {managesSchema && missingStarters.length > 0 ? (
        <div className="scan-actions two">
          {missingStarters.map((t) => (
            <button
              key={t.key}
              type="button"
              className="secondary small"
              disabled={addTemplate.isPending}
              onClick={() => addTemplate.mutate(t.key)}
            >
              Add the {t.name} family
            </button>
          ))}
        </div>
      ) : null}

      <input
        aria-label="Name"
        placeholder="Name, such as Charizard Holo"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={500}
        required
      />

      {fields
        .filter((f) => !(f.key === CERTIFICATE_FIELD && hasCertificateField))
        .map((f) => (
          <FieldInput
            key={f.id}
            field={f}
            value={values[f.key] ?? ''}
            onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))}
          />
        ))}

      <div className="scan-cost">
        <input
          aria-label="Price"
          placeholder={`Price (${env.shop.shop.currency})`}
          inputMode="decimal"
          value={price}
          onChange={(e) => setPrice(e.target.value.replace(',', '.'))}
          required
        />
        {seesCosts ? (
          <input
            aria-label="Cost"
            placeholder="Cost (optional)"
            inputMode="decimal"
            value={cost}
            onChange={(e) => setCost(e.target.value.replace(',', '.'))}
          />
        ) : null}
      </div>

      {connected.length === 1 ? (
        <div className="scan-toggle">
          <label>
            <input
              type="checkbox"
              checked={listing !== 'off'}
              onChange={(e) => setListing(e.target.checked ? 'draft' : 'off')}
            />
            <span>List on Shopify</span>
          </label>
          {listing !== 'off' ? (
            <select
              aria-label="Shopify listing status"
              value={listing}
              onChange={(e) => setListing(e.target.value as 'draft' | 'active')}
            >
              <option value="draft">as a draft</option>
              <option value="active">active (for sale)</option>
            </select>
          ) : null}
        </div>
      ) : canList && stores.isSuccess ? (
        <label className="scan-toggle disabled">
          <input type="checkbox" disabled aria-describedby="qa-shopify-note" />
          <span>List on Shopify</span>
          <span id="qa-shopify-note" className="muted small-text">
            {connected.length === 0
              ? 'No Shopify store is connected.'
              : 'Several stores: list it from the product page.'}
          </span>
        </label>
      ) : null}

      {!env.location ? (
        <p className="notice error">Scan a location label: where does it go?</p>
      ) : null}
      {similar ? (
        <div className="notice">
          <p>Items with similar names already exist:</p>
          <ul>
            {similar.map((s) => (
              <li key={s.productId}>{s.name}</li>
            ))}
          </ul>
          <button type="button" disabled={submit.isPending} onClick={() => submit.mutate(true)}>
            Add anyway
          </button>
        </div>
      ) : null}
      <p className="scan-confirm" aria-live="polite">
        1 unit{name.trim() ? ` of ${name.trim()}` : ''}
        {priceOk ? ` at ${price.trim()} ${env.shop.shop.currency}` : ''}
        {env.location ? ` → ${env.location.path}` : ''}
        {pictures.length
          ? ` · ${pictures.length} ${pictures.length === 1 ? 'picture' : 'pictures'}`
          : ''}
      </p>
      <div className="scan-actions">
        <button type="submit" disabled={!ready || submit.isPending || similar !== null}>
          {submit.isPending ? 'Adding…' : preparing ? 'Preparing pictures…' : 'Add 1 unit'}
        </button>
      </div>
    </form>
  );
}

function PictureStrip({
  pictures,
  onRemove,
}: {
  pictures: Picture[];
  onRemove?: (id: string) => void;
}) {
  if (pictures.length === 0) return null;
  return (
    <ul className="scan-picture-strip" aria-label="Pictures">
      {pictures.map((p) => (
        <li key={p.id} className={p.state}>
          {p.url ? <img src={p.url} alt={p.name} /> : <span className="mono">{p.name}</span>}
          <span className="small-text">
            {p.state === 'preparing'
              ? 'Preparing…'
              : p.state === 'uploading'
                ? `${Math.round(p.progress * 100)}%`
                : p.state === 'done'
                  ? 'Linked'
                  : p.state === 'failed'
                    ? 'Failed'
                    : 'Ready'}
          </span>
          {p.error ? <span className="small-text error-text">{p.error}</span> : null}
          {onRemove ? (
            <button type="button" className="ghost small" onClick={() => onRemove(p.id)}>
              Remove
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: Field;
  value: string;
  onChange: (value: string) => void;
}) {
  if (field.type === 'single_select') {
    return (
      <select aria-label={field.label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.label}</option>
        {field.options
          .filter((o) => !o.archived)
          .map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <select aria-label={field.label} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{field.label}</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }
  if (field.type === 'date') {
    return (
      <label className="scan-label">
        <span>{field.label}</span>
        <input
          type="date"
          aria-label={field.label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }
  return (
    <input
      aria-label={field.label}
      placeholder={field.label}
      inputMode={field.type === 'integer' || field.type === 'decimal' ? 'decimal' : undefined}
      value={value}
      onChange={(e) =>
        onChange(field.type === 'decimal' ? e.target.value.replace(',', '.') : e.target.value)
      }
    />
  );
}

/** One more unit, with its serial (such as a certificate), of an item whose units share a price. */
function SharedUnit({ env }: { env: ScanEnv }) {
  const queryClient = useQueryClient();
  const [item, setItem] = useState<ScanItem | null>(null);
  const [serial, setSerial] = useState('');
  const [cost, setCost] = useState('');
  const key = useRef(crypto.randomUUID());
  const seesCosts = can(env.shop, 'costs.read');

  const submit = useMutation({
    mutationFn: () =>
      command<QuickAdded>(
        `/shops/${env.shopId}/quick-add`,
        {
          locationId: env.location!.locationId,
          variantId: item!.variantId,
          serial: serial.trim(),
          ...(seesCosts && cost.trim() ? { unitCost: cost.trim() } : {}),
        },
        key.current,
      ),
    onSuccess: (r) => {
      key.current = crypto.randomUUID();
      env.feedback('ok', `Added ${r.sku} serial ${serial.trim()} at ${env.location!.path}.`);
      setSerial('');
      void queryClient.invalidateQueries({ queryKey: ['shop', env.shopId] });
    },
    onError: (error) => {
      key.current = crypto.randomUUID();
      env.feedback('error', errorMessage(error));
    },
  });

  useScanHandler((scan) => {
    if (scan.kind === 'location') return false;
    if (scan.kind === 'unknown') {
      setSerial(scan.code);
      env.feedback('ok', item ? `Serial ${scan.code}.` : `Serial ${scan.code}. Now scan the item.`);
      return true;
    }
    const scanned = scan.item;
    if (scanned.trackingMode !== 'serial') {
      env.feedback(
        'error',
        `${scanned.sku} is not tracked by serial. Use One of a kind, or track it by serial in the dashboard.`,
      );
      return true;
    }
    setItem(scanned);
    if (scanned.matchedBy === 'serial') {
      env.feedback('error', `${scan.code} is already a unit of ${scanned.sku}. Scan the new one.`);
    } else {
      env.feedback(
        'ok',
        serial ? undefined : 'Now scan or type the new unit’s certificate or serial.',
      );
    }
    return true;
  });

  const costOk = !cost.trim() || COST.test(cost.trim());
  const ready = item !== null && serial.trim() !== '' && env.location !== null && costOk;
  return (
    <div className="scan-card">
      {item ? (
        <ItemTitle item={{ ...item, pack: null, serial: null }} />
      ) : (
        <>
          <h2>Unit of a shared item</h2>
          <p className="muted">
            Scan the shared item’s barcode or type its SKU in the code field, then the new unit’s
            certificate or serial.
          </p>
        </>
      )}
      <ScanField
        label="Serial"
        placeholder="Certificate or serial number"
        button="Set"
        keepValue
        onSubmit={(code) => setSerial(code)}
        inputProps={{ value: serial, onChange: (e) => setSerial(e.target.value) }}
      />
      {seesCosts ? (
        <input
          aria-label="Cost"
          placeholder="Cost (optional)"
          inputMode="decimal"
          value={cost}
          onChange={(e) => setCost(e.target.value.replace(',', '.'))}
        />
      ) : null}
      {!env.location ? (
        <p className="notice error">Scan a location label: where does it go?</p>
      ) : null}
      <p className="scan-confirm" aria-live="polite">
        1 unit{item ? ` of ${item.sku}` : ''}
        {serial.trim() ? ` · SN ${serial.trim()}` : ''}
        {env.location ? ` → ${env.location.path}` : ''}
      </p>
      <div className="scan-actions">
        <button type="button" disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
          {submit.isPending ? 'Adding…' : 'Add 1 unit'}
        </button>
        {item ? (
          <button type="button" className="secondary" onClick={() => setItem(null)}>
            Another item
          </button>
        ) : null}
      </div>
    </div>
  );
}
