import type { ops } from '@airstock/core';
import { useQuery } from '@tanstack/react-query';
import { createContext, type ReactNode, useContext } from 'react';
import { api, type Out } from './api.ts';

export interface AppInfo {
  email: string;
  mcpUrl: string;
}

const AppInfoContext = createContext<AppInfo>({ email: '', mcpUrl: '' });

export function AppInfoProvider({ info, children }: { info: AppInfo; children: ReactNode }) {
  return <AppInfoContext.Provider value={info}>{children}</AppInfoContext.Provider>;
}

export const useAppInfo = () => useContext(AppInfoContext);

export type ShopContext = Out<typeof ops.getShopContext>;
export type ShopSummary = Out<typeof ops.listShops>['shops'][number];

export function useShops() {
  return useQuery({
    queryKey: ['shops'],
    queryFn: () => api<Out<typeof ops.listShops>>('/shops'),
  });
}

/** The current shop, the member's role and permissions, and the shop's limits. */
export function useShopContext(shopId: string) {
  return useQuery({
    queryKey: ['shop', shopId, 'context'],
    queryFn: () => api<ShopContext>(`/shops/${shopId}`),
    staleTime: 60_000,
  });
}

/** Whether the member holds a permission. Checks name permissions, never roles (PRD 2.3). */
export function can(context: ShopContext | undefined, permission: string): boolean {
  return context?.permissions.includes(permission as ShopContext['permissions'][number]) ?? false;
}
