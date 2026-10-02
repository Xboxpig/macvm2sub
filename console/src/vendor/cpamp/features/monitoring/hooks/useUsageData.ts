import type { ApiKeyAlias } from '@/services/api/usageService';
const apiKeyAliases: ApiKeyAlias[] = [{ apiKeyHash: 'gateway', alias: 'macvm2sub API' }];
const loadApiKeyAliases = async () => {};
export function useUsageData(_options: { loadUsageEvents: boolean }) { return { apiKeyAliases, loadApiKeyAliases }; }
