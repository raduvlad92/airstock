import type { ComponentType } from 'react';
import { createContext, useContext, useEffect, useRef } from 'react';
import type { ShopContext } from '../context.tsx';
import type { Resolved } from './resolve.ts';

/**
 * The flow framework for /app/scan (plan 5.12). The page owns the camera, the scan field, the
 * keyboard wedge, the current location, and the feedback; a flow is one component that receives
 * resolved scans and shows its own form. Adding a flow (count, move, receive against a PO, quick
 * add) means writing that component and adding one entry to FLOWS in flow-list.tsx.
 */
export type FlowId = 'lookup' | 'receive' | 'pick' | 'count' | 'move' | 'quick-add';

export const FLOW_IDS: readonly FlowId[] = [
  'lookup',
  'receive',
  'pick',
  'count',
  'move',
  'quick-add',
];

export interface CurrentLocation {
  locationId: string;
  path: string;
  warehouseId: string;
}

export interface ScanEnv {
  shopId: string;
  shop: ShopContext;
  /** Set by scanning a location label; flows read it and may change it. */
  location: CurrentLocation | null;
  setLocation: (location: CurrentLocation | null) => void;
  /** Sound, vibration where supported, a coloured flash, and a status line. */
  feedback: (tone: 'ok' | 'error' | 'notice', message?: string) => void;
  /** Stops decoding camera frames, for example while a quantity waits for confirmation. */
  setPaused: (paused: boolean) => void;
}

/** What a flow does with a scan. Return (or resolve to) true when the flow used it. */
export type ScanHandler = (scan: Resolved) => unknown;

export interface FlowDef {
  id: FlowId;
  label: string;
  /** A permission the member needs, checked like every other UI control (PRD 2.3). */
  permission: string | null;
  /** Not built yet: the tab shows "coming soon". */
  soon?: string;
  Component: ComponentType<{ env: ScanEnv }>;
}

/**
 * Scan handlers registered by the mounted flow components. The most recently mounted one (an
 * open form inside a flow) is asked first; when it returns anything but true, the next one is.
 */
export class ScanBus {
  private handlers: ScanHandler[] = [];

  add(handler: ScanHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /** True when a flow used the scan. */
  async dispatch(scan: Resolved): Promise<boolean> {
    for (const handler of [...this.handlers].reverse()) {
      if ((await handler(scan)) === true) return true;
    }
    return false;
  }
}

export const ScanBusContext = createContext<ScanBus>(new ScanBus());

/** Registers a scan handler; the latest render's closure always receives the scans. */
export function useScanHandler(handler: ScanHandler) {
  const bus = useContext(ScanBusContext);
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => bus.add((scan) => latest.current(scan)), [bus]);
}

export function isFlowId(value: unknown): value is FlowId {
  return typeof value === 'string' && (FLOW_IDS as readonly string[]).includes(value);
}
