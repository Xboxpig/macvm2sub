export type RequestMonitoringUnavailableReason = 'usage_service_not_configured';
export function useRequestMonitoringAvailability() { return { available: true, checking: false, serviceBase: location.origin, reason: '' as const }; }
