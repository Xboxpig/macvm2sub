// macvm2sub adapters for upstream presentation components.
import { createContext, useContext } from 'react';
import type { Config } from '../types/config';
export const ConsoleContext = createContext<{ resolvedTheme: 'light' | 'dark'; showNotification: (message: string, kind?: string) => void }>({ resolvedTheme: 'light', showNotification: () => {} });
const config: Config = { apiKeys: [] };
export function useThemeStore<T>(select: (s: { resolvedTheme: 'light' | 'dark' }) => T): T { return select(useContext(ConsoleContext)); }
export function useNotificationStore<T>(select: (s: { showNotification: (message: string, kind?: string) => void }) => T): T { return select(useContext(ConsoleContext)); }
export function useAuthStore<T>(select: (s: { managementKey: string }) => T): T { return select({ managementKey: '' }); }
export function useConfigStore<T>(select: (s: { config: Config }) => T): T { return select({ config }); }
