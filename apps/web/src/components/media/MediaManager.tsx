import type { ops } from '@airstock/core';
import { DEFAULT_ORIGINAL_MAX_SIDE, roleLabel } from '@airstock/core/media';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type DragEvent, useId, useRef, useState } from 'react';
import { api, command, errorMessage, type Out } from '../../api.ts';
import { can, useShopContext } from '../../context.tsx';
import { useMutation } from '../../mutation.ts';
import { Badge, Card, Empty, ErrorNotice, Loading } from '../ui.tsx';
import { ACCEPT, prepareFile } from './derivatives.ts';
import { uploadToProduct } from './upload.ts';
import './media.css';

type ProductMedia = Out<typeof ops.listProductMedia>;
type MediaItem = ProductMedia['media'][number];
type Link = ProductMedia['product']['links'][number];

interface Entry {
  media: MediaItem;
  productLink: Link | null;
  variantLinks: Link[];
}

interface UploadRow {
  id: string;
  name: string;
  progress: number;
  state: 'preparing' | 'uploading' | 'done' | 'failed';
  error?: string;
}

/** The product's own pictures in order, then files shown only on some variants. */
export function mediaEntries(data: ProductMedia): Entry[] {
  const byId = new Map(data.media.map((m) => [m.mediaId, m]));
  const variantLinks = data.variants.flatMap((v) => v.links);
  const seen = new Set<string>();
  const out: Entry[] = [];
  const add = (mediaId: string, productLink: Link | null) => {
    const media = byId.get(mediaId);
    if (!media || seen.has(mediaId)) return;
    seen.add(mediaId);
    out.push({
      media,
      productLink,
      variantLinks: variantLinks.filter((l) => l.mediaId === mediaId),
    });
  };
  for (const l of data.product.links) add(l.mediaId, l);
  for (const l of variantLinks) add(l.mediaId, null);
  return out;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Pictures and attachments of one product: upload by picking or dropping files, then order, roles,
 * alt text, primary picture, which variants show each file, download, and remove (plan 5.8).
 */
export function MediaManager({ shopId, productId }: { shopId: string; productId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['shop', shopId, 'media', productId];
  const context = useShopContext(shopId);
  const canWrite = can(context.data, 'catalog.write');
  // Null keeps originals at full size, so only a missing context falls back to the default.
  const originalMaxSide = context.data
    ? context.data.shop.mediaOriginalMaxSide
    : DEFAULT_ORIGINAL_MAX_SIDE;
  // Signed links stay valid for at least 15 minutes; refetch well before.
  const list = useQuery({
    queryKey,
    queryFn: () => api<ProductMedia>(`/shops/${shopId}/products/${productId}/media`),
    staleTime: 5 * 60_000,
    refetchInterval: 10 * 60_000,
  });
  // The shop-wide prefix also refreshes primary pictures on gallery cards.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['shop', shopId, 'media'] });
  const change = useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSettled: refresh,
  });
  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const rolesId = useId();

  const update = (id: string, patch: Partial<UploadRow>) =>
    setUploads((rows) => rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const addFiles = async (files: File[]) => {
    const rows = files.map((f) => ({
      id: crypto.randomUUID(),
      name: f.name,
      progress: 0,
      state: 'preparing' as const,
    }));
    setUploads((current) => [...current.filter((r) => r.state !== 'done'), ...rows]);
    // One at a time: each file holds its bytes and two resized copies in memory.
    for (const [i, file] of files.entries()) {
      const row = rows[i]!;
      try {
        const prepared = await prepareFile(file, undefined, { originalMaxSide });
        update(row.id, { state: 'uploading', name: prepared.fileName });
        await uploadToProduct(shopId, productId, prepared, (share) =>
          update(row.id, { progress: share }),
        );
        update(row.id, { state: 'done', progress: 1 });
      } catch (error) {
        update(row.id, { state: 'failed', error: errorMessage(error) });
      }
      await refresh();
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canWrite && e.dataTransfer.files.length > 0) void addFiles([...e.dataTransfer.files]);
  };

  const data = list.data;
  const entries = data ? mediaEntries(data) : [];
  const ordered = data?.product.links.map((l) => l.mediaId) ?? [];
  const multiVariant = (data?.variants.length ?? 0) > 1;
  const base = `/shops/${shopId}`;

  const move = (mediaId: string, by: -1 | 1) => {
    const order = [...ordered];
    const at = order.indexOf(mediaId);
    const to = at + by;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to]!, order[at]!];
    change.mutate(() => command(`${base}/products/${productId}/media/order`, { order }));
  };
  // Role and alt text describe the file on this product, so they apply to each of its links here.
  const updateAll = (entry: Entry, patch: { role?: string; altText?: string | null }) =>
    change.mutate(async () => {
      for (const link of [entry.productLink, ...entry.variantLinks].filter(Boolean) as Link[]) {
        await command(`${base}/media/${entry.media.mediaId}/links/update`, {
          productId,
          ...(link.variantId ? { variantId: link.variantId } : {}),
          ...patch,
        });
      }
    });
  const setLinked = (mediaId: string, variantId: string | null, linked: boolean) =>
    change.mutate(() =>
      command(`${base}/media/${mediaId}/links${linked ? '' : '/remove'}`, {
        productId,
        scope: variantId ? 'variants' : 'product',
        ...(variantId ? { variantIds: [variantId] } : {}),
      }),
    );
  const download = (mediaId: string) =>
    change.mutate(async () => {
      const link = await api<Out<typeof ops.downloadOriginal>>(`${base}/media/${mediaId}/original`);
      window.location.assign(link.url);
    });

  return (
    <Card title="Pictures and attachments">
      {canWrite ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: dropping is an extra; the file picker inside does the same.
        <div
          className={dragging ? 'media-drop over' : 'media-drop'}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="muted">
            Drop pictures or PDFs here. JPEG, PNG, WebP, AVIF, or GIF up to 20 MB; PDF up to 50 MB.
          </p>
          <label className="media-pick">
            <span>Choose files</span>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT}
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                if (input.current) input.current.value = '';
                if (files.length > 0) void addFiles(files);
              }}
            />
          </label>
        </div>
      ) : null}
      {uploads.length > 0 ? (
        <ul className="media-uploads" aria-label="Uploads">
          {uploads.map((u) => (
            <li key={u.id}>
              <span className="media-upload-name">{u.name}</span>
              {u.state === 'failed' ? (
                <span className="field-error" role="alert">
                  {u.error}
                </span>
              ) : (
                <>
                  <progress max={1} value={u.progress} aria-label={`Uploading ${u.name}`} />
                  <span className="muted">
                    {u.state === 'preparing'
                      ? 'Preparing…'
                      : u.state === 'done'
                        ? 'Uploaded'
                        : `${Math.round(u.progress * 100)}%`}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <ErrorNotice error={list.error ?? change.error} />
      {list.isPending ? <Loading /> : null}
      {data && entries.length === 0 ? <Empty>No pictures or attachments yet.</Empty> : null}
      <datalist id={rolesId}>
        {(data?.roles ?? []).map((r) => (
          <option key={r} value={roleLabel(r)} />
        ))}
      </datalist>
      {entries.length > 0 ? (
        <ol className="media-list">
          {entries.map((entry) => {
            const { media, productLink } = entry;
            const position = ordered.indexOf(media.mediaId);
            const anyLink = productLink ?? entry.variantLinks[0]!;
            const linkCount = (productLink ? 1 : 0) + entry.variantLinks.length;
            return (
              <li key={media.mediaId} className="media-card">
                <div className="media-thumb">
                  {media.thumbnail?.url ? (
                    <img
                      src={media.thumbnail.url}
                      alt={anyLink.altText ?? ''}
                      width={media.thumbnail.width ?? undefined}
                      height={media.thumbnail.height ?? undefined}
                      loading="lazy"
                    />
                  ) : (
                    <span className="media-doc">{media.kind === 'document' ? 'PDF' : '—'}</span>
                  )}
                </div>
                <div className="media-body">
                  <div className="media-title">
                    <strong>{media.fileName}</strong>
                    <span className="muted">{formatBytes(media.size)}</span>
                    {productLink?.primary ? <Badge tone="ok">Primary</Badge> : null}
                  </div>
                  {canWrite ? (
                    <div className="media-fields">
                      <DraftInput
                        label="Role"
                        value={anyLink.roleLabel}
                        list={rolesId}
                        onCommit={(role) => role && updateAll(entry, { role })}
                      />
                      {media.kind === 'image' ? (
                        <DraftInput
                          label="Alt text"
                          value={anyLink.altText ?? ''}
                          onCommit={(altText) => updateAll(entry, { altText: altText || null })}
                        />
                      ) : null}
                    </div>
                  ) : (
                    <p className="muted">
                      {anyLink.roleLabel}
                      {anyLink.altText ? ` · ${anyLink.altText}` : ''}
                    </p>
                  )}
                  {canWrite && multiVariant ? (
                    <fieldset className="checks media-scopes">
                      <legend>Shown on</legend>
                      <label className="check">
                        <input
                          type="checkbox"
                          checked={productLink !== null}
                          disabled={change.isPending || (productLink !== null && linkCount === 1)}
                          onChange={(e) => setLinked(media.mediaId, null, e.target.checked)}
                        />
                        All variants
                      </label>
                      {data!.variants.map((v) => {
                        const own = entry.variantLinks.some((l) => l.variantId === v.variantId);
                        return (
                          <label key={v.variantId} className="check">
                            <input
                              type="checkbox"
                              checked={own}
                              disabled={change.isPending || (own && linkCount === 1)}
                              onChange={(e) =>
                                setLinked(media.mediaId, v.variantId, e.target.checked)
                              }
                            />
                            {v.title || v.sku}
                          </label>
                        );
                      })}
                    </fieldset>
                  ) : null}
                  <div className="media-actions">
                    {canWrite && position >= 0 ? (
                      <>
                        <button
                          type="button"
                          className="ghost small"
                          disabled={change.isPending || position === 0}
                          onClick={() => move(media.mediaId, -1)}
                          aria-label={`Move ${media.fileName} up`}
                        >
                          Up
                        </button>
                        <button
                          type="button"
                          className="ghost small"
                          disabled={change.isPending || position === ordered.length - 1}
                          onClick={() => move(media.mediaId, 1)}
                          aria-label={`Move ${media.fileName} down`}
                        >
                          Down
                        </button>
                      </>
                    ) : null}
                    {canWrite && media.kind === 'image' && productLink && !productLink.primary ? (
                      <button
                        type="button"
                        className="ghost small"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate(() =>
                            command(`${base}/media/${media.mediaId}/links/update`, {
                              productId,
                              primary: true,
                            }),
                          )
                        }
                      >
                        Make primary
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="ghost small"
                      disabled={change.isPending}
                      onClick={() => download(media.mediaId)}
                    >
                      Download
                    </button>
                    {canWrite ? (
                      <button
                        type="button"
                        className="danger small"
                        disabled={change.isPending}
                        onClick={() =>
                          change.mutate(() =>
                            command(`${base}/media/${media.mediaId}/links/remove`, { productId }),
                          )
                        }
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}
    </Card>
  );
}

/** A text input that saves when it loses focus or Enter is pressed, if its value changed. */
function DraftInput({
  label,
  value,
  list,
  onCommit,
}: {
  label: string;
  value: string;
  list?: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft.trim() !== value) onCommit(draft.trim());
    setDraft(null);
  };
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        value={draft ?? value}
        list={list}
        maxLength={label === 'Role' ? 60 : 1000}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}
