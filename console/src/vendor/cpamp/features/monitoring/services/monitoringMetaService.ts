import type { Config } from '@/types/config';
import type { AuthFileItem } from '@/types/authFile';
import type { MonitoringChannelMeta } from '../model/types';
export async function loadMonitoringMetaPayload(_config: Config) {
  return { authFiles: [{ name: 'Codex OAuth', auth_index: 'codex', type: 'codex', provider: 'codex', label: 'Codex OAuth' }] as AuthFileItem[], channels: [] as MonitoringChannelMeta[] };
}
