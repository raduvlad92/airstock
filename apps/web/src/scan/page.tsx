import type { ops } from '@airstock/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage, type Out } from '../api.ts';
import { ErrorNotice, Loading } from '../components/ui.tsx';
import { can, type ShopContext, useShopContext, useShops } from '../context.tsx';
import { CameraScanner } from './camera.tsx';
import { loadZxing, needsZxing } from './decoder.ts';
import { FLOWS } from './flow-list.tsx';
import {
  type CurrentLocation,
  type FlowId,
  isFlowId,
  ScanBusContext,
  type ScanEnv,
  type ScanHandler,
} from './flows.ts';
import { type LocationRow, resolveScan } from './resolve.ts';
import { ScanField } from './scan-field.tsx';
import { feedback as playFeedback, setSoundEnabled, soundEnabled, unlockAudio } from './sounds.ts';
import { ScanThrottle } from './throttle.ts';
import { useKeyboardWedge } from './wedge.ts';

export interface ScanSearch {
  shop?: string;
  flow?: FlowId;
}

export function parseScanSearch(search: Record<string, unknown>): ScanSearch {
  return {
    ...(typeof search.shop === 'string' && /^[0-9a-f-]{36}$/.test(search.shop)
      ? { shop: search.shop }
      : {}),
    ...(isFlowId(search.flow) ? { flow: search.flow } : {}),
  };
}

const SHOP_KEY = 'airstock.scan.shop';
const LOCATION_KEY = 'airstock.scan.location';

function remembered(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode: nothing is remembered.
  }
}

/**
 * The phone scanning app (plan D13, 5.12): the installed app starts here. It picks the shop (the
 * one named in the address, the last one used, or the only one), then shows the scanner and the
 * chosen flow.
 */
export function ScanPage() {
  const search = useSearch({ from: '/scan' }) as ScanSearch;
  const navigate = useNavigate();
  const shops = useShops();
  const list = shops.data?.shops ?? [];
  const last = remembered(SHOP_KEY);
  const shopId =
    search.shop ??
    (list.find((s) => s.id === last)?.id || (list.length === 1 ? list[0]!.id : undefined));

  useEffect(() => {
    if (shopId) remember(SHOP_KEY, shopId);
  }, [shopId]);

  if (shops.isPending)
    return (
      <ScanFrame>
        <Loading />
      </ScanFrame>
    );
  if (shops.error)
    return (
      <ScanFrame>
        <ErrorNotice error={shops.error} />
      </ScanFrame>
    );
  if (!shopId) {
    return (
      <ScanFrame>
        <h1 className="scan-title">Choose a shop</h1>
        {list.length === 0 ? (
          <p>
            You have no shop yet. <Link to="/">Create one in the dashboard.</Link>
          </p>
        ) : (
          <ul className="scan-choices">
            {list.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="scan-choice"
                  onClick={() => void navigate({ to: '/scan', search: { ...search, shop: s.id } })}
                >
                  <strong>{s.name}</strong>
                  <span className="muted">{s.role.replaceAll('_', ' ')}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ScanFrame>
    );
  }
  return <ScanShop key={shopId} shopId={shopId} flow={search.flow ?? 'lookup'} />;
}

function ScanFrame({ children }: { children: React.ReactNode }) {
  return <div className="scan-app">{children}</div>;
}

function ScanShop({ shopId, flow }: { shopId: string; flow: FlowId }) {
  const context = useShopContext(shopId);
  const shops = useShops();
  const navigate = useNavigate();
  if (context.isPending)
    return (
      <ScanFrame>
        <Loading />
      </ScanFrame>
    );
  if (context.error) {
    return (
      <ScanFrame>
        <ErrorNotice error={context.error} />
        <button type="button" onClick={() => void navigate({ to: '/scan', search: {} })}>
          Choose another shop
        </button>
      </ScanFrame>
    );
  }
  return (
    <ScanWorkspace
      shopId={shopId}
      shop={context.data}
      flow={flow}
      shopCount={shops.data?.shops.length ?? 1}
    />
  );
}

interface Status {
  tone: 'ok' | 'error' | 'notice';
  message: string;
  at: number;
}

function ScanWorkspace({
  shopId,
  shop,
  flow,
  shopCount,
}: {
  shopId: string;
  shop: ShopContext;
  flow: FlowId;
  shopCount: number;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bus = useRef<{ current: ScanHandler | null }>({ current: null });
  const throttle = useRef(new ScanThrottle());
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [flash, setFlash] = useState<'ok' | 'error' | null>(null);
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(soundEnabled());
  const [location, setLocationState] = useState<CurrentLocation | null>(() => {
    const saved = remembered(`${LOCATION_KEY}.${shopId}`);
    try {
      return saved ? (JSON.parse(saved) as CurrentLocation) : null;
    } catch {
      return null;
    }
  });

  const setLocation = useCallback(
    (next: CurrentLocation | null) => {
      setLocationState(next);
      remember(`${LOCATION_KEY}.${shopId}`, next ? JSON.stringify(next) : null);
    },
    [shopId],
  );

  const feedback = useCallback((tone: Status['tone'], message?: string) => {
    playFeedback(tone);
    setFlash(tone === 'error' ? 'error' : 'ok');
    if (message) setStatus({ tone, message, at: Date.now() });
  }, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 600);
    return () => clearTimeout(t);
  }, [flash]);

  // Start downloading zxing while the user reaches for the camera.
  useEffect(() => {
    if (needsZxing()) void loadZxing().catch(() => {});
  }, []);

  // iOS plays sound only after a gesture.
  useEffect(() => {
    const unlock = () => unlockAudio();
    document.addEventListener('pointerdown', unlock, { capture: true });
    document.addEventListener('keydown', unlock, { capture: true });
    return () => {
      document.removeEventListener('pointerdown', unlock, { capture: true });
      document.removeEventListener('keydown', unlock, { capture: true });
    };
  }, []);

  const locations = useCallback(
    () =>
      queryClient
        .fetchQuery({
          queryKey: ['shop', shopId, 'locations'],
          queryFn: () => api<Out<typeof ops.listLocations>>(`/shops/${shopId}/locations`),
          staleTime: 60_000,
        })
        .then((r): LocationRow[] => r.locations),
    [queryClient, shopId],
  );

  const handle = useCallback(
    async (code: string) => {
      setBusy(true);
      try {
        const resolved = await resolveScan(shopId, code, locations);
        if (resolved.kind === 'location') {
          if (!resolved.location.holdsStockAllowed) {
            feedback('error', `${resolved.location.path} has sub-locations; scan one of those.`);
            return;
          }
          setLocation({
            locationId: resolved.location.locationId,
            path: resolved.location.path,
            warehouseId: resolved.location.warehouseId,
          });
        }
        const used = (await bus.current.current?.(resolved)) === true;
        if (resolved.kind === 'location' && !used) {
          feedback('ok', `Location: ${resolved.location.path}`);
        }
      } catch (error) {
        feedback('error', errorMessage(error));
      } finally {
        setBusy(false);
      }
    },
    [shopId, locations, feedback, setLocation],
  );

  const onCamera = useCallback(
    (found: { text: string }) => {
      if (!throttle.current.accept(found.text, performance.now())) return;
      void handle(found.text);
    },
    [handle],
  );

  const onTyped = useCallback(
    (code: string) => {
      throttle.current.reset();
      void handle(code);
    },
    [handle],
  );

  useKeyboardWedge(onTyped);

  const env: ScanEnv = useMemo(
    () => ({ shopId, shop, location, setLocation, feedback, setPaused }),
    [shopId, shop, location, setLocation, feedback],
  );

  const available = FLOWS.filter((f) => !f.permission || can(shop, f.permission));
  const active = available.find((f) => f.id === flow) ?? available[0]!;
  const Flow = active.Component;

  return (
    <div className="scan-app">
      <header className="scan-header">
        <Link to="/shops/$shopId/products" params={{ shopId }} className="scan-back">
          Dashboard
        </Link>
        <strong className="scan-shop">{shop.shop.name}</strong>
        {shopCount > 1 ? (
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              remember(SHOP_KEY, null);
              void navigate({ to: '/scan', search: { flow } });
            }}
          >
            Switch
          </button>
        ) : null}
        <button
          type="button"
          className="ghost small"
          aria-pressed={sound}
          onClick={() => {
            setSoundEnabled(!sound);
            setSound(!sound);
            if (!sound) unlockAudio();
          }}
        >
          {sound ? 'Sound on' : 'Sound off'}
        </button>
      </header>

      <CameraScanner onDetected={onCamera} paused={paused || busy} flash={flash} />

      <ScanField label="Code" onSubmit={onTyped} />

      <div className="scan-location">
        {location ? (
          <>
            <span className="muted">Location</span>
            <strong>{location.path}</strong>
            <button type="button" className="ghost small" onClick={() => setLocation(null)}>
              Clear
            </button>
          </>
        ) : (
          <span className="muted">Scan a location label to set the current location.</span>
        )}
      </div>

      {status ? (
        <p
          className={`scan-status ${status.tone}`}
          role={status.tone === 'error' ? 'alert' : 'status'}
        >
          {status.message}
        </p>
      ) : null}

      <section className="scan-flow" aria-label={active.label}>
        <ScanBusContext.Provider value={bus.current}>
          {active.soon ? (
            <div className="scan-soon">
              <h2>{active.label}</h2>
              <p>{active.soon}</p>
            </div>
          ) : (
            <Flow key={active.id} env={env} />
          )}
        </ScanBusContext.Provider>
      </section>

      <nav className="scan-tabs" aria-label="Scan flows">
        {available.map((f) => (
          <button
            key={f.id}
            type="button"
            className={f.id === active.id ? 'scan-tab active' : 'scan-tab'}
            aria-current={f.id === active.id ? 'page' : undefined}
            onClick={() => {
              throttle.current.reset();
              setPaused(false);
              void navigate({ to: '/scan', search: { shop: shopId, flow: f.id }, replace: true });
            }}
          >
            {f.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
